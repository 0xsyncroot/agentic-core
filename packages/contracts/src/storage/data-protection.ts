import type { DataClassification, JsonValue } from "../shared/json.js";

export interface DataProtectionContext {
  readonly tenantId: string;
  readonly recordId: string;
  readonly purpose: string;
  readonly classification: DataClassification;
}

export interface ProtectedDataEnvelope {
  readonly _protected: "gateway-envelope-v1";
  readonly algorithm: "A256GCM";
  readonly keyId: string;
  readonly nonce: string;
  readonly ciphertext: string;
  readonly tag: string;
}

/** Persistence-facing port. Core and domain plugins never handle encryption keys. */
export interface PayloadProtector {
  protect(value: JsonValue, context: DataProtectionContext): Promise<ProtectedDataEnvelope>;
  unprotect(envelope: ProtectedDataEnvelope, context: DataProtectionContext): Promise<JsonValue>;
}

/** Keyed lexical projection used when encrypted text still requires exact-term lookup. */
export interface BlindIndexEncoder {
  encodeTerms(text: string, tenantId: string): Promise<readonly string[]>;
}

export function isProtectedDataEnvelope(value: unknown): value is ProtectedDataEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return candidate._protected === "gateway-envelope-v1" && candidate.algorithm === "A256GCM" &&
    typeof candidate.keyId === "string" && typeof candidate.nonce === "string" &&
    typeof candidate.ciphertext === "string" && typeof candidate.tag === "string";
}
