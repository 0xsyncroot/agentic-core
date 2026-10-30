/** Constructor configuration for `TypeSafeJudgmentAdapter`. The key is only ever sent as a bearer header. */
export interface TypeSafeJudgmentConfig {
  readonly apiKey: string;
  /** Default "https://api.typesafe.ai". https only, except loopback http for local fakes; no credentials in the URL. */
  readonly baseUrl?: string;
  /** Default "jev-1.13.0". Pinned rather than an alias, so tuned behaviour does not move underneath a deployment. */
  readonly model?: string;
  /** Default 1500. */
  readonly timeoutMs?: number;
  readonly fetch?: typeof fetch;
}

/** What `judgment.yaml` resolves to. The key itself is read from `env[apiKeyEnv]`, never from the file. */
export interface TypeSafeJudgmentSettings {
  readonly enabled: boolean;
  readonly apiKeyEnv: string;
  /** undefined when env[apiKeyEnv] is unset or blank. */
  readonly apiKey?: string;
  readonly adapter: Omit<TypeSafeJudgmentConfig, "apiKey" | "fetch">;
  /** Defaults 12 / 1200; deadlineMs is clamped to at most 1500 so the knowledge tool's own timeout never fires first. */
  readonly rerank: { readonly shortlist: number; readonly deadlineMs: number };
}
