#!/usr/bin/env python3
"""Runs `http_server.py` and posts JSON-RPC to `/mcp`, the same Streamable HTTP server the
backend calls. The official `@modelcontextprotocol/client` check is `test/http.test.mjs`.
Writes its fixtures into a temporary directory and points the server at it (`DOCUMENT_SOURCE_DIR`),
exactly how the process that runs it in production hands it documents (see `backend.py`).

Generates its own .xlsx/.docx fixtures with `fixtures.py` — the repo carries no binary files.

Prints PASS/FAIL per assertion; exits non-zero if any failed. This is the gate: run it after any
change here (`python3 selftest.py`) before considering the change done.
"""
from __future__ import annotations

import json
import os
import re
import sys
import tempfile

import fixtures
import tables
from selftest_grants import run_grant_checks
from selftest_header import run_header_checks
from selftest_hints import run_hint_checks
from selftest_paging import run_paging_checks
from selftest_skipped import run_skipped_checks
from selftest_s3 import run_s3_checks
from selftest_files import run_file_checks
from wire_client import HttpClient, Results, result_of

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
XLSX_MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
DOCX_MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"


def write_fixtures(directory: str) -> None:
    """Each fixture as `<documentId>` plus `<documentId>.meta.json` — what the parent process writes."""
    for document_id, (content, media_type, name) in build_fixtures().items():
        with open(os.path.join(directory, document_id), "wb") as handle:
            handle.write(content)
        with open(os.path.join(directory, document_id + ".meta.json"), "w", encoding="utf-8") as handle:
            json.dump({"name": name, "mediaType": media_type}, handle)


def build_fixtures() -> dict[str, tuple[bytes, str, str]]:
    table_xlsx = fixtures.build_xlsx({
        "Items": [
            ["Item Code", "Item Name", "Qty", "Unit Price"],
            ["A100", "Widget", 10, 2.5],
            [None, None, None, None],
            ["A200", "Gadget", 5, None],
            [None, "Miscellaneous note", None, None],
        ],
        # Second, never first: sheets[0] is what read_document previews by default, and several
        # assertions above read it. A sheet with real accented Vietnamese headers, because against
        # ASCII headers an accented synonym and an unaccented one are the same string, so the accent
        # half of "case/accent-insensitively" could not be tested at all.
        "Nhiệm vụ": [
            ["Mã nhiệm vụ", "Nội dung", "Số tiền"],
            ["NVC01", "Chi lương và các khoản theo lương", 4250],
        ],
        # Longer than one preview, with the rows that matter past the twentieth — the shape of a
        # real biểu, where the first twenty lines are chỉ tiêu and the first actual nhiệm vụ is
        # row 21. A fixture of three rows cannot tell a table read from a preview, and one did
        # not: the default was wrong in production while this suite stayed green.
        "Biểu dài hơn một trang": [
            ["Số TT", "Tên nhiệm vụ chi"],
            *[[str(i), f"Chỉ tiêu theo mẫu {i}"] for i in range(1, 21)],
            ["", "Nhiệm vụ khám chữa bệnh"],
            ["", "Nhiệm vụ phòng bệnh"],
            ["", "Phụ cấp y tế thôn"],
        ],
        # Two tab names lifted from a real dossier. `31- ĐBXH` carries a stray space after the dash
        # that nobody typing the biểu number would reproduce, and `26-SNVHTT` carries an "SN" a
        # caller reading "biểu 26 văn hoá thông tin" leaves out. Both were asked for, neither
        # matched, and the refusal answered with forty-five names and no candidate among them.
        # `26-SNVHTT ` also ends in a space Excel never shows; the reader prints it trimmed, as it can be typed back.
        "31- ĐBXH": [
            ["STT", "Nội dung"],
            ["1", "Chi đảm bảo xã hội"],
        ],
        "26-SNVHTT ": [
            ["STT", "Nội dung"],
            ["1", "Chi sự nghiệp văn hoá thông tin"],
        ],
        # Shaped like a real official form: caption lines, a BLANK line, then the column titles.
        # The blank line is the whole point — the titles sit on worksheet row 5 while a caller
        # counting the preview would call them the fourth thing it sees.
        "Biểu có dòng trống": [
            ["PHỤ BIỂU"],
            ["CHI TIẾT NHIỆM VỤ CHI"],
            [None, None, "Đơn vị: Triệu đồng"],
            None,
            ["Số TT", "Tên nhiệm vụ chi"],
            ["1", "Chi hoạt động thường xuyên"],
        ],
    })
    text_docx = fixtures.build_docx(
        ["This is a short demonstration document.", "It has a second paragraph."],
        tables=[[["Header A", "Header B"], ["cell 1", "cell 2"]]],
    )
    return {
        "doc-table": (table_xlsx, XLSX_MEDIA_TYPE, "items.xlsx"),
        "doc-text": (text_docx, DOCX_MEDIA_TYPE, "notes.docx"),
        "doc-scan": (fixtures.build_png(), "image/png", "bieu-scan.png"),
    }


def _assert_protocol_purity(results: Results, clients: list[HttpClient]) -> None:
    for client in clients:
        for body in client.responses:
            try:
                parsed = json.loads(body)
            except json.JSONDecodeError:
                results.check("every MCP response is a JSON-RPC 2.0 object", False, f"unparsable body: {body!r}")
                return
            if parsed.get("jsonrpc") != "2.0":
                results.check("every MCP response is a JSON-RPC 2.0 object", False, f"non-JSON-RPC body: {body!r}")
                return
    results.check("every MCP response is a JSON-RPC 2.0 object", True)


def _run_source_checks(results: Results, client: HttpClient) -> None:
    """Reading stays inside the directory: unknown ids and anything that could step out are refused."""
    for label, document_id in (("an unknown documentId", "doc-does-not-exist"),
                               ("a path that steps out of the directory", "../server.py"),
                               ("an absolute path", "/etc/passwd"),
                               ("a metadata sidecar", "doc-table.meta.json")):
        response = result_of(
            client.request("tools/call", {"name": "read_document", "arguments": {"documentId": document_id}}),
            results, f"call for {label} responds",
        )
        if response is not None:
            results.check(f"{label} is refused as a tool error, never read", response.get("isError") is True, str(response)[:200])


def _run_main_flow(results: Results, client: HttpClient) -> None:
    discover = result_of(client.request("server/discover"), results, "server/discover responds")
    if discover is not None:
        results.check(
            "server/discover negotiates the modern era",
            discover.get("resultType") == "complete" and "2026-07-28" in discover.get("supportedVersions", []),
            str(discover),
        )

    tools_list = result_of(client.request("tools/list"), results, "tools/list responds")
    if tools_list is not None:
        names = {t["name"] for t in tools_list.get("tools", [])}
        results.check("tools/list returns the three document tools", names == {"read_document", "read_table", "read_cells"}, str(names))

    _run_source_checks(results, client)

    workbook_call = result_of(
        client.request("tools/call", {"name": "read_document", "arguments": {"documentId": "doc-table"}}),
        results, "read_document on the generated .xlsx responds",
    )
    if workbook_call is not None:
        structured = workbook_call.get("structuredContent", {})
        resource_uri = structured.get("resourceUri", "")
        results.check(
            "read_document parses the generated .xlsx correctly and mints a well-formed grant URI",
            structured.get("kind") == "workbook"
            # dataRowCount is 3 where rowCount is 4: the fixture carries a deliberately blank row,
            # and telling those two numbers apart is the whole point of reporting both. A real
            # workbook keeps a row for anything ever formatted, so rowCount alone cannot say whether
            # a sheet holds data.
            # Compared field by field rather than whole-object, so adding a survey field to the
            # sheet list does not fail an assertion about row counts.
            and [{k: v for k, v in sheet.items() if k in ("name", "columns", "rowCount", "dataRowCount")}
                 for sheet in structured.get("sheets", [])] == [
                {"name": "Items", "columns": ["Item Code", "Item Name", "Qty", "Unit Price"], "rowCount": 4, "dataRowCount": 3},
                {"name": "Nhiệm vụ", "columns": ["Mã nhiệm vụ", "Nội dung", "Số tiền"], "rowCount": 1, "dataRowCount": 1},
                {"name": "Biểu dài hơn một trang", "columns": ["Số TT", "Tên nhiệm vụ chi"], "rowCount": 23, "dataRowCount": 23},
                {"name": "31- ĐBXH", "columns": ["STT", "Nội dung"], "rowCount": 1, "dataRowCount": 1},
                {"name": "26-SNVHTT", "columns": ["STT", "Nội dung"], "rowCount": 1, "dataRowCount": 1},
                # Five `<row>` elements for six worksheet rows: the blank one is simply absent.
                {"name": "Biểu có dòng trống", "columns": ["PHỤ BIỂU", "", ""], "rowCount": 4, "dataRowCount": 4},
            ]
            and resource_uri.startswith("document://") and resource_uri.count(".") == 1,
            str(structured),
        )

    gap = result_of(
        client.request("tools/call", {"name": "read_document", "arguments": {
            "documentId": "doc-table", "sheet": "Biểu có dòng trống"}}),
        results, "read_document previews a sheet that omits a blank row",
    )
    if gap is not None:
        preview = gap.get("structuredContent", {}).get("preview", {})
        numbers = preview.get("rowNumbers")
        titles_position = next((i for i, row in enumerate(preview.get("rows", [])) if row and row[0] == "Số TT"), None)
        # The trap, stated as an assertion: the column titles are the FOURTH row the preview shows
        # and worksheet row FIVE, because the blank line above them has no `<row>` of its own. A
        # caller counting positions asks for the wrong row, and on a sheet where that wrong number
        # happens to exist it silently reads the wrong line instead of failing.
        results.check(
            "the preview hands back each row's own worksheet number, which is not its position",
            preview.get("headerRowNumber") == 1 and numbers == [2, 3, 5, 6] and titles_position == 2,
            f"headerRowNumber={preview.get('headerRowNumber')} rowNumbers={numbers} titlesAt={titles_position}",
        )

        counted = client.request("tools/call", {"name": "read_table", "arguments": {
            "documentId": "doc-table", "sheet": "Biểu có dòng trống", "headerRow": 4}})
        counted_message = str(counted.get("error", {}).get("message", "")) + str(counted.get("result", {}))
        results.check(
            "asking for a row the sheet does not contain is refused, and the refusal names real rows",
            "omits empty rows" in counted_message and "2, 3, 5, 6" in counted_message,
            counted_message[:240],
        )

        # Same question, other door: a row that does not exist, asked with the titles wanted. The
        # answer has to be the same one — "they are on row 5" — or a caller learns where to look
        # from one refusal and is left guessing by the other.
        missing = client.request("tools/call", {"name": "read_table", "arguments": {
            "documentId": "doc-table", "sheet": "Biểu có dòng trống",
            "headerRow": 4, "columns": {"stt": ["Số TT"], "ten": ["Tên nhiệm vụ chi"]}}})
        missing_message = str(missing.get("error", {}).get("message", "")) + str(missing.get("result", {}))
        results.check(
            "a headerRow that is not a row, with titles only one row carries, reads that row instead of refusing",
            '"headerRowNumber": 5' in missing_message.replace("\\", "") and "only row that carries all of them" in missing_message,
            missing_message[:300],
        )

        # Asking for columns without saying which row holds the titles lands on the caption line.
        # "None matched" alone sends a caller back to invent different column names, which fails
        # the same way; the refusal has to name the real cause and the way out.
        captioned = client.request("tools/call", {"name": "read_table", "arguments": {
            "documentId": "doc-table", "sheet": "Biểu có dòng trống",
            "columns": {"stt": ["Số TT"], "ten": ["Tên nhiệm vụ chi"]}}})
        caption_message = str(captioned.get("error", {}).get("message", "")) + str(captioned.get("result", {}))
        results.check(
            # The fixture's titles sit on worksheet row 5. The reader used to compute that and refuse with
            # "Use headerRow 5"; the caller passed the number back or, on a real dossier, guessed wrong eight
            # times running. One row carrying every title is the header: it is used, and the result says so.
            "columns that only one row carries are read from that row, not refused",
            "only row that carries all of them" in caption_message and "Chi hoạt động thường xuyên" in caption_message,
            caption_message[:300],
        )

        # Reading every column names no title, so the result itself must say when the header taken is a caption line;
        # otherwise a caller guesses the header row. The facts come with the rows.
        whole_caption = client.request("tools/call", {"name": "read_table", "arguments": {
            "documentId": "doc-table", "sheet": "Biểu có dòng trống", "all": True}})
        whole_text = str(whole_caption.get("result", {}))
        results.check(
            "a whole-sheet read without headerRow whose header row is a caption says so and reads back the rows that hold several cells",
            "headerWarning" in whole_text and "5: Số TT | Tên nhiệm vụ chi" in whole_text,
            whole_text[:400],
        )
        named_row = client.request("tools/call", {"name": "read_table", "arguments": {
            "documentId": "doc-table", "sheet": "Biểu có dòng trống", "all": True, "headerRow": 5}})
        results.check("the caller who names the header row gets no warning", "headerWarning" not in str(named_row.get("result", {})), str(named_row)[:200])

        # Naming the row is only half an answer when the caller's wording is what was wrong. These
        # forms call the same column "Nội dung" on one biểu, "CHỈ TIÊU" on the next and "Danh mục
        # dự án" on a third, so a caller that guessed one of them is told "row 5, matches 1 of 2"
        # and has no way to learn what the other title is actually called. Echoing the row's own
        # words costs one line and ends the guessing; office-docs needs to know no vocabulary to
        # do it, only how to read back what is written there.
        partial = client.request("tools/call", {"name": "read_table", "arguments": {
            "documentId": "doc-table", "sheet": "Biểu có dòng trống",
            "columns": {"stt": ["Số TT"], "ten": ["Nội dung"]}}})
        partial_message = str(partial.get("error", {}).get("message", "")) + str(partial.get("result", {}))
        results.check(
            "a row that matches only some of the titles shows what it actually says",
            "Use headerRow 5" in partial_message and "1 of 2" in partial_message and "Tên nhiệm vụ chi" in partial_message,
            partial_message[:400],
        )

        # Order is the whole of it. This refusal used to open with the header it matched against —
        # on a real form, twenty-six empty strings — and put the row to use at the very end. Across
        # six sheets and more than twenty refusals an agent changed its column spellings every time
        # and never once passed the row it had been handed, wandering 5, 6, 4, 3 on one sheet whose
        # answer was 7. What to do goes first; why it was refused follows.
        lead = _refusal_text(partial)
        results.check(
            "the refusal opens with the row to use, not with the header that failed",
            lead.startswith("Use headerRow 5"),
            lead[:200],
        )

        # Overshooting the titles used to be unrecoverable. `rebase_header` drops every row above
        # the one named, and the hint was searched against what was left — so a caller one row past
        # the header was told to try rows far below it while the answer sat just above, cut away by
        # its own guess. On the real dossier that read "Use headerRow 35 — Báo cáo theo các chi
        # tiêu nêu tại điểm 1" when the answer was row 5.
        overshot = client.request("tools/call", {"name": "read_table", "arguments": {
            "documentId": "doc-table", "sheet": "Biểu có dòng trống",
            "headerRow": 6, "columns": {"stt": ["Số TT"], "ten": ["Tên nhiệm vụ chi"]}}})
        overshot_text = _refusal_text(overshot) or str(overshot.get("result", {}))
        results.check(
            "a headerRow one past the titles reads the one row that carries them, not further down",
            "row 5 is the only row" in overshot_text.replace("\\", "") and "Chi hoạt động thường xuyên" in overshot_text,
            overshot_text[:220],
        )

        real = result_of(
            client.request("tools/call", {"name": "read_table", "arguments": {
                "documentId": "doc-table", "sheet": "Biểu có dòng trống", "headerRow": 5}}),
            results, "read_table accepts a headerRow taken from the preview's rowNumbers",
        )
        if real is not None:
            structured = real.get("structuredContent", {})
            results.check(
                "that row's own titles become the columns, and only the rows below it remain",
                structured.get("columns") == {"Số TT": "Số TT", "Tên nhiệm vụ chi": "Tên nhiệm vụ chi"}
                and [row.get("Tên nhiệm vụ chi") for row in structured.get("rows", [])] == ["Chi hoạt động thường xuyên"],
                str(structured)[:240],
            )

    text_call = result_of(
        client.request("tools/call", {"name": "read_document", "arguments": {"documentId": "doc-text"}}),
        results, "read_document on the generated .docx responds",
    )
    if text_call is not None:
        structured = text_call.get("structuredContent", {})
        paragraphs = structured.get("preview", {}).get("paragraphs", [])
        results.check(
            "read_document parses the generated .docx correctly",
            structured.get("kind") == "text" and paragraphs == ["This is a short demonstration document.", "It has a second paragraph."],
            str(structured),
        )

    _run_read_table_flow(results, client)
    _run_paging_flow(results, client)
    _run_accent_flow(results, client)
    _run_image_flow(results, client)


def _refusal_text(response: dict) -> str:
    """The refusal a caller actually receives, unwrapped from the tool result it arrives in.

    Read through `str(response)` instead and the quotes come back backslash-escaped, so a check for
    the sentence the server wrote fails against the sentence the server wrote.
    """
    content = response.get("result", {}).get("content", [{}])
    text = str(content[0].get("text", "{}")) if content else "{}"
    try:
        return str(json.loads(text).get("error", text))
    except (ValueError, AttributeError):
        return text + str(response.get("error", {}))


def _run_read_table_flow(results: Results, client: HttpClient) -> None:
    mapped_args = {
        "documentId": "doc-table",
        "columns": {"code": ["item code", "id"], "amount": ["unit price", "price"]},
    }
    mapped = result_of(client.request("tools/call", {"name": "read_table", "arguments": mapped_args}), results, "read_table with caller-supplied synonyms responds")
    if mapped is not None:
        structured = mapped.get("structuredContent", {})
        results.check(
            "read_table resolves headers by synonym, case/accent-insensitively",
            structured.get("columns") == {"code": "Item Code", "amount": "Unit Price"},
            str(structured),
        )
        results.check(
            "read_table returns coerced rows and a skipped row with a reason",
            # A field the row leaves empty is absent from it, not sent as null.
            structured.get("rows") == [{"code": "A100", "amount": 2.5}, {"code": "A200"}]
            and structured.get("skipped") == [{"row": 5, "reason": "no value in any requested column"}],
            str(structured),
        )

    identity = result_of(
        client.request("tools/call", {"name": "read_table", "arguments": {"documentId": "doc-table"}}),
        results, "read_table without `columns` (identity mode) responds",
    )
    if identity is not None:
        structured = identity.get("structuredContent", {})
        results.check(
            "read_table falls back to one field per header when columns is omitted",
            set(structured.get("columns", {})) == {"Item Code", "Item Name", "Qty", "Unit Price"},
            str(structured),
        )

    # A preview samples; an extraction returns the table. Sharing one default made `read_table`
    # answer with twenty rows, and on a real biểu the first twenty are all chỉ tiêu — the first
    # actual nhiệm vụ is row 21, so the caller saw none of them and nothing said so.
    whole = result_of(
        client.request("tools/call", {"name": "read_table", "arguments": {
            "documentId": "doc-table", "sheet": "Biểu dài hơn một trang"}}),
        results, "read_table without maxRows responds",
    )
    if whole is not None:
        structured = whole.get("structuredContent", {})
        results.check(
            "read_table returns the whole table by default, not a preview-sized sample",
            len(structured.get("rows", [])) == structured.get("totalRows") == 23
            and "nextOffset" not in structured
            and any("khám chữa bệnh" in str(row) for row in structured.get("rows", [])),
            str(structured)[:240],
        )
    sampled = result_of(
        client.request("tools/call", {"name": "read_document", "arguments": {
            "documentId": "doc-table"}}),
        results, "read_document without maxRows responds",
    )
    if sampled is not None:
        preview = sampled.get("structuredContent", {}).get("preview", {})
        results.check(
            "read_document still samples — a preview is meant to be one",
            len(preview.get("rows", [])) <= 20,
            str(preview)[:200],
        )

    # An official form labels only the columns it has a word for. On a real biểu the header row
    # names Cân đối / BSMT / Trên phần mềm and leaves the cells above STT and Nội dung empty — so
    # a caller asking for stt/noiDung/amounts got the amounts and nothing else, and reported back
    # that the sheet held "figures with no names". The names were in the sheet. Two things were
    # missing: any way to say which column, and any word about what had been dropped.
    # `dataRowCount` does not answer the question a caller actually has, which is where in this
    # workbook the content is. On a real 46-sheet dossier the sheet holding 32 of the 110 nhiệm vụ
    # reported 39 data rows and the sheets holding none reported 36 and 35 — indistinguishable, and
    # a live run duly called the 32-row sheet an empty template and lost a third of the answer.
    # What separates them is what each sheet SAYS about itself, and surveying that took one call
    # per sheet before this.
    survey = result_of(
        client.request("tools/call", {"name": "read_document", "arguments": {
            "documentId": "doc-table"}}),
        results, "read_document surveys every sheet, not only the one it previews",
    )
    if survey is not None:
        sheets = survey.get("structuredContent", {}).get("sheets", [])
        by_name = {sheet.get("name"): sheet for sheet in sheets}
        results.check(
            "every sheet carries the first real line of text on it, so a caller can read the form's own title",
            by_name.get("Biểu có dòng trống", {}).get("heading") == "CHI TIẾT NHIỆM VỤ CHI",
            str(by_name.get("Biểu có dòng trống")),
        )
        results.check(
            "a form number is not a heading — it only repeats the sheet name",
            all("Mẫu biểu" not in (sheet.get("heading") or "") for sheet in sheets),
            str([sheet.get("heading") for sheet in sheets]),
        )
        results.check(
            "rows carrying a figure are counted apart from rows carrying anything at all",
            by_name.get("Items", {}).get("figureRowCount") == 2 and by_name.get("Items", {}).get("dataRowCount") == 3,
            str(by_name.get("Items")),
        )

    positional = result_of(
        client.request("tools/call", {"name": "read_table", "arguments": {
            "documentId": "doc-table",
            "columns": {"code": ["#0"], "qty": ["#2"]}}}),
        results, "read_table accepts a column addressed by position",
    )
    if positional is not None:
        structured = positional.get("structuredContent", {})
        results.check(
            "`#n` takes the nth column whatever its title says",
            structured.get("rows", [{}])[0] == {"code": "A100", "qty": 10},
            str(structured)[:300],
        )

    dropped = result_of(
        client.request("tools/call", {"name": "read_table", "arguments": {
            "documentId": "doc-table",
            "columns": {"code": ["Item Code"], "ngayChungTu": ["Ngày chứng từ"]}}}),
        results, "read_table still answers when only some columns resolve",
    )
    if dropped is not None:
        structured = dropped.get("structuredContent", {})
        unresolved = structured.get("unresolvedColumns", {})
        results.check(
            "a field that matched nothing is named in the result, not dropped in silence",
            unresolved.get("fields") == ["ngayChungTu"] and "ngayChungTu" in str(unresolved.get("detail", "")),
            str(structured)[:300],
        )

    # Ten refusals in one run ended with "nothing matched" and nothing else: the caller had landed
    # on a data row, so the caption-line branch stayed quiet too, and its spellings appear nowhere
    # in the sheet so no row could be named as holding them. True, and nowhere to go. The sheet's
    # own words are the only thing that moves it, and they need no vocabulary the caller lacks.
    nowhere = client.request("tools/call", {"name": "read_table", "arguments": {
        "documentId": "doc-table",
        "columns": {"ngay": ["Ngày chứng từ"], "dvt": ["Đơn vị tính"]}}})
    nowhere_text = _refusal_text(nowhere)
    results.check(
        "a refusal that can name no matching row reads the sheet's own rows back instead",
        nowhere_text.startswith("No row here carries any of those titles") and "Item Code" in nowhere_text,
        nowhere_text[:260],
    )

    # One space was worth nineteen retries. Asked for `31-ĐBXH` against a tab called `31- ĐBXH`,
    # this refused with every sheet name in the workbook and named none of them as the likely one;
    # the caller then walked headerRow 4 through 9 on a sheet that did not exist under that name,
    # so every retry was doomed before it was sent. A name differing only in spacing or tone is the
    # same name typed differently and now resolves — visibly, because the result echoes `sheet`.
    spaced = result_of(
        client.request("tools/call", {"name": "read_table", "arguments": {
            "documentId": "doc-table", "sheet": "31-ĐBXH",
            "columns": {"stt": ["STT"], "noiDung": ["Nội dung"]}}}),
        results, "read_table accepts a sheet name whose only difference is a stray space",
    )
    if spaced is not None:
        structured = spaced.get("structuredContent", {})
        results.check(
            "the sheet read is echoed under its real name, so resolving is visible not silent",
            structured.get("sheet") == "31- ĐBXH"
            and structured.get("rows") == [{"stt": "1", "noiDung": "Chi đảm bảo xã hội"}],
            str(structured),
        )

    # What cannot be resolved is named rather than searched for: "SN" is not whitespace, so this
    # one stays a refusal — but a refusal that says which tab it probably meant, before the list.
    missed = client.request("tools/call", {"name": "read_table", "arguments": {
        "documentId": "doc-table", "sheet": "26-VHTT"}})
    missed_text = _refusal_text(missed)
    # Asserting that "26-SNVHTT" appears anywhere in this refusal proves nothing: every sheet name
    # appears in it, which is the complaint. The claim is that it is offered as the candidate, and
    # ahead of the list — and the check must report that, not raise, when the offer is missing.
    offer = missed_text.find("closest sheet names")
    catalogue = missed_text.find("available sheets")
    results.check(
        "a sheet name that cannot be resolved is refused with the nearest real names, named first",
        0 <= offer < catalogue and "closest sheet names: '26-SNVHTT'" in missed_text,
        missed_text[:300],
    )

    # A tab whose name ends in a space is read by the name without it, in both calls, and named back without it.
    typed_table = client.request("tools/call", {"name": "read_table", "arguments": {"documentId": "doc-table", "sheet": "26-SNVHTT"}})
    typed_document = client.request("tools/call", {"name": "read_document", "arguments": {"documentId": "doc-table", "sheet": "26-SNVHTT"}})
    echoed = (typed_table.get("result") or {}).get("structuredContent", {}).get("sheet")
    results.check(
        "a tab ending in a space is read and named back by the name without it",
        echoed == "26-SNVHTT" and not (typed_document.get("result") or {}).get("isError"),
        f"{echoed!r} {_refusal_text(typed_document)[:200]}",
    )

    # Tabs that differ only by an edge space are each read by the name printed for it; trimming first read 'X' for 'X '.
    pairs = {"twins": ["X", "X "], "leading": [" X", "X"], "case": ["A ", "a"], "blank": ["   ", "B"]}
    printed = {kind: [tables.typed_sheet_name(name, names) for name in names] for kind, names in pairs.items()}
    round_trip = all(tables.select_sheet_name(names, shown)[0] == name for kind, names in pairs.items() for name, shown in zip(names, printed[kind]))
    results.check("each tab is read by the name printed for it, tabs differing only by spaces included", round_trip, json.dumps(printed, ensure_ascii=False))

    # The suggester must not become a guesser: a name with nothing in common gets the list and no
    # candidate, because a wrong candidate on a budget form reads a different biểu than the one
    # asked for and reports a total for it.
    foreign = client.request("tools/call", {"name": "read_table", "arguments": {
        "documentId": "doc-table", "sheet": "Bảng cân đối kế toán"}})
    foreign_text = _refusal_text(foreign)
    results.check(
        "a sheet name with no near match is refused without inventing a candidate",
        "not found" in foreign_text and "closest sheet names" not in foreign_text,
        foreign_text[:300],
    )


def _run_paging_flow(results: Results, client: HttpClient) -> None:
    """Two mechanisms that exist so a caller is never quietly handed part of a sheet.

    `headerRow` is obedience, not detection: official forms open with caption lines and the column
    titles sit below them, but where exactly differs by form, province and year, so the caller — who
    can see the first rows — says which row, and the server does as it is told. `offset`/`totalRows`
    make a partial read visible as one; without them a caller receiving the maximum number of rows
    could not tell a short sheet from a long one.
    """
    base = {"documentId": "doc-table"}
    paged = result_of(
        client.request("tools/call", {"name": "read_table", "arguments": {**base, "maxRows": 1}}),
        results, "read_table with a small page responds",
    )
    if paged is not None:
        structured = paged.get("structuredContent", {})
        results.check(
            "a partial read reports the sheet's total and where the next page starts",
            structured.get("totalRows") == 3 and len(structured.get("rows", [])) == 1 and structured.get("nextOffset") == 1,
            str(structured),
        )
        second = result_of(
            client.request("tools/call", {"name": "read_table", "arguments": {**base, "maxRows": 10, "offset": 1}}),
            results, "read_table with an offset responds",
        )
        if second is not None:
            rest = second.get("structuredContent", {})
            results.check(
                "the last page carries no nextOffset, so its absence is the end signal",
                "nextOffset" not in rest and len(rest.get("rows", [])) == 2,
                str(rest),
            )

    titles = result_of(
        client.request("tools/call", {"name": "read_table", "arguments": {
            "documentId": "doc-table", "sheet": "Nhiệm vụ",
            "headerRow": 1, "columns": {"ma": ["ma nhiem vu"]}}}),
        results, "read_table with an explicit headerRow responds",
    )
    if titles is not None:
        results.check(
            "an explicit headerRow resolves that row's titles",
            titles.get("structuredContent", {}).get("columns") == {"ma": "Mã nhiệm vụ"},
            str(titles.get("structuredContent")),
        )
    bad = client.request("tools/call", {"name": "read_table", "arguments": {**base, "headerRow": 9_999}})
    message = str(bad.get("error", {}).get("message", "")) + str(bad.get("result", {}))
    results.check(
        # The refusal has to name rows this file really has. It used to print first-to-last as a
        # range, which on a sheet that omits its empty rows claims rows it does not contain — it
        # refused row 6 while reporting "rows present: 1-1000". A caller reading that has nowhere
        # to go, so the message now lists actual numbers and says why they skip.
        "a headerRow that is not a row in the sheet is refused, naming rows that really exist",
        "headerRow 9999" in message and "omits empty rows" in message and "Nearest rows that do exist" in message,
        message[:240],
    )


def _run_accent_flow(results: Results, client: HttpClient) -> None:
    """Unaccented synonyms against accented headers — the case the docstring promises.

    This is the shape a caller actually writes: the sheet says "Mã nhiệm vụ" and the request says
    `ma nhiem vu`, because typing tones into a config file is the thing people skip. It failed
    silently before — no column resolved, so every row came back as `skipped` with nothing pointing
    at the header. The older assertion here claimed to cover this and did not: its synonym list also
    carried an exact ASCII spelling, which matched first, so the accent branch never ran and the
    check stayed green with the folding removed. Only unaccented synonyms appear below, on purpose.
    """
    args = {
        "documentId": "doc-table",
        "sheet": "Nhiệm vụ",
        "columns": {"code": ["ma nhiem vu"], "name": ["noi dung"], "amount": ["so tien"]},
    }
    read = result_of(client.request("tools/call", {"name": "read_table", "arguments": args}), results, "read_table accepts unaccented synonyms for accented headers")
    if read is not None:
        structured = read.get("structuredContent", {})
        results.check(
            "read_table resolves accented Vietnamese headers from unaccented synonyms",
            structured.get("columns") == {"code": "Mã nhiệm vụ", "name": "Nội dung", "amount": "Số tiền"},
            str(structured),
        )
        results.check(
            "read_table returns the row under those accented headers, not an empty skip",
            structured.get("rows") == [{"code": "NVC01", "name": "Chi lương và các khoản theo lương", "amount": 4250}]
            and not structured.get("skipped"),
            str(structured),
        )


def _run_image_flow(results: Results, client: HttpClient) -> None:
    """A scanned biểu is a picture of a table, and this server does not pretend to read it.

    What it must do is hand the picture back so the caller can look at it — the alternative being an
    OCR-plus-heuristics layer in a server whose whole point is to carry no domain guessing. Real
    Vietnamese budget paperwork circulates as scans (the Ministry of Finance's own digitally-signed
    circular PDF is one image per page with no text layer), so refusing images outright means
    refusing a real share of what users actually send.
    """
    args = {"documentId": "doc-scan"}
    read = result_of(client.request("tools/call", {"name": "read_document", "arguments": args}), results, "read_document accepts an image")
    if read is not None:
        blocks = read.get("content", [])
        results.check(
            "read_document returns the image itself as an image content block",
            len(blocks) == 1 and blocks[0].get("type") == "image" and blocks[0].get("mimeType") == "image/png"
            and isinstance(blocks[0].get("data"), str) and len(blocks[0]["data"]) > 0,
            str(blocks)[:300],
        )
        results.check(
            "read_document reports an image as kind=image without inventing an empty text preview",
            read.get("structuredContent", {}).get("kind") == "image"
            and "paragraphs" not in read.get("structuredContent", {}).get("preview", {}),
            str(read.get("structuredContent")),
        )
    table = client.request("tools/call", {"name": "read_table", "arguments": args})
    message = str(table.get("error", {}).get("message", "")) + str(table.get("result", {}))
    results.check(
        "read_table on an image refuses and says which tool to use instead",
        "not a workbook" in message and "read_document" in message,
        message[:250],
    )


def _run_stateless_and_legacy_checks(results: Results, source_dir: str, clients: list[HttpClient]) -> None:
    # A fresh process's very first message is a tool call — no discover, no initialize. The
    # modern era's real session (post-sibling-probe) does exactly this; if dispatch ever assumed
    # a handshake ran first, this is where it would break.
    stateless_client = HttpClient(SCRIPT_DIR, source_dir)
    clients.append(stateless_client)
    stateless_result = result_of(
        stateless_client.request("tools/call", {"name": "read_document", "arguments": {"documentId": "doc-text"}}),
        results, "stateless first-message tools/call responds",
    )
    if stateless_result is not None:
        results.check(
            "tools/call works as the first message on a fresh process (no prior handshake)",
            stateless_result.get("resultType") == "complete" and not stateless_result.get("isError"),
            str(stateless_result),
        )

    # The legacy `initialize` handshake must still work standalone (a legacy-only client never
    # sends server/discover at all).
    legacy_client = HttpClient(SCRIPT_DIR, source_dir)
    clients.append(legacy_client)
    init_params = {"protocolVersion": "2025-11-25", "capabilities": {}, "clientInfo": {"name": "selftest", "version": "0"}}
    init_result = result_of(legacy_client.request("initialize", init_params), results, "legacy initialize responds")
    if init_result is not None:
        results.check(
            "legacy initialize returns the bare (unwrapped) result shape",
            "resultType" not in init_result and init_result.get("protocolVersion") == "2025-11-25" and "serverInfo" in init_result,
            str(init_result),
        )
    legacy_client.notify("notifications/initialized")
    legacy_tools = result_of(legacy_client.request("tools/list"), results, "tools/list after legacy initialize responds")
    if legacy_tools is not None:
        results.check("tools/list still works after the legacy handshake", len(legacy_tools.get("tools", [])) == 3, str(legacy_tools))


def run() -> bool:
    results = Results()
    clients: list[HttpClient] = []
    with tempfile.TemporaryDirectory(prefix="office-docs-selftest-") as source_dir:
        write_fixtures(source_dir)
        try:
            main_client = HttpClient(SCRIPT_DIR, source_dir)
            clients.append(main_client)
            _run_main_flow(results, main_client)
            run_grant_checks(results, main_client, SCRIPT_DIR, source_dir)
            _run_stateless_and_legacy_checks(results, source_dir, clients)
            run_s3_checks(results, SCRIPT_DIR, build_fixtures()["doc-table"], clients)
            _assert_protocol_purity(results, clients)
            run_paging_checks(results)
            run_skipped_checks(results)
            run_hint_checks(results)
            run_header_checks(results)
            run_file_checks(results)
        finally:
            for client in clients:
                client.close()
    return results.summarize()


if __name__ == "__main__":
    sys.exit(0 if run() else 1)
