# MCP connectors and authorization

## Three independent security boundaries

1. Host to agent API: authoritative tenant, actor, session and permissions
2. Agent to MCP server: connector authentication and tool policy
3. MCP server to downstream service: downstream authorization and credential custody

A token valid at one boundary is not automatically valid at another. Forwarding user credentials requires a declared verifier and audience/issuer binding. Service credentials stay server-side; delegated credentials require a user-bound authorization flow

## Discovery and execution

The adapter normalizes remote tools while preserving provenance. Composition supplies required permissions, risk overrides, timeouts and resource bounds. Tools cannot authorize themselves through descriptions or returned text. Missing required connectors fail closed according to configuration; optional connectors can be omitted explicitly

HTTP configuration can declare attachment storage separately from the file service. Archive credentials never travel to that service. Document URI schemes and elicitation URL origins must be bounded by trusted configuration

## Stdio

Stdio starts a process under deployment authority. The executable must be on an explicit allowlist; only approved environment names reach the child. Do not treat a configurable command as ordinary untrusted user input. The demo accepts a deliberately constrained allowlist; a deployed product should select known binaries from its own image

## Durable interaction

An input-required response suspends work at the tool boundary. Resume validates the interaction identity, response shape and current authority. Sequential interactions are supported without turning browser events into execution state

External authorization happens at the connector/control plane. The browser returns an accepted/declined/cancelled outcome, not OAuth credentials. Production flows need state/PKCE where appropriate, authoritative user binding, encrypted credential storage, rotation/revocation and egress controls

## Bundled services

`mcp-servers/document-readers` supplies document inspection. `mcp-servers/agent-execution` supplies optional isolated execution. Their deployment templates, authentication and dependencies are independent of the basic Echo/DeepSeek chat demo. See each service's README before enabling it
