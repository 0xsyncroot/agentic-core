# Verification

## Offline checks

```sh
npm ci
npx playwright-core install chromium
npm run check
npm run build
npm run test:shared
```

`npm test` runs the same check/build/shared-test sequence. The browser layout tests require the Chromium download above. On Linux, install the browser system libraries reported by Playwright if they are missing. Shared tests include the kernel, plugin lifecycle, adapters, HTTP/SSE, catalog generations, widget and document-reader service. Legacy `.xls` tests need `xlrd==2.0.2`, matching the document-reader Dockerfile; use a dedicated Python virtual environment

Package exports point to `dist`, so build before running focused tests. A passing source-only test can otherwise coexist with stale compiled dependencies

## Optional integration profiles

| Command | External prerequisite |
| --- | --- |
| `npm run test:mysql` | Isolated MySQL test database |
| `npm run test:postgres` | Isolated PostgreSQL test database |
| `npm run test:sqlserver` | Isolated SQL Server test database |
| `npm run mcp:execution:test` | Execution gateway dependencies |

Execution-image integration is a separate manual profile documented with that service. The test-reachability gate keeps these distinctions explicit; a skipped database test is not proof of that database integration

## Runtime and live-model evidence

Run the CLI and web chat through the full harness. Echo verifies wiring without credentials. For DeepSeek, configure a server-side key and select the provider explicitly

Judge success from structured outcomes, journal events, tool observations and actual interaction behavior. Do not grade model prose with regex. Record the provider/model, scenario, outcome and relevant limitations without writing credentials or private conversation content

Termination changes require `packages/core/test/turn-end-replay.test.ts` and a comparison with the baseline. Judgment questions, thresholds and policy changes require labeled live evaluation with negative cases before activation. A successful chat response alone does not validate the whole architecture
