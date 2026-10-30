import type { AgentNarrationEvent, AgentOutputEvent, AgentProgressEvent, AgentReasoningEvent, JsonValue, ToolTerminalExecutionState } from "@0xsyncroot/contracts";
import { PublicReasoningStream, type PublicReasoningOptions } from "./public-reasoning-stream.js";
import { publicPlan } from "./public-reasoning-text.js";
import { InlineThoughtDecoder } from "@0xsyncroot/contracts";

const PUBLIC_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/;
/**
 * A narration may be a whole draft answer a policy kept on screen, so it is cut, never withdrawn:
 * the user has already read it. The same bound and mark apply when history replays it.
 */
const NARRATION_MAX_CHARS = 20_000;
const NARRATION_CUT_MARK = "…";
const OUTPUT_MAX_CHARS = 256_000;
const TRACE_LABEL_MAX_CHARS = 240;
const ACTIVE_NARRATION_LIMIT = 8;
const ACTIVE_OUTPUT_LIMIT = 4;

interface ActiveNarration {
  readonly turnId: string;
  chars: number;
  readonly channels: InlineThoughtDecoder;
}

interface ActiveOutput {
  readonly turnId: string;
  chars: number;
}

/**
 * One tool call as the product's labeller sees it: what it was made with, and — once it has ended —
 * how it ended and what came back. Server-side material, like the tool id: the labeller turns it
 * into a sentence, and the sentence is the only thing that crosses.
 */
export interface ToolTraceCall {
  readonly phase: "started" | "completed";
  readonly arguments?: JsonValue;
  /** `completed` only. */
  readonly status?: ToolTerminalExecutionState;
  /** `completed` only, and only when the call returned something. */
  readonly result?: JsonValue;
  /** `completed` only: why a call that did not succeed did not, as the runtime recorded it. */
  readonly error?: JsonValue;
  /** The call ran within an approval the user gave earlier in the task, so no card of its own was shown (`started` and `completed`). */
  readonly approvalReused?: true;
  /** The call ran under the user's standing approval, so no card was asked (`started` and `completed`). */
  readonly approvalStanding?: true;
}

/**
 * Names a tool call in words the product wrote, for a user who must never be shown the tool's own id.
 *
 * `call` lets the sentence say what this particular call is about — which file, which table, which
 * query, how much came back — rather than one fixed phrase per tool: "reading a table" tells the
 * person watching nothing they can check; the same line naming the table does.
 *
 * Returning nothing withholds the event entirely, which is the right default for a product that has
 * not written a phrase for that tool: a generic line for every call is noise, and the id itself is
 * not the product's to show.
 */
export type ToolTraceLabeller = (toolId: string, initiator?: "policy", call?: ToolTraceCall) => string | undefined;

export interface PublicAgentStreamWriterOptions extends PublicReasoningOptions {
  readonly toolTrace?: ToolTraceLabeller;
}

/** Writes the deliberately small, user-safe part of an agent run to browser SSE. */
export class PublicAgentStreamWriter {
  readonly #activeNarrations = new Map<string, ActiveNarration>();
  readonly #activeOutputs = new Map<string, ActiveOutput>();
  readonly #reasoning: PublicReasoningStream;
  readonly #toolTrace: ToolTraceLabeller | undefined;
  constructor(readonly publish: (event: string, payload: unknown) => void, options: PublicAgentStreamWriterOptions = {}) {
    this.#toolTrace = options.toolTrace;
    this.#reasoning = new PublicReasoningStream((event, payload) => this.event(event, payload), options);
  }

  event(event: string, payload: unknown): void {
    this.publish(event, payload);
  }

  /**
   * Raw model text stays server-side; progress is never promoted to assistant chat.
   *
   * Tool identity does not cross either, and did not used to be stopped here. A `tool-started` or
   * `tool-completed` event carries `toolId`, and this forwarded the event whole — so every product
   * built on this writer published its internal tool names to the browser. What may cross instead
   * is a phrase the product wrote for that tool, which names the work rather than the tool; with no
   * phrase, the event is withheld rather than sent with the id stripped and nothing in its place.
   */
  progress(progress: AgentProgressEvent): void {
    if (progress.type === "output-item-delta" || progress.type === "content-delta") return;
    if (progress.type === "tool-started" || progress.type === "tool-completed") {
      const call: ToolTraceCall = progress.type === "tool-started"
        ? { phase: "started", ...(progress.arguments !== undefined ? { arguments: progress.arguments } : {}), ...(progress.approvalReused ? { approvalReused: true as const } : {}),
            ...(progress.approvalStanding ? { approvalStanding: true as const } : {}) }
        : {
            phase: "completed", status: progress.status,
            ...(progress.arguments !== undefined ? { arguments: progress.arguments } : {}),
            ...(progress.result !== undefined ? { result: progress.result } : {}),
            ...(progress.error !== undefined ? { error: progress.error } : {}),
            ...(progress.approvalReused ? { approvalReused: true as const } : {}),
            ...(progress.approvalStanding ? { approvalStanding: true as const } : {}),
          };
      const label = this.#label(progress.toolId, progress.initiator, call);
      if (!label) return;
      // Built field by field, never spread: the event also carries the call's arguments and its
      // result, and a spread would have published both the day they were added — the same way the
      // tool id once crossed. `label` is the browser's name for this field, not a choice made here:
      // published as `trace`, the widget — reading `label` — printed its one generic fallback
      // sentence for every call instead. Both sides' tests were green; each asserted its own spelling.
      this.event("progress", {
        type: progress.type, turnId: progress.turnId, step: progress.step, callId: progress.callId, label,
        ...(progress.initiator ? { initiator: progress.initiator } : {}),
        ...(progress.workStepId ? { workStepId: progress.workStepId } : {}),
        ...(progress.type === "tool-completed" ? { status: progress.status } : {}),
        // A flag, not identity: the client may refresh what it shows of the user's setting when a call ran under it.
        ...(progress.type === "tool-started" && progress.approvalStanding ? { approvalStanding: true } : {}),
      });
      return;
    }
    if (progress.type === "tool-state-changed") {
      const label = this.#label(progress.toolId, undefined);
      if (!label) return;
      const { toolId: _withheld, ...rest } = progress;
      this.event("progress", { ...rest, label });
      return;
    }
    // A card carries the same tool id, in a field the browser never reads. Stopping it on the
    // trace events alone left the whole identity published anyway, one approval card at a time —
    // and a card is the event a product is most likely to log, forward or screenshot. What the
    // client actually needs to answer a card is its id, its deadline and what it says; the tool
    // behind it is this runtime's business. `history-view.ts` drops it from the replay of the same
    // card for the same reason.
    if (progress.type === "approval-requested") {
      const { toolId: _withheld, ...approval } = progress.approval;
      this.event("progress", { ...progress, approval });
      return;
    }
    if (progress.type === "interaction-requested") {
      const { toolId: _withheld, ...interaction } = progress.interaction;
      this.event("progress", { ...progress, interaction });
      return;
    }
    // The plan is the model's own writing: its sentences cross, the identifiers in them do not.
    this.event("progress", progress.type === "plan-updated" ? { ...progress, plan: publicPlan(progress.plan) } : progress);
  }

  /** A labeller is product code: a throw or an essay from it must not take the stream down or flood it. */
  #label(toolId: string, initiator: "policy" | undefined, call?: ToolTraceCall): string | undefined {
    let label: string | undefined;
    try { label = this.#toolTrace?.(toolId, initiator, call); } catch { return undefined; }
    if (typeof label !== "string") return undefined;
    const compact = label.trim().replaceAll(/\s+/gu, " ");
    return compact ? compact.slice(0, TRACE_LABEL_MAX_CHARS) : undefined;
  }

  /** The model's private reasoning, as the product chose to publish it — see `PublicReasoningStream`. */
  reasoning(reasoning: AgentReasoningEvent): void {
    this.#reasoning.handle(reasoning);
  }

  discardReasonings(): void {
    this.#reasoning.discardAll();
  }

  /** Streams only the core's explicit user-facing answer channel, never raw progress. */
  output(output: AgentOutputEvent): void {
    if (output.audience !== "user" ||
        typeof output.outputId !== "string" || !PUBLIC_ID_PATTERN.test(output.outputId) ||
        typeof output.turnId !== "string" || !PUBLIC_ID_PATTERN.test(output.turnId)) return;

    if (output.type === "assistant-output-start") {
      const previous = this.#activeOutputs.get(output.outputId);
      if (previous) this.#endOutput(output.outputId, previous.turnId, "discarded");
      if (this.#activeOutputs.size >= ACTIVE_OUTPUT_LIMIT) return;
      this.#activeOutputs.set(output.outputId, { turnId: output.turnId, chars: 0 });
      this.event(output.type, output);
      return;
    }

    const current = this.#activeOutputs.get(output.outputId);
    if (!current || current.turnId !== output.turnId) return;
    if (output.type === "assistant-output-delta") {
      if (typeof output.delta !== "string" || !output.delta || current.chars + output.delta.length > OUTPUT_MAX_CHARS) {
        this.#endOutput(output.outputId, current.turnId, "discarded");
        return;
      }
      current.chars += output.delta.length;
      this.event(output.type, output);
      return;
    }
    if (output.type === "assistant-output-end" && (output.status === "completed" || output.status === "discarded")) {
      this.#endOutput(output.outputId, output.turnId, output.status);
    }
  }

  /**
   * Only a complete, explicit public-narration lifecycle can cross this boundary.
   *
   * A narration is never ended `discarded` for its length. It used to be, at 4,000 characters, and
   * a draft answer kept as narration is longer than that: the client had already moved the text the
   * user was reading into the narration slot, and the discard emptied it.
   */
  narration(narration: AgentNarrationEvent): void {
    if (narration.audience !== "user" ||
        typeof narration.narrationId !== "string" || !PUBLIC_ID_PATTERN.test(narration.narrationId) ||
        typeof narration.turnId !== "string" || !PUBLIC_ID_PATTERN.test(narration.turnId)) return;

    if (narration.type === "assistant-narration-start") {
      const previous = this.#activeNarrations.get(narration.narrationId);
      if (previous) this.#end(narration.narrationId, previous.turnId, "discarded");
      if (this.#activeNarrations.size >= ACTIVE_NARRATION_LIMIT) return;
      this.#activeNarrations.set(narration.narrationId, { turnId: narration.turnId, chars: 0, channels: new InlineThoughtDecoder() });
      this.event(narration.type, {
        type: narration.type, turnId: narration.turnId, narrationId: narration.narrationId, audience: "user",
        ...(narration.kind === "draft" ? { kind: "draft" } : {}),
      });
      return;
    }
    // A narration told and ended earlier leaves the chat; only the two ids cross.
    if (narration.type === "assistant-narration-superseded") {
      if (typeof narration.by === "string" && PUBLIC_ID_PATTERN.test(narration.by)) {
        this.event(narration.type, { type: narration.type, turnId: narration.turnId, narrationId: narration.narrationId, audience: "user", by: narration.by });
      }
      return;
    }

    const current = this.#activeNarrations.get(narration.narrationId);
    if (!current || current.turnId !== narration.turnId) return;
    if (narration.type === "assistant-narration-delta") {
      if (typeof narration.delta !== "string" || !narration.delta) {
        this.#end(narration.narrationId, current.turnId, "discarded");
        return;
      }
      this.#narrate(narration.narrationId, current, current.channels.push(narration.delta));
      return;
    }
    if (narration.type === "assistant-narration-end" &&
        (narration.status === "completed" || narration.status === "discarded")) {
      const rest = current.channels.finish();
      if (narration.status === "completed") this.#narrate(narration.narrationId, current, rest);
      this.event(narration.type, narration);
      this.#activeNarrations.delete(narration.narrationId);
    }
  }

  /** Publishes the public text of one decoded delta, up to the narration bound; what is past it is dropped behind one mark. */
  #narrate(narrationId: string, current: ActiveNarration, parts: ReturnType<InlineThoughtDecoder["push"]>): void {
    const text = parts.filter((part) => part.type === "text-delta").map((part) => part.delta).join("");
    const room = NARRATION_MAX_CHARS - current.chars;
    if (!text || room <= 0) return;
    // Cut before a split surrogate pair: half a character is not text a client can render.
    const delta = text.length <= room ? text : `${text.slice(0, room - NARRATION_CUT_MARK.length).replace(/[\uD800-\uDBFF]$/, "")}${NARRATION_CUT_MARK}`;
    current.chars = text.length <= room ? current.chars + text.length : NARRATION_MAX_CHARS;
    this.event("assistant-narration-delta", { type: "assistant-narration-delta", turnId: current.turnId, narrationId, audience: "user", delta });
  }

  discardNarrations(): void {
    for (const [narrationId, narration] of this.#activeNarrations) {
      this.#end(narrationId, narration.turnId, "discarded");
    }
  }

  discardOutputs(): void {
    for (const [outputId, output] of this.#activeOutputs) {
      this.#endOutput(outputId, output.turnId, "discarded");
    }
  }

  #end(narrationId: string, turnId: string, status: "completed" | "discarded"): void {
    this.event("assistant-narration-end", {
      type: "assistant-narration-end", turnId, narrationId, audience: "user", status,
    });
    this.#activeNarrations.delete(narrationId);
  }

  #endOutput(outputId: string, turnId: string, status: "completed" | "discarded"): void {
    this.event("assistant-output-end", {
      type: "assistant-output-end", turnId, outputId, audience: "user", status,
    });
    this.#activeOutputs.delete(outputId);
  }
}
