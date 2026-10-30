import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import type { GeminiSpeechConfig, GeminiSpeechSettings } from "./config.js";
import { validateProviderBaseUrl } from "./base-url.js";

const ROOT_KEYS = ["enabled", "apiKeyEnv", "baseUrl", "stt", "tts", "timeoutMs"];
const STT_KEYS = ["api", "model", "mode", "languageCodes", "vocabulary"];
const TTS_KEYS = ["model", "voice", "style"];
const LITERAL_KEY_NAMES = ["apiKey", "api_key", "key", "token"];
const MODEL_ID = /^[A-Za-z0-9._-]{1,128}$/u;
const MAX_VOCABULARY = 100;

function record(value: unknown, name: string, allowed: readonly string[]): Record<string, unknown> {
  if (value === null || value === undefined) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be a mapping`);
  const source = value as Record<string, unknown>;
  for (const key of Object.keys(source)) {
    if (LITERAL_KEY_NAMES.includes(key)) {
      throw new Error(`speech.yaml must not contain a literal ${key}; use apiKeyEnv to name an environment variable`);
    }
    if (!allowed.includes(key)) throw new Error(`${name}.${key} is not a known key`);
  }
  return source;
}

function noSubstitution(value: unknown, name: string): void {
  if (typeof value === "string" && value.includes("${")) throw new Error(`${name} must not use \${...} substitution; name an environment variable instead`);
  if (Array.isArray(value)) value.forEach((item, index) => noSubstitution(item, `${name}[${index}]`));
  else if (value && typeof value === "object") for (const [key, item] of Object.entries(value)) noSubstitution(item, `${name}.${key}`);
}

function text(value: unknown, name: string, pattern?: RegExp): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string`);
  const resolved = value.trim();
  if (pattern && !pattern.test(resolved)) throw new Error(`${name} is invalid`);
  return resolved;
}

function oneOf<T extends string>(value: unknown, name: string, allowed: readonly T[]): T | undefined {
  const resolved = text(value, name);
  if (resolved === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(resolved)) throw new Error(`${name} must be one of ${allowed.join(", ")}`);
  return resolved as T;
}

function strings(value: unknown, name: string, pattern: RegExp | undefined, maximum: number): readonly string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`${name} must be a list`);
  if (value.length > maximum) throw new Error(`${name} may hold at most ${maximum} entries`);
  return Object.freeze(value.map((item, index) => text(item, `${name}[${index}]`, pattern)!));
}

export function parseGeminiSpeechConfig(source: string, env: NodeJS.ProcessEnv): GeminiSpeechSettings {
  let document: unknown;
  try { document = parse(source); } catch (error) {
    throw new Error(`speech.yaml is not valid YAML: ${error instanceof Error ? error.message : "unknown error"}`);
  }
  noSubstitution(document, "speech.yaml");
  const root = record(document, "speech.yaml", ROOT_KEYS);
  const stt = record(root.stt, "stt", STT_KEYS);
  const tts = record(root.tts, "tts", TTS_KEYS);
  if (root.enabled !== undefined && typeof root.enabled !== "boolean") throw new Error("enabled must be true or false");
  const apiKeyEnv = text(root.apiKeyEnv, "apiKeyEnv", /^[A-Z][A-Z0-9_]{0,63}$/u) ?? "GEMINI_API_KEY";
  if (root.timeoutMs !== undefined && (typeof root.timeoutMs !== "number" || !Number.isInteger(root.timeoutMs) || root.timeoutMs < 250 || root.timeoutMs > 120_000)) {
    throw new Error("timeoutMs must be an integer between 250 and 120000");
  }
  const baseUrl = text(root.baseUrl, "baseUrl");
  const fields: Partial<Record<keyof Omit<GeminiSpeechConfig, "apiKey" | "fetch">, unknown>> = {
    baseUrl: baseUrl === undefined ? undefined : validateProviderBaseUrl(baseUrl),
    sttApi: oneOf(stt.api, "stt.api", ["transcribe", "prompt"]),
    sttModel: text(stt.model, "stt.model", MODEL_ID),
    transcriptionMode: oneOf(stt.mode, "stt.mode", ["smart", "verbatim"]),
    ttsModel: text(tts.model, "tts.model", MODEL_ID),
    defaultVoice: text(tts.voice, "tts.voice"),
    defaultStyle: text(tts.style, "tts.style"),
    timeoutMs: root.timeoutMs,
  };
  const adapter = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as GeminiSpeechSettings["adapter"];
  const apiKey = env[apiKeyEnv]?.trim();
  return Object.freeze({
    enabled: root.enabled ?? true,
    apiKeyEnv,
    ...(apiKey ? { apiKey } : {}),
    adapter: Object.freeze(adapter),
    languageCodes: strings(stt.languageCodes, "stt.languageCodes", /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/u, 20),
    vocabulary: strings(stt.vocabulary, "stt.vocabulary", undefined, MAX_VOCABULARY),
  });
}

/** Reads the file, or reports that it is absent (`undefined`) rather than guessing a provider. */
export async function loadGeminiSpeechConfig(path: string, env: NodeJS.ProcessEnv): Promise<GeminiSpeechSettings | undefined> {
  let source: string;
  try { source = await readFile(path, "utf8"); }
  catch (error) {
    if (error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  return parseGeminiSpeechConfig(source, env);
}
