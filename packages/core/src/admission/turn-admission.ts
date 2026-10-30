import { randomUUID } from "node:crypto";
import { AgenticError, type TurnAdmissionController, type TurnAdmissionLease, type TurnAdmissionRequest } from "@0xsyncroot/contracts";

export class UnlimitedTurnAdmissionController implements TurnAdmissionController {
  readonly productionSafe = false;

  async acquire(): Promise<TurnAdmissionLease> {
    return Object.freeze({ admissionId: randomUUID(), revision: "unlimited-v1", settle: async () => undefined });
  }
}

/** Process-local reference implementation. Multi-replica products can replace it with a distributed adapter. */
export class InMemoryTurnAdmissionController implements TurnAdmissionController {
  readonly productionSafe = false;
  readonly #active = new Map<string, number>();

  constructor(private readonly maxConcurrentPerTenant: number) {
    if (!Number.isInteger(maxConcurrentPerTenant) || maxConcurrentPerTenant <= 0) {
      throw new Error("maxConcurrentPerTenant must be a positive integer");
    }
  }

  async acquire(request: TurnAdmissionRequest, signal?: AbortSignal): Promise<TurnAdmissionLease> {
    if (signal?.aborted) throw signal.reason;
    const scope = request.security.tenantId;
    const active = this.#active.get(scope) ?? 0;
    if (active >= this.maxConcurrentPerTenant) {
      throw new AgenticError("budget-exceeded", `Concurrent turn quota exceeded for tenant ${scope}`);
    }
    this.#active.set(scope, active + 1);
    let settled = false;
    return Object.freeze({
      admissionId: randomUUID(),
      revision: `in-memory-concurrency-${this.maxConcurrentPerTenant}-v1`,
      settle: async () => {
        if (settled) return;
        settled = true;
        const current = this.#active.get(scope) ?? 1;
        if (current <= 1) this.#active.delete(scope);
        else this.#active.set(scope, current - 1);
      },
    });
  }
}
