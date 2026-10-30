import { AgenticError, type ChatMessage } from "@0xsyncroot/contracts";
import { modelContextSize } from "./llm-model-context.js";
import { isStepInstruction } from "./step-instruction.js";
import { DEFAULT_CONTEXT_BUDGET_TEXT, type ContextBudgetText } from "./context-budget-text.js";

function size(message: ChatMessage): number { return modelContextSize(message); }
/** The most of a cut message's end that is kept, and the share of the limit it may take. */
const KEPT_END_CHARS = 1000;

/** Says what was cut and, for a tool result, that the tool can give the cut part again. */

/**
 * A message over its limit keeps its start and its end, with the cut named between them. The end
 * is kept because what says a result is partial or where to continue is as likely to be written
 * last as first. Fitted against the serialized size the budget counts, in which every quote or
 * newline of the content costs two.
 */
function truncate(message: ChatMessage, limit: number, text: ContextBudgetText): ChatMessage {
  if (message.context?.retention === "required") return message;
  if (typeof message.content !== "string" || size(message) <= limit) return message;
  const { content } = message;
  // The longest start that still fits: each character it drops takes at least one from the size.
  const fit = (start: number, build: (start: number) => ChatMessage): ChatMessage | undefined => {
    for (let attempt = 0, head = start; attempt < 8 && head >= 0; attempt += 1) {
      const candidate = build(head);
      const excess = size(candidate) - limit;
      if (excess <= 0) return candidate;
      head -= excess;
    }
    return undefined;
  };
  const suffixed = (head: number): ChatMessage => ({ ...message, content: `${content.slice(0, Math.max(0, head))}${text.suffix}` });
  const shortened = () => fit(limit - text.suffix.length, suffixed) ?? suffixed(limit - text.suffix.length);
  const endLength = Math.min(KEPT_END_CHARS, Math.floor(limit / 4));
  const marker = text.cut(message.role, content.length);
  if (limit < 2 * marker.length || content.length <= endLength) return shortened();
  // Never splits a surrogate pair: half of one is not text.
  const endAt = content.length - endLength + (/[\uDC00-\uDFFF]/u.test(content.charAt(content.length - endLength)) ? 1 : 0);
  const end = content.slice(endAt);
  const cut = (head: number): ChatMessage => {
    const start = head - (/[\uD800-\uDBFF]/u.test(content.charAt(head - 1)) ? 1 : 0);
    return { ...message, content: `${content.slice(0, start)}${text.cut(message.role, endAt - start)}${end}` };
  };
  return fit(Math.min(endAt, limit - marker.length - end.length), cut) ?? shortened();
}

/** What stands in for a tool result the budget could not hold. */
/** The most of the window the calls of cleared results may take from the results still held whole. */
const CLEARED_SHARE = 8;

/** A call and its results with the results' bodies cleared, when that is smaller than the group. */
function cleared(group: readonly ChatMessage[], notices: ContextBudgetText): ChatMessage[] | undefined {
  if (!group.some((message) => message.role === "tool" && (message.images?.length || typeof message.content === "string" && message.content.length > notices.cleared.length))) return undefined;
  return group.map((message) => {
    if (message.role !== "tool" || message.context?.retention === "required") return message;
    const { images: _images, ...text } = message;
    return { ...text, content: notices.cleared };
  });
}

export interface ContextWindow {
  readonly messages: readonly ChatMessage[];
  /** Messages left out altogether. */
  readonly omittedMessages: number;
  /** Tool results whose call is still shown and whose body is not. */
  readonly clearedResults: number;
}

/**
 * Strategy: keep system messages and complete assistant/tool groups, newest first — except that the
 * request being worked on, the manifests of the files attached to the conversation, and any
 * conversation group holding a `required` message, are kept wherever they sit. Tool results can be
 * read again when the budget drops them; the user's own words cannot, and a turn that lost them
 * asked the user to repeat what they had already written.
 *
 * A manifest is what "can be read again" rests on: it is the one place a file's id is written. A
 * long read fills the window with pages, the oldest messages go, and the manifest is the oldest
 * of them — a turn twenty pages into a dossier was left with no id to read page twenty-one by,
 * called the tool with nothing, and stopped. It is a few hundred characters.
 *
 * A tool result the budget cannot hold loses its body, not its call. Dropping call and result
 * together left the model with no record that the read had happened: thirty sheets into a dossier
 * it could not tell a sheet it had read from one it had never opened, and reported on the dozen
 * still in view as if they were the file. With the call kept — and beside it whatever the model
 * said when it made it — what was read stays known, and what is gone is one call away.
 */
export class ContextWindowPolicy {
  constructor(private readonly maxChars: number, private readonly notices: ContextBudgetText = DEFAULT_CONTEXT_BUDGET_TEXT) {}

  apply(messages: readonly ChatMessage[]): ContextWindow {
    const notices = this.notices;
    // The step's own instructions stay last, where the model writes. Moved to the front with the
    // other system messages, "this is the final step, no tools remain" sat between a 45,000-char
    // system prompt and 130,000 chars of scrolling; the model never weighed it, wrote its next
    // scroll call out as text, and the turn ended with nothing (3 of 3 replays). The same
    // request with the instruction last answered 3 of 3.
    const tail = messages.filter(isStepInstruction);
    const rawSystem = messages.filter((message) => message.role === "system" && !isStepInstruction(message));
    const requiredSystem = [...rawSystem.filter((message) => message.context?.retention === "required"), ...tail];
    const optionalSystem = rawSystem.filter((message) => message.context?.retention !== "required");
    const conversation = messages.filter((message) => message.role !== "system");
    const groups: ChatMessage[][] = [];
    for (let index = 0; index < conversation.length; index += 1) {
      const current = conversation[index];
      if (!current) continue;
      const group = [current];
      if (current.role === "assistant" && current.toolCalls?.length) {
        while (conversation[index + 1]?.role === "tool") {
          const tool = conversation[index + 1]; if (tool) group.push(tool); index += 1;
        }
      }
      groups.push(group);
    }
    // The user's own words are the one user message the projector leaves unmarked (a manifest, the
    // application context, memory and checkpoints all say where they came from); the newest of them
    // is the request being worked on.
    const request = [...groups].reverse().find((group) => group.some((message) => message.role === "user" && message.context === undefined));
    const required = groups.filter((group) => group.some((message) => message.context?.retention === "required"));
    const requiredChars = modelContextSize(requiredSystem);
    const charsOf = (list: readonly ChatMessage[][]) => list.reduce((total, group) => total + modelContextSize(group), 0);
    // A request too large to hold whole is left to the newest-first pass, which can still shorten
    // it, rather than failing the turn — the user wrote it, and a truncated request beats none.
    const requestChars = request === undefined ? 0 : modelContextSize(request);
    const holdRequest = request !== undefined && !required.includes(request) && requestChars <= Math.floor(this.maxChars / 4) &&
      requiredChars + charsOf(required) + requestChars <= this.maxChars;
    const manifests = groups.filter((group) => !required.includes(group) && group !== request &&
      group.some((message) => message.context?.provenance === "attachment-manifest"));
    const manifestChars = charsOf(manifests);
    const holdManifests = manifestChars <= Math.floor(this.maxChars / 4) &&
      requiredChars + charsOf(required) + (holdRequest ? requestChars : 0) + manifestChars <= this.maxChars;
    const pinned = new Set([...required, ...(holdRequest && request ? [request] : []), ...(holdManifests ? manifests : [])]);
    const pinnedChars = charsOf([...pinned]);
    if (requiredChars + pinnedChars > this.maxChars) {
      throw new AgenticError("budget-exceeded", `Required instruction context exceeds ${this.maxChars} characters`);
    }
    const systemBudget = conversation.length > 0
      ? Math.min(this.maxChars, Math.max(requiredChars, Math.floor(this.maxChars / 2)))
      : this.maxChars;
    const optionalBudget = Math.max(0, systemBudget - requiredChars);
    const perSystem = Math.max(2, Math.floor((optionalBudget - 2) / Math.max(1, optionalSystem.length)));
    const boundedOptional = optionalSystem.map((message) => truncate(message, perSystem, notices));
    while (modelContextSize([...requiredSystem, ...boundedOptional]) > systemBudget && boundedOptional.length > 0) boundedOptional.pop();
    const system = [...requiredSystem.filter((message) => !tail.includes(message)), ...boundedOptional];
    const selected: ChatMessage[][] = [];
    let used = modelContextSize([...system, ...tail]) + pinnedChars;
    let anyUnpinned = false;
    // Room is kept for the calls of the results that will not fit, so the newest results cannot
    // crowd out the record of the older ones. Nothing is held back when everything fits.
    const stubs = new Map(groups.flatMap((group) => {
      const stub = pinned.has(group) ? undefined : cleared(group, notices);
      return stub ? [[group, { messages: stub, chars: modelContextSize(stub) }] as const] : [];
    }));
    const everythingFits = used + charsOf(groups.filter((group) => !pinned.has(group))) <= this.maxChars;
    const stubCap = everythingFits ? 0 : Math.floor(this.maxChars / CLEARED_SHARE);
    /** What the calls of every group older than `index` would take, cleared. */
    const olderStubChars: number[] = [];
    groups.reduce((total, group, index) => { olderStubChars[index] = total; return total + (stubs.get(group)?.chars ?? 0); }, 0);
    let clearedResults = 0;
    // The newest result is worth more than the record of the old ones: nothing is held back from it.
    let heldWhole = false;
    for (let index = groups.length - 1; index >= 0; index -= 1) {
      const group = groups[index]; if (!group) continue;
      if (pinned.has(group)) { selected.unshift(group); continue; }
      const groupSize = modelContextSize(group);
      const stub = stubs.get(group);
      if (used + groupSize + (heldWhole ? Math.min(stubCap, olderStubChars[index] ?? 0) : 0) <= this.maxChars) {
        selected.unshift(group);
        used += groupSize;
        anyUnpinned = true;
        heldWhole ||= stub !== undefined;
        continue;
      }
      if (stub && (anyUnpinned || group.some((message) => message.images?.length)) && used + stub.chars <= this.maxChars) {
        selected.unshift(stub.messages);
        used += stub.chars;
        clearedResults += stub.messages.filter((message) => message.role === "tool").length;
        continue;
      }
      if (!anyUnpinned) {
        const available = Math.max(2, this.maxChars - used);
        const perMessage = Math.max(2, Math.floor((available - 2) / Math.max(1, group.length)));
        const boundedGroup = group.map((message) => truncate(message, perMessage, notices));
        if (used + modelContextSize(boundedGroup) <= this.maxChars) {
          selected.unshift(boundedGroup);
          used += modelContextSize(boundedGroup);
          anyUnpinned = true;
        }
      }
    }
    const kept = selected.reduce((total, group) => total + group.length, 0);
    const omittedMessages = Math.max(0, conversation.length - kept);
    const proposedNotice: ChatMessage[] = omittedMessages > 0
      ? [{ role: "system", content: notices.omitted(omittedMessages) }]
      : [];
    // A cleared result says so where it stood; only a message that is gone needs a notice.
    const withoutNotice = [...system, ...selected.flat(), ...tail];
    const withNotice = [...system, ...proposedNotice, ...selected.flat(), ...tail];
    const result = modelContextSize(withNotice) <= this.maxChars ? withNotice : withoutNotice;
    if (modelContextSize(result) > this.maxChars) {
      throw new AgenticError("budget-exceeded", `Context cannot be represented within ${this.maxChars} characters`);
    }
    return { messages: result, omittedMessages, clearedResults };
  }
}
