export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type DataClassification = "public" | "internal" | "confidential" | "restricted";

function normalizedJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => item === undefined ? null : normalizedJson(item));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => [key, normalizedJson(item)]));
  }
  return value;
}

/** Deterministic JSON encoding shared by fingerprints and integrity hashes. */
export function canonicalJson(value: unknown): string {
  const encoded = JSON.stringify(normalizedJson(value));
  if (encoded === undefined) throw new TypeError("Value cannot be represented as canonical JSON");
  return encoded;
}
