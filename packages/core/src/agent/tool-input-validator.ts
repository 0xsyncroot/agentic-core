import { AgenticError, type JsonValue } from "@0xsyncroot/contracts";
import { allowedList, closestName, shownName } from "./schema-near-miss.js";

export interface ToolInputValidator {
  validateSchema(schema: JsonValue): void;
  validate(schema: JsonValue, value: JsonValue, subject?: "tool input" | "tool output"): void;
}

function object(value: unknown): value is Record<string, JsonValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** How many failures one refusal names. */
const MAX_REPORTED = 5;

const SCHEMA_TYPES = new Set(["object", "array", "string", "integer", "number", "boolean", "null"]);

function validType(type: JsonValue): boolean {
  if (typeof type === "string") return SCHEMA_TYPES.has(type);
  return Array.isArray(type) && type.length > 0 && type.every((name) => typeof name === "string" && SCHEMA_TYPES.has(name));
}

/** The JSON Schema type name a concrete value has, for matching against a list of allowed types. */
function typeOfValue(value: JsonValue): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "object") return "object";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

export class JsonSchemaToolInputValidator implements ToolInputValidator {
  /**
   * Keywords this validator understands, plus the annotations it accepts and ignores.
   *
   * An unknown keyword is refused rather than skipped, so a constraint this cannot enforce never
   * passes silently. Annotations are the deliberate exception: JSON Schema defines `format`,
   * `readOnly`, `writeOnly` and `deprecated` as annotations that assert nothing by default, so
   * ignoring them enforces exactly what the schema asks for.
   *
   * `format` is why this list gained them. A server generating schemas from a typed language emits
   * it as a matter of course — the C# MCP SDK writes `{"type":"string","format":"date-time"}` for a
   * DateTimeOffset — and refusing it meant the whole tool catalogue of such a server failed to
   * load, with an error naming a field rather than the incompatibility. Nothing caught it because
   * the reference implementation those tools are diffed against is written in TypeScript and emits
   * no `format` at all, so both sides agreed while neither exercised this.
   */
  readonly #supported = new Set([
    "$schema", "$id", "title", "description", "default", "examples",
    "format", "readOnly", "writeOnly", "deprecated",
    "type", "properties", "required", "additionalProperties", "items", "enum", "const",
    "minLength", "maxLength", "pattern", "minItems", "maxItems", "minimum", "maximum", "anyOf",
  ]);

  validateSchema(schema: JsonValue): void { this.#validateSchema(schema, "$"); }

  /**
   * Refuses a value the schema rejects, naming up to `MAX_REPORTED` failures at once.
   *
   * Reporting only the first sent the model through one correction per round trip; a near miss is
   * named beside the unknown name or value, so the fix is in the message that refused it.
   */
  validate(schema: JsonValue, value: JsonValue, subject: "tool input" | "tool output" = "tool input"): void {
    const failures: string[] = [];
    this.#validate(schema, value, "$", failures);
    if (failures.length > 0) throw new AgenticError("validation", `Invalid ${subject}: ${failures.slice(0, MAX_REPORTED).join("; ")}`);
  }

  #validateSchema(schema: JsonValue, path: string): void {
    if (typeof schema === "boolean") return;
    if (!object(schema)) throw new AgenticError("validation", `Invalid JSON Schema at ${path}: schema must be an object or boolean`);
    for (const keyword of Object.keys(schema)) {
      if (!this.#supported.has(keyword)) throw new AgenticError("validation", `Unsupported JSON Schema keyword at ${path}: ${keyword}`);
    }
    // `type` may be a single name or a list of them. The list form is how JSON Schema spells a
    // nullable value, and it is what every SDK that generates schemas from a typed language emits
    // for an optional parameter — the C# MCP SDK writes `["string","null"]` for a `string?`.
    // Accepting only the single form meant such a server's tool catalogue failed to load entirely.
    if (schema.type !== undefined && !validType(schema.type)) {
      throw new AgenticError("validation", `Invalid JSON Schema type at ${path}`);
    }
    if (schema.properties !== undefined) {
      if (!object(schema.properties)) throw new AgenticError("validation", `Invalid JSON Schema properties at ${path}`);
      for (const [name, child] of Object.entries(schema.properties)) this.#validateSchema(child, `${path}.properties.${name}`);
    }
    if (schema.items !== undefined) this.#validateSchema(schema.items, `${path}.items`);
    if (schema.anyOf !== undefined) {
      if (!Array.isArray(schema.anyOf) || schema.anyOf.length === 0) throw new AgenticError("validation", `Invalid JSON Schema anyOf at ${path}`);
      schema.anyOf.forEach((branch, index) => this.#validateSchema(branch, `${path}.anyOf[${index}]`));
    }
    if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== "boolean") {
      this.#validateSchema(schema.additionalProperties, `${path}.additionalProperties`);
    }
    if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some((item) => typeof item !== "string"))) {
      throw new AgenticError("validation", `Invalid JSON Schema required list at ${path}`);
    }
    if (schema.pattern !== undefined) {
      if (typeof schema.pattern !== "string") throw new AgenticError("validation", `Invalid JSON Schema pattern at ${path}`);
      try { new RegExp(schema.pattern); } catch { throw new AgenticError("validation", `Invalid JSON Schema regex at ${path}`); }
    }
  }

  #validate(schemaValue: JsonValue, value: JsonValue, path: string, failures: string[]): void {
    const fail = (at: string, message: string) => { failures.push(`${at} ${message}`); };
    if (schemaValue === true) return;
    if (schemaValue === false) return fail(path, "is rejected by the schema");
    if (!object(schemaValue)) return;
    if (Array.isArray(schemaValue.anyOf) && !schemaValue.anyOf.some((branch) => this.#accepts(branch, value, path))) {
      return fail(path, "matches none of its allowed shapes");
    }
    if (schemaValue.const !== undefined && JSON.stringify(value) !== JSON.stringify(schemaValue.const)) return fail(path, "does not equal the required constant");
    if (Array.isArray(schemaValue.enum) && !schemaValue.enum.some((item) => JSON.stringify(item) === JSON.stringify(value))) {
      const names = schemaValue.enum.map((item) => typeof item === "string" ? item : JSON.stringify(item));
      const closest = typeof value === "string" ? closestName(value, names) : undefined;
      return fail(path, `has an unsupported value${closest === undefined ? "" : ` (closest: ${closest})`}; allowed: ${allowedList(names)}`);
    }
    // With a list of types, the branch that matches the value's own type is the one whose
    // constraints apply — union semantics. A value matching none of them fails here, naming what
    // was allowed, rather than falling through every branch below and silently validating nothing.
    let expected = schemaValue.type;
    if (Array.isArray(expected)) {
      const actual = typeOfValue(value);
      const matched = expected.find((name) => name === actual || (name === "number" && actual === "integer"));
      if (matched === undefined) return fail(path, `must be one of ${expected.join(", ")}`);
      expected = matched as JsonValue;
    }
    if (expected === "object") {
      if (!object(value)) return fail(path, "must be an object");
      const properties = object(schemaValue.properties) ? schemaValue.properties : {};
      const required = Array.isArray(schemaValue.required) ? schemaValue.required : [];
      for (const name of required) if (typeof name === "string" && !(name in value)) fail(`${path}.${name}`, "is required");
      if (schemaValue.additionalProperties === false) {
        const allowed = Object.keys(properties);
        for (const name of Object.keys(value)) {
          if (name in properties) continue;
          const closest = closestName(name, allowed);
          fail(`${path}.${shownName(name)}`, `is not allowed${closest === undefined ? "" : ` (closest: ${closest})`}${allowed.length > 0 ? `; allowed: ${allowedList(allowed)}` : ""}`);
        }
      }
      for (const [name, child] of Object.entries(value)) {
        const childSchema = properties[name];
        if (childSchema !== undefined) this.#validate(childSchema, child, `${path}.${shownName(name)}`, failures);
        else if (object(schemaValue.additionalProperties) || schemaValue.additionalProperties === true) this.#validate(schemaValue.additionalProperties, child, `${path}.${shownName(name)}`, failures);
      }
    } else if (expected === "array") {
      if (!Array.isArray(value)) return fail(path, "must be an array");
      if (typeof schemaValue.minItems === "number" && value.length < schemaValue.minItems) fail(path, `must have at least ${schemaValue.minItems} items`);
      if (typeof schemaValue.maxItems === "number" && value.length > schemaValue.maxItems) fail(path, `must have at most ${schemaValue.maxItems} items`);
      if (schemaValue.items !== undefined) value.forEach((item, index) => this.#validate(schemaValue.items as JsonValue, item, `${path}[${index}]`, failures));
    } else if (expected === "string") {
      if (typeof value !== "string") return fail(path, "must be a string");
      if (typeof schemaValue.minLength === "number" && value.length < schemaValue.minLength) fail(path, `must have at least ${schemaValue.minLength} characters`);
      if (typeof schemaValue.maxLength === "number" && value.length > schemaValue.maxLength) fail(path, `must have at most ${schemaValue.maxLength} characters`);
      if (typeof schemaValue.pattern === "string" && !new RegExp(schemaValue.pattern).test(value)) fail(path, `does not match the required pattern ${schemaValue.pattern}`);
    } else if (expected === "integer" || expected === "number") {
      if (typeof value !== "number" || (expected === "integer" && !Number.isInteger(value))) return fail(path, `must be ${expected === "integer" ? "an integer" : "a number"}`);
      if (typeof schemaValue.minimum === "number" && value < schemaValue.minimum) fail(path, `must be >= ${schemaValue.minimum}`);
      if (typeof schemaValue.maximum === "number" && value > schemaValue.maximum) fail(path, `must be <= ${schemaValue.maximum}`);
    }
    else if (expected === "boolean" && typeof value !== "boolean") fail(path, "must be a boolean");
    else if (expected === "null" && value !== null) fail(path, "must be null");
  }

  /** Whether one `anyOf` branch accepts the value; its own failure is only one shape not matching. */
  #accepts(schema: JsonValue, value: JsonValue, path: string): boolean {
    const failures: string[] = [];
    this.#validate(schema, value, path, failures);
    return failures.length === 0;
  }
}
