# Contributor and coding-agent instructions

Read the [architecture](specs/agentic-core-architecture.md), [code organization](docs/architecture/code-organization.md) and [extension guide](docs/architecture/extension-guide.md) before changing boundaries

## Architecture

This is a microkernel. `core` owns the turn loop, runtime snapshots, security spine, admission, leases, durable lifecycle and budgets. Identity is resolved in delivery before entering the kernel. `contracts` and `plugin-sdk` define ports and lifecycle. Plugins register owned capabilities explicitly; adapters implement concrete providers. The harness is the composition root

Keep product policy and user-facing business copy in the consuming product. Shared mechanisms must not branch on a particular skill/tool identifier. Security invariants cannot live in removable plugins or prompts

## Implementation conventions

- Use English in shared code, comments and documentation. Localized regression fixture data may retain its original language
- Explain invariants and reasons in comments, not incident chronology, review rounds or owner quotations
- Read environment settings in composition/delivery and inject adapter configuration. Existing exceptions are persistence migration CLIs and filtered MCP stdio environment forwarding
- Do not register plugins as an import side effect
- Skills are prose; executable examples belong in tool descriptions or tests
- Use structured facts/notices as evidence. Do not classify a model answer with regex or add a heuristic for a single fixture
- Keep source modules within the enforced line limit. `apps/widget/src/core/widget.ts` may only shrink; add new logic in focused modules
- Keep each commit focused on one coherent change

## Workflow

1. Locate ownership and read relevant code with Codegraph before text search when an index is available
2. Reproduce the behavior using execution or journal evidence; distinguish facts, assumptions and unknowns
3. Obtain an independent agent's design audit before implementation, giving it code and evidence rather than a prescribed conclusion
4. Change the mechanism at its owning layer. Include the failing case, another case of the same class and a meaningful negative case where appropriate
5. Build affected packages before tests: workspace exports load `dist`
6. Obtain an independent final audit of the diff and decisive checks. Resolve P0/P1 findings before declaring completion

Changes to turn termination in `core/src/agent` or `plugins-base/src/audit` require `turn-end-replay` and a baseline comparison. Changes to judgment questions, routing instructions or live policy require labeled real-provider evaluation with difficult negative cases before enabling the behavior. Do not silently substitute offline mocks for that evidence

## Completion checks

Run `npm run check` and the relevant test suite. Preserve architecture, docs, environment and test-reachability gates; do not remove assertions or add unexplained exceptions to make extraction pass. Update the architecture specification when runtime behavior changes. Update the dependency table and executable policy together. Record hard-to-reverse decisions in an ADR

State any unrun service integration or live-model checks explicitly
