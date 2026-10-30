import assert from "node:assert/strict";
import test from "node:test";
import { createJudgmentPort, judgmentProvider, describeJudgmentChoice } from "../src/composition/judgment-provider.js";

test("TypeSafe is selected explicitly or from its key, and can be disabled", () => {
  assert.equal(judgmentProvider({ TYPESAFE_API_KEY: "test-key" }), "typesafe");
  assert.equal(judgmentProvider({}), "none");
  assert.equal(judgmentProvider({ TYPESAFE_API_KEY: "test-key", AGENTIC_JUDGMENT_PROVIDER: "none" }), "none");
  assert.equal(judgmentProvider({ AGENTIC_JUDGMENT_PROVIDER: "typesafe" }), "typesafe");
  assert.throws(() => judgmentProvider({ AGENTIC_JUDGMENT_PROVIDER: "unknown" }), /typesafe or none/u);
});

test("TypeSafe keeps its real model identity and requires its own credential", () => {
  const adapter = createJudgmentPort({ TYPESAFE_API_KEY: "test-key" });
  assert.equal(adapter?.providerId, "typesafe");
  assert.equal(adapter?.model, "jev-1.13.0");
  assert.equal(createJudgmentPort({}), undefined);
  assert.throws(() => createJudgmentPort({ AGENTIC_JUDGMENT_PROVIDER: "typesafe" }), /TYPESAFE_API_KEY/u);
});

test("measured seams are on by default, a product can still choose; one switch turns everything to shadow", async () => {
  const { judgmentSeamModes, judgmentShadow } = await import("../src/composition/judgment-provider.js");
  assert.deepEqual(judgmentSeamModes({}), { observationReview: "on", observationState: "off", skillRelevance: "on", resultRelevance: "on", toolRelevance: "on", stepClaim: "shadow", answerMoved: "on", nextCall: "shadow" });
  const product = { resultRelevance: "shadow" } as const;
  assert.deepEqual(judgmentSeamModes({}, product), { observationReview: "on", observationState: "off", skillRelevance: "on", resultRelevance: "shadow", toolRelevance: "on", stepClaim: "shadow", answerMoved: "on", nextCall: "shadow" });
  assert.deepEqual(judgmentSeamModes({ AGENTIC_JUDGMENT_MODE: "shadow" }, product), { observationReview: "shadow", observationState: "off", skillRelevance: "shadow", resultRelevance: "shadow", toolRelevance: "shadow", stepClaim: "shadow", answerMoved: "shadow", nextCall: "shadow" });
  assert.equal(judgmentShadow({}), false);
  assert.throws(() => judgmentShadow({ AGENTIC_JUDGMENT_MODE: "on" }), /shadow or unset/u);
});

test("AGENTIC_JUDGMENT_FALLBACK_MODEL names the skill-fit fallback's model; unset or blank leaves it to the chat model", async () => {
  const { judgmentFallbackModel } = await import("../src/composition/judgment-provider.js");
  assert.equal(judgmentFallbackModel({}), undefined);
  assert.equal(judgmentFallbackModel({ AGENTIC_JUDGMENT_FALLBACK_MODEL: "  " }), undefined);
  assert.equal(judgmentFallbackModel({ AGENTIC_JUDGMENT_FALLBACK_MODEL: " example-fallback-model " }), "example-fallback-model");
});

test("startup diagnostics explain selection and shadow mode without exposing credentials", () => {
  const env = { AGENTIC_JUDGMENT_PROVIDER: "typesafe", TYPESAFE_API_KEY: "private-test-key", TYPESAFE_BASE_URL: "https://judge.example" };
  const description = describeJudgmentChoice(env);
  assert.equal(description, "judgment provider: typesafe (AGENTIC_JUDGMENT_PROVIDER names it); mode: live");
  assert.doesNotMatch(description, /private-test-key|judge\.example/u);
  assert.match(describeJudgmentChoice({ TYPESAFE_API_KEY: "test-key" }), /automatic: TYPESAFE_API_KEY is set/u);
  assert.match(describeJudgmentChoice({}), /none \(automatic: no judgment key is set\); mode: live$/u);
  assert.match(describeJudgmentChoice({ ...env, AGENTIC_JUDGMENT_MODE: "shadow" }), /mode: shadow/u);
});
