"""Signed, stateless resource URIs backing `resources/read`'s capability-based authorization.

## Why capability-based, not identity-based

`resources/read` carries only `{uri}` — no ticket, no identity of any kind. A resource URI that was
predictable from a `documentId` — the earlier `document://{documentId}/extraction` scheme — let any
principal who could guess or enumerate a `documentId` read another principal's document: a
cross-tenant data leak, found by audit and fixed by making **the URI itself the authorization**.
`resources/list` never enumerates (the reader always answers `[]`); a principal learns a URI only
inside the tool result of the call that minted it.

## Why signed instead of stored

The URI carries what the result was made from — tool name, arguments, expiry, a random nonce —
and an HMAC over them. Any pod holding the same key verifies it and serves the read again from
the archive; a `documentId` is content-derived, so the bytes and therefore the result are the
same. Nothing is stored, so there is nothing to bound or evict.

The key comes from `DOCUMENT_READERS_TOKEN`, the secret the pods already share (only the
backend, which may call the tools directly anyway, also holds it). Without that variable the
process uses a random key of its own.
Unforgeability plus expiry is the property enforced, not "the right person is asking": this server
cannot see who asks.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
import time
import zlib
from typing import Any, Callable
from settings import read_setting

SCHEME = "document://"
NONCE_BYTES = 12
SIGNATURE_BYTES = 16  # 128-bit tag
# Matches the document-source ticket's own fixed lifetime (5 minutes).
DEFAULT_GRANT_TTL_SECONDS = int(read_setting("DOCUMENT_READERS_GRANT_TTL_SECONDS", ("GRANT_TTL_SECONDS",)) or "300")
# The calling runtime refuses longer resource URIs (adapter-mcp MAX_RESOURCE_URI_LENGTH); a result
# whose arguments would not fit gets no URI rather than one that can never be read.
MAX_URI_LENGTH = 2048
# Characters a result reserves for its own `resourceUri` when fitting itself to the result budget.
URI_SIZE_RESERVE = 512


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def grant_key() -> bytes:
    token = os.environ.get("DOCUMENT_READERS_TOKEN", "")
    if token:
        return hmac.new(token.encode(), b"document-readers/resource-uri/v1", hashlib.sha256).digest()
    return secrets.token_bytes(32)


class GrantStore:
    def __init__(self, *, key: bytes | None = None, ttl_seconds: float = DEFAULT_GRANT_TTL_SECONDS) -> None:
        self._key = key if key is not None else grant_key()
        self._ttl_seconds = ttl_seconds

    def _sign(self, body: str) -> str:
        return _b64(hmac.new(self._key, body.encode("ascii"), hashlib.sha256).digest()[:SIGNATURE_BYTES])

    def mint(self, tool: str, arguments: dict, build_payload: Callable[[str | None], dict]) -> tuple[str | None, dict]:
        """`build_payload(uri)` builds the tool's structured result, which embeds the URI as its own
        `resourceUri` — or leaves it out when `uri` is None (arguments too large to carry). Returns
        `(uri, payload)`."""
        claims = {"t": tool, "a": arguments, "e": int(time.time() + self._ttl_seconds), "n": _b64(secrets.token_bytes(NONCE_BYTES))}
        packed = json.dumps(claims, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode("utf-8")
        body = _b64(zlib.compress(packed, 9))
        uri: str | None = f"{SCHEME}{body}.{self._sign(body)}"
        if len(uri) > MAX_URI_LENGTH:
            uri = None
        return uri, build_payload(uri)

    def get(self, uri: str) -> tuple[str, dict[str, Any]] | None:
        """`(tool, arguments)` for a genuine, unexpired URI; `None` for anything else — unknown,
        forged, expired and malformed are deliberately indistinguishable to the caller."""
        if not isinstance(uri, str) or not uri.startswith(SCHEME):
            return None
        body, _, signature = uri[len(SCHEME):].partition(".")
        if not body or not signature or not hmac.compare_digest(signature, self._sign(body)):
            return None
        try:
            claims = json.loads(zlib.decompress(_unb64(body), bufsize=MAX_URI_LENGTH * 8))
        except (ValueError, UnicodeDecodeError, zlib.error):
            return None
        if not isinstance(claims, dict) or not isinstance(claims.get("t"), str) or not isinstance(claims.get("a"), dict):
            return None
        if not isinstance(claims.get("e"), int) or claims["e"] < time.time():
            return None
        return claims["t"], claims["a"]
