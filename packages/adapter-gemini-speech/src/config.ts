/** Constructor configuration for `GeminiSpeechAdapter`. The key is only ever sent as a request header. */
export interface GeminiSpeechConfig {
  readonly apiKey: string;
  /** Default "https://generativelanguage.googleapis.com". https only, except loopback http for local fakes; no credentials in the URL. */
  readonly baseUrl?: string;
  /** "transcribe" (dedicated transcription model, default) or "prompt" (a general audio model given a transcription instruction). */
  readonly sttApi?: "transcribe" | "prompt";
  /** Default "gemini-3.5-transcribe". With sttApi "prompt", a general audio model such as "gemini-3.8-flash". */
  readonly sttModel?: string;
  /** Default "smart". Applies to sttApi "transcribe" only. */
  readonly transcriptionMode?: "smart" | "verbatim";
  /** Default "gemini-3.8-flash-lite-tts". */
  readonly ttsModel?: string;
  /** Default "Kore". */
  readonly defaultVoice?: string;
  readonly defaultStyle?: string;
  /** Per provider call, default 12000. */
  readonly timeoutMs?: number;
  readonly fetch?: typeof fetch;
}

/** What `speech.yaml` resolves to. The key itself is read from `env[apiKeyEnv]`, never from the file. */
export interface GeminiSpeechSettings {
  readonly enabled: boolean;
  readonly apiKeyEnv: string;
  /** undefined when env[apiKeyEnv] is unset or blank. */
  readonly apiKey?: string;
  readonly adapter: Omit<GeminiSpeechConfig, "apiKey" | "fetch">;
  readonly languageCodes: readonly string[];
  readonly vocabulary: readonly string[];
}
