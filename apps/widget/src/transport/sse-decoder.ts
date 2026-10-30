/** @internal Incremental SSE decoder preserving split CR/LF boundaries. */
class AgentChatSseDecoder {
  #buffer = "";
  #event = "";
  #data: string[] = [];
  #id: string | undefined;
  #retry: number | undefined;
  #firstLine = true;

  push(chunk: string): readonly AgentChatSseFrame[] {
    this.#buffer += chunk;
    return this.#drain(false);
  }

  finish(chunk = ""): readonly AgentChatSseFrame[] {
    this.#buffer += chunk;
    const frames = [...this.#drain(true)];
    const finalFrame = this.#dispatch();
    if (finalFrame) frames.push(finalFrame);
    return frames;
  }

  /**
   * Scans forward with a cursor and reslices the buffer once.
   *
   * Searching and reslicing from index 0 per line makes a chunk carrying many frames
   * quadratic, and re-scans an unterminated line from the start on every push — the hot
   * path for a long streamed answer.
   */
  #drain(final: boolean): AgentChatSseFrame[] {
    const frames: AgentChatSseFrame[] = [];
    let cursor = 0;
    while (cursor < this.#buffer.length) {
      const lf = this.#buffer.indexOf("\n", cursor);
      const cr = this.#buffer.indexOf("\r", cursor);
      const boundary = lf < 0 ? cr : cr < 0 ? lf : Math.min(lf, cr);
      if (boundary < 0) {
        if (!final) break;
        this.#consumeLine(this.#buffer.slice(cursor), frames);
        cursor = this.#buffer.length;
        break;
      }
      // A trailing CR may still be the first half of a CRLF split across chunks.
      if (this.#buffer[boundary] === "\r" && boundary === this.#buffer.length - 1 && !final) break;
      this.#consumeLine(this.#buffer.slice(cursor, boundary), frames);
      cursor = boundary + (this.#buffer[boundary] === "\r" && this.#buffer[boundary + 1] === "\n" ? 2 : 1);
    }
    if (cursor > 0) this.#buffer = this.#buffer.slice(cursor);
    return frames;
  }

  #consumeLine(rawLine: string, frames: AgentChatSseFrame[]): void {
    const line = this.#firstLine ? rawLine.replace(/^\uFEFF/, "") : rawLine;
    this.#firstLine = false;
    if (line === "") {
      const frame = this.#dispatch();
      if (frame) frames.push(frame);
      return;
    }
    if (line.startsWith(":")) return;
    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    let value = separator < 0 ? "" : line.slice(separator + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") this.#event = value;
    if (field === "data") this.#data.push(value);
    if (field === "id" && !value.includes("\0")) this.#id = value;
    if (field === "retry" && /^\d+$/.test(value)) this.#retry = Number(value);
  }

  #dispatch(): AgentChatSseFrame | null {
    if (this.#data.length === 0) {
      this.#event = "";
      this.#retry = undefined;
      return null;
    }
    const frame: AgentChatSseFrame = {
      event: this.#event || "message",
      data: this.#data.join("\n"),
      ...(this.#id === undefined ? {} : { id: this.#id }),
      ...(this.#retry === undefined ? {} : { retry: this.#retry }),
    };
    this.#event = "";
    this.#data = [];
    this.#retry = undefined;
    return frame;
  }
}
