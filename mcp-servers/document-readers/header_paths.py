"""Where a table's header really starts: the title of every column with the titles above it.

A form's header is usually two or three rows — a group title ("Lương") merged over several columns
and the column's own title under it ("Thực lĩnh"). `read_table` keys a column by the row it was told
to use, which is the lowest of them, so two columns that differ only by their group ("Số tiền" under
six groups) arrived as the same words and the caller could not say which it meant. This reads the
rows above the header row, resolves merged cells to the text they own, and returns each column's
full path, so a caller names a column by its group and its title.

Mechanical on purpose: it knows nothing about what a title means. A line that is plainly a caption —
one text in the whole row, or one merged over (nearly) the whole width — is not a group title.
"""
from __future__ import annotations

from xlsx_reader import SheetData

_BAND_ROWS = 3
_TEXT_CHARS = 80
_CAPTION_SHARE = 0.9


def _text(value: object) -> str:
    return " ".join(str(value).split()) if value is not None else ""


def header_paths(whole: SheetData, header_row: int, columns: list[tuple[str, int, str]]) -> list[dict]:
    """`columns` is `(field, index, header text)` per resolved column, `index` 0-based.

    Returns `[{"field", "column", "path"}]`: `path` is the group titles above the header row, outermost
    first, then the column's own title. `whole` is the sheet as it arrived, before it was rebased.
    """
    numbered = {whole.header_row_number: list(whole.header)}
    numbered.update(zip(whole.row_numbers, whole.rows))
    width = max((len(row) for row in numbered.values()), default=0)
    merges = whole.merges

    def own(row_number: int, index: int) -> tuple[str, int]:
        """The text a cell shows — its own, or the merged range's — and how many columns that text spans."""
        row = numbered.get(row_number)
        value = _text(row[index]) if row is not None and index < len(row) else ""
        for first_row, first_col, last_row, last_col in merges:
            if first_row <= row_number <= last_row and first_col <= index + 1 <= last_col:
                top = numbered.get(first_row)
                owner = _text(top[first_col - 1]) if top is not None and first_col - 1 < len(top) else ""
                return owner, last_col - first_col + 1
        return value, 1

    def caption(row_number: int) -> bool:
        """A row that is blank, or one line of text across the sheet, holds no column titles."""
        row = numbered.get(row_number)
        filled = [i for i in range(len(row)) if _text(row[i])] if row else []
        if not filled:
            return True
        if width < 4:
            return False
        return len(filled) == 1 or any(own(row_number, i)[1] >= _CAPTION_SHARE * width for i in filled)

    band = [r for r in range(header_row - _BAND_ROWS, header_row) if r >= 1 and not caption(r)]
    out: list[dict] = []
    for field, index, header in columns:
        groups: list[str] = []
        for row_number in band:
            title, _span = own(row_number, index)
            title = title[:_TEXT_CHARS]
            if title and (not groups or groups[-1] != title) and title != _text(header):
                groups.append(title)
        out.append({"field": field, "column": index, "path": [*groups, _text(header)[:_TEXT_CHARS]]})
    return out
