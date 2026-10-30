/**
 * Response schemas for the JSON `/api/*` routes, so Fastify's `fast-json-stringify` actually
 * engages instead of Fastify's router running with none of its speed. Deliberately uneven: a
 * route whose payload shape is small and fully enumerable here (`/api/health`, `/api/runtime`,
 * `/api/chat/cancel`) gets a strict schema and the full serialization win. A route whose payload
 * is genuinely open-ended — `resultPayload()`'s `ui`/`work`/`approval`/`interaction`, or a
 * projected session message's own narrations/approval/interaction/work/ui — gets only its stable
 * top-level envelope typed; every field whose shape can evolve independently of this file is left
 * as `{}` (JSON Schema's "no constraint"), which `fast-json-stringify` serializes through its
 * plain-`JSON.stringify` fallback for that one subtree rather than dropping anything it was not
 * told about. `fast-json-stringify` silently omits a property that is not in the schema when
 * `additionalProperties` is not `true` — that would be a worse bug than the one this migration is
 * fixing, so nothing here trades correctness for the speed win on a field this package does not
 * fully own the shape of.
 */

const STATUS_OK_SCHEMA = { type: "object", properties: { status: { type: "string" } }, required: ["status"] } as const;

export const HEALTH_RESPONSE_SCHEMA = { 200: STATUS_OK_SCHEMA } as const;
export const RUNTIME_RESPONSE_SCHEMA = {
  200: {
    type: "object",
    properties: { status: { type: "string" }, labels: { type: "object", additionalProperties: { type: "string" } } },
    required: ["status"],
  },
} as const;

export const CANCEL_RESPONSE_SCHEMA = {
  200: { type: "object", properties: { cancelled: { type: "boolean" } }, required: ["cancelled"] },
  202: { type: "object", properties: { cancelled: { type: "boolean" } }, required: ["cancelled"] },
} as const;

export const INTERJECT_RESPONSE_SCHEMA = {
  200: { type: "object", properties: { accepted: { type: "boolean" } }, required: ["accepted"] },
  202: { type: "object", properties: { accepted: { type: "boolean" } }, required: ["accepted"] },
} as const;

/** `resultPayload()`'s stable envelope (see result-payload.ts); every rich/nested field passes through unconstrained. */
const RESULT_PAYLOAD_PROPERTIES = {
  content: {}, sessionId: { type: "string" }, turnId: { type: "string" }, outcome: { type: "string" },
  replayed: { type: "boolean" }, approval: {}, interaction: {}, ui: {}, work: {}, metrics: {},
} as const;

export const CHAT_RESPONSE_SCHEMA = {
  200: { type: "object", properties: RESULT_PAYLOAD_PROPERTIES, required: ["content", "sessionId", "turnId", "outcome", "replayed", "metrics"] },
} as const;

/** `resumeApproval` returns the same `resultPayload()` shape `/api/chat` does. */
export const APPROVAL_RESPONSE_SCHEMA = CHAT_RESPONSE_SCHEMA;

/** `visibleMessages()`'s projection (see history-view.ts): only `sessionId` and the envelope array are typed; each message's own shape is left open for the same reason. */
export const SESSIONS_RESPONSE_SCHEMA = {
  200: {
    type: "object",
    properties: { sessionId: { type: "string" }, messages: { type: "array", items: {} } },
    required: ["sessionId", "messages"],
  },
} as const;

/** The one shape every error body takes (see error-mapping.ts's `PublicApiError`) — reused across every non-2xx status this binding's JSON routes can answer with. */
export const ERROR_RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    error: {
      type: "object",
      properties: { code: { type: "string" }, message: { type: "string" }, reason: { type: "string" }, detail: { type: "string" } },
      required: ["code", "message"],
    },
  },
  required: ["error"],
} as const;
