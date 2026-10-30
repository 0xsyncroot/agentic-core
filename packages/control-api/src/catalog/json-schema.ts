/**
 * The subset of JSON Schema (draft 2020-12) the catalog's public item schemas are written in, and the validator that reads
 * them. The published schema is the rule: the console's form, an editing MCP and the release checks all validate with the
 * same document, so a field the schema does not state is never checked somewhere else. Keywords outside this subset are
 * refused when a schema is built, so a schema cannot carry a rule the validator would silently skip.
 */

export type JsonSchemaType = "object" | "array" | "string" | "integer" | "number" | "boolean" | "null";

export interface JsonSchema {
  readonly $schema?: string;
  readonly $id?: string;
  readonly title?: string;
  readonly description?: string;
  readonly type?: JsonSchemaType | readonly JsonSchemaType[];
  readonly enum?: readonly (string | number | boolean | null)[];
  readonly const?: string | number | boolean | null;
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly required?: readonly string[];
  /** `false` refuses any key not in `properties`; a schema validates every such key's value. */
  readonly additionalProperties?: boolean | JsonSchema;
  readonly propertyNames?: JsonSchema;
  readonly maxProperties?: number;
  readonly items?: JsonSchema;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly uniqueItems?: boolean;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: string;
  readonly minimum?: number;
  readonly maximum?: number;
}

/** One failure: `path` names the field (`permission[0]`, `repeatableRows.rows`), empty for the value itself. */
export interface SchemaViolation {
  readonly path: string;
  readonly message: string;
}

const KEYWORDS = new Set([
  "$schema", "$id", "title", "description", "type", "enum", "const", "properties", "required", "additionalProperties", "propertyNames",
  "maxProperties", "items", "minItems", "maxItems", "uniqueItems", "minLength", "maxLength", "pattern", "minimum", "maximum",
]);

/** Refuses a keyword the validator does not implement, in this schema and every schema nested in it. */
export function assertSupportedSchema(schema: JsonSchema, at = "#"): JsonSchema {
  for (const key of Object.keys(schema)) if (!KEYWORDS.has(key)) throw new Error(`schema ${at} uses unsupported keyword ${key}`);
  for (const [key, nested] of Object.entries(schema.properties ?? {})) assertSupportedSchema(nested, `${at}/properties/${key}`);
  if (typeof schema.additionalProperties === "object") assertSupportedSchema(schema.additionalProperties, `${at}/additionalProperties`);
  if (schema.propertyNames) assertSupportedSchema(schema.propertyNames, `${at}/propertyNames`);
  if (schema.items) assertSupportedSchema(schema.items, `${at}/items`);
  return schema;
}

const child = (path: string, key: string): string => (path === "" ? key : `${path}.${key}`);

function typeOf(value: unknown): JsonSchemaType | "undefined" {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  if (typeof value === "string" || typeof value === "boolean" || typeof value === "object") return typeof value as JsonSchemaType;
  return "undefined";
}

function typeMatches(actual: JsonSchemaType | "undefined", expected: JsonSchemaType): boolean {
  return actual === expected || (expected === "number" && actual === "integer");
}

/** Code points, not UTF-16 units: the length a person counts and the one JSON Schema defines. */
const codePoints = (text: string): number => [...text].length;

/** Every violation of `schema` by `value`, in document order; an empty list means the value is valid. */
export function validateSchema(schema: JsonSchema, value: unknown, path = ""): SchemaViolation[] {
  const failures: SchemaViolation[] = [];
  const fail = (message: string, at = path) => { failures.push({ path: at, message }); };
  const actual = typeOf(value);
  if (schema.type !== undefined) {
    const expected = typeof schema.type === "string" ? [schema.type] : schema.type;
    if (!expected.some((type) => typeMatches(actual, type))) {
      fail(`must be ${expected.join(" or ")}`);
      return failures;
    }
  }
  if (schema.const !== undefined && value !== schema.const) fail(`must be ${JSON.stringify(schema.const)}`);
  if (schema.enum !== undefined && !schema.enum.some((option) => option === value)) fail(`must be one of ${schema.enum.map((option) => JSON.stringify(option)).join(", ")}`);
  if (typeof value === "string") stringRules(schema, value, fail);
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) fail(`must be at least ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) fail(`must be at most ${schema.maximum}`);
  }
  if (Array.isArray(value)) failures.push(...arrayRules(schema, value, path));
  else if (actual === "object") failures.push(...objectRules(schema, value as Record<string, unknown>, path));
  return failures;
}

function stringRules(schema: JsonSchema, value: string, fail: (message: string) => void): void {
  const length = codePoints(value);
  if (schema.minLength !== undefined && length < schema.minLength) fail(schema.minLength === 1 ? "must not be empty" : `must hold at least ${schema.minLength} characters`);
  if (schema.maxLength !== undefined && length > schema.maxLength) fail(`must hold at most ${schema.maxLength} characters`);
  if (schema.pattern !== undefined && !new RegExp(schema.pattern, "u").test(value)) fail(`must match ${schema.pattern}`);
}

function arrayRules(schema: JsonSchema, value: readonly unknown[], path: string): SchemaViolation[] {
  const failures: SchemaViolation[] = [];
  if (schema.minItems !== undefined && value.length < schema.minItems) failures.push({ path, message: `must hold at least ${schema.minItems} item(s)` });
  if (schema.maxItems !== undefined && value.length > schema.maxItems) failures.push({ path, message: `must hold at most ${schema.maxItems} item(s)` });
  if (schema.uniqueItems) {
    const seen = new Set<string>();
    value.forEach((item, index) => {
      const key = JSON.stringify(item);
      if (seen.has(key)) failures.push({ path: `${path}[${index}]`, message: "repeats an earlier item" });
      seen.add(key);
    });
  }
  if (schema.items) value.forEach((item, index) => failures.push(...validateSchema(schema.items as JsonSchema, item, `${path}[${index}]`)));
  return failures;
}

function objectRules(schema: JsonSchema, value: Record<string, unknown>, path: string): SchemaViolation[] {
  const failures: SchemaViolation[] = [];
  const properties = schema.properties ?? {};
  for (const key of schema.required ?? []) {
    if (!Object.hasOwn(value, key)) failures.push({ path: child(path, key), message: "is required" });
  }
  const keys = Object.keys(value);
  if (schema.maxProperties !== undefined && keys.length > schema.maxProperties) failures.push({ path, message: `must hold at most ${schema.maxProperties} key(s)` });
  for (const key of keys) {
    const at = child(path, key);
    if (schema.propertyNames) {
      for (const failure of validateSchema(schema.propertyNames, key, at)) failures.push({ path: at, message: `key ${failure.message}` });
    }
    const nested = properties[key];
    if (nested) failures.push(...validateSchema(nested, value[key], at));
    else if (schema.additionalProperties === false) failures.push({ path: at, message: "is not a known field" });
    else if (typeof schema.additionalProperties === "object") failures.push(...validateSchema(schema.additionalProperties, value[key], at));
  }
  return failures;
}
