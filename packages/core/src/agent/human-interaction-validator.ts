import {
  AgenticError,
  INTERACTION_OTHER_ANSWER,
  INTERACTION_SUGGESTION_LIMIT,
  type HumanInteractionAction,
  type HumanInteractionEcho,
  type HumanInteractionRequest,
  type JsonValue,
} from "@0xsyncroot/contracts";

const MAX_SCHEMA_BYTES = 32 * 1024;
const MAX_RESPONSE_BYTES = 32 * 1024;
const MAX_FIELDS = 20;
const MAX_CHOICES = 100;
/** The echo is a receipt for history, not a copy of the answer: a dozen lines, each readable at a glance. */
const MAX_ECHO_ENTRIES = 12;
const MAX_ECHO_LABEL_CHARS = 200;
const MAX_ECHO_VALUE_CHARS = 500;
const SENSITIVE_FIELD = /(?:password|passwd|secret|api[\s_-]*key|access[\s_-]*token|refresh[\s_-]*token|private[\s_-]*key|credit[\s_-]*card|cvv|m[aậ]t[\s_-]*kh[aẩ]u|otp)/iu;

function record(value: unknown): value is Record<string, JsonValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new AgenticError("validation", `${name} must contain 1-${max} characters`);
  }
  return value;
}

function fieldMetadata(fieldId: string, schema: Record<string, JsonValue>): string {
  return [fieldId, schema.title, schema.description].filter((value) => typeof value === "string").join(" ");
}

/** `oneOf: [{const, title, description?}]`: choices a person picks by their title, submitting the `const`. */
function titledChoices(value: JsonValue | undefined): readonly { readonly value: string; readonly title: string }[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_CHOICES) return undefined;
  const choices = value.map((candidate) => {
    if (!record(candidate) || typeof candidate.const !== "string" || typeof candidate.title !== "string" || !candidate.title.trim() ||
        (candidate.description !== undefined && typeof candidate.description !== "string")) return undefined;
    return { value: candidate.const, title: candidate.title };
  });
  if (choices.some((choice) => choice === undefined)) return undefined;
  return choices as readonly { readonly value: string; readonly title: string }[];
}

function stringChoices(schema: Record<string, JsonValue>): readonly string[] | undefined {
  if (Array.isArray(schema.enum) && schema.enum.length > 0 && schema.enum.length <= MAX_CHOICES &&
      schema.enum.every((choice) => typeof choice === "string")) return schema.enum;
  return titledChoices(schema.oneOf)?.map((choice) => choice.value);
}

/** A multiselect's titled choices sit on its items, as `oneOf` or — as older tools wrote them — `anyOf`. */
function itemChoices(schema: Record<string, JsonValue>): readonly { readonly value: string; readonly title: string }[] | undefined {
  if (!record(schema.items)) return undefined;
  return titledChoices(schema.items.oneOf ?? schema.items.anyOf);
}

function arrayChoices(schema: Record<string, JsonValue>): readonly string[] | undefined {
  if (!record(schema.items)) return undefined;
  if (Array.isArray(schema.items.enum) && schema.items.enum.length > 0 && schema.items.enum.length <= MAX_CHOICES &&
      schema.items.enum.every((choice) => typeof choice === "string")) return schema.items.enum;
  return itemChoices(schema)?.map((choice) => choice.value);
}

/**
 * Suggestions are quick picks beside a free-text answer, never the only valid answers: a short
 * list the widget lays out whole, and each one an answer the field itself would accept.
 */
function validateExamples(fieldId: string, schema: Record<string, JsonValue>): void {
  if (schema.examples === undefined) return;
  if (schema.type !== "string") throw new AgenticError("validation", `Only string interaction fields support suggestions: ${fieldId}`);
  const maxLength = typeof schema.maxLength === "number" ? schema.maxLength : Number.POSITIVE_INFINITY;
  const examples = schema.examples;
  if (!Array.isArray(examples) || examples.length === 0 || examples.length > INTERACTION_SUGGESTION_LIMIT ||
      examples.some((example) => typeof example !== "string" || !example.trim() || example.length > maxLength)) {
    throw new AgenticError("validation", `Interaction field ${fieldId} must offer 1-${INTERACTION_SUGGESTION_LIMIT} suggestions within its length limit`);
  }
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function choiceTitle(choices: readonly { readonly value: string; readonly title: string }[] | undefined, value: string): string {
  return choices?.find((choice) => choice.value === value)?.title ?? value;
}

/** An answer as the person saw it when they gave it: a choice by its title, several joined with ", ". */
function echoValue(schema: Record<string, JsonValue>, value: JsonValue): string {
  if (Array.isArray(value)) {
    const choices = itemChoices(schema);
    return value.map((item) => choiceTitle(choices, String(item))).join(", ");
  }
  if (typeof value === "string") return choiceTitle(titledChoices(schema.oneOf), value);
  return String(value);
}

function validateFormat(format: JsonValue | undefined, value: string, field: string): void {
  if (format === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    throw new AgenticError("validation", `Interaction field ${field} must be an email address`);
  }
  if (format === "uri") {
    try { new URL(value); }
    catch { throw new AgenticError("validation", `Interaction field ${field} must be an absolute URI`); }
  }
  if (format === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new AgenticError("validation", `Interaction field ${field} must be an ISO date`);
  }
  if (format === "date-time" && (!value.includes("T") || !Number.isFinite(Date.parse(value)))) {
    throw new AgenticError("validation", `Interaction field ${field} must be an ISO date-time`);
  }
}

/** Security boundary for every tool-originated interaction, regardless of adapter or UI. */
export class HumanInteractionValidator {
  validateRequest(request: HumanInteractionRequest): void {
    text(request.message, "interaction message", 2_000);
    if (request.title !== undefined) text(request.title, "interaction title", 120);
    if (request.ttlMs !== undefined && (!Number.isSafeInteger(request.ttlMs) || request.ttlMs < 1_000)) {
      throw new AgenticError("validation", "Interaction ttlMs must be a whole number of milliseconds, at least 1000");
    }
    if (request.kind === "external") {
      text(request.externalId, "external interaction id", 256);
      if (request.url.length > 4_096) throw new AgenticError("validation", "External interaction URL is too long");
      let url: URL;
      try { url = new URL(request.url); }
      catch { throw new AgenticError("validation", "External interaction URL is invalid"); }
      const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1" || url.hostname === "[::1]";
      if (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) {
        throw new AgenticError("denied", "External interaction URL must use HTTPS");
      }
      if (url.username || url.password || url.hash) {
        throw new AgenticError("denied", "External interaction URL must not contain credentials or a fragment");
      }
      return;
    }
    this.#validateFormSchema(request.requestedSchema);
  }

  validateResponse(request: HumanInteractionRequest, action: HumanInteractionAction, content: JsonValue | undefined): void {
    if (action !== "accept") {
      if (content !== undefined) throw new AgenticError("validation", "Declined or cancelled interactions must not include content");
      return;
    }
    if (request.kind === "external") {
      if (content !== undefined) throw new AgenticError("validation", "External interactions must not return credentials or content");
      return;
    }
    if (!record(content)) throw new AgenticError("validation", "Accepted form interaction requires an object response");
    if (Buffer.byteLength(JSON.stringify(content), "utf8") > MAX_RESPONSE_BYTES) throw new AgenticError("budget-exceeded", "Interaction response exceeds 32 KiB");
    this.#validateFormContent(request.requestedSchema, content);
  }

  /**
   * What the user answered, as they saw it, for history to show beside the question: each field's
   * title and the answer's title. Built from a response `validateResponse` accepted; nothing for a
   * question skipped, dismissed or answered out of band.
   */
  echo(request: HumanInteractionRequest, action: HumanInteractionAction, content: JsonValue | undefined): HumanInteractionEcho | undefined {
    if (action !== "accept" || request.kind !== "form" || !record(content)) return undefined;
    const schema = request.requestedSchema;
    if (!record(schema) || !record(schema.properties)) return undefined;
    const entries: { readonly label: string; readonly value: string }[] = [];
    for (const [fieldId, field] of Object.entries(schema.properties)) {
      const answer = content[fieldId];
      // A `readOnly` field is filled by the host that answered the card, not by the person: it is no part of the receipt.
      if (entries.length >= MAX_ECHO_ENTRIES || answer === undefined || !record(field) || field.readOnly === true) continue;
      const value = echoValue(field, answer);
      if (!value.trim()) continue;
      const title = typeof field.title === "string" && field.title.trim() ? field.title.trim() : fieldId;
      entries.push(Object.freeze({ label: clip(title, MAX_ECHO_LABEL_CHARS), value: clip(value, MAX_ECHO_VALUE_CHARS) }));
    }
    return entries.length > 0 ? Object.freeze(entries) : undefined;
  }

  #validateFormSchema(value: JsonValue): void {
    const serialized = JSON.stringify(value);
    if (Buffer.byteLength(serialized, "utf8") > MAX_SCHEMA_BYTES) throw new AgenticError("budget-exceeded", "Interaction schema exceeds 32 KiB");
    if (!record(value) || value.type !== "object" || !record(value.properties)) {
      throw new AgenticError("validation", "Form interaction requires an object schema with properties");
    }
    const properties = value.properties;
    const fields = Object.entries(properties);
    if (fields.length === 0 || fields.length > MAX_FIELDS) throw new AgenticError("validation", `Form interaction requires 1-${MAX_FIELDS} fields`);
    const required = value.required === undefined ? [] : value.required;
    if (!Array.isArray(required) || required.some((item) => typeof item !== "string" || !(item in properties))) {
      throw new AgenticError("validation", "Form interaction has an invalid required list");
    }
    for (const [fieldId, fieldValue] of fields) {
      if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(fieldId) || !record(fieldValue)) {
        throw new AgenticError("validation", `Invalid interaction field ${fieldId}`);
      }
      if (SENSITIVE_FIELD.test(fieldMetadata(fieldId, fieldValue))) {
        throw new AgenticError("denied", `Sensitive field ${fieldId} must use an external interaction`);
      }
      const type = fieldValue.type;
      if (type !== "string" && type !== "number" && type !== "integer" && type !== "boolean" && type !== "array") {
        throw new AgenticError("validation", `Unsupported interaction field type for ${fieldId}`);
      }
      if (type === "array") {
        if (!arrayChoices(fieldValue)) {
          throw new AgenticError("validation", `Interaction array field ${fieldId} must contain enumerated strings`);
        }
      }
      if (type === "string" && (fieldValue.enum !== undefined || fieldValue.oneOf !== undefined) && !stringChoices(fieldValue)) {
        throw new AgenticError("validation", `Invalid choices for interaction field ${fieldId}`);
      }
      if (fieldValue.enum !== undefined && type !== "string") {
        throw new AgenticError("validation", `Only string interaction fields support enum choices: ${fieldId}`);
      }
      if (fieldValue[INTERACTION_OTHER_ANSWER] !== undefined && (fieldValue[INTERACTION_OTHER_ANSWER] !== true || type !== "string" || !stringChoices(fieldValue))) {
        throw new AgenticError("validation", `Only a string choice field may take another answer: ${fieldId}`);
      }
      if (fieldValue.format !== undefined && !["date", "date-time", "email", "uri"].includes(String(fieldValue.format))) {
        throw new AgenticError("validation", `Unsupported format for interaction field ${fieldId}`);
      }
      validateExamples(fieldId, fieldValue);
    }
  }

  #validateFormContent(schemaValue: JsonValue, content: Record<string, JsonValue>): void {
    this.#validateFormSchema(schemaValue);
    const schema = schemaValue as Record<string, JsonValue>;
    const properties = schema.properties as Record<string, JsonValue>;
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const field of required) if (typeof field === "string" && !(field in content)) {
      throw new AgenticError("validation", `Interaction field ${field} is required`);
    }
    for (const [field, value] of Object.entries(content)) {
      const raw = properties[field];
      if (!record(raw)) throw new AgenticError("validation", `Interaction field ${field} is not allowed`);
      const type = raw.type;
      const validType = type === "string" ? typeof value === "string"
        : type === "boolean" ? typeof value === "boolean"
          : type === "number" ? typeof value === "number" && Number.isFinite(value)
            : type === "integer" ? typeof value === "number" && Number.isInteger(value)
              : type === "array" ? Array.isArray(value) && value.every((item) => typeof item === "string")
                : false;
      if (!validType) throw new AgenticError("validation", `Interaction field ${field} has an invalid value`);
      // An open list takes the person's own words as its value; a closed one only its choices.
      const own = raw[INTERACTION_OTHER_ANSWER] === true && typeof value === "string" && value.trim() !== "";
      if (Array.isArray(raw.enum) && !own && !raw.enum.some((item) => JSON.stringify(item) === JSON.stringify(value))) {
        throw new AgenticError("validation", `Interaction field ${field} is outside its enum`);
      }
      if (typeof value === "string") {
        if (typeof raw.minLength === "number" && value.length < raw.minLength) throw new AgenticError("validation", `Interaction field ${field} is too short`);
        if (typeof raw.maxLength === "number" && value.length > raw.maxLength) throw new AgenticError("validation", `Interaction field ${field} is too long`);
        const allowed = stringChoices(raw);
        if (allowed && !allowed.includes(value) && !own) throw new AgenticError("validation", `Interaction field ${field} is outside its choices`);
        validateFormat(raw.format, value, field);
      }
      if (typeof value === "number") {
        if (typeof raw.minimum === "number" && value < raw.minimum) throw new AgenticError("validation", `Interaction field ${field} is below its minimum`);
        if (typeof raw.maximum === "number" && value > raw.maximum) throw new AgenticError("validation", `Interaction field ${field} is above its maximum`);
      }
      if (Array.isArray(value)) {
        const allowed = arrayChoices(raw) ?? [];
        if (typeof raw.minItems === "number" && value.length < raw.minItems) throw new AgenticError("validation", `Interaction field ${field} has too few choices`);
        if (typeof raw.maxItems === "number" && value.length > raw.maxItems) throw new AgenticError("validation", `Interaction field ${field} has too many choices`);
        if (value.some((item) => typeof item !== "string" || !allowed.includes(item))) throw new AgenticError("validation", `Interaction field ${field} contains an unsupported choice`);
      }
    }
  }
}
