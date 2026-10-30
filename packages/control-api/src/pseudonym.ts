import { createHmac } from "node:crypto";

/** Bytes a pseudonym key must hold: a shorter key makes the actor keys guessable from a list of actor ids. */
const MIN_KEY_BYTES = 32;
const ACTOR_KEY = /^[0-9a-f]{64}$/u;
/** Hex characters a reader sees; the full key identifies, the short form only names. */
export const PSEUDONYM_CHARS = 6;
/** Input of the key fingerprint. It holds no NUL, so it is never the input of an actor key (`tenantId NUL actorId`). */
const FINGERPRINT_INPUT = "review-pseudonym-key-fingerprint";
const FINGERPRINT_CHARS = 16;

/**
 * Actor keys: hex(HMAC-SHA256(key, tenantId || 0x00 || actorId)). The tenant is part of the input, so one person in two tenants
 * gets two unrelated keys; the NUL keeps ("ab", "c") apart from ("a", "bc"). The version names the key, so rotating it is a
 * new version and a rebuild, never a silent change of what an old key meant.
 */
export class ActorPseudonyms {
  readonly #key: Buffer;
  constructor(key: string, readonly version: string) {
    this.#key = Buffer.from(key, "utf8");
    if (this.#key.length < MIN_KEY_BYTES) throw new Error(`pseudonym key must hold at least ${MIN_KEY_BYTES} bytes`);
    if (version.trim() === "") throw new Error("pseudonym key version must not be empty");
  }

  /**
   * Names the key without disclosing it: an HMAC under the key, so knowing the fingerprint gives no way to test guesses of
   * actor ids. It changes with the key and not with the version label, so a rotated key always gives a new projector revision.
   */
  get keyFingerprint(): string {
    return createHmac("sha256", this.#key).update(FINGERPRINT_INPUT, "utf8").digest("hex").slice(0, FINGERPRINT_CHARS);
  }

  /** The 64-hex key that stands for this actor in this tenant. */
  actorKey(tenantId: string, actorId: string): string {
    for (const [name, value] of [["tenantId", tenantId], ["actorId", actorId]] as const) {
      if (value === "") throw new Error(`${name} must not be empty`);
      if (value.includes("\u0000")) throw new Error(`${name} must not contain NUL`);
    }
    return createHmac("sha256", this.#key).update(`${tenantId}\u0000${actorId}`, "utf8").digest("hex");
  }
}

/** The short form a reader sees: the last characters of the actor key. */
export function pseudonymOf(actorKey: string): string {
  if (!ACTOR_KEY.test(actorKey)) throw new Error("actor key must be 64 lowercase hex characters");
  return actorKey.slice(-PSEUDONYM_CHARS);
}
