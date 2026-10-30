# Code organization

## Dependency boundaries

`scripts/check-architecture.mjs` is the executable dependency policy. Every workspace package must be classified; an unrecognized package fails the gate

| Layer | Allowed workspace dependencies |
| --- | --- |
| `contracts` | None |
| `plugin-sdk` | `contracts` |
| `env-settings` | None |
| `redis-connection` | `env-settings` |
| `core`, `plugins-base` | `contracts`, `plugin-sdk` |
| Adapters | `contracts`, `plugin-sdk`, `redis-connection`, `env-settings` |
| Persistence | `contracts`, `redis-connection`, `env-settings` |
| `agent-api` | `contracts`, `plugins-base` |
| `control-api` | `contracts` |
| `apps/harness` | Explicitly assembled workspace implementations |
| `apps/web` | Harness, contracts and shared delivery as allowed by the gate |
| `apps/widget` | Browser protocol client; no kernel dependency |

Change this table and the executable policy together when changing a boundary

## Reading path

Start with `apps/harness/src/composition/create-runtime.ts` and `runtime-dependencies.ts`. Follow capability contracts into `packages/core`, then inspect the provider implementation selected by composition. For dynamic configuration, read `composition/catalog/` and `runtime-mount.ts`. For the UI path, start with `apps/web/src/main.ts`, `packages/agent-api` and `apps/widget/src/public-api.ts`

## Where new code belongs

1. Business policy or copy belongs in the consuming product
2. A reusable external tool service belongs in `mcp-servers`
3. Workflow instructions belong in prose-based skills
4. Provider, protocol and storage mappings belong in adapters/persistence
5. Removable neutral prompts, tools and policies belong in `plugins-base`
6. Shared transport, identity and projection belong in `agent-api`
7. Wiring and environment reads belong in composition/delivery
8. Only invariants required by every composition belong in `core`

The widget's existing `core/widget.ts` may only shrink; new logic belongs in focused modules. Source files are limited to 300 lines except documented, checked exceptions. Tests keep localized and adversarial fixture data where needed, while shared implementation and comments use English

## Automated checks

`npm run check` runs architecture classification/import checks, documentation link checks, environment registry checks, test reachability and TypeScript compilation. Architecture checks also enforce neutral core identifiers, business-language boundaries, widget persona separation and timeless comments. Existing test-reachability logic follows scripts and fixture imports; optional integration profiles remain explicit
