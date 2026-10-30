# ADR 0004: Administration outside the agent API

Status: accepted

Conversation review and catalog management have a different authority boundary from ordinary tenant conversation requests

Reusable handlers live in `control-api` and depend only on contracts. A consuming product supplies a separate administrative composition, identity and deployment. It does not import the kernel to bypass normal execution. Agent execution remains the owner of turn and journal writes

Review reads are scoped and audited. Administrative database roles use least privilege; catalog operations use their own explicit permissions. Shared catalog stores and harness generation mounts connect published configuration to runtime assembly

The public repository includes these mechanisms, not a complete hosted administration product or its identity provider
