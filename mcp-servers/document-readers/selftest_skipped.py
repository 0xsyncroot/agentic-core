"""Regression checks for mostly-skipped tables, through the actual HTTP MCP reader."""
from __future__ import annotations

import json
from pathlib import Path
import tempfile

import fixtures
from wire_client import HttpClient, Results, result_of


def run_skipped_checks(results: Results) -> None:
    sheets = {
        "Large": [["Nội dung", "Số tiền"], *[[f"Tên {i}", None] for i in range(5000)], ["Có tiền", 12]],
        "Mixed": [["Nội dung", "Số tiền"], *[[f"Tên {i}", i if i % 4 == 0 else None] for i in range(35)]],
        "Caption": [[None, None, "Đơn vị tính: Triệu đồng"], ["STT", "Nội dung", None],
                    *[[i, f"Nhiệm vụ {i}", None] for i in range(12)]],
    }
    with tempfile.TemporaryDirectory() as directory:
        Path(directory, "skips").write_bytes(fixtures.build_xlsx(sheets))
        Path(directory, "skips.meta.json").write_text(json.dumps({
            "name": "Skipped.xlsx", "mediaType": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        }), encoding="utf-8")
        client = HttpClient(str(Path(__file__).parent.resolve()), directory)
        try:
            def call(sheet: str, **extra: object) -> dict:
                reply = result_of(client.request("tools/call", {"name": "read_table", "arguments": {
                    "documentId": "skips", "sheet": sheet, "columns": {"amount": ["Số tiền"]}, **extra,
                }}), results, f"read_table {sheet} responds")
                return reply.get("structuredContent", {}) if reply else {}

            page = call("Large")
            results.check("5000 skips do not crowd out the data or exceed the result budget",
                          page.get("rows") == [{"amount": 12}] and page.get("totalSkipped") == 5000
                          and len(page.get("skipped", [])) == 8 and page.get("nextSkippedOffset") == 8
                          and len(json.dumps(page, ensure_ascii=False)) <= 24000, str(page)[:180])
            results.check("successful but mostly-excluded data is explicitly distinguished from an empty sheet",
                          "not an empty sheet" in page.get("columnWarning", "")
                          and page.get("headerRowNumber") == 1, page.get("columnWarning", ""))
            last = call("Large", offset=1, skippedOffset=4996)
            results.check("skippedOffset can reach the end without repeating data rows",
                          last.get("rows") == [] and [entry["row"] for entry in last.get("skipped", [])] == list(range(4998, 5002))
                          and "nextSkippedOffset" not in last and "nextOffset" not in last, str(last)[:180])

            rows, numbers, offset = [], [], 0
            while offset is not None:
                page = call("Mixed", offset=offset, maxRows=3)
                rows += page["rows"]
                numbers += page["rowNumbers"]
                offset = page.get("nextOffset")
            results.check("paging data preserves every selected value and its worksheet row",
                          rows == [{"amount": i} for i in range(0, 35, 4)] and numbers == list(range(2, 37, 4)))
            skipped, offset = [], 0
            while offset is not None:
                page = call("Mixed", offset=len(rows), skippedOffset=offset, maxRows=3)
                skipped += page["skipped"]
                offset = page.get("nextSkippedOffset")
            results.check("paging skips independently preserves every excluded row exactly once",
                          page["totalSkipped"] == 26 and [entry["row"] for entry in skipped] == [i + 2 for i in range(35) if i % 4 != 0])
            reply = client.request("resources/read", {"uri": page["resourceUri"]})
            resource = json.loads(reply["result"]["contents"][0]["text"])
            results.check("a resource URI replays the same skip page and cursors",
                          all(resource.get(key) == page.get(key) for key in ("rows", "skipped", "totalSkipped", "nextSkippedOffset")))

            caption = call("Caption", columns={})
            results.check("identity mapping against a currency label succeeds with a corrective warning",
                          caption.get("rows") == [] and caption.get("totalSkipped") == 13
                          and "headerRow" in caption.get("columnWarning", ""))
            corrected = call("Caption", headerRow=2, columns={"name": ["#1"]})
            results.check("using the actual header and a positional column recovers task names",
                          corrected.get("rows") == [{"name": f"Nhiệm vụ {i}"} for i in range(12)]
                          and corrected.get("totalSkipped") == 0 and "columnWarning" not in corrected)
            for bad in (-1, True, "1"):
                refused = client.request("tools/call", {"name": "read_table", "arguments": {
                    "documentId": "skips", "sheet": "Mixed", "skippedOffset": bad,
                }})
                results.check(f"invalid skippedOffset {bad!r} is refused",
                              "skippedOffset must be a non-negative integer" in json.dumps(refused))
        finally:
            client.close()
