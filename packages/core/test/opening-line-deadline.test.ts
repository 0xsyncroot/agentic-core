import assert from "node:assert/strict";
import test from "node:test";
import type { AgentNarrationEvent, LlmAdapter } from "@0xsyncroot/contracts";
import { DefaultAgentLoop, OPENING_LINE_PROVENANCE } from "@0xsyncroot/core";
import { activeHost, answer, security, SpyStore } from "./turn-harness.js";

/**
 * An adapter whose opening stream ignores its abort signal cannot hold the turn or keep speaking: once the turn ends (or the
 * line's deadline passes) the wait for its next word is given up, nothing it says later is shown, and the line on screen is
 * withdrawn.
 */
const LATE_MS = 1_500;

test("an opening stream that ignores its abort neither holds the turn's end nor shows a word after it", async () => {
  const frames: AgentNarrationEvent[] = [];
  const adapter: LlmAdapter = {
    id: "deaf", model: "deaf", plainParameters: {},
    async *stream(request) {
      if (request.messages[0]?.context?.provenance === OPENING_LINE_PROVENANCE) {
        yield { type: "text-delta", delta: "Em đã nhận" };
        await new Promise((resolve) => setTimeout(resolve, LATE_MS));
        yield { type: "text-delta", delta: " yêu cầu." };
        return;
      }
      // The turn's own step waits until the first word is on screen, then answers at once.
      while (!frames.some((frame) => frame.type === "assistant-narration-delta")) await new Promise((resolve) => setImmediate(resolve));
      yield answer("Xong.")();
    },
  };
  const { host, router } = await activeHost(adapter, []);
  try {
    const started = performance.now();
    const result = await new DefaultAgentLoop(router, new SpyStore(), {}, { modelInstructions: { openingLine: "One sentence." } })
      .runTurn({ sessionId: `deaf-${Math.random()}`, content: "đếm bảng", security: security(), onNarration: (frame) => { frames.push(frame); } });
    const took = performance.now() - started;
    assert.equal(result.outcome, "completed");
    assert.ok(took < LATE_MS / 2, `the turn ended without waiting for the stream (${Math.round(took)} ms)`);
    const opening = frames.filter((frame) => frame.narrationId.startsWith("opening:"))
      .map((frame) => [frame.type, (frame as { delta?: string }).delta ?? (frame as { status?: string }).status ?? ""]);
    assert.deepEqual(opening, [["assistant-narration-start", ""], ["assistant-narration-delta", "Em đã nhận"], ["assistant-narration-end", "discarded"]]);
    assert.equal(result.events.some((event) => event.type === "assistant/narration"), false, "nothing is journaled");
    await new Promise((resolve) => setTimeout(resolve, LATE_MS));
    assert.equal(frames.filter((frame) => frame.narrationId.startsWith("opening:")).length, 3, "the late word is never shown");
  } finally { await host.shutdown(); }
});
