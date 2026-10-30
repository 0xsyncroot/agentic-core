# ADR 0003: Durable human interaction at the tool boundary

Status: accepted

Tools can need user input or external authorization after execution has begun. An ephemeral UI callback cannot safely represent this state

The runtime records a durable pending interaction tied to its invocation and authorized session. Validated responses resume that invocation. Approval retains its distinct semantics while delivery exposes a consistent interaction route

Forms are bounded and reject sensitive credential/payment fields. External authorization stays with the connector; chat carries an outcome rather than credentials. Presentation events and private reasoning are not execution state

Sequential interactions are supported. Concurrent reviewer quorum and arbitrary credential collection are outside this contract. Production OAuth still requires a properly secured connector/control plane
