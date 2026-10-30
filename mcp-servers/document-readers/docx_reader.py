"""Reads .docx documents straight from their ZIP + XML parts — no third-party dependency.

A .docx is a ZIP archive whose body lives in `word/document.xml` (OOXML WordprocessingML): a
flat sequence of block elements inside `<w:body>`, mainly paragraphs (`w:p`, text runs `w:r` /
`w:t`) and tables (`w:tbl`, rows `w:tr`, cells `w:tc`). Structured data in a Word document is
often laid out as a table rather than prose, so this reader keeps tables as their own structure
(a list of row-cells) instead of flattening them into paragraph text.
"""
from __future__ import annotations

import io
import zipfile
from dataclasses import dataclass, field
from xml.etree import ElementTree as ET

from errors import ToolInputError
from ooxml import read_xml, validate_archive

MAX_PARAGRAPHS = 5000
MAX_TABLE_ROWS = 2000


@dataclass
class TableData:
    rows: list[list[str]] = field(default_factory=list)


@dataclass
class DocxData:
    paragraphs: list[str] = field(default_factory=list)
    tables: list[TableData] = field(default_factory=list)


def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _paragraph_text(p_el: ET.Element) -> str:
    return "".join(t.text or "" for t in p_el.iter() if _local(t.tag) == "t")


def _table_cell_text(tc_el: ET.Element) -> str:
    # A cell can contain multiple paragraphs; join them like a plain multi-line cell would read.
    return "\n".join(
        _paragraph_text(p_el) for p_el in tc_el if _local(p_el.tag) == "p"
    ).strip()


def _read_table(tbl_el: ET.Element) -> TableData:
    rows: list[list[str]] = []
    for tr_el in tbl_el:
        if _local(tr_el.tag) != "tr":
            continue
        row = [_table_cell_text(tc_el) for tc_el in tr_el if _local(tc_el.tag) == "tc"]
        rows.append(row)
        if len(rows) > MAX_TABLE_ROWS:
            raise ToolInputError(f"document table has more than {MAX_TABLE_ROWS} rows")
    return TableData(rows=rows)


def parse_docx(content: bytes) -> DocxData:
    try:
        archive = zipfile.ZipFile(io.BytesIO(content))
    except zipfile.BadZipFile as error:
        raise ToolInputError("document is not a valid .docx (not a ZIP archive)") from error
    try:
        validate_archive(archive)
        root = read_xml(archive, "word/document.xml")
    except KeyError as error:
        raise ToolInputError("document is missing word/document.xml") from error
    except ET.ParseError as error:
        raise ToolInputError(f"document contains malformed document.xml: {error}") from error
    body = next((el for el in root if _local(el.tag) == "body"), None)
    if body is None:
        raise ToolInputError("document.xml has no <w:body>")
    paragraphs: list[str] = []
    tables: list[TableData] = []
    for el in body:
        tag = _local(el.tag)
        if tag == "p":
            text = _paragraph_text(el)
            if text.strip():
                paragraphs.append(text)
                if len(paragraphs) > MAX_PARAGRAPHS:
                    raise ToolInputError(f"document has more than {MAX_PARAGRAPHS} non-empty paragraphs")
        elif tag == "tbl":
            tables.append(_read_table(el))
    return DocxData(paragraphs=paragraphs, tables=tables)
