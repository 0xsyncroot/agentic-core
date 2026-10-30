"""Grant-store (`resources/read` capability) security checks for `selftest.py` — split into its
own file to keep `selftest.py` under the per-file line budget. See `grants.py`'s module docstring
for what these prove and why: `resources/list` must never enumerate, and `resources/read` must
only ever honor a URI the caller was actually handed inside a tool result — this is the fix for a
cross-principal data leak an audit found (one process serving every principal, with a
document-id-predictable resource URI and an enumerable `resources/list`).
"""
from __future__ import annotations

import json
import time

from wire_client import HttpClient, Results, result_of

FORGED_URI = "document://" + "ab" * 16  # the old random-id shape, never minted under this key
MALFORMED_URIS = ["not-a-uri-at-all", "http://document/whatever", "document://"]


def run_grant_checks(results: Results, client: HttpClient, script_dir: str, source_dir: str) -> None:
    doc_a = result_of(
        client.request("tools/call", {"name": "read_document", "arguments": {"documentId": "doc-table"}}),
        results, "mint a grant for doc-table (for grant checks)",
    )
    doc_b = result_of(
        client.request("tools/call", {"name": "read_document", "arguments": {"documentId": "doc-text"}}),
        results, "mint a grant for doc-text (for grant checks)",
    )
    if doc_a is None or doc_b is None:
        return
    uri_a = doc_a["structuredContent"]["resourceUri"]
    uri_b = doc_b["structuredContent"]["resourceUri"]
    results.check(
        "two calls mint two different signed URIs (body.signature)",
        uri_a != uri_b and all(uri.startswith("document://") and uri.count(".") == 1 for uri in (uri_a, uri_b)),
        f"a={uri_a!r} b={uri_b!r}",
    )
    body, _, signature = uri_a[len("document://"):].partition(".")
    tampered = client.request("resources/read", {"uri": f"document://{body}.{('A' if signature[0] != 'A' else 'B') + signature[1:]}"})
    results.check("a URI whose signature was altered is refused", "error" in tampered, str(tampered)[:200])
    _run_other_process_check(results, script_dir, source_dir)

    listing = result_of(client.request("resources/list"), results, "resources/list responds (with live grants present)")
    if listing is not None:
        results.check("resources/list never enumerates grants, even when live ones exist", listing.get("resources") == [], str(listing))

    read_a = result_of(client.request("resources/read", {"uri": uri_a}), results, "resources/read on doc-table's own grant responds")
    read_b = result_of(client.request("resources/read", {"uri": uri_b}), results, "resources/read on doc-text's own grant responds")
    if read_a is not None and read_b is not None:
        payload_a = json.loads(read_a["contents"][0]["text"])
        payload_b = json.loads(read_b["contents"][0]["text"])
        results.check(
            "the legitimate flow works, and a grant for document X never returns document Y's data",
            payload_a.get("documentId") == "doc-table" and payload_b.get("documentId") == "doc-text",
            f"a={payload_a} b={payload_b}",
        )

    error_texts = []
    forged = client.request("resources/read", {"uri": FORGED_URI})
    results.check("a forged grant id nobody was ever handed is refused (not guessable)", "error" in forged, str(forged))
    if "error" in forged:
        error_texts.append(forged["error"]["message"])
    for bad_uri in MALFORMED_URIS:
        response = client.request("resources/read", {"uri": bad_uri})
        results.check(f"a malformed resource URI ({bad_uri!r}) is refused", "error" in response, str(response))
        if "error" in response:
            error_texts.append(response["error"]["message"])
    results.check(
        "a forged and every malformed resource URI fail with byte-identical messages",
        len(error_texts) == 1 + len(MALFORMED_URIS) and len(set(error_texts)) == 1,
        str(error_texts),
    )

    _run_expiry_check(results, script_dir, source_dir)
    _run_oversize_check(results)


def _run_other_process_check(results: Results, script_dir: str, source_dir: str) -> None:
    """Several reader pods: a URI minted by one process is served by another holding the same key."""
    shared = {"DOCUMENT_READERS_TOKEN": "s" * 40}
    first, second = HttpClient(script_dir, source_dir, extra_env=shared), HttpClient(script_dir, source_dir, extra_env=shared)
    stranger = HttpClient(script_dir, source_dir, extra_env={"DOCUMENT_READERS_TOKEN": "t" * 40})
    try:
        minted = result_of(first.request("tools/call", {"name": "read_document", "arguments": {"documentId": "doc-table"}}),
                           results, "mint a URI in one reader process")
        if minted is None:
            return
        uri = minted["structuredContent"]["resourceUri"]
        served = second.request("resources/read", {"uri": uri})
        payload = json.loads(served["result"]["contents"][0]["text"]) if "result" in served else {}
        results.check("another reader process with the same key serves the URI (any pod can answer)",
                      payload.get("documentId") == "doc-table", str(served)[:200])
        results.check("a process with a different key refuses it", "error" in stranger.request("resources/read", {"uri": uri}))
    finally:
        for client in (first, second, stranger):
            client.close()


def _run_oversize_check(results: Results) -> None:
    """Arguments too large for the runtime's 2048-character URI limit: no URI, not an unreadable one."""
    import secrets as random_source
    from grants import MAX_URI_LENGTH, GrantStore
    store = GrantStore(key=b"k" * 32)
    uri, payload = store.mint("read_table", {"documentId": "d", "columns": {"x": [random_source.token_hex(2000)]}},
                              lambda minted: {"resourceUri": minted} if minted else {})
    results.check("arguments past the URI limit mint no URI and leave it out of the result",
                  uri is None and "resourceUri" not in payload, f"uri length {len(uri) if uri else None} > {MAX_URI_LENGTH}")


def _run_expiry_check(results: Results, script_dir: str, source_dir: str) -> None:
    short_lived_client = HttpClient(script_dir, source_dir, extra_env={"DOCUMENT_READERS_GRANT_TTL_SECONDS": "1"})
    try:
        minted = result_of(
            short_lived_client.request("tools/call", {"name": "read_document", "arguments": {"documentId": "doc-table"}}),
            results, "mint a short-lived grant (for expiry check) responds",
        )
        if minted is None:
            return
        uri = minted["structuredContent"]["resourceUri"]
        still_live = short_lived_client.request("resources/read", {"uri": uri})
        results.check("a fresh grant is readable before it expires", "result" in still_live, str(still_live))
        time.sleep(1.5)
        expired = short_lived_client.request("resources/read", {"uri": uri})
        results.check("a grant is refused once its TTL has passed", "error" in expired, str(expired))
    finally:
        short_lived_client.close()
