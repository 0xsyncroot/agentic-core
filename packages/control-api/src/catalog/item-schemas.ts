import { CATALOG_ITEM_KINDS, CATALOG_SCHEMA_VERSION, catalogBodyFormat, MAX_SKILL_CLOSING_CHARS, TOOL_GROUP_FACTS, type CatalogItemKind, type ToolGroupFact } from "@0xsyncroot/contracts";
import { assertSupportedSchema, type JsonSchema } from "./json-schema.js";

/**
 * The public schema of each catalog item kind, version 1. A `tool`, `connector` or `group` body is a JSON object; a `skill`
 * or `profile` body is Markdown whose YAML frontmatter the schema describes. The item id is the item's key and is never
 * repeated inside a JSON body. What only code can do (a custom validation, a confirmation card, a composite call) is named
 * by `behaviour` and resolved by the build that runs the release, never stored as code.
 */

const DRAFT = "https://json-schema.org/draft/2020-12/schema";

/** A reference to another item, a permission or a behaviour: printable ASCII the catalog's id columns hold. */
const REFERENCE = "^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$";
/** Text with at least one visible character. */
const VISIBLE = "\\S";
const SEMVER = "^\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?$";
const SIDE_EFFECTS = ["none", "idempotent", "nonIdempotent"] as const;
/** Kinds of connector a build knows how to open; the address, secret or command stays in deploy configuration. */
export const CATALOG_CONNECTOR_KINDS = ["intent-adapter", "mcp-http", "mcp-stdio"] as const;
/** Connector kinds whose tools are discovered at runtime and named `mcp_<connection>_<tool>`. */
export const CONTEXTUAL_CONNECTOR_KINDS: readonly CatalogConnectorKind[] = ["mcp-http", "mcp-stdio"];
/** The longest purpose a tool group may carry (core's tool-group catalog rule). */
export const MAX_GROUP_PURPOSE_CHARS = 400;
/** The longest group id core's tool-group catalog accepts. */
export const MAX_GROUP_ID_CHARS = 64;

export type CatalogConnectorKind = (typeof CATALOG_CONNECTOR_KINDS)[number];
export type CatalogSideEffect = (typeof SIDE_EFFECTS)[number];

export interface ToolItemBody {
  readonly connector: string;
  readonly intent: string;
  readonly kind: "report" | "action";
  readonly access: "read" | "write";
  readonly sideEffect: CatalogSideEffect;
  readonly permission: readonly string[];
  readonly group: string;
  readonly traceLabel: string | null;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly timeoutMs: number;
  readonly behaviour?: string;
  readonly readback?: boolean;
  readonly optional?: boolean;
  readonly repeatableRows?: Readonly<Record<string, "subset" | "whole">>;
}

export interface ConnectorItemBody {
  readonly kind: CatalogConnectorKind;
  readonly connection: string;
  /** Raises the risk of named tools of the connection; lowering stays in deploy configuration. */
  readonly riskOverrides?: Readonly<Record<string, Exclude<CatalogSideEffect, "none">>>;
}

export interface GroupItemBody {
  readonly purpose: string;
  /** The group's rank in the agent's group list, lowest first. */
  readonly order: number;
  /** Members in the order the model reads them, tools the build provides included. */
  readonly toolIds: readonly string[];
  readonly requires?: ToolGroupFact;
}

export interface SkillFrontmatter {
  readonly id: string;
  readonly version: string;
  readonly name: string;
  readonly description: string;
  readonly role?: "procedure" | "supporting";
  readonly requiredTools?: readonly string[];
  readonly done?: readonly string[];
  readonly preconditions?: Readonly<Record<string, { readonly after: readonly string[] }>>;
}

export interface ProfileFrontmatter {
  readonly id: string;
  readonly version: string;
  readonly name: string;
  readonly description: string;
  readonly supportedDomains?: readonly string[];
  readonly preloadSkills?: readonly string[];
  readonly conditionalSkills?: readonly string[];
}

const reference = (description: string): JsonSchema => ({ type: "string", pattern: REFERENCE, description });
const visible = (maxLength: number, description: string): JsonSchema => ({ type: "string", pattern: VISIBLE, maxLength, description });
const references = (description: string, extra: JsonSchema = {}): JsonSchema => ({ type: "array", items: reference("An id."), uniqueItems: true, description, ...extra });

const TOOL: JsonSchema = {
  type: "object", additionalProperties: false,
  required: ["connector", "intent", "kind", "access", "sideEffect", "permission", "group", "traceLabel", "description", "inputSchema", "timeoutMs"],
  properties: {
    connector: reference("The id of the connector item the tool calls through."),
    intent: { type: "string", pattern: VISIBLE, maxLength: 200, description: "The operation the connector runs: an intent name or a server tool name." },
    kind: { enum: ["report", "action"], description: "`report` reads (access read, sideEffect none); `action` writes." },
    access: { enum: ["read", "write"] },
    sideEffect: { enum: [...SIDE_EFFECTS], description: "What a call changes; a write is never `none`." },
    permission: references("Permissions a caller must hold, every one of them.", { minItems: 1 }),
    group: reference("The id of the group item the tool belongs to."),
    traceLabel: { type: ["string", "null"], minLength: 1, description: "The phrase shown while the tool runs; null uses the generic line." },
    description: { type: "string", pattern: VISIBLE, description: "What the model reads about when and how to call the tool." },
    inputSchema: {
      type: "object", required: ["type"], properties: { type: { const: "object" } },
      description: "The JSON Schema of the call's arguments, an object schema.",
    },
    timeoutMs: { type: "integer", minimum: 1, description: "How long one call may run, in milliseconds." },
    behaviour: reference("A behaviour the build registers for what only code does: validation, card, composite call, readback."),
    readback: { type: "boolean", description: "The runtime reads back with this tool to confirm a write; read tools only." },
    optional: { type: "boolean", description: "The connector may not offer the operation; the tool is then left out." },
    repeatableRows: {
      type: "object", propertyNames: { type: "string", pattern: "^[A-Za-z_][A-Za-z0-9_]{0,63}$" },
      additionalProperties: { enum: ["subset", "whole"] },
      description: "Row arrays a repeat of an approved write may resend without a second card; write tools only.",
    },
  },
};

const CONNECTOR: JsonSchema = {
  type: "object", additionalProperties: false, required: ["kind", "connection"],
  properties: {
    kind: { enum: [...CATALOG_CONNECTOR_KINDS] },
    connection: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$", description: "The connection's name in deploy configuration." },
    riskOverrides: {
      type: "object", propertyNames: { type: "string", pattern: REFERENCE },
      additionalProperties: { enum: ["idempotent", "nonIdempotent"] },
      description: "Raises the side effect of named server tools; a lower risk is set only in deploy configuration.",
    },
  },
};

const GROUP: JsonSchema = {
  type: "object", additionalProperties: false, required: ["purpose", "order", "toolIds"],
  properties: {
    purpose: visible(MAX_GROUP_PURPOSE_CHARS, "One line on what the group's tools do: what the turn's judge weighs a request against."),
    order: { type: "integer", minimum: 0, description: "The group's rank in the agent's group list, lowest first." },
    toolIds: references("Members in the order the model reads them.", { minItems: 1 }),
    requires: { enum: [...TOOL_GROUP_FACTS], description: "A session fact without which the group is left out." },
  },
};

const SKILL: JsonSchema = {
  type: "object", additionalProperties: false, required: ["id", "version", "name", "description"],
  description: `The frontmatter of a skill. The body after it holds the instructions; an optional \`<!-- closing -->\` line starts a closing of at most ${MAX_SKILL_CLOSING_CHARS} characters.`,
  properties: {
    id: { type: "string", pattern: "^[a-z0-9][a-z0-9.-]{1,99}$", description: "Equals the item id." },
    version: { type: "string", pattern: SEMVER },
    name: visible(120, "The skill's name."),
    description: visible(1_000, "When the skill applies: what the agent routes on."),
    role: { enum: ["procedure", "supporting"] },
    requiredTools: { type: "array", items: { type: "string", pattern: VISIBLE }, description: "Tools the skill needs; each is a release tool or a contextual connector tool." },
    done: { type: "array", maxItems: 12, items: visible(400, "One completion criterion, `<condition> => <requirement>` at most once."), description: "Completion criteria." },
    preconditions: {
      type: "object",
      additionalProperties: {
        type: "object", additionalProperties: false, required: ["after"],
        properties: { after: { type: "array", minItems: 1, items: { type: "string", pattern: VISIBLE } } },
      },
      description: "Write tool id → tools that must have run first; every id is one of requiredTools.",
    },
  },
};

const PROFILE: JsonSchema = {
  type: "object", additionalProperties: false, required: ["id", "version", "name", "description"],
  description: "The frontmatter of an agent profile. The body holds its instructions (with an optional closing), 12,000 characters at most.",
  properties: {
    id: { type: "string", pattern: "^[a-z0-9][a-z0-9.-]{1,99}$", description: "Equals the item id." },
    version: { type: "string", pattern: SEMVER },
    name: visible(120, "The profile's name."),
    description: visible(500, "What the agent is for."),
    supportedDomains: { type: "array", maxItems: 50, items: visible(160, "One domain.") },
    preloadSkills: { type: "array", maxItems: 20, items: { type: "string", pattern: "^[a-z0-9][a-z0-9._-]{1,99}$" }, description: "Skills loaded with the profile; each is a release skill." },
    conditionalSkills: { type: "array", items: { type: "string", pattern: VISIBLE }, description: "Preloaded skills the runtime may leave out of a turn." },
  },
};

const BODIES: Readonly<Record<CatalogItemKind, JsonSchema>> = { tool: TOOL, connector: CONNECTOR, group: GROUP, skill: SKILL, profile: PROFILE };

/** The published schema of each kind, with its `$id`, title and the format the body is stored in. */
export const CATALOG_ITEM_SCHEMAS: Readonly<Record<CatalogItemKind, JsonSchema>> = Object.freeze(Object.fromEntries(CATALOG_ITEM_KINDS.map((kind) => [
  kind, assertSupportedSchema({
    $schema: DRAFT, $id: `catalog/${kind}/${CATALOG_SCHEMA_VERSION}`,
    title: catalogBodyFormat(kind) === "markdown" ? `${kind} frontmatter` : `${kind} body`, ...BODIES[kind],
  }),
])) as Record<CatalogItemKind, JsonSchema>);
