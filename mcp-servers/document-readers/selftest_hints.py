"""Header-hint checks for `selftest.py` — split out to keep that file under the line budget.

What they prove: when a refusal names the row to use as the header, it names a row of column
titles, not the form's caption. On a real biểu the caption read "TỔNG HỢP … NỘI DUNG … DỰ TOÁN 2027"
and the titles sat three rows below it; both matched one of the two titles asked for, the caption
won the tie by coming first, and a caller sent to it never read the sheet.

Run in-process against `tables`: the property is about which row the hint leads with.
"""
from __future__ import annotations

import fixtures
import tables
import xlsx_reader
from wire_client import Results


def run_hint_checks(results: Results) -> None:
    workbook = xlsx_reader.parse_workbook(fixtures.build_xlsx({"31- ĐBXH": [
        ["Mẫu biểu số 31"],
        ["TỔNG HỢP KẾT QUẢ THỰC HIỆN CÁC CHÍNH SÁCH THEO NỘI DUNG GIAO NĂM 2026 VÀ DỰ TOÁN 2027"],
        ["Đơn vị tính: Triệu đồng"],
        ["STT", "Nội dung", "Hệ số", "Dự toán năm 2026", "UTH năm 2026", "Năm 2027"],
        ["A", "B", "1", "2", "3", "4"],
        ["1", "Trợ cấp xã hội hàng tháng", "1.5", "1200", "1180", "1300"],
    ]}))
    sheet = workbook.sheets[0]
    asked = {"content": ["Nội dung"], "amount": ["Dự toán 2027"]}
    hint = tables.rows_holding_titles(sheet, asked)
    titles_row = sheet.row_numbers[2]
    results.check(
        "a caption that merely contains a title does not outrank the row where the title is a cell of its own",
        hint.startswith(f"Use headerRow {titles_row} — that row reads: STT | Nội dung"),
        hint[:220],
    )
    results.check(
        "the caption is still named, after the row to use — it does hold the words asked for",
        "Other rows holding some of them: 2 (1 of 2)" in hint,
        hint[:320],
    )
    # More titles matched still beats how they matched — counted in cells: the caption above
    # mentions both titles in its one sentence, and that is one cell, not two columns.
    both = tables.rows_holding_titles(sheet, {"content": ["Nội dung"], "amount": ["dự toán năm"]})
    results.check(
        "a row carrying more of the titles, each in a cell of its own, leads",
        both.startswith(f"Use headerRow {titles_row} ") and "(matches 2 of 2)" in both,
        both[:200],
    )
