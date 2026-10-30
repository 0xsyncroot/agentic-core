"""The two office-docs MCP tools: JSON Schemas and handlers.

A handler returns either `{"structured": <result>}` (a normal complete tool result) or
`{"elicit": {"key", "message", "requestedSchema", "state"}}`, which `protocol.py` turns into a
`resultType: "input_required"` result — no tool here uses that today (see `protocol.py`'s
module docstring on why the plumbing is kept anyway). Raising `ToolInputError` becomes an `isError` tool result —
never a JSON-RPC protocol error, since an unknown document id or an unparsable document is the
caller's problem to fix and retry, not ours.

Both tools mint a signed resource URI for their own result via `call.services.grants.mint`
(see `grants.py`) — the returned `resourceUri` is the only way `resources/read` can serve this
result again, from any reader process, to whoever receives this tool result.
"""
from __future__ import annotations

import json
from typing import Any, Callable

import documents
import tables
import xlsx_reader
from errors import ToolInputError
from header_paths import header_paths
from settings import read_setting
from grants import URI_SIZE_RESERVE
from protocol import ToolCall, ToolSpec

MAX_RESULT_BYTES = 256 * 1024

# What one result may weigh, in characters of JSON. The runtime that calls this server keeps a tool
# result only up to its own budget — 32,000 characters unless it is told otherwise — and refuses a
# larger one whole: the model is told the read failed, on a document that was read. That happened
# on a real 46-sheet dossier, whose overview alone was over, and a bigger workbook only makes it
# worse. So a result is built to fit: every list it carries (a workbook's sheets, a sheet's rows, a
# document's paragraphs) is a page, cut to what fits, with the offset of the next page beside it.
# No document is too large to read; a large one takes more calls. The margin under 32,000 is for
# the envelope the result travels in.
RESULT_CHAR_BUDGET = max(4_000, int(read_setting("DOCUMENT_READERS_RESULT_CHARS", ("OFFICE_DOCS_RESULT_CHARS",)) or "24000"))
# A whole table in one result (`read_table` with `all`): under MAX_RESULT_BYTES in bytes, with room for 3-byte letters.
WHOLE_TABLE_CHAR_BUDGET = 150_000


def _chars(value: Any) -> int:
    return len(json.dumps(value, ensure_ascii=False))


def _fit(build: Callable[[int], dict], count: int, budget: int, floor: int = 1) -> int:
    """How many entries of a list `build(n)` can carry and still weigh no more than `budget`.

    Never fewer than `floor`: a page that carries nothing cannot be told from a list that is empty,
    and one entry too large for any page is refused out loud by the size check after this.
    """
    while count > floor:
        size = _chars(build(count))
        if size <= budget:
            break
        each = max(1, (size - _chars(build(0))) // count)
        count = max(floor, min(count - 1, count - (size - budget) // each))
    return count


def _offset(args: dict, name: str) -> int:
    value = args.get(name, 0)
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise ToolInputError(f"{name} must be a non-negative integer")
    return value


def _assert_within_result_bounds(structured: dict) -> None:
    size = len(json.dumps(structured, ensure_ascii=False).encode("utf-8"))
    if size > MAX_RESULT_BYTES:
        raise ToolInputError(
            f"result is {size} bytes, over the {MAX_RESULT_BYTES} byte cap; narrow the request "
            "(a single sheet, a smaller maxRows, fewer requested columns) instead of retrying as-is"
        )


def _handle_read_document(args: dict, call: ToolCall) -> dict:
    document_id = args.get("documentId")
    if not isinstance(document_id, str) or not document_id:
        raise ToolInputError("documentId is required")
    document = call.services.documents.read(document_id)
    offset = _offset(args, "offset")
    sheet_offset = _offset(args, "sheetOffset")
    table_offset = _offset(args, "tableOffset")
    formulas = args.get("formulas", True)
    if not isinstance(formulas, bool):
        raise ToolInputError("formulas must be a boolean")
    result = documents.read_document(document, sheet=args.get("sheet"), max_rows=args.get("maxRows"), row_offset=offset,
                                     table_offset=table_offset, formulas=formulas)
    preview, sheets = _paged_overview(result, document.name, offset, sheet_offset, named_sheet=args.get("sheet") is not None)

    def build(uri: str) -> dict:
        structured: dict[str, Any] = {
            "documentId": result.document_id,
            # The file's own name, as the user knows it: an id means nothing to them, and whoever
            # reports this read — the model in its answer, the product in its activity trace —
            # otherwise has only the id to call it by.
            "name": document.name,
            "kind": result.kind,
            "preview": preview,
            **({"resourceUri": uri} if uri else {}),
            **sheets,
            **_whole_table_call(result, preview, document.name),
        }
        _assert_within_result_bounds(structured)
        return structured

    _uri, structured = call.services.grants.mint("read_document", args, build)
    if result.kind == "image":
        import base64
        import mimetypes

        media_type = document.media_type if document.media_type.startswith("image/") else mimetypes.guess_type(document.name)[0]
        if not media_type or not media_type.startswith("image/"):
            raise ToolInputError("image media type could not be determined")
        return {
            "structured": structured,
            "content": [{
                "type": "image",
                "data": base64.b64encode(document.content).decode("ascii"),
                "mimeType": media_type,
            }],
        }
    return {"structured": structured}


def _whole_table_call(result: Any, preview: dict, name: str) -> dict:
    """The read a cut sheet preview calls for: the whole table, one `read_table` call, as data beside the preview.

    A preview is a window; a caller after the sheet's figures reads it whole, and a comparison or a total takes the
    table by the resultId of that one read. Named only when the window was cut (`nextOffset`); a preview that shows
    every row calls for nothing. The caller's runtime may make the call itself; to a reader it is the same advice.
    `reads` says what the call reads, for a runtime that weighs making it (`_reads`).
    """
    if result.kind != "workbook" or not result.sheet_name or preview.get("nextOffset") is None:
        return {}
    reads = _reads(result, preview, name)
    return {"nextCall": {
        "tool": "read_table",
        "arguments": {"documentId": result.document_id, "sheet": result.sheet_name, "all": True},
        "why": (f"the preview of sheet {result.sheet_name!r} shows {len(preview.get('rows', []))} of its "
                f"{preview.get('totalRows')} rows; read_table with all: true returns the whole table in one result"),
        **({"reads": reads} if reads else {}),
    }}


def _reads(result: Any, preview: dict, name: str) -> dict | None:
    """What the whole-table read reads: the file, every sheet of it, the sheet read, and how many of its rows the preview shows.

    Each sheet comes with its heading and the rows holding anything, so a reader can tell the sheet a task asks for from
    its neighbours. The list must fit a quarter of the result budget: past that it goes without the headings, then without
    the row counts. A list of names alone that still does not fit is not sent, and the call goes without `reads`: still
    named, never described by part of the workbook.
    """
    sheets = result.sheets or []
    own = next((entry for entry in sheets if entry.get("name") == result.sheet_name), {})
    full = [{"name": entry["name"], **({"heading": entry["heading"]} if entry.get("heading") else {}),
             "rows": entry.get("dataRowCount", 0)} for entry in sheets]
    shapes = (full, [{"name": part["name"], "rows": part["rows"]} for part in full], [{"name": part["name"]} for part in full])
    catalog = next((shape for shape in shapes if _chars(shape) <= RESULT_CHAR_BUDGET // 4), None)
    if catalog is None:
        return None
    return {
        "source": {"id": result.document_id, "name": name, **({"heading": own["heading"]} if own.get("heading") else {})},
        "unit": "sheet", "catalog": catalog, "target": result.sheet_name,
        "shown": {"rows": len(preview.get("rows", [])), "of": preview.get("totalRows", 0)},
    }


def _paged_overview(result: Any, name: str, offset: int, sheet_offset: int, *, named_sheet: bool) -> tuple[dict, dict]:
    """A document's preview and its sheet list, each cut to a page that fits the result budget.

    The call that names a sheet is asking for that sheet's rows, so they get most of the room and
    the sheet list what is left; the call that names none is surveying the workbook, so it is the
    other way round. Whatever a page leaves out is one call away: `nextOffset` for rows or
    paragraphs, `nextSheetOffset` for sheets, and the totals say how much there is in all.
    """
    preview = dict(result.preview)
    if result.kind == "text":
        paragraphs = preview["paragraphs"]
        table_rows = preview.get("tableRows", [])
        room = (RESULT_CHAR_BUDGET - 600) // 2 if table_rows else RESULT_CHAR_BUDGET - 400
        kept = _fit(lambda n: {"paragraphs": paragraphs[:n]}, len(paragraphs), room)
        if kept < len(paragraphs):
            preview.update(paragraphs=paragraphs[:kept], nextOffset=offset + kept)
        if table_rows:
            kept_rows = _fit(lambda n: {"tableRows": table_rows[:n]}, len(table_rows), room)
            if kept_rows < len(table_rows):
                prior = preview.get("nextTableOffset", preview["totalTableRows"]) - len(table_rows)
                preview.update(tableRows=table_rows[:kept_rows], nextTableOffset=prior + kept_rows)
        return preview, {}
    if result.kind != "workbook":
        return preview, {}
    # A row is its cells up to the last one holding anything. A form sheet is two dozen columns
    # wide and most rows fill three or four: on a real dossier 63% of the cells sent were empty,
    # and every one of them was paid for in the caller's context. Position still means column —
    # only the empty tail goes, never a cell between two filled ones.
    rows, numbers = [_without_empty_tail(row) for row in preview["rows"]], preview["rowNumbers"]
    preview["rows"] = rows
    formulas = preview.get("formulas")
    def row_preview(n):
        page = {**preview, "rows": rows[:n], "rowNumbers": numbers[:n]}
        if formulas is not None:
            row_set = set(numbers[:n]) | ({preview.get("headerRowNumber")} if offset == 0 else set())
            page["formulas"] = {address: entry for address, entry in formulas.items()
                                if int(''.join(c for c in address if c.isdigit())) in row_set}
        return page
    # A call that names a sheet is told about that sheet, not about the workbook again. The whole
    # list used to ride along on every such call — 5,700 characters, twenty-two times in one real
    # run — and a caller's context is where a long read is won or lost. The survey call lists them.
    own = [entry for entry in (result.sheets or []) if entry.get("name") == result.sheet_name][:1] if named_sheet and sheet_offset == 0 else None
    # The whole-table read a cut window names, with what it reads, rides beside it: its room is kept whether or not the
    # window is cut. A named sheet's rows give that room up; a survey's preview keeps its quarter and the sheet list pays.
    reserve = _chars(_whole_table_call(result, {**preview, "nextOffset": 0}, name))
    if own is not None:
        # With no list to carry, the named sheet's rows get the page, less its own entry and the envelope.
        room = RESULT_CHAR_BUDGET - 600 - _chars(own) - reserve
    else:
        room = RESULT_CHAR_BUDGET * 3 // 4 - reserve if named_sheet else RESULT_CHAR_BUDGET // 4
    kept = _fit(row_preview, len(rows), room)
    preview = row_preview(kept)
    if kept < len(rows):
        preview.update(rows=rows[:kept], rowNumbers=numbers[:kept], nextOffset=offset + kept)
    if own is not None:
        return preview, {"sheets": own, "totalSheets": len(result.sheets or [])}
    listed = (result.sheets or [])[sheet_offset:]
    left = max(0, RESULT_CHAR_BUDGET - 400 - _chars(preview) - reserve)
    # A survey always lists at least one sheet; a named sheet's read may have no room for any.
    count = _fit(lambda n: {"sheets": listed[:n]}, len(listed), left, floor=0 if named_sheet else min(1, len(listed)))
    sheets: dict[str, Any] = {"sheets": listed[:count], "totalSheets": len(result.sheets or [])}
    if sheet_offset + count < sheets["totalSheets"]:
        sheets["nextSheetOffset"] = sheet_offset + count
    return preview, sheets


def _without_empty_tail(row: list) -> list:
    end = len(row)
    while end > 0 and (row[end - 1] is None or (isinstance(row[end - 1], str) and not row[end - 1].strip())):
        end -= 1
    return row[:end]


def _select_sheet(workbook: xlsx_reader.WorkbookData, sheet_name: str | None, document_id: str) -> xlsx_reader.SheetData:
    if sheet_name is not None:
        # A name that differs only in spacing or tone marks is the same name typed differently, and
        # resolving it is visible rather than silent: every read_table result echoes `sheet` as the
        # sheet actually read. What cannot be resolved gets the near misses named first — before
        # the full list, which on a real dossier is forty-five names and was where the answer hid.
        names = [s.name for s in workbook.sheets]
        resolved, nearest = tables.select_sheet_name(names, sheet_name) if isinstance(sheet_name, str) else (None, [])
        if resolved is not None:
            return next(s for s in workbook.sheets if s.name == resolved)
        meant = f"closest sheet names: {', '.join(repr(tables.typed_sheet_name(name, names)) for name in nearest)}. " if nearest else ""
        raise ToolInputError(f"sheet {sheet_name!r} not found; {meant}available sheets: {', '.join(tables.typed_sheet_name(name, names) for name in names)}", code="sheet_not_found")
    if not workbook.sheets:
        raise ToolInputError(f"document {document_id} has no sheets")
    return workbook.sheets[0]


def _resolved_positions(selected: xlsx_reader.SheetData, columns: dict | None) -> list[tuple[str, int]]:
    resolved, _unresolved = tables.resolve_columns(selected.header, columns)
    return [(column.field, column.index) for column in resolved]


def _choose_header(whole: xlsx_reader.SheetData, header_row: int | None, columns: dict | None) -> tuple[xlsx_reader.SheetData, str]:
    """The sheet rebased on the header row to read, and a sentence when it is not the row the caller named.

    The row asked for stands whenever it resolves any of the titles asked for. When it does not (it
    is a caption line, a data row, or not a row of this sheet) and exactly one row carries every
    title, that row is used: the reader would otherwise compute the answer and refuse.
    """
    def attempt(row: int | None) -> xlsx_reader.SheetData | None:
        try:
            return whole if row is None else tables.rebase_header(whole, row)
        except ToolInputError:
            return None

    asked = attempt(header_row)
    if asked is not None and (not columns or tables.resolve_columns(asked.header, columns)[0]):
        # Down to the row that holds the column titles proper: a caption over a group row over the titles is three rows, and
        # stopping at the group row lost every amount under it (the salary and allowance amounts of a payroll form, live).
        lower, leaf = None, tables.leaf_header_row(whole, asked.header_row_number)
        for _ in range(3):
            candidate = attempt(leaf) if leaf is not None else None
            if candidate is None or (columns and not tables.resolve_columns(candidate.header, columns)[0]):
                break
            lower, leaf = candidate, tables.leaf_header_row(whole, candidate.header_row_number)
        if lower is not None:
            row = lower.header_row_number
            return lower, (f"Row {asked.header_row_number} holds titles merged over several columns; the titles of those columns are on row {row}, "
                           f"so row {row} was used as the header (the merged titles are the first parts of each columnPaths path).")
        return asked, ""
    found = tables.unique_header_row(whole, columns)
    chosen = attempt(found) if found is not None and found != (header_row if asked is not None else None) else None
    if chosen is not None:
        said = f"headerRow {header_row} " if header_row is not None else "The sheet's first row "
        return chosen, (f"{said}{'is not a row of this sheet' if asked is None else 'holds none of the titles asked for'}; "
                        f"row {found} is the only row that carries all of them, so it was used as the header.")
    if header_row is not None and asked is None:
        # Not a row of this sheet and no single row to use instead: the refusal names the rows that do hold the titles.
        try:
            tables.rebase_header(whole, header_row)
        except ToolInputError as error:
            hint = tables.rows_holding_titles(whole, columns)
            raise ToolInputError(f"{error}{' ' + hint if hint else ''}", code=error.code, echoes_cells=bool(hint),
                                 rows=(header_row, *tables.rows_named_in_hint(whole, columns))) from error
    return (asked if asked is not None else whole), ""


def _handle_read_table(args: dict, call: ToolCall) -> dict:
    document_id = args.get("documentId")
    if not isinstance(document_id, str) or not document_id:
        raise ToolInputError("documentId is required")
    columns = args.get("columns")
    if columns is not None and not isinstance(columns, dict):
        raise ToolInputError("columns must be an object mapping a field name to a list of header synonyms")

    document = call.services.documents.read(document_id)
    header_row = args.get("headerRow")
    if header_row is not None and (not isinstance(header_row, int) or isinstance(header_row, bool) or header_row < 1):
        raise ToolInputError("headerRow must be a positive integer worksheet row number")
    offset = _offset(args, "offset")
    skipped_offset = _offset(args, "skippedOffset")
    if "all" in args and not isinstance(args["all"], bool):
        raise ToolInputError("all must be a boolean")
    kind = documents.detect_kind(document)
    if kind != "workbook":
        hint = (
            " — it is an image; call read_document to look at it instead"
            if kind == "image" else ""
        )
        raise ToolInputError(f"document {document_id} is not a workbook; read_table only reads spreadsheet tables{hint}")
    workbook = documents.read_workbook(document)
    selected = _select_sheet(workbook, args.get("sheet"), document_id)

    whole = selected
    selected, header_note = _choose_header(whole, header_row, columns)
    result = tables.extract_table(selected, columns, whole)
    if header_note:
        result["headerRowNote"] = header_note
    if header_row is None and not columns:
        warning = tables.caption_header_warning(selected)
        if warning:
            result["headerWarning"] = warning
    result["columnPaths"] = header_paths(whole, selected.header_row_number, [
        (field, index, selected.header[index]) for field, index in _resolved_positions(selected, columns)])
    whole_table = args.get("all") is True
    # `all` is for a result the runtime keeps whole behind an id (the model passes the id on, it does not
    # read the rows): every row in one answer, as many as the size cap allows.
    max_rows = len(result["rows"]) or 1 if whole_table else documents.clamp_max_rows(args.get("maxRows"), documents.DEFAULT_TABLE_ROWS)
    budget = WHOLE_TABLE_CHAR_BUDGET if whole_table else RESULT_CHAR_BUDGET
    # Say how many rows there are and where the next page starts. Returning a prefix with neither
    # used to make a partial read indistinguishable from a complete one: a caller asked for a
    # sheet, got two hundred rows, and had nothing in the response suggesting the sheet held more.
    # `nextOffset` is absent when there is nothing left, so its absence is the end signal rather
    # than a count the caller has to reason about — the same shape MCP uses for its own cursors.
    total_rows = len(result["rows"])
    result["totalRows"] = total_rows
    # Skips are diagnostics, not data pages. A wrong header used to attach the entire list to
    # EVERY row page; a large mostly-skipped sheet could exceed the budget before one data row
    # was fitted. Keep a small, independently pageable list and an exact count instead.
    skipped = result["skipped"]
    result["totalSkipped"] = len(skipped)
    result["skipped"] = skipped[skipped_offset:skipped_offset + min(max_rows, 8)]
    if skipped_offset + len(result["skipped"]) < len(skipped):
        result["nextSkippedOffset"] = skipped_offset + len(result["skipped"])
    if not workbook.formulas_available:
        result["formulasAvailable"] = False
    page = result["rows"][offset:offset + max_rows]
    numbers = result["rowNumbers"][offset:offset + max_rows]
    # The page is what fits, not only what was asked for: a wide table's two hundred rows are far
    # over what one result may weigh, and `nextOffset` then starts where this page really ended.
    head = {"documentId": document_id, "name": document.name, "sheet": tables.typed_sheet_name(selected.name, [s.name for s in workbook.sheets]), **result, "resourceUri": "x" * URI_SIZE_RESERVE}
    # Reserve room for both cursors, including when size rather than maxRows cuts the page.
    head.update(nextOffset=offset + len(page), nextSkippedOffset=skipped_offset + len(result["skipped"]))
    kept = _fit(lambda n: {**head, "rows": page[:n], "rowNumbers": numbers[:n]}, len(page), budget)
    result["rows"] = page[:kept]
    result["rowNumbers"] = numbers[:kept]
    if offset + kept < total_rows:
        result["nextOffset"] = offset + kept

    def build(uri: str) -> dict:
        structured = {"documentId": document_id, "name": document.name, "sheet": tables.typed_sheet_name(selected.name, [s.name for s in workbook.sheets]), **result, **({"resourceUri": uri} if uri else {})}
        _assert_within_result_bounds(structured)
        return structured

    _uri, structured = call.services.grants.mint("read_table", args, build)
    return {"structured": structured}


def build_tool_registry() -> dict[str, ToolSpec]:
    from tool_catalog import build_tool_registry as registry
    return registry()
