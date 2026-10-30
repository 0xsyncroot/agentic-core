import {
  INTERACTION_OTHER_ANSWER,
  INTERACTION_SUGGESTION_LIMIT,
  TOOL_EXECUTION_RESPONSE_PROTOCOL,
  type JsonValue,
  type ToolDefinition,
  type ToolInvocation,
} from "@0xsyncroot/contracts";
import { objectArguments } from "./arguments.js";

const FIELD_TYPES = ["text", "multiline", "number", "integer", "boolean", "select", "multiselect", "suggest", "date", "email"] as const;
type FieldType = typeof FIELD_TYPES[number];

const MAX_FIELDS = 20;
const MAX_CHOICES = 50;
const MAX_CHOICE_CHARS = 200;
/** What a card shows as a field's title; a longer question is shortened there and kept whole in its description. */
const MAX_LABEL_CHARS = 120;
/** The longest question a field accepts at all, title and description together. */
const MAX_QUESTION_CHARS = 500;

/** One option: what the tool receives back (`value`), what the user reads (`label`), and a line on what it means. */
interface Choice {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
}

interface FieldSpec {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly type: FieldType;
  readonly required?: boolean;
  readonly choices?: readonly Choice[];
}

function choiceText(value: JsonValue | undefined, what: string, fieldId: string): string | undefined {
  if (value === undefined) return undefined;
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > MAX_CHOICE_CHARS) throw new Error(`User input field ${fieldId} has a choice ${what} that is not 1-${MAX_CHOICE_CHARS} characters`);
  return text;
}

/** A plain string is its own label; an object may name its label and a one-line description. */
function choice(value: JsonValue, fieldId: string): Choice {
  if (typeof value === "string") {
    const text = choiceText(value, "value", fieldId)!;
    return { value: text, label: text };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`User input field ${fieldId} has an invalid choice`);
  const text = choiceText(value.value ?? "", "value", fieldId)!;
  const label = choiceText(value.label, "label", fieldId);
  const description = choiceText(value.description, "description", fieldId);
  return { value: text, label: label ?? text, ...(description ? { description } : {}) };
}

function choices(input: Record<string, JsonValue>, id: string, type: FieldType): readonly Choice[] | undefined {
  // An empty list is no list: a suggest field with none is a plain open question.
  const parsed = Array.isArray(input.choices) && input.choices.length > 0 ? input.choices.map((item) => choice(item, id)) : undefined;
  if ((type === "select" || type === "multiselect") && parsed !== undefined && parsed.length > MAX_CHOICES) {
    throw new Error(`User input field ${id} requires 1-${MAX_CHOICES} choices`);
  }
  // Suggestions are quick picks alongside a free-text answer, not a closed set: too many stop
  // reading like a shortlist, so they are capped at the number every client lays out whole.
  if (type === "suggest" && parsed !== undefined && parsed.length > INTERACTION_SUGGESTION_LIMIT) {
    throw new Error(`User input field ${id} requires 1-${INTERACTION_SUGGESTION_LIMIT} suggestions`);
  }
  if (parsed && new Set(parsed.map((item) => item.value)).size !== parsed.length) throw new Error(`User input field ${id} repeats a choice value`);
  return parsed;
}

/** A question longer than a title: shortened at a word for the title, kept whole at the head of the description. */
function titled(label: string, description: string | undefined): { readonly label: string; readonly description?: string } {
  if (label.length <= MAX_LABEL_CHARS) return { label, ...(description ? { description } : {}) };
  const cut = label.slice(0, MAX_LABEL_CHARS - 1), space = cut.lastIndexOf(" ");
  return { label: `${(space > MAX_LABEL_CHARS / 2 ? cut.slice(0, space) : cut).trimEnd()}…`, description: [label, description].filter(Boolean).join("\n").slice(0, MAX_QUESTION_CHARS) };
}

/**
 * One field. A choice field sent with no choices is asked as an open question, and a question
 * longer than a title keeps its whole text in the description: refusing either sends the model
 * back to retry, each retry another step that rewrites the answer the card follows, while the
 * user could answer either one as it stands.
 */
function field(value: JsonValue, index: number): FieldSpec {
  const input = objectArguments(value);
  const id = typeof input.id === "string" ? input.id.trim() : "";
  const question = typeof input.label === "string" ? input.label.trim() : "";
  const asked = input.type as FieldType;
  if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(id) || !question || question.length > MAX_QUESTION_CHARS) {
    throw new Error(`User input field at index ${index} needs an id and a label of 1-${MAX_QUESTION_CHARS} characters`);
  }
  if (!FIELD_TYPES.includes(asked)) throw new Error(`Unsupported user input field type: ${String(input.type)}`);
  const open = (asked === "select" || asked === "multiselect") && !(Array.isArray(input.choices) && input.choices.length > 0);
  const type: FieldType = open ? "text" : asked;
  const parsed = open ? undefined : choices(input, id, type);
  const description = typeof input.description === "string" && input.description.trim() ? input.description.trim().slice(0, MAX_QUESTION_CHARS) : undefined;
  return {
    id, type, ...titled(question, description),
    ...(input.required === true ? { required: true } : {}), ...(parsed ? { choices: parsed } : {}),
  };
}

/** The request, checked whole: every field titled, every choice list within its bounds. */
function parseRequest(value: JsonValue): { readonly message: string; readonly title?: string; readonly fields: readonly FieldSpec[] } {
  const input = objectArguments(value);
  const message = typeof input.message === "string" ? input.message.trim() : "";
  if (!message) throw new Error("request_user_input requires a message");
  // A question with no field is one free fact, and that is asked in chat, not on a card.
  if (!Array.isArray(input.fields) || input.fields.length === 0 || input.fields.length > MAX_FIELDS) {
    throw new Error(`request_user_input requires 1-${MAX_FIELDS} fields; ask a single free question in chat instead`);
  }
  const fields = input.fields.map(field);
  if (new Set(fields.map((spec) => spec.id)).size !== fields.length) throw new Error("request_user_input field ids must be unique");
  return { message, ...(typeof input.title === "string" && input.title.trim() ? { title: input.title.trim() } : {}), fields };
}

/** An answer is a value the user gave: a missing key, null, blank text and an empty selection are none. */
function isAnswered(value: JsonValue | undefined): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  return !Array.isArray(value) || value.length > 0;
}

/**
 * The ids of the asked fields the accepted content holds no answer for, optional ones included: a fact the
 * model reads, not an instruction. The asked fields come from the call's original arguments; when those cannot
 * be read (a card raised before this result existed) nothing is reported, and the resume still succeeds.
 */
function unansweredFields(args: JsonValue, values: JsonValue): string[] {
  try {
    const given = values && typeof values === "object" && !Array.isArray(values) ? values : {};
    return parseRequest(args).fields.filter((spec) => !isAnswered(given[spec.id])).map((spec) => spec.id);
  } catch {
    return [];
  }
}

function titledChoice(item: Choice): Record<string, JsonValue> {
  return { const: item.value, title: item.label, ...(item.description ? { description: item.description } : {}) };
}

function fieldSchema(spec: FieldSpec): Record<string, JsonValue> {
  const metadata = { title: spec.label, ...(spec.description ? { description: spec.description } : {}) };
  const options = spec.choices ?? [];
  if (spec.type === "number" || spec.type === "integer") return { ...metadata, type: spec.type };
  if (spec.type === "boolean") return { ...metadata, type: "boolean" };
  // Choices are `oneOf` consts: the card shows each title and description, and submits the value.
  if (spec.type === "multiselect") return {
    ...metadata, type: "array", items: { type: "string", oneOf: options.map(titledChoice) }, maxItems: options.length,
  };
  return {
    ...metadata, type: "string",
    // A list drawn up by the agent may miss what the person means: they can answer in their own words instead.
    ...(spec.type === "select" ? { oneOf: options.map(titledChoice), [INTERACTION_OTHER_ANSWER]: true } : {}),
    // Not a choice list: examples are illustrations, not a closed set (JSON Schema's own meaning
    // for the keyword), so a client renders them as quick picks that fill the field, never as the
    // only valid answers — the user can still type something none of them named. A suggestion
    // fills the field with the words the user reads, so a labelled one contributes its label.
    ...(spec.type === "suggest" && spec.choices ? { examples: options.map((item) => item.label) } : {}),
    ...(spec.type === "date" || spec.type === "email" ? { format: spec.type } : {}),
    ...(spec.type === "multiline" ? { maxLength: 8_000 } : { maxLength: 2_000 }),
  };
}

const choiceSchema: Record<string, JsonValue> = {
  anyOf: [
    { type: "string", minLength: 1, maxLength: MAX_CHOICE_CHARS },
    {
      type: "object", additionalProperties: false, required: ["value"],
      properties: {
        value: { type: "string", minLength: 1, maxLength: MAX_CHOICE_CHARS, description: "What you receive back when this option is picked." },
        label: { type: "string", minLength: 1, maxLength: MAX_CHOICE_CHARS, description: "What the user reads; defaults to the value." },
        description: { type: "string", minLength: 1, maxLength: MAX_CHOICE_CHARS, description: "One line on what picking it means." },
      },
    },
  ],
};

/**
 * How to ask, written once for the model: the same decision table the system prompt carries, so
 * the tool's own description never contradicts it.
 */
const DESCRIPTION = [
  "Ask the user for something only they can supply, as a card in the chat; their answer comes back as this tool's result. Choose by what you are asking:",
  "- One free fact you cannot guess (a name, a date, an amount): do not call this tool; ask it in plain chat text.",
  "- Yes or no, or a choice among a few known options: a 'select' field ('multiselect' when several may apply). Give each choice a short label and, when it helps, a one-line description. A select's answer may also be the user's own words.",
  `- An open answer where you can guess 1-${INTERACTION_SUGGESTION_LIMIT} likely values (for example the closest names a lookup returned): a 'suggest' field with those guesses as choices. They show as quick picks, and the user can still type anything else.`,
  "- Several questions at once: ONE call with one field per question; each is shown as its own tab, followed by a review tab. Never several calls.",
  "Every field needs an id and a label (its title, best under 120 characters). A choice is a string, or {value, label, description} where value is what you receive back; a 'suggest' field's quick picks go in `choices` too.",
  "A select always carries its `choices`: one sent without them reaches the user as a blank text box. A yes/no question with room for details: fields: [{\"id\": \"change\", \"label\": \"Anything to change first?\", \"type\": \"select\", \"choices\": [\"No change\", \"Change needed\"]}, {\"id\": \"details\", \"label\": \"What to change\", \"type\": \"multiline\"}].",
  "A question the user skipped or left unanswered is not an answer: never state or act on an answer the user did not give. Never request passwords, tokens, API keys, OTPs or payment credentials.",
].join("\n");

/** Neutral, non-sensitive user input primitive. Credentials must use an external connector flow. */
export function createUserInputTool(): ToolDefinition {
  return {
    id: "request_user_input", version: "1.0.0",
    description: DESCRIPTION,
    inputSchema: {
      type: "object", additionalProperties: false, required: ["message", "fields"],
      properties: {
        title: { type: "string", maxLength: 120 },
        message: { type: "string", minLength: 1, maxLength: 2_000 },
        fields: {
          type: "array", minItems: 1, maxItems: MAX_FIELDS,
          items: {
            type: "object", additionalProperties: false, required: ["id", "label", "type"],
            properties: {
              id: { type: "string", pattern: "^[A-Za-z][A-Za-z0-9_.-]{0,63}$" },
              label: { type: "string", minLength: 1, maxLength: MAX_QUESTION_CHARS },
              description: { type: "string", maxLength: 500 },
              type: { type: "string", enum: [...FIELD_TYPES] },
              required: { type: "boolean" },
              choices: { type: "array", maxItems: MAX_CHOICES, items: choiceSchema },
            },
          },
        },
      },
    },
    outputSchema: {
      type: "object", additionalProperties: false, required: ["action", "values"],
      properties: {
        action: { type: "string", enum: ["accept", "decline", "cancel"] },
        values: { type: "object", additionalProperties: true },
        unanswered: { type: "array", items: { type: "string" } },
      },
    },
    requiredPermissions: [], sideEffect: "none", timeoutMs: 30_000, asksUser: true,
    // Checked before the card is raised: a malformed question comes back to the model to fix, and
    // the user never sees a card the runtime would then refuse.
    validateArguments: (args) => { parseRequest(args); },
    execute: async (invocation: ToolInvocation) => {
      if (invocation.interaction) {
        const { action, content } = invocation.interaction;
        const values = content ?? {};
        const unanswered = action === "accept" ? unansweredFields(invocation.arguments, values) : [];
        return { action, values, ...(unanswered.length > 0 ? { unanswered } : {}) };
      }
      const request = parseRequest(invocation.arguments);
      const properties = Object.fromEntries(request.fields.map((spec) => [spec.id, fieldSchema(spec)]));
      return {
        protocol: TOOL_EXECUTION_RESPONSE_PROTOCOL,
        kind: "interaction-required",
        request: {
          kind: "form", message: request.message, ...(request.title ? { title: request.title } : {}),
          requestedSchema: { type: "object", properties, required: request.fields.filter((spec) => spec.required).map((spec) => spec.id) },
        },
      };
    },
  };
}
