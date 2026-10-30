import assert from "node:assert/strict";
import { test } from "node:test";
import { createEchoToolPlugin } from "@0xsyncroot/adapter-echo";
import type { ChatMessage, TurnControlPolicy } from "@0xsyncroot/contracts";
import { DefaultAgentLoop } from "@0xsyncroot/core";
import { SpyStore, activeHost, answer, call, scriptedModel, security } from "./turn-harness.js";

/**
 * The objection to the answer just written is read where the model writes next.
 *
 * Every system message goes to the front of the request except the step's own instructions. Sent
 * there, a turn-control objection sits under the whole system prompt while the last thing the model
 * reads is the budget notice's "otherwise answer now", and the model answers into the objection until
 * the turn ends for making no progress. Once the model has acted on the objection — a step with tool
 * calls — it is history, and goes back to the front with the others.
 */

const OBJECTION = "OBJECTION-READ-AGAIN";

function objectingOnce(): TurnControlPolicy {
  let objected = false;
  return {
    id: "test.objection", revision: "v1", beforeModelStep: async () => ({}),
    reviewTerminal: async () => {
      if (objected) return { decision: "accept" };
      objected = true;
      return { decision: "continue", feedback: OBJECTION };
    },
  };
}

const at = (messages: readonly ChatMessage[], text: string) => messages.findIndex((message) => message.content?.includes(text));
const lastNonSystem = (messages: readonly ChatMessage[]) => messages.findLastIndex((message) => message.role !== "system");

test("the newest objection follows the conversation until the model acts on it, then is not sent again", async () => {
  const { adapter, requests } = scriptedModel([answer("draft"), call("c1", "agentic_echo", { value: "again" }), answer("done")]);
  const { host, router } = await activeHost(adapter, [createEchoToolPlugin()]);
  try {
    const result = await new DefaultAgentLoop(router, new SpyStore(), {}, { turnControlPolicy: objectingOnce() })
      .runTurn({ sessionId: "objection-position", content: "read", security: security() });
    assert.equal(result.outcome, "completed");
    const answering = requests[1]!.messages;
    assert.ok(at(answering, OBJECTION) > lastNonSystem(answering),
      `the objection comes after the conversation: at ${at(answering, OBJECTION)}, conversation ends at ${lastNonSystem(answering)}`);
    // Rejoining the front would hoist it into the system prompt: the prefix would change every lap and the objection stand
    // as a standing rule.
    const after = requests[2]!.messages;
    assert.equal(at(after, OBJECTION), -1, "once answered by a tool step, the objection is not sent again");
    assert.equal(after[0]!.content, requests[1]!.messages[0]!.content, "the system prompt is the same on every step");
  } finally { await host.shutdown(); }
});
