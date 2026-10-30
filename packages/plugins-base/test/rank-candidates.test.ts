import assert from "node:assert/strict";
import { test } from "node:test";
import { AgenticError, type JudgmentPort, type ToolInvocation } from "@0xsyncroot/contracts";
import { createRankCandidatesTool } from "../src/index.js";

// Each candidate is judged alone, so the order they come in never changes the ranking (one many-way question follows
// the order of the candidates).
const judged: string[] = [];
const port: JudgmentPort = { providerId: "fake", model: "fake", judge: async (request) => {
  const id = (request.state as { candidate: { id: string } }).candidate.id;
  judged.push(id);
  return { modelId: "fake", answers: { fits: { type: "noul", noul: id === "Payroll" ? 0.99 : id === "Payroll (contract staff)" ? 0.95 : 0.01 } } };
} };
const run = (candidates: { id: string; evidence: string }[]) => createRankCandidatesTool(port).execute(
  { arguments: { criterion: "the payroll table of the month, one row per person with salary items and net pay", candidates }, security: { tenantId: "t" } } as unknown as ToolInvocation,
  new AbortController().signal) as Promise<{ ranked: { id: string; probability: number }[]; fits: string[]; clear?: string }>;

test("every candidate is judged on its own; the ranking does not depend on their order; one clear fit is named", async () => {
  const sheets = [{ id: "Payment list", evidence: "DANH SÁCH THANH TOÁN" }, { id: "Payroll", evidence: "BẢNG LƯƠNG THÁNG 9" }, { id: "Allowance", evidence: "KHOÁN VPP" }];
  const forward = await run(sheets), backward = await run([...sheets].reverse());
  assert.deepEqual(forward.ranked, backward.ranked);
  assert.deepEqual([forward.ranked[0]!.id, forward.fits, forward.clear], ["Payroll", ["Payroll"], "Payroll"]);
  assert.equal(new Set(judged).size, 3, "one judgment per candidate");
  const two = await run([...sheets, { id: "Payroll (contract staff)", evidence: "BẢNG LƯƠNG HỢP ĐỒNG" }]);
  assert.deepEqual([two.fits, two.clear], [["Payroll", "Payroll (contract staff)"], undefined], "two fits: no clear choice, the agent counts who is in each or asks");
});

test("a dropped connection is asked once more; a refusal or a malformed answer is not asked again", async () => {
  const flaky = (failure: AgenticError) => {
    let calls = 0;
    const tool = createRankCandidatesTool({ providerId: "fake", model: "fake", judge: async () => {
      if (++calls === 1) throw failure;
      return { modelId: "fake", answers: { fits: { type: "noul", noul: 0.99 } } };
    } });
    const ranked = tool.execute({ arguments: { criterion: "the payroll table", candidates: [{ id: "Payroll", evidence: "BẢNG LƯƠNG" }] }, security: { tenantId: "t" } } as unknown as ToolInvocation,
      new AbortController().signal) as Promise<{ fits: string[] }>;
    return { ranked, calls: () => calls };
  };
  const dropped = flaky(new AgenticError("transient", "Test judgment provider transport failed", true));
  assert.deepEqual((await dropped.ranked).fits, ["Payroll"]);
  assert.equal(dropped.calls(), 2);
  // Test judgment provider's own deadline is a non-retryable `timeout`: one slow answer is the gateway's, so it is asked once more too.
  const slow = flaky(new AgenticError("timeout", "Test judgment provider request exceeded 20000 ms", false));
  assert.deepEqual([(await slow.ranked).fits, slow.calls()], [["Payroll"], 2]);
  const invalid = flaky(new AgenticError("validation", "Test judgment provider needs 1 to 8 questions", false));
  await assert.rejects(invalid.ranked, /questions/u);
  assert.equal(invalid.calls(), 1);
  const refused = flaky(new AgenticError("permanent", "Test judgment provider request failed (400): bad request", false));
  await assert.rejects(refused.ranked, /400/u);
  assert.equal(refused.calls(), 1, "the same request would be refused the same way");
});
