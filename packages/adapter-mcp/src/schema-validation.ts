import { AgenticError, type JsonValue } from "@0xsyncroot/contracts";

/**
 * A dependency-free JSON Schema subset validator for `ToolDefinition.validateArguments`.
 *
 * The point is to catch obviously malformed remote-tool arguments before authorization is asked
 * for, not to be a conformant JSON Schema implementation: unsupported keywords are ignored rather
 * than rejected, `$ref`/`oneOf`/`anyOf`/`allOf` are not resolved, and work is capped so a hostile
 * or malformed schema cannot make validation itself expensive.
 */

const MAX_CHECKS = 2000;
const MAX_DEPTH = 8;
const MAX_PATTERN_LENGTH = 512;
const MAX_PATTERN_INPUT_LENGTH = 4096;

function isRecord(value: unknown): value is Record<string, JsonValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function typeOf(value: JsonValue): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

function deepEqual(left: JsonValue, right: JsonValue): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length
      && left.every((item, index) => deepEqual(item, right[index] as JsonValue));
  }
  if (isRecord(left) && isRecord(right)) {
    const leftKeys = Object.keys(left);
    return leftKeys.length === Object.keys(right).length
      && leftKeys.every((key) => key in right && deepEqual(left[key] as JsonValue, right[key] as JsonValue));
  }
  return false;
}

/** Tracks how many individual checks a single `validateAgainstSchema` call has spent. */
class CheckBudget {
  #remaining = MAX_CHECKS;
  /** Returns false once the budget is exhausted; callers must stop validating deeper on `false`. */
  spend(): boolean {
    if (this.#remaining <= 0) return false;
    this.#remaining -= 1;
    return true;
  }
}

/** Compiles `pattern` at most once per call and caches the result, including a failed compile. */
function compilePattern(cache: Map<string, RegExp | null>, pattern: string): RegExp | null {
  const cached = cache.get(pattern);
  if (cached !== undefined) return cached;
  let compiled: RegExp | null = null;
  if (pattern.length <= MAX_PATTERN_LENGTH) {
    try { compiled = new RegExp(`^(?:${pattern})$`, "us"); } catch { compiled = null; }
  }
  cache.set(pattern, compiled);
  return compiled;
}

function fail(toolId: string, path: string, why: string): never {
  throw new AgenticError("validation", `${toolId}: ${path || "$"} ${why}`);
}

function validateNode(
  schema: JsonValue, value: JsonValue, path: string, depth: number,
  toolId: string, budget: CheckBudget, patterns: Map<string, RegExp | null>,
): void {
  // Work cap and depth cap both fail open: anything past the budget is accepted unchecked rather
  // than rejected, because the goal is catching obvious mistakes cheaply, not exhaustive proof.
  if (!budget.spend() || depth > MAX_DEPTH || !isRecord(schema)) return;

  const declaredTypes = schema.type === undefined ? undefined
    : (Array.isArray(schema.type) ? schema.type : [schema.type]).map(String);
  if (declaredTypes) {
    const actual = typeOf(value);
    const matches = declaredTypes.some((type) => type === actual || (type === "number" && actual === "integer"));
    if (!matches) fail(toolId, path, `must be of type ${declaredTypes.join(" or ")}, got ${actual}`);
  }
  if ("const" in schema && !deepEqual(value, schema.const as JsonValue)) fail(toolId, path, "does not match const");
  if (Array.isArray(schema.enum) && !schema.enum.some((option) => deepEqual(option as JsonValue, value))) {
    fail(toolId, path, "is not one of the allowed values");
  }

  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) fail(toolId, path, `must be at least ${schema.minLength} characters`);
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) fail(toolId, path, `must be at most ${schema.maxLength} characters`);
    if (typeof schema.pattern === "string") {
      if (value.length > MAX_PATTERN_INPUT_LENGTH) fail(toolId, path, `must be at most ${MAX_PATTERN_INPUT_LENGTH} characters to match pattern`);
      const regex = compilePattern(patterns, schema.pattern);
      if (regex && !regex.test(value)) fail(toolId, path, "does not match the required pattern");
    }
  }

  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) fail(toolId, path, `must be >= ${schema.minimum}`);
    if (typeof schema.maximum === "number" && value > schema.maximum) fail(toolId, path, `must be <= ${schema.maximum}`);
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) fail(toolId, path, `must have at least ${schema.minItems} items`);
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) fail(toolId, path, `must have at most ${schema.maxItems} items`);
    if (schema.items !== undefined) {
      for (let index = 0; index < value.length; index += 1) {
        if (!budget.spend()) break;
        validateNode(schema.items, value[index] as JsonValue, `${path}[${index}]`, depth + 1, toolId, budget, patterns);
      }
    }
  }

  if (isRecord(value)) {
    const required = Array.isArray(schema.required) ? schema.required.map(String) : [];
    for (const key of required) {
      if (!budget.spend()) break;
      if (!(key in value)) fail(toolId, path, `is missing required property "${key}"`);
    }
    const properties = isRecord(schema.properties) ? schema.properties : undefined;
    if (properties) {
      for (const [key, propertySchema] of Object.entries(properties)) {
        if (!(key in value)) continue;
        if (!budget.spend()) break;
        validateNode(propertySchema, value[key] as JsonValue, path ? `${path}.${key}` : key, depth + 1, toolId, budget, patterns);
      }
    }
    if (schema.additionalProperties === false) {
      const allowed = new Set(Object.keys(properties ?? {}));
      for (const key of Object.keys(value)) {
        if (!budget.spend()) break;
        if (!allowed.has(key)) fail(toolId, path, `has an unexpected property "${key}"`);
      }
    }
  }
}

/** Throws `AgenticError("validation", "<toolId>: <path> <why>")` on the first mismatch it finds. */
export function validateAgainstSchema(schema: JsonValue, value: JsonValue, toolId: string): void {
  validateNode(schema, value, "", 0, toolId, new CheckBudget(), new Map());
}
