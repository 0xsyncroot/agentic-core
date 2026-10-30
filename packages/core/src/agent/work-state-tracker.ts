import type { JsonValue } from "@0xsyncroot/contracts";
import { sha256 } from "../hash.js";
import type { ToolExecutionResult } from "./tool-execution-coordinator.js";

/**
 * Per-operation fingerprint of tool observations, so a step that repeats an earlier call's exact
 * result is not mistaken for progress.
 *
 * Plan lifecycle used to live here too; it now belongs to `WorkPlanLedger`, which owns identity,
 * matching and closure. This tracker keeps only what it always should have been: whether a result
 * has been seen before in this operation.
 */
export class WorkStateTracker {
  readonly #observationHashes = new Set<string>();

  observe(result: Pick<ToolExecutionResult, "result" | "error" | "images">, project?: (value: JsonValue) => JsonValue): "new" | "repeated" {
    const value = (result.result ?? result.error ?? null) as JsonValue;
    const observation = result.result !== undefined && project ? project(value) : value;
    const fingerprint = sha256(result.images?.length ? { observation, images: result.images } : observation);
    const informationGain = this.#observationHashes.has(fingerprint) ? "repeated" : "new";
    this.#observationHashes.add(fingerprint);
    return informationGain;
  }
}
