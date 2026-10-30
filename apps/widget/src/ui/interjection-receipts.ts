/** @internal The words as the server keeps them: line breaks as `\n`, no outer space. */
const interjectionWords = (content: string): string => content.replaceAll(/\r\n?/gu, "\n").trim();

/**
 * @internal The user's mid-turn messages a running turn took, in the order they were sent, until the turn reads them.
 *
 * The turn reports each one as it reads it (progress `interjection-received`, with the words); the row then carries a small
 * "read" note, so the user can see the agent has their words instead of wondering whether the correction arrived. Words
 * are matched oldest first: the turn reads them in the order they came, so two identical messages are marked one by one.
 * What the turn ended without reading is handed back (`unread`) for the widget to send on as the next turn. A message is
 * added before it is sent: a turn that reads it at once may report the read before the send itself is answered.
 */
class InterjectionReceipts {
  readonly #sent: { readonly content: string; readonly row: HTMLElement }[] = [];

  /** A message on its way to the running turn. */
  add(content: string, row: HTMLElement): void {
    this.#sent.push({ content: interjectionWords(content), row });
  }

  /** A message the turn did not take after all. */
  remove(row: HTMLElement): void {
    const index = this.#sent.findIndex((entry) => entry.row === row);
    if (index >= 0) this.#sent.splice(index, 1);
  }

  /** Marks the oldest unread row with these words as read; false when the progress is not a read receipt for one. */
  read(progress: unknown, label: string): boolean {
    if (!transportRecord(progress) || progress.type !== "interjection-received" || typeof progress.content !== "string") return false;
    const content = interjectionWords(progress.content);
    const index = this.#sent.findIndex((entry) => entry.content === content);
    if (index < 0) return false;
    const { row } = this.#sent.splice(index, 1)[0]!;
    const note = document.createElement("div");
    note.className = "acw-user-read";
    note.textContent = label;
    row.append(note);
    return true;
  }

  /** The rows still unread, by their words, oldest first; the receipts are cleared. */
  unread(): Map<string, HTMLElement> {
    const rows = new Map<string, HTMLElement>();
    for (const entry of this.#sent.splice(0)) if (!rows.has(entry.content)) rows.set(entry.content, entry.row);
    return rows;
  }
}
