import type { ContextCompactionAssessment, ContextCompactionPolicy } from "@0xsyncroot/contracts";

export type ContextCompactionMode = "off" | "auto";

export interface ConfiguredContextCompactionPolicyOptions {
  readonly mode?: ContextCompactionMode;
  readonly thresholdRatio?: number;
  readonly retainRatio?: number;
  readonly estimatedCharsPerToken?: number;
  readonly revision?: string;
}

function ratio(name: string, value: number): number {
  if (!Number.isFinite(value) || value <= 0 || value >= 1) throw new Error(`${name} must be greater than 0 and less than 1`);
  return value;
}

function positive(name: string, value: number): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive`);
  return value;
}

/** Runtime-wide pressure policy; exact capacity is supplied by the resolved adapter route. */
export class ConfiguredContextCompactionPolicy implements ContextCompactionPolicy {
  readonly #mode: ContextCompactionMode;
  readonly #thresholdRatio: number;
  readonly #retainRatio: number;
  readonly #estimatedCharsPerToken: number;
  readonly #revision: string;

  constructor(options: ConfiguredContextCompactionPolicyOptions = {}) {
    this.#mode = options.mode ?? "auto";
    this.#thresholdRatio = ratio("thresholdRatio", options.thresholdRatio ?? 0.8);
    this.#retainRatio = ratio("retainRatio", options.retainRatio ?? 0.16);
    this.#estimatedCharsPerToken = positive("estimatedCharsPerToken", options.estimatedCharsPerToken ?? 3);
    if (this.#retainRatio >= this.#thresholdRatio) throw new Error("retainRatio must be less than thresholdRatio");
    this.#revision = options.revision?.trim() || "context-pressure-v1";
  }

  assess(input: Parameters<ContextCompactionPolicy["assess"]>[0]): ContextCompactionAssessment {
    const thresholdRatio = this.#thresholdRatio;
    const retainRatio = this.#retainRatio;
    const charsPerToken = positive("estimatedCharsPerToken", input.estimatedCharsPerToken ?? this.#estimatedCharsPerToken);
    const maxContextChars = input.contextWindowTokens
      ? Math.floor(positive("contextWindowTokens", input.contextWindowTokens) * charsPerToken)
      : input.fallbackMaxContextChars;
    const thresholdChars = Math.floor(maxContextChars * thresholdRatio);
    const shouldCompactForPressure = input.measuredContextTokens !== undefined && input.contextWindowTokens !== undefined
      ? input.measuredContextTokens >= Math.floor(input.contextWindowTokens * thresholdRatio)
      : input.measuredContextChars >= thresholdChars;
    return {
      trigger: input.trigger,
      providerId: input.providerId,
      modelId: input.modelId,
      measuredContextChars: input.measuredContextChars,
      maxContextChars,
      targetContextChars: Math.max(1, Math.floor(maxContextChars * retainRatio)),
      shouldCompact: input.trigger === "manual" || (this.#mode === "auto" &&
        (input.trigger === "context-overflow" || shouldCompactForPressure)),
      policyRevision: this.#revision,
      ...(input.measuredContextTokens !== undefined ? { measuredContextTokens: input.measuredContextTokens } : {}),
      ...(input.contextWindowTokens !== undefined ? { maxContextTokens: input.contextWindowTokens } : {}),
      ...(input.measurementRevision ? { measurementRevision: input.measurementRevision } : {}),
    };
  }
}
