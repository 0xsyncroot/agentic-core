import assert from "node:assert/strict";
import test from "node:test";
import { createWorkPlanningProvider } from "../src/tools/plan-tool.js";

// Codex's update_plan asks for step + status only: a required id costs refused plans, and with no "blocked" status the
// only honest end for a step the agent cannot do is to drop it or lie "completed".
test("a step needs no id, and a step that cannot be done is blocked with its reason", () => {
  const { parseProposal, definition } = createWorkPlanningProvider();
  const proposal = parseProposal({ goal: "Đối soát", steps: [
    { description: "Mở bảng lương", status: "completed", outcome: "Đã mở" },
    { description: "Đọc sheet GVBC", status: "blocked", outcome: "Tệp không mở được" },
    { id: "keep", description: "Báo cáo", status: "in_progress" },
  ] });
  assert.deepEqual(proposal.steps.map((step) => [step.id, step.status]), [["step_1", "completed"], ["step_2", "blocked"], ["keep", "in_progress"]]);
  const schema = definition.modelInputSchema as { properties: { steps: { items: { required: string[]; properties: { status: { enum: string[] } } } } } };
  assert.deepEqual(schema.properties.steps.items.required, ["description", "status"]);
  assert.ok(schema.properties.steps.items.properties.status.enum.includes("blocked"));
  assert.throws(() => parseProposal({ goal: "x", steps: [{ description: "y", status: "done" }] }), /status must be one of pending, in_progress, completed, blocked/u);
});

test("a step with an id and no description is accepted; one with neither is refused", () => {
  const { parseProposal, definition } = createWorkPlanningProvider();
  const proposal = parseProposal({ goal: "Đối soát", steps: [
    { id: "open", status: "completed", outcome: "Đã mở" },
    { id: "report", description: "Báo cáo", status: "in_progress" },
  ] });
  assert.equal(proposal.steps[0]!.description, undefined, "the stored description is the runtime's to fill");
  assert.deepEqual(proposal.steps.map((step) => step.id), ["open", "report"]);
  assert.throws(() => parseProposal({ goal: "x", steps: [{ status: "pending" }] }), /Step 1 needs a description or the id of a step in the plan/u);
  assert.throws(() => parseProposal({ goal: "x", steps: [{ id: " ", status: "pending" }] }), /Step 1 needs a description or the id of a step in the plan/u);
  assert.throws(() => parseProposal({ goal: "x", steps: [{ id: "a", description: " ", status: "pending" }] }), /Step 1 description must be a non-empty string/u);
});

// A NEW plan has no step to name: without `description` in `required`, first calls come as `{id, status}` and core refuses them
// (the user sees no plan). The schema requires a description and the text says every step keeps its id and description.
test("the plan tool asks for a description on every step and says ids and descriptions identify the step", () => {
  const { definition } = createWorkPlanningProvider();
  assert.match(definition.description, /Keep every step's id and description the same in each update: they identify the step\./u);
  assert.doesNotMatch(definition.description, /by its id alone/u);
  const step = (definition.modelInputSchema as { properties: { steps: { items: { required: string[]; properties: Record<string, unknown> } } } }).properties.steps.items;
  assert.ok(step.required.includes("description"));
  assert.ok(!step.required.includes("id"), "the id stays optional (P6-14)");
});

// The model is asked for a description (above); a call is checked against what the port accepts, so a completed step sent
// as `{id, status, outcome}` is not refused by the schema alone.
test("calls are checked against a schema that needs only a status on each step", () => {
  const { definition } = createWorkPlanningProvider();
  const accepted = (definition.inputSchema as { properties: { steps: { items: { required: string[] } } } }).properties.steps.items;
  assert.deepEqual(accepted.required, ["status"]);
  const shown = definition.modelInputSchema as { properties: { steps: { items: { required: string[] } } } };
  assert.notEqual(shown, definition.inputSchema);
  const { required: _shown, ...shownRest } = shown.properties.steps.items;
  const { required: _accepted, ...acceptedRest } = accepted;
  assert.deepEqual(acceptedRest, shownRest, "the two schemas differ only in which step fields are required");
});

// Progress without resending the plan, with the step's result line kept: every field is required (an optional field in a
// schema is dropped by the model on every call), and the outcome is what the user reads as the step's line.
test("plan_mark takes a step id, a status and an outcome, all required, and refuses anything else", async () => {
  const { markDefinition, parseMark, definition } = createWorkPlanningProvider();
  assert.equal(markDefinition.id, "plan_mark");
  const schema = markDefinition.inputSchema as { required: string[]; additionalProperties: boolean; properties: Record<string, { enum?: string[] }> };
  assert.deepEqual(schema.required, ["id", "status", "outcome"]);
  assert.deepEqual(Object.keys(schema.properties).sort(), [...schema.required].sort(), "no optional field");
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.properties.status!.enum, ["in_progress", "completed", "blocked"]);
  assert.deepEqual(parseMark({ id: "read", status: "completed", outcome: "Đã đọc 152 nhân viên." }), { id: "read", status: "completed", outcome: "Đã đọc 152 nhân viên." });
  assert.deepEqual(parseMark({ id: "read", status: "blocked", outcome: "Tệp không mở được." }), { id: "read", status: "blocked", outcome: "Tệp không mở được." });
  assert.throws(() => parseMark({ id: "read", status: "pending", outcome: "x" }), /status must be one of in_progress, completed, blocked/u);
  assert.throws(() => parseMark({ status: "completed", outcome: "x" }), /id must be a non-empty string/u);
  assert.throws(() => parseMark({ id: "read", status: "completed" }), /outcome must be a non-empty string/u);
  assert.throws(() => parseMark({ id: "read", status: "completed", outcome: " " }), /outcome must be a non-empty string/u);
  await assert.rejects(markDefinition.execute({ arguments: { id: "read", status: "completed", outcome: "x" } } as never), /plan_mark needs the plan the agent runtime keeps/u);
  assert.match(markDefinition.description, /in the same step as the calls that do the work/u);
  assert.match(markDefinition.description, /completed, what was done or observed, with the numbers you observed; in_progress, what the step starts; blocked, what blocks it\./u);
  assert.doesNotMatch(markDefinition.description, /With your final answer|every step still open/u, "the runtime closes the steps the results show done");
  assert.doesNotMatch(markDefinition.description, /send no mark before answering/u);
  assert.match(markDefinition.description, /Your final answer carries no mark: the runtime closes the plan from the results\./u);
  assert.match(definition.description, /Once a plan exists, mark each step's progress with plan_mark in the same step as the work/u);
  assert.doesNotMatch(definition.description, /With your final answer|every step still open/u, "the runtime closes the steps the results show done");
  assert.doesNotMatch(definition.description, /send no final update before answering/u);
  assert.doesNotMatch(definition.description, /or beside your final answer/u);
});
