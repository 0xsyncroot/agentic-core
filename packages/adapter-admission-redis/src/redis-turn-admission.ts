import { createHash } from "node:crypto";
import { AgenticError, type TurnAdmissionController, type TurnAdmissionLease, type TurnAdmissionRequest } from "@0xsyncroot/contracts";
import type { RedisAdmissionBus } from "./redis-admission-bus.js";

export interface RedisTurnAdmissionOptions {
  /** Turns one tenant may run at the same time across every replica. */
  readonly maxConcurrentPerTenant: number;
  /** Turns one tenant may start per window. Omitted leaves admission purely a concurrency gate. */
  readonly maxTurnsPerWindowPerTenant?: number;
  readonly rateWindowMs?: number;
  /**
   * How long a slot survives without a heartbeat.
   *
   * It is a crash timer, not a turn timer: a replica that dies mid-turn must give the tenant
   * its capacity back on its own, and every live turn renews well inside this.
   */
  readonly leaseTtlMs?: number;
  readonly renewIntervalMs?: number;
  readonly keyPrefix?: string;
  /** Reported so an operator can see which slot was released, never what the turn contained. */
  readonly onEvent?: (event: RedisAdmissionEvent) => void;
}

export interface RedisAdmissionEvent {
  readonly phase: "admitted" | "rejected" | "renewed" | "expired" | "settled";
  readonly tenantId: string;
  readonly admissionId: string;
  readonly active?: number;
  readonly reason?: "concurrency" | "rate";
}

function positive(value: number | undefined, fallback: number, minimum: number, maximum: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < minimum || resolved > maximum) throw new Error(`${name} is invalid`);
  return resolved;
}

function prefix(value: string | undefined): string {
  const resolved = value ?? "gateway:admission:v1";
  if (!/^[A-Za-z0-9][A-Za-z0-9:_-]{0,63}$/.test(resolved)) throw new Error("keyPrefix is invalid");
  return resolved;
}

/** Tenant identifiers are caller data: hashed so they cannot shape a key, and bounded in length. */
function scope(value: string): string {
  return createHash("sha256").update(value).digest("base64url").slice(0, 32);
}

/**
 * Distributed turn admission.
 *
 * The in-memory controller counts turns inside one process, which makes a tenant's quota a
 * per-replica quota — four replicas quietly grant four times the limit, and the limit stops
 * meaning anything the moment the service scales. This one keeps the count in Redis, so the
 * number an operator configures is the number that holds.
 *
 * Failure is closed on purpose. If Redis cannot answer, no turn is admitted: an admission
 * controller that fails open is a quota that disappears exactly when the system is under the
 * kind of pressure the quota exists for.
 */
export class RedisTurnAdmissionController implements TurnAdmissionController {
  readonly productionSafe: boolean;
  readonly #prefix: string;
  readonly #ttlMs: number;
  readonly #renewMs: number;
  readonly #rateLimit: number;
  readonly #rateWindowMs: number;
  readonly #timers = new Set<NodeJS.Timeout>();
  #closed = false;

  constructor(private readonly bus: RedisAdmissionBus, private readonly options: RedisTurnAdmissionOptions) {
    this.productionSafe = bus.productionSafe;
    this.#prefix = prefix(options.keyPrefix);
    this.#ttlMs = positive(options.leaseTtlMs, 60_000, 5_000, 3_600_000, "leaseTtlMs");
    this.#renewMs = positive(options.renewIntervalMs, Math.floor(this.#ttlMs / 3), 1_000, 600_000, "renewIntervalMs");
    this.#rateWindowMs = positive(options.rateWindowMs, 60_000, 1_000, 3_600_000, "rateWindowMs");
    this.#rateLimit = options.maxTurnsPerWindowPerTenant === undefined
      ? 0 : positive(options.maxTurnsPerWindowPerTenant, 0, 1, 1_000_000, "maxTurnsPerWindowPerTenant");
    positive(options.maxConcurrentPerTenant, 0, 1, 100_000, "maxConcurrentPerTenant");
    if (this.#renewMs * 2 >= this.#ttlMs) throw new Error("renewIntervalMs must be less than half of leaseTtlMs");
  }

  async acquire(request: TurnAdmissionRequest, signal?: AbortSignal): Promise<TurnAdmissionLease> {
    if (this.#closed) throw new AgenticError("transient", "Turn admission is closed", true);
    if (signal?.aborted) throw signal.reason;
    const tenant = scope(request.security.tenantId);
    const activeKey = `${this.#prefix}:active:{${tenant}}`;
    const member = this.#member(request);
    let outcome;
    try {
      outcome = await this.bus.admit({
        activeKey, rateKey: `${this.#prefix}:rate:{${tenant}}`, member,
        concurrencyLimit: this.options.maxConcurrentPerTenant, ttlMs: this.#ttlMs,
        rateLimit: this.#rateLimit, rateWindowMs: this.#rateWindowMs,
      });
    } catch (error) {
      // Retryable, and deliberately not admitted: a quota that fails open stops existing under
      // exactly the load it was configured for.
      throw new AgenticError("transient", "Turn admission could not reach its quota store", true, { cause: error });
    }
    if (!outcome.admitted) {
      this.#emit({ phase: "rejected", tenantId: request.security.tenantId, admissionId: member,
        active: outcome.active, reason: outcome.reason });
      throw new AgenticError("budget-exceeded", outcome.reason === "rate"
        ? `Turn rate quota exceeded for tenant ${request.security.tenantId}`
        : `Concurrent turn quota exceeded for tenant ${request.security.tenantId}`);
    }
    this.#emit({ phase: "admitted", tenantId: request.security.tenantId, admissionId: member, active: outcome.active });
    return this.#lease(request, activeKey, member);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const timer of this.#timers) clearInterval(timer);
    this.#timers.clear();
    await this.bus.close();
  }

  /**
   * A slot held by heartbeat, released on settlement.
   *
   * The renewal runs on a timer rather than on the turn's own progress: a turn can legitimately
   * spend a minute inside one model call, and losing the slot mid-call would let a second turn
   * in while the first is still running.
   */
  #lease(request: TurnAdmissionRequest, activeKey: string, member: string): TurnAdmissionLease {
    let settled = false;
    const timer = setInterval(() => {
      if (settled) return;
      void this.bus.renew({ activeKey, member, ttlMs: this.#ttlMs })
        .then((held) => this.#emit({ phase: held ? "renewed" : "expired", tenantId: request.security.tenantId, admissionId: member }))
        .catch(() => this.#emit({ phase: "expired", tenantId: request.security.tenantId, admissionId: member }));
    }, this.#renewMs);
    timer.unref();
    this.#timers.add(timer);
    return Object.freeze({
      admissionId: member,
      revision: `redis-concurrency-${this.options.maxConcurrentPerTenant}`
        + `${this.#rateLimit > 0 ? `-rate-${this.#rateLimit}/${this.#rateWindowMs}ms` : ""}-v1`,
      settle: async () => {
        if (settled) return;
        settled = true;
        clearInterval(timer);
        this.#timers.delete(timer);
        // A failed release is survivable: the slot expires on its own TTL. Throwing here would
        // turn a completed turn into a failed one over bookkeeping the clock already handles.
        try { await this.bus.release({ activeKey, member }); }
        catch { /* The TTL is the backstop. */ }
        this.#emit({ phase: "settled", tenantId: request.security.tenantId, admissionId: member });
      },
    });
  }

  /**
   * The slot's identity: the same turn retried is the same slot.
   *
   * Keyed by the caller's idempotency key rather than by a fresh id, so a client retrying
   * after a dropped connection re-enters the slot it already holds. With a random id a retry
   * storm would consume the tenant's whole quota with attempts at a single turn.
   */
  #member(request: TurnAdmissionRequest): string {
    return createHash("sha256").update(JSON.stringify([
      request.security.tenantId, request.security.actorId, request.sessionId,
      request.idempotencyKey, request.agentProfileId,
    ])).digest("base64url").slice(0, 32);
  }

  #emit(event: RedisAdmissionEvent): void {
    try { this.options.onEvent?.(Object.freeze(event)); }
    catch { /* Telemetry consumers cannot break admission. */ }
  }
}
