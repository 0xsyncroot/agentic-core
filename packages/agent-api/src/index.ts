export {
  applyResponseHeaders,
  createAgentApiHandler,
  type AgentApiHandler,
  type AgentApiOptions,
  type AgentApiRuntime,
} from "./agent-api-handler.js";
export {
  publicApiError,
  publicMessage,
  publicStatus,
  type BusinessMessages,
  type PublicApiError,
} from "./error-mapping.js";
export {
  applyCorsHeaders,
  createOriginPolicyResolver,
  rejectsApiOrigin,
  respondToPreflight,
  type ResponsePolicy,
  type WebApplicationOptions,
} from "./cors-policy.js";
export {
  cancelInput, chatInput, interjectInput, AGENT_PROFILE_PATTERN, MAX_INTERJECTION_CHARS, REQUEST_PATTERN, SESSION_PATTERN,
  type ChatInputOptions, type ValidChatInput,
} from "./chat-input.js";
export { readJsonBody } from "./request-body.js";
export {
  HmacIdentityResolver,
  StaticDevelopmentIdentityResolver,
  resolveRequestIdentity,
} from "./identity-resolvers.js";
export {
  readInteractionInput,
  resolveInteraction,
  type ApprovalInteractionInput,
  type HumanInteractionInput,
  type PublicInteractionCallbacks,
  type PublicInteractionInput,
} from "./interaction-api.js";
export { resumeApproval } from "./approval-api.js";
export { visibleMessages } from "./history-view.js";
export { type ToolTraceCall, type ToolTraceLabeller, PublicAgentStreamWriter } from "./public-agent-stream.js";
export { type PublicReasoningMode, type ReasoningSummarizer } from "./public-reasoning-stream.js";
export { createReasoningSummarizer } from "./reasoning-summarizer.js";
export {
  servePublicAgentStream,
  type PublicAgentStreamErrorOptions,
  type PublicAgentStreamOperationInput,
} from "./public-agent-stream-handler.js";
export {
  pipeResumableAgentStream,
  requestedLastEventId,
  resumableAgentOperationFingerprint,
  resumableAgentStreamFingerprint,
  resumableAgentStreamKey,
  type ResumableAgentStreamEvent,
  type ResumableAgentStreamKey,
  type ResumableAgentStreamObserver,
  type ResumableAgentStreamOperation,
  type ResumableAgentStreamRegistry,
} from "./resumable-agent-stream.js";
export { InMemoryResumableAgentStreamRegistry } from "./in-memory-stream-registry.js";
export { InterjectionQueue, MAX_PENDING_INTERJECTIONS, type RemoteInterjections, type ClosableInterjections } from "./interjection-queue.js";
export { resultPayload } from "./result-payload.js";
export {
  applicationContext, resolveIdentity, withRequestScope,
  type RequestScopeOptions,
} from "./request-context.js";
// Re-exported so a product needs no direct @0xsyncroot/plugins-base dependency of its own for the one
// piece of it a delivery-layer consumer actually needs: a generic PrincipalCredentialScope.
export { AsyncLocalPrincipalCredentialScope } from "@0xsyncroot/plugins-base";
export { acceptChatTurn, parseMultipartTurn, storeInlineAttachments, type AttachmentStore, type InlineAttachmentFile } from "./inline-attachments.js";
export { chatAttachments } from "./chat-input.js";

export { sessionHistoryEvents } from "./session-history.js";
export { sessionDirectory } from "./session-directory.js";
export { historyTimelines, supersededNarrationIds } from "./history-timeline.js";
