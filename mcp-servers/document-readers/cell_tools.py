"""Read a real Excel range, keeping formula source and cached value separately."""
import json
import re

import documents
import tables
from errors import ToolInputError
from protocol import ToolSpec
from xlsx_reader import cell_address


def _position(address: str) -> tuple[int, int]:
    match = re.fullmatch(r"\$?([A-Z]{1,3})\$?([1-9][0-9]{0,6})", address.upper())
    if not match:
        raise ToolInputError("range must use Excel A1 addresses, e.g. A1:F12")
    col = 0
    for char in match[1]:
        col = col * 26 + ord(char) - ord("A") + 1
    row = int(match[2])
    if col > 16384 or row > 1048576:
        raise ToolInputError("range exceeds Excel's worksheet limits")
    return row, col


def _bounds(requested: str, sheet) -> tuple[tuple[int, int], tuple[int, int]]:
    """The first and last (row, column) a range names. `5:5` and `5:7` are whole rows, `A:C` whole columns."""
    text = requested.strip().replace("$", "").upper()
    rows = re.fullmatch(r"([1-9][0-9]{0,6}):([1-9][0-9]{0,6})", text)
    columns = re.fullmatch(r"([A-Z]{1,3}):([A-Z]{1,3})", text)
    if rows or columns:
        last_row = max([sheet.header_row_number, *sheet.row_numbers], default=1)
        last_column = max([len(sheet.header), *(len(row) for row in sheet.rows)], default=1)
    if rows:
        return (int(rows[1]), 1), (int(rows[2]), max(1, last_column))
    if columns:
        return (1, _position(columns[1] + "1")[1]), (max(1, last_row), _position(columns[2] + "1")[1])
    addresses = text.split(":")
    if len(addresses) not in (1, 2):
        raise ToolInputError("range must be one cell or a rectangular A1 range")
    return _position(addresses[0]), _position(addresses[-1])


def _read_cells(args, call):
    from grants import URI_SIZE_RESERVE
    from tools import RESULT_CHAR_BUDGET, _assert_within_result_bounds, _select_sheet
    document_id, requested = args.get("documentId"), args.get("range")
    if not isinstance(document_id, str) or not document_id or not isinstance(requested, str):
        raise ToolInputError("documentId and range are required")
    document = call.services.documents.read(document_id)
    if documents.detect_kind(document) != "workbook":
        raise ToolInputError("read_cells requires an .xlsx workbook")
    workbook = documents.read_workbook(document)
    selected = _select_sheet(workbook, args.get("sheet"), document_id)
    start, end = _bounds(requested, selected)
    if end[0] < start[0] or end[1] < start[1]:
        raise ToolInputError("range end precedes its start")
    width = end[1] - start[1] + 1
    total = (end[0] - start[0] + 1) * width
    if total > 10000:
        raise ToolInputError("range exceeds 10000 cells; read a smaller range")
    offset, count = args.get("offset", 0), args.get("maxCells", 100)
    if not isinstance(offset, int) or isinstance(offset, bool) or offset < 0:
        raise ToolInputError("offset must be a non-negative integer")
    if not isinstance(count, int) or isinstance(count, bool) or not 1 <= count <= 400:
        raise ToolInputError("maxCells must be between 1 and 400")
    cells = []
    for position in range(offset, min(total, offset + count)):
        address = cell_address(start[0] + position // width, start[1] + position % width)
        row_number, column_number = start[0] + position // width, start[1] + position % width
        cell = dict(selected.cells.get(address, {"address": address, "value": None, "type": "blank"}))
        # Layout facts the cell's own text cannot carry (see xlsx_reader.SheetData): where a merged
        # range starts, so a blank neighbour is not read as missing data, and what is hidden.
        merge = next((m for m in selected.merges if m[0] <= row_number <= m[2] and m[1] <= column_number <= m[3]), None)
        if merge:
            cell["mergedRange"] = f"{cell_address(merge[0], merge[1])}:{cell_address(merge[2], merge[3])}"
        if row_number in selected.hidden_rows:
            cell["hiddenRow"] = True
        if any(low <= column_number <= high for low, high in selected.hidden_columns):
            cell["hiddenColumn"] = True
        cells.append(cell)

    def build(uri):
        result = {"documentId": document_id, "name": document.name, "sheet": tables.typed_sheet_name(selected.name, [s.name for s in workbook.sheets]),
                  "range": requested, "cells": cells, "totalCells": total, "offset": offset,
                  "values": "cached in the file; formulas are not recalculated",
                  **({} if workbook.formulas_available else {"formulasAvailable": False,
                     "values": "values only: this .xls format exposes no formulas to this reader"}),
                  **({"resourceUri": uri} if uri else {})}
        if offset + len(cells) < total:
            result["nextOffset"] = offset + len(cells)
        return result

    while len(cells) > 1 and len(json.dumps(build("x" * URI_SIZE_RESERVE), ensure_ascii=False)) > RESULT_CHAR_BUDGET:
        cells.pop()
    if len(json.dumps(build("x" * URI_SIZE_RESERVE), ensure_ascii=False)) > RESULT_CHAR_BUDGET:
        raise ToolInputError("One cell exceeds the result budget; its contents were not returned")
    _uri, result = call.services.grants.mint("read_cells", args, build)
    _assert_within_result_bounds(result)
    return {"structured": result}


def read_cells_spec():
    return ToolSpec(
        description=("Reads an Excel A1 range with each cell's real address, value and original formula. "
                     "Values are cached in the file, never recalculated. hasCachedValue distinguishes a "
                     "formula without a saved result from zero. Shared-formula followers report their master "
                     "under sharedFormula; formula is null when the file stores no own formula text. "
                     "Read referenced cells or sheets to explain a formula; do not invent inputs. "
                     "Follow nextOffset until absent to read the whole requested range."),
        input_schema={"type": "object", "properties": {
            "documentId": {"type": "string"}, "sheet": {"type": "string"}, "range": {"type": "string"},
            "offset": {"type": "integer", "minimum": 0}, "maxCells": {"type": "integer", "minimum": 1, "maximum": 400}},
            "required": ["documentId", "range"], "additionalProperties": False},
        annotations={"readOnlyHint": True}, handler=_read_cells,
    )
