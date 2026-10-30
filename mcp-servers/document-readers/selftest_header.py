"""Header and whole-table checks for `selftest.py`: the reader absorbs structure the caller used to carry.

What they prove: titles that identify one row are read from it; a tie between rows is refused with each row
shown whole; a multi-row header comes back as full column paths (merged group titles resolved); `all` returns
a whole table in one result; a sheet named by its unique prefix, a padded name, and a row-only range work.
"""
from __future__ import annotations

import json
import os
import tempfile

import fixtures
from errors import ToolInputError
from wire_client import Results

_CAPTION = ["BẢNG LƯƠNG THÁNG 9"] + [None] * 7
_GROUPS = [None, None, "Lương", None, "Phụ cấp", None, "Khấu trừ", None]
_TITLES = ["STT", "Họ và tên", "Hệ số", "Thực lĩnh", "Số tiền", "Ghi chú", "Số tiền", "Còn lại"]


def _workbook() -> bytes:
    people = [[i, f"Người {i}", 2.5, 1_000_000 * i, 50_000, "", 10_000, 940_000 * i] for i in range(1, 251)]
    return fixtures.build_xlsx({
        "33-KHCN": [_CAPTION, [None], _GROUPS, _TITLES, *people],
        "Hai tầng": [["BẢNG"] + [None] * 5, ["TT", "Họ và tên", "Phụ cấp", None, "Tổng lĩnh", "Ghi chú"], [None, None, "Hệ số", "Số tiền", None, None],
                     ["A", "Biên chế", None, None, None, None], [1, "Người 1", 0.5, 1000, 1000, "x"]],
        "Hai dòng giống nhau": [["STT", "Họ và tên", "Thực lĩnh"], ["STT", "Họ và tên", "Thực lĩnh"], [1, "A", 1]],
        "Ba tầng": [["BẢNG"] + [None] * 5, ["TT", "Họ và tên", "Thu nhập", None, None, "Ghi chú"], [None, None, "Lương", None, "Tổng lĩnh", None],
                    [None, None, "Hệ số", "Số tiền", None, None], [1, "Người 1", 2.34, 1000, 1000, "x"]],
        "Gộp trên số": [["TT", "Họ và tên", "Phụ cấp", None], [1, "Người 1", 0.5, 1000]],
        "Gộp trên tên": [["BẢNG"] + [None] * 3, ["TT", "Họ và tên", None, "Lương"], [1, "Nguyễn Văn", "An", 1000], [2, "Trần Thị", "Bình", 2000]],
    }, layout={"33-KHCN": {"merges": ["A1:H1", "C3:D3", "E3:F3", "G3:H3"]}, "Hai tầng": {"merges": ["A2:A3", "B2:B3", "C2:D2", "E2:E3", "F2:F3"]},
               "Ba tầng": {"merges": ["A1:F1", "A2:A4", "B2:B4", "C2:E2", "F2:F4", "C3:D3", "E3:E4"]}, "Gộp trên số": {"merges": ["C1:D1"]},
               "Gộp trên tên": {"merges": ["A1:D1", "B2:C2"]}})


def run_header_checks(results: Results) -> None:
    with tempfile.TemporaryDirectory() as directory:
        with open(os.path.join(directory, "payroll"), "wb") as handle:
            handle.write(_workbook())
        with open(os.path.join(directory, "payroll.meta.json"), "w", encoding="utf-8") as handle:
            json.dump({"name": "Bảng lương.xlsx", "mediaType": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"}, handle)
        previous = os.environ.get("DOCUMENT_SOURCE_DIR")
        os.environ["DOCUMENT_SOURCE_DIR"] = directory
        try:
            import protocol
            import session
            import tools
            registry, services = tools.build_tool_registry(), session.Services()

            def call(name: str, args: dict) -> dict:
                return registry[name].handler(args, protocol.ToolCall(services=services))["structured"]

            named = {"documentId": "payroll", "sheet": " 33 "}
            read = call("read_table", {**named, "all": True})
            results.check("a padded, shortened sheet name that only one tab begins with reads that tab, and echoes it",
                          read["sheet"] == "33-KHCN", read["sheet"])
            results.check("without headerRow the first row is the header, as before (a caption here)",
                          read["headerRowNumber"] == 1, str(read["headerRowNumber"]))

            by_titles = call("read_table", {**named, "all": True, "columns": {"stt": ["STT"], "ten": ["Họ và tên"], "net": ["Thực lĩnh"]}})
            results.check("titles that only one row carries are read from that row, said in headerRowNote",
                          by_titles["headerRowNumber"] == 4 and "only row that carries all of them" in by_titles.get("headerRowNote", ""),
                          str({k: by_titles.get(k) for k in ("headerRowNumber", "headerRowNote")}))
            results.check("`all` returns every row in one result, with no nextOffset",
                          len(by_titles["rows"]) == 250 and "nextOffset" not in by_titles and by_titles["totalRows"] == 250,
                          f"{len(by_titles['rows'])} rows next={by_titles.get('nextOffset')}")

            full = call("read_table", {"documentId": "payroll", "sheet": "33-KHCN", "headerRow": 4, "all": True})
            paths = {entry["column"]: entry["path"] for entry in full["columnPaths"]}
            results.check("a multi-row header comes back as full paths: merged group titles over their columns, the caption left out",
                          paths[3] == ["Lương", "Thực lĩnh"] and paths[4] == ["Phụ cấp", "Số tiền"] and paths[6] == ["Khấu trừ", "Số tiền"]
                          and paths[0] == ["STT"] and paths[7] == ["Khấu trừ", "Còn lại"],
                          str(paths))
            results.check("a title repeated in the header keeps both columns (keyed apart), each with its own path",
                          len([f for f in full["columns"] if f.startswith("Số tiền")]) == 2, str(list(full["columns"])))

            try:
                call("read_table", {"documentId": "payroll", "sheet": "Hai dòng giống nhau", "columns": {"stt": ["STT"], "net": ["Thực lĩnh"]}, "headerRow": 40})
                tie = ""
            except ToolInputError as error:
                tie = str(error)
            results.check("two rows carrying every title tie: refused with each candidate row shown whole",
                          "Use headerRow" in tie and "Other rows holding some of them" in tie and "Thực lĩnh" in tie, tie[:260])

            two = call("read_table", {"documentId": "payroll", "sheet": "Hai tầng", "headerRow": 2, "all": True})
            two_paths = {entry["column"]: entry["path"] for entry in two["columnPaths"]}
            results.check("titles merged over several columns: the next row is the header, merged-down titles keep their columns",
                          two["headerRowNumber"] == 3 and "merged over several columns" in two.get("headerRowNote", "")
                          and two_paths == {0: ["TT"], 1: ["Họ và tên"], 2: ["Phụ cấp", "Hệ số"], 3: ["Phụ cấp", "Số tiền"], 4: ["Tổng lĩnh"], 5: ["Ghi chú"]},
                          str(two_paths))
            three = call("read_table", {"documentId": "payroll", "sheet": "Ba tầng", "headerRow": 1, "all": True})
            three_paths = {entry["column"]: entry["path"] for entry in three["columnPaths"]}
            results.check("a caption over a group row over the titles: the header is the titles row, every amount keeps its column",
                          three["headerRowNumber"] == 4 and three_paths.get(3, [])[-1:] == ["Số tiền"] and "Lương" in three_paths.get(3, [])
                          and three_paths.get(4, [])[-1:] == ["Tổng lĩnh"], str((three["headerRowNumber"], three_paths)))
            over = call("read_table", {"documentId": "payroll", "sheet": "Gộp trên số", "headerRow": 1, "all": True})
            results.check("a merged title over numbers is the header itself: the numbers beneath are data, never titles",
                          over["headerRowNumber"] == 1 and len(over["rows"]) == 1, str((over["headerRowNumber"], len(over["rows"]))))
            names = call("read_table", {"documentId": "payroll", "sheet": "Gộp trên tên", "headerRow": 1, "all": True})
            results.check("a merged title over a person's name parts stays the header: a row half figures is data, every person kept",
                          names["headerRowNumber"] == 2 and len(names["rows"]) == 2, str((names["headerRowNumber"], len(names["rows"]))))
            cells = call("read_cells", {"documentId": "payroll", "sheet": "33-KHCN", "range": "4:4", "maxCells": 400})
            results.check("a range of whole rows (`4:4`) reads that row across the sheet's width",
                          cells["totalCells"] == 8 and [c["value"] for c in cells["cells"]][:2] == ["STT", "Họ và tên"], str(cells["totalCells"]))
        finally:
            if previous is None:
                os.environ.pop("DOCUMENT_SOURCE_DIR", None)
            else:
                os.environ["DOCUMENT_SOURCE_DIR"] = previous
