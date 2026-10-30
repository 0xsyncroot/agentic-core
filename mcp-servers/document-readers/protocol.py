"""JSON-RPC 2.0 dispatch for the office-docs HTTP MCP server.

Wire framing is `POST /mcp` in `http_server.py`. This module is pure dispatch, era negotiation
and result-envelope shaping, so it can be exercised without speaking HTTP.

## The critical finding this module exists to honour

Two MCP eras share the wire:

- **legacy** ("2025-11-25"): the classic `initialize` / `notifications/initialized` handshake.
  Results are the bare payload — no `resultType` wrapper.
- **modern** ("2026-07-28", `MODERN_PROTOCOL_VERSION`): reached only through `server/discover`.
  Every result is wrapped with `resultType: "complete" | "input_required"`. Only the modern era
  can carry `input_required` — the multi-round-trip form a tool needs when it has to ask the
  caller something mid-call (which sheet, which value) before it can finish. No tool here uses
  that today, but the plumbing (`_input_required` below, and every result going out
  modern-shaped) is kept live on purpose: a tool server that cannot raise a form is a dead end
  the moment someone adds a tool that needs one, and the failure mode if it isn't ready is
  silent (see the next paragraph).

Each `POST /mcp` is one message. The official client may send `tools/call` on a connection
that never saw `initialize` or `server/discover`. Dispatch is stateless per message: nothing
may assume a handshake happened earlier. `tools/call` must work as the first message a process
receives.

Symmetrically, a legacy-only client only ever sends `initialize`. If this server answered its
`tools/call` with `resultType: "input_required"` on that connection, the legacy codec silently
strips `resultType` and reports the result as an ordinary complete response — a question the
server needed answered would simply never surface, with no error anywhere. There is no
per-connection state to branch on here (this process may serve either kind of client on any
message), so this server always emits the modern-shaped envelope; a legacy client's own codec is
what strips it back down. The one consequence that DOES matter for us: since we cannot know in
advance whether a caller can see `input_required`, we always implement `server/discover` (never
only `initialize`) so the modern path is actually reachable.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable

from errors import ResourceAccessError, ToolInputError
from diagnostics import error_details

MODERN_PROTOCOL_VERSION = "2026-07-28"
LEGACY_PROTOCOL_VERSION = "2025-11-25"
SERVER_INFO = {"name": "office-docs-mcp", "version": "0.1.0"}
SERVER_CAPABILITIES = {"tools": {}, "resources": {}}
SERVER_INSTRUCTIONS = (
    "office-docs: reader for Office Open XML documents (.xlsx/.docx) and image files. Every call takes "
    "the documentId of a file already provided to this conversation. Large documents are read in pages, "
    "never whole: read_document first (sheets, headings, row counts), then read_table for the sheet you "
    "need and keep passing the returned nextOffset as offset until it is absent; use read_cells for exact "
    "cells and formulas. Each answer is sized to fit one reply, so a page may hold fewer rows than "
    "maxRows. Take row numbers from rowNumbers, never from counting. If a call answers that the reader "
    "is busy or took too long, retry the same call or ask for a smaller page; the file is not the problem. "
    "Formulas are returned as written and are never recalculated."
)

# JSON-RPC 2.0 standard error codes.
PARSE_ERROR = -32700
INVALID_REQUEST = -32600
METHOD_NOT_FOUND = -32601
INVALID_PARAMS = -32602
INTERNAL_ERROR = -32603


class JsonRpcError(Exception):
    """A protocol-level error: turned into a JSON-RPC `error` member, never an `isError` result."""

    def __init__(self, code: int, message: str, data: Any = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.data = data


def _complete(body: dict) -> dict:
    return {"resultType": "complete", **body}


def _input_required(input_requests: dict, request_state: str) -> dict:
    return {"resultType": "input_required", "inputRequests": input_requests, "requestState": request_state}


def _text_block(value: Any) -> list[dict]:
    import json

    return [{"type": "text", "text": json.dumps(value, ensure_ascii=False)}]


def _call_tool_result(structured: Any, content: list[dict] | None = None) -> dict:
    """Builds the tools/call result.

    `content` lets a handler return blocks other than the JSON text block — specifically an image
    block for a document this server cannot parse into rows because it is a picture of one. That is
    not a workaround: a scanned biểu is read by the model looking at it, and the alternative would
    be an OCR-and-heuristics layer in here, which is precisely the kind of guessing this server
    exists to stay out of. `structuredContent` is still sent alongside, so a caller that only reads
    structured output still learns what the document is.
    """
    return _complete({"content": content or _text_block(structured), "structuredContent": structured})


def _error_tool_result(message: str, code: str | None = None) -> dict:
    return _complete({"content": _text_block({"error": message, **({"code": code} if code else {})}), "isError": True})


@dataclass
class ToolCall:
    """Everything a tool handler needs for one `tools/call` invocation."""

    services: Any  # session.Services — document source and grant key
    input_responses: dict | None = None
    request_state: str | None = None


@dataclass
class ToolSpec:
    description: str
    input_schema: dict
    annotations: dict
    handler: Callable[[dict, ToolCall], dict]


@dataclass
class Dispatcher:
    """Bundles the tool registry and resource store dispatch depends on."""

    tools: dict[str, ToolSpec]
    services: Any
    list_resources: Callable[[], list[dict]]
    read_resource: Callable[[str], dict]


def handle_request(method: str, params: dict | None, dispatcher: Dispatcher,
                   on_error: Callable[[BaseException], None] | None = None) -> dict:
    """Returns the JSON-RPC `result` value for one request. Raises `JsonRpcError` on failure."""
    params = params or {}
    if method == "initialize":
        return {
            "protocolVersion": LEGACY_PROTOCOL_VERSION,
            "capabilities": SERVER_CAPABILITIES,
            "serverInfo": SERVER_INFO,
            "instructions": SERVER_INSTRUCTIONS,
        }
    if method == "server/discover":
        return _complete({
            "ttlMs": 0,
            "cacheScope": "private",
            "supportedVersions": [MODERN_PROTOCOL_VERSION],
            "capabilities": SERVER_CAPABILITIES,
            "instructions": SERVER_INSTRUCTIONS,
        })
    if method == "ping":
        return _complete({})
    if method == "tools/list":
        tools = [
            {"name": name, "description": spec.description, "inputSchema": spec.input_schema, "annotations": spec.annotations}
            for name, spec in dispatcher.tools.items()
        ]
        return _complete({"ttlMs": 0, "cacheScope": "private", "tools": tools})
    if method == "tools/call":
        return _handle_tools_call(params, dispatcher, on_error)
    if method == "resources/list":
        return _complete({"ttlMs": 0, "cacheScope": "private", "resources": dispatcher.list_resources()})
    if method == "resources/read":
        uri = params.get("uri")
        if not isinstance(uri, str):
            raise JsonRpcError(INVALID_PARAMS, "uri is required")
        try:
            payload = dispatcher.read_resource(uri)
        except ResourceAccessError as error:
            raise JsonRpcError(INVALID_PARAMS, str(error)) from error
        import json

        return _complete({
            "ttlMs": 0,
            "cacheScope": "private",
            "contents": [{"uri": uri, "mimeType": "application/json", "text": json.dumps(payload, ensure_ascii=False)}],
        })
    raise JsonRpcError(METHOD_NOT_FOUND, f"Method not found: {method}")


def _handle_tools_call(params: dict, dispatcher: Dispatcher,
                       on_error: Callable[[BaseException], None] | None = None) -> dict:
    name = params.get("name")
    spec = dispatcher.tools.get(name) if isinstance(name, str) else None
    if spec is None:
        raise JsonRpcError(METHOD_NOT_FOUND, f"Unknown tool: {name}")
    args = params.get("arguments") or {}
    call = ToolCall(
        services=dispatcher.services,
        input_responses=params.get("inputResponses"),
        request_state=params.get("requestState"),
    )
    try:
        outcome = spec.handler(args, call)
    except ToolInputError as error:
        if on_error:
            on_error(error)
        # Both a bad-input problem and an unreachable backend become an `isError` tool result,
        # never a JSON-RPC protocol error: an isError result gives the caller (and the LLM reading it) a plain-English
        # reason instead of a raw JSON-RPC error object.
        return _error_tool_result(str(error), getattr(error, "code", None))
    if "elicit" in outcome:
        elicit = outcome["elicit"]
        input_requests = {
            elicit["key"]: {
                "method": "elicitation/create",
                "params": {"message": elicit["message"], "mode": "form", "requestedSchema": elicit["requestedSchema"]},
            }
        }
        return _input_required(input_requests, elicit["state"])
    return _call_tool_result(outcome["structured"], outcome.get("content"))


def to_jsonrpc_error(error: BaseException) -> dict:
    if isinstance(error, JsonRpcError):
        return {"code": error.code, "message": error.message}
    if isinstance(error, (ToolInputError, ValueError)):
        return {"code": INVALID_PARAMS, "message": str(error)}
    return {"code": INTERNAL_ERROR, "message": str(error) or "Internal error"}


@dataclass
class HandledMessage:
    kind: str  # "none" | "result" | "error"
    id: Any = None
    result: dict | None = None
    error: dict | None = None
    # Operator-only: never included in the JSON-RPC result/error envelope.
    diagnostic: dict | None = None


def handle_message(message: Any, dispatcher: Dispatcher) -> HandledMessage:
    """Handles one already-JSON-parsed message. Never raises — every failure is captured into
    the returned `HandledMessage` (or, for a malformed notification, silently dropped, matching
    JSON-RPC 2.0: a notification never gets a reply, not even an error reply)."""
    is_notification = not isinstance(message, dict) or "id" not in message
    method = message.get("method") if isinstance(message, dict) else None
    if not isinstance(method, str):
        if is_notification:
            return HandledMessage(kind="none")
        return HandledMessage(kind="error", id=message.get("id"), error={"code": INVALID_REQUEST, "message": "Invalid request"})
    diagnostics = []
    try:
        result = handle_request(method, message.get("params"), dispatcher,
                                lambda error: diagnostics.append(error_details(error)))
        if is_notification:
            return HandledMessage(kind="none")
        return HandledMessage(kind="result", id=message["id"], result=result if result is not None else _complete({}),
                              diagnostic=diagnostics[0] if diagnostics else None)
    except Exception as error:  # noqa: BLE001 - every failure must become a JSON-RPC error, not a crash
        if is_notification:
            return HandledMessage(kind="none")
        return HandledMessage(kind="error", id=message["id"], error=to_jsonrpc_error(error), diagnostic=error_details(error))
