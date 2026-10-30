"""Where document bytes come from — object storage, or a local directory for tests and dev.

The HTTP reader reads here. The server has no
login of its own: it gets read access to the storage from its environment, by `documentId`, and
reads nothing else. Ownership (tenant) is checked by the backend before it calls a tool.

- **Object storage** (`DOCUMENT_S3_ENV_PREFIX`, `DOCUMENT_S3_PREFIX` — see `s3_source.py`): the
  object `<DOCUMENT_S3_PREFIX><documentId>`, its original name in `x-amz-meta-filename`
  (percent-encoded). This is where the agent puts chat attachments.
- **Local directory** (`DOCUMENT_SOURCE_DIR`, takes precedence): `<dir>/<documentId>`, with an
  optional `<documentId>.meta.json` (`{"name", "mediaType"}`) beside it.

A `documentId` is opaque and unguessable (the agent derives it with a keyed hash); knowing one is
what lets a conversation read it, the same capability model `grants.py` uses for resource URIs.
Ids are content-derived, so a cached copy can never go stale — hence the bounded cache below.
"""
from __future__ import annotations

import json
import mimetypes
import os
import re
import threading
import urllib.parse
from collections import OrderedDict
from file_source import FetchedDocument

import s3_source
from errors import ToolInputError



def _source_dir() -> str:
    """Read per call, not at import: `http_server.py --local` derives it after importing this module."""
    return os.environ.get("DOCUMENT_SOURCE_DIR", "").strip()

META_SUFFIX = ".meta.json"
DOCUMENT_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$")

# A document we will not even attempt to read/parse past this size. Generous enough for a real
# office document, small enough that a misplaced file can't hand us something unbounded.
MAX_DOCUMENT_BYTES = 25 * 1024 * 1024


class BoundedDocumentCache:
    """Most recently read documents, bounded by count and total bytes. Paging through one large
    workbook is many calls on one document; without this each would download it again."""

    def __init__(self, *, max_entries: int = 16, max_total_bytes: int = 128 * 1024 * 1024) -> None:
        self._entries: "OrderedDict[str, FetchedDocument]" = OrderedDict()
        self._max_entries = max_entries
        self._max_total_bytes = max_total_bytes
        self._total_bytes = 0
        self._lock = threading.Lock()  # HTTP mode reads on several worker threads

    def get(self, document_id: str) -> FetchedDocument | None:
        with self._lock:
            document = self._entries.get(document_id)
            if document is not None:
                self._entries.move_to_end(document_id)
            return document

    def put(self, document: FetchedDocument) -> None:
        with self._lock:
            if document.document_id in self._entries:
                return
            self._entries[document.document_id] = document
            self._total_bytes += len(document.content)
            while self._entries and (len(self._entries) > self._max_entries or self._total_bytes > self._max_total_bytes):
                _, evicted = self._entries.popitem(last=False)
                self._total_bytes -= len(evicted.content)


_CACHE = BoundedDocumentCache()
_S3_LOCATION: "s3_source.S3Location | None" = None


def _s3_location() -> "s3_source.S3Location | None":
    """Read on first use, so a misconfiguration is a tool error naming the variable, not a dead process."""
    global _S3_LOCATION
    if _S3_LOCATION is None:
        try:
            _S3_LOCATION = s3_source.configured_location()
        except RuntimeError as error:
            raise ToolInputError(f"office-docs storage is misconfigured: {error}") from error
    return _S3_LOCATION


def read_document_bytes(document_id: str) -> FetchedDocument:
    """Reads one document by its opaque id. The id may not carry a path separator, a leading dot or
    the sidecar suffix, so nothing outside the configured storage is ever reachable."""
    if not isinstance(document_id, str) or not DOCUMENT_ID_PATTERN.match(document_id) or document_id.endswith(META_SUFFIX):
        raise ToolInputError(f"document {document_id} is not a valid document id")
    if _source_dir():
        return _read_local(document_id)
    location = _s3_location()
    if location is None:
        raise ToolInputError("office-docs has no document storage configured (DOCUMENT_S3_ENV_PREFIX / DOCUMENT_SOURCE_DIR)")
    cached = _CACHE.get(document_id)
    if cached is not None:
        return cached
    try:
        found = s3_source.get_object(location, location.key_prefix + document_id, MAX_DOCUMENT_BYTES)
    except s3_source.S3NotFound as error:
        raise ToolInputError(f"document {document_id} was not found", code="document_not_found") from error
    except s3_source.S3TooLarge as error:
        raise ToolInputError(f"document {document_id} exceeds the {MAX_DOCUMENT_BYTES} byte limit", code="document_too_large") from error
    except RuntimeError as error:
        raise ToolInputError(f"document {document_id} could not be read: {error}") from error
    encoded_name = found.metadata.get("filename", "")
    name = urllib.parse.unquote(encoded_name) if encoded_name else document_id
    media_type = found.content_type.split(";")[0].strip() or mimetypes.guess_type(name)[0] or "application/octet-stream"
    document = FetchedDocument(document_id=document_id, name=name, media_type=media_type, content=found.content)
    _CACHE.put(document)
    return document


def _read_local(document_id: str) -> FetchedDocument:
    path = os.path.join(_source_dir(), document_id)
    if not os.path.isfile(path):
        raise ToolInputError(f"document {document_id} was not found", code="document_not_found")
    if os.path.getsize(path) > MAX_DOCUMENT_BYTES:
        raise ToolInputError(f"document {document_id} exceeds the {MAX_DOCUMENT_BYTES} byte limit", code="document_too_large")
    name = document_id
    media_type = ""
    meta_path = path + META_SUFFIX
    if os.path.isfile(meta_path):
        try:
            with open(meta_path, encoding="utf-8") as handle:
                meta = json.load(handle)
            name = str(meta.get("name") or name)
            media_type = str(meta.get("mediaType") or "")
        except (OSError, ValueError):
            pass  # an unreadable sidecar costs the original name, not the document
    media_type = media_type or mimetypes.guess_type(name)[0] or "application/octet-stream"
    with open(path, "rb") as handle:
        content = handle.read()
    return FetchedDocument(document_id=document_id, name=name, media_type=media_type, content=content)


class StorageDocumentSource:
    """Local directory or object storage, selected from the environment of this process."""
    read = staticmethod(read_document_bytes)
