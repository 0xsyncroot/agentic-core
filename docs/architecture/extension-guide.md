# Extension guide

## Add a capability without widening the kernel

Define stable data and ports in `contracts` only when multiple implementations need the contract. Add typed capability tokens and lifecycle requirements in `plugin-sdk` when appropriate. Implement provider/protocol details in an adapter and register its descriptor explicitly in the harness composition

Use [the Echo adapter](../../packages/adapter-echo/src/index.ts) as a small executable plugin example. A manifest declares identity, version, artifact, requirements, capabilities and permissions. Activation registers owned capabilities; disposal releases their resources. Importing a module must not activate it

## Model adapters

Implement `LlmAdapter`, including model metadata and normalized stream events. Preserve tool-call/result pairing, cancellation, usage and provider-state semantics. Keep provider dialects inside the adapter. Constructor configuration supplies credentials and settings; adapters do not read deployment environment directly

Context limits must come from explicit configuration, trusted provider metadata or documented adapter metadata. A generic gateway has no universal model default. Do not invent a limit for an unknown model

## MCP and tools

Keep business logic in its owning service. Configure transport, authentication, required permissions, risk overrides, bounded results and timeouts in composition. Tool descriptions explain input/output contracts; they cannot grant permissions. HTTP and stdio have distinct credential and process boundaries; see [MCP connectors](mcp-connectors.md)

Use structured tool facts/notices for execution evidence. Avoid hardcoded branches for individual skill/tool identifiers in the kernel. Preserve readable retained results so later steps can request the specific missing evidence without repeating an entire workflow

## Profiles and skills

Profiles select product-facing instructions and available capabilities. Skills describe a workflow in prose and state their routing scope clearly. Keep executable examples in tool descriptions or tests. Catalog generations allow profiles and capabilities to evolve while existing turns remain pinned to the generation they acquired

## Persistence

Implement contract semantics for scope, ordering, leases, idempotency, integrity and deletion before optimizing the storage engine. Use the memory adapter as a behavioral reference and the relational adapter tests as conformance examples. Database integration tests require isolated test databases and explicit configuration

## Delivery and verification

Resolve authoritative identity before entering the runtime. Browser state is input, not permission. Put HTTP behavior in `agent-api`; put browser rendering in the widget. Keep administration in a separate composition using `control-api`

Before merging an extension, build its exported packages, run affected regressions and all repository checks, then obtain an independent review. Runtime termination changes require replay comparison. Judgment or model-policy changes require live labeled evaluation before enabling the changed behavior
