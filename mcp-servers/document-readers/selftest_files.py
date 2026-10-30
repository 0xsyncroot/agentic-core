"""Formula evidence and Word-table pages, read through the HTTP MCP server."""
import json
import os
import tempfile

import fixtures
from wire_client import HttpClient, Results, result_of


def formula_workbook():
    return fixtures.build_xlsx({"Lương": [
        ["Tên", "Mức cơ sở", "Hệ số", "Lương"],
        ["Nguyễn An", 2340000, 5.9, {"formula": "ROUND(B2*C2,0)", "cached": 13806000, "omitReference": True}],
        ["Trần Bình", 2340000, 3, {"formula": "B3*C3", "cached": 7020000,
                                   "attributes": {"t": "shared", "si": 0, "ref": "D3:D4"}}],
        ["Lê Chi", 2340000, 0, {"formula": None, "cached": 0,
                               "attributes": {"t": "shared", "si": 0}}],
        [None, None, None, {"formula": "SUM(D2:D4)"}],
    ]})


def run_file_checks(results: Results):
    with tempfile.TemporaryDirectory() as directory:
        for document_id, content, name in [
            ("formula", formula_workbook(), "Lương.xlsx"),
            ("tables", fixtures.build_docx(["Quyết định phụ cấp."],
                [[[str(row), f"Khoản {row}: " + "thuyết minh " * 40, "650000"] for row in range(60)]]), "Phụ cấp.docx"),
        ]:
            with open(os.path.join(directory, document_id), "wb") as handle:
                handle.write(content)
            with open(os.path.join(directory, document_id + ".meta.json"), "w") as handle:
                json.dump({"name": name, "mediaType": "application/octet-stream"}, handle)
        client = HttpClient(os.path.dirname(__file__), directory)
        try:
            def call(name, arguments):
                response = result_of(client.request("tools/call", {"name": name, "arguments": arguments}),
                                     results, f"{name} responds")
                return (response or {}).get("structuredContent", {})

            overview = call("read_document", {"documentId": "formula"})
            preview = overview.get("preview", {})
            results.check("formula-only trailing rows remain readable, including an unsaved result",
                          preview.get("totalRows") == 4 and preview.get("formulas", {}).get("D5", {}).get("hasCachedValue") is False,
                          str(preview)[:500])
            page = call("read_cells", {"documentId": "formula", "sheet": "Lương", "range": "D2:D5"})
            cells = {cell["address"]: cell for cell in page.get("cells", [])}
            results.check("formula source, cached value and missing cache stay separate",
                          cells.get("D2", {}).get("formula") == "=ROUND(B2*C2,0)"
                          and cells.get("D2", {}).get("value") == 13806000
                          and cells.get("D5", {}).get("value") is None
                          and cells.get("D5", {}).get("hasCachedValue") is False, str(cells))
            follower = cells.get("D4", {})
            results.check("a shared-formula follower reports its master and preserves a real zero",
                          follower.get("formula") is None and follower.get("value") == 0
                          and follower.get("hasCachedValue") is True
                          and follower.get("sharedFormula") == {"address": "D3", "formula": "=B3*C3", "range": "D3:D4"}, str(follower))
            addresses, offset = [], 0
            for _ in range(8):
                page = call("read_cells", {"documentId": "formula", "range": "A1:D5", "offset": offset, "maxCells": 3})
                addresses += [cell["address"] for cell in page.get("cells", [])]
                offset = page.get("nextOffset")
                if offset is None:
                    break
            results.check("cell pagination reads the entire rectangle once, including blank cells",
                          len(addresses) == len(set(addresses)) == 20 and addresses[0] == "A1" and addresses[-1] == "D5", str(addresses))
            for requested in ["XFE1", "A1048577", "D5:A1", "A1:A10001"]:
                response = client.request("tools/call", {"name": "read_cells", "arguments": {"documentId": "formula", "range": requested}})
                results.check(f"an invalid or excessive range is refused: {requested}", response.get("result", {}).get("isError") is True, str(response)[:200])

            rows, offset, paragraph = [], 0, None
            for _ in range(30):
                page = call("read_document", {"documentId": "tables", "tableOffset": offset, "maxRows": 200}).get("preview", {})
                paragraph = page.get("paragraphs")
                rows += page.get("tableRows", [])
                offset = page.get("nextTableOffset")
                if offset is None:
                    break
            results.check("Word table pages retain every real row and its table position",
                          paragraph == ["Quyết định phụ cấp."] and len(rows) == 60
                          and [row["row"] for row in rows] == list(range(1, 61))
                          and all(row["table"] == 1 and row["cells"][2] == "650000" for row in rows), f"{len(rows)} rows")
        finally:
            client.close()
