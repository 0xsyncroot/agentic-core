import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AgenticError, type JudgmentAnswer, type JudgmentPort, type JudgmentRequest, type JudgmentResult,
  type KnowledgeDocument, type SecurityContext,
} from "@0xsyncroot/contracts";
import { InMemoryKnowledgeService, JudgedKnowledgeService, type JudgedKnowledgeServiceOptions } from "@0xsyncroot/plugins-base";

const security: SecurityContext = {
  tenantId: "tenant-a", actorId: "user-a", permissions: new Set(["*"]), correlationId: "judged-test", purpose: "test",
};

/** Lexical order for the query "alpha beta": doc-a (2 matching words) > doc-b (1) > doc-c (1, later id). */
function document(id: string, content: string): KnowledgeDocument {
  return { id, title: id, content, sourceRef: `${id}.md`, contentHash: `hash-${id}`, classification: "internal" };
}
const documents = [
  document("doc-a", "alpha beta together"),
  document("doc-b", "alpha alone"),
  document("doc-c", "beta alone"),
];
const inner = new InMemoryKnowledgeService(documents);
const QUERY = "alpha beta";

function noul(value: number): JudgmentAnswer { return { type: "noul", noul: value }; }

/** A fake judgment provider that scores candidates by `values[title]`, answering with the documented shape. */
function judgeWith(values: Record<string, number>, seen: JudgmentRequest[] = []): JudgmentPort {
  return {
    providerId: "fake", model: "fake-latest",
    async judge(request): Promise<JudgmentResult> {
      seen.push(request);
      const candidates = (request.state as { candidates: Array<{ title: string }> }).candidates;
      return {
        modelId: "fake-1",
        answers: Object.fromEntries(candidates.map((candidate, index) => [`c${index}`, noul(values[candidate.title] ?? 0)])),
      };
    },
  };
}
function failing(error: unknown): JudgmentPort {
  return { providerId: "fake", model: "fake-1", async judge() { throw error; } };
}
const hanging: JudgmentPort = { providerId: "fake", model: "fake-1", judge: () => new Promise(() => undefined) };

test("the output follows judgment provider, not the lexical order", async () => {
  assert.deepEqual((await inner.search(QUERY, 3, security)).map((hit) => hit.documentId), ["doc-a", "doc-b", "doc-c"]);
  const seen: JudgmentRequest[] = [];
  const events: unknown[] = [];
  const service = new JudgedKnowledgeService(inner, judgeWith({ "doc-a": 0.1, "doc-b": 0.5, "doc-c": 0.9 }, seen), {
    onJudged: (info) => events.push(info),
  });
  const hits = await service.search(QUERY, 3, security);
  assert.deepEqual(hits.map((hit) => hit.documentId), ["doc-c", "doc-b", "doc-a"]);
  assert.deepEqual(hits.map((hit) => hit.score), [0.9, 0.5, 0.1]);
  assert.equal(seen.length, 1, "one judge request per search");
  assert.deepEqual(Object.keys(seen[0]!.questions), ["c0", "c1", "c2"]);
  assert.equal((seen[0]!.state as { query: string }).query, QUERY);
  assert.equal(events.length, 1);
  assert.deepEqual({ ...(events[0] as object), elapsedMs: 0 }, { queryChars: QUERY.length, candidates: 3, modelId: "fake-1", elapsedMs: 0, reordered: true });
  assert.equal(JSON.stringify(events).includes(QUERY), false, "the query text never reaches a callback");
});

test("ties keep the inner order and reordered is false when judgment provider agrees", async () => {
  const events: Array<{ reordered: boolean }> = [];
  const service = new JudgedKnowledgeService(inner, judgeWith({ "doc-a": 0.5, "doc-b": 0.5, "doc-c": 0.5 }), { onJudged: (info) => events.push(info) });
  assert.deepEqual((await service.search(QUERY, 3, security)).map((hit) => hit.documentId), ["doc-a", "doc-b", "doc-c"]);
  assert.equal(events[0]!.reordered, false);
});

test("limit trims after reordering and the shortlist is at least limit wide", async () => {
  const service = new JudgedKnowledgeService(inner, judgeWith({ "doc-a": 0, "doc-b": 0.2, "doc-c": 1 }), { shortlist: 3 });
  assert.deepEqual((await service.search(QUERY, 2, security)).map((hit) => hit.documentId), ["doc-c", "doc-b"]);
  const narrow = new JudgedKnowledgeService(inner, judgeWith({ "doc-a": 0, "doc-b": 0, "doc-c": 1 }), { shortlist: 1 });
  assert.deepEqual((await narrow.search(QUERY, 3, security)).map((hit) => hit.documentId), ["doc-c", "doc-a", "doc-b"], "limit widens the shortlist");
});

test("score is the noul rounded to 0.01, within [0,1]", async () => {
  const service = new JudgedKnowledgeService(inner, judgeWith({ "doc-a": 0.123456, "doc-b": 1.7, "doc-c": -0.4 }));
  const hits = await service.search(QUERY, 3, security);
  assert.deepEqual(hits.map((hit) => [hit.documentId, hit.score]), [["doc-b", 1], ["doc-a", 0.12], ["doc-c", 0]]);
  for (const hit of hits) assert.ok(hit.score >= 0 && hit.score <= 1);
});

async function failsOpen(judge: JudgmentPort, options: JudgedKnowledgeServiceOptions = {}, effectiveDeadlineMs = options.deadlineMs ?? 1_200) {
  const failures: Array<{ queryChars: number; candidates: number; elapsedMs: number; error: unknown }> = [];
  const service = new JudgedKnowledgeService(inner, judge, { ...options, onJudgmentFailure: (info) => failures.push(info) });
  const started = Date.now();
  const hits = await service.search(QUERY, 2, security);
  assert.ok(Date.now() - started <= effectiveDeadlineMs + 100, `answered within deadlineMs + 100 (took ${Date.now() - started})`);
  assert.deepEqual(hits, (await inner.search(QUERY, 2, security)), "the inner order is returned unchanged");
  assert.equal(failures.length, 1);
  assert.equal(failures[0]!.queryChars, QUERY.length);
  assert.equal(failures[0]!.candidates, 3);
  return failures[0]!;
}

test("fails open on 401", async () => {
  const failure = await failsOpen(failing(new AgenticError("permanent", "TypeSafe request failed (401): unauthorized")));
  assert.equal((failure.error as AgenticError).code, "permanent");
});

test("fails open on 529", async () => {
  const failure = await failsOpen(failing(new AgenticError("transient", "TypeSafe request failed (529): overloaded", true)));
  assert.equal((failure.error as AgenticError).code, "transient");
});

test("fails open at the deadline, aborting the provider call", async () => {
  let signal: AbortSignal | undefined;
  const judge: JudgmentPort = { providerId: "fake", model: "fake-1", judge: (_request, given) => { signal = given; return new Promise(() => undefined); } };
  await failsOpen(judge, { deadlineMs: 80 });
  assert.equal(signal?.aborted, true);
});

test("the deadline is clamped to 1500 ms", async () => {
  await failsOpen(hanging, { deadlineMs: 60_000 }, 1_500);
});

test("fails open on a missing or mistyped answer", async () => {
  const missing: JudgmentPort = { providerId: "fake", model: "fake-1", async judge() { return { modelId: "m", answers: { c0: noul(1), c1: noul(0.9) } }; } };
  await failsOpen(missing);
  const mistyped: JudgmentPort = {
    providerId: "fake", model: "fake-1",
    async judge() {
      return { modelId: "m", answers: { c0: noul(1), c1: noul(1), c2: { type: "choice", choice: "x", probabilities: {}, confidence: 1 } } };
    },
  };
  await failsOpen(mistyped);
});

test("a shortlist of one or none skips judgment provider", async () => {
  let calls = 0;
  const counting: JudgmentPort = { providerId: "fake", model: "fake-1", async judge() { calls += 1; throw new Error("must not be called"); } };
  const service = new JudgedKnowledgeService(inner, counting);
  const single = await service.search("together", 5, security);
  assert.deepEqual(single.map((hit) => hit.documentId), ["doc-a"]);
  assert.equal(single[0]!.score, (await inner.search("together", 5, security))[0]!.score, "the inner score is untouched");
  assert.deepEqual(await service.search("zzz", 5, security), []);
  assert.equal(calls, 0);
});

test("read() delegates to the inner service", async () => {
  const service = new JudgedKnowledgeService(inner, failing(new Error("unused")));
  const range = { startLine: 1, endLine: 5 };
  assert.deepEqual(await service.read("doc-a", range, security), await inner.read("doc-a", range, security));
  assert.equal(await service.read("missing", range, security), null);
});
