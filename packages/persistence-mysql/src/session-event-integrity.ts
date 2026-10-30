import { createHash } from "node:crypto";
import { sha256 } from "./hash.js";

// Encoding used by the original MySQL adapter (db80e3b). Keep this read-only:
// changing a fingerprint writer would affect idempotency and new event hashes.
function legacyJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(legacyJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${legacyJson(item)}`).join(",")}}`;
}

export function sessionEventHashFormat(value: unknown, expected: string): "canonical" | "legacy-mysql" | "mismatch" {
  if (sha256(value) === expected) return "canonical";
  const legacyHash = createHash("sha256").update(legacyJson(value)).digest("hex");
  return legacyHash === expected ? "legacy-mysql" : "mismatch";
}
