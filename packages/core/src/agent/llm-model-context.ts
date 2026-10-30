import {
  AgenticError,
  type ChatMessage,
  type LlmAdapter,
  type LlmContextMeasurement,
  type ResolvedLlmModel,
  type ToolSchema,
} from "@0xsyncroot/contracts";

/**
 * What one image counts for in the context budget: 2048 tokens at three characters a token.
 *
 * A provider counts an image by its pixels, never by its base64 length: screenshots of very different byte sizes cost about
 * the same tokens (docs/incidents/2026-10-12-core-image-cost.md). Counted by that length,
 * one screenshot would claim a third of a large window and push out results the model still needs. The reserve is an
 * upper bound over the image token costs providers publish; a provider measurement (`measureContext`) wins. What an
 * image's bytes do cost is time on every request that carries it, which the projector bounds by not sending an
 * earlier turn's images again.
 */
export const IMAGE_CONTEXT_CHARS = 6_144;

/**
 * Serialized characters of `value`, each image counted as `imageChars` instead of its base64.
 *
 * Pass 0 for a size to set against the tokens a provider counted: those include the image's real cost, which is far below
 * the reserve, and a reserve in the characters would read as text much lighter than it is.
 */
export function modelContextSize(value: unknown, imageChars = IMAGE_CONTEXT_CHARS): number {
  return JSON.stringify(value, (key, item: unknown) => key === "images" && Array.isArray(item) &&
      item.every((entry: unknown) => entry && typeof entry === "object" && "mediaType" in entry && "data" in entry)
    ? item.map(() => " ".repeat(imageChars)) : item).length;
}

function positiveInteger(name: string, value: number | undefined): void {
  if (value !== undefined && (!Number.isInteger(value) || value <= 0)) {
    throw new AgenticError("validation", `${name} must be a positive integer`);
  }
}

/** Resolve and validate the exact adapter route; a provider may not silently substitute a model. */
export async function resolveLlmModel(llm: LlmAdapter, signal: AbortSignal): Promise<ResolvedLlmModel> {
  const fallback: ResolvedLlmModel = {
    providerId: llm.providerId ?? llm.id,
    adapterId: llm.id,
    modelId: llm.model,
    routeRevision: `adapter:${llm.id}:${llm.model}`,
    metadataSource: "fallback",
    estimatedCharsPerToken: 3,
  };
  const resolved = await llm.resolveModel?.(signal) ?? fallback;
  if (resolved.adapterId !== llm.id || resolved.providerId !== (llm.providerId ?? llm.id) || resolved.modelId !== llm.model) {
    throw new AgenticError("validation", `LLM adapter ${llm.id} resolved a route different from its mounted capability`);
  }
  if (!resolved.routeRevision.trim()) throw new AgenticError("validation", "Resolved LLM route requires a revision");
  positiveInteger("contextWindowTokens", resolved.contextWindowTokens);
  positiveInteger("maxOutputTokens", resolved.maxOutputTokens);
  if (resolved.estimatedCharsPerToken !== undefined &&
      (!Number.isFinite(resolved.estimatedCharsPerToken) || resolved.estimatedCharsPerToken <= 0)) {
    throw new AgenticError("validation", "estimatedCharsPerToken must be positive");
  }
  return Object.freeze({ ...resolved });
}

export async function measureLlmContext(input: {
  readonly llm: LlmAdapter;
  readonly model: ResolvedLlmModel;
  readonly messages: readonly ChatMessage[];
  readonly tools: readonly ToolSchema[];
  readonly signal: AbortSignal;
}): Promise<{ readonly serializedChars: number; readonly measurement: LlmContextMeasurement }> {
  const serializedChars = modelContextSize({ messages: input.messages, tools: input.tools });
  const measured = await input.llm.measureContext?.({
    model: input.model,
    messages: input.messages,
    tools: input.tools,
    parameters: input.llm.defaultParameters ?? {},
  }, input.signal);
  if (measured) {
    if (!Number.isInteger(measured.inputTokens) || measured.inputTokens < 0 || !measured.revision.trim()) {
      throw new AgenticError("validation", `LLM adapter ${input.llm.id} returned an invalid context measurement`);
    }
    return { serializedChars, measurement: Object.freeze({ ...measured }) };
  }
  const charsPerToken = input.model.estimatedCharsPerToken ?? 3;
  return {
    serializedChars,
    measurement: {
      inputTokens: Math.ceil(serializedChars / charsPerToken),
      method: "estimate",
      revision: `serialized-chars-v1:${charsPerToken}`,
    },
  };
}
