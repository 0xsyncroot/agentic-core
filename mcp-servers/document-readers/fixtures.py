"""Generates real, minimal .xlsx and .docx fixtures with nothing but `zipfile` — no binary files
live in this repo. Used only by `selftest.py`.

Both formats are ZIP archives of a fixed OOXML part layout; these builders write just enough of
that layout for `xlsx_reader.py` / `docx_reader.py` (or a real Excel/Word) to open the result.
"""
from __future__ import annotations

import io
import struct
import zlib
import zipfile

CONTENT_TYPES_XLSX = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
{sheet_overrides}
<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
</Types>"""

ROOT_RELS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>"""

WORKBOOK_RELS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
{relationships}
<Relationship Id="rIdShared" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>
</Relationships>"""


def _escape(text: str) -> str:
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")


def _column_letter(index: int) -> str:
    letters = ""
    index += 1
    while index > 0:
        index, remainder = divmod(index - 1, 26)
        letters = chr(ord("A") + remainder) + letters
    return letters


def build_xlsx(sheets: dict[str, list[list[object]]], layout: dict[str, dict] | None = None) -> bytes:
    """`sheets`: sheet name -> rows (row 0 is the header). Every string cell becomes a shared
    string; numbers are written inline as `t="n"` (the default type, so `t` is simply omitted).

    A row given as `None` is written as no `<row>` element at all while the numbering still
    advances past it — which is exactly what Excel does with a blank line, and the reason a
    sheet's row numbers are a sparse set rather than a range. Fixtures that only ever produced
    contiguous rows could not tell a correct reader from one that counts positions."""
    shared_strings: list[str] = []

    def string_index(value: str) -> int:
        if value not in shared_strings:
            shared_strings.append(value)
        return shared_strings.index(value)

    layout = layout or {}  # sheet name -> {merges: ["A1:C1"], hiddenRows: [3], hiddenColumns: [(2, 2)], state: "hidden"}
    sheet_names = list(sheets.keys())
    sheet_xml_by_name: dict[str, str] = {}
    for name, rows in sheets.items():
        row_xml_parts = []
        for row_index, row in enumerate(rows, start=1):
            if row is None:
                continue
            cell_parts = []
            for col_index, value in enumerate(row):
                if value is None:
                    continue
                ref = f"{_column_letter(col_index)}{row_index}"
                if isinstance(value, dict) and "formula" in value:
                    attributes = " ".join(f'{key}="{_escape(str(item))}"' for key, item in value.get("attributes", {}).items())
                    formula = _escape(value["formula"] or "")
                    cached = f'<v>{_escape(str(value["cached"]))}</v>' if "cached" in value else ""
                    reference = "" if value.get("omitReference") else f' r="{ref}"'
                    cell_parts.append(f'<c{reference}><f {attributes}>{formula}</f>{cached}</c>')
                elif isinstance(value, (int, float)) and not isinstance(value, bool):
                    cell_parts.append(f'<c r="{ref}"><v>{value}</v></c>')
                else:
                    idx = string_index(str(value))
                    cell_parts.append(f'<c r="{ref}" t="s"><v>{idx}</v></c>')
            hidden = ' hidden="1"' if row_index in layout.get(name, {}).get("hiddenRows", []) else ""
            row_xml_parts.append(f'<row r="{row_index}"{hidden}>{"".join(cell_parts)}</row>')
        extra = layout.get(name, {})
        cols_xml = "".join(f'<col min="{low}" max="{high}" width="9" hidden="1" customWidth="1"/>'
                           for low, high in extra.get("hiddenColumns", []))
        merges = extra.get("merges", [])
        merge_xml = (f'<mergeCells count="{len(merges)}">' + "".join(f'<mergeCell ref="{m}"/>' for m in merges)
                     + "</mergeCells>") if merges else ""
        sheet_xml_by_name[name] = (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
            f'{f"<cols>{cols_xml}</cols>" if cols_xml else ""}<sheetData>{"".join(row_xml_parts)}</sheetData>{merge_xml}</worksheet>'
        )

    sheet_entries = []
    rel_entries = []
    overrides = []
    for i, name in enumerate(sheet_names, start=1):
        state = layout.get(name, {}).get("state")
        sheet_entries.append(f'<sheet name="{_escape(name)}" sheetId="{i}"{f" state=\"{state}\"" if state else ""} r:id="rId{i}"/>')
        rel_entries.append(
            f'<Relationship Id="rId{i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet{i}.xml"/>'
        )
        overrides.append(
            f'<Override PartName="/xl/worksheets/sheet{i}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
        )

    workbook_xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        f'<sheets>{"".join(sheet_entries)}</sheets></workbook>'
    )
    shared_strings_xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        f'<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="{len(shared_strings)}" uniqueCount="{len(shared_strings)}">'
        + "".join(f"<si><t>{_escape(s)}</t></si>" for s in shared_strings)
        + "</sst>"
    )

    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", CONTENT_TYPES_XLSX.format(sheet_overrides="".join(overrides)))
        archive.writestr("_rels/.rels", ROOT_RELS)
        archive.writestr("xl/workbook.xml", workbook_xml)
        archive.writestr("xl/_rels/workbook.xml.rels", WORKBOOK_RELS.format(relationships="".join(rel_entries)))
        archive.writestr("xl/sharedStrings.xml", shared_strings_xml)
        for i, name in enumerate(sheet_names, start=1):
            archive.writestr(f"xl/worksheets/sheet{i}.xml", sheet_xml_by_name[name])
    return buffer.getvalue()


CONTENT_TYPES_DOCX = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>"""

DOCX_ROOT_RELS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>"""


def _paragraph_xml(text: str) -> str:
    return f"<w:p><w:r><w:t>{_escape(text)}</w:t></w:r></w:p>"


def _table_xml(rows: list[list[str]]) -> str:
    row_xml = "".join(
        "<w:tr>" + "".join(f"<w:tc>{_paragraph_xml(cell)}</w:tc>" for cell in row) + "</w:tr>" for row in rows
    )
    return f"<w:tbl>{row_xml}</w:tbl>"


def build_docx(paragraphs: list[str], tables: list[list[list[str]]] | None = None) -> bytes:
    body_parts = [_paragraph_xml(p) for p in paragraphs]
    for table in tables or []:
        body_parts.append(_table_xml(table))
    document_xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        f'<w:body>{"".join(body_parts)}</w:body></w:document>'
    )
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", CONTENT_TYPES_DOCX)
        archive.writestr("_rels/.rels", DOCX_ROOT_RELS)
        archive.writestr("word/document.xml", document_xml)
    return buffer.getvalue()


def build_png(width: int = 2, height: int = 2) -> bytes:
    """A real, minimal PNG, built with nothing but `zlib` and `struct`.

    Same rule as the .xlsx/.docx builders above: no binary file is committed to this repo, so the
    image path gets a genuine PNG to prove itself against rather than a blob of bytes that merely
    has the right extension — `detect_kind` keys off the media type and name, so a fake would pass
    the test while a real client choked on the result.
    """
    raw = b"".join(b"\x00" + b"\xff\x00\x00" * width for _ in range(height))

    def chunk(tag: bytes, payload: bytes) -> bytes:
        return struct.pack(">I", len(payload)) + tag + payload + struct.pack(">I", zlib.crc32(tag + payload) & 0xFFFFFFFF)

    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")
