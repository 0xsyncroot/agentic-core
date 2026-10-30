import assert from "node:assert/strict";
import test from "node:test";
import { createEchoToolPlugin } from "@0xsyncroot/adapter-echo";
import type { IdentityEvidence, LlmAdapter, LlmStreamEvent, TurnControlPolicy } from "@0xsyncroot/contracts";
import { DefaultAgentLoop } from "@0xsyncroot/core";
import { InMemorySessionStore } from "@0xsyncroot/persistence-memory";
import { createSystemPromptPlugin } from "@0xsyncroot/plugins-base";
import { activeHost, security } from "../../core/test/turn-harness.js";
import { createAgentApiFastify } from "../src/fastify/agent-api-fastify.js";

// Items differ as a real list's do: one line repeated word for word is a looping generation, and the runtime cuts it (AnswerBound).
const DRAFT = `Em đã nhặt xong danh mục.\n${Array.from({ length: 110 }, (_, i) => `- Nhiệm vụ ${i + 1}: chi thường xuyên theo biểu chi tiết của hồ sơ.\n`).join("")}`.trim();
const BESIDE_CALL = "Em trình danh mục để anh/chị kiểm tra và xác nhận lưu.";
const ANSWER = "Danh mục gồm 3 nhiệm vụ: A, B, C.";

/** A draft answer in chunks, then text beside a call, then the answer: the three steps a send-back turn takes. */
function model(): LlmAdapter {
  let call = 0;
  return {
    id: "kept-draft", model: "kept-draft",
    async *stream(): AsyncIterable<LlmStreamEvent> {
      call += 1;
      const content = call === 1 ? DRAFT : call === 2 ? BESIDE_CALL : ANSWER;
      for (let at = 0; at < content.length; at += 1_500) yield { type: "text-delta", delta: content.slice(at, at + 1_500) };
      if (call === 2) yield { type: "final", content, toolCalls: [{ id: "write", name: "agentic_echo", arguments: '{"value":"write"}' }], finishReason: "tool_calls" };
      else yield { type: "final", content, toolCalls: [], finishReason: "stop", status: "completed" };
    },
  };
}

/** Sends the long draft back at terminal review and refuses the call at tool-call review, once each. */
function sendingBack(keepDraftsAsNarration: boolean): TurnControlPolicy {
  return {
    id: "test.unfinished-work", revision: "v1", ...(keepDraftsAsNarration ? { keepDraftsAsNarration } : {}),
    beforeModelStep: async () => ({}),
    reviewTerminal: async ({ candidate }) => candidate.content === DRAFT ? { decision: "continue", feedback: "Two sheets are still unread." } : { decision: "accept" },
    reviewToolCalls: async () => ({ decision: "continue", feedback: "Read the remaining pages before writing." }),
  };
}

interface Frame { readonly event: string; readonly data: Record<string, unknown> }

async function stream(policy: TurnControlPolicy): Promise<readonly Frame[]> {
  const { host, router } = await activeHost(model(), [createSystemPromptPlugin(), createEchoToolPlugin()]);
  const sessions = new InMemorySessionStore();
  const app = createAgentApiFastify({
    agent: new DefaultAgentLoop(router, sessions, { maxSteps: 6 }, { turnControlPolicy: policy }),
    identityResolver: { resolve: async (evidence: IdentityEvidence) => security({ correlationId: evidence.correlationId }) },
    sessions,
  });
  try {
    const response = await app.inject({ method: "POST", url: "/api/chat/stream", payload: { content: "work", sessionId: "kept-draft-session", requestId: "kept-draft-request" } });
    assert.equal(response.statusCode, 200);
    return response.body.split("\n\n").flatMap((block): Frame[] => {
      const event = /^event: (.+)$/mu.exec(block)?.[1];
      const data = /^data: (.+)$/mu.exec(block)?.[1];
      return event && data ? [{ event, data: JSON.parse(data) as Record<string, unknown> }] : [];
    });
  } finally {
    await app.close();
    await host.shutdown();
  }
}

test("a policy send-back keeps the streamed draft on the wire as narration: no retraction, no revision notice, nothing discarded for length", async () => {
  const frames = await stream(sendingBack(true));
  const names = frames.map((frame) => frame.event);
  // The answer was typed out as the model wrote it — several deltas, before anything was decided about it.
  const firstOutput = frames.find((frame) => frame.event === "assistant-output-start")!.data.outputId;
  const firstNarration = frames.findIndex((frame) => frame.event === "assistant-narration-start");
  assert.ok(frames.slice(0, firstNarration).filter((frame) => frame.event === "assistant-output-delta" && frame.data.outputId === firstOutput).length >= 4, "progressive deltas");
  assert.equal(frames.some((frame) => frame.data.type === "answer-revision-requested"), false);
  assert.equal(frames.some((frame) => frame.event === "assistant-narration-end" && frame.data.status === "discarded"), false);
  // Every draft that ended discarded is preceded by a completed narration under the same id.
  const discarded = frames.flatMap((frame, index) => frame.event === "assistant-output-end" && frame.data.status === "discarded" ? [index] : []);
  assert.equal(discarded.length, 2, "the terminal draft and the text beside the refused call");
  for (const index of discarded) {
    const id = frames[index]!.data.outputId;
    assert.deepEqual(names.slice(index - 3, index), ["assistant-narration-start", "assistant-narration-delta", "assistant-narration-end"]);
    assert.ok(frames.slice(index - 3, index).every((frame) => frame.data.narrationId === id), "same id as the draft it replaces");
    assert.equal(frames[index - 1]!.data.status, "completed");
  }
  const narrated = frames.filter((frame) => frame.event === "assistant-narration-delta").map((frame) => frame.data.delta);
  assert.deepEqual(narrated, [DRAFT, BESIDE_CALL], "the ~6 000-character draft crossed whole");
  assert.ok(DRAFT.length > 6_000 && DRAFT.length < 20_000);
  const result = frames.find((frame) => frame.event === "result")!.data;
  assert.equal(result.content, ANSWER);
  assert.equal(result.outcome, "completed");
  assert.equal(names.filter((name) => name === "assistant-output-end").length, 3);
  assert.equal(frames.findLast((frame) => frame.event === "assistant-output-end")!.data.status, "completed");
});

test("without the flag the same send-backs retract the draft and announce the revision, as before", async () => {
  const frames = await stream(sendingBack(false));
  assert.equal(frames.filter((frame) => frame.data.type === "answer-revision-requested").length, 1);
  assert.equal(frames.some((frame) => frame.event.startsWith("assistant-narration")), false);
  assert.deepEqual(frames.filter((frame) => frame.event === "assistant-output-end").map((frame) => frame.data.status), ["discarded", "discarded", "completed"]);
});
