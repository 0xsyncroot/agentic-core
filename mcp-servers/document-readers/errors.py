"""Shared exception types for the office-docs MCP server.

Kept in their own module so `tools.py`, `backend.py`, `documents.py`/`tables.py` and `protocol.py`
can all raise and catch them without an import cycle. Each type carries the JSON-RPC/tool-result
treatment it gets, documented on the class.
"""
from __future__ import annotations


class ToolInputError(Exception):
    """A business-level problem with a tool call's own arguments or a document's content.

    Reported to the caller as a `tools/call` result with `isError: true` — never a JSON-RPC
    protocol error. This is the catch-all for "the request was well-formed JSON-RPC but the
    document/arguments make no sense" (unknown sheet name, unparsable workbook, oversized
    result, ...).

    `code` names the kind of refusal for a caller that has to tell them apart without reading the
    sentence — the product's activity trace says "document not found" and "no such sheet" in its
    own words, and those are different things to tell a user. The sentence stays for the model.

    A refusal whose sentence repeats cells of the document (the row it read as a header, the rows
    that look like one) says so with `echoes_cells`, and names those rows in `rows`. The model gets
    the sentence unchanged; the server log gets the code and the row numbers, never the cells.
    """

    def __init__(self, message: str, code: str | None = None, *, echoes_cells: bool = False,
                 rows: tuple[int, ...] = ()) -> None:
        super().__init__(message)
        self.code = code
        self.echoes_cells = echoes_cells
        self.rows = rows


class ResourceAccessError(Exception):
    """`resources/read` was asked for a URI this process has no cached, already-authorized result
    for. Mapped to a JSON-RPC `INVALID_PARAMS` error by `protocol.py` — unlike the tool errors
    above, resource reads are not tool calls and have no `isError` content channel.
    """
