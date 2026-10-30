"""Merged ranges, hidden rows/columns and hidden sheets reach the agent (read_document counts,
read_cells positions) instead of being guessed from blank cells. Drives the dispatcher in-process."""
from __future__ import annotations

import json
import sys

import fixtures
from file_source import FetchedDocument
from protocol import handle_message
from session import Services, _build_dispatcher
from tool_catalog import build_tool_registry
from wire_client import Results


class Source:
    def __init__(self, content: bytes) -> None:
        self.content = content

    def read(self, document_id: str) -> FetchedDocument:
        return FetchedDocument(document_id, "luong.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", self.content)


def call(dispatcher, name: str, arguments: dict) -> dict:
    handled = handle_message({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": name, "arguments": arguments}}, dispatcher)
    return handled.result["structuredContent"]


def main() -> bool:
    results = Results()
    content = fixtures.build_xlsx(
        {"Luong": [["Ho ten", "He so", "Tien"], ["Hoa", 2.34, 100], ["Lan", 3.0, 200]], "An": [["x"], [1]]},
        {"Luong": {"merges": ["A1:B1"], "hiddenRows": [3], "hiddenColumns": [(2, 2)]}, "An": {"state": "hidden"}})
    dispatcher = _build_dispatcher(Services(documents=Source(content)), build_tool_registry())
    sheets = {sheet["name"]: sheet for sheet in call(dispatcher, "read_document", {"documentId": "d"})["sheets"]}
    results.check("a merged range is counted", sheets["Luong"].get("mergedRangeCount") == 1, str(sheets["Luong"]))
    results.check("hidden row and column are counted", sheets["Luong"].get("hiddenRowCount") == 1 and sheets["Luong"].get("hiddenColumnCount") == 1)
    results.check("a hidden sheet says so", sheets["An"].get("state") == "hidden")
    results.check("a visible plain sheet carries no layout noise", "state" not in sheets["Luong"] and "mergedRangeCount" not in sheets["An"])
    cells = {cell["address"]: cell for cell in call(dispatcher, "read_cells", {"documentId": "d", "sheet": "Luong", "range": "A1:C3"})["cells"]}
    results.check("both cells of a merge name the range", cells["A1"].get("mergedRange") == "A1:B1" and cells["B1"].get("mergedRange") == "A1:B1")
    results.check("a cell outside the merge has none", "mergedRange" not in cells["C1"])
    results.check("cells of a hidden row are flagged", cells["A3"].get("hiddenRow") is True and "hiddenRow" not in cells["A2"])
    results.check("cells of a hidden column are flagged", cells["B2"].get("hiddenColumn") is True and "hiddenColumn" not in cells["A2"])
    results.check("values are still returned for hidden cells", cells["C3"]["value"] == 200 and cells["B3"]["value"] == 3)
    two_level = fixtures.build_xlsx({"L": [["STT", "Họ tên", "Lương", "", "Phụ cấp", ""],
                                           ["", "", "Hệ số", "Thành tiền", "Hệ số", "Thành tiền"],
                                           [1, "Hoa", 2.34, 5920200, 0.2, 506000], None, [2, "Lan", 3, 7590000, 0.3, 759000]]})
    dispatcher = _build_dispatcher(Services(documents=Source(two_level)), build_tool_registry())
    table = call(dispatcher, "read_table", {"documentId": "d", "headerRow": 2})
    results.check("repeated leaf titles under a two-level header keep every column (keyed by column letter)",
                  table["rows"][0] == {"Hệ số [C]": 2.34, "Thành tiền [D]": 5920200, "Hệ số [E]": 0.2, "Thành tiền [F]": 506000}, str(table["rows"][:1]))
    results.check("read_table names each row's worksheet number; a blank row is skipped, not renumbered",
                  table.get("rowNumbers") == [3, 5], str(table.get("rowNumbers")))
    return results.summarize()


if __name__ == "__main__":
    sys.exit(0 if main() else 1)
