import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";
import { AgenticError, type BlindIndexEncoder, type DataProtectionContext, type JsonValue, type PayloadProtector, type ProtectedDataEnvelope } from "@0xsyncroot/contracts";

export interface TenantDataKey {
  readonly keyId: string;
  readonly key: Uint8Array;
}

/** Production implementations normally unwrap tenant DEKs through a KMS/HSM. */
export interface TenantDataKeyProvider {
  current(tenantId: string): Promise<TenantDataKey>;
  byId(tenantId: string, keyId: string): Promise<TenantDataKey>;
}

function validKey(key: TenantDataKey): Buffer {
  const bytes = Buffer.from(key.key);
  if (!key.keyId.trim() || bytes.length !== 32) throw new AgenticError("validation", "Tenant data keys must have an ID and exactly 32 bytes");
  return bytes;
}

function aad(context: DataProtectionContext): Buffer {
  return Buffer.from(JSON.stringify({
    tenantId: context.tenantId, recordId: context.recordId,
    purpose: context.purpose, classification: context.classification,
  }), "utf8");
}

function decode(value: string, label: string): Buffer {
  const result = Buffer.from(value, "base64url");
  if (result.length === 0 && value.length > 0) throw new AgenticError("permanent", `Invalid ${label} encoding`);
  return result;
}

export class AesGcmEnvelopeProtector implements PayloadProtector, BlindIndexEncoder {
  constructor(private readonly keys: TenantDataKeyProvider) {}

  async protect(value: JsonValue, context: DataProtectionContext): Promise<ProtectedDataEnvelope> {
    const material = await this.keys.current(context.tenantId);
    const key = validKey(material);
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(aad(context));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
    return {
      _protected: "gateway-envelope-v1", algorithm: "A256GCM", keyId: material.keyId,
      nonce: nonce.toString("base64url"), ciphertext: ciphertext.toString("base64url"),
      tag: cipher.getAuthTag().toString("base64url"),
    };
  }

  async unprotect(envelope: ProtectedDataEnvelope, context: DataProtectionContext): Promise<JsonValue> {
    try {
      const material = await this.keys.byId(context.tenantId, envelope.keyId);
      const decipher = createDecipheriv("aes-256-gcm", validKey(material), decode(envelope.nonce, "nonce"));
      decipher.setAAD(aad(context));
      decipher.setAuthTag(decode(envelope.tag, "authentication tag"));
      const plaintext = Buffer.concat([decipher.update(decode(envelope.ciphertext, "ciphertext")), decipher.final()]).toString("utf8");
      return JSON.parse(plaintext) as JsonValue;
    } catch (error) {
      if (error instanceof AgenticError) throw error;
      throw new AgenticError("permanent", "Protected payload authentication failed", false, { cause: error });
    }
  }

  async encodeTerms(text: string, tenantId: string): Promise<readonly string[]> {
    const material = await this.keys.current(tenantId);
    const key = validKey(material);
    const terms = new Set(text.normalize("NFKC").toLocaleLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter(Boolean));
    return [...terms].sort().map((term) => createHmac("sha256", key).update("gateway-blind-index-v1\0").update(term).digest("hex"));
  }
}

/** Reference provider for local/single-key deployments; use a KMS-backed provider at enterprise scale. */
export class DerivedTenantKeyProvider implements TenantDataKeyProvider {
  readonly #root: Buffer;

  constructor(rootKey: Uint8Array, private readonly keyId: string) {
    this.#root = Buffer.from(rootKey);
    if (this.#root.length !== 32 || !keyId.trim()) throw new AgenticError("validation", "Root key must be 32 bytes and keyId cannot be empty");
  }

  async current(tenantId: string): Promise<TenantDataKey> { return this.#derive(tenantId, this.keyId); }

  async byId(tenantId: string, keyId: string): Promise<TenantDataKey> {
    if (keyId !== this.keyId) throw new AgenticError("denied", `Unknown encryption key ID: ${keyId}`);
    return this.#derive(tenantId, keyId);
  }

  #derive(tenantId: string, keyId: string): TenantDataKey {
    if (!tenantId.trim()) throw new AgenticError("validation", "tenantId cannot be empty");
    const key = Buffer.from(hkdfSync("sha256", this.#root, Buffer.from(tenantId), Buffer.from("gateway-agentic-tenant-dek-v1"), 32));
    return Object.freeze({ keyId, key });
  }
}
