"""Result-size checks for `selftest.py` — split out to keep that file under the line budget.

What they prove: no document is too large to read. The runtime that calls this server keeps a tool
result only up to a character budget and refuses a larger one whole, so every list a result
carries is a page cut to fit, and whatever a page leaves out is reachable by the offset beside it.
A real 46-sheet dossier's overview was refused by that runtime before this existed — the model was
told the read had failed, on a file that had been read.

Run in-process against the tool handlers: the property is about what a handler returns, and a
large workbook over HTTP would only make the same assertions slower.
"""
from __future__ import annotations

import json
import os
import tempfile

import fixtures
from wire_client import Results


def _large_workbook() -> bytes:
    """Far past the real dossier: 120 sheets, every one 40 columns wide, one of them 1,200 rows long."""
    wide = [f"Cột số {c} – chỉ tiêu dự toán ngân sách năm 2027" for c in range(40)]
    sheets = {f"{i:03d}-Biểu chi tiết đơn vị {i}": [wide, [f"dòng 1 ô {c}" for c in range(40)]] for i in range(120)}
    sheets["000-Biểu chi tiết đơn vị 0"] = [wide] + [[f"NVC {r} ô {c} " + "x" * 30 for c in range(40)] for r in range(1200)]
    return fixtures.build_xlsx(sheets)


def _formula_workbook() -> bytes:
    """A wide sheet whose every figure is a formula, like a real biểu: the formulas outweigh the rows."""
    header = ["STT", "Nội dung"] + [f"Cột {c}" for c in range(2, 14)]
    rows = [header] + [[str(r), f"Nhiệm vụ {r}"] + [
        {"formula": f"SUM(C{r + 1}:D{r + 1})+'Biểu {c}'!E{r + 1}*0.5", "cached": r * c} for c in range(2, 14)] for r in range(1, 301)]
    return fixtures.build_xlsx({"Công thức": rows})


def _read_all(call, args: dict) -> tuple[list, list, int, int]:
    """Every row number and first cell a sheet's preview pages carry, and the page and call counts."""
    numbers, firsts, offset, calls, total = [], [], 0, 0, None
    while offset is not None and calls < 400:
        preview = call("read_document", {**args, "offset": offset, "maxRows": 200})["preview"]
        numbers += preview["rowNumbers"]
        firsts += [row[0] for row in preview["rows"]]
        total, offset, calls = preview["totalRows"], preview.get("nextOffset"), calls + 1
    return numbers, firsts, total, calls


def run_paging_checks(results: Results) -> None:
    with tempfile.TemporaryDirectory() as directory:
        with open(os.path.join(directory, "large"), "wb") as handle:
            handle.write(_large_workbook())
        with open(os.path.join(directory, "large.meta.json"), "w", encoding="utf-8") as handle:
            json.dump({"name": "Hồ sơ lớn.xlsx", "mediaType": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"}, handle)
        with open(os.path.join(directory, "long-text"), "wb") as handle:
            handle.write(fixtures.build_docx([f"Đoạn văn số {i}: " + "nội dung thuyết minh dự toán " * 20 for i in range(400)]))
        with open(os.path.join(directory, "long-text.meta.json"), "w", encoding="utf-8") as handle:
            json.dump({"name": "Thuyết minh dài.docx", "mediaType": "application/vnd.openxmlformats-officedocument.wordprocessingml.document"}, handle)

        # A form Excel has formatted far past its last line: rows that exist and hold nothing.
        with open(os.path.join(directory, "formatted"), "wb") as handle:
            handle.write(fixtures.build_xlsx({"Biểu": [["STT", "Nội dung", "Dự toán"], ["1", "Chi lương", 12.5], ["2", "Chi khác", None]] + [["", " ", None]] * 60}))
        with open(os.path.join(directory, "formatted.meta.json"), "w", encoding="utf-8") as handle:
            json.dump({"name": "Biểu đã kẻ sẵn.xlsx", "mediaType": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"}, handle)

        # A two-sheet workbook whose sheets say what they are: the reads of a cut sheet keep each one's heading.
        with open(os.path.join(directory, "two-sheets"), "wb") as handle:
            handle.write(fixtures.build_xlsx({
                "T9": [["BẢNG THANH TOÁN TIỀN LƯƠNG THÁNG 9"], ["STT", "Họ và tên", "Lương"]] + [[str(r), f"Người {r}", r * 1000] for r in range(1, 301)],
                "Ghi chú": [["Ghi chú về các khoản phụ cấp"], ["Phụ cấp ăn trưa", 730000]],
            }))
        with open(os.path.join(directory, "two-sheets.meta.json"), "w", encoding="utf-8") as handle:
            json.dump({"name": "Lương tháng 9.xlsx", "mediaType": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"}, handle)

        with open(os.path.join(directory, "formulas"), "wb") as handle:
            handle.write(_formula_workbook())
        with open(os.path.join(directory, "formulas.meta.json"), "w", encoding="utf-8") as handle:
            json.dump({"name": "Biểu công thức.xlsx", "mediaType": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"}, handle)

        previous = os.environ.get("DOCUMENT_SOURCE_DIR")
        os.environ["DOCUMENT_SOURCE_DIR"] = directory
        try:
            import protocol
            import session
            import tools
            registry, services = tools.build_tool_registry(), session.Services()
            budget = tools.RESULT_CHAR_BUDGET
            largest = 0

            def call(name: str, args: dict) -> dict:
                nonlocal largest
                structured = registry[name].handler(args, protocol.ToolCall(services=services))["structured"]
                largest = max(largest, len(json.dumps(structured, ensure_ascii=False)))
                return structured

            page = call("read_document", {"documentId": "large"})
            names, calls = [s["name"] for s in page["sheets"]], 1
            results.check("large workbook: the first page of sheets says how many there are and where the list continues",
                          page["totalSheets"] == 120 and 0 < len(names) < 120 and page.get("nextSheetOffset") == len(names),
                          f"{len(names)}/{page.get('totalSheets')} next={page.get('nextSheetOffset')}")
            while page.get("nextSheetOffset") is not None and calls < 60:
                page = call("read_document", {"documentId": "large", "sheetOffset": page["nextSheetOffset"]})
                names += [s["name"] for s in page["sheets"]]
                calls += 1
            results.check("large workbook: paging by nextSheetOffset lists every sheet exactly once",
                          len(names) == 120 and len(set(names)) == 120, f"{len(names)} names, {len(set(names))} distinct, {calls} calls")

            rows, offset, calls, total = [], 0, 0, None
            while offset is not None and calls < 600:
                page = call("read_table", {"documentId": "large", "sheet": names[0], "offset": offset})
                rows += page["rows"]
                total, offset, calls = page["totalRows"], page.get("nextOffset"), calls + 1
            first_cells = [next(iter(row.values())) for row in rows]
            results.check("large sheet: paging by nextOffset reads every row exactly once, in order",
                          total == 1200 and len(rows) == 1200 and len(set(first_cells)) == 1200 and first_cells[0].startswith("NVC 0 ") and first_cells[-1].startswith("NVC 1199 "),
                          f"{len(rows)}/{total} rows in {calls} calls")

            page = call("read_document", {"documentId": "large", "sheet": names[0], "maxRows": 200})
            preview = page["preview"]
            results.check("a named sheet's preview is cut to fit and says where it continues",
                          0 < len(preview["rows"]) < 200 and preview.get("nextOffset") == len(preview["rows"]) and len(preview["rowNumbers"]) == len(preview["rows"]),
                          f"{len(preview['rows'])} rows, next={preview.get('nextOffset')}")
            whole = page.get("nextCall") or {}
            results.check("a cut sheet preview names the one read that returns the whole table",
                          whole.get("tool") == "read_table" and whole.get("arguments") == {"documentId": "large", "sheet": names[0], "all": True}
                          and str(len(preview["rows"])) in whole.get("why", "") and "1200" in whole.get("why", ""),
                          f"nextCall={whole}")

            reads = whole.get("reads") or {}
            results.check("the whole-table read says what it reads: the file, every sheet, the sheet read and the rows shown",
                          reads.get("source", {}).get("id") == "large" and reads["source"].get("name") == "Hồ sơ lớn.xlsx" and reads.get("unit") == "sheet"
                          and [part["name"] for part in reads.get("catalog", [])] == names and reads.get("target") == names[0]
                          and reads.get("shown") == {"rows": len(preview["rows"]), "of": 1200},
                          f"reads={json.dumps(reads, ensure_ascii=False)[:300]}")
            results.check("a sheet list too long for a quarter of the budget goes without headings, then row counts, still every sheet",
                          len(reads.get("catalog", [])) == 120 and all(set(part) == {"name"} for part in reads["catalog"])
                          and len(json.dumps(reads["catalog"], ensure_ascii=False)) <= budget // 4, f"{len(reads.get('catalog', []))} sheets")
            survey = call("read_document", {"documentId": "large"})
            results.check("a survey's preview keeps its rows while the read it names says what it reads",
                          len(survey["preview"]["rows"]) > 1 and (survey.get("nextCall") or {}).get("reads", {}).get("target") == names[0],
                          f"{len(survey['preview']['rows'])} rows, target={(survey.get('nextCall') or {}).get('reads', {}).get('target')}")
            page = call("read_document", {"documentId": "two-sheets", "sheet": "T9", "maxRows": 20})
            reads = (page.get("nextCall") or {}).get("reads") or {}
            results.check("a short sheet list keeps each sheet's heading and its rows",
                          reads.get("catalog") == [{"name": "T9", "heading": "BẢNG THANH TOÁN TIỀN LƯƠNG THÁNG 9", "rows": 301},
                                                   {"name": "Ghi chú", "heading": "Ghi chú về các khoản phụ cấp", "rows": 1}]
                          and reads.get("source") == {"id": "two-sheets", "name": "Lương tháng 9.xlsx", "heading": "BẢNG THANH TOÁN TIỀN LƯƠNG THÁNG 9"}
                          and reads.get("target") == "T9" and reads.get("shown", {}).get("rows") == len(page["preview"]["rows"]),
                          f"reads={json.dumps(reads, ensure_ascii=False)[:400]}")

            page = call("read_document", {"documentId": "formatted", "sheet": "Biểu", "maxRows": 200})
            preview = page["preview"]
            results.check("a sheet ends at its last row holding anything: formatted-but-empty rows are not pages to read",
                          preview["totalRows"] == 2 and "nextOffset" not in preview and preview["rows"] == [["1", "Chi lương", 12.5], ["2", "Chi khác"]],
                          f"totalRows={preview['totalRows']} next={preview.get('nextOffset')} rows={preview['rows'][:3]}")
            results.check("a preview that shows every row names no further read", "nextCall" not in page, f"nextCall={page.get('nextCall')}")
            results.check("a call that names a sheet is told about that sheet, not the whole workbook again",
                          [s["name"] for s in page["sheets"]] == ["Biểu"] and page["totalSheets"] == 1
                          and [s["name"] for s in call("read_document", {"documentId": "large", "sheet": names[5], "maxRows": 5})["sheets"]] == [names[5]],
                          f"{[s['name'] for s in page['sheets']]}")

            paragraphs, offset, calls, total = [], 0, 0, None
            while offset is not None and calls < 200:
                page = call("read_document", {"documentId": "long-text", "offset": offset, "maxRows": 200})["preview"]
                paragraphs += page["paragraphs"]
                total, offset, calls = page["totalParagraphs"], page.get("nextOffset"), calls + 1
            results.check("long text document: paging by nextOffset reads every paragraph exactly once",
                          total == 400 and len(paragraphs) == 400 and len(set(paragraphs)) == 400, f"{len(paragraphs)}/{total} in {calls} calls")

            with_formulas = call("read_document", {"documentId": "formulas", "sheet": "Công thức", "maxRows": 200})["preview"]
            without = call("read_document", {"documentId": "formulas", "sheet": "Công thức", "maxRows": 200, "formulas": False})["preview"]
            explicit = call("read_document", {"documentId": "formulas", "sheet": "Công thức", "maxRows": 200, "formulas": True})["preview"]
            results.check("formulas defaults to true: the result is the same as asking for formulas explicitly",
                          json.dumps(with_formulas, sort_keys=True) == json.dumps(explicit, sort_keys=True)
                          and len(with_formulas["formulas"]) > 0 and "formulasOmitted" not in with_formulas,
                          f"{len(with_formulas['rows'])} rows, {len(with_formulas['formulas'])} formulas")
            results.check("formulas: false leaves the formulas map out, says so, keeps formulaValues, and the page holds several times more rows",
                          "formulas" not in without and "formulasOmitted" in without and without["formulaValues"] == with_formulas["formulaValues"]
                          and len(without["rows"]) >= 3 * len(with_formulas["rows"]),
                          f"{len(without['rows'])} rows without vs {len(with_formulas['rows'])} with")
            results.check("formulas: false starts at the same row as formulas: true at the same offset",
                          with_formulas["rowNumbers"] == without["rowNumbers"][:len(with_formulas["rowNumbers"])]
                          and call("read_document", {"documentId": "formulas", "sheet": "Công thức", "maxRows": 200, "offset": 40, "formulas": False})["preview"]["rowNumbers"][0]
                          == call("read_document", {"documentId": "formulas", "sheet": "Công thức", "maxRows": 200, "offset": 40})["preview"]["rowNumbers"][0],
                          f"{with_formulas['rowNumbers'][:3]} / {without['rowNumbers'][:3]}")
            numbers_true, firsts_true, total_true, pages_true = _read_all(call, {"documentId": "formulas", "sheet": "Công thức"})
            numbers_false, firsts_false, total_false, pages_false = _read_all(call, {"documentId": "formulas", "sheet": "Công thức", "formulas": False})
            results.check("formulas: false covers the whole sheet in contiguous pages, no row lost or duplicated, in fewer calls",
                          numbers_false == numbers_true and len(set(numbers_false)) == len(numbers_false) == total_false == total_true == 300
                          and firsts_false == firsts_true and pages_false * 3 <= pages_true,
                          f"{pages_false} pages without, {pages_true} with, {len(numbers_false)}/{total_false} rows")
            for bad in ("false", 0, 1, None, []):
                try:
                    call("read_document", {"documentId": "formulas", "formulas": bad})
                    refused = ""
                except Exception as error:
                    refused = str(error)
                results.check(f"formulas: {bad!r} is refused as not a boolean", refused == "formulas must be a boolean", refused or "accepted")

            results.check("no result of a large document is over the character budget", largest <= budget, f"largest {largest} of {budget}")
        finally:
            if previous is None:
                os.environ.pop("DOCUMENT_SOURCE_DIR", None)
            else:
                os.environ["DOCUMENT_SOURCE_DIR"] = previous
