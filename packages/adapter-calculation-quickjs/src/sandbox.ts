import { getQuickJS, shouldInterruptAfterDeadline, type QuickJSWASMModule } from "quickjs-emscripten";

/**
 * Runs model-written JavaScript where it can reach nothing but its inputs.
 *
 * QuickJS compiled to WebAssembly: its own heap, no `process`, `require`, network, files or host
 * objects — only the JSON it is handed. `node:vm` is not that boundary (its own documentation
 * says so), and the code here is written by a model that has just read documents a stranger may
 * have written. Memory and time are capped; output crosses back as one JSON string.
 */
export interface SandboxLimits {
  readonly timeoutMs: number;
  readonly memoryBytes: number;
  readonly maxOutputChars: number;
}

export type SandboxOutcome =
  | { readonly ok: true; readonly json: string }
  | { readonly ok: false; readonly reason: "error" | "timeout" | "memory" | "output" | "not-json"; readonly message: string };

let module: Promise<QuickJSWASMModule> | undefined;
const quickjs = (): Promise<QuickJSWASMModule> => (module ??= getQuickJS());

/**
 * Helpers the code may call. Kept small and documented in the tool description: each answers a
 * question models get wrong by hand, none of them rounds an amount.
 */
const PRELUDE = `
const fold = (text) => String(text ?? "").normalize("NFD").replace(/[\\u0300-\\u036f]/g, "").replace(/đ/g, "d").replace(/Đ/g, "D").toLowerCase().replace(/\\s+/g, "");
const keys = (list, keyOf) => { const seen = new Map(); return list.map((row) => { const key = keyOf(row); const n = seen.get(key) ?? 0; seen.set(key, n + 1); return n === 0 ? key : key + "#" + (n + 1); }); };
const sum = (list) => list.reduce((total, value) => total + (typeof value === "number" && Number.isFinite(value) ? value : 0), 0);
const exact = (value) => { if (typeof value !== "number") return value; const whole = Math.round(value); return Math.abs(value - whole) < 1e-6 ? whole : value; };
const rowsOf = (cells) => { const byRow = new Map(); for (const cell of cells ?? []) { if (!cell || typeof cell.row !== "number" || typeof cell.column !== "number") continue; if (!byRow.has(cell.row)) byRow.set(cell.row, {}); byRow.get(cell.row)[cell.column] = cell.value; } return [...byRow.entries()].sort((a, b) => a[0] - b[0]).map(([row, values]) => ({ row, values })); };
const columnOf = (paths, ...names) => { const want = names.map(fold); const whole = (paths ?? []).filter((entry) => (entry.path ?? []).map(fold).join(">") === want.join(">")); if (whole.length === 1) return whole[0].column; const hits = (paths ?? []).filter((entry) => { const path = (entry.path ?? []).map(fold); return want.every((name, i) => path[path.length - want.length + i] === name); }); if (hits.length === 1) return hits[0].column; const near = (paths ?? []).filter((entry) => (entry.path ?? []).some((part) => fold(part).includes(want[want.length - 1]))).slice(0, 8).map((entry) => entry.column + ": " + entry.path.join(" > ")); throw new Error("columnOf(" + names.join(" > ") + "): " + hits.length + " columns match" + (near.length ? "; near: " + near.join(" | ") : "")); };
const match = (left, right, keyLeft, keyRight) => { const lk = keys(left, (row) => fold(keyLeft(row))), rk = keys(right, (row) => fold(keyRight(row))); const byKey = new Map(right.map((row, i) => [rk[i], row])); const pairs = [], onlyLeft = []; left.forEach((row, i) => { const other = byKey.get(lk[i]); if (other === undefined) onlyLeft.push(row); else { pairs.push({ key: lk[i], left: row, right: other }); byKey.delete(lk[i]); } }); return { pairs, onlyLeft, onlyRight: [...byKey.values()] }; };
`;

/** Names the code cannot take for an input: the language's own words, the prelude, the globals it uses. */
const TAKEN = new Set(("break case catch class const continue debugger default delete do else export extends false finally for function if import in "
  + "instanceof new null return super switch this throw true try typeof var void while with yield let static await enum implements interface package "
  + "private protected public arguments eval undefined NaN Infinity fold keys sum exact rowsOf columnOf match inputs JSON Math Object Array Number "
  + "String Boolean Date Map Set Error RegExp Symbol Promise BigInt globalThis").split(" "));

/**
 * Each input also as a constant of its own name. The tool says `inputs.<name>`, and models still write
 * `<name>.data…`; refusing that costs a failed call for a spelling the sandbox can simply accept.
 * Only plain identifiers that shadow nothing.
 */
function byName(inputs: string): string {
  let names: string[] = [];
  try { names = Object.keys(JSON.parse(inputs) as Record<string, unknown>); } catch { return ""; }
  const usable = names.filter((name) => /^[A-Za-z_$][\w$]*$/u.test(name) && !TAKEN.has(name));
  return usable.length ? `const { ${usable.join(", ")} } = inputs;\n` : "";
}

export async function runSandboxed(code: string, inputs: string, limits: SandboxLimits): Promise<SandboxOutcome> {
  const runtime = (await quickjs()).newRuntime();
  runtime.setMemoryLimit(limits.memoryBytes);
  runtime.setMaxStackSize(1024 * 1024);
  runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + limits.timeoutMs));
  const vm = runtime.newContext();
  try {
    const handle = vm.newString(inputs);
    vm.setProp(vm.global, "__inputs", handle);
    handle.dispose();
    const program = `"use strict";${PRELUDE}\nconst inputs = JSON.parse(__inputs);\n${byName(inputs)}const __result = (function () {\n${code}\n})();\n`
      + `if (__result === undefined) throw new Error("The code returned nothing: end it with return <value>.");\nJSON.stringify(__result);`;
    const result = vm.evalCode(program, "calculation.js");
    if (result.error) {
      const error = vm.dump(result.error) as { name?: string; message?: string; stack?: string } | string;
      result.error.dispose();
      const message = typeof error === "string" ? error : `${error.name ?? "Error"}: ${error.message ?? ""}${error.stack ? ` (${error.stack.trim().split("\n")[0]?.trim()})` : ""}`;
      if (/interrupted/u.test(message)) return { ok: false, reason: "timeout", message: `The code ran longer than ${limits.timeoutMs} ms and was stopped.` };
      if (/out of memory/u.test(message)) return { ok: false, reason: "memory", message: "The code used more memory than allowed and was stopped." };
      return { ok: false, reason: "error", message };
    }
    const json = vm.dump(result.value);
    result.value.dispose();
    if (typeof json !== "string") return { ok: false, reason: "not-json", message: "The returned value cannot be written as JSON (functions, undefined, cycles)." };
    if (json.length > limits.maxOutputChars) {
      return { ok: false, reason: "output", message: `The returned value is ${json.length} characters; return at most ${limits.maxOutputChars} (differences and totals, not whole tables).` };
    }
    return { ok: true, json };
  } finally {
    vm.dispose();
    runtime.dispose();
  }
}
