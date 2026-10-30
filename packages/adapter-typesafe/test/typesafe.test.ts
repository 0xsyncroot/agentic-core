import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AgenticError, type JudgmentRequest } from "@0xsyncroot/contracts";
import { InMemoryKnowledgeService, JudgedKnowledgeService } from "@0xsyncroot/plugins-base";
import { TypeSafeJudgmentAdapter, loadTypeSafeJudgmentConfig } from "../src/index.js";

const KEY = "ts-test-key-0123456789abcdef";
const request: JudgmentRequest = {
  state: { query: "q", candidates: [{ title: "a" }, { title: "b" }] },
  questions: {
    c0: { type: "noul", instructions: "Is `candidates[0]` relevant to `query`?" },
    c1: { type: "choice", instructions: "pick", criteria: { x: "one", y: null } },
  },
};
const okBody = {
  model: "jev-1.13.0",
  answers: {
    c0: { type: "noul", noul: 0.81 },
    c1: { type: "choice", choice: "x", probabilities: { x: 0.9, y: 0.1 }, confidence: 0.7 },
  },
  usage: { input_tokens: 120, output_tokens: 4 },
};

function reply(status: number, body: unknown): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function adapter(fetchImpl: typeof fetch, extra: Record<string, unknown> = {}) {
  return new TypeSafeJudgmentAdapter({ apiKey: KEY, fetch: fetchImpl, ...extra });
}

async function rejection(promise: Promise<unknown>): Promise<AgenticError> {
  try { await promise; } catch (error) {
    assert.ok(error instanceof AgenticError, "expected AgenticError");
    return error;
  }
  assert.fail("expected rejection");
}

test("sends the documented request and maps the documented response", async () => {
  let seen: { url: string; init: RequestInit } | undefined;
  const judged = await adapter(async (url, init) => { seen = { url: String(url), init: init! }; return reply(200, okBody); })
    .judge(request, new AbortController().signal);
  assert.equal(seen!.url, "https://api.typesafe.ai/v1/systemone");
  assert.equal(seen!.init.method, "POST");
  const headers = seen!.init.headers as Record<string, string>;
  assert.equal(headers.authorization, `Bearer ${KEY}`);
  assert.deepEqual(JSON.parse(seen!.init.body as string), { state: request.state, model: "jev-1.13.0", questions: request.questions });
  assert.equal(judged.modelId, "jev-1.13.0");
  assert.deepEqual(judged.usage, { inputTokens: 120, outputTokens: 4 });
  assert.deepEqual(judged.answers.c0, { type: "noul", noul: 0.81 });
  assert.equal(seen!.url.includes(KEY), false);
});

test("status mapping: 429, 529 and 5xx transient; 401 and 422 permanent; the key never leaks", async () => {
  const expected: Array<[number, string, boolean]> = [
    [429, "transient", true], [529, "transient", true], [500, "transient", true], [503, "transient", true],
    [401, "permanent", false], [422, "permanent", false],
  ];
  for (const [status, code, retryable] of expected) {
    const error = await rejection(adapter(async () => reply(status, { error: { message: `bad key ${KEY}` } })).judge(request, new AbortController().signal));
    assert.equal(error.code, code, `status ${status}`);
    assert.equal(error.retryable, retryable);
    assert.match(error.message, new RegExp(`\\(${status}\\)`));
    assert.equal(error.message.includes(KEY), false);
  }
  const plain = await rejection(adapter(async () => reply(529, "overloaded")).judge(request, new AbortController().signal));
  assert.equal(plain.code, "transient");
});

test("a network failure is transient", async () => {
  const error = await rejection(adapter(async () => { throw new TypeError("fetch failed"); }).judge(request, new AbortController().signal));
  assert.equal(error.code, "transient");
});

test("an answer whose type differs from its question is permanent", async () => {
  const wrong = { ...okBody, answers: { ...okBody.answers, c0: { type: "choice", choice: "x", probabilities: {}, confidence: 1 } } };
  const error = await rejection(adapter(async () => reply(200, wrong)).judge(request, new AbortController().signal));
  assert.equal(error.code, "permanent");
  const missing = await rejection(adapter(async () => reply(200, { model: "m" })).judge(request, new AbortController().signal));
  assert.equal(missing.code, "permanent");
});

const hang: typeof fetch = (_url, init) => new Promise((_resolve, reject) => {
  init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
});

test("its own deadline is a timeout, the caller's abort is cancelled", async () => {
  const slow = adapter(hang, { timeoutMs: 40 });
  const timedOut = await rejection(slow.judge(request, new AbortController().signal));
  assert.equal(timedOut.code, "timeout");
  assert.equal(timedOut.retryable, false);
  const caller = new AbortController();
  const pending = rejection(adapter(hang, { timeoutMs: 5_000 }).judge(request, caller.signal));
  caller.abort();
  assert.equal((await pending).code, "cancelled");
});

test("a call's own deadline replaces the configured one, and the timeout names the milliseconds that applied", async () => {
  const shortened = await rejection(adapter(hang, { timeoutMs: 60_000 }).judge(request, new AbortController().signal, { timeoutMs: 30 }));
  assert.equal(shortened.code, "timeout");
  assert.match(shortened.message, /exceeded 30 ms/u);
  assert.match((await rejection(adapter(hang, { timeoutMs: 35 }).judge(request, new AbortController().signal, {}))).message, /exceeded 35 ms/u, "no deadline named: the configured one");
  const slowButAnswering: typeof fetch = async () => { await new Promise((resolve) => setTimeout(resolve, 80)); return reply(200, okBody); };
  assert.equal((await adapter(slowButAnswering, { timeoutMs: 20 }).judge(request, new AbortController().signal, { timeoutMs: 5_000 })).modelId, "jev-1.13.0");
  await assert.rejects(adapter(slowButAnswering).judge(request, new AbortController().signal, { timeoutMs: 1.5 }), /positive integer/u);
});

test("base URL rules", () => {
  const build = (baseUrl: string) => () => new TypeSafeJudgmentAdapter({ apiKey: KEY, baseUrl });
  assert.throws(build("http://api.typesafe.ai"), /https/);
  assert.throws(build("https://user:pw@api.typesafe.ai"), /credentials/);
  assert.throws(build(`https://api.typesafe.ai/?key=${KEY}`), /query/);
  assert.throws(build("not a url"), /valid URL/);
  assert.throws(() => new TypeSafeJudgmentAdapter({ apiKey: " " }), /API key/);
  build("http://127.0.0.1:4721")();
  build("http://localhost:4721/")();
});

test("a loopback base URL is used verbatim, with a trailing slash trimmed", async () => {
  let url = "";
  await adapter(async (input) => { url = String(input); return reply(200, okBody); }, { baseUrl: "http://127.0.0.1:4721/" })
    .judge(request, new AbortController().signal);
  assert.equal(url, "http://127.0.0.1:4721/v1/systemone");
});

async function load(yaml: string | undefined, env: NodeJS.ProcessEnv = {}) {
  const dir = await mkdtemp(join(tmpdir(), "typesafe-config-"));
  const path = join(dir, "judgment.yaml");
  if (yaml !== undefined) await writeFile(path, yaml);
  return loadTypeSafeJudgmentConfig(path, env);
}

test("loader: absent file, defaults, key from env, deadline clamp", async () => {
  assert.equal(await load(undefined), undefined);
  const minimal = await load("apiKeyEnv: TYPESAFE_API_KEY\n");
  assert.deepEqual(minimal, { enabled: true, apiKeyEnv: "TYPESAFE_API_KEY", adapter: {}, rerank: { shortlist: 12, deadlineMs: 1200 } });
  const full = await load(
    "enabled: false\napiKeyEnv: TYPESAFE_API_KEY\nbaseUrl: http://127.0.0.1:4721\nmodel: jev-1.13.0\ntimeoutMs: 900\nrerank:\n  shortlist: 8\n  deadlineMs: 9000\n",
    { TYPESAFE_API_KEY: `  ${KEY}  ` },
  );
  assert.equal(full!.enabled, false);
  assert.equal(full!.apiKey, KEY);
  assert.deepEqual(full!.adapter, { baseUrl: "http://127.0.0.1:4721", model: "jev-1.13.0", timeoutMs: 900 });
  assert.deepEqual(full!.rerank, { shortlist: 8, deadlineMs: 1500 });
  assert.equal((await load("apiKeyEnv: TYPESAFE_API_KEY\n", { TYPESAFE_API_KEY: "  " }))!.apiKey, undefined);
});

test("loader rejects unknown keys, placeholders, literal keys and bad values", async () => {
  await assert.rejects(load("apiKeyEnv: TYPESAFE_API_KEY\nextra: 1\n"), /unknown key: extra/);
  await assert.rejects(load("apiKeyEnv: TYPESAFE_API_KEY\nrerank:\n  top: 3\n"), /unknown key: top/);
  await assert.rejects(load("apiKeyEnv: ${TYPESAFE_API_KEY}\n"), /substitution/);
  await assert.rejects(load(`apiKey: ${KEY}\napiKeyEnv: TYPESAFE_API_KEY\n`), /literal apiKey/);
  await assert.rejects(load(`apiKeyEnv: ${KEY}\n`), /environment variable/);
  await assert.rejects(load("apiKeyEnv: TYPESAFE_API_KEY\nbaseUrl: http://api.typesafe.ai\n"), /https/);
  await assert.rejects(load("apiKeyEnv: TYPESAFE_API_KEY\nrerank:\n  shortlist: 99\n"), /rerank.shortlist/);
  await assert.rejects(load("apiKeyEnv: TYPESAFE_API_KEY\nenabled: yes-please\n"), /true or false/);
  await assert.rejects(load("- a\n- b\n"), /mapping/);
});

test("the real adapter feeds JudgedKnowledgeService, which fails open on 401 and 529", async () => {
  const documents = ["doc-a", "doc-b", "doc-c"].map((id, index) => ({
    id, title: id, content: `alpha ${"beta ".repeat(3 - index)}`, sourceRef: `${id}.md`, contentHash: id, classification: "internal" as const,
  }));
  const inner = new InMemoryKnowledgeService(documents);
  const security = { tenantId: "t", actorId: "a", permissions: new Set(["*"]), correlationId: "c", purpose: "test" };
  const expected = await inner.search("alpha beta", 2, security);
  assert.equal(expected.length, 2);
  for (const [status, code] of [[401, "permanent"], [529, "transient"]] as const) {
    const failures: Array<{ error: unknown }> = [];
    let judged = 0;
    const service = new JudgedKnowledgeService(
      inner,
      adapter(async () => reply(status, { error: { message: "refused" } })),
      { onJudged: () => { judged += 1; }, onJudgmentFailure: (info) => failures.push(info) },
    );
    assert.deepEqual(await service.search("alpha beta", 2, security), expected, `status ${status}`);
    assert.equal(judged, 0);
    assert.equal(failures.length, 1);
    assert.equal((failures[0]!.error as AgenticError).code, code);
  }
});
