"""In-process session for the office-docs reader.

The HTTP server (`http_server.py`) and the in-process checks share this. A resource URI is
signed, not stored, so any process with the same `DOCUMENT_READERS_TOKEN` can serve a URI another
one minted. `resources/list` stays empty: a URI is learned only inside the tool result that minted it.
"""
from __future__ import annotations

from dataclasses import dataclass, field

from errors import ResourceAccessError, ToolInputError
from file_source import DocumentSource
from grants import GrantStore
from protocol import Dispatcher, ToolCall
from tools import build_tool_registry


def _storage_source() -> DocumentSource:
    from backend import StorageDocumentSource
    return StorageDocumentSource()


@dataclass
class Services:
    """Grants and document bytes for one reader process. Dispatch is stateless per message:
    `tools/call` works with no earlier handshake."""

    grants: GrantStore = field(default_factory=GrantStore)
    documents: DocumentSource = field(default_factory=_storage_source)


def _list_resources() -> list[dict]:
    return []


_RESOURCE_REFUSAL = ("this resource URI is unknown, expired, or malformed. Resource URIs are returned "
                     "inside a read_document/read_table result — call the tool again for a fresh one.")


def _read_resource(services: Services, tools, uri: str) -> dict:
    """Verifies the signed URI, then serves the same read again from the archive. Unknown, forged,
    expired and malformed URIs all get one identical message."""
    granted = services.grants.get(uri)
    spec = tools.get(granted[0]) if granted else None
    if spec is None:
        raise ResourceAccessError(_RESOURCE_REFUSAL)
    try:
        outcome = spec.handler(granted[1], ToolCall(services=services))
    except ToolInputError as error:
        raise ResourceAccessError(f"the document behind this resource can no longer be read: {error}") from error
    return outcome["structured"]


def _build_dispatcher(services: Services, tools=None) -> Dispatcher:
    registry = tools if tools is not None else build_tool_registry()
    return Dispatcher(
        tools=registry,
        services=services,
        list_resources=_list_resources,
        read_resource=lambda uri: _read_resource(services, registry, uri),
    )
