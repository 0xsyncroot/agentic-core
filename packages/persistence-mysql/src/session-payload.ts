import { AgenticError, isProtectedDataEnvelope, type JsonValue, type ProtectedDataEnvelope } from "@0xsyncroot/contracts";

const FORMAT = "gateway-session-json-text-v1";

/**
 * MySQL's binary JSON number conversion can change an IEEE-754 value (for example
 * 123456789012345.67 becomes 123456789012345.69). Store the original JSON as text
 * inside the JSON column so replay sees exactly the payload used by the hash.
 * Encrypted envelopes already preserve the plaintext bytes and stay unchanged.
 */
export function encodeSessionPayload(payload: JsonValue | ProtectedDataEnvelope): JsonValue | ProtectedDataEnvelope {
  return isProtectedDataEnvelope(payload) ? payload : { _mysql: FORMAT, json: JSON.stringify(payload) };
}

/** Unwrap once: an application payload that resembles this envelope stays an application payload. */
export function decodeSessionPayload(payload: JsonValue): JsonValue {
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || payload._mysql !== FORMAT) return payload;
  if (typeof payload.json !== "string") throw new AgenticError("permanent", "Invalid MySQL session JSON text envelope");
  try { return JSON.parse(payload.json) as JsonValue; }
  catch { throw new AgenticError("permanent", "Invalid MySQL session JSON text envelope"); }
}
