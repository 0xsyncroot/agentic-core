import type { ChatMessage, JsonValue, LlmToolChoice, PreparedLlmRequest, ResolvedLlmModel } from "@0xsyncroot/contracts";
import { sha256 } from "../hash.js";
import { toJsonValue } from "./json-value.js";

/** Most messages the manifest describes one by one; `messageCount` still counts them all. */
const MAX_MANIFEST_ENTRIES = 64;
/**
 * Hex digits of each message's sha256 the manifest keeps. Sixty-four bits tell a request's
 * messages apart and match one against the traced body; the full digest per line would make the
 * manifest, not the request, the largest part of the row.
 */
const MESSAGE_HASH_CHARS = 16;

function manifestEntry(message: ChatMessage): JsonValue {
  const toolCallIds = message.toolCalls?.map((call) => call.id) ?? (message.toolCallId ? [message.toolCallId] : []);
  return toJsonValue({
    role: message.role,
    ...(message.context?.provenance ? { provenance: message.context.provenance } : {}),
    ...(toolCallIds.length > 0 ? { toolCallIds } : {}),
    chars: JSON.stringify(message).length,
    sha256: sha256(message).slice(0, MESSAGE_HASH_CHARS),
  });
}

/** The rendered system prompt: the system messages the request opens with. */
function leadingSystemText(messages: readonly ChatMessage[]): string | undefined {
  const leading: string[] = [];
  for (const message of messages) {
    if (message.role !== "system") break;
    leading.push(message.content ?? "");
  }
  return leading.length > 0 ? leading.join("\n\n") : undefined;
}

/**
 * What the journal keeps of a request the model was sent: its identity and shape, not its body.
 *
 * Full requests were 91% of the journal's bytes, and every bounded read carried them again. The
 * body is available where it belongs — the tracing adapter captures it in full when enabled, and
 * `contentHash`, computed over the whole request exactly as before, is the key both sides share.
 * What stays is enough to audit a request from the journal alone: which prompt, which tools, which
 * choice and how it was enforced, and one line per message (role, provenance, the tool calls it
 * made or answers, its size and hash) — enough to see that every call was answered once. A
 * conversation longer than the manifest keeps its newest messages there.
 */
export function requestDigest(prepared: PreparedLlmRequest, details: {
  readonly modelRoute: ResolvedLlmModel;
  readonly requestedToolChoice: LlmToolChoice | undefined;
  readonly toolChoiceEnforcement: "provider" | "instruction" | "none";
}): Readonly<Record<string, JsonValue>> {
  const systemText = leadingSystemText(prepared.messages);
  return {
    requestId: prepared.requestId, attemptId: prepared.attemptId, turnId: prepared.turnId, stepId: prepared.stepId,
    runtimeSnapshotId: prepared.runtimeSnapshotId, model: prepared.model, contentHash: prepared.contentHash,
    systemHash: systemText === undefined ? null : sha256(systemText),
    toolsHash: sha256(prepared.tools),
    toolIds: prepared.tools.map((tool) => tool.name),
    messageCount: prepared.messages.length,
    messagesChars: JSON.stringify(prepared.messages).length,
    messageManifest: prepared.messages.slice(-MAX_MANIFEST_ENTRIES).map(manifestEntry),
    toolChoice: prepared.toolChoice === undefined ? null : toJsonValue(prepared.toolChoice),
    requestedToolChoice: details.requestedToolChoice === undefined ? null : toJsonValue(details.requestedToolChoice),
    toolChoiceEnforcement: details.toolChoiceEnforcement,
    parameters: toJsonValue(prepared.parameters),
    modelRoute: toJsonValue(details.modelRoute),
  };
}
