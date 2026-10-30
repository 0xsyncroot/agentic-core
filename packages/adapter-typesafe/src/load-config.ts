import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import type { TypeSafeJudgmentSettings } from "./config.js";
import { resolveTypeSafeBaseUrl } from "./typesafe-judgment-adapter.js";

const ROOT_KEYS = new Set(["enabled", "apiKeyEnv", "baseUrl", "model", "timeoutMs", "rerank"]);
const RERANK_KEYS = new Set(["shortlist", "deadlineMs"]);
const MAX_DEADLINE_MS = 1_500;

function mapping(value: unknown, name: string, allowed: ReadonlySet<string>): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be a mapping`);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${name} has an unknown key: ${key}`);
  }
  return value as Record<string, unknown>;
}

function noPlaceholders(value: unknown, name: string): void {
  if (typeof value === "string" && value.includes("${")) throw new Error(`${name} must not use \${…} substitution; name an environment variable instead`);
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) noPlaceholders(item, `${name}.${key}`);
  }
}

function integer(value: unknown, name: string, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function optionalText(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string`);
  return value.trim();
}

/**
 * Reads judgment.yaml. The file names the environment variable holding the key and never the key:
 * a literal key, or a `${…}` placeholder, is refused. Returns undefined when the file is absent.
 */
export async function loadTypeSafeJudgmentConfig(path: string, env: NodeJS.ProcessEnv): Promise<TypeSafeJudgmentSettings | undefined> {
  let source: string;
  try { source = await readFile(path, "utf8"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  let document: unknown;
  try { document = parse(source); } catch (error) {
    throw new Error(`judgment.yaml is not valid YAML: ${error instanceof Error ? error.message : "unknown error"}`);
  }
  noPlaceholders(document, "judgment.yaml");
  const root = mapping(document, "judgment.yaml", new Set([...ROOT_KEYS, "apiKey"]));
  if (root.apiKey !== undefined) throw new Error("judgment.yaml must not contain a literal apiKey; use apiKeyEnv to name an environment variable");
  const rerank = mapping(root.rerank, "rerank", RERANK_KEYS);
  if (root.enabled !== undefined && typeof root.enabled !== "boolean") throw new Error("enabled must be true or false");
  const apiKeyEnv = optionalText(root.apiKeyEnv, "apiKeyEnv");
  if (!apiKeyEnv || !/^[A-Z][A-Z0-9_]{0,63}$/u.test(apiKeyEnv)) throw new Error("apiKeyEnv must name an environment variable, for example TYPESAFE_API_KEY");
  const baseUrl = optionalText(root.baseUrl, "baseUrl");
  if (baseUrl) resolveTypeSafeBaseUrl(baseUrl);
  const model = optionalText(root.model, "model");
  const key = env[apiKeyEnv]?.trim();
  return Object.freeze({
    enabled: root.enabled ?? true,
    apiKeyEnv,
    ...(key ? { apiKey: key } : {}),
    adapter: Object.freeze({
      ...(baseUrl ? { baseUrl } : {}),
      ...(model ? { model } : {}),
      ...(root.timeoutMs !== undefined ? { timeoutMs: integer(root.timeoutMs, "timeoutMs", 1_500, 1, 60_000) } : {}),
    }),
    rerank: Object.freeze({
      shortlist: integer(rerank.shortlist, "rerank.shortlist", 12, 1, 30),
      deadlineMs: Math.min(integer(rerank.deadlineMs, "rerank.deadlineMs", 1_200, 1, 60_000), MAX_DEADLINE_MS),
    }),
  });
}
