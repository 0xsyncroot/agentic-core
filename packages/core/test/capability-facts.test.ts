import assert from "node:assert/strict";
import test from "node:test";
import {
  CAPABILITIES, type ContextualToolSource, type JsonValue, type SessionEvent, type ToolDefinition, type TurnControlPolicy, type TurnControlState,
} from "@0xsyncroot/contracts";
import { DefaultAgentLoop, PermissionToolExecutionPolicy, PluginHost, resolveContextualToolSurface } from "@0xsyncroot/core";
import { CONTEXTUAL_TOOL_SOURCE_CAPABILITY, type PluginDescriptor } from "@0xsyncroot/plugin-sdk";
import { activeHost, answer, call, calls, scriptedModel, security, SpyStore, toolPlugin, writeTool } from "./turn-harness.js";

/**
 * What the runtime knows a turn lacks, said as a fact, so a model whose reader is down does not keep calling it and
 * answering that it cannot read the file. A source says it is unavailable, a permission the principal lacks is named,
 * the refused call carries `unavailable`, the policy's state holds
 * both, and the attachment manifest tells the model that no tool can read the files instead of "use the tools that read them".
 */
const SOURCE_ID = "mcp_docs";
const readDocument = (revision: string): ToolDefinition => ({
  id: `${SOURCE_ID}_read_document`, version: "1", description: "reads a document", requiredPermissions: ["docs.read"], sideEffect: "none", timeoutMs: 100,
  inputSchema: { type: "object" }, outputSchema: {}, execute: async () => ({ text: "contents" }) as JsonValue,
  origin: { sourceId: SOURCE_ID, sourceVersion: "1", catalogRevision: revision, nativeId: "read_document", schemaDigest: "d" },
});
const read: ToolDefinition = {
  id: "test_read", version: "1", description: "read", requiredPermissions: [], sideEffect: "none", timeoutMs: 100,
  inputSchema: { type: "object" }, outputSchema: {}, execute: async () => ({ page: 1 }) as JsonValue,
};
const payroll: ToolDefinition = { ...read, id: "test_payroll", requiredPermissions: ["payroll.read", "payroll.export"] };

/** A contextual source the way the MCP connector provides one: down (`unavailable`) or answering with its reader tool. */
function readerSource(state: "down" | "up" | (() => "down" | "up"), readsAttachments = true): PluginDescriptor {
  const now = () => typeof state === "function" ? state() : state;
  const source: ContextualToolSource = {
    id: SOURCE_ID, version: "1", ...(readsAttachments ? { readsAttachments: true } : {}),
    discover: async () => now() === "down" ? { revision: "down", tools: [], unavailable: true } : { revision: "r1", tools: [readDocument("r1")] },
  };
  return {
    trustTier: "platform-core",
    manifest: { manifestVersion: 1, id: "io.syncroot.test.reader", version: "1.0.0", publisher: "test", coreApi: "^1.0.0",
      artifact: { digest: "builtin:reader", signature: "test" }, requires: {},
      provides: { [CAPABILITIES.contextualTools]: { version: "1.0.0", cardinality: "multi" } }, permissions: {} },
    plugin: { validate: async () => ({ valid: true }), activate: async (context) => {
      context.registrations.provide(CONTEXTUAL_TOOL_SOURCE_CAPABILITY, source);
      return { dispose: () => undefined };
    } },
  };
}

const attachments = [{ id: "doc_1", name: "mapping.xlsx", mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", byteSize: 5_941 }];
const manifestOf = (messages: readonly { readonly content?: string | null }[]) => messages.map((message) => message.content ?? "").find((content) => content.startsWith("Attached files"));
const results = (events: readonly SessionEvent[]) => events.filter((event) => event.type === "tool/result").map((event) => event.payload as Record<string, unknown>);

test("discovery keeps what it learned: a source that did not answer, and tools withheld for a permission", async () => {
  const host = new PluginHost();
  await host.activate([readerSource("down"), toolPlugin("tools", [read, payroll])], { security: security(), verifyArtifact: async () => true });
  const lease = host.acquireSnapshot();
  try {
    const surface = await resolveContextualToolSurface(lease.capabilities, { security: security(), runtime: lease.snapshot, sessionId: "s", turnId: "t" },
      new PermissionToolExecutionPolicy(), new AbortController().signal);
    assert.deepEqual(surface.tools.map((tool) => tool.id), ["test_read"]);
    assert.deepEqual(surface.unavailable, {
      sources: [{ sourceId: SOURCE_ID, readsAttachments: true }],
      withheldTools: [{ toolId: "test_payroll", missingPermissions: ["payroll.read", "payroll.export"] }],
    });
    assert.deepEqual(surface.attachmentReaders, [{ sourceId: SOURCE_ID, state: "unavailable" }]);
  } finally { lease.release(); await host.shutdown(); }
});

test("nothing missing: no `unavailable` at all, and a reader whose every tool is withheld is said to be withheld", async () => {
  const host = new PluginHost();
  await host.activate([readerSource("up"), toolPlugin("tools", [read])], { security: security(), verifyArtifact: async () => true });
  const lease = host.acquireSnapshot();
  try {
    const resolve = (permissions: readonly string[]) => resolveContextualToolSurface(lease.capabilities, {
      security: security({ permissions: new Set(permissions) }), runtime: lease.snapshot, sessionId: "s", turnId: "t",
    }, new PermissionToolExecutionPolicy(), new AbortController().signal);
    const granted = await resolve(["docs.read"]);
    assert.equal("unavailable" in granted, false);
    assert.deepEqual(granted.attachmentReaders, [{ sourceId: SOURCE_ID, state: "available" }]);
    const refused = await resolve([]);
    assert.deepEqual(refused.attachmentReaders, [{ sourceId: SOURCE_ID, state: "withheld", missingPermissions: ["docs.read"] }]);
  } finally { lease.release(); await host.shutdown(); }
});

test("a call to a missing capability is refused with why, and marked so the turn can treat the blocker as proven", async () => {
  let seenState: TurnControlState | undefined;
  const policy: TurnControlPolicy = {
    id: "p", revision: "v1", beforeModelStep: async (state) => { seenState ??= state; return {}; }, reviewTerminal: async () => ({ decision: "accept" }),
  };
  const { adapter, requests } = scriptedModel([
    calls([{ id: "c1", name: `${SOURCE_ID}_read_document`, args: { documentId: "doc_1" } }, { id: "c2", name: "test_payroll", args: {} }, { id: "c3", name: "made_up", args: {} }]),
    answer("The file cannot be read right now."),
  ]);
  const { host, router } = await activeHost(adapter, [readerSource("down"), toolPlugin("tools", [read, payroll])]);
  try {
    const result = await new DefaultAgentLoop(router, new SpyStore(), { maxSteps: 4 }, { turnControlPolicy: policy })
      .runTurn({ sessionId: "missing", content: "read the attached file", security: security(), attachments });
    const [reader, withheld, unknown] = results(result.events);
    assert.equal(reader!.unavailable, "source-unavailable");
    assert.equal(reader!.state, "not_started");
    assert.equal(reader!.dispatched, false);
    assert.match(JSON.stringify(reader!.error), /the service it belongs to is unavailable right now/u);
    assert.match(JSON.stringify(reader!.error), /the files they attached cannot be read/u);
    assert.equal(withheld!.unavailable, "withheld");
    assert.match(JSON.stringify(withheld!.error), /needs a permission this account has not been granted/u);
    // No technical id for the model to repeat into the chat: the product names the cause in its own notice.
    assert.doesNotMatch(JSON.stringify(reader!.error), /mcp_docs[^_]|did not answer/u);
    assert.doesNotMatch(JSON.stringify(withheld!.error), /payroll\.read|payroll\.export/u);
    assert.equal(unknown!.unavailable, undefined);
    assert.match(JSON.stringify(unknown!.error), /made_up does not exist in this session/u);
    // The model reads it where it reads every tool outcome.
    assert.match(requests[1]!.messages.find((message) => message.role === "tool" && message.toolCallId === "c1")?.content ?? "", /Do not call it again/u);
    // And the policy holds the same facts, from configuration and policy, not from prose.
    assert.deepEqual(seenState?.unavailable, {
      sources: [{ sourceId: SOURCE_ID, readsAttachments: true }],
      withheldTools: [{ toolId: "test_payroll", missingPermissions: ["payroll.read", "payroll.export"] }],
      attachments: "source-unavailable",
      unreadFiles: [{ id: "doc_1", name: "mapping.xlsx" }],
    });
  } finally { await host.shutdown(); }
});

test("a turn that lacks nothing hands the policy no `unavailable`", async () => {
  let seenState: TurnControlState | undefined;
  const policy: TurnControlPolicy = {
    id: "p", revision: "v1", beforeModelStep: async (state) => { seenState ??= state; return {}; }, reviewTerminal: async () => ({ decision: "accept" }),
  };
  const { adapter } = scriptedModel([answer("ok")]);
  const { host, router } = await activeHost(adapter, [toolPlugin("tools", [read])]);
  try {
    await new DefaultAgentLoop(router, new SpyStore(), { maxSteps: 2 }, { turnControlPolicy: policy }).runTurn({ sessionId: "complete", content: "hi", security: security() });
    assert.ok(seenState);
    assert.equal("unavailable" in seenState, false);
  } finally { await host.shutdown(); }
});

test("the manifest says no tool can read attached files when every reader is down or withheld, and only then", async () => {
  const manifest = async (plugins: readonly PluginDescriptor[], permissions = ["docs.read"]) => {
    const { adapter, requests } = scriptedModel([answer("noted")]);
    const { host, router } = await activeHost(adapter, plugins);
    try {
      await new DefaultAgentLoop(router, new SpyStore(), { maxSteps: 2 })
        .runTurn({ sessionId: "manifest", content: "read it", security: security({ permissions: new Set(permissions) }), attachments });
      return manifestOf(requests[0]!.messages) ?? "";
    } finally { await host.shutdown(); }
  };
  const unreadable = "No tool can read these files in this turn: do not call document tools for them, and tell the user plainly that the files cannot be read right now.";
  const down = await manifest([readerSource("down")]);
  assert.ok(down.includes(unreadable), down);
  assert.match(down, /mapping\.xlsx/u);
  assert.doesNotMatch(down, /mcp_docs|did not answer|, and why/u, "no source id, no guessed cause");
  const withheld = await manifest([readerSource("up")], []);
  assert.ok(withheld.includes(unreadable), withheld);
  assert.doesNotMatch(withheld, /docs\.read/u, "no permission name");
  const usual = "Attached files (references, not contents — use the tools that read them):";
  assert.ok((await manifest([readerSource("up")])).startsWith(usual), "a reader that can read: as always");
  assert.ok((await manifest([readerSource("down", false)])).startsWith(usual), "no source says it reads attachments: the runtime knows nothing, as always");
  assert.ok((await manifest([toolPlugin("tools", [read])])).startsWith(usual));
});

test("one refused call to a down reader, then an answer: the turn is not sent round again", async () => {
  const { adapter, requests } = scriptedModel([call("c1", `${SOURCE_ID}_read_document`, { documentId: "doc_1" }), answer("The file cannot be read right now.")]);
  const { host, router } = await activeHost(adapter, [readerSource("down")]);
  try {
    const result = await new DefaultAgentLoop(router, new SpyStore(), { maxSteps: 48 })
      .runTurn({ sessionId: "down-once", content: "read the attached file", security: security(), attachments });
    assert.equal(result.outcome, "completed");
    assert.equal(requests.length, 2);
  } finally { await host.shutdown(); }
});

test("an earlier request's file is said to be read when a reader read it, and unreadable when none did", async () => {
  // An earlier task's file that was read is said to be read (marked unreadable, it reads as never read); one no reader ever
  // read is said to be unreadable (listed with "use the tools that read them", a follow-up goes looking for readers).
  // Each file is said as what it is, whichever request attached it.
  const { ConversationProjector } = await import("../src/agent/conversation-projector.js");
  const { attachmentsReadability } = await import("../src/agent/attachment-manifest.js");
  let seq = 0;
  const event = (turnId: string, type: string, payload: Record<string, unknown>) =>
    ({ eventId: `e${++seq}`, sessionId: "s", seq, turnId, type, payload }) as unknown as SessionEvent;
  const events = [
    event("t1", "user/input", { content: "reconcile with this file", attachments: [{ id: "doc-1", name: "september.xlsx", mediaType: "text/csv", byteSize: 2048 }] }),
    event("t1", "tool/intent", { callId: "r1", toolId: `${SOURCE_ID}_read_document`, arguments: JSON.stringify({ documentId: "doc-1" }) }),
    event("t1", "tool/result", { callId: "r1", toolId: `${SOURCE_ID}_read_document`, dispatched: true, state: "succeeded", result: { rows: 3 } }),
    event("t2", "user/input", { content: "and this one?", attachments: [{ id: "doc-2", name: "october.xlsx", mediaType: "text/csv", byteSize: 2048 }] }),
  ];
  const down = [{ sourceId: SOURCE_ID, state: "unavailable" as const }];
  // A later task (t3) about something else: told the truth about both files, blocked by neither.
  const later = attachmentsReadability(down, events, ["t3"]);
  assert.deepEqual([[...later!.readEarlier], later!.unavailable], [["doc-1"], undefined]);
  const manifests = new ConversationProjector().project(events, undefined, undefined, new Set(["t3"]), later)
    .map((message) => message.content ?? "").filter((content) => content.startsWith("Attached files"));
  assert.match(manifests[0]!, /They were read earlier in this conversation[\s\S]*september\.xlsx/u, "the earlier task's file a reader read");
  assert.match(manifests[1]!, /No tool can read these files in this turn[\s\S]*october\.xlsx/u, "the earlier task's file nothing read: unreadable now");
  // The task that attached the unread file is blocked by it; so is a later task once one of its calls names it.
  assert.equal(attachmentsReadability(down, events, ["t2"])?.unavailable, "source-unavailable");
  const reached = [...events, event("t3", "tool/intent", { callId: "r2", toolId: `${SOURCE_ID}_read_document`, arguments: JSON.stringify({ documentId: "doc-2" }) })];
  assert.equal(attachmentsReadability(down, reached, ["t3"])?.unavailable, "source-unavailable", "a call of the task named it");
  assert.equal(attachmentsReadability([{ sourceId: SOURCE_ID, state: "available" }], events, ["t2"]), undefined, "a reader that can read: nothing to say");
  assert.equal(attachmentsReadability([{ sourceId: SOURCE_ID, state: "withheld" }], events.slice(0, 3), ["t1"])?.unavailable, undefined, "every file read: no blocker");
});

test("a follow-up request without files of its own: the model is told the earlier file cannot be read; the policy is told nothing of it", async () => {
  // The reader withheld for the account, the first task ended, then "read it again" as a new task: the earlier file is no
  // blocker of a later task until a call of that task names it.
  const states: TurnControlState[] = [];
  const policy: TurnControlPolicy = { id: "p", revision: "v1", reviewTerminal: async () => ({ decision: "accept" }),
    beforeModelStep: async (state) => { states.push(state); return {}; } };
  const { adapter, requests } = scriptedModel([answer("The file cannot be read right now.")]);
  const { host, router } = await activeHost(adapter, [readerSource("up")]);
  try {
    const agent = new DefaultAgentLoop(router, new SpyStore(), { maxSteps: 3 }, { turnControlPolicy: policy });
    await agent.runTurn({ sessionId: "follow-up", content: "summarize this file", security: security({ permissions: new Set() }), attachments });
    const second = await agent.runTurn({ sessionId: "follow-up", content: "read it again", security: security({ permissions: new Set() }) });
    const manifest = manifestOf(requests.at(-1)!.messages) ?? "";
    assert.match(manifest, /No tool can read these files in this turn[\s\S]*mapping\.xlsx/u, manifest);
    const later = states.find((state) => state.turnId === second.turnId)?.unavailable;
    assert.equal(later?.attachments, undefined, "not the task's file");
    assert.deepEqual(later?.unreadFiles, [{ id: "doc_1", name: "mapping.xlsx" }], "but a file of the conversation nothing could read");
    assert.deepEqual(later?.withheldTools.map((tool) => tool.toolId), [`${SOURCE_ID}_read_document`], "the withheld reader is still a fact");
  } finally { await host.shutdown(); }
});

test("the task's files are a fact for the policy too: `unavailable.attachments` says why they cannot be read, and only then", async () => {
  const seen = async (plugins: readonly PluginDescriptor[], permissions: readonly string[], withFiles = true) => {
    let state: TurnControlState | undefined;
    const policy: TurnControlPolicy = { id: "p", revision: "v1", beforeModelStep: async (current) => { state ??= current; return {}; }, reviewTerminal: async () => ({ decision: "accept" }) };
    const { adapter } = scriptedModel([answer("noted")]);
    const { host, router } = await activeHost(adapter, plugins);
    try {
      await new DefaultAgentLoop(router, new SpyStore(), { maxSteps: 2 }, { turnControlPolicy: policy })
        .runTurn({ sessionId: "fact", content: "read it", security: security({ permissions: new Set(permissions) }), ...(withFiles ? { attachments } : {}) });
      return state?.unavailable;
    } finally { await host.shutdown(); }
  };
  assert.equal((await seen([readerSource("down")], ["docs.read"]))?.attachments, "source-unavailable");
  assert.deepEqual(await seen([readerSource("up")], []), {
    sources: [], withheldTools: [{ toolId: `${SOURCE_ID}_read_document`, missingPermissions: ["docs.read"] }], attachments: "withheld",
    unreadFiles: [{ id: "doc_1", name: "mapping.xlsx" }] });
  assert.equal((await seen([readerSource("down")], ["docs.read"], false))?.attachments, undefined, "no files in the task: nothing about them");
  assert.equal(await seen([readerSource("up")], ["docs.read"]), undefined, "a reader that can read: nothing missing");
});

test("files a reader already read in the task are not called unreadable when it is down on the resume", async () => {
  // Read before an approval pause, then the reader goes down: the resume's manifest must not call the files unreadable, or
  // the gate treats the task as unblocked and the model sets aside the rows it already read.
  let reader: "up" | "down" = "up";
  const states: TurnControlState[] = [];
  const policy: TurnControlPolicy = {
    id: "p", revision: "v1", reviewTerminal: async () => ({ decision: "accept" }),
    beforeModelStep: async (state) => { states.push(state); return {}; },
  };
  const { adapter, requests } = scriptedModel([
    call("r1", `${SOURCE_ID}_read_document`, { documentId: "doc_1" }), call("w1", "test_write", { value: "a" }), answer("Written from the file."),
  ]);
  const { host, router } = await activeHost(adapter, [readerSource(() => reader), toolPlugin("write", [writeTool()])]);
  const principal = security({ permissions: new Set(["docs.read", "test.write"]) });
  try {
    const agent = new DefaultAgentLoop(router, new SpyStore(), { maxSteps: 6 }, { turnControlPolicy: policy });
    const paused = await agent.runTurn({ sessionId: "read-then-down", content: "copy the file's total", security: principal, attachments });
    assert.equal(paused.outcome, "awaiting_approval");
    reader = "down";
    const resumed = await agent.resumeTurn({ sessionId: "read-then-down", approvalId: paused.approval!.approvalId, decision: "approve", security: principal, idempotencyKey: "ok" });
    assert.equal(resumed.content, "Written from the file.");
    const resumedState = states.find((state) => state.turnId === resumed.turnId);
    const manifest = manifestOf(requests.at(-1)!.messages) ?? "";
    assert.match(manifest, /They were read earlier in this conversation and cannot be read again in this turn: use the results already read/u);
    assert.doesNotMatch(manifest, /No tool can read these files/u);
    assert.deepEqual(resumedState?.unavailable?.sources, [{ sourceId: SOURCE_ID, readsAttachments: true }], "the reader is still down, as a fact");
    assert.equal(resumedState?.unavailable?.attachments, undefined, "but the files were read: no blocker");
  } finally { await host.shutdown(); }
});

test("read earlier is said of the files that were read, not of every file once one was", async () => {
  // A and B attached, only A read before the pause, the reader down on the resume: the manifest must not say both "were
  // read earlier… use the results already read", since nothing has been read of B to use.
  const two = [attachments[0]!, { id: "doc_2", name: "allowances.xlsx", mediaType: "text/csv", byteSize: 1_024 }];
  let reader: "up" | "down" = "up";
  const states: TurnControlState[] = [];
  const policy: TurnControlPolicy = { id: "p", revision: "v1", reviewTerminal: async () => ({ decision: "accept" }),
    beforeModelStep: async (state) => { states.push(state); return {}; } };
  const { adapter, requests } = scriptedModel([
    call("r1", `${SOURCE_ID}_read_document`, { documentId: "doc_1" }), call("w1", "test_write", { value: "a" }), answer("Only the first file was read."),
  ]);
  const { host, router } = await activeHost(adapter, [readerSource(() => reader), toolPlugin("write", [writeTool()])]);
  const principal = security({ permissions: new Set(["docs.read", "test.write"]) });
  try {
    const agent = new DefaultAgentLoop(router, new SpyStore(), { maxSteps: 6 }, { turnControlPolicy: policy });
    const paused = await agent.runTurn({ sessionId: "read-one", content: "reconcile both files", security: principal, attachments: two });
    reader = "down";
    const resumed = await agent.resumeTurn({ sessionId: "read-one", approvalId: paused.approval!.approvalId, decision: "approve", security: principal, idempotencyKey: "ok" });
    const manifest = manifestOf(requests.at(-1)!.messages) ?? "";
    assert.match(manifest, /Read earlier in this conversation — use the results already read:\n- mapping\.xlsx[^\n]*id=doc_1\nNever read — their contents are unknown; tell the user plainly that these cannot be read right now:\n- allowances\.xlsx[^\n]*id=doc_2/u, manifest);
    assert.doesNotMatch(manifest, /mcp_docs|docs\.read/u);
    assert.equal(states.find((state) => state.turnId === resumed.turnId)?.unavailable?.attachments, "source-unavailable", "one file of the task cannot be read: a blocker");
  } finally { await host.shutdown(); }
});
