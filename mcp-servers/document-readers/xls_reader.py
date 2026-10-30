"""Legacy Excel 97–2003 (.xls, BIFF) reader, values only.

`.xls` is not OOXML, so `xlsx_reader.py` cannot read it, and payroll files from older tools often
arrive in it. `xlrd` (pure Python, imported only when an .xls actually arrives) reads the stored
values, merged ranges and hidden rows/columns/sheets. It does not expose formulas: every result
built from this workbook says so (`WorkbookData.formulas_available = False`), so a caller never
reads "no formula" as "typed in by hand". Macros and external links are never evaluated.

The output has the same shape as `xlsx_reader.parse_workbook`. xlrd's used range counts formatted
blank cells, so a cell with no value is not loaded and an all-blank row is not a page. Later rows
keep their own worksheet numbers, so the gap stays.
"""
from __future__ import annotations

from errors import ToolInputError
from xlsx_reader import (
    MAX_DENSE_CELLS,
    MAX_MERGES,
    MAX_ROWS_PER_SHEET,
    MAX_SHEETS,
    MAX_WORKBOOK_CELLS,
    MAX_WORKBOOK_ROWS,
    SheetData,
    WorkbookData,
    cell_address,
)

OLE_MAGIC = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"
_STATES = {0: "visible", 1: "hidden", 2: "veryHidden"}


def is_xls(content: bytes) -> bool:
    return content[:8] == OLE_MAGIC


def _value(cell, xlrd, datemode) -> tuple[object, str]:
    kind = cell.ctype
    if kind in (xlrd.XL_CELL_EMPTY, xlrd.XL_CELL_BLANK):
        return None, "blank"
    if kind == xlrd.XL_CELL_TEXT:
        return cell.value, "s"
    if kind in (xlrd.XL_CELL_NUMBER, xlrd.XL_CELL_DATE):
        number = float(cell.value)
        return (int(number) if number.is_integer() else number), "n"
    if kind == xlrd.XL_CELL_BOOLEAN:
        return bool(cell.value), "b"
    if kind == xlrd.XL_CELL_ERROR:
        return xlrd.error_text_from_code.get(cell.value, "#ERR"), "e"
    return None, "blank"


def parse_xls(content: bytes) -> WorkbookData:
    try:
        import xlrd  # noqa: PLC0415 - optional dependency, only for .xls
    except ImportError as error:
        raise ToolInputError(
            "this reader cannot open .xls (Excel 97–2003) files here; ask for the file saved as .xlsx",
            code="unsupported_format") from error
    try:
        book = xlrd.open_workbook(file_contents=content, formatting_info=True, on_demand=True)
    except Exception as error:  # noqa: BLE001 - xlrd raises many unrelated types for a bad file
        raise ToolInputError(f"document is not a readable .xls workbook: {error}") from error
    try:
        if book.nsheets > MAX_SHEETS:
            raise ToolInputError(f"workbook has more than {MAX_SHEETS} sheets, which is more than this server loads", code="document_too_large")
        sheets: list[SheetData] = []
        total_rows = total_cells = 0
        for index in range(book.nsheets):
            sheet = book.sheet_by_index(index)
            if sheet.nrows > MAX_ROWS_PER_SHEET:
                raise ToolInputError(f"sheet {sheet.name!r} has more than {MAX_ROWS_PER_SHEET} rows, which is more than this server loads", code="document_too_large")
            parsed_rows: list[list[object]] = []
            row_numbers: list[int] = []
            cells: dict[str, dict] = {}
            dense_cells = 0
            for r in range(sheet.nrows):
                row: list[object] = []
                kept = False
                for c in range(sheet.ncols):
                    value, kind = _value(sheet.cell(r, c), xlrd, book.datemode)
                    if kind == "blank":
                        continue
                    while len(row) <= c:
                        row.append(None)
                    row[c] = value
                    kept = True
                    address = cell_address(r + 1, c + 1)
                    cells[address] = {"address": address, "value": value, "type": kind}
                    total_cells += 1
                    if total_cells > MAX_WORKBOOK_CELLS:
                        raise ToolInputError("Workbook exceeds the loaded cell limit", code="document_too_large")
                if not kept:
                    continue
                dense_cells += len(row)
                if dense_cells > MAX_DENSE_CELLS:
                    raise ToolInputError("Worksheet exceeds the loaded table size limit", code="document_too_large")
                parsed_rows.append(row)
                row_numbers.append(r + 1)
            total_rows += len(parsed_rows)
            if total_rows > MAX_WORKBOOK_ROWS:
                raise ToolInputError(f"workbook holds more than {MAX_WORKBOOK_ROWS} rows in all, which is more than this server loads", code="document_too_large")
            merges = [(rlo + 1, clo + 1, rhi, chi) for rlo, rhi, clo, chi in sheet.merged_cells]
            if len(merges) > MAX_MERGES:
                raise ToolInputError("Worksheet has more merged ranges than this server loads", code="document_too_large")
            hidden_rows = {r + 1 for r, info in sheet.rowinfo_map.items() if info.hidden}
            hidden_columns = [(c + 1, c + 1) for c, info in sheet.colinfo_map.items() if info.hidden]
            state = _STATES.get(sheet.visibility, "visible")
            if not parsed_rows:
                sheets.append(SheetData(name=sheet.name, header=[], rows=[], state=state, merges=merges,
                                        hidden_columns=hidden_columns))
                continue
            header = ["" if value is None else str(value) for value in parsed_rows[0]]
            sheets.append(SheetData(name=sheet.name, header=header, rows=parsed_rows[1:], row_numbers=row_numbers[1:],
                                    header_row_number=row_numbers[0], cells=cells, state=state, merges=merges,
                                    hidden_rows=hidden_rows, hidden_columns=hidden_columns))
            book.unload_sheet(index)
        return WorkbookData(sheets=sheets, formulas_available=False)
    finally:
        book.release_resources()
