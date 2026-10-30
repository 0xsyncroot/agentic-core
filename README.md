# Agentic Core

A TypeScript microkernel for embedding agents in products, with a complete execution harness, HTTP/SSE delivery and an embeddable chat widget

The kernel owns execution and security invariants. Plugins provide capabilities; adapters connect model providers, storage and external tools. The CLI and web demo use this same runtime

## Quick start

Requires Node.js 22 or newer and npm. Python 3 is needed for document-reader tests; optional service dependencies are described in [verification](docs/verification.md)

```sh
npm ci
npm run build
npm run harness -- "Confirm that the runtime is working"
```

With no provider credentials, the harness uses the deterministic Echo adapter. This verifies wiring and execution, not model quality

Copy `.env.example` to `.env`, then run `npm run web` and open `http://127.0.0.1:3400`. The template explicitly enables a loopback development identity. The widget example is at `/widget-demo/`

For a real model, set `AGENTIC_LLM_PROVIDER=deepseek` and `DEEPSEEK_API_KEY` in `.env`. Keep credentials on the server. Both `npm run harness` and `npm run web` load that file

Typed judgments use the TypeSafe adapter and its pinned `jev-1.13.0` model. To enable it, set `AGENTIC_JUDGMENT_PROVIDER=typesafe` and `TYPESAFE_API_KEY`. The example environment leaves judgments disabled; the chat model remains independently configurable

## What is included

- Durable turns, append-only journals, session leases, idempotency and recovery
- Plugin activation, typed capabilities, immutable runtime snapshots and catalog generation pinning
- Context budgets, compaction, retained tool results and structured work state
- Tool authorization, approvals, durable human interactions and scoped credentials
- Optional typed judgment providers with per-seam live or shadow modes
- Model adapters, MCP over HTTP/stdio, document readers and an isolated execution service
- Memory, relational/Redis persistence, telemetry, tracing and control-plane handlers
- A CLI harness, web chat and reusable widget

## Repository layout

| Directory | Responsibility |
| --- | --- |
| `packages/contracts`, `packages/plugin-sdk` | Stable data, ports and plugin lifecycle |
| `packages/core` | Execution and security invariants |
| `packages/plugins-base` | Replaceable, product-neutral capabilities |
| `packages/adapter-*`, `packages/persistence-*` | Provider, protocol and storage implementations |
| `packages/agent-api`, `packages/control-api` | Conversation delivery and separate administration handlers |
| `apps/harness` | Composition, catalog mounts and CLI |
| `apps/web`, `apps/widget` | Web demonstration and embedding |
| `mcp-servers`, `skills`, `deploy` | Optional services, workflow instructions and local infrastructure |

Start with the [architecture](specs/agentic-core-architecture.md), [code map](docs/architecture/code-organization.md) and [extension guide](docs/architecture/extension-guide.md)

This repository provides reusable infrastructure and a development demo. A production deployment still needs its own identity integration, authorization policy, secret management, service topology and operational validation. No live-model quality or production certification is implied by the offline test suite

## Read-only Web3 example

The [Web3 sample](examples/web3/README.md) connects a single chain-snapshot MCP tool to the full harness. Run it with `npm run demo:web3` after configuring the model and RPC endpoint
