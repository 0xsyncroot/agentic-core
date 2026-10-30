"""Document parsing seam: dispatches a fetched document to the right stdlib reader and shapes
`read_document`'s preview. Resource-URI minting lives in `grants.py`, not here — `read_document`'s
result carries no URI of its own; `tools.py`'s handler mints one per call via `GrantStore.mint`.

Parsing uses only the stdlib readers (`xlsx_reader.py`, `docx_reader.py`); no third-party package is
required or wired.
"""
from __future__ import annotations

import hashlib
import threading
from collections import OrderedDict
from dataclasses import dataclass
from typing import Any

import docx_reader
import tables
import xls_reader
import xlsx_reader
from file_source import FetchedDocument
from errors import ToolInputError

# A preview is meant to be a sample; an extraction is meant to be the table. One number served
# both, and twenty is right for the first and ruinous for the second. Measured on a real dossier:
# `read_table` on a 48-row biểu returned the first twenty, which are all chỉ tiêu — số cơ sở, số
# người lao động, tổng kinh phí — and the first actual nhiệm vụ, "Nhiệm vụ khám chữa bệnh", is row
# 21. The caller never saw a single task on that sheet and had no way to know. On a 348-row biểu it
# saw 5.7%. `nextOffset` was in every one of those results and went unused.
DEFAULT_MAX_ROWS = 20
# Extraction defaults to as much as one call may carry. 200 rows of the widest biểu in that dossier
# serialises to 26.8k characters against the 32k a tool result is allowed, so a whole biểu usually
# arrives in one call and paging becomes the exception rather than the thing every read depends on.
DEFAULT_TABLE_ROWS = 200
MAX_MAX_ROWS = 200

# .xlsm is the same OOXML package with a macro part that is never run; .xls (BIFF) goes to
# xls_reader by its file signature, whatever the name says.
_XLSX_MEDIA_HINTS = ("spreadsheetml", "xlsx", "xlsm", "macroenabled", "ms-excel", ".xls")
_DOCX_MEDIA_HINTS = ("wordprocessingml", "docx")


@dataclass
class ReadDocumentResult:
    document_id: str
    kind: str  # "workbook" | "text"
    sheets: list[dict] | None
    preview: dict
    # The sheet the preview is of, by its real name — a caller may have asked with other spacing.
    sheet_name: str | None = None


def _looks_like(name_or_media_type: str, hints: tuple[str, ...]) -> bool:
    lowered = name_or_media_type.lower()
    return any(hint in lowered for hint in hints)


# Ảnh chụp/bản scan của một biểu. Server này KHÔNG cố đọc chữ trong ảnh: nó trả ảnh về cho người
# gọi nhìn. Văn bản pháp quy và biểu mẫu ngành tài chính lưu hành rất nhiều dưới dạng scan — kể cả
# bản PDF có chữ ký số của Bộ Tài chính cũng là ảnh từng trang, không có lớp text — nên "không đọc
# được ảnh" nghĩa là không nhận được một phần đáng kể hồ sơ thật.
_IMAGE_MEDIA_HINTS = ("image/", ".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tif", ".tiff")

# Ngưỡng riêng cho ảnh, không dùng MAX_RESULT_BYTES: khối ảnh không nằm trong structured payload.
# 4 MB là mức an toàn chung cho một khối ảnh trên hầu hết client; quá ngưỡng thì báo rõ kích thước
# và đề nghị gửi bản nhẹ hơn, thay vì cắt ảnh làm đôi và trả về một nửa biểu.
MAX_IMAGE_BYTES = 4 * 1024 * 1024


def detect_kind(document: FetchedDocument) -> str:
    haystack = f"{document.media_type} {document.name}"
    if _looks_like(haystack, _XLSX_MEDIA_HINTS):
        return "workbook"
    if _looks_like(haystack, _DOCX_MEDIA_HINTS):
        return "text"
    if _looks_like(haystack, _IMAGE_MEDIA_HINTS):
        return "image"
    raise ToolInputError(
        f"document {document.document_id} has an unsupported media type for parsing: {document.media_type!r} "
        f"(name {document.name!r}); .xlsx, .xlsm, .xls, .docx and image files are supported"
    )


# Cache immutable parsed workbooks by content hash so each sheet read avoids reparsing
# the entire file. A file edited under the same name receives a fresh cache entry.
# Downstream transformations create new sheets rather than mutating cached ones.
_PARSED_WORKBOOKS: "OrderedDict[bytes, xlsx_reader.WorkbookData]" = OrderedDict()
_PARSED_SIZES: dict[bytes, int] = {}
MAX_PARSED_WORKBOOKS = 4
# Bound both entry count and source bytes to constrain cache growth across workers.
MAX_PARSED_SOURCE_BYTES = 48 * 1024 * 1024
_PARSE_LOCK = threading.Lock()          # guards the two dicts and the per-key locks
_PARSING: dict[bytes, threading.Lock] = {}


def read_workbook(document: FetchedDocument) -> xlsx_reader.WorkbookData:
    """Thread-safe and single-flight: workers asking for the same file wait for one parse."""
    key = hashlib.sha256(document.content).digest()
    parse = xls_reader.parse_xls if xls_reader.is_xls(document.content) else xlsx_reader.parse_workbook
    with _PARSE_LOCK:
        parsed = _PARSED_WORKBOOKS.get(key)
        if parsed is not None:
            _PARSED_WORKBOOKS.move_to_end(key)
            return parsed
        gate = _PARSING.setdefault(key, threading.Lock())
    with gate:
        with _PARSE_LOCK:
            parsed = _PARSED_WORKBOOKS.get(key)
        if parsed is None:
            parsed = parse(document.content)
            with _PARSE_LOCK:
                _PARSED_WORKBOOKS[key] = parsed
                _PARSED_SIZES[key] = len(document.content)
                while len(_PARSED_WORKBOOKS) > 1 and (len(_PARSED_WORKBOOKS) > MAX_PARSED_WORKBOOKS
                                                      or sum(_PARSED_SIZES.values()) > MAX_PARSED_SOURCE_BYTES):
                    evicted, _ = _PARSED_WORKBOOKS.popitem(last=False)
                    _PARSED_SIZES.pop(evicted, None)
        with _PARSE_LOCK:
            _PARSING.pop(key, None)
    return parsed


def read_text(document: FetchedDocument) -> docx_reader.DocxData:
    return docx_reader.parse_docx(document.content)



def clamp_max_rows(max_rows: Any, default: int = DEFAULT_MAX_ROWS) -> int:
    if max_rows is None:
        return default
    if not isinstance(max_rows, int) or isinstance(max_rows, bool) or max_rows < 1:
        raise ToolInputError(f"maxRows must be a positive integer, got {max_rows!r}")
    return min(max_rows, MAX_MAX_ROWS)


_HEADING_CHARS = 120


def _sheet_heading(sheet) -> str:
    """The first line of real text on a sheet — what the form calls itself.

    Taken from the first rows because that is where a Vietnamese budget form puts its own title,
    and skipping cells that are only a form number ("Mẫu biểu số 23") because that repeats what the
    sheet name already says. Empty when the sheet opens with nothing to read, which is itself worth
    knowing.
    """
    for row in [list(sheet.header), *sheet.rows[:6]]:
        for cell in row:
            text = "" if cell is None else str(cell).strip()
            if len(text) > 12 and not text.lower().startswith("mẫu biểu"):
                return text[:_HEADING_CHARS]
    return ""

def read_document(document: FetchedDocument, *, sheet: str | None, max_rows: Any, row_offset: Any = 0, table_offset: int = 0,
                  formulas: bool = True) -> ReadDocumentResult:
    """Builds the bounded preview `read_document` returns. Raises `ToolInputError` for an
    unknown `sheet` name or an out-of-range `maxRows` rather than silently ignoring them.

    `formulas=False` leaves the per-cell `formulas` map out of a workbook preview and says so in
    `formulasOmitted`: on a wide formula sheet the map outweighs the rows several times over."""
    capped_rows = clamp_max_rows(max_rows)
    kind = detect_kind(document)
    if kind == "workbook":
        workbook = read_workbook(document)
        # `rowCount` counts rows the sheet actually has, including a blank line. Cells that carry
        # only a style are not loaded, so a form Excel filled out to a thousand formatted rows does
        # not report those rows here. `dataRowCount` counts rows with a value in at least one cell.
        #
        # `heading` and `figureRowCount` exist because `dataRowCount` does not settle the question a
        # caller actually has, which is where in this workbook the content is. Measured on a real
        # 46-sheet dossier: the sheet holding 32 of the 110 nhiệm vụ reported 39 data rows, and the
        # sheets holding none reported 36 and 35. A caller cannot tell those apart, and this one
        # did not — it called the 32-row sheet an empty template and lost a third of the answer.
        #
        # What separates them is what the sheet SAYS, so `heading` carries the first real line of
        # text on it — an official form opens by naming itself ("BIỂU TỔNG HỢP DỰ TOÁN BỔ SUNG CÓ
        # MỤC TIÊU…") — and `figureRowCount` counts rows carrying a number, which a blank form
        # printed from a Thông tư does not have. Neither decides anything on its own; together they
        # let one call survey a whole dossier instead of forty-six calls guessing from sheet names.
        names = [s.name for s in workbook.sheets]
        sheets_info = [{
            "name": tables.typed_sheet_name(s.name, names), "columns": s.header, "rowCount": len(s.rows),
            "dataRowCount": sum(1 for row in s.rows if any(cell is not None and str(cell).strip() for cell in row)),
            "heading": _sheet_heading(s),
            "figureRowCount": sum(1 for row in s.rows if any(
                isinstance(cell, (int, float)) and not isinstance(cell, bool) and cell != 0 for cell in row)),
            # Layout the preview cannot show: a hidden sheet, row or column holds data nobody on
            # screen sees; a merged range owns its blank cells. Counts only; read_cells gives positions.
            **({"state": s.state} if s.state != "visible" else {}),
            **({"mergedRangeCount": len(s.merges)} if s.merges else {}),
            **({"hiddenRowCount": len(s.hidden_rows)} if s.hidden_rows else {}),
            **({"hiddenColumnCount": sum(high - low + 1 for low, high in s.hidden_columns)} if s.hidden_columns else {}),
        } for s in workbook.sheets]
        if sheet is not None:
            # Resolved as read_table resolves it, so a name one call accepts the other does too.
            resolved, nearest = tables.select_sheet_name(names, sheet) if isinstance(sheet, str) else (None, [])
            selected = next((s for s in workbook.sheets if s.name == resolved), None)
            if selected is None:
                meant = f"closest sheet names: {', '.join(repr(tables.typed_sheet_name(name, names)) for name in nearest)}. " if nearest else ""
                available = ", ".join(tables.typed_sheet_name(name, names) for name in names)
                raise ToolInputError(f"sheet {sheet!r} not found; {meant}available sheets: {available}", code="sheet_not_found")
        else:
            selected = workbook.sheets[0] if workbook.sheets else None
        # The preview is a window, and says so: `totalRows` is how many the sheet holds and
        # `nextOffset` where the next window starts, absent once there is nothing left. Without
        # them a caller who received twenty rows had no way to tell a short sheet from a long one.
        all_rows = selected.rows if selected else []
        formula_rows = {int(''.join(c for c in address if c.isdigit())) for address, cell in (selected.cells.items() if selected else []) if "formula" in cell}
        # Up to the last row holding anything. Excel keeps a row for whatever it has ever formatted:
        # a real biểu of 355 rows reported 999, and a caller paging "until nextOffset is gone" was
        # sent through 640 empty rows after the last line of the form — or stopped where the data
        # stopped and looked, to anything counting pages, like a read left part-way.
        last = len(all_rows)
        while last > 0 and not any(cell is not None and str(cell).strip() for cell in all_rows[last - 1]) and selected.row_numbers[last - 1] not in formula_rows:
            last -= 1
        all_rows = all_rows[:last]
        offset = max(0, int(row_offset or 0))
        preview_rows = [row[: len(selected.header)] for row in all_rows[offset:offset + capped_rows]] if selected else []
        # Each previewed row's own worksheet number, and the header's. A worksheet omits rows it
        # has nothing in, so counting down a preview gives the wrong number the moment a form has
        # one blank line above its column titles — on a real dossier the titles sat on worksheet
        # row 8 while the preview showed them sixth, and `headerRow: 6` was then refused by a
        # sheet that does contain a row 6's worth of nothing. Handing the numbers over removes the
        # counting entirely: the caller passes back a number it was shown.
        row_numbers = list(selected.row_numbers) if selected else []
        formula_window = set(row_numbers[offset:offset + capped_rows] + ([selected.header_row_number] if selected and offset == 0 else []))
        preview = {
            "columns": selected.header if selected else [],
            "headerRowNumber": selected.header_row_number if selected else None,
            "rows": preview_rows,
            "rowNumbers": row_numbers[offset:offset + capped_rows],
            "totalRows": len(all_rows),
            **({} if workbook.formulas_available else {"formulasAvailable": False}),
            "formulaValues": "cached in the file; not recalculated" if workbook.formulas_available
            else "values only: this .xls format exposes no formulas to this reader; do not infer that a cell was typed in",
            **({"formulas": {address: cell for address, cell in (selected.cells.items() if selected else [])
                             if "formula" in cell and int(''.join(c for c in address if c.isdigit())) in
                             formula_window}} if formulas else
               {"formulasOmitted": "left out because the call passed formulas: false; read_cells gives a cell's formula"}),
        }
        if offset + capped_rows < len(all_rows):
            preview["nextOffset"] = offset + capped_rows
        return ReadDocumentResult(document_id=document.document_id, kind="workbook", sheets=sheets_info, preview=preview,
                                  sheet_name=tables.typed_sheet_name(selected.name, names) if selected else None)
    if kind == "image":
        # Không có preview chữ, và cố ý không có: nội dung ảnh đi trong khối ảnh của kết quả
        # (tools.py), người gọi tự nhìn. Bịa ra một `preview` rỗng ở đây sẽ khiến người gọi tưởng
        # tài liệu không có gì bên trong.
        if len(document.content) > MAX_IMAGE_BYTES:
            raise ToolInputError(
                f"image {document.document_id} is {len(document.content)} bytes, over the "
                f"{MAX_IMAGE_BYTES} byte cap for one image block; send a smaller or downscaled copy"
            )
        return ReadDocumentResult(
            document_id=document.document_id, kind="image", sheets=None,
            preview={"mediaType": document.media_type, "byteSize": len(document.content)},
        )
    text = read_text(document)
    # A window, like a sheet's rows: `totalParagraphs` says how long the document is and
    # `nextOffset` where the next window starts, absent once there is nothing left.
    offset = max(0, int(row_offset or 0))
    preview = {"paragraphs": text.paragraphs[offset:offset + capped_rows], "totalParagraphs": len(text.paragraphs)}
    table_rows = [{"table": index + 1, "row": number + 1, "cells": row}
                  for index, table in enumerate(text.tables) for number, row in enumerate(table.rows)]
    if table_rows:
        preview.update(tableRows=table_rows[table_offset:table_offset + capped_rows], totalTableRows=len(table_rows))
        if table_offset + capped_rows < len(table_rows):
            preview["nextTableOffset"] = table_offset + capped_rows
    if offset + capped_rows < len(text.paragraphs):
        preview["nextOffset"] = offset + capped_rows
    return ReadDocumentResult(document_id=document.document_id, kind="text", sheets=None, preview=preview)
