# apps/web

A development/demo harness for the neutral agent runtime `apps/harness` composes
(`createBlankRuntime`): a single Node HTTP server exposing `@0xsyncroot/agent-api`'s generic `/api/*`
handler, this app's own static widget-demo pages, and nothing product-specific. It carries no
product's business language, approval cards or MCP connectors of its own — a product backend
builds those on `packages/agent-api` directly, in its own
`http.createServer`, and does not use this app at all.

Use this to try the runtime locally or to serve the widget demo pages; it is not a deployable
product backend and ships no production-hardening of its own beyond what `@0xsyncroot/harness` already
enforces (see the root architecture specification for runtime-level guarantees).

## Running

Copy the root `.env.example` to `.env` first. The template explicitly enables a loopback development identity

```sh
npm run build
npm run web
```

## Environment

| Variable | Required | Notes |
| --- | --- | --- |
| `AGENTIC_WEB_HOST` | no (default `127.0.0.1`) | A non-loopback host also requires `AGENTIC_WEB_ALLOW_REMOTE=true` and `AGENTIC_WEB_BEHIND_TLS_PROXY=true`. |
| `AGENTIC_WEB_PORT` | no (default `3400`) | Integer, 1–65535. |
| `AGENTIC_WEB_ALLOW_REMOTE` | only with a non-loopback host | See above. |
| `AGENTIC_WEB_BEHIND_TLS_PROXY` | only with a non-loopback host | Asserts a TLS-terminating proxy sits in front of this process; it does not add TLS itself. |
| `AGENTIC_WEB_AUTH_SECRET` | required in production, or for any remote listener | HMAC secret for `HmacIdentityResolver`. Without it, `AGENTIC_WEB_UNSAFE_LOCAL_IDENTITY=true` must be set instead. |
| `AGENTIC_WEB_AUTH_ISSUER` / `AGENTIC_WEB_AUTH_AUDIENCE` | no | Defaults to `agentic-control-plane` / `agentic-web`. |
| `AGENTIC_WEB_UNSAFE_LOCAL_IDENTITY` | see `AGENTIC_WEB_AUTH_SECRET` | A static, unauthenticated identity for a loopback-only development session. Never set this in production; `main.ts` refuses to start a production profile without `AGENTIC_WEB_AUTH_SECRET` regardless. |
| `AGENTIC_WEB_ALLOWED_ORIGINS` | no | Comma-separated CORS allowlist. |
| `AGENTIC_WEB_ALLOW_CREDENTIALS` | no | `"true"` to allow credentialed cross-origin requests. |
| `AGENTIC_MCP_STDIO_ALLOWLIST` | no | See below. |

Everything `@0xsyncroot/harness`'s `createBlankRuntime` itself reads (model provider, persistence,
`AGENTIC_MCP_SERVERS` or its file form `AGENTIC_MCP_CONFIG_FILE`, and so on) applies here unchanged; this
file only adds the small set above.

### `AGENTIC_MCP_STDIO_ALLOWLIST` is a development/demo affordance, not a production control

This is the one environment variable here that can change what a process is allowed to spawn: a
comma-separated list of absolute paths, validated fail-closed (no shell metacharacters), passed as
`mcpStdioCommandAllowlist` to `createBlankRuntime`. It exists only because this app is a *generic*
harness that does not know in advance which stdio MCP command a given local run will be pointed
at, so something has to name it, and that something is the environment.

A deployed product should select a fixed allowlist from the binaries shipped in its own image.
Its environment must not be able to widen that execution boundary. Keep this demonstration
setting local to the development harness
