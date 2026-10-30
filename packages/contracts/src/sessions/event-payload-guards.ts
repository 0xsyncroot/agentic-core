import type { JsonValue } from "../shared/json.js";

export type JsonObject = Record<string, JsonValue>;

export function isObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function nonEmpty(value: JsonValue | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function boundedString(value: JsonValue | undefined, maxChars: number): boolean {
  return typeof value === "string" && value.length <= maxChars;
}
