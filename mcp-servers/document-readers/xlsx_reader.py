"""Reads .xlsx workbooks straight from their ZIP + XML parts — no third-party dependency.

An .xlsx is a ZIP archive of XML parts (OOXML SpreadsheetML). The parts this reader needs:
- `xl/workbook.xml` — the ordered list of sheet names and their relationship ids.
- `xl/_rels/workbook.xml.rels` — relationship id -> worksheet part path.
- `xl/sharedStrings.xml` — the shared-string table most text cells index into.
- `xl/worksheets/sheetN.xml` — the actual cell grid, one `<row>` per row.

Cell gotchas this reader handles: cells carry `t="s"` for a shared-string index, `t="inlineStr"`
for text stored inline (`<is><t>`), `t="str"` for a formula's cached string result, `t="b"` for
booleans, and no `t` (or `t="n"`) for plain numbers — which is also what date cells are: OOXML
stores dates as day-count serials with the "it's a date" fact living in a cell style (`s="..."`)
that points into `xl/styles.xml`'s number formats, not in the cell itself. Parsing that style
chain is out of scope here; `excel_serial_to_date` is exposed for a caller that already knows a
given column is a date, from context this reader doesn't have.
Empty cells are simply absent from the row, so column position comes from each cell's `r`
attribute (e.g. `B7`), never from array position.
"""
from __future__ import annotations

import datetime
import io
import posixpath
import re
import zipfile
from dataclasses import dataclass, field
from xml.etree import ElementTree as ET

from errors import ToolInputError
from ooxml import read_xml, validate_archive

# What one parsed workbook may hold in memory — not what a caller may be shown at once: every
# result is paged (tools.py), so a workbook is never too long to read, only too large to load.
# Fifty sheets was the old ceiling and a real dossier had forty-six; the next one would have been
# refused whole. The total-row guard keeps the memory bound the old pair of limits implied.
# A cell with neither a value nor a formula is not loaded: a budget form paints a style across a
# thousand empty rows, and counting that paint made a 46-sheet dossier of ~14 thousand real values
# look like 665 thousand cells and be refused before the paged read ever started.
MAX_SHEETS = 500
MAX_ROWS_PER_SHEET = 100_000
MAX_WORKBOOK_ROWS = 250_000
MAX_WORKBOOK_CELLS = 250_000
MAX_DENSE_CELLS = 1_000_000
_CELL_REF_RE = re.compile(r"^([A-Z]+)(\d+)$")


@dataclass
class SheetData:
    name: str
    header: list[str]  # header row's cell text, aligned to columns A, B, C, ...
    rows: list[list[object]]  # each row aligned to `header`'s columns; missing cells are None
    row_numbers: list[int] = field(default_factory=list)  # each data row's own worksheet row (the `r` in `<row r="N">`), for sourceRef
    # The header's own worksheet row. Kept because a sheet's first `<row>` is very often not row 1
    # — a form that starts one line down begins at r="2" — and code that assumed 1 reported every
    # later row one off, which is invisible until someone asks for a row by number and is refused.
    header_row_number: int = 1
    cells: dict[str, dict] = field(default_factory=dict)
    # Layout facts a reader must not guess from blank cells: a merged heading owns its blank
    # neighbours, and a hidden row or column is data the person on screen does not see.
    state: str = "visible"  # "visible" | "hidden" | "veryHidden"
    merges: list[tuple[int, int, int, int]] = field(default_factory=list)  # (row1, col1, row2, col2), 1-based
    hidden_rows: set[int] = field(default_factory=set)  # worksheet row numbers
    hidden_columns: list[tuple[int, int]] = field(default_factory=list)  # 1-based inclusive (min, max)


@dataclass
class WorkbookData:
    sheets: list[SheetData] = field(default_factory=list)
    # False for a format whose reader returns values only (.xls): "no formula" then means "not
    # readable here", never "typed in by hand".
    formulas_available: bool = True


def _local(tag: str) -> str:
    """Strips the `{namespace}` prefix ElementTree keeps on every tag name."""
    return tag.rsplit("}", 1)[-1]


def _column_index(cell_ref: str) -> int:
    """`"B7"` -> 1 (0-based column index). Raises on a malformed reference."""
    match = _CELL_REF_RE.match(cell_ref)
    if not match:
        raise ToolInputError(f"malformed cell reference in workbook: {cell_ref!r}")
    letters = match.group(1)
    index = 0
    for char in letters:
        index = index * 26 + (ord(char) - ord("A") + 1)
    return index - 1


def cell_address(row: int, col: int) -> str:
    """A1 address from one-based worksheet coordinates, including cells with an omitted `r`."""
    letters = ""
    while col:
        col, remainder = divmod(col - 1, 26)
        letters = chr(65 + remainder) + letters
    return f"{letters}{row}"


def excel_serial_to_date(serial: float) -> str:
    """Converts an Excel/OOXML date serial (1900 date system) to an ISO `YYYY-MM-DD` string."""
    epoch = datetime.date(1899, 12, 30)  # Excel's day 0, accounting for its fictitious 1900-02-29
    return (epoch + datetime.timedelta(days=serial)).isoformat()


def _read_shared_strings(archive: zipfile.ZipFile) -> list[str]:
    if "xl/sharedStrings.xml" not in archive.namelist():
        return []
    root = read_xml(archive, "xl/sharedStrings.xml")
    strings: list[str] = []
    for si in root:
        if _local(si.tag) != "si":
            continue
        strings.append("".join(t.text or "" for t in si.iter() if _local(t.tag) == "t"))
    return strings


def _read_workbook_sheets(archive: zipfile.ZipFile) -> list[tuple[str, str, str]]:
    """Returns `[(sheetName, relationshipId, state), ...]` in workbook order."""
    root = read_xml(archive, "xl/workbook.xml")
    sheets_el = next((el for el in root if _local(el.tag) == "sheets"), None)
    if sheets_el is None:
        raise ToolInputError("workbook.xml has no <sheets> element")
    result = []
    for sheet_el in sheets_el:
        if _local(sheet_el.tag) != "sheet":
            continue
        name = sheet_el.get("name", "")
        rid = next((v for k, v in sheet_el.attrib.items() if k.endswith("}id") or k == "id"), None)
        if rid is None:
            raise ToolInputError(f"sheet {name!r} has no relationship id")
        result.append((name, rid, sheet_el.get("state", "visible")))
    return result


def _read_workbook_rels(archive: zipfile.ZipFile) -> dict[str, str]:
    root = read_xml(archive, "xl/_rels/workbook.xml.rels")
    return {el.get("Id"): el.get("Target") for el in root if _local(el.tag) == "Relationship"}


def _cell_value(cell_el: ET.Element, shared_strings: list[str]) -> object:
    cell_type = cell_el.get("t")
    if cell_type == "inlineStr":
        is_el = next((c for c in cell_el if _local(c.tag) == "is"), None)
        if is_el is None:
            return None
        return "".join(t.text or "" for t in is_el.iter() if _local(t.tag) == "t")
    value_el = next((c for c in cell_el if _local(c.tag) == "v"), None)
    if value_el is None or value_el.text is None:
        return None
    raw = value_el.text
    if cell_type == "s":
        index = int(raw)
        return shared_strings[index] if 0 <= index < len(shared_strings) else None
    if cell_type == "str" or cell_type == "e":
        return raw
    if cell_type == "b":
        return raw == "1"
    try:
        number = float(raw)
    except ValueError:
        return raw
    return int(number) if number.is_integer() else number


def _read_sheet(archive: zipfile.ZipFile, part_path: str, name: str, shared_strings: list[str], state: str = "visible") -> SheetData:
    root = read_xml(archive, part_path)
    sheet_data_el = next((el for el in root if _local(el.tag) == "sheetData"), None)
    merges, hidden_columns = _read_layout(root)
    hidden_rows: set[int] = set()
    parsed_rows: list[list[object]] = []
    row_numbers: list[int] = []
    cells: dict[str, dict] = {}
    shared_formulas: dict[str, dict] = {}
    dense_cells = 0
    if sheet_data_el is not None:
        for position, row_el in enumerate(el for el in sheet_data_el if _local(el.tag) == "row"):
            row_number = int(row_el.get("r")) if row_el.get("r") else position + 1
            if not 1 <= row_number <= 1048576:
                raise ToolInputError("worksheet row exceeds Excel's row limit")
            row: list[object] = []
            saw_cell = False
            kept = False
            for cell_el in row_el:
                if _local(cell_el.tag) != "c":
                    continue
                saw_cell = True
                ref = cell_el.get("r")
                col = _column_index(ref) if ref else len(row)
                if col >= 16384:
                    raise ToolInputError("worksheet column exceeds Excel's column limit")
                value = _cell_value(cell_el, shared_strings)
                formula = next((c for c in cell_el if _local(c.tag) == "f"), None)
                if value is None and formula is None:
                    continue
                while len(row) <= col:
                    row.append(None)
                row[col] = value
                kept = True
                address = ref or cell_address(row_number, col + 1)
                value_node = next((c for c in cell_el if _local(c.tag) == "v"), None)
                entry = {"address": address, "value": row[col], "type": cell_el.get("t", "n")}
                if formula is not None:
                    entry.update(formula="=" + formula.text if formula.text else None,
                                 formulaType=formula.get("t", "normal"),
                                 hasCachedValue=value_node is not None and value_node.text is not None)
                    if formula.get("ref"):
                        entry["formulaRange"] = formula.get("ref")
                    if formula.get("si") is not None:
                        entry["sharedIndex"] = formula.get("si")
                        if formula.text:
                            shared_formulas[formula.get("si")] = {"address": address, "formula": entry["formula"], "range": formula.get("ref")}
                cells[address] = entry
                if len(cells) > MAX_WORKBOOK_CELLS:
                    raise ToolInputError('Worksheet exceeds the loaded cell limit', code='document_too_large')
            # A row with no cells is a blank line and stays, so row numbers keep their gap.
            # A row whose cells are only painted style — no value, no formula — is not a line
            # anyone will page to; loading it is what made a template's used range look huge.
            if saw_cell and not kept:
                continue
            if row_el.get("hidden") in ("1", "true"):
                hidden_rows.add(row_number)
            dense_cells += len(row)
            if dense_cells > MAX_DENSE_CELLS:
                raise ToolInputError('Worksheet exceeds the loaded table size limit', code='document_too_large')
            parsed_rows.append(row)
            row_numbers.append(row_number)
            if len(parsed_rows) > MAX_ROWS_PER_SHEET:
                raise ToolInputError(
                    f"sheet {name!r} has more than {MAX_ROWS_PER_SHEET} rows, which is more than this "
                    "server loads; ask the user for the sheet split into smaller files", code="document_too_large",
                )
    if not parsed_rows:
        return SheetData(name=name, header=[], rows=[], state=state, merges=merges, hidden_columns=hidden_columns)
    width = max(len(r) for r in parsed_rows)
    if len(parsed_rows) * width > MAX_DENSE_CELLS:
        raise ToolInputError('Worksheet would exceed the loaded table size limit', code='document_too_large')
    header = [str(v) if v is not None else "" for v in _pad(parsed_rows[0], width)]
    rows = [_pad(r, width) for r in parsed_rows[1:]]
    for entry in cells.values():
        if "sharedIndex" in entry:
            entry["sharedFormula"] = shared_formulas.get(entry["sharedIndex"])
    return SheetData(name=name, header=header, rows=rows, row_numbers=row_numbers[1:], header_row_number=row_numbers[0], cells=cells,
                     state=state, merges=merges, hidden_rows=hidden_rows, hidden_columns=hidden_columns)


MAX_MERGES = 20_000


def _read_layout(root) -> tuple[list[tuple[int, int, int, int]], list[tuple[int, int]]]:
    """Merged ranges and hidden column spans, straight from the worksheet XML."""
    merges: list[tuple[int, int, int, int]] = []
    hidden_columns: list[tuple[int, int]] = []
    for el in root:
        tag = _local(el.tag)
        if tag == "mergeCells":
            for merge in el:
                ref = merge.get("ref", "")
                start, _, end = ref.partition(":")
                if not end:
                    continue
                try:
                    first, last = _cell_position(start), _cell_position(end)
                except ToolInputError:
                    continue
                merges.append((first[0], first[1], last[0], last[1]))
                if len(merges) > MAX_MERGES:
                    raise ToolInputError("Worksheet has more merged ranges than this server loads", code="document_too_large")
        elif tag == "cols":
            for col in el:
                if col.get("hidden") in ("1", "true") and col.get("min") and col.get("max"):
                    hidden_columns.append((int(col.get("min")), int(col.get("max"))))
    return merges, hidden_columns


def _cell_position(ref: str) -> tuple[int, int]:
    """`"B7"` -> (row 7, column 2), both 1-based."""
    letters = "".join(ch for ch in ref if ch.isalpha())
    digits = "".join(ch for ch in ref if ch.isdigit())
    if not letters or not digits:
        raise ToolInputError("malformed cell reference")
    return int(digits), _column_index(ref) + 1


def _pad(row: list[object], width: int) -> list[object]:
    return row + [None] * (width - len(row)) if len(row) < width else row


def parse_workbook(content: bytes) -> WorkbookData:
    try:
        archive = zipfile.ZipFile(io.BytesIO(content))
    except zipfile.BadZipFile as error:
        raise ToolInputError("document is not a valid .xlsx (not a ZIP archive)") from error
    try:
        validate_archive(archive)
        shared_strings = _read_shared_strings(archive)
        sheet_refs = _read_workbook_sheets(archive)
        if len(sheet_refs) > MAX_SHEETS:
            raise ToolInputError(f"workbook has more than {MAX_SHEETS} sheets, which is more than this server loads", code="document_too_large")
        rels = _read_workbook_rels(archive)
        sheets = []
        total_rows = 0
        total_cells = 0
        total_dense = 0
        for name, rid, state in sheet_refs:
            target = rels.get(rid)
            if target is None:
                raise ToolInputError(f"sheet {name!r} references unknown relationship {rid!r}")
            # OPC relationships may use absolute package paths (openpyxl does), or
            # paths relative to xl/workbook.xml. These are ZIP entries, never host paths.
            part_path = posixpath.normpath(target.lstrip("/") if target.startswith(("/", "xl/")) else posixpath.join("xl", target))
            if part_path.startswith("../"):
                raise ToolInputError("worksheet relationship escapes the document package")
            sheets.append(_read_sheet(archive, part_path, name, shared_strings, state))
            total_rows += len(sheets[-1].rows)
            total_cells += len(sheets[-1].cells)
            total_dense += (len(sheets[-1].rows) + 1) * len(sheets[-1].header)
            if total_cells > MAX_WORKBOOK_CELLS or total_dense > MAX_DENSE_CELLS:
                raise ToolInputError('Workbook exceeds the loaded cell limit', code='document_too_large')
            if total_rows > MAX_WORKBOOK_ROWS:
                raise ToolInputError(
                    f"workbook holds more than {MAX_WORKBOOK_ROWS} rows in all, which is more than this server "
                    "loads; ask the user for it split into smaller files", code="document_too_large",
                )
        return WorkbookData(sheets=sheets)
    except KeyError as error:
        raise ToolInputError(f"document is missing an expected workbook part: {error}") from error
    except ET.ParseError as error:
        raise ToolInputError(f"document contains malformed workbook XML: {error}") from error
