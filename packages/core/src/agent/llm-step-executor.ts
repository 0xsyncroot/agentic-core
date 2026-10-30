import { randomUUID } from "node:crypto";
import { AgenticError, MODEL_LIMIT_REASON, type LlmStreamEvent, type PreparedLlmRequest } from "@0xsyncroot/contracts";
import { sha256 } from "../hash.js";
import { AnswerBound } from "./answer-bound.js";
import { cacheUse, estimatedUncachedTokens, reasoningUse, FirstEventModel, promptPieces, type PromptPieces } from "./first-event-model.js";
import { AttemptRace, unusedCallDiscard } from "./llm-attempt-race.js";
import { modelContextSize } from "./llm-model-context.js";
import { ContextWindowPolicy } from "./context-window-policy.js";
import { classifyError } from "./error-classifier.js";
import { ExponentialRetryPolicy } from "./retry-policy.js";
import { modelToolSchema } from "./model-tool-schema.js";
import { requestDigest } from "./request-digest.js";
import { closingMessage } from "./step-instruction.js";
import { rejectedToolChoice, toolChoiceInstruction } from "./llm-step-tool-choice.js";
import type { ModelInstructions } from "./context-budget-text.js";
import { INTERJECTION_DISCARD, type LlmStepCommand, type LlmStepResult } from "./llm-step-command.js";

export { INTERJECTION_DISCARD, type LlmStepCommand, type LlmStepResult } from "./llm-step-command.js";

export class LlmStepExecutor {
  /** The last request the gateway answered, per turn (one `TurnEventWriter` is one turn and goes with it): turns never see each other's. */
  readonly #answered = new WeakMap<object, PromptPieces>();
  constructor(
    private readonly defaultMaxContextChars: number,
    private readonly retryPolicy: ExponentialRetryPolicy,
    private readonly attemptTimeoutMs: number,
    private readonly instructions?: ModelInstructions,
    /** The longest silence after which an attempt's call is made once more (AttemptRace), learned below it (FirstEventModel); 0 makes none. */
    private readonly hedgeAfterMs = 0,
    /** Text one attempt may stream before it is cut and the step generated again (AnswerBound); 0 bounds nothing. */
    private readonly maxAnswerChars = 0,
    /** First-event times of this executor's calls, per model id: what sets the silence before the second call. */
    private readonly firstEvents = new FirstEventModel(),
  ) {}

  async #consumeFinal(race: AttemptRace, request: PreparedLlmRequest, parentSignal: AbortSignal,
    onTextDelta?: (delta: string) => void, onReasoningDelta?: (delta: string) => void): Promise<Extract<LlmStreamEvent, { type: "final" }>> {
    // The first event's bound is set per attempt (execute); the race also makes the second call.
    const { call, first } = await race.first(request);
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Silence between events, not the length of the answer. A chunk restarts it; a stream
    // that stops sending still ends, and is retried, instead of cutting a reply that is arriving.
    const armIdle = (): Promise<never> => new Promise((_, reject) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        const error = new AgenticError("timeout", `LLM attempt timed out after ${this.attemptTimeoutMs}ms`, true);
        call.controller.abort(error);
        reject(error);
      }, this.attemptTimeoutMs);
    });
    // A degenerate generation never stops by itself: one that loops or runs past the bound is cut here, as a silent one is.
    // Per call of this method, so the adapter's own continuation of an attempt (a second pass after its thinking budget) counts.
    const bounds = this.maxAnswerChars > 0
      ? { answer: new AnswerBound(this.maxAnswerChars), reasoning: new AnswerBound(Number.POSITIVE_INFINITY, "reasoning") } : undefined;
    const cut = (reason: string): never => {
      const error = new AgenticError("transient", reason, true, { reason: MODEL_LIMIT_REASON.OUTPUT });
      call.controller.abort(error);
      throw error;
    };
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(parentSignal.reason);
      if (parentSignal.aborted) onAbort();
      else parentSignal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      for (let item = first; !item.done; item = await Promise.race([call.iterator.next(), armIdle(), aborted])) {
        if (item.value.type === "text-delta") {
          const over = bounds?.answer.push(item.value.delta);
          if (over) cut(over);
          try { onTextDelta?.(item.value.delta); } catch { /* Progress observers are best effort. */ }
        } else if (item.value.type === "reasoning-delta") {
          const over = bounds?.reasoning.push(item.value.delta);
          if (over) cut(over);
          try { onReasoningDelta?.(item.value.delta); } catch { /* Progress observers are best effort. */ }
        } else if (item.value.type === "final") return item.value;
      }
      throw new AgenticError("permanent", `LLM adapter ${race.adapterId} ended without a final event`);
    } finally {
      if (timer) clearTimeout(timer);
      if (onAbort) parentSignal.removeEventListener("abort", onAbort);
      call.release();
      if (call.controller.signal.aborted) void call.iterator.return?.().catch(() => undefined);
    }
  }

  async execute(command: LlmStepCommand): Promise<LlmStepResult> {
    // A hard tool choice the adapter cannot enforce is enforced by the loop instead of refused.
    //
    // Failing the whole turn instead would end on an error a turn that may already have written
    // data. What the choice protects is not the request wire but the
    // outcome: the model must call this tool before it does anything else. Told so in words,
    // it does; and a call to anything else is sent back by the review, exactly as it would be
    // had the provider ignored the parameter. The tool subset offered stays as selected.
    const hardChoice = command.toolChoice === "required" || (command.toolChoice !== undefined && typeof command.toolChoice === "object");
    const enforceable = command.llm.features?.toolChoice === true;
    const toolChoice = hardChoice && !enforceable ? undefined : command.toolChoice;
    const choiceMessages = hardChoice && !enforceable && command.toolChoice !== undefined
      ? [...command.messages, toolChoiceInstruction(command.toolChoice, this.instructions)] : command.messages;
    const closing = closingMessage(this.instructions, command);
    const messages = closing ? [...choiceMessages, closing] : choiceMessages;
    const requestId = randomUUID();
    const toolSchemas = command.tools.map(modelToolSchema);
    const toolChars = JSON.stringify(toolSchemas).length;
    const contextChars = command.maxContextChars ?? this.defaultMaxContextChars;
    const messageBudget = contextChars - toolChars;
    if (messageBudget <= 0) throw new AgenticError("budget-exceeded", "Tool schemas exceed the model context budget");
    const bounded = new ContextWindowPolicy(messageBudget, this.instructions?.contextBudget).apply(messages);
    if (bounded.omittedMessages > 0 || bounded.clearedResults > 0) {
      await command.writer.append(
        [{ type: "context/trimmed", turnId: command.turnId, stepId: command.stepId, requestId, payload: {
          omittedMessages: bounded.omittedMessages, ...(bounded.clearedResults > 0 ? { clearedResults: bounded.clearedResults } : {}),
        } }],
        // Per request: a step that overflowed is prepared again, smaller, and trims differently.
        `context-trimmed:${command.stepId}:${requestId}`,
      );
    }

    // Images at none of the budget's reserve: their tokens are a small part of what the provider counts, and the reserve
    // read as characters would make every image request teach a lighter text than it is (context-calibration).
    const requestChars = modelContextSize({ messages: bounded.messages, tools: toolSchemas }, 0);
    try { command.onRequestSized?.(requestChars); } catch { /* Observers are best effort. */ }
    // The tokens the gateway must read afresh for this request, estimated before it is sent: what a retry of a silent call
    // shares with the one that hung is not read, so every attempt of this step keeps the estimate.
    const pieces = promptPieces(bounded.messages, toolSchemas);
    const uncachedTokens = estimatedUncachedTokens(pieces, this.#answered.get(command.writer), command.resolvedModel.estimatedCharsPerToken);
    // Plain from the start when the step asks it; otherwise only after a reasoning-limit failure (below).
    let plain = command.plain === true && command.llm.plainParameters !== undefined;
    const signal = command.interrupt ? AbortSignal.any([command.signal, command.interrupt]) : command.signal;
    for (let attempt = 1; attempt <= this.retryPolicy.maxAttempts; attempt += 1) {
      const attemptId = randomUUID();
      const itemId = randomUUID();
      const reasoningId = randomUUID();
      let outputStarted = false;
      let reasoningStarted = false;
      // The adapter gets the full request; the journal keeps its digest (see requestDigest). A second call of the same
      // attempt (AttemptRace) is the same request under its own attempt id, journaled before it is sent.
      // A stream with progress (`progressStreaming`, not a plain request) speaks from its first token. Its first event has
      // the silence bound and nothing more: healthy first events come well inside it, and a call still silent there is a
      // hang the provider's gateway would cut itself much later. Past `hedgeAfterMs` of silence the same request goes once
      // more (AttemptRace), `hedgeAfterMs` being what the calls answered so far say a prompt of this many uncached tokens
      // takes, never more than the configured cap.
      const live = command.llm.features?.progressStreaming === true && !plain;
      const hedgeAfterMs = live ? this.firstEvents.hedgeAfterMs(command.resolvedModel.modelId, uncachedTokens, this.hedgeAfterMs) : 0;
      const prepare = async (callId: string, hedgeOf?: string): Promise<PreparedLlmRequest> => {
        const requestBase = {
          requestId, attemptId: callId, turnId: command.turnId, stepId: command.stepId,
          runtimeSnapshotId: command.runtimeSnapshotId, model: command.resolvedModel.modelId, messages: bounded.messages,
          tools: toolSchemas,
          ...(toolChoice === undefined ? {} : { toolChoice }),
          parameters: { ...(command.llm.defaultParameters ?? {}), ...(plain ? command.llm.plainParameters : {}) },
        };
        const prepared = { ...requestBase, contentHash: sha256(requestBase) };
        await command.writer.append(
          [{
            type: "request/prepared", turnId: command.turnId, stepId: command.stepId, requestId, attemptId: callId,
            classification: "confidential",
            payload: { ...requestDigest(prepared, {
              modelRoute: command.resolvedModel, requestedToolChoice: command.toolChoice,
              // Which way a hard choice was enforced is a fact about the endpoint worth keeping:
              // it answers "does this model take tool_choice?" from the journal, not from a rerun.
              toolChoiceEnforcement: hardChoice ? (enforceable ? "provider" : "instruction") : "none",
            }), ...(hedgeOf ? { hedgeOf } : {}), ...(hedgeAfterMs > 0 ? { hedgeAfterMs } : {}) },
          }],
          `request-prepared:${callId}`,
        );
        return prepared;
      };
      const prepared = await prepare(attemptId);
      // A stream that may be silent while it works (hidden reasoning, tool calls sent whole) keeps the wait for the prompt
      // to be read and the answer to start, or a large request is cut before its first event on every attempt. One extra
      // second per 12k characters, at most three times the bound; no second call, since silence there says nothing and a
      // hedge would only double the calls.
      const firstEventMs = live ? this.attemptTimeoutMs
        : Math.min(3 * this.attemptTimeoutMs, this.attemptTimeoutMs + Math.round(JSON.stringify(bounded.messages).length / 12));
      const race = new AttemptRace({ adapter: command.llm, signal, firstEventMs,
        hedgeAfterMs, prepareHedge: () => prepare(randomUUID(), attemptId) });
      const at = { turnId: command.turnId, stepId: command.stepId, requestId };
      // Delivery observers see one attempt, `attemptId`, whichever call streamed it; the journal names the call.
      try {
        try { command.onAttemptStarted?.(attemptId); } catch { /* Progress observers are best effort. */ }
        const final = await this.#consumeFinal(
          race,
          prepared,
          signal,
          (delta) => {
            if (!outputStarted) {
              outputStarted = true;
              try { command.onOutputStarted?.(attemptId, itemId); } catch { /* Delivery observers are best effort. */ }
            }
            try { command.onTextDelta?.(delta, attemptId, itemId); } catch { /* Delivery observers are best effort. */ }
          },
          (delta) => {
            if (!reasoningStarted) {
              reasoningStarted = true;
              try { command.onReasoningStarted?.(attemptId, reasoningId); } catch { /* Delivery observers are best effort. */ }
            }
            try { command.onReasoningDelta?.(delta, attemptId, reasoningId); } catch { /* Delivery observers are best effort. */ }
          },
        );
        if (reasoningStarted) {
          try { command.onReasoningEnded?.(attemptId, reasoningId, "completed"); } catch { /* Delivery observers are best effort. */ }
        }
        if (outputStarted) {
          try { command.onOutputCompleted?.(attemptId, itemId); } catch { /* Delivery observers are best effort. */ }
        }
        await race.quiet();
        const usedId = race.winner?.attemptId ?? attemptId, hedge = race.hedge;
        const cacheFacts = cacheUse(final.usage);
        await command.writer.append([...unusedCallDiscard(race, usedId, at), {
          type: "llm/attempt-committed", ...at, attemptId: usedId,
          payload: { itemId: outputStarted ? itemId : null, hadPublicOutput: outputStarted, ...rejectedToolChoice(final),
            ...(race.firstEventMs === undefined ? {} : { firstEventMs: race.firstEventMs }), ...(hedge ? { hedge } : {}),
            ...cacheFacts, ...reasoningUse(final.usage), ...(live ? { estimatedUncachedTokens: uncachedTokens } : {}), ...(plain ? { plain: true } : {}) },
        }], `llm-attempt-committed:${usedId}`);
        // The gateway has read this request now. A call that hung or failed leaves the earlier one as the last answered.
        this.#answered.set(command.writer, pieces);
        // Only the call sent first teaches ("hedge delay plus the hedge's first event" is not how long the gateway takes);
        // one that answered after the hedge was sent still does, and is what raises the estimate when the gateway slows.
        if (live && this.hedgeAfterMs > 0 && usedId === attemptId && race.firstEventMs !== undefined) {
          this.firstEvents.learn(command.resolvedModel.modelId, uncachedTokens, race.firstEventMs);
        }
        try { command.onAttemptCommitted?.(attemptId, outputStarted ? itemId : undefined); } catch { /* Delivery observers are best effort. */ }
        return { final, requestId, attemptId: usedId, requestChars, ...cacheFacts };
      } catch (error) {
        // A call cut for the user's input is only discarded, never retried; the turn's own abort always wins.
        // No tool from a failed generation has run. Retry this step once in the adapter's
        // declared plain mode, with the same source and durable state; never clip private state.
        const cut = command.interrupt?.aborted === true && !command.signal.aborted, classified = classifyError(error);
        const recoverReasoning = !cut && error instanceof AgenticError && error.reason === MODEL_LIMIT_REASON.REASONING &&
          !plain && command.llm.plainParameters !== undefined && attempt < this.retryPolicy.maxAttempts && !signal.aborted;
        const willRetry = !cut && (recoverReasoning || this.retryPolicy.shouldRetry(classified, attempt)), code = cut ? INTERJECTION_DISCARD : classified.code;
        if (reasoningStarted) {
          try { command.onReasoningEnded?.(attemptId, reasoningId, "discarded"); } catch { /* Delivery observers are best effort. */ }
        }
        await race.quiet();
        const usedId = race.winner?.attemptId ?? attemptId, hedge = race.hedge;
        await command.writer.append(
          [
            ...(cut ? [] : [{ type: "llm/attempt-failed" as const, ...at, attemptId: usedId, payload: {
              ...classified, willRetry, attempt, ...(recoverReasoning ? { recovery: "plain-parameters" } : {}),
            } }]),
            { type: "llm/attempt-discarded", ...at, attemptId: usedId, payload: {
              itemId: outputStarted ? itemId : null, hadPublicOutput: outputStarted, code, willRetry, ...(hedge ? { hedge } : {}),
            } },
            ...unusedCallDiscard(race, usedId, at, { code, willRetry }),
          ],
          `llm-attempt-failed:${usedId}`,
        );
        try { command.onAttemptDiscarded?.(attemptId, code, willRetry, outputStarted ? itemId : undefined); } catch { /* Delivery observers are best effort. */ }
        if (!willRetry) throw error;
        if (recoverReasoning) { plain = true; continue; }
        // The back-off waits on the turn alone, so the retry it announced is made: input that came meanwhile cuts that attempt
        // as it starts, and its discard says so.
        await this.retryPolicy.wait(attempt, command.signal);
      }
    }
    throw new AgenticError("permanent", "LLM retry policy exhausted without a terminal attempt");
  }
}
