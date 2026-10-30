#!/usr/bin/env python3
"""office-docs as a native HTTP MCP server (stateless Streamable HTTP, JSON responses).

Documents are read from object storage by `documentId`
(`DOCUMENT_S3_ENV_PREFIX` / `DOCUMENT_S3_PREFIX`, see `backend.py`), the same archive the backend
writes chat attachments to; nothing is uploaded to this service. Backend-to-backend only: every call
but the probes needs `Authorization: Bearer <DOCUMENT_READERS_TOKEN>`, browser origins are refused.

  POST /mcp       MCP JSON-RPC (discover/initialize/tools/resources)
  GET  /healthz   liveness
  GET  /readyz    readiness (503 while saturated)

Run: `python3 http_server.py` (container) or `python3 http_server.py --local` (developer machine,
loopback only, token read from the repository `.env`).
"""
from __future__ import annotations

import hmac
import json
import os
import re
import signal
import socket
import sys
import threading
import time
from concurrent import futures
from concurrent.futures import Future, ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from backend import StorageDocumentSource
from diagnostics import call_context, error_details, safe_text
from protocol import handle_message
from session import Services, _build_dispatcher
from tool_catalog import build_tool_registry

MAX_MCP_BODY = 256 * 1024
# Overload protection. Every limit is bounded and answers fast instead of queueing without end.
MAX_OUTSTANDING = int(os.environ.get("DOCUMENT_READERS_MAX_OUTSTANDING", "8"))   # running + waiting calls; beyond it: "busy"
CALL_TIMEOUT_S = int(os.environ.get("DOCUMENT_READERS_CALL_TIMEOUT_S", "75"))   # how long a caller waits for one read
HARD_LIMIT_S = max(CALL_TIMEOUT_S + 30, 180)  # a call this old means a wedged parser: exit so the orchestrator restarts us
WORKER_METHODS = {"tools/call", "resources/read"}
LOG_LOCK = threading.Lock()

def event(name: str, **fields) -> None:
    """One JSON line per event on stderr. Only bounded diagnostic context, never full arguments."""
    with LOG_LOCK:
        print(json.dumps({"time": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "event": name,
                          "pid": os.getpid(), "parentPid": os.getppid(), **fields}),
              file=sys.stderr, flush=True)


def load_local_env() -> None:
    """`--local` only: read the service token and the object-storage settings from the repository
    `.env` without overriding the shell."""
    path = Path(__file__).resolve().parents[2] / ".env"
    if not path.is_file():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        match = re.fullmatch(r"\s*(DOCUMENT_[A-Z0-9_]+|AGENTIC_ATTACHMENTS_DIR|(?:[A-Z0-9_]+_)?S3_[A-Z_]+)\s*=\s*(.*?)\s*", line)
        if match:
            os.environ.setdefault(match[1], match[2].strip("\"'"))


class Executor:
    """Runs tool calls on a small worker pool. A slot is held until the parser returns, not until
    the caller gives up: Python cannot interrupt a parse, so counting only live callers would lie."""

    def __init__(self, dispatcher, workers: int) -> None:
        self.dispatcher = dispatcher
        self.pool = ThreadPoolExecutor(max_workers=workers, thread_name_prefix="reader")
        self._lock = threading.Lock()
        self._started: dict[int, float] = {}
        self._next = 0

    @property
    def outstanding(self) -> int:
        with self._lock:
            return len(self._started)

    def watchdog(self) -> None:
        while True:
            time.sleep(5)
            with self._lock:
                oldest = min(self._started.values(), default=None)
            if oldest is not None and time.monotonic() - oldest > HARD_LIMIT_S:
                event("reader.wedged", limitS=HARD_LIMIT_S)
                os._exit(1)

    def call(self, message: dict) -> dict | str:
        """Returns the JSON-RPC response, or "busy" / "timeout"."""
        with self._lock:
            if len(self._started) >= MAX_OUTSTANDING:
                return "busy"
            self._next += 1
            call_id = self._next
            self._started[call_id] = time.monotonic()
        params = message.get("params")
        label = safe_text((params.get("name") if isinstance(params, dict) else None) or message["method"], 100)
        context = call_context(message)
        started = time.monotonic()
        future: Future = self.pool.submit(handle_message, message, self.dispatcher)

        def settled(done: Future) -> None:
            with self._lock:
                self._started.pop(call_id, None)
            exception = done.exception()
            failed = exception is not None
            diagnostic = error_details(exception) if exception else None
            if not failed:
                handled = done.result()
                failed = handled.kind != "result" or bool((handled.result or {}).get("isError"))
                diagnostic = handled.diagnostic
                if failed and not diagnostic:
                    diagnostic = {"type": "McpError", "code": (handled.error or {}).get("code"),
                                  "message": safe_text((handled.error or {}).get("message", "Tool returned isError"))}
            event("call.done", id=call_id, label=label, outcome="error" if failed else "ok",
                  ms=int((time.monotonic() - started) * 1000), **context,
                  **({"error": diagnostic} if failed else {}))

        future.add_done_callback(settled)
        try:
            handled = future.result(timeout=CALL_TIMEOUT_S)
        except (TimeoutError, futures.TimeoutError):  # distinct classes before Python 3.11
            event("call.abandoned", id=call_id, label=label, timeoutS=CALL_TIMEOUT_S, **context)
            return "timeout"
        return handled


def error_result(text: str) -> dict:
    return {"resultType": "complete", "isError": True, "content": [{"type": "text", "text": text}]}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    timeout = 90
    server_version = "document-readers"
    sys_version = ""

    answered = False
    body_read = False  # an early refusal leaves the body unread, so the connection cannot be reused

    def log_message(self, format: str, *args) -> None:  # noqa: A002 - request logging is event()-based, never the raw URL
        del format, args

    def send_error(self, code: int, message: str | None = None, explain: str | None = None) -> None:
        """Framing errors raised by BaseHTTPRequestHandler itself (501 for a method it has no handler
        for, 400/414/431 for a malformed request line or headers) never reach `handle_any`."""
        self.refused(code, "framing")
        super().send_error(code, message, explain)

    def refused(self, status: int, reason: str, **fields) -> None:
        """One `call.refused` line for every request answered without entering the worker pool. The
        query string is dropped: it is not part of the MCP contract and may carry a credential."""
        path = getattr(self, "path", None)
        event("call.refused", **{"reason": reason, "status": status, "method": getattr(self, "command", None),
                                 "path": safe_text(path.split("?", 1)[0], 200) if isinstance(path, str) else None, **fields})

    def refuse(self, status: int, reason: str, body: bytes = b"", content_type: str = "text/plain; charset=utf-8",
               headers: dict | None = None, **fields) -> None:
        self.refused(status, reason, **fields)
        self.reply(status, body, content_type, headers)

    def reply(self, status: int, body: bytes, content_type: str = "text/plain; charset=utf-8",
              headers: dict | None = None, send_body: bool = True) -> None:
        self.answered = True
        if not self.body_read and (self.headers.get("content-length", "0") != "0" or self.headers.get("transfer-encoding")):
            self.close_connection = True
        self.send_response(status)
        self.send_header("Cache-Control", "no-store")
        if status != 204:
            self.send_header("Content-Type", content_type)
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        if "Content-Length" not in (headers or {}):
            self.send_header("Content-Length", str(len(body)))
        if self.close_connection:
            self.send_header("Connection", "close")
        self.end_headers()
        if send_body and body and self.command != "HEAD":
            self.wfile.write(body)

    # -- routing ---------------------------------------------------------------------------------
    def handle_any(self) -> None:
        # BaseHTTPRequestHandler reuses this instance for HTTP/1.1 keep-alive requests.
        # A prior successful read must not make an unread, refused request body reusable.
        self.answered = False
        self.body_read = False
        app: App = self.server.app  # type: ignore[attr-defined]
        host = (self.headers.get("host") or "").rsplit(":", 1)[0].lower()
        if host not in app.hosts:
            return self.refuse(403, "host_not_allowed")
        if self.path == "/healthz" and self.command == "GET":  # liveness: this thread answering is the proof
            return self.reply(200, b"ok")
        if self.path == "/readyz" and self.command == "GET":  # readiness: shed load before callers see "busy"
            ready = app.executor.outstanding < MAX_OUTSTANDING
            return self.reply(200 if ready else 503, b"ready" if ready else b"saturated")
        if self.headers.get("origin"):
            return self.refuse(403, "origin_refused")  # backend-to-backend only; browsers are refused
        supplied = (self.headers.get("authorization") or "").encode()
        if not hmac.compare_digest(supplied, app.expected):
            return self.refuse(401, "unauthorized", headers={"WWW-Authenticate": "Bearer"})
        if self.path != "/mcp":
            return self.refuse(404, "not_found")
        if self.command != "POST":
            return self.refuse(405, "method_not_allowed", headers={"Allow": "POST"})
        try:
            self.mcp(app)
        except Exception as error:  # noqa: BLE001
            event("mcp.failed", error=error_details(error))
            if not self.answered:
                self.reply(500, b"MCP request failed")

    do_GET = do_POST = do_PUT = do_DELETE = do_HEAD = handle_any

    def mcp(self, app: "App") -> None:
        try:
            length = int(self.headers.get("content-length") or "-1")
        except ValueError:
            length = -1
        if length < 0:
            return self.refuse(411, "length_required")
        if length > MAX_MCP_BODY:
            self.close_connection = True
            return self.refuse(413, "body_too_large", length=length)
        self.body_read = True
        try:
            message = json.loads(self.rfile.read(length))
        except ValueError:
            return self.refuse(400, "parse_error", json.dumps({"jsonrpc": "2.0", "id": None,
                                                               "error": {"code": -32700, "message": "Parse error"}}).encode(),
                               "application/json")
        if not isinstance(message, dict):
            return self.refuse(400, "invalid_request")
        method = message.get("method")
        if "id" not in message:  # notification: accepted, never answered
            return self.reply(202, b"")
        context = call_context(message)
        params = message.get("params")
        tool = params.get("name") if isinstance(params, dict) else None
        if method == "tools/call" and tool not in app.tool_names:
            self.refused(200, "unknown_tool", **context, tool=safe_text(tool, 100))
            reply = {"jsonrpc": "2.0", "id": message["id"], "result": error_result(
                "This service only reads documents. Code execution is unavailable.")}
        elif method in WORKER_METHODS:
            outcome = app.executor.call(message)
            if isinstance(outcome, str):
                if outcome == "busy":
                    self.refused(200, "busy", **context, tool=safe_text(tool, 100) if isinstance(tool, str) else None)
                text = ("The document reader is busy. Wait a few seconds and retry the same call; do not change the request."
                        if outcome == "busy" else "Reading took too long. Retry with a smaller page (maxRows) or a narrower range.")
                reply = {"jsonrpc": "2.0", "id": message["id"], "result": error_result(text)} \
                    if method == "tools/call" else {"jsonrpc": "2.0", "id": message["id"],
                                                    "error": {"code": -32603, "message": text}}
            else:
                reply = _envelope(outcome)
        else:
            reply = _envelope(handle_message(message, app.dispatcher))
        self.reply(200, json.dumps(reply, ensure_ascii=False).encode(), "application/json")


class ReaderServer(ThreadingHTTPServer):
    daemon_threads = True

    def server_bind(self) -> None:
        # On Windows SO_REUSEADDR (which HTTPServer sets) lets a second process bind a port a live
        # one still holds, and connections then split between them: a stale reader keeps answering
        # after a restart. SO_EXCLUSIVEADDRUSE is the Windows way to make the port ours alone.
        if sys.platform == "win32":
            self.allow_reuse_address = False
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


def _envelope(handled) -> dict:
    if handled.kind == "result":
        return {"jsonrpc": "2.0", "id": handled.id, "result": handled.result}
    return {"jsonrpc": "2.0", "id": handled.id, "error": handled.error}


class App:
    def __init__(self, token: str, hosts: list[str], workers: int) -> None:
        self.expected = f"Bearer {token}".encode()
        self.hosts = {host.strip().lower() for host in hosts if host.strip()}
        self.tool_names = {"read_document", "read_table", "read_cells"}
        registry = build_tool_registry()
        if set(registry) != self.tool_names:
            raise RuntimeError("Only the reviewed document readers may be exposed by this service")
        self.dispatcher = _build_dispatcher(Services(documents=StorageDocumentSource()), registry)
        self.executor = Executor(self.dispatcher, workers)


def main() -> None:
    local = "--local" in sys.argv
    if local:
        load_local_env()
        os.environ.setdefault("DOCUMENT_READERS_BIND_HOST", "127.0.0.1")
        os.environ.setdefault("DOCUMENT_READERS_ALLOWED_HOSTS", "localhost,127.0.0.1")
        # Development without S3: the backend writes attachments under AGENTIC_ATTACHMENTS_DIR/<prefix>,
        # so the reader reads that same folder instead of the archive.
        attachments = os.environ.get("AGENTIC_ATTACHMENTS_DIR", "").strip()
        if attachments and not os.environ.get("DOCUMENT_SOURCE_DIR"):
            os.environ["DOCUMENT_SOURCE_DIR"] = os.path.join(os.path.abspath(attachments), os.environ.get("DOCUMENT_S3_PREFIX", ""))
    if not os.environ.get("DOCUMENT_S3_PREFIX") and not os.environ.get("DOCUMENT_SOURCE_DIR"):
        sys.exit("Set DOCUMENT_S3_PREFIX (where the archive keeps attachments; the bucket comes from the shared S3_* settings, "
                 "or the set DOCUMENT_S3_ENV_PREFIX names), or DOCUMENT_SOURCE_DIR for a local directory")
    token = os.environ.get("DOCUMENT_READERS_TOKEN", "")
    if len(token.encode()) < 32:
        sys.exit("DOCUMENT_READERS_TOKEN must contain at least 32 bytes")
    port = int(os.environ.get("DOCUMENT_READERS_PORT", "8080"))
    if not 1 <= port <= 65535:
        sys.exit("Invalid DOCUMENT_READERS_PORT")
    app = App(token, os.environ.get("DOCUMENT_READERS_ALLOWED_HOSTS", "localhost,127.0.0.1,document-readers").split(","),
              max(1, int(os.environ.get("DOCUMENT_READERS_WORKERS", "2"))))
    threading.Thread(target=app.executor.watchdog, daemon=True).start()
    bind = os.environ.get("DOCUMENT_READERS_BIND_HOST") or "0.0.0.0"
    server = ReaderServer((bind, port), Handler)
    server.app = app  # type: ignore[attr-defined]

    stopping = threading.Event()

    def stop(signum: int, frame: object) -> None:
        del frame
        if stopping.is_set():
            return
        stopping.set()
        def drain() -> None:
            event("shutdown.begin", signal=signal.Signals(signum).name, outstanding=app.executor.outstanding)
            server.shutdown()
            deadline = time.monotonic() + 25
            while app.executor.outstanding and time.monotonic() < deadline:
                time.sleep(0.1)
            event("shutdown.end", outstanding=app.executor.outstanding)
            os._exit(0)
        threading.Thread(target=drain, daemon=True).start()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    event("listening", host=bind, port=port, workers=app.executor.pool._max_workers)
    server.serve_forever()


if __name__ == "__main__":
    main()
