# ADR 0001: Microkernel with owned plugin capabilities

Status: accepted

The runtime must support multiple products and providers without allowing extensions to replace security or durable execution invariants

The kernel owns the turn loop, security spine, budgets, admission and lifecycle. Plugins supply typed capabilities through explicit manifests, staged activation, owned registration and reverse disposal. Ports and adapters isolate infrastructure. Composition selects trusted implementations

This retains Cordis-inspired lifecycle ideas while avoiding an everything-is-a-plugin runtime. A plugin can be removable; tenant checks, tool authorization and durable continuation cannot be optional

The tradeoff is a deliberate boundary: new invariant behavior requires kernel review, while provider and product behavior can evolve independently
