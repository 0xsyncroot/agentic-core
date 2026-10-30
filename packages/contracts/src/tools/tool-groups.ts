import type { JsonValue } from "../shared/json.js";

/**
 * Tools a turn is offered together. A composition names its groups and says in one line what each is for; core asks the
 * turn's judge, one group per call, whether the request needs a group, and leaves a group out of a turn only when the judge
 * is confident it is not needed. A tool in no group is offered on every turn, as is every tool when no judge is mounted.
 */
export interface ToolGroup {
  /** The composition's own name for the group, unique in its catalog. */
  readonly id: string;
  /** One line on what the group's tools do: what the judge weighs the request against. */
  readonly purpose: string;
  readonly toolIds: readonly string[];
  /** A fact core checks before the judge is asked: while it does not hold, the group is left out without asking. */
  readonly requires?: ToolGroupFact;
}

/**
 * Facts core reads from the session's journal, before any judgment. `files`: the conversation holds a file a user attached.
 * A group whose tools only work on such facts (reading attached files) can be needed by no request while the fact is false,
 * however a request is worded, and asking the judge about it spends a call to be told the request mentions a file.
 */
export const TOOL_GROUP_FACTS = ["files"] as const;
export type ToolGroupFact = typeof TOOL_GROUP_FACTS[number];

export interface ToolGroupCatalog {
  readonly groups: readonly ToolGroup[];
  /** The tool that offers a left-out group's tools for the rest of a turn, and the argument naming the group. */
  readonly loader: { readonly toolId: string; readonly argument: string };
}

/** What a turn's offer rests on: the judge's verdicts, or a request that carries no signal of its own, or a later load. */
export const TOOL_SELECTION_BASES = ["judged", "resume", "short-request", "added"] as const;
export type ToolSelectionBasis = typeof TOOL_SELECTION_BASES[number];

/**
 * Why one group is offered or left out. `every-group`: the basis offers every group. `skill`: a skill in effect requires
 * one of its tools. `session`: the session offered it earlier (an earlier `tool/selection` row offered it, or the agent
 * called one of its tools), and a session's offer only grows. `needed`: the judge was not
 * confident the request goes without it. `no-verdict`: the judge gave no answer. `not-needed`: left out. `loaded`: the
 * loader offered it during the turn. `skill-loaded`: a skill loaded during the turn requires one of its tools. `no-fact`: the
 * group's declared fact (`ToolGroup.requires`) does not hold, so it is left out without asking the judge.
 */
export const TOOL_SELECTION_REASONS = ["every-group", "skill", "session", "needed", "no-verdict", "not-needed", "no-fact", "loaded", "skill-loaded"] as const;
export type ToolSelectionReason = typeof TOOL_SELECTION_REASONS[number];

/** The `tool/selection` payload: group ids and reasons only. `shadow`: nothing was left out; `offered` says what "on" would offer. */
export interface ToolSelectionPayload {
  readonly basis: ToolSelectionBasis;
  readonly groups: readonly { readonly group: string; readonly offered: boolean; readonly reason: ToolSelectionReason }[];
  readonly shadow?: true;
}

const MAX_GROUPS = 64;
const MAX_GROUP_ID_CHARS = 64;
const MAX_PURPOSE_CHARS = 400;
const GROUP_KEYS = new Set(["group", "offered", "reason"]);
const PAYLOAD_KEYS = new Set(["basis", "groups", "shadow"]);
const BASES = new Set<string>(TOOL_SELECTION_BASES);
const REASONS = new Set<string>(TOOL_SELECTION_REASONS);
const FACTS = new Set<string>(TOOL_GROUP_FACTS);

const groupId = (value: unknown): value is string =>
  typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= MAX_GROUP_ID_CHARS;

/** A catalog core can select from: bounded unique ids, a purpose each, and every tool in one group at most. */
export function validateToolGroupCatalog(catalog: ToolGroupCatalog): void {
  if (!catalog.loader.toolId || !catalog.loader.argument) throw new Error("A tool group catalog names its loader tool and argument");
  if (catalog.groups.length > MAX_GROUPS) throw new Error(`A tool group catalog holds at most ${MAX_GROUPS} groups`);
  const ids = new Set<string>();
  const owner = new Map<string, string>();
  for (const group of catalog.groups) {
    if (!groupId(group.id) || ids.has(group.id)) throw new Error(`Tool group id must be unique and at most ${MAX_GROUP_ID_CHARS} characters: ${group.id}`);
    ids.add(group.id);
    if (!group.purpose.trim() || group.purpose.length > MAX_PURPOSE_CHARS) throw new Error(`Tool group ${group.id} needs a purpose of at most ${MAX_PURPOSE_CHARS} characters`);
    if (group.toolIds.length === 0) throw new Error(`Tool group ${group.id} holds no tool`);
    if (group.requires !== undefined && !FACTS.has(group.requires)) throw new Error(`Tool group ${group.id} requires an unknown fact: ${group.requires}`);
    for (const toolId of group.toolIds) {
      if (owner.has(toolId)) throw new Error(`Tool ${toolId} is in two tool groups: ${owner.get(toolId)} and ${group.id}`);
      if (toolId === catalog.loader.toolId) throw new Error(`The loader tool ${toolId} cannot be in a tool group`);
      owner.set(toolId, group.id);
    }
  }
}

/** The closed shape of a `tool/selection` payload, checked at the journal boundary. */
export function assertToolSelectionPayload(payload: Readonly<Record<string, JsonValue>>): void {
  const groups = payload.groups;
  const valid = Object.keys(payload).every((key) => PAYLOAD_KEYS.has(key)) && BASES.has(String(payload.basis))
    && (payload.shadow === undefined || payload.shadow === true) && Array.isArray(groups) && groups.length <= MAX_GROUPS
    && groups.every((entry) => typeof entry === "object" && entry !== null && !Array.isArray(entry)
      && Object.keys(entry).every((key) => GROUP_KEYS.has(key)) && groupId(entry.group) && typeof entry.offered === "boolean"
      && REASONS.has(String(entry.reason)));
  if (!valid) throw new Error("tool/selection requires a basis and groups of {group, offered, reason} from the closed sets");
}
