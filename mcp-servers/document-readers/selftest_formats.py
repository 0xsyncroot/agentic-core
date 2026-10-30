"""Excel formats beyond .xlsx: .xlsm (same OOXML, macro part never run) and legacy .xls (values
only, through xlrd). Drives the dispatcher in-process. The .xls fixture is generated with xlwt;
without xlwt that part is reported as skipped, never as passed."""
from __future__ import annotations

import io
import sys
import zipfile

import fixtures
from file_source import FetchedDocument
from protocol import handle_message
from session import Services, _build_dispatcher
from tool_catalog import build_tool_registry
from wire_client import Results

XLSM_TYPE = "application/vnd.ms-excel.sheet.macroEnabled.12"
XLS_TYPE = "application/vnd.ms-excel"


class Source:
    def __init__(self, files: dict[str, tuple[bytes, str, str]]) -> None:
        self.files = files

    def read(self, document_id: str) -> FetchedDocument:
        content, name, media_type = self.files[document_id]
        return FetchedDocument(document_id, name, media_type, content)


def call(dispatcher, name: str, arguments: dict) -> dict:
    handled = handle_message({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": name, "arguments": arguments}}, dispatcher)
    return handled.result


def xlsm() -> bytes:
    buffer = io.BytesIO(fixtures.build_xlsx({"Luong": [["Ho ten", "Tien"], ["Hoa", 100]]}))
    out = io.BytesIO()
    with zipfile.ZipFile(buffer) as source, zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as target:
        for item in source.infolist():
            target.writestr(item, source.read(item))
        target.writestr("xl/vbaProject.bin", b"\x00macro that must never run\x00")
    return out.getvalue()


def xls(variant: str = "") -> bytes | None:
    try:
        import xlwt
    except ImportError:
        return None
    book = xlwt.Workbook()
    sheet = book.add_sheet("Luong")
    for row, values in enumerate([["Ho ten", "He so", "Tien"], ["Hoa", 2.34, 100], ["Lan", 3, 200]]):
        for column, value in enumerate(values):
            sheet.write(row, column, value)
    sheet.write_merge(4, 4, 0, 2, "Tong cong")
    sheet.write(5, 2, 300)  # a real .xls stores formula results; xlwt cannot, so the total is a value
    sheet.row(2).hidden = True
    sheet.col(1).hidden = True
    other = book.add_sheet("An")
    other.write(0, 0, "x" + variant)
    other.visibility = 1
    out = io.BytesIO()
    book.save(out)
    return out.getvalue()


def main() -> bool:
    results = Results()
    files = {"m": (xlsm(), "luong.xlsm", XLSM_TYPE)}
    legacy = xls()
    if legacy is not None:
        files["x"] = (legacy, "luong.xls", XLS_TYPE)
    dispatcher = _build_dispatcher(Services(documents=Source(files)), build_tool_registry())

    macro = call(dispatcher, "read_table", {"documentId": "m"})
    results.check(".xlsm is read like .xlsx", not macro.get("isError") and macro["structuredContent"]["rows"][0].get("Tien") == 100, str(macro)[:200])

    if legacy is None:
        print("[SKIP] .xls checks — install xlwt to generate the fixture")
        return results.summarize()
    preview = call(dispatcher, "read_document", {"documentId": "x"})["structuredContent"]
    sheets = {sheet["name"]: sheet for sheet in preview["sheets"]}
    results.check(".xls opens and lists its sheets", set(sheets) == {"Luong", "An"}, str(sheets)[:200])
    results.check(".xls says formulas are not available", "values only" in preview["preview"]["formulaValues"]
                  and preview["preview"].get("formulasAvailable") is False)
    results.check(".xls reports merged, hidden row/column and hidden sheet",
                  sheets["Luong"].get("mergedRangeCount") == 1 and sheets["Luong"].get("hiddenRowCount") == 1
                  and sheets["Luong"].get("hiddenColumnCount") == 1 and sheets["An"].get("state") == "hidden", str(sheets["Luong"]))
    table = call(dispatcher, "read_table", {"documentId": "x", "sheet": "Luong"})["structuredContent"]
    numbers = call(dispatcher, "read_document", {"documentId": "x", "sheet": "Luong"})["structuredContent"]["preview"]["rowNumbers"]
    results.check(".xls read_table says formulas are not available", table.get("formulasAvailable") is False)
    results.check(".xls rows keep their worksheet numbers, the empty row 4 left out",
                  table["rows"][0].get("Tien") == 100 and numbers == [2, 3, 5, 6], f"{numbers} {str(table)[:200]}")
    cells = call(dispatcher, "read_cells", {"documentId": "x", "sheet": "Luong", "range": "A2:C5"})["structuredContent"]
    by_address = {cell["address"]: cell for cell in cells["cells"]}
    results.check(".xls read_cells marks formulas unavailable", cells.get("formulasAvailable") is False)
    results.check(".xls cells carry merge and hidden flags",
                  by_address["B5"].get("mergedRange") == "A5:C5" and by_address["A3"].get("hiddenRow") is True
                  and by_address["B2"].get("hiddenColumn") is True and by_address["B2"]["value"] == 2.34, str(by_address)[:300])

    # A workbook not parsed yet (a cached parse would never reach the import).
    files["y"] = (xls("-uncached"), "khac.xls", XLS_TYPE)
    saved = sys.modules.get("xlrd")
    sys.modules["xlrd"] = None  # type: ignore[assignment]  # makes `import xlrd` raise ImportError
    try:
        missing = call(dispatcher, "read_document", {"documentId": "y"})
    finally:
        if saved is not None:
            sys.modules["xlrd"] = saved
        else:
            sys.modules.pop("xlrd", None)
    results.check("without xlrd an .xls is refused with a clear reason, not a crash",
                  missing.get("isError") is True and "unsupported_format" in str(missing) and ".xlsx" in str(missing), str(missing)[:200])
    return results.summarize()


if __name__ == "__main__":
    sys.exit(0 if main() else 1)
