"""Object-storage source checks for `selftest.py`: a stdlib stand-in for an S3 endpoint records every
request, so these assert what the server sends (a signed, path-style GET for `<prefix><documentId>`)
and what it does with the answers (original name from metadata, 404 as a tool error, one fetch per
document however many calls read it). Real signature validity is checked against MinIO by the
product's end-to-end run, not here: a stand-in that verified SigV4 would share this code's own
understanding of it.
"""
from __future__ import annotations

import os
import threading
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import s3_source
from settings import SettingConflict
from wire_client import HttpClient, Results, result_of

BUCKET = "attachments-bucket"
PREFIX = "chat-attachments/"


class _S3Handler(BaseHTTPRequestHandler):
    objects: dict[str, tuple[bytes, str, str]] = {}  # key -> (content, contentType, encodedName)
    requests: list[tuple[str, dict[str, str]]] = []

    def do_GET(self) -> None:  # noqa: N802 - stdlib handler method name
        self.requests.append((self.path, {name.lower(): value for name, value in self.headers.items()}))
        key = urllib.parse.unquote(self.path.removeprefix(f"/{BUCKET}/"))
        found = self.objects.get(key)
        if found is None:
            self.send_response(404)
            self.end_headers()
            return
        content, content_type, encoded_name = found
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("x-amz-meta-filename", encoded_name)
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        self.wfile.write(content)

    def log_message(self, format_: str, *args: object) -> None:  # noqa: A002 - stdlib signature
        pass


_S3_NAMES = ("S3_", "AGENTIC_KNOWLEDGE_S3_", "AGENTIC_S3_", "DOCUMENT_S3", "SHARED_S3_")


def _location_with(env: dict[str, str]):
    """`configured_location()` against exactly `env` for the S3 names, the rest of the process untouched."""
    saved = dict(os.environ)
    try:
        for name in [name for name in os.environ if name.startswith(_S3_NAMES)]:
            del os.environ[name]
        os.environ.update(env)
        return s3_source.configured_location()
    finally:
        os.environ.clear()
        os.environ.update(saved)


def run_s3_name_checks(results: Results) -> None:
    """The shared `S3_*` names, the retired ones they replaced, and a prefix of its own."""
    keys = {"ENDPOINT": "http://127.0.0.1:9000", "BUCKET": "b", "ACCESS_KEY": "a", "SECRET_KEY": "s"}
    shared = {f"S3_{name}": value for name, value in keys.items()}
    retired = {f"AGENTIC_KNOWLEDGE_S3_{name}": value for name, value in keys.items()}
    results.check("S3 names: the shared S3_* set is the default", getattr(_location_with({"DOCUMENT_S3_PREFIX": "p/", **shared}), "bucket", None) == "b")
    results.check("S3 names: retired AGENTIC_KNOWLEDGE_S3_* still configure it", getattr(_location_with(retired), "bucket", None) == "b")
    migrated = _location_with({"DOCUMENT_S3_ENV_PREFIX": "AGENTIC_KNOWLEDGE_S3", **shared})
    results.check("S3 names: an unedited retired prefix reads a migrated S3_* set", getattr(migrated, "bucket", None) == "b")
    try:
        _location_with({**shared, "AGENTIC_KNOWLEDGE_S3_SECRET_KEY": "other"})
        refused = False
    except SettingConflict as error:
        refused = "S3_SECRET_KEY and its retired name AGENTIC_KNOWLEDGE_S3_SECRET_KEY" in str(error) and "other" not in str(error)
    results.check("S3 names: a new and a retired name with different values refuse, naming settings only", refused)
    own = _location_with({"DOCUMENT_S3_ENV_PREFIX": "SHARED_S3", **retired})
    results.check("S3 names: a prefix of its own reads no retired names", own is None, str(own))


def run_s3_checks(results: Results, script_dir: str, document: tuple[bytes, str, str], clients: list[HttpClient]) -> None:
    run_s3_name_checks(results)
    content, media_type, name = document
    _S3Handler.objects = {PREFIX + "a1b2c3": (content, media_type, urllib.parse.quote(name))}
    _S3Handler.requests = []
    server = ThreadingHTTPServer(("127.0.0.1", 0), _S3Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        env = {
            "DOCUMENT_S3_ENV_PREFIX": "SHARED_S3", "DOCUMENT_S3_PREFIX": PREFIX,
            "SHARED_S3_ENDPOINT": f"http://127.0.0.1:{server.server_address[1]}", "SHARED_S3_BUCKET": BUCKET,
            "SHARED_S3_ACCESS_KEY": "access", "SHARED_S3_SECRET_KEY": "secret",
        }
        client = HttpClient(script_dir, "", extra_env=env)
        clients.append(client)
        first = result_of(client.request("tools/call", {"name": "read_document", "arguments": {"documentId": "a1b2c3"}}), results, "S3: read_document responds")
        second = result_of(client.request("tools/call", {"name": "read_document", "arguments": {"documentId": "a1b2c3"}}), results, "S3: second read_document responds")
        if first is not None and second is not None:
            results.check("S3: a stored workbook is read", not first.get("isError") and first["structuredContent"].get("kind") == "workbook", str(first)[:200])
        path, headers = _S3Handler.requests[0] if _S3Handler.requests else ("", {})
        results.check("S3: a path-style GET for <prefix><documentId>", path == f"/{BUCKET}/{PREFIX}a1b2c3", path)
        results.check(
            "S3: the request is signed with the configured access key (SigV4)",
            headers.get("authorization", "").startswith("AWS4-HMAC-SHA256 Credential=access/") and "x-amz-date" in headers,
            str(headers),
        )
        results.check("S3: a document read twice is fetched once", len(_S3Handler.requests) == 1, str(len(_S3Handler.requests)))
        missing = result_of(client.request("tools/call", {"name": "read_document", "arguments": {"documentId": "not-there"}}), results, "S3: missing object responds")
        if missing is not None:
            results.check("S3: a missing object is a tool error, not a crash", missing.get("isError") is True, str(missing)[:200])
    finally:
        server.shutdown()
