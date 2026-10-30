"""Generic table extraction over a parsed workbook sheet: resolves caller-supplied header
synonyms to column positions, coerces cell values, and reports a skip reason for any row that
carries no value in any requested column.

This module knows nothing about what a field *means* — the vocabulary (which header text counts
as "code" vs "amount" vs anything else) is entirely caller-supplied via `read_table`'s `columns`
argument. What lives here is purely mechanical: locate a header, match it against a synonym list
case/diacritic-insensitively, read off the column position, and shape the rows underneath it.
"""
from __future__ import annotations

import difflib
import re
import unicodedata
from dataclasses import dataclass, replace

from errors import ToolInputError
from xlsx_reader import cell_address, SheetData


def _fold_diacritics(text: str) -> str:
    """Strips Vietnamese tone and vowel marks so `noi dung` matches `Nội dung`.

    NFD splits a precomposed vowel into base + combining mark, which `Mn` then drops. `đ`/`Đ` is the
    exception that makes this more than a one-liner: it is a distinct letter, not a decomposable
    one, so NFD leaves it alone and it has to be mapped by hand — miss that and `dam bao xa hoi`
    still fails to match `Đảm bảo xã hội` while everything around it starts working, which is a
    worse place to stop than not folding at all.
    """
    decomposed = unicodedata.normalize("NFD", text)
    stripped = "".join(c for c in decomposed if unicodedata.category(c) != "Mn")
    return stripped.replace("đ", "d").replace("Đ", "D")


def _normalize(text: str) -> str:
    """Case- and diacritic-insensitive form used for every header/synonym comparison here.

    The diacritic half used to be missing: this returned NFKC, which preserves precomposed
    Vietnamese vowels, while this module's docstring and `_find_column` both advertised
    diacritic-insensitive matching. A caller who believed the documentation and wrote its synonyms
    without tones — the natural thing to write — resolved no column at all, and every row in the
    sheet came back as `skipped` with no hint that the header was the problem. Folding here rather
    than at each call site keeps the promise in one place; exact, fully-accented synonyms fold to
    themselves, so nothing that worked before changes.
    """
    return _fold_diacritics(unicodedata.normalize("NFKC", text)).strip().lower()


def typed_sheet_name(name: str, names: list[str]) -> str:
    """A sheet's name as a caller can type it back: without the spaces around it, when that still resolves to this sheet.

    A tab named 'P. GVHĐ - BHXH ' carries a trailing space nobody sees in Excel. Printed with it, the name was copied and the
    caller, unable to end a string on a space, sent 'P. GVHĐ - BHXH 1234567890' twenty-two times (2026-10-11). The trimmed
    name resolves to the same tab, so the trimmed name is what the reader prints; two tabs that differ only so keep theirs.
    """
    trimmed = name.strip()
    if not trimmed or trimmed == name:
        return name
    exact = [other for other in names if other == trimmed]
    return trimmed if not exact and select_sheet_name(names, trimmed)[0] == name else name


def select_sheet_name(names: list[str], asked: str) -> tuple[str | None, list[str]]:
    """The sheet a request names: the name exactly as given, then without its surrounding spaces, then `resolve_sheet_name`.

    The exact name comes first, so tabs 'X' and 'X ' are each read by the name printed for them; trimming first read 'X'
    for a request of 'X ' without a word, and left a tab 'A ' beside 'a' unreachable. Returns `(resolved, nearest)`.
    """
    if asked in names:
        return asked, []
    trimmed = asked.strip()
    if trimmed in names:
        return trimmed, []
    return resolve_sheet_name(names, trimmed)


def resolve_sheet_name(names: list[str], asked: str) -> tuple[str | None, list[str]]:
    """The sheet a caller meant when no name matched exactly, or the nearest names to retry with.

    Returns `(resolved, nearest)`. `resolved` is a real sheet name when the request differs from
    exactly one sheet only in spacing, case or tone marks — `'31-ĐBXH'` for a workbook whose tab is
    `'31- ĐBXH'`. `nearest` is what to say instead when nothing can be resolved.

    One space was worth nineteen retries. On a real dossier a caller asked for `'31-ĐBXH'` — the
    tab is `'31- ĐBXH'` — and the refusal answered with all forty-five sheet names and no hint
    which of them was meant. It then walked headerRow 4, 5, 6, 7, 8 and 9 on a sheet that did not
    exist under that name, so every retry was doomed before it was sent, and the list it was handed
    each time did contain the answer: one character away, forty-fourth in a wall of names.

    Resolution is deliberately narrow — same characters, different whitespace or tone — because
    these sheets are `'24-SNGD'` and `'24-SNKT'`, `'31'` and `'31- ĐBXH'`. Anything looser would
    read a different biểu than the one asked for and report a total for it, which is worse than a
    refusal. Where it cannot be resolved, naming the near misses is a fact about the workbook, not
    a guess about intent: the caller can see the document and still decides.
    """
    squeezed = {name: re.sub(r"\s+", "", _normalize(name)) for name in names}
    want = re.sub(r"\s+", "", _normalize(asked))
    same = [name for name, key in squeezed.items() if key == want]
    if len(same) == 1:
        return same[0], []
    # One tab begins with what was asked and no other does: `'33'` for the only tab `'33-KHCN'`. The result echoes
    # the sheet really read, so this is visible; two tabs that begin alike stay a refusal naming both.
    if not same and len(want) >= 2:
        begins = [name for name, key in squeezed.items() if key.startswith(want)]
        if len(begins) == 1:
            return begins[0], []
    # Two tabs whose names differ only in spacing: say both rather than pick one.
    if same:
        return None, same
    # A tab whose name merely carries more than the ask — `'33'` against `'33-KHCN'` — scores below
    # any sensible edit-distance cutoff while being the only thing the ask could mean, so prefixes
    # come first and difflib fills in behind them.
    starts = [name for name, key in squeezed.items() if want and (key.startswith(want) or want.startswith(key))]
    close = difflib.get_close_matches(want, sorted(set(squeezed.values())), n=3, cutoff=0.6)
    ranked = starts + [name for key in close for name, other in squeezed.items() if other == key]
    return None, list(dict.fromkeys(ranked))[:3]


def _find_column(header: list[str], synonyms: list[str]) -> int | None:
    # `#3` takes column 3 by position, 0-based, whatever its title says — including nothing at all.
    # An official form labels only the columns it has a word for: on a real biểu the header row
    # names Cân đối / BSMT / Trên phần mềm and leaves the cells above STT and Nội dung empty, so
    # those two columns were unreachable through this API no matter how the caller spelled them.
    # A caller that can see the rows can see which position holds what; it could not say so.
    for synonym in synonyms:
        if isinstance(synonym, str) and _POSITION.fullmatch(synonym.strip()):
            index = int(synonym.strip()[1:])
            if 0 <= index < len(header):
                return index
    normalized_header = [_normalize(h) for h in header]
    normalized_synonyms = [_normalize(s) for s in synonyms if isinstance(s, str) and s.strip()]
    if not normalized_synonyms:
        return None
    for i, h in enumerate(normalized_header):
        if h and h in normalized_synonyms:
            return i
    for i, h in enumerate(normalized_header):
        if h and any(syn in h for syn in normalized_synonyms):
            return i
    return None


# Enough of a row to recognise its titles, bounded so a refusal stays a sentence a caller reads
# rather than a dump of a wide sheet it scrolls past.
_POSITION = re.compile(r"#\d+")
_ROW_CELLS = 8
# A candidate header row is shown whole: a wide form's column the caller needs sits past the eighth cell.
_HEADER_CELLS = 80
_CELL_CHARS = 40


@dataclass
class ResolvedColumn:
    field: str
    header: str
    index: int


def resolve_columns(header: list[str], columns: dict[str, list[str]] | None) -> tuple[list[ResolvedColumn], list[str]]:
    """`columns` maps a field name to a list of header synonyms for it. `None` (or an empty
    dict) falls back to an identity mapping: every non-empty header cell becomes its own field,
    named after its own text — a reasonable default when the caller doesn't yet know the
    document's vocabulary. Returns `(resolved, unresolvedFields)`."""
    if not columns:
        # A multi-level header repeats its leaf titles ("Hệ số", "Thành tiền" under every item);
        # keyed by text alone, each repeat overwrote the one before and the row kept only the last
        # item's figures. A repeated title is keyed with its column letter, so every column survives.
        repeated = {h for h in header if h and header.count(h) > 1}
        return [ResolvedColumn(field=f"{h} [{cell_address(1, i + 1)[:-1]}]" if h in repeated else h, header=h, index=i)
                for i, h in enumerate(header) if h], []
    resolved: list[ResolvedColumn] = []
    unresolved: list[str] = []
    for field, synonyms in columns.items():
        index = _find_column(header, synonyms) if isinstance(synonyms, list) else None
        if index is not None:
            resolved.append(ResolvedColumn(field=field, header=header[index], index=index))
        else:
            unresolved.append(field)
    return resolved, unresolved


def _coerce(value: object) -> object:
    """Cell values from `xlsx_reader`/`docx_reader` are already natively typed (numbers, bools,
    strings) from the document's own format — this only trims incidental whitespace off strings,
    turning a whitespace-only cell into `None`. No locale-specific number parsing happens here: a
    caller that needs e.g. "1.234,56"-style text coerced supplies already-numeric cells or does
    that coercion itself."""
    if isinstance(value, str):
        trimmed = value.strip()
        return trimmed if trimmed else None
    return value


def _row_is_blank(row: list[object]) -> bool:
    return all(v is None or (isinstance(v, str) and not v.strip()) for v in row)


def rows_holding_titles(sheet: SheetData, columns: dict[str, list[str]] | None) -> str:
    """The instruction naming the row to use, or "" when there is nothing to say.

    Shared by both refusals a caller can hit while looking for a header — the row it named does
    not exist, or the row it landed on matched nothing — because in both cases the useful answer
    is the same one, and a caller told it in one place and not the other still ends up guessing.

    It leads with the row to pass, and the caller's message puts it first, because order turned out
    to be the whole of it. This used to arrive after the header that failed to match, which on a
    real form is twenty-six empty strings. Across six sheets and more than twenty refusals an agent
    rewrote its column spellings every single time and never once passed the row it had been
    handed — on one sheet it tried 5, 6, 4 and 3 while the answer, named in every refusal, was 7.
    """
    if not columns:
        return ""
    where = _rows_holding(sheet, columns)
    if not where:
        return _rows_reading(sheet)
    wanted = len(columns or {})
    best, count, cells = where[0]
    lead = f"Use headerRow {best} — that row reads: {' | '.join(cells)} (matches {count} of {wanted})."
    others = "; ".join(f"{number} ({matched} of {wanted})" for number, matched, _ in where[1:])
    return lead + (f" Other rows holding some of them: {others}." if others else "")


def rows_named_in_hint(sheet: SheetData, columns: dict[str, list[str]] | None) -> tuple[int, ...]:
    """Row numbers `rows_holding_titles` points at, for the log: the hint's cells never go there."""
    return tuple(number for number, _, _ in _rows_holding(sheet, columns)) if columns else ()


def _rows_reading(sheet: SheetData) -> str:
    """What to say when no row carries any of the titles asked for.

    Ten refusals in one run ended here and said only that nothing matched. The caller had landed on
    a data row — `['', 'VHTT', '4210', ...]` — so the caption-line branch did not fire either, and
    the sheet's real titles were never named because none of the caller's spellings appear in this
    sheet at all. "Nothing matched" is true and leaves nowhere to go; the sheet's own rows are the
    only thing that can move it, and reading them back needs no vocabulary the caller lacks.
    """
    numbered = [(sheet.header_row_number, list(sheet.header)), *zip(sheet.row_numbers, sheet.rows)]
    filled = []
    for number, row in numbered[:60]:
        cells = [str(cell) for cell in row if cell is not None and str(cell).strip()]
        if len(cells) >= 2:
            filled.append((number, [cell[:_CELL_CHARS] for cell in cells[:_ROW_CELLS]]))
    if not filled:
        return ""
    reads = "; ".join(f"{number}: {' | '.join(cells)}" for number, cells in filled[:3])
    return ("No row here carries any of those titles, under any spelling. These rows do hold "
            f"values — pass one as `headerRow` if its words are the columns you mean: {reads}.")


def caption_header_warning(sheet: SheetData) -> str:
    """What to tell a caller who read every column without `headerRow` when the row used as the header is a caption.

    A refusal names the way out when asked-for titles match nothing; reading every column asks for no title, so nothing
    was said. Live (2026-10-11): a whole-sheet read took row 1 — the sheet's title — as its header, the caller guessed
    headerRow 9, the first person's row, and that person vanished from the comparison. The facts end the guess: how
    empty the row used is, and the first rows that hold several cells, read back. Which one is the header stays the
    caller's call.
    """
    filled = [cell for cell in sheet.header if str(cell).strip()]
    if len(filled) > max(1, len(sheet.header) // 8):
        return ""
    numbered = list(zip(sheet.row_numbers, sheet.rows))[:40]
    counts = [len([cell for cell in row if cell is not None and str(cell).strip()]) for _, row in numbered]
    wide = max(2, (max(counts, default=0) + 1) // 2)
    rows = []
    for (number, row), count in zip(numbered, counts):
        cells = [str(cell) for cell in row if cell is not None and str(cell).strip()]
        if count >= wide:
            rows.append(f"{number}: {' | '.join(cell[:_CELL_CHARS] for cell in cells[:_ROW_CELLS])}")
        if len(rows) == 3:
            break
    reads = f" The first rows holding at least {wide} cells: {'; '.join(rows)}." if rows else ""
    return (f"Row {sheet.header_row_number} was read as the header and holds {len(filled)} non-empty cell(s) of {len(sheet.header)}:"
            f" probably a caption line, so the columns are not named by their titles.{reads}"
            " Pass the titles' row as headerRow (a row of titles merged over two rows is read with its second row).")


def _rows_holding(sheet: SheetData, columns: dict[str, list[str]]) -> list[tuple[int, int, list[str]]]:
    """Rows whose own cells carry the requested header synonyms, best first, at most three.

    Purely a search: it says where these words appear, never which row a form's header "should"
    be — that call stays with the caller, who can see the document. What it removes is the part
    no one should have to do by hand, which is guessing a row number and retrying.

    Each row comes back with its own words, because naming the row answers only half the question
    a partial match raises. One dossier calls the same column "Nội dung" on one biểu, "CHỈ TIÊU"
    on the next and "Danh mục dự án" on a third: a caller told "row 6, matches 1 of 2" knows where
    to look and still cannot know what the title it missed is called. Reading the cells back needs
    no vocabulary — it repeats what the sheet already says — and turns the retry into a correction.
    """
    numbered = [(sheet.header_row_number, list(sheet.header)), *zip(sheet.row_numbers, sheet.rows)]
    scored: list[tuple[int, int, list[str], int]] = []
    for number, row in numbered[:60]:
        cells = [str(cell) for cell in row if cell is not None and str(cell).strip()]
        # Counted in cells, not in titles: two titles found inside one and the same cell are one
        # sentence that happens to mention both, and no table has two columns in one cell.
        matched = len({_find_column(cells, synonyms) for synonyms in columns.values() if isinstance(synonyms, list)} - {None})
        if matched > 0:
            scored.append((number, matched, [cell[:_CELL_CHARS] for cell in cells[:_HEADER_CELLS]], _whole_cell_matches(cells, columns)))
    # Between rows matching equally many titles, the one where a title is a cell of its own comes
    # before the one where it is only a few words inside a sentence. A form's caption line names
    # its own subject — "TỔNG HỢP ... NỘI DUNG ... DỰ TOÁN 2027" — and sits above the column
    # titles, so with row order as the only tie-break the caption won every tie: on a real biểu
    # the refusal said "Use headerRow 2" while row 5 held a cell reading exactly "Nội dung", and
    # the caller, sent to the caption, never read the sheet at all. This is still only where the
    # words appear and how: nothing here knows what a header is.
    scored.sort(key=lambda item: (-item[1], -item[3], item[0]))
    return [(number, matched, cells) for number, matched, cells, _ in scored[:3]]


def _whole_cell_matches(cells: list[str], columns: dict[str, list[str]]) -> int:
    """How many of the asked-for titles are, on this row, the whole text of a cell."""
    normalized = {_normalize(cell) for cell in cells}
    return sum(
        1 for synonyms in columns.values()
        if isinstance(synonyms, list) and any(isinstance(s, str) and s.strip() and _normalize(s) in normalized for s in synonyms)
    )


def extract_table(sheet: SheetData, columns: dict[str, list[str]] | None, whole: SheetData | None = None) -> dict:
    """Returns `{"columns": {field: resolvedHeaderText}, "rows": [...], "skipped": [{"row","reason"}]}`.
    A row with no value in any resolved column is reported in `skipped` with the sheet's own row
    number and a reason; a row with no value anywhere at all (resolved or not) is silently
    omitted — it carries nothing to report skipping. A field whose synonyms matched nothing is
    simply absent from `columns` (and from every row): the caller can tell it wasn't found by its
    absence, without a separate field for it.

    Raises `ToolInputError` when `columns` was given but none of it matched any header — that is
    almost certainly a misconfigured call, and a clear error beats silently returning rows of
    empty objects."""
    resolved, unresolved = resolve_columns(sheet.header, columns)
    if columns and not resolved:
        # Naming the header that was matched against is not enough on its own: the commonest cause
        # is that the row used as the header is not the header at all — an official form opens with
        # caption lines, and without `headerRow` the first row is assumed. A caller told only "none
        # matched" re-sends the same call with different column names and fails the same way. So
        # when the row is mostly empty, say what it looks like and name the way out.
        filled = [cell for cell in sheet.header if str(cell).strip()]
        # Searching for the asked-for titles is mechanical — no judgement about what a form's
        # header "should" look like, just: which rows contain these words. Saying only "none
        # matched" leaves the caller guessing a row number, and on a real dossier it guessed
        # wrong eight times running. Naming the rows that do hold them ends the guessing.
        # Searched against the sheet as it arrived, not as it was rebased. `rebase_header` drops
        # every row above the one the caller named, so the hint could only ever point downward: a
        # caller that overshot the titles by one row was told to try rows 35, 37 and 40 while the
        # answer, row 5, had been cut away by its own guess. It asked for row 6 twice and row 8
        # once on that sheet and was never once pointed back up.
        lead = rows_holding_titles(whole or sheet, columns)
        if not lead and len(filled) <= max(1, len(sheet.header) // 8):
            lead = (
                f"Row {sheet.header_row_number} was used as the header and holds almost nothing"
                f" ({len(filled)} non-empty of {len(sheet.header)}), so it is probably a caption line rather than the"
                " column titles: read the first rows with read_document and pass the titles' own number"
                " from its `rowNumbers` as `headerRow`."
            )
        # The empty cells are dropped from the echo: a sheet twenty-six columns wide opened this
        # message with twenty-six empty strings, which is not what the row holds — it is what it
        # does not hold, spelled out at length in front of the part worth reading.
        raise ToolInputError(
            f"{lead}{' ' if lead else ''}Row {sheet.header_row_number} was read as the header and none of"
            f" {unresolved} matched it; it holds {filled if filled else 'nothing'}.",
            code="header_not_matched",
            echoes_cells=True,
            rows=(sheet.header_row_number, *rows_named_in_hint(whole or sheet, columns)),
        )
    rows_out: list[dict] = []
    row_numbers_out: list[int] = []
    skipped: list[dict] = []
    for row, row_number in zip(sheet.rows, sheet.row_numbers):
        if _row_is_blank(row):
            continue
        row_values = {c.field: _coerce(row[c.index]) if c.index < len(row) else None for c in resolved}
        if all(v is None for v in row_values.values()):
            skipped.append({"row": row_number, "reason": "no value in any requested column"})
            continue
        # Only the fields this row has: a column the row leaves empty is said by its absence, the
        # same way an unresolved field is, and `"amount": null` forty times a page is not data.
        rows_out.append({field: value for field, value in row_values.items() if value is not None})
        row_numbers_out.append(row_number)
    columns_out = {c.field: c.header for c in resolved}
    # Each returned row's own worksheet row: blank rows are left out, so a position in `rows` is not a row number.
    result = {"columns": columns_out, "rows": rows_out, "rowNumbers": row_numbers_out,
              "headerRowNumber": sheet.header_row_number, "skipped": skipped}
    if len(skipped) > len(rows_out):
        # A caption or currency label can match a column and produce a successful read while
        # dropping nearly all the sheet's content. Report the measured coverage, without
        # guessing a new header or claiming the source rows are empty.
        result["columnWarning"] = (
            f"{len(skipped)} non-empty source rows have no value in the selected columns; only"
            f" {len(rows_out)} rows have selected values. This is not an empty sheet."
            f" Row {sheet.header_row_number} was used as the header. Read this sheet's first rows"
            " with read_document, then pass the titles' actual rowNumber as headerRow."
            " For untitled columns, use #n (0-based) in columns. totalRows counts only rows"
            " with selected values, not all source rows."
        )
    # Some asked-for fields matched and some did not. That is not a refusal — the rows that did
    # resolve are real — but it must not be silent either. On a real form the header row labels
    # only the money columns and leaves the STT and Nội dung cells empty above them, so a caller
    # asking for stt/noiDung/amounts got the amounts and nothing else, and read that back as "the
    # sheet has figures with no names". The names were in the sheet; this read dropped them, and
    # nothing in the result said so.
    if unresolved:
        where = rows_holding_titles(whole or sheet, {field: columns[field] for field in unresolved if columns})
        blank = [i for i, cell in enumerate(sheet.header) if not str(cell).strip()][:_ROW_CELLS]
        first = next((row for row in sheet.rows if not _row_is_blank(row)), [])
        holds = "; ".join(
            f"#{i} holds {str(first[i])[:_CELL_CHARS]!r}"
            for i in blank if i < len(first) and first[i] is not None and str(first[i]).strip()
        )
        result["unresolvedColumns"] = {
            "fields": unresolved,
            "detail": (f"{', '.join(unresolved)} matched no header cell on row {sheet.header_row_number},"
                       f" so those columns are absent from every row returned above."
                       + (f" This row leaves columns {', '.join(f'#{i}' for i in blank)} untitled, and the first"
                          f" row of data {holds} — pass `#n` as the synonym to take a column by position." if holds else "")
                       + (f" {where}" if where else "")),
        }
    return result


def rebase_header(sheet: SheetData, header_row: int) -> SheetData:
    """The same sheet read as if row `header_row` were the header row.

    The parser takes the first `<row>` present as the header, which is right for a sheet that
    begins with its column titles and wrong for most official forms: a Vietnamese budget form opens
    with three to five caption lines ("Mẫu biểu số 18", the form's title, the unit of currency) and
    the real column titles sit below them, often spread over two merged lines.

    This does NOT guess which row that is, and deliberately so. Deciding where a form's header
    begins is reading comprehension, not parsing: the shape differs by province, by form and by
    year, so any rule here would be right for the samples it was written against and quietly wrong
    for the next batch. The caller — which can see the first rows and knows what it is looking at —
    says which row, and this obeys. That is also how a code-execution sandbox handles it: the model
    reads a few rows, then passes `header=4` itself.
    """
    numbered: list[tuple[int, list[object]]] = [(sheet.header_row_number, list(sheet.header))]
    numbered.extend(zip(sheet.row_numbers or range(sheet.header_row_number + 1, len(sheet.rows) + sheet.header_row_number + 1), sheet.rows))
    position = next((i for i, (number, _) in enumerate(numbered) if number == header_row), None)
    if position is None:
        # A worksheet omits rows it has nothing in, so the numbers present are a sparse set, not a
        # range. Reporting first-to-last as "rows present" told a caller that row 6 was present
        # while refusing row 6 — a message that contradicts itself and leaves nowhere to go. The
        # real numbers near the ask are what the caller can act on.
        present = [number for number, _ in numbered]
        nearby = sorted(present, key=lambda number: (abs(number - header_row), number))[:8]
        raise ToolInputError(
            f"headerRow {header_row} is not a row in sheet {sheet.name.strip() or sheet.name!r}: this sheet omits empty rows, so its "
            f"row numbers skip. Nearest rows that do exist: {', '.join(str(n) for n in sorted(nearby))}. "
            "Use a rowNumber from read_document's preview rather than counting rows.",
            code="header_not_matched",
        )
    header_cells = ["" if cell is None else str(cell).strip() for cell in numbered[position][1]]
    # A title merged down over this row (and the row above it) is this column's title, though the cell under it is empty.
    by_number = dict(numbered)
    for first_row, first_col, last_row, last_col in sheet.merges:
        if first_row <= header_row <= last_row and first_row != header_row:
            owner = by_number.get(first_row)
            title = "" if owner is None or first_col - 1 >= len(owner) or owner[first_col - 1] is None else str(owner[first_col - 1]).strip()
            if title and last_col > len(header_cells):
                header_cells.extend([""] * (last_col - len(header_cells)))
            for index in range(first_col - 1, last_col):
                if title and not header_cells[index]:
                    header_cells[index] = title
    body = numbered[position + 1:]
    return replace(
        sheet,
        header=header_cells,
        rows=[row for _, row in body],
        row_numbers=[number for number, _ in body],
        header_row_number=header_row,
    )


def unique_header_row(whole: SheetData, columns: dict[str, list[str]] | None) -> int | None:
    """The one row that carries every requested title, or None when no row does or two rows tie.

    The reader used to compute this ("Use headerRow 5") and then refuse, leaving the caller to pass
    back the number it had just been told. When the titles asked for identify a row unambiguously
    there is nothing left to decide, so the row is used. A row that matches only some of them, or a
    second row that matches as well (a caption line repeating the words), stays the caller's call.
    """
    if not columns:
        return None
    wanted = len([1 for synonyms in columns.values() if isinstance(synonyms, list)])
    found = _rows_holding_full(whole, columns)
    if wanted == 0 or not found or found[0][1] < wanted:
        return None
    if len(found) > 1 and found[1][1] >= wanted and found[1][3] >= found[0][3]:
        return None
    return found[0][0]


def _rows_holding_full(sheet: SheetData, columns: dict[str, list[str]]) -> list[tuple[int, int, list[str], int]]:
    numbered = [(sheet.header_row_number, list(sheet.header)), *zip(sheet.row_numbers, sheet.rows)]
    scored = []
    for number, row in numbered[:60]:
        cells = [str(cell) for cell in row if cell is not None and str(cell).strip()]
        matched = len({_find_column(cells, synonyms) for synonyms in columns.values() if isinstance(synonyms, list)} - {None})
        if matched > 0:
            scored.append((number, matched, cells, _whole_cell_matches(cells, columns)))
    scored.sort(key=lambda item: (-item[1], -item[3], item[0]))
    return scored


def leaf_header_row(whole: SheetData, header_row: int) -> int | None:
    """The row that holds the column titles proper when `header_row` holds titles merged over several columns.

    A merged title ("Phụ cấp", over three columns) owns the columns beneath it, and the titles of those
    columns are on the next row. Read as the header, the group row yields one column per group and loses the
    amounts under it. Returns that next row's number when a title merged across columns on `header_row` has
    a title beneath it on the next row, else None. A number beneath is data (or a row numbering the columns),
    never a title: the merged row is then the header itself.
    """
    numbered = dict([(whole.header_row_number, list(whole.header)), *zip(whole.row_numbers, whole.rows)])
    later = sorted(number for number in numbered if number > header_row)
    if not later:
        return None
    below = numbered[later[0]]
    # A row that is at least half figures is data, whatever text sits under the merge: a name split over a merged
    # "Họ và tên" would otherwise become the header, and its person would vanish from the rows.
    filled = [cell for cell in below if cell is not None and str(cell).strip()]
    if not filled or 2 * sum(1 for cell in filled if not _is_title(cell)) >= len(filled):
        return None
    for first_row, first_col, last_row, last_col in whole.merges:
        if first_row == header_row and last_row == header_row and last_col > first_col:
            if any(i < len(below) and _is_title(below[i]) for i in range(first_col - 1, last_col)):
                return later[0]
    return None


def _is_title(value: object) -> bool:
    """Text a header cell would hold: not blank, and not a number written as text."""
    if value is None or isinstance(value, (int, float)):
        return False
    text = str(value).strip()
    try:
        float(text.replace(",", "."))
        return False
    except ValueError:
        return bool(text)
