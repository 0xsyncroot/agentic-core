import { missingResultText, type JsonValue, type ToolDefinition, type ToolInvocation, type ToolResultSpool } from "@0xsyncroot/contracts";
import { runSandboxed, type SandboxLimits } from "./sandbox.js";

export const CALCULATE_TOOL_ID = "calculate";

const MAX_CODE_CHARS = 20_000;
const MAX_INPUTS = 20;
const MAX_INPUT_CHARS = 8_000_000;
const DEFAULT_LIMITS: SandboxLimits = { timeoutMs: 5_000, memoryBytes: 256 * 1024 * 1024, maxOutputChars: 20_000 };
const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/u;

function valueAt(value: JsonValue, path: string | undefined): JsonValue | undefined {
  if (!path || path === "(root)") return value;
  let current: JsonValue | undefined = value;
  for (const segment of path.split(/[.[\]]/u).filter(Boolean)) {
    if (current === null || typeof current !== "object") return undefined;
    current = Object.hasOwn(current, segment) ? (current as Record<string, JsonValue>)[segment] : undefined;
  }
  return current;
}

/**
 * A number as Excel keeps it: 15 significant digits. Binary floating point writes 5.02 × 2,530,000 as
 * 12700599.999999998 and 0.1 + 0.2 as 0.30000000000000004; read at 15 digits they are 12700600 and
 * 0.3, the values the sheet shows. A real fraction (20515371.525) is untouched. This is the
 * representation, not rounding an amount: below 15 digits nothing is changed.
 */
function fifteenDigits(value: JsonValue): JsonValue {
  if (typeof value === "number") return Number.isFinite(value) ? Number(value.toPrecision(15)) : value;
  if (Array.isArray(value)) return value.map(fifteenDigits);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fifteenDigits(item)]));
  return value;
}

const typeOf = (value: JsonValue | undefined): string =>
  value === null ? "null" : Array.isArray(value) ? `array of ${value.length}` : typeof value;

/** A value's shape as the code reads it: its type, and for an object each top-level key with its value's type. Data, never advice. */
function shapeOf(value: JsonValue): string {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return typeOf(value);
  return `object {${Object.entries(value).map(([key, item]) => `${key}: ${typeOf(item)}`).join(", ")}}`;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/**
 * Exact figures from what was read, computed by code instead of by the model.
 *
 * A model adds, subtracts and matches rows by hand, and gets them wrong without saying so: on a
 * real reconciliation it compared seven of 84 people, called the rest "small, probably rounding"
 * and reported a difference nobody had computed. Here the code it writes runs on the stored
 * results themselves — the whole value the runtime kept, never figures copied into the prompt —
 * and the call (code, inputs by resultId, output) is journaled as the evidence for every number
 * the answer states. Nothing is rounded on the model's behalf.
 */
/**
 * A view of a stored result a product offers the code: the result read through the product's own loader, as one value.
 * A screen page and a file read are stored in different shapes and a sheet is several pages, so code written against
 * the raw stored shape fails; the view gives it one shape for any source.
 */
export type CalculationView = (scope: { readonly tenantId: string; readonly sessionId: string }, resultId: string) => JsonValue;
export interface CalculationViews { readonly views?: Readonly<Record<string, { readonly describe: string; readonly read: CalculationView }>> }

export function createCalculationTool(spool: ToolResultSpool, limits: SandboxLimits = DEFAULT_LIMITS, options: CalculationViews = {}): ToolDefinition {
  const views = options.views ?? {};
  const viewNames = Object.keys(views);
  return {
    id: CALCULATE_TOOL_ID,
    version: "1.0.0",
    description: "Run JavaScript on results already read to get exact figures: sums, differences, rows of two tables matched by key, counts, "
      + "and checks that totals close. Any figure you state that is not copied verbatim from a tool result must come from this tool — never compute in your head. "
      + "`inputs` maps a name to a retained result ({resultId, path}); the code reads it as inputs.<name>, the full stored value (not the cut view): "
      + "without a path that is the whole tool result as stored, structuredContent included when the tool returned one, so a list inside it is read at its full path. "
      + "Write a function body that ends with `return <value>`: a small JSON value (differences, totals, counts, unmatched rows), at most 20,000 characters. "
      + "Helpers: fold(text) is a name without accents, case or any spaces (\"JohnSmith\" = \"John  Smith\"); keys(list, row => key) adds #2, #3 to repeated keys so people with the same name stay apart; "
      + "match(a, b, rowA => key, rowB => key) pairs two lists by folded key with repeats kept apart and returns {pairs:[{key,left,right}], onlyLeft, onlyRight}; "
      + "rowsOf(cells) turns [{row,column,value}] cells (every page of a spreadsheet read) into [{row, values:{column: value}}]; "
      + "columnOf(columnPaths, ...names) is the column whose header path ends with those names, e.g. columnOf(paths, \"Salary\", \"Net pay\"), and throws naming the near columns when none or several match; "
      + "sum(list) adds the numbers in a list. Numbers are read and returned at Excel's 15 significant digits, so binary noise such as 12700599.999999998 comes back as 12700600 — that is not rounding. "
      + "Nothing is rounded for you, and you must not round a figure to make two sources agree: report the exact difference and say which source rounds. "
      + "The code runs isolated: no network, files, tools or other results."
      + viewNames.map((name) => ` With view "${name}" an input is ${views[name]!.describe}`).join(""),
    inputSchema: {
      type: "object", additionalProperties: false, required: ["code"],
      properties: {
        code: { type: "string", minLength: 1, maxLength: MAX_CODE_CHARS, description: "A function body; inputs.<name> holds each input. End with return <value>." },
        inputs: {
          type: "object",
          description: "Name → retained result. Names are JavaScript identifiers. Omit when the code needs no stored result.",
          additionalProperties: {
            type: "object", additionalProperties: false, required: ["resultId"],
            properties: {
              resultId: { type: "string", description: "The resultId of a retained result (shown under the result, or returned by an earlier calculate call)." },
              path: { type: "string", description: "Field or list inside the result, for example data.rows. Omit for the whole value." },
              ...(viewNames.length ? { view: { type: "string", enum: viewNames, description: "Read the result through this view instead of as stored (path then applies to the view)." } } : {}),
            },
          },
        },
      },
    },
    outputSchema: { type: "object", additionalProperties: true, required: ["value", "inputs"] },
    requiredPermissions: [], sideEffect: "none", timeoutMs: limits.timeoutMs + 10_000,
    // The output is already bounded by the sandbox; a later calculation may take this result as its input.
    maxResultChars: limits.maxOutputChars * 2, retainResult: true, computes: true,
    execute: async (invocation: ToolInvocation) => {
      const args = record(invocation.arguments) ?? {};
      const code = typeof args.code === "string" ? args.code : "";
      if (!code.trim() || code.length > MAX_CODE_CHARS) throw new Error(`code must be a function body of 1 to ${MAX_CODE_CHARS} characters.`);
      const requested = record(args.inputs) ?? {};
      const names = Object.keys(requested);
      if (names.length > MAX_INPUTS) throw new Error(`At most ${MAX_INPUTS} inputs.`);
      const values: Record<string, JsonValue> = {};
      const used: { name: string; resultId: string; toolId: string; path?: string }[] = [];
      for (const name of names) {
        if (!NAME.test(name)) throw new Error(`Input name "${name.slice(0, 40)}" must be a JavaScript identifier.`);
        const input = record(requested[name]);
        const resultId = typeof input?.resultId === "string" ? input.resultId : "";
        const path = typeof input?.path === "string" ? input.path : undefined;
        const scope = { tenantId: invocation.security.tenantId, sessionId: invocation.sessionId };
        const stored = resultId ? spool.get(scope, resultId) : undefined;
        if (!stored) throw new Error(`Input "${name}": ${missingResultText(spool, scope, resultId)}`);
        const view = typeof input?.view === "string" ? input.view : undefined;
        if (view !== undefined && !views[view]) throw new Error(`Input "${name}": no view "${view}"; views: ${viewNames.join(", ") || "none"}.`);
        const value = valueAt(view ? views[view]!.read(scope, resultId) : stored.value, path);
        if (value === undefined) {
          throw new Error(`Input "${name}": the result has no value at "${path}". Use a field or list path from the original result. The stored result is ${shapeOf(stored.value)}.`);
        }
        values[name] = fifteenDigits(value);
        used.push({ name, resultId, toolId: stored.toolId, ...(path ? { path } : {}), ...(view ? { view } : {}) });
      }
      const serialized = JSON.stringify(values);
      if (serialized.length > MAX_INPUT_CHARS) throw new Error(`The inputs total ${serialized.length} characters; pass narrower paths (at most ${MAX_INPUT_CHARS}).`);
      const started = performance.now();
      const outcome = await runSandboxed(code, serialized, limits);
      if (!outcome.ok) {
        const shapes = names.map((name) => `inputs.${name} is ${shapeOf(values[name]!)}`).join("; ");
        throw new Error(`The calculation did not run to the end — ${outcome.message} Fix the code and call again; state no figure from this attempt.${shapes ? ` ${shapes}.` : ""}`);
      }
      return { value: fifteenDigits(JSON.parse(outcome.json) as JsonValue), inputs: used, elapsedMs: Math.max(0, Math.round(performance.now() - started)) };
    },
  };
}
