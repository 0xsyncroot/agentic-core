import assert from "node:assert/strict";
import test from "node:test";
import type { AgentNarrationEvent, LlmAdapter, LlmStreamEvent, PreparedLlmRequest, SessionEvent } from "@0xsyncroot/contracts";
import { DefaultAgentLoop, OPENING_LINE_PROVENANCE } from "@0xsyncroot/core";
import { startOpeningLine } from "../src/agent/opening-line.js";
import type { ClaimedTurn } from "../src/agent/claimed-turn.js";
import { activeHost, answer, planningPlugin, planStep, call, security, SpyStore, toolPlugin, writeTool } from "./turn-harness.js";

/**
 * The opening line: one sentence acknowledging the request, written by its own no-thinking call beside the turn's setup,
 * streamed as narration and journaled with `opening: true`. It never reaches the model's context, never counts as the
 * turn's narration, is not told on a resume, and a failure or a timeout shows nothing.
 */

const LINE = "Dạ, em đã nhận yêu cầu đếm bảng lương tháng 8 của anh/chị.";
const INSTRUCTION = "Acknowledge the request in one sentence.";
const PLAIN = { enable_thinking: false };
type Reply = (request: PreparedLlmRequest) => LlmStreamEvent;
type Opening = (signal: AbortSignal) => AsyncIterable<LlmStreamEvent>;

const says = (...deltas: readonly string[]): Opening => async function* () { for (const delta of deltas) yield { type: "text-delta", delta }; };
/** Writes `first`, then waits for its call to be cancelled. */
const hangs = (first?: string): Opening => async function* (signal) {
  if (first) yield { type: "text-delta", delta: first };
  await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
};

/** The turn's model steps come from `steps`; the opening line's call, told apart by its provenance, from `opening`. */
function model(opening: Opening, steps: readonly Reply[], onStep: () => void = () => undefined) {
  const openings: PreparedLlmRequest[] = [];
  const requests: PreparedLlmRequest[] = [];
  const adapter: LlmAdapter = {
    id: "scripted", model: "scripted", plainParameters: PLAIN,
    async *stream(request, signal) {
      if (request.messages[0]?.context?.provenance === OPENING_LINE_PROVENANCE) { openings.push(request); yield* opening(signal); return; }
      requests.push(request);
      onStep();
      yield steps[Math.min(requests.length, steps.length) - 1]!(request);
    },
  };
  return { adapter, openings, requests };
}

const openingRows = (events: readonly SessionEvent[]) => events.filter((event) => event.type === "assistant/narration" && (event.payload as { opening?: boolean }).opening === true);
const openingFrames = (frames: readonly AgentNarrationEvent[]) => frames.filter((frame) => frame.narrationId.startsWith("opening:"));

async function runOne(opening: Opening, steps: readonly Reply[], options: { readonly instruction?: string; readonly plugins?: Parameters<typeof activeHost>[1] } = {}) {
  const frames: AgentNarrationEvent[] = [];
  let framesAtFirstStep: AgentNarrationEvent[] | undefined;
  const scripted = model(opening, steps, () => { framesAtFirstStep ??= [...frames]; });
  const { host, router } = await activeHost(scripted.adapter, options.plugins ?? []);
  try {
    const instructions = options.instruction === undefined ? {} : { modelInstructions: { openingLine: options.instruction } };
    const result = await new DefaultAgentLoop(router, new SpyStore(), {}, instructions)
      .runTurn({ sessionId: `opening-${Math.random()}`, content: "đếm bảng lương tháng 8", security: security(), onNarration: (frame) => frames.push(frame) });
    return { ...scripted, result, frames, framesAtFirstStep: framesAtFirstStep ?? [] };
  } finally { await host.shutdown(); }
}

test("the opening line is streamed and journaled before the first model step, from one plain call that reads only the request", async () => {
  const run = await runOne(says("Dạ, em đã nhận yêu cầu ", "đếm bảng lương tháng 8 của anh/chị."), [answer("Có 3 bảng.")], { instruction: INSTRUCTION });
  const turnId = run.result.turnId;
  assert.deepEqual(openingFrames(run.framesAtFirstStep).map((frame) => frame.type),
    ["assistant-narration-start", "assistant-narration-delta", "assistant-narration-delta", "assistant-narration-end"], "told whole before the model's first step");
  assert.deepEqual(openingFrames(run.frames).at(-1), { type: "assistant-narration-end", turnId, narrationId: `opening:${turnId}`, audience: "user", status: "completed" });
  const [row, ...more] = openingRows(run.result.events);
  assert.equal(more.length, 0);
  assert.deepEqual(row!.payload, { narrationId: `opening:${turnId}`, audience: "user", content: LINE, opening: true });
  assert.equal(row!.stepId, undefined, "no step of its own");
  const firstStep = run.result.events.findIndex((event) => event.type === "step/start");
  assert.ok(run.result.events.indexOf(row!) < firstStep, "journaled before the first step starts");
  assert.equal(run.openings.length, 1);
  const [request] = run.openings;
  assert.deepEqual(request!.parameters, PLAIN, "private reasoning off");
  assert.deepEqual(request!.tools, []);
  assert.deepEqual(request!.messages.map((message) => [message.role, message.content, message.context?.trust]),
    [["system", INSTRUCTION, "instruction"], ["user", "đếm bảng lương tháng 8", "untrusted"]], "the composition's instruction and the request as material, no history");
  assert.equal(run.result.content, "Có 3 bảng.");
});

test("the opening line never reaches the model: every step's messages are the ones a turn without it sends", async () => {
  const steps = [call("r1", "test_write", { value: "a" }), answer("Xong.")];
  const strip = (requests: readonly PreparedLlmRequest[]) => requests.map((request) => request.messages.map((message) => [message.role, message.content]));
  const withLine = await runOne(says(LINE), steps, { instruction: INSTRUCTION });
  const without = await runOne(says(LINE), steps);
  assert.equal(without.openings.length, 0, "no instruction, no call");
  assert.equal(openingRows(without.result.events).length, 0);
  assert.equal(openingRows(withLine.result.events).length, 1);
  assert.ok(withLine.requests.length > 0);
  for (const request of withLine.requests) assert.ok(!JSON.stringify(request.messages).includes(LINE), "the sentence is in no step's context");
  assert.deepEqual(strip(withLine.requests), strip(without.requests), "same prompt, same cached prefix");
});

test("the model's own plan announcement is still told: the opening line is not the turn's narration", async () => {
  const announcement = "Em sẽ đếm từng bảng lương của tháng 8.";
  const run = await runOne(says(LINE), [
    planStep("p1", "count", [{ id: "s1", description: "count sheets", status: "in_progress" }], announcement),
    planStep("p2", "count", [{ id: "s1", description: "count sheets", status: "completed" }]),
    answer("Có 3 bảng."),
  ], { instruction: INSTRUCTION, plugins: [planningPlugin()] });
  const narrations = run.result.events.filter((event) => event.type === "assistant/narration").map((event) => (event.payload as { content: string }).content);
  assert.deepEqual(narrations, [LINE, announcement], "the announcement beside the first plan update is narrated as without the opening line");
  assert.equal(run.result.content, "Có 3 bảng.");
});

test("an approval resume has no opening line: its request was acknowledged when the user made it", async () => {
  const frames: AgentNarrationEvent[] = [];
  const scripted = model(says(LINE), [call("w1", "test_write", { value: "a" }), answer("Đã ghi.")]);
  const { host, router } = await activeHost(scripted.adapter, [toolPlugin("write", [writeTool()])]);
  try {
    const agent = new DefaultAgentLoop(router, new SpyStore(), {}, { modelInstructions: { openingLine: INSTRUCTION } });
    const paused = await agent.runTurn({ sessionId: "opening-resume", content: "ghi giá trị a", security: security(), onNarration: (frame) => frames.push(frame) });
    assert.equal(paused.outcome, "awaiting_approval");
    assert.equal(openingRows(paused.events).length, 1);
    const resumed = await agent.resumeTurn({ sessionId: "opening-resume", approvalId: paused.approval!.approvalId, decision: "approve", security: security(),
      idempotencyKey: "approve-1", onNarration: (frame) => frames.push(frame) });
    assert.equal(resumed.content, "Đã ghi.");
    assert.equal(scripted.openings.length, 1, "asked once, for the turn the user started");
    assert.equal(openingRows(resumed.events.filter((event) => event.turnId === resumed.turnId)).length, 0);
    assert.ok(openingFrames(frames).every((frame) => frame.turnId === paused.turnId));
  } finally { await host.shutdown(); }
});

test("a failed opening call shows nothing and the turn answers as without it", async () => {
  const failing: Opening = async function* () { throw new Error("gateway refused"); };
  const run = await runOne(failing, [answer("Có 3 bảng.")], { instruction: INSTRUCTION });
  assert.equal(run.openings.length, 1);
  assert.deepEqual(openingFrames(run.frames), [], "no frame, no placeholder");
  assert.equal(openingRows(run.result.events).length, 0);
  assert.equal(run.result.content, "Có 3 bảng.");
});

test("a line still being written when the turn ends is withdrawn, and the turn does not wait out its deadline", async () => {
  const started = performance.now();
  const run = await runOne(hangs("Dạ, em đã nhận"), [answer("Có 3 bảng.")], { instruction: INSTRUCTION });
  assert.ok(performance.now() - started < 2_000, "closed with the turn, not at the 3 s deadline");
  assert.deepEqual(openingFrames(run.frames).map((frame) => frame.type === "assistant-narration-end" ? `end:${frame.status}` : frame.type),
    ["assistant-narration-start", "assistant-narration-delta", "end:discarded"]);
  assert.equal(openingRows(run.result.events).length, 0);
  assert.equal(run.result.content, "Có 3 bảng.");
});

/** A claimed turn with only what the opening line touches. */
function claimed(appends: unknown[], frames: AgentNarrationEvent[], signal = new AbortController().signal): ClaimedTurn {
  return {
    turnId: "turn-1", signal, input: { sessionId: "s", content: "đếm bảng lương", security: security(), onNarration: (frame: AgentNarrationEvent) => frames.push(frame) },
    writer: { append: async (events: unknown) => { appends.push(events); } },
    runtimeLease: { snapshot: { id: "snapshot-1" } },
  } as unknown as ClaimedTurn;
}
const adapterOf = (opening: Opening): LlmAdapter => ({ id: "o", model: "o", stream: (_request, signal) => opening(signal) });

test("past its deadline the line is given up: what was shown is withdrawn and nothing is journaled", async () => {
  const appends: unknown[] = [];
  const frames: AgentNarrationEvent[] = [];
  const line = startOpeningLine(claimed(appends, frames), adapterOf(hangs("Dạ, em")), INSTRUCTION, 30);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.deepEqual(frames.map((frame) => frame.type === "assistant-narration-end" ? `end:${frame.status}` : frame.type),
    ["assistant-narration-start", "assistant-narration-delta", "end:discarded"]);
  assert.deepEqual(appends, []);
  await line.close();
});

test("only the first line is the sentence; leading blank lines are skipped and a reply with no text shows nothing", async () => {
  const appends: { payload: { content: string } }[][] = [];
  const frames: AgentNarrationEvent[] = [];
  const told = (line: ReturnType<typeof startOpeningLine>) => new Promise((resolve) => setTimeout(resolve, 20)).then(() => line.close());
  await told(startOpeningLine(claimed(appends, frames), adapterOf(says("\n  ", "Dạ, em đã nhận.", "\nCâu thứ hai.")), INSTRUCTION));
  assert.equal(appends[0]![0]!.payload.content, "Dạ, em đã nhận.");
  assert.deepEqual(frames.flatMap((frame) => frame.type === "assistant-narration-delta" ? [frame.delta] : []), ["Dạ, em đã nhận."]);
  const silent: AgentNarrationEvent[] = [];
  const none: unknown[] = [];
  await told(startOpeningLine(claimed(none, silent), adapterOf(says(" ", "\n")), INSTRUCTION));
  assert.deepEqual(silent, []);
  assert.deepEqual(none, []);
});
