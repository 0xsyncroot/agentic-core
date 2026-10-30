/**
 * The provider's own call envelope, written out as text.
 *
 * Some DeepSeek-compatible deployments answer a tool call by printing their native DSML envelope
 * into `content` instead of using the tool-call channel. Two different questions live here, and
 * keeping them apart is the point: parsing one into calls needs the envelope exact and complete,
 * because a half-read call must never be dispatched; deciding whether a person may be shown the
 * text needs only "is this markup?". A run that answered one question and not the other put an
 * opening tag on screen as the assistant's reply.
 *
 * The envelope does not always arrive in the documented spelling. A final step may write a
 * sentence and then `<｜｜DSML｜｜ calls>` — a space after the delimiter and `calls` instead of
 * `tool_calls` — with the same space in every inner tag. The grammar below
 * accepts that spelling and leading prose, and nothing looser: the envelope still has to close,
 * and nothing but invokes and parameters may sit inside it.
 */
import type { JsonValue } from "@0xsyncroot/contracts";

/** The delimiter every DSML tag starts with, opening or closing. */
const DSML_MARK = "<｜｜DSML｜｜";
const DSML_CLOSING_MARK = "</｜｜DSML｜｜";
const ENVELOPE_OPEN = /<｜｜DSML｜｜\s*(?:tool_)?calls>/u;
const ENVELOPE_CLOSE = /<\/｜｜DSML｜｜\s*(?:tool_)?calls>$/u;
const INVOKE = /<｜｜DSML｜｜\s*invoke name="([^"]+)">([\s\S]*?)<\/｜｜DSML｜｜\s*invoke>/gu;
const PARAMETER = /<｜｜DSML｜｜\s*parameter name="([^"]+)" string="(true|false)">([\s\S]*?)<\/｜｜DSML｜｜\s*parameter>/gu;

/** Markup rather than an answer, whatever the tag is called and however truncated it arrived. */
export const looksLikeDsml = (content: string | null): boolean => /<\/?｜｜DSML｜｜/u.test(content ?? "");

export interface DsmlCalls {
  /** Text the model wrote before the envelope; null when there was none. */
  readonly prose: string | null;
  readonly calls: readonly { id: string; name: string; arguments: string }[];
}

/** Parses a complete envelope, optionally preceded by prose, into calls; anything less exact yields none. */
export function dsmlToolCalls(content: string | null, requestId: string): DsmlCalls {
  const none: DsmlCalls = { prose: null, calls: [] };
  const source = content?.trim();
  if (!source) return none;
  const open = ENVELOPE_OPEN.exec(source);
  if (!open || !ENVELOPE_CLOSE.test(source)) return none;
  const prose = source.slice(0, open.index).trim();
  // Markup before the envelope is not prose: a second, broken envelope is never half-dispatched.
  if (looksLikeDsml(prose)) return none;
  const body = source.slice(open.index + open[0].length).replace(ENVELOPE_CLOSE, "");
  if (body.replace(INVOKE, "").trim()) return none;
  const calls: { id: string; name: string; arguments: string }[] = [];
  for (const invoke of body.matchAll(INVOKE)) {
    const inner = invoke[2]!;
    if (inner.replace(PARAMETER, "").trim()) return none;
    const values: Record<string, JsonValue> = {};
    for (const parameter of inner.matchAll(PARAMETER)) {
      try {
        values[parameter[1]!] = parameter[2] === "true"
          ? parameter[3]!
          : JSON.parse(parameter[3]!) as JsonValue;
      } catch {
        return none;
      }
    }
    calls.push({ id: `${requestId}:dsml:${calls.length}`, name: invoke[1]!, arguments: JSON.stringify(values) });
  }
  return calls.length > 0 ? { prose: prose || null, calls } : none;
}

/**
 * Holds DSML back from the live text stream.
 *
 * The final answer is decided once the reply is complete, but its text streams to the person as
 * it arrives. Without this the envelope reached the chat token by token — `<`, `｜｜DSML｜｜`,
 * ` calls`… — and stayed there until the reply was withdrawn. Text before the envelope still
 * streams; from the delimiter on, nothing does. A chunk ending in what could be the start of the
 * delimiter is held until the next chunk says which it was.
 */
export class DsmlDeltaGuard {
  #pending = "";
  #markup = false;

  /** The part of this chunk a person may see now. */
  push(delta: string): string {
    if (this.#markup) return "";
    const text = this.#pending + delta;
    const start = Math.min(...[text.indexOf(DSML_MARK), text.indexOf(DSML_CLOSING_MARK)].map((index) => index < 0 ? Number.POSITIVE_INFINITY : index));
    if (Number.isFinite(start)) {
      this.#markup = true;
      this.#pending = "";
      return text.slice(0, start);
    }
    const held = heldSuffix(text);
    this.#pending = text.slice(text.length - held);
    return text.slice(0, text.length - held);
  }

  /** What was held back at the end of the reply, when it turned out not to be markup. */
  flush(): string {
    const rest = this.#markup ? "" : this.#pending;
    this.#pending = "";
    return rest;
  }
}

/** Length of the longest suffix of `text` that could still grow into a DSML delimiter. */
function heldSuffix(text: string): number {
  let held = 0;
  for (const mark of [DSML_MARK, DSML_CLOSING_MARK]) {
    for (let length = Math.min(mark.length - 1, text.length); length > held; length -= 1) {
      if (text.endsWith(mark.slice(0, length))) { held = length; break; }
    }
  }
  return held;
}
