# Host integration

## Authority boundary

The host backend authenticates the user and narrows tenant, actor, permissions and allowed agent profiles. The browser receives a short-lived ticket; it never receives the signing secret or provider credentials. The agent API verifies the ticket before entering the runtime

The reference HMAC resolver expects HS256 JWTs with `iss`, `aud`, `sub`, `tenantId`, `actorId`, `permissions`, `grantRevision`, `agentProfileIds`, `iat` and `exp`. Optional claims include `roles`, string-valued trusted `context`, `assurance` and `nbf`. The reference lifetime limit is 300 seconds. Check [the resolver](../../packages/agent-api/src/identity-resolvers.ts) when implementing a host ticket service

Keep the signing key at least 32 bytes and server-side. Issuer/audience must match the agent deployment. The host resolves permissions from authoritative state rather than copying values from a browser request

## Browser integration

Provide `connection.headers` as a callback that obtains a valid host-issued ticket. Refresh through the host session without embedding long-lived secrets. Reset the widget's session and local presentation state when the user or tenant changes

Page context and `contextProvider` values are untrusted application context. They cannot override ticket claims. Labels, welcome text and host interaction hooks control presentation only

## Deployment

The bundled loopback demo can explicitly enable `AGENTIC_WEB_UNSAFE_LOCAL_IDENTITY=true`. Remote listeners require authenticated delivery and declared TLS proxy termination. For a real host, configure allowed origins, credential policy, issuer/audience and the product's runtime-provider composition

Multiple replicas additionally require durable session storage, shared admission and a compatible resumable-stream strategy. Test lease contention, reconnect, expired tickets, changed grants, cross-tenant denial and pending-interaction recovery

## Host extensions

Use `onInteractionChange` and `answerInteraction` for forms the host can complete from a real user action. Use menu-toggle and badge APIs for product state, without bypassing server validation. Floating/docked layout and compact mode are presentation choices

Ship the matching widget bundle and generated declarations together. The raw intermediate bundle is not the embedding artifact. Avoid mixing assets from different builds
