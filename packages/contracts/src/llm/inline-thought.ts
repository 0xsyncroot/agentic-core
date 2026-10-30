const OPEN = "<|channel>";
const CHANNEL = "thought";
const CLOSE = "<channel|>";

export interface InlineThoughtPart {
  readonly type: "text-delta" | "reasoning-delta";
  readonly delta: string;
}

/** What follows `<|channel>`: optional whitespace, then the channel name. `complete` also reports the header's length. */
function header(rest: string): { readonly kind: "complete"; readonly length: number } | { readonly kind: "partial" } | { readonly kind: "other" } {
  const blanks = /^\s*/u.exec(rest)![0].length;
  const name = rest.slice(blanks, blanks + CHANNEL.length);
  if (name === CHANNEL) return { kind: "complete", length: blanks + CHANNEL.length };
  return rest.length - blanks < CHANNEL.length && CHANNEL.startsWith(name) ? { kind: "partial" } : { kind: "other" };
}

/** Length of the longest suffix of `text` that begins one of `delimiters`. */
function openSuffix(text: string, delimiters: readonly string[]): number {
  let keep = 0;
  for (const delimiter of delimiters) {
    for (let size = Math.min(delimiter.length - 1, text.length); size > keep; size--) {
      if (delimiter.startsWith(text.slice(-size))) { keep = size; break; }
    }
  }
  return keep;
}

/** Decode inline private channels used by the gateway, even across arbitrary SSE splits.
 * Only a delimiter-sized suffix is retained. An unclosed private channel never becomes text, and a
 * closing delimiter with no opener is gateway syntax, not public text.
 */
export class InlineThoughtDecoder {
  #pending = "";
  #private = false;
  #privateChars = 0;
  #unclosedChars: number | undefined;

  /** After `finish()`: characters of private text no closing delimiter ever ended; undefined when every channel closed. */
  get unclosedChars(): number | undefined { return this.#unclosedChars; }

  push(delta: string): InlineThoughtPart[] {
    this.#pending += delta;
    const parts: InlineThoughtPart[] = [];
    const emit = (type: InlineThoughtPart["type"], text: string) => { if (text) parts.push({ type, delta: text }); };
    while (this.#pending) {
      if (this.#private) {
        const index = this.#pending.indexOf(CLOSE);
        if (index >= 0) {
          this.#privateChars += index;
          emit("reasoning-delta", this.#pending.slice(0, index));
          this.#pending = this.#pending.slice(index + CLOSE.length);
          this.#private = false;
          continue;
        }
        const keep = openSuffix(this.#pending, [CLOSE]);
        this.#privateChars += this.#pending.length - keep;
        emit("reasoning-delta", this.#pending.slice(0, this.#pending.length - keep));
        this.#pending = this.#pending.slice(this.#pending.length - keep);
        break;
      }
      const open = this.#pending.indexOf(OPEN);
      const stray = this.#pending.indexOf(CLOSE);
      if (stray >= 0 && (open < 0 || stray < open)) {
        emit("text-delta", this.#pending.slice(0, stray));
        this.#pending = this.#pending.slice(stray + CLOSE.length);
        continue;
      }
      if (open < 0) {
        const keep = openSuffix(this.#pending, [OPEN, CLOSE]);
        emit("text-delta", this.#pending.slice(0, this.#pending.length - keep));
        this.#pending = this.#pending.slice(this.#pending.length - keep);
        break;
      }
      const found = header(this.#pending.slice(open + OPEN.length));
      if (found.kind === "partial") {
        emit("text-delta", this.#pending.slice(0, open));
        this.#pending = this.#pending.slice(open);
        break;
      }
      if (found.kind === "other") {
        // Another channel name is not ours to hide: the opener stays in the text, scanning goes on after it.
        emit("text-delta", this.#pending.slice(0, open + OPEN.length));
        this.#pending = this.#pending.slice(open + OPEN.length);
        continue;
      }
      emit("text-delta", this.#pending.slice(0, open));
      this.#pending = this.#pending.slice(open + OPEN.length + found.length);
      this.#private = true;
      this.#privateChars = 0;
    }
    return parts;
  }

  finish(): InlineThoughtPart[] {
    const tail = this.#pending;
    this.#pending = "";
    if (this.#private) {
      this.#unclosedChars = this.#privateChars + tail.length;
      return tail ? [{ type: "reasoning-delta", delta: tail }] : [];
    }
    // A cut-off channel header is not public text. A plain trailing '<' still is.
    return !tail || tail.startsWith("<|") ? [] : [{ type: "text-delta", delta: tail }];
  }
}

/** Public projection only; the original journal and its integrity hashes stay unchanged. */
export function withoutInlineThought(text: string): string {
  const decoder = new InlineThoughtDecoder();
  return [...decoder.push(text), ...decoder.finish()].filter((part) => part.type === "text-delta").map((part) => part.delta).join("");
}
