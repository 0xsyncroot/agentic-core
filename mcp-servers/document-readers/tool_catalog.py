"""Public Office tool schemas, independent of product business rules."""
import documents
from protocol import ToolSpec

def build_tool_registry() -> dict[str, ToolSpec]:
    from tools import _handle_read_document, _handle_read_table
    from cell_tools import read_cells_spec
    registry = {
        "read_cells": read_cells_spec(),
        "read_document": ToolSpec(
            description=(
                "Excel previews include original formulas alongside cached values; use read_cells for "
                "an A1 range or formula dependencies. On a sheet full of formulas the formulas outweigh the "
                "rows and a page holds few of them: pass `formulas: false` to leave the `formulas` map out "
                "(`formulasOmitted` then says so) and the page holds several times more rows — `offset`, "
                "`nextOffset` and `rowNumbers` mean the same either way. Word previews include tableRows; follow "
                "nextTableOffset as tableOffset until absent, separately from paragraph offset. "
                "Reads one document: a bounded preview of a workbook (.xlsx) or text document (.docx), "
                "or, for an image file, the image itself returned as an image block for you to look at. "
                "`sheets` reports rowCount, dataRowCount, `figureRowCount` (rows carrying a number) and `heading` "
                "(the first real line of text on that sheet) for each sheet — so one call surveys a "
                "workbook and an official form's own title is readable without opening it. Row counts alone "
                "do not tell a filled form from a blank one printed from a circular: both are full of rows. "
                "Every list in the result is a page sized to fit one answer, never the whole of a large "
                "document: `totalSheets` says how many sheets there are, and `nextSheetOffset`, when present, "
                "is where the list continues — pass it back as `sheetOffset` until it is gone before "
                "concluding what the workbook holds. "
                "the preview carries totalRows (totalParagraphs for a text document) and, while rows remain, "
                "nextOffset to pass back as `offset`. "
                "It also carries `rowNumbers`, each previewed row's own worksheet row, and `headerRowNumber`: "
                "a worksheet omits rows it has nothing in, so counting down the preview does not give a row "
                "number this file has. Pass a number from `rowNumbers`, never a counted position. "
                "A scanned or photographed form arrives as an image — this server does not transcribe it."
            ),
            input_schema={
                "type": "object",
                "properties": {
                    "documentId": {"type": "string"},
                    "sheet": {"type": "string"},
                    "offset": {"type": "integer", "minimum": 0},
                    "sheetOffset": {"type": "integer", "minimum": 0},
                    "tableOffset": {"type": "integer", "minimum": 0},
                    "maxRows": {"type": "integer", "minimum": 1, "maximum": documents.MAX_MAX_ROWS},
                    "formulas": {"type": "boolean", "default": True},
                },
                "required": ["documentId"],
                "additionalProperties": False,
            },
            annotations={"readOnlyHint": True},
            handler=_handle_read_document,
        ),
        "read_table": ToolSpec(
            description=(
                "Reads a spreadsheet sheet as normalized rows. `columns` maps a field name to the header "
                "synonyms that identify it (e.g. {\"code\": [\"code\", \"id\"]}); omit it to get every "
                "column keyed by its own header text. A synonym of the form `#3` takes column 3 by "
                "position, 0-based — official forms title only the columns they have a word for and leave "
                "the cells above STT/Nội dung empty, and those columns are reachable no other way. A field "
                "matching nothing comes back under `unresolvedColumns`, naming it, the untitled positions on "
                "that header row, and what the first row of data holds in them. `headerRow` says which worksheet row holds the column "
                "titles — official forms often open with caption lines, so read the first rows with "
                "read_document and pass that row's own number from the preview's `rowNumbers`, not its "
                "position in the list; without it the sheet's first row is assumed. "
                "Without `maxRows` this returns the table up to 200 rows, not a sample — an official "
                "biểu often opens with twenty lines of chỉ tiêu before the first nhiệm vụ, so a sample can "
                "contain none of the work. A wide table's page holds fewer rows than that, as many as fit "
                "one answer. Page until `nextOffset` is gone rather than treating the first answer as the sheet. "
                "`offset` pages through the sheet: the result carries `totalRows`, and `nextOffset` when "
                "rows remain. `totalRows` counts only rows with selected values, not all source rows. "
                "`skipped` is a small page of non-empty rows with no selected values; `totalSkipped` "
                "is their exact count. To inspect more skips, pass `nextSkippedOffset` as "
                "`skippedOffset`, independently of the data's `offset`. A `columnWarning` means "
                "most source rows were excluded: inspect read_document and correct headerRow/columns "
                "before concluding the sheet is empty or fully read. "
                "When `columns` is given and exactly one row carries all the titles, that row is used as the header "
                "whatever `headerRow` says (`headerRowNote` says so). `columnPaths` gives each returned column's "
                "position and full header path — the group titles above the header row, then its own title — "
                "so columns that repeat a title are told apart. `all: true` returns every row in one result "
                "(up to the size cap; `nextOffset` still says if it was cut), for a table that is handed on "
                "to a comparison by its resultId rather than read page by page."
            ),
            input_schema={
                "type": "object",
                "properties": {
                    "documentId": {"type": "string"},
                    "sheet": {"type": "string"},
                    "columns": {"type": "object", "additionalProperties": {"type": "array", "items": {"type": "string"}}},
                    "headerRow": {"type": "integer", "minimum": 1},
                    "offset": {"type": "integer", "minimum": 0},
                    "skippedOffset": {"type": "integer", "minimum": 0},
                    "maxRows": {"type": "integer", "minimum": 1, "maximum": documents.MAX_MAX_ROWS},
                    "all": {"type": "boolean"},
                },
                "required": ["documentId"],
                "additionalProperties": False,
            },
            annotations={"readOnlyHint": True},
            handler=_handle_read_table,
        ),
    }
    return registry
