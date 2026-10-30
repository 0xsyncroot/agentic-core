import type {
  EventDraft, JsonValue, SessionEvent, ToolDefinition, ToolGroup, ToolGroupCatalog, ToolSelectionBasis, ToolSelectionPayload,
  ToolSelectionReason, SystemPromptProvider, SystemPromptTurn, TurnContextOperation, TurnJudge, WorkPlan, WorkPlanningProvider,
} from "@0xsyncroot/contracts";
import { attachmentManifestFromPayload } from "./attachment-manifest.js";
import type { JudgmentMemo } from "./judgment-memo.js";
import type { JudgmentSeamMode } from "./observation-review.js";
import { ToolCallPairing } from "./tool-call-pairing.js";
import { judgeToolGroups, toolRelevanceState, type GroupVerdict } from "./tool-relevance.js";
import type { TurnEventWriter } from "./turn-event-writer.js";

/** A request of at most this many words names no work of its own (a bare "go on, please"): every group is offered. */
const SHORT_REQUEST_WORDS = 4;

export interface ToolSelectionOpen {
  readonly catalog: ToolGroupCatalog;
  /** The turn's tool surface, discovered and policy-filtered: the universe a selection takes from, never adds to. */
  readonly tools: readonly ToolDefinition[];
  /** The `toolRelevance` seam's mode; a turn without a judge selects nothing, whatever it says. */
  readonly mode: JudgmentSeamMode | undefined;
  readonly judge: TurnJudge | undefined;
  readonly operation: TurnContextOperation;
  /** What the user wrote for this turn. */
  readonly content: string;
  /** The session's journal as the turn opens. */
  readonly events: readonly SessionEvent[];
  readonly turnId: string;
  /** Tools every step offers, whatever the groups: planning, asking the user, loading a skill. */
  readonly pinnedToolIds: ReadonlySet<string>;
}

/** A load the refusal of an unoffered call names, as the call that would offer the tool: data, never a sentence. */
export interface GroupLoad { readonly group: string; readonly call: { readonly toolId: string; readonly arguments: Readonly<Record<string, string>> } }

type Reasons = ReadonlyMap<string, ToolSelectionReason>;

/** The reasons that leave a group out of the turn. */
const LEFT_OUT: ReadonlySet<ToolSelectionReason> = new Set(["not-needed", "no-fact"]);

const payloadOf = (event: SessionEvent): Readonly<Record<string, unknown>> =>
  event.payload && typeof event.payload === "object" && !Array.isArray(event.payload) ? event.payload as Readonly<Record<string, unknown>> : {};

function argumentOf(intent: SessionEvent | undefined, name: string): string | undefined {
  const raw = intent ? payloadOf(intent).arguments : undefined;
  if (typeof raw !== "string") return undefined;
  try { const value = (JSON.parse(raw) as Record<string, unknown>)[name]; return typeof value === "string" ? value : undefined; } catch { return undefined; }
}

/**
 * What the session offered before this turn's selection, read back from the journal: every group a `tool/selection` row
 * offered (a resumed turn's own earlier rows included) or the agent called a tool of in an earlier turn (a policy's own reads
 * are not the agent's work), and for every other group the reason its last row left it out. `selected`: a row exists.
 */
function sessionOffer(events: readonly SessionEvent[], groupOf: ReadonlyMap<string, string>, turnId: string): {
  readonly offered: ReadonlySet<string>; readonly leftOut: ReadonlyMap<string, ToolSelectionReason>; readonly selected: boolean;
} {
  const offered = new Set<string>();
  const leftOut = new Map<string, ToolSelectionReason>();
  let selected = false;
  for (const event of events) {
    const payload = payloadOf(event);
    if (event.type === "tool/selection" && Array.isArray(payload.groups)) {
      selected = true;
      for (const entry of payload.groups as ToolSelectionPayload["groups"]) {
        if (entry.offered) offered.add(entry.group); else leftOut.set(entry.group, entry.reason);
      }
    } else if (event.type === "tool/intent" && event.turnId !== turnId && payload.initiator !== "policy") {
      const group = groupOf.get(String(payload.toolId));
      if (group) offered.add(group);
    }
  }
  for (const group of offered) leftOut.delete(group);
  return { offered, leftOut, selected };
}

/**
 * Which tool groups one turn offers the model (core seam `tool-relevance`).
 *
 * The session's offer only grows: the tool list is every request's cached prefix, and a list that changes from turn to turn
 * loses it. A group any earlier `tool/selection` row offered, or one the agent called a tool of, stays offered for the session
 * (`session`), read back from the journal. Order: the turn's skipped skills are settled first; then every group a skill in
 * effect requires, every group the session offered and the always-offered tools are pinned; then a group whose declared fact
 * does not hold (`ToolGroup.requires`) is left out without asking; then the judge's verdict decides the rest, one group per
 * call, and a group is left out only when the judge is confident it is not needed. The judge is asked only about groups the
 * session never offered. A turn that resumes a pause reuses the session's offer without asking: a group left out earlier stays
 * out for the reason its last row gave, and one no row named is offered. A resume in a session with no row, or a request of a
 * few words, offers every group: such a request says nothing about what the work needs. No judge, the seam off, or a
 * composition without the loader tool: every tool, exactly as without groups.
 *
 * The selection only narrows what the model is offered: the turn's tool surface stays the catalog that policies, approvals
 * and refusals read. Within a turn it only grows too: the loader offers a group for the rest of the session, and a skill loaded
 * during the turn adds the groups it requires.
 */
export class TurnToolSelection {
  readonly #catalog: ToolGroupCatalog;
  readonly #tools: readonly ToolDefinition[];
  readonly #groups: readonly ToolGroup[];
  readonly #groupOf = new Map<string, string>();
  readonly #pinned: ReadonlySet<string>;
  readonly #basis: ToolSelectionBasis | undefined;
  readonly #shadow: boolean;
  /** Groups the session offered before this turn's selection: they stay offered. */
  readonly #session: ReadonlySet<string>;
  /** The reason the last row that left a group out gave, for a group the session never offered. */
  readonly #leftOutBefore: ReadonlyMap<string, ToolSelectionReason>;
  /** The basis offers every group: a request of a few words, or a resume with no earlier selection to reuse. */
  readonly #everyGroup: boolean;
  /** Groups whose declared fact does not hold this turn. */
  readonly #lacking: ReadonlySet<string>;
  readonly #offered = new Set<string>();
  #reasons: Reasons = new Map();
  #verdicts: ReadonlyMap<string, GroupVerdict> = new Map();
  #withLoader = false;

  constructor(input: ToolSelectionOpen) {
    this.#catalog = input.catalog;
    this.#tools = input.tools;
    const present = new Set(input.tools.map((tool) => tool.id));
    this.#groups = input.catalog.groups.filter((group) => group.toolIds.some((toolId) => present.has(toolId)));
    for (const group of this.#groups) for (const toolId of group.toolIds) if (present.has(toolId)) this.#groupOf.set(toolId, group.id);
    this.#pinned = input.pinnedToolIds;
    const selecting = input.judge !== undefined && (input.mode === "on" || input.mode === "shadow") && present.has(input.catalog.loader.toolId);
    this.#shadow = input.mode === "shadow";
    const before = sessionOffer(input.events, this.#groupOf, input.turnId);
    this.#session = before.offered;
    this.#leftOutBefore = before.leftOut;
    this.#basis = !selecting || this.#groups.length === 0 ? undefined
      : input.operation !== "run-turn" ? "resume"
        : input.content.trim().split(/\s+/u).filter(Boolean).length <= SHORT_REQUEST_WORDS ? "short-request" : "judged";
    this.#everyGroup = this.#basis === "short-request" || (this.#basis === "resume" && !before.selected);
    const files = input.events.some((event) => event.type === "user/input" && attachmentManifestFromPayload(payloadOf(event).attachments).length > 0);
    this.#lacking = new Set(this.#groups.filter((group) => group.requires === "files" && !files).map((group) => group.id));
    for (const group of this.#groups) this.#offered.add(group.id);
  }

  /** Whether a load during the turn can still add a group: something was left out. */
  get grows(): boolean { return this.#withLoader; }

  /** The groups the judge is asked about: none unless the turn is judged, never one the session offered or one lacking its fact. */
  get asked(): readonly ToolGroup[] {
    return this.#basis === "judged" ? this.#groups.filter((group) => !this.#session.has(group.id) && !this.#lacking.has(group.id)) : [];
  }

  /** Asks the judge about every group `asked` names, in parallel; a verdict it does not give offers the group. */
  async judge(judge: TurnJudge, request: string, plan: WorkPlan | undefined, signal: AbortSignal, memo?: { readonly verdicts: JudgmentMemo; readonly scope: string }): Promise<void> {
    const asked = this.asked;
    if (asked.length > 0) this.#verdicts = await judgeToolGroups(judge, asked, toolRelevanceState(request, plan), signal, memo);
  }

  /** Fixes the turn's groups once the skills in effect are known: `skillToolIds` are the tools those skills require. */
  settle(skillToolIds: readonly string[]): void {
    if (!this.#basis) return;
    const skillGroups = new Set(skillToolIds.flatMap((toolId) => this.#groupOf.get(toolId) ?? []));
    this.#reasons = new Map(this.#groups.map((group): [string, ToolSelectionReason] => {
      if (this.#everyGroup) return [group.id, "every-group"];
      if (skillGroups.has(group.id)) return [group.id, "skill"];
      if (this.#session.has(group.id)) return [group.id, "session"];
      if (this.#basis === "resume") return [group.id, this.#leftOutBefore.get(group.id) ?? "no-verdict"];
      if (this.#lacking.has(group.id)) return [group.id, "no-fact"];
      return [group.id, this.#verdicts.get(group.id) ?? "no-verdict"];
    }));
    const leftOut = [...this.#reasons].filter(([, reason]) => LEFT_OUT.has(reason)).map(([group]) => group);
    if (this.#shadow || leftOut.length === 0) return;
    for (const group of leftOut) this.#offered.delete(group);
    this.#withLoader = true;
  }

  /** The tools the turn offers the model: what the system prompt is rendered for. */
  get offeredToolIds(): ReadonlySet<string> {
    return new Set(this.#modelTools().map((tool) => tool.id));
  }

  /** The `tool/selection` row for the turn's open; none when the turn selects nothing. */
  openingDraft(turnId: string): EventDraft | undefined {
    if (!this.#basis) return undefined;
    const payload: ToolSelectionPayload = {
      basis: this.#basis,
      groups: [...this.#reasons].map(([group, reason]) => ({ group, offered: !LEFT_OUT.has(reason), reason })),
      ...(this.#shadow ? { shadow: true as const } : {}),
    };
    return { type: "tool/selection", turnId, payload: payload as unknown as JsonValue };
  }

  /**
   * The tools a step offers: the turn's selection and every group a load during the turn added, read from this turn's
   * succeeded loader and skill-loader results. `skillTools` gives the tools the named loaded skills require.
   */
  stepTools(events: readonly SessionEvent[], frame: {
    readonly turnId: string; readonly stepId: string;
    readonly skillLoader?: { readonly toolId: string; readonly argument: string };
    readonly skillTools: (loaded: ReadonlySet<string>) => readonly string[];
  }): { readonly tools: readonly ToolDefinition[]; readonly draft?: EventDraft } {
    if (!this.#withLoader) return { tools: this.#modelTools() };
    const added = new Map<string, ToolSelectionReason>();
    const { loader } = this.#catalog;
    const pairing = new ToolCallPairing(events);
    const loadedSkills = new Set<string>();
    for (const event of events) {
      const payload = payloadOf(event);
      if (event.turnId !== frame.turnId || event.type !== "tool/result" || payload.state !== "succeeded") continue;
      if (payload.toolId === loader.toolId) {
        const group = argumentOf(pairing.intentOfResult(event), loader.argument);
        if (group && !this.#offered.has(group) && this.#groups.some((candidate) => candidate.id === group)) added.set(group, "loaded");
      } else if (frame.skillLoader && payload.toolId === frame.skillLoader.toolId) {
        const skill = argumentOf(pairing.intentOfResult(event), frame.skillLoader.argument);
        if (skill) loadedSkills.add(skill);
      }
    }
    if (loadedSkills.size > 0) {
      for (const toolId of frame.skillTools(loadedSkills)) {
        const group = this.#groupOf.get(toolId);
        if (group && !this.#offered.has(group) && !added.has(group)) added.set(group, "skill-loaded");
      }
    }
    if (added.size === 0) return { tools: this.#modelTools() };
    for (const group of added.keys()) this.#offered.add(group);
    const payload: ToolSelectionPayload = { basis: "added", groups: [...added].map(([group, reason]) => ({ group, offered: true, reason })) };
    return { tools: this.#modelTools(), draft: { type: "tool/selection", turnId: frame.turnId, stepId: frame.stepId, payload: payload as unknown as JsonValue } };
  }

  /** For a call to a tool of a group this turn left out: the group, and the loader call that offers it. */
  loadFor(toolId: string): GroupLoad | undefined {
    const group = this.#groupOf.get(toolId);
    if (!this.#withLoader || !group || this.#offered.has(group)) return undefined;
    return { group, call: { toolId: this.#catalog.loader.toolId, arguments: { [this.#catalog.loader.argument]: group } } };
  }

  /** In the surface's own order: the tools of no group, the pinned ones, those of offered groups, and the loader while a group is left out. */
  #modelTools(): readonly ToolDefinition[] {
    const loader = this.#catalog.loader.toolId;
    return this.#tools.filter((tool) => {
      if (tool.id === loader) return this.#withLoader;
      const group = this.#groupOf.get(tool.id);
      return group === undefined || this.#pinned.has(tool.id) || this.#offered.has(group);
    });
  }
}

/** The tools the skills in effect require, as each prompt provider with skills reports them (`SystemPromptProvider.skillTools`). */
export function skillToolIds(prompts: readonly SystemPromptProvider[], turn: SystemPromptTurn & { readonly loadedSkills: ReadonlySet<string> }): readonly string[] {
  return prompts.flatMap((prompt) => prompt.skillTools?.(turn) ?? []);
}

/** The turn's selection when the composition declares tool groups; undefined keeps every tool on offer, as before groups. */
export function openToolSelection(catalog: ToolGroupCatalog | undefined, input: Omit<ToolSelectionOpen, "catalog" | "pinnedToolIds"> & {
  readonly planning?: WorkPlanningProvider; readonly skillLoaderId?: string;
}): TurnToolSelection | undefined {
  if (!catalog) return undefined;
  const pinned = new Set(input.tools.filter((tool) => tool.asksUser === true).map((tool) => tool.id));
  // Both planning tools: a plan published with one is marked with the other.
  for (const toolId of [input.planning?.definition.id, input.planning?.markDefinition?.id, input.skillLoaderId]) if (toolId) pinned.add(toolId);
  return new TurnToolSelection({ ...input, catalog, pinnedToolIds: pinned });
}

/**
 * What each step of the turn offers the model, journaling a group a load added: the whole surface without a selection.
 * `skippedSkills` are the turn's, so a skill loaded during the turn is weighed with the same preloads.
 */
export function stepToolOffer(selection: TurnToolSelection | undefined, tools: readonly ToolDefinition[], frame: {
  readonly events: () => Promise<readonly SessionEvent[]>; readonly writer: TurnEventWriter; readonly turnId: string;
  readonly prompts: readonly SystemPromptProvider[]; readonly skippedSkills: ReadonlySet<string>;
}): (stepId: string) => Promise<readonly ToolDefinition[]> {
  if (!selection) return async () => tools;
  const skillLoader = frame.prompts.find((prompt) => prompt.skillLoader)?.skillLoader;
  return async (stepId) => {
    const offer = selection.stepTools(selection.grows ? await frame.events() : [], {
      turnId: frame.turnId, stepId, ...(skillLoader ? { skillLoader } : {}),
      skillTools: (loadedSkills) => skillToolIds(frame.prompts, { ...(frame.skippedSkills.size ? { skippedSkills: frame.skippedSkills } : {}), loadedSkills }),
    });
    if (offer.draft) await frame.writer.append([offer.draft], `tool-selection:${stepId}`);
    return offer.tools;
  };
}
