import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/** The labeller's turn verdicts: correct, stuck, or none, keyed by captured turn. */
export function labelledTurns(dir) {
  const lines = (file) => readFileSync(resolve(dir, file), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const steps = [...lines("m1-227.jsonl"), ...lines("m1-new.jsonl")];
  const match = JSON.parse(readFileSync(resolve(dir, "match.json"), "utf8"));
  const literal = /SAT_CAP = (\{[^}]*\})/su.exec(readFileSync(resolve(dir, "bin/final_m1.py"), "utf8"))[1];
  const satisfaction = JSON.parse(literal.replace(/None/gu, "null").replace(/(\d+):/gu, "\"$1\":"));
  const turns = new Map();
  for (const step of steps) {
    const turn = turns.get(step.turn) ?? { repeating: false, satisfied: false, satisfaction: undefined };
    if (step.labels.repeating === true) turn.repeating = true;
    if (step.labels.satisfied === true) turn.satisfied = true;
    const instance = match[step.id]?.[0];
    if (instance !== undefined && String(instance) in satisfaction) turn.satisfaction = satisfaction[String(instance)];
    turns.set(step.turn, turn);
  }
  // A turn outside the satisfaction table (an eval run) is correct when a labelled step already satisfied the request.
  return new Map([...turns].map(([turn, label]) => [turn, label.satisfaction === undefined ? (label.satisfied ? "correct" : "unlabelled")
    : label.satisfaction === null ? "unlabelled" : label.satisfaction >= 0 ? "correct" : label.repeating ? "stuck" : "unlabelled"]));
}

const RUNTIME_USER = ["[Runtime instruction", "Application context", "Durable product task state", "Retained tool observations",
  "Verification read performed", "Attached files", "Historical conversation checkpoint", "{\"request\"", "Completion audit", "[Runtime",
  "Runtime note"];

/** The model's tool call ids of one captured turn: every call after the turn's user message in its last request. */
export function capturedCallIds(captures, turn) {
  const last = /^cap:\d+-(\d+)$/u.exec(turn)?.[1];
  const file = last ? resolve(captures, `req-${last}.json`) : undefined;
  if (!file || !existsSync(file)) return undefined;
  const messages = JSON.parse(readFileSync(file, "utf8")).messages ?? [];
  const text = (content) => typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => part?.text ?? "").join(" ") : "";
  const user = messages.findLastIndex((message) => message.role === "user" && !RUNTIME_USER.some((prefix) => text(message.content).startsWith(prefix)));
  return new Set(messages.slice(user + 1).flatMap((message) => message.role === "assistant" ? (message.tool_calls ?? []).map((item) => item.id) : []));
}
