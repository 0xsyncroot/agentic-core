import { AgenticError, type JudgmentPort } from "@0xsyncroot/contracts";
import { noticeOnce } from "@0xsyncroot/env-settings";
import type { JudgmentSeamMode, JudgmentSeamModes } from "@0xsyncroot/core";
import { TypeSafeJudgmentAdapter } from "@0xsyncroot/adapter-typesafe";

export type JudgmentProvider = "typesafe" | "none";

function optional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** Selects an explicit provider, then a configured TypeSafe provider, otherwise no judgment service. */
export function judgmentProvider(env: NodeJS.ProcessEnv): JudgmentProvider {
  return judgmentChoice(env).provider;
}

/** Explains provider selection without exposing configuration values. */
export function judgmentChoice(env: NodeJS.ProcessEnv): { readonly provider: JudgmentProvider; readonly reason: string } {
  const configured = optional(env.AGENTIC_JUDGMENT_PROVIDER)?.toLowerCase();
  if (configured === "typesafe" || configured === "none") {
    return { provider: configured, reason: "AGENTIC_JUDGMENT_PROVIDER names it" };
  }
  if (configured) throw new Error(`AGENTIC_JUDGMENT_PROVIDER must be typesafe or none, got "${configured}"`);
  if (optional(env.TYPESAFE_API_KEY)) return { provider: "typesafe", reason: "automatic: TYPESAFE_API_KEY is set" };
  return { provider: "none", reason: "automatic: no judgment key is set" };
}

/** The one startup line that says which judgment provider runs, why, and in which mode. Names settings, never values. */
export function describeJudgmentChoice(env: NodeJS.ProcessEnv): string {
  const { provider, reason } = judgmentChoice(env);
  const mode = judgmentShadow(env) ? "shadow (AGENTIC_JUDGMENT_MODE=shadow: asked and journaled, never acted on)" : "live";
  return `judgment provider: ${provider} (${reason}); mode: ${mode}`;
}

/** The judgment port the environment selects, or undefined when none is selected. A named provider without its key is a configuration error. */
export function createJudgmentPort(env: NodeJS.ProcessEnv): JudgmentPort | undefined {
  const provider = judgmentProvider(env);
  noticeOnce("judgment-provider", describeJudgmentChoice(env));
  if (provider === "none") return undefined;
  const apiKey = optional(env.TYPESAFE_API_KEY);
  if (!apiKey) throw new AgenticError("validation", "TYPESAFE_API_KEY is required for AGENTIC_JUDGMENT_PROVIDER=typesafe");
  const baseUrl = optional(env.TYPESAFE_BASE_URL);
  return new TypeSafeJudgmentAdapter({ apiKey, ...(baseUrl ? { baseUrl } : {}) });
}

/** AGENTIC_JUDGMENT_MODE=shadow: every seam asks and journals, and none changes a turn — for measuring a deployment. */
export function judgmentShadow(env: NodeJS.ProcessEnv): boolean {
  const mode = optional(env.AGENTIC_JUDGMENT_MODE)?.toLowerCase();
  if (mode !== undefined && mode !== "shadow") throw new Error(`AGENTIC_JUDGMENT_MODE must be shadow or unset, got "${mode}"`);
  return mode === "shadow";
}

/** Optional fallback model for skill relevance when the judgment provider gives no verdict. */
export function judgmentFallbackModel(env: NodeJS.ProcessEnv): string | undefined {
  return optional(env.AGENTIC_JUDGMENT_FALLBACK_MODEL);
}

/**
 * How each fast-judgment seam of the loop runs. The product's defaults come from what was measured
 * on it; a seam it does not name runs in shadow (asked and journaled, nothing changes), except the
 * state seam, which is off. AGENTIC_JUDGMENT_MODE=shadow turns every seam that is on into shadow.
 */
export function judgmentSeamModes(env: NodeJS.ProcessEnv, defaults: JudgmentSeamModes = {}): JudgmentSeamModes {
  const shadow = judgmentShadow(env);
  const mode = (seam: keyof JudgmentSeamModes, fallback: JudgmentSeamMode): JudgmentSeamMode => {
    const chosen = defaults[seam] ?? fallback;
    return shadow && chosen === "on" ? "shadow" : chosen;
  };
  // Keep observation state disabled; relevance and review seams use the configured defaults.
  return { observationReview: mode("observationReview", "on"), observationState: mode("observationState", "off"),
    skillRelevance: mode("skillRelevance", "on"), resultRelevance: mode("resultRelevance", "on"),
    // Acts only where a product declares tool groups; elsewhere nothing asks it.
    toolRelevance: mode("toolRelevance", "on"),
    // Step claims stay in shadow until a deployment validates its policy.
    stepClaim: mode("stepClaim", "shadow"),
    // Answer movement follows the configured live policy.
    answerMoved: mode("answerMoved", "on"),
    // Suggested next calls stay in shadow unless a deployment enables them.
    nextCall: mode("nextCall", "shadow") };
}
