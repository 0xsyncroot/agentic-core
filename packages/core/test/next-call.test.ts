import assert from "node:assert/strict";
import test from "node:test";
import { AgenticError, CAPABILITIES, TOOL_EXECUTION_RESPONSE_PROTOCOL, type JsonValue, type JudgmentPort, type JudgmentRequest, type SessionEvent, type ToolDefinition, type ToolNextCall, type TurnAttachment } from "@0xsyncroot/contracts";
import { DefaultAgentLoop, type JudgmentSeamMode } from "@0xsyncroot/core";
import { JUDGMENT_CAPABILITY, type PluginDescriptor } from "@0xsyncroot/plugin-sdk";
import { activeHost, answer, call, calls, scriptedModel, security, SpyStore, toolPlugin } from "./turn-harness.js";

/**
 * A read a tool names from its own result (`nextCall`, with what it `reads`) is made by the runtime before the next model
 * call when the facts allow it (offered, changes nothing, same source, says what it reads, not made yet, within the turn's
 * bound, never from a runtime read) and every one of five narrow questions, each asked in its own judge call, clears it. In
 * shadow the judge is asked and nothing runs.
 */
const CLEAR: Readonly<Record<string, number>> = { needsFile: 0.97, fileIsTarget: 0.96, sheetIsTarget: 0.95, previewEnough: 0.03, userStopped: 0.02 };
const judging = (values: Readonly<Record<string, number | undefined>>, asked: JudgmentRequest[] = []): PluginDescriptor => ({
  trustTier: "platform-core",
  manifest: { manifestVersion: 1, id: "io.syncroot.test.judgment", version: "1.0.0", publisher: "test", coreApi: "^1.0.0",
    artifact: { digest: "builtin:judgment", signature: "test" }, requires: {},
    provides: { [CAPABILITIES.judgment]: { version: "1.0.0", cardinality: "single" } }, permissions: {} },
  plugin: { validate: async () => ({ valid: true }), activate: async (context) => {
    const port: JudgmentPort = { providerId: "fake", model: "fake", judge: async (request) => {
      asked.push(request);
      const id = Object.keys(request.questions)[0]!;
      const value = values[id];
      if (value === undefined) throw new AgenticError("permanent", `no answer for ${id}`);
      return { modelId: "fake", answers: { [id]: { type: "noul", noul: value } } };
    } };
    context.registrations.provide(JUDGMENT_CAPABILITY, port);
    return { dispose: () => undefined };
  } },
});
const READS = { source: { id: "d1", name: "Luong T9.xlsx", heading: "BANG LUONG THANG 9" }, unit: "sheet",
  catalog: [{ name: "T9", heading: "BANG LUONG THANG 9", rows: 120 }, { name: "T8", rows: 118 }], target: "T9", shown: { rows: 10, of: 120 } };
const WHOLE: ToolNextCall = { toolId: "table_read", arguments: { documentId: "d1", all: true }, why: "the preview shows 10 of 120 rows", reads: READS };
const docRead = (next: unknown = WHOLE, origin?: string): ToolDefinition => ({
  id: "doc_read", version: "1", description: "read a document", requiredPermissions: [], sideEffect: "none", timeoutMs: 100,
  inputSchema: { type: "object" }, outputSchema: {},
  ...(origin ? { origin: { sourceId: origin, sourceVersion: "1", catalogRevision: "1", nativeId: "read_document", schemaDigest: "x" } } : {}),
  execute: async () => ({ protocol: TOOL_EXECUTION_RESPONSE_PROTOCOL, kind: "completed", result: { rows: 10, nextOffset: 10 }, nextCall: next as ToolNextCall }),
});
let tableReads = 0;
const tableRead = (overrides: Partial<ToolDefinition> = {}): ToolDefinition => ({
  id: "table_read", version: "1", description: "read a whole table", requiredPermissions: [], sideEffect: "none", timeoutMs: 100,
  inputSchema: { type: "object" }, outputSchema: {},
  execute: async (invocation) => {
    tableReads += 1;
    // A runtime-made read naming one more read: never followed.
    return { protocol: TOOL_EXECUTION_RESPONSE_PROTOCOL, kind: "completed", result: { rows: 120, read: tableReads, args: invocation.arguments },
      nextCall: { toolId: "table_read", arguments: { documentId: "d2", all: true }, why: "chained", reads: { ...READS, source: { id: "d2", name: "x" } } } };
  },
  ...overrides,
});
const FILE: TurnAttachment = { id: "d1", name: "Luong T9.xlsx", mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", byteSize: 2_048 };

async function run(options: { readonly mode?: JudgmentSeamMode; readonly values?: Readonly<Record<string, number | undefined>>; readonly tools?: readonly ToolDefinition[];
  readonly script?: Parameters<typeof scriptedModel>[0]; readonly steps?: number; readonly sources?: Readonly<Record<string, string>> }) {
  tableReads = 0;
  const asked: JudgmentRequest[] = [];
  const { adapter, requests } = scriptedModel(options.script ?? [call("d", "doc_read", { documentId: "d1" }), answer("120 rows.")]);
  const store = new SpyStore();
  const { host, router } = await activeHost(adapter, [toolPlugin("tools", options.tools ?? [docRead(), tableRead()]), judging(options.values ?? CLEAR, asked)]);
  try {
    await new DefaultAgentLoop(router, store, options.steps ? { maxSteps: options.steps, initialStepBudget: options.steps } : {},
      { judgmentSeams: { nextCall: options.mode ?? "on" }, ...(options.sources ? { nextCallSources: options.sources } : {}) })
      .runTurn({ sessionId: "next-call", content: "sum every row of sheet T9 in the attached file", security: security(), attachments: [FILE] });
    const events = await store.inner.load("next-call", security());
    return { requests, events, asked, runtime: runtimeIntents(events) };
  } finally { await host.shutdown(); }
}
const runtimeIntents = (events: readonly SessionEvent[]) => events.filter((event) => event.type === "tool/intent")
  .map((event) => event.payload as Record<string, unknown>).filter((intent) => intent.policyId === "runtime:next-call");
const judgments = (events: readonly SessionEvent[]) => events.filter((event) => event.type === "judgment/classified" &&
  (event.payload as { seam?: string }).seam === "next-call").map((event) => event.payload as Record<string, unknown>);
const verdictOf = (row: Record<string, unknown> | undefined) => (row?.verdict ?? {}) as Record<string, unknown>;
const askedIds = (asked: readonly JudgmentRequest[]) => asked.map((request) => Object.keys(request.questions)).sort();

test("on, every question clears: five calls, one row each, and the runtime reads the whole table once as its own best-effort read", async () => {
  const { requests, events, asked, runtime } = await run({ sources: { screen: "the software open in the browser" } });
  assert.equal(runtime.length, 1);
  assert.deepEqual(JSON.parse(String(runtime[0]!.arguments)), WHOLE.arguments);
  assert.equal(runtime[0]!.bestEffort, true);
  assert.equal(runtime[0]!.reason, WHOLE.why);
  assert.equal(tableReads, 1, "the runtime-made read's own nextCall is never followed");
  const second = requests[1]!.messages.map((message) => message.content ?? "").join("\n");
  assert.match(second, /performed by the runtime, not by you — tool table_read .*\(the preview shows 10 of 120 rows\)/u);
  assert.match(second, /"rows":120/u);
  assert.deepEqual(askedIds(asked), [["fileIsTarget"], ["needsFile"], ["previewEnough"], ["sheetIsTarget"], ["userStopped"]], "one question per call");
  const state = (id: string) => asked.find((request) => request.questions[id])!.state as Record<string, unknown>;
  assert.deepEqual(state("needsFile"), { request: "sum every row of sheet T9 in the attached file",
    sources: { attachedFiles: [{ id: "d1", name: "Luong T9.xlsx" }], screen: "the software open in the browser" } });
  assert.deepEqual(state("fileIsTarget").target, { id: "d1", name: "Luong T9.xlsx", heading: "BANG LUONG THANG 9", sheets: ["T9", "T8"] });
  assert.deepEqual(state("sheetIsTarget"), { request: "sum every row of sheet T9 in the attached file", source: { name: "Luong T9.xlsx", sheets: READS.catalog }, target: { sheet: "T9" } });
  assert.deepEqual(state("previewEnough").readSoFar, { result: { rows: 10, nextOffset: 10 }, shown: { rows: 10, of: 120 } }, "a small result is read whole");
  assert.deepEqual(state("userStopped"), { messages: ["sum every row of sheet T9 in the attached file"] });
  const rows = judgments(events);
  assert.equal(rows.length, 5);
  for (const row of rows) {
    const verdict = verdictOf(row);
    assert.equal(verdict.label, "run");
    assert.match(String(verdict.item), /^(needsFile|fileIsTarget|sheetIsTarget|previewEnough|userStopped) table_read \{"documentId":"d1","all":true\}$/u);
    assert.equal(verdict.threshold, /^(previewEnough|userStopped) /u.test(String(verdict.item)) ? 0.1 : 0.9);
  }
});

test("one question that does not clear, or one missing answer, and nothing runs", async () => {
  for (const [id, value] of [["needsFile", 0.6], ["fileIsTarget", 0.89], ["sheetIsTarget", 0.5], ["previewEnough", 0.4], ["userStopped", 0.11]] as const) {
    const { runtime, asked, events } = await run({ values: { ...CLEAR, [id]: value } });
    assert.equal(runtime.length, 0, `${id} at ${value} stops the read`);
    assert.equal(asked.length, 5, "every question is still asked");
    assert.equal(verdictOf(judgments(events).find((row) => String(verdictOf(row).item).startsWith(`${id} `))).label, "skip");
  }
  const missing = await run({ values: { ...CLEAR, previewEnough: undefined } });
  assert.equal(missing.runtime.length, 0, "a failed judge call is no answer, and no answer is no run");
  assert.equal(judgments(missing.events).filter((row) => row.outcome === "failed").length, 1);
});

test("shadow asks all five and journals them, and runs nothing", async () => {
  const shadow = await run({ mode: "shadow" });
  assert.equal(shadow.runtime.length, 0);
  assert.equal(shadow.asked.length, 5);
  assert.deepEqual(judgments(shadow.events).map((row) => [verdictOf(row).mode, verdictOf(row).label]), Array(5).fill(["shadow", "run"]));
});

test("a call that does not say what it reads is asked nothing and run never; a malformed reads is dropped and the call kept", async () => {
  const { reads: _, ...bare } = WHOLE;
  const without = await run({ tools: [docRead(bare), tableRead()] });
  assert.equal(without.runtime.length + without.asked.length + judgments(without.events).length, 0);
  const malformed = await run({ tools: [docRead({ ...WHOLE, reads: { ...READS, target: "T7" } }), tableRead()] });
  assert.equal(malformed.runtime.length + malformed.asked.length, 0);
  assert.deepEqual((malformed.events.find((event) => event.type === "tool/result")?.payload as { nextCall?: unknown }).nextCall, bare);
});

test("facts rule a call out before the judge is asked: a write, another source, a call already made, a malformed hint", async () => {
  const write = await run({ tools: [docRead(), tableRead({ sideEffect: "idempotent", requiredPermissions: ["test.write"] })] });
  assert.equal(write.runtime.length + write.asked.length, 0, "a tool that changes something is never called in the model's place");
  const otherSource = await run({ tools: [docRead(WHOLE, "server-a"), tableRead()] });
  assert.equal(otherSource.runtime.length + otherSource.asked.length, 0, "a tool may name only a tool of its own source");
  const sameSource = await run({ tools: [docRead(WHOLE, "server-a"), tableRead({ origin: { sourceId: "server-a", sourceVersion: "1", catalogRevision: "1", nativeId: "read_table", schemaDigest: "y" } })] });
  assert.equal(sameSource.runtime.length, 1);
  const made = await run({ tools: [docRead(), tableRead({ execute: async () => ({ rows: 120 }) as JsonValue })], script: [calls([{ id: "d", name: "doc_read", args: {} }, { id: "t", name: "table_read", args: { all: true, documentId: "d1" } }]), answer("Done.")] });
  assert.equal(made.runtime.length + made.asked.length, 0, "the model already made that call");
  const malformed = await run({ tools: [docRead({ toolId: "table_read", arguments: ["d1"], why: "x", reads: READS }), tableRead()] });
  assert.equal(malformed.runtime.length + malformed.asked.length, 0);
  assert.equal((malformed.events.find((event) => event.type === "tool/result")?.payload as { nextCall?: unknown }).nextCall, undefined);
});

test("a turn makes at most two such reads, and never follows a read the runtime made", async () => {
  const many = (n: number) => call(`d${n}`, "doc_read", { n });
  const docs: ToolDefinition = { ...docRead(), execute: async (invocation) => ({ protocol: TOOL_EXECUTION_RESPONSE_PROTOCOL, kind: "completed",
    result: { rows: 10, n: (invocation.arguments as { n: number }).n },
    nextCall: { toolId: "table_read", arguments: { documentId: String((invocation.arguments as { n: number }).n), all: true }, why: "cut", reads: READS } }) };
  const bounded = await run({ tools: [docs, tableRead()], script: [many(1), many(2), many(3), many(4), answer("Done.")], steps: 10 });
  assert.equal(bounded.runtime.length, 2);
  // The runtime's read names one more; the model works on with a call of its own, and the named read is not made.
  const other: ToolDefinition = { ...tableRead(), id: "note_read", execute: async () => ({ note: "x" }) as JsonValue };
  const chained = await run({ tools: [docRead(), tableRead(), other], script: [call("d", "doc_read", {}), call("o", "note_read", {}), answer("Done.")], steps: 10 });
  assert.equal(chained.runtime.length, 1);
  assert.equal(tableReads, 1);
});

test("without a judge, or with the seam off, nothing is asked or run", async () => {
  const off = await run({ mode: "off" });
  assert.equal(off.runtime.length + off.asked.length, 0);
  const { adapter } = scriptedModel([call("d", "doc_read", {}), answer("Done.")]);
  const store = new SpyStore();
  const { host, router } = await activeHost(adapter, [toolPlugin("tools", [docRead(), tableRead()])]);
  try {
    await new DefaultAgentLoop(router, store, {}, { judgmentSeams: { nextCall: "on" } }).runTurn({ sessionId: "no-judge", content: "read", security: security() });
    assert.equal(runtimeIntents(await store.inner.load("no-judge", security())).length, 0);
  } finally { await host.shutdown(); }
});
