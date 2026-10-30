# document-readers (office-docs MCP server)

A real, runnable Python MCP server that reads Office Open XML documents (.xlsx/.docx). Standard
library for OOXML; legacy `.xls` additionally requires `xlrd==2.0.2`, matching the Dockerfile. Run it, and `python3 selftest.py` proves it, on a
machine with the documented format dependencies installed.

## What this is

A tool server, not a product component: it reads spreadsheets and Word documents and knows
nothing about what the data in them means. Its three tools are advertised by bare name
(`read_document`, `read_table`, `read_cells`); platform-side namespacing happens on the calling
side. The vocabulary that turns columns into meaningful fields is supplied by the caller at call
time and lives nowhere here.

Formats: `.xlsx` and `.xlsm` (OOXML; values, formulas, merged ranges, hidden rows/columns/sheets;
the macro part is never run), legacy `.xls` (values, merges and hidden flags through `xlrd`; no
formulas, and every result says `formulasAvailable: false`), `.docx`, and images.

One reader, **Streamable HTTP** (`POST /mcp`), the transport `@modelcontextprotocol/client`'s `StreamableHTTPClientTransport` speaks:

| Mode | Run | Where files come from | Use |
|---|---|---|---|
| **HTTP MCP** (`http_server.py`) | own container, backend calls `POST /mcp` | S3 by `documentId`, read-only access from its environment; nothing is uploaded to it | deployment on the cloud: [deploy/](deploy/) |
| **HTTP, dev without S3** (`http_server.py --local`) | `python3 http_server.py --local` | `AGENTIC_ATTACHMENTS_DIR/<prefix>` from the repo `.env`, the folder the backend writes in development | local runs; refused by the backend in production |

## How much information reaches the agent

Nothing is returned whole. Each answer is cut to `DOCUMENT_READERS_RESULT_CHARS` (24,000 characters,
under the runtime's 32,000-character tool-result limit, which refuses an over-size result outright).
The agent reads in pages: `read_document` surveys sheets, `read_table` pages rows (at most 200 per
call, fewer when the columns are wide) and returns `nextOffset` until the sheet is done, `read_cells`
returns exact cells and formulas. An image goes back as an image block (at most 4 MiB), for the
model to look at. The server's `instructions` tell the agent this protocol, so the loop is
driven by the agent, not hard-coded per skill.

`read_table` with `all: true` is the exception, for a table that a comparison tool consumes by its
`resultId`: every row in one result, up to 150,000 characters (the runtime shows the model a cut view
and keeps the whole under the id; `nextOffset` still appears if even that cap cut it). Every
`read_table` result also carries `columnPaths`: each returned column's position and full header path
(group titles from the rows above the header row, merged cells resolved), so columns that repeat a
title are told apart. When `columns` is given and exactly one row carries all the titles, that row is
the header whatever `headerRow` says (`headerRowNote`); two rows that tie, or a row that carries only
some of them, stay a refusal that shows each candidate row whole.

## Staying healthy under load (HTTP mode)

Parsing is CPU-bound Python, about 0.4 s for a 240,000-cell sheet and 170 MiB peak (measured), so
the service bounds every resource instead of queueing without end:

| Control | Default | Effect |
|---|---|---|
| `DOCUMENT_READERS_WORKERS` | 2 | concurrent parses (threads share one GIL: this bounds memory, it does not multiply throughput) |
| `DOCUMENT_READERS_MAX_OUTSTANDING` | 8 | running + waiting calls; the next one is answered "busy, retry" immediately |
| `DOCUMENT_READERS_CALL_TIMEOUT_S` | 75 | how long one caller waits; the slot stays counted until the parser really returns |
| Parsed-workbook cache | 4 files / 48 MiB of source | thread-safe, one parse per file even when workers ask together |
| Limits in the readers | 25 MiB file, 250,000 cells, ZIP/XML bomb caps | refused with an error, never attempted |
| `/readyz` | 503 when saturated | Kubernetes stops routing to a saturated pod; `/healthz` stays 200 so it is not killed |
| Watchdog | 180 s | a call that old means a wedged parser: the process exits and is restarted |
| SIGTERM | drains up to 25 s | rolling updates do not cut a read |

The service keeps no state: files come from the archive, and a resource URI (`document://…`)
carries its own tool, arguments and expiry under an HMAC keyed from `DOCUMENT_READERS_TOKEN`
(`grants.py`), so any pod verifies it and serves the read again. Scale out with replicas (manifest:
2 with a PodDisruptionBudget, no session affinity) or up with CPU and `DOCUMENT_READERS_WORKERS`.
The parsed-workbook cache is per pod and only saves time.

One reader deployment serves one archive prefix (`DOCUMENT_S3_PREFIX`). Sample App and EXAMPLE use
different prefixes, so each product runs its own `document-readers` deployment (or Service name) with
its own prefix and read-only key.

## Run it

```bash
cd mcp-servers/document-readers
python3 http_server.py --local       # HTTP MCP on 127.0.0.1:8080 (token from the repo .env); `npm run mcp:documents:sample-app` / `:example`
python3 selftest.py                  # the gate: spawns http_server.py and posts JSON-RPC to /mcp
```

`selftest.py` generates its own `.xlsx`/`.docx` fixtures with `zipfile` (no binary files live in
this repo), writes them into a temporary directory and points the server at it with
`DOCUMENT_SOURCE_DIR`. Run it after any change here.

## Tools

### `read_document`
`{documentId, sheet?, maxRows?, offset?, sheetOffset?, formulas?}` → `{documentId, name, kind:"workbook"|"text", sheets?:[{name,columns,rowCount}], totalSheets?, nextSheetOffset?, preview:{columns?,rows?,paragraphs?}, totalParagraphs?, nextOffset?, resourceUri}`

A bounded preview of one document's structure. `maxRows` defaults to 20, capped at 200. An
unknown `sheet` name or an out-of-range `maxRows` is a tool error naming the problem, not a
silent fallback. Caches its own result under `resourceUri` (see "Resources" below).

`formulas` (boolean, default `true`) decides whether a workbook preview carries the per-cell
`formulas` map. On a wide sheet of formulas the map outweighs the rows: a real 356-row biểu spent
about 80% of each page on it and took 24 pages. With `formulas: false` the map is replaced by a
short `formulasOmitted` note (`formulaValues` stays) and the same sheet takes 4 pages. `offset`,
`nextOffset`, `rowNumbers` and `totalRows` mean the same either way — both start at the same row for
the same `offset`. A non-boolean `formulas` is a tool error. `read_table` and `read_cells` are unchanged.

### `read_table`
`{documentId, sheet?, headerRow?, columns?, maxRows?, offset?, skippedOffset?}` → `{documentId, name, sheet, headerRowNumber, columns:{field: resolvedHeader}, rows:[{...}], totalRows, nextOffset?, skipped:[{row,reason}], totalSkipped, nextSkippedOffset?, columnWarning?, resourceUri}`

Reads one sheet as normalized rows. `columns` is a **caller-supplied** map from a field name to
the header synonyms that identify it, e.g.

```json
{"code": ["mã", "mã hàng"], "amount": ["số lượng", "giá"]}
```

This server does the mechanical part — locating each field's header (case/accent-insensitive,
exact match first, then substring), reading off the column, coercing each cell (numbers/booleans
stay natively typed from the file format; strings are trimmed) — and reports a `skipped` entry
with a real reason for a row that has data but none in any resolved field. `columns` omitted
returns the raw header row and rows as read: an identity mapping where every non-empty header
becomes its own field, so you can inspect a sheet before you know its vocabulary. A requested
field whose synonyms matched nothing is simply absent from `columns` (and from every row) rather
than getting its own error — except when `columns` was given and *none* of it matched anything,
which fails the call outright (a clear error beats silently returning rows of empty objects). No
locale-specific number parsing happens here — a caller with "1.234,56"-style text supplies
already-numeric cells or coerces it after the fact.

`totalRows` counts rows with values in the selected columns. `totalSkipped` counts non-empty source
rows with no selected value; `skipped` carries at most eight of them per call (fewer with a smaller
`maxRows`). Pass `nextSkippedOffset` as `skippedOffset` to inspect the rest, independently of the
data's `offset`. Mostly-excluded tables carry a `columnWarning` explaining the coverage and how to
check `headerRow`/`columns`. A successful read of a caption or currency column is not evidence that
the sheet is empty or that its content was fully read.

## Every result is a page

A caller's runtime refuses a tool result over its own size budget, and a refused result is a
document the model never saw — so no result here is ever larger than `DOCUMENT_READERS_RESULT_CHARS`
(24,000 characters by default), whatever the document's size. What does not fit is not dropped: the
result says where to continue.

| List | Cut to fit | Continue with |
|---|---|---|
| sheets of a workbook (`read_document`) | `sheets` — `totalSheets` says how many there are | `sheetOffset: nextSheetOffset` |
| paragraphs of a text document (`read_document`) | `preview.paragraphs` — `totalParagraphs` | `offset: nextOffset` |
| rows of a sheet (`read_table`, and `read_document` with `sheet`) | `rows` — `totalRows` | `offset: nextOffset` |
| excluded non-empty rows (`read_table`) | `skipped` — `totalSkipped` | `skippedOffset: nextSkippedOffset` |

What a caller reads is what its context pays for, so a result carries nothing it can do without:

- A call that names a `sheet` gets that sheet's own entry in `sheets` (and `totalSheets`), not the
  workbook's whole list again. The survey — the call with no `sheet` — is what lists them.
- A `read_document` row ends at its last cell holding anything; position still means column.
- A `read_table` row carries only the fields that have a value. A field that is absent is an empty
  cell, not a missing column: `columns` in the same result says which columns were matched.

On a real 46-sheet dossier the same twenty-odd calls went from about 496,000 characters to 152,000.

`nextOffset` / `nextSheetOffset` absent means the list was read to its end. The page is cut by
size, not by a fixed row count: a wide sheet returns fewer rows per call than a narrow one, and
`nextOffset` always names the first row not returned. `selftest_paging.py` reads a large workbook
and a long text document by following these fields and checks every row and paragraph arrives
exactly once and no result is over the budget.

What the server refuses to load at all, with `code: "document_too_large"`: a file over 25 MiB, a
workbook over 500 sheets, a sheet over 100,000 rows, a workbook over 250,000 rows in all.

Tool errors carry a `code` beside the message (`document_not_found`, `sheet_not_found`,
`document_too_large`), so a caller can tell the user which of these happened without parsing prose.

## Resources: capability URIs, not a catalogue

`resources/read` carries only `{uri}` — no identity of any kind — and this server is a **single
process shared by every principal using the deployment** (one child, not one per user), so
`resources/read` has nothing to check a caller against. A resource URI that was predictable from
a `documentId` (an earlier version of this server used `document://{documentId}/extraction`) let
any principal who could guess or enumerate a `documentId` read a document another principal had
already read — a cross-tenant/cross-document data leak, found by a security audit and fixed here.

The fix, and the model this server now uses everywhere: **the URI itself is the authorization.**
Every successful `read_document` / `read_table` call mints a fresh grant — `document://<128-bit
random hex>`, never derived from the `documentId` — and returns it as `resourceUri`.

That URI is a **bearer capability**: whoever holds it can read it back, no further check, for as
long as it's valid. It lands in the tool result and therefore in that call's session/conversation
journal, so its secrecy is protected by whatever protects that journal. A deployment that logs or
persists full tool results should treat those logs accordingly.

The TTL (`DOCUMENT_READERS_GRANT_TTL_SECONDS`, default 300s) is what bounds that exposure.

Two more consequences of the capability model:

- **`resources/list` always returns an empty list.** This server does not publish a catalogue of
  live grants, because it cannot tell who is asking — enumeration is exactly what made the old
  scheme's predictability exploitable rather than merely guessable. (Coordination note: since a
  client can no longer *discover* the `document://` scheme this way, the platform side pins it —
  `resources.allowedSchemes: ["document"]` in its MCP server config.)
- **`resources/read` answers unknown, expired, and malformed URIs identically** — one message,
  (see `grants.py`'s `GrantStore.get`). A forged grant id is refused the same way a stale or
  mistyped one is; nothing distinguishes "you guessed wrong" from "that one aged out".

Every call mints its own grant — calling `read_document` twice on the same `documentId` produces
two independent, differently-expiring grants, not one shared, overwritten resource. `selftest_grants.py`
is the dedicated test suite for this: two grants never collide or cross-read each other's document,
`resources/list` stays empty even with live grants present, a forged and several malformed URIs
all fail with byte-identical messages, and a grant genuinely expires on its own TTL.

## Where documents come from

**Object storage** (production): the object `<DOCUMENT_S3_PREFIX><documentId>`, read with a signed
GET (`s3_source.py`, stdlib SigV4 — MinIO, Ceph RGW, AWS). The connection is read from the shared
`S3_*` settings — `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, optional `S3_REGION`,
`S3_PATH_STYLE`, `S3_USE_SSL` — the same variables the backends hold for the same bucket, rather
than a second copy of the credentials. `DOCUMENT_S3_ENV_PREFIX` names another set for a bucket of
its own; the retired prefixes (`AGENTIC_KNOWLEDGE_S3`, `AGENTIC_S3`, `DOCUMENT_S3`) still configure the
shared set, with one warning per name (see `settings.py`). The original file name comes from `x-amz-meta-filename` (percent-encoded).

**Local directory** (tests, dev; `DOCUMENT_SOURCE_DIR`, takes precedence): `<dir>/<documentId>`, with
an optional `<documentId>.meta.json` (`{"name": "...", "mediaType": "..."}`) beside it.

- A `documentId` is an opaque name: letters, digits, `.`, `_`, `-` — no separator, no leading dot,
  never the sidecar suffix — so nothing outside the configured storage is reachable.
- It is also the only authorization: whoever knows an id can read it, the capability model
  `grants.py` already uses for resource URIs. The agent makes ids unguessable (a keyed hash of the
  tenant and the file's content) and only a conversation that received the file ever sees its id.
- Documents are immutable per id (the id derives from the content), so the last 16 read, up to
  128 MiB, stay in memory: paging through one large workbook downloads it once.
- An unknown id, a missing object or unreachable storage is a tool error (`isError`), never a
  protocol error. Files over 25 MiB are refused.

## Why `server/discover` stays even with no elicitation user today

This is a **stateless-first** MCP server (protocol revision `2026-07-28`), confirmed against a
real `@modelcontextprotocol/client@2.0.0`:

- The client's `LATEST_PROTOCOL_VERSION` (`"2025-11-25"`) is the **legacy** `initialize`
  handshake; the name is misleading.
- Multi-round-trip input (`resultType:"input_required"`, `inputRequests`, `requestState`) exists
  only on the **modern** era, reachable only through `server/discover`, gated at `2026-07-28`.
- The legacy codec **silently strips `resultType`** when decoding a result. A server that
  implements only `initialize` can raise `input_required` all day and the client will never show
  a form — no error anywhere, just a feature that quietly never fires.
- **Neither tool here uses `input_required` today** (that need left with the tool that used to
  live here — see "History" below). `server/discover` and the modern-era envelope stay anyway: a
  tool server that cannot raise a form is a dead end the moment a future tool needs one, and the
  failure mode — no error, no log, the question simply never appears — is silent enough that
  finding it after the fact is expensive. `protocol.py`'s dispatch already wraps every result
  modern-shaped and already knows how to turn a handler's `{"elicit": ...}` return into
  `input_required`; the day a tool needs to ask something mid-call, that plumbing is ready.
- Each `POST /mcp` is independent. The client may send `tools/call` with no earlier `initialize`
  or `server/discover` on that process. Nothing in `protocol.py` may assume a handshake happened
  first. `selftest.py` checks this ("stateless first-message tools/call").
- On the modern era, `tools/list` / `resources/list` / `resources/read` results carry `ttlMs` +
  `cacheScope` (SEP-2549 `CacheableResult`); `tools/call` and `ping` do not.

The body of `POST /mcp` is one JSON-RPC 2.0 object. Logs go to stderr. `selftest.py` checks that
every response body parses as `{"jsonrpc":"2.0", ...}`. `test/http.test.mjs` speaks the same
endpoint with `StreamableHTTPClientTransport`.

## Ảnh và bản scan

`read_document` nhận cả file ảnh (`.png`, `.jpg`, `.webp`, …) và trả **chính tấm ảnh đó** về trong
một khối `image` của kết quả, kèm `structuredContent.kind = "image"`. Server này **không** đọc chữ
trong ảnh: không OCR, không heuristic. Người gọi (model) nhìn tấm ảnh.

Đó là lựa chọn có chủ đích chứ không phải thiếu sót. Nhét một lớp OCR cộng suy đoán vào đây sẽ đưa
đúng thứ server này tồn tại để tránh — phán đoán về nội dung nghiệp vụ — vào một thành phần dùng
chung cho mọi sản phẩm. Ngược lại, từ chối ảnh cũng không được: giấy tờ ngành tài chính lưu hành rất
nhiều dưới dạng scan, kể cả bản PDF có chữ ký số của Bộ Tài chính cũng là ảnh từng trang không có
lớp text, nên "chỉ nhận .xlsx/.docx" nghĩa là từ chối một phần đáng kể hồ sơ thật.

Giới hạn: 4 MB cho một khối ảnh (`documents.MAX_IMAGE_BYTES`). Quá ngưỡng thì báo rõ kích thước và
đề nghị gửi bản nhẹ hơn, không cắt ảnh làm đôi rồi trả về một nửa biểu. `read_table` gọi trên một
ảnh bị từ chối kèm câu chỉ sang `read_document`.

**PDF thì chưa.** Render trang PDF thành ảnh cần một thư viện ngoài, mà server này cố ý chỉ dùng
stdlib (xem mục dưới). Đây là quyết định phụ thuộc, không phải việc bỏ quên — hiện PDF bị từ chối
với thông điệp về media type.

## History

This server originally lived under a specific product and carried a third tool that recognized
that product's own domain-specific rows by a hardcoded vocabulary. That tool, and the vocabulary
it hardcoded, moved to the business server that actually owns that domain — recognizing
domain-specific rows is business logic, not document parsing. `read_table` is what replaced it
here: the same fuzzy-matching mechanism, minus the vocabulary, so it can serve any caller's
domain rather than one product's. This server itself now carries no product name, no business
vocabulary, and no assumption about what the documents it reads are for.

## Env vars

| Var | Default | Meaning |
|---|---|---|
| `DOCUMENT_S3_ENV_PREFIX` | `S3` | Prefix of the variables holding the S3 connection (`<P>_ENDPOINT`, `_BUCKET`, `_ACCESS_KEY`, `_SECRET_KEY`, …). The default is the shared `S3_*` set; retired names: docs/architecture/environment-settings.md. |
| `DOCUMENT_S3_PREFIX` | empty | Key prefix documents live under (EXAMPLE: `example-agentic-attachments/`). |
| `DOCUMENT_SOURCE_DIR` | unset | Read from this directory instead (tests, dev). |
| `DOCUMENT_READERS_GRANT_TTL_SECONDS` | `300` | How long a `resources/read` grant stays valid after a tool call mints it. |
| `DOCUMENT_READERS_RESULT_CHARS` | `24000` | Largest result, in characters (floor 4,000). Keep it under the calling runtime's tool-result budget. |

## Error diagnostics

The server always writes one JSON `call.done` line to stderr per executed call. An error line
includes `rpcId`, `method`, tool `label`, document/sheet and page coordinates when supplied,
plus `error.type`, optional `error.code`, `error.traceback` (file/line/function) and chained
`error.causes`. `error.message` is present only for a refusal that does not quote the document;
a refusal that repeats cells (header not matched) logs its `error.code` and `error.rows` (row
numbers) instead, and an unexpected exception logs no message at all, because its text can carry
a cell value. The model still receives the full refusal text. This includes handled
`ToolInputError` results (`isError: true`), not only exceptions escaping a worker. `mcp.failed`
includes the same exception details for HTTP dispatch failures; `call.abandoned` records the wait
timeout and call context.

Every request answered without entering the worker pool writes one `call.refused` line:
`reason` (`busy`, `unknown_tool`, `unauthorized`, `origin_refused`, `host_not_allowed`,
`not_found`, `method_not_allowed`, `length_required`, `body_too_large`, `parse_error`,
`invalid_request`, `framing` for errors raised by the HTTP layer itself such as 501), `status`,
`method`, `path` (no query string), and `rpcId`/`tool`/page coordinates when the request was parsed.

Diagnostics are captured before JSON-RPC conversion and stay in server logs. No full tool
arguments, document rows, source lines or frame locals are dumped; messages are bounded and
known environment credentials, Bearer tokens and signed URL queries are redacted. Successful
calls retain compact metadata. Existing tool-error/JSON-RPC behavior is unchanged.

After syncing source, restart the reader process (or rebuild its container). Match the failed
`call.done` by `rpcId`/local `id` and timestamp, then inspect its `error` object. A reader error
alone does not prove the cause of a later backend SSE `internal` error: also inspect the backend
turn failure for that turn ID. Regression checks: `python3 selftest_diagnostics.py`,
`python3 selftest.py`, and from the repository root `npm run mcp:documents:test`.

## Files

| File | What it is |
|---|---|
| `http_server.py` | Streamable HTTP: `POST /mcp`, `/healthz`, `/readyz`. Logs on stderr. |
| `diagnostics.py` | Bounded exception/cause traceback and allowlisted page context for server logs. |
| `session.py` | Process services and the dispatcher `http_server.py` and the in-process checks share. |
| `protocol.py` | Dispatch for `initialize` / `server/discover` / `ping` / `tools/*` / `resources/*`, result envelopes, JSON-RPC error codes. |
| `tools.py` | Document/table handlers and bounded paging; each mints its result's grant via `grants.py`. |
| `tool_catalog.py` | Public tool schemas and the registry. |
| `cell_tools.py` | `read_cells`: A1 ranges, original formulas and cached values. |
| `grants.py` | The capability-based `resources/read` store: random URIs, TTL, indistinguishable denial. See "Resources" above. |
| `documents.py` | Seam: picks the xlsx/docx reader, shapes `read_document`'s bounded preview. |
| `xlsx_reader.py` | `.xlsx` via `zipfile` + `xml.etree.ElementTree` — shared strings, inline strings, cell refs, no third-party dependency. |
| `docx_reader.py` | `.docx` via the same approach — paragraphs and tables. |
| `tables.py` | `read_table`'s generic mechanism: header-synonym matching, cell coercion, `skipped` reasons — no business vocabulary. |
| `backend.py` | Reads a document by id — object storage or `DOCUMENT_SOURCE_DIR` — through a bounded cache. |
| `s3_source.py` | The signed S3 GET (SigV4, stdlib only) and its configuration. |
| `selftest_s3.py` | Object-storage checks for `selftest.py`, against a recording stand-in. |
| `errors.py` | Shared exception types and how each one is supposed to surface on the wire. |
| `fixtures.py` | Generates `.xlsx`/`.docx` bytes with `zipfile`, for `selftest.py` only. |
| `wire_client.py` | Spawns `http_server.py` and posts JSON-RPC to `/mcp`, plus the PASS/FAIL recorder. |
| `selftest.py` | The gate. Run it after any change. |
| `selftest_grants.py` | The grant-store security checks (see "Resources" above), split out of `selftest.py`. |
| `selftest_files.py` | Formula/cache/shared-formula and Word-table paging checks over HTTP. |

Support checks are split by topic; `selftest.py` remains the single gate.

## Đóng gói cùng agent và dữ liệu công thức

EXAMPLE và Sample App gọi bộ đọc này bằng Streamable HTTP (`office-docs` trong `mcp-servers.yaml`).
Mỗi sản phẩm chạy một deployment riêng, cùng kho S3, khóa chỉ đọc, token `DOCUMENT_READERS_TOKEN`.
Resource URI ký bằng token đó nên replica nào cũng phục vụ được URI do replica khác cấp.

`read_document` và `read_table` giữ hợp đồng cũ. Tool đọc mới `read_cells(documentId, sheet, range)`
trả từng địa chỉ A1, `value` và `formula`; theo `nextOffset` để đọc hết vùng. Giá trị là cache
trong file, không phải kết quả server tính lại. `hasCachedValue` phân biệt giá trị chưa lưu
với số 0. Shared formula giữ `sharedIndex`, `sharedFormula` (ô gốc/công thức/vùng); công thức
ô theo sau không bị tự dịch hoặc đoán. Preview cũng có `formulas` cho các hàng đang đọc.

Word preview có cả `tableRows`; `nextTableOffset` tiếp tục riêng phần bảng. Ảnh giữ nguyên
bytes trong MCP `image` block. Adapter MCP đổi nó sang `ToolCompletedResponse.images`; core
giữ trong journal và `ChatMessage.images`, adapter model gửi dạng image part/data URL.
Base64 không được chèn thành text hoặc OCR. Model/route phải hỗ trợ ảnh; không tự đổi model.
Giới hạn ảnh: 4 MiB mỗi ảnh, 16 MiB tổng một kết quả, tối đa 8 ảnh. Giới hạn văn bản vẫn áp dụng riêng.
Nếu provider không có phép đo context, core dự trù 2048 token mỗi ảnh ở quy đổi mặc định; đây là ước lượng,
không phải số token thực tế của mọi model.

Định dạng hiện hỗ trợ: `.xlsx`, `.docx`, ảnh. `.xls`, `.doc`, PDF và macro không được đọc bằng
reader này; server báo loại không hỗ trợ, không nhận rồi dựng nội dung thay thế.
