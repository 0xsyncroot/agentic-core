/**
 * @internal Claude-style question card body: one tab per field, plus a final "Xem lại" review tab
 * when there are several — spec §7 Q4 / A17. A card with one question has neither: the question and
 * the send button share the card. `EmbeddedAgentChat` builds the card's shell (title,
 * description, status line, the decline/confirm action row) and calls only this function for the
 * part that varies with the schema.
 */

/** @internal What a card's form adds to an agent's question: facts the review repeats above the answers. */
interface InteractionFormOptions {
  /** Listed first on the review tab, before the answers: what an approval is about to change. A single-question form has no review tab to list them on. */
  readonly reviewRows?: readonly AgentChatInteractionEcho[];
}

/** @internal The status line while a form of optional questions has none answered: skipping is the other button. */
const BLANK_FORM_SENTENCE = "Chưa có câu trả lời nào để gửi. Bấm \"Bỏ qua\" nếu không muốn trả lời.";

/** @internal A field's value that answers nothing: left empty, an empty selection, or only spaces. */
function isBlankAnswer(value: unknown): boolean {
  return value === undefined || (Array.isArray(value) && value.length === 0) || (typeof value === "string" && value.trim() === "");
}

/**
 * @internal Builds the field(s) for one interaction card. Several fields get a tab each plus a final
 * "Xem lại" review tab, as Claude's AskUserQuestion does (spec §7 Q4 / A17); one field is shown
 * on its own and sent from the same panel. Agent questions, the runtime's own question and
 * approvals all go through here.
 *
 * `confirm` stays in the card's own action row beside "Bỏ qua", so both answers to the card sit
 * together. With several fields this function shows it only while the review tab is open, since
 * sending is what that tab is for; with one field it is always shown. `onSubmit` also receives the
 * answers as the review read them out — the receipt the settled card keeps, the same one history
 * shows from the server's echo.
 */
function buildInteractionForm(
  requestedSchema: UnknownRecord,
  confirm: HTMLButtonElement,
  status: HTMLElement,
  onSubmit: (content: Record<string, unknown>, echo: readonly AgentChatInteractionEcho[]) => void,
  options: InteractionFormOptions = {},
): HTMLElement {
  const body = document.createElement("div");
  body.className = "acw-interaction-form";
  const properties = isRecord(requestedSchema.properties) ? requestedSchema.properties : {};
  const required = new Set(Array.isArray(requestedSchema.required) ? requestedSchema.required.filter((item): item is string => typeof item === "string") : []);
  let onFieldChange: (id: string) => void = () => undefined;
  // A `readOnly` field is the host's to fill (apps/widget/HOST-INTEGRATION.md 5d), never a question on the card.
  const fields = Object.entries(properties).flatMap(([id, rawSchema]) => isRecord(rawSchema) && rawSchema.readOnly !== true ? [{ id, rawSchema, title: text(rawSchema.title, id), required: required.has(id) }] : [])
    .map((entry) => ({ ...entry, field: buildInteractionField(entry.id, entry.rawSchema, entry.required, () => onFieldChange(entry.id)) }));
  const readAll = (): Record<string, unknown> => Object.fromEntries(fields.flatMap(({ id, field }) => {
    const value = field.read();
    return value === undefined ? [] : [[id, value]];
  }));
  const firstInvalid = (): number => fields.findIndex(({ required: needed, field }) => (needed && !field.isAnswered()) || field.validate() !== undefined);
  // Optional questions all left blank are a skip under the label of an answer: sent as `{}`, the agent
  // reads it as "nothing to adjust". Skipping is "Bỏ qua"'s; a required question
  // already holds "Gửi" back and the review points at it, so such a form keeps its own line.
  const blank = (): boolean => fields.length > 0 && fields.every(({ required: needed, field }) => !needed && isBlankAnswer(field.read()));
  let ownStatus: string | null = null;
  const updateConfirmState = (): void => {
    const nothing = blank();
    confirm.disabled = nothing || firstInvalid() >= 0;
    // Said where "Gửi" stands, the review tab; the card's own line comes back once there is an answer.
    if (nothing && !confirm.hidden && status.textContent !== BLANK_FORM_SENTENCE) { ownStatus = status.textContent; status.textContent = BLANK_FORM_SENTENCE; }
    else if ((!nothing || confirm.hidden) && status.textContent === BLANK_FORM_SENTENCE) status.textContent = ownStatus;
  };
  // Only ever reassigned once tabs exist (fields.length > 1); the submit handler below still
  // refers to it unconditionally, so a form without tabs needs this no-op placeholder.
  let showTab: (index: number) => void = () => undefined;
  const submit = (): void => {
    if (blank()) { updateConfirmState(); return; }
    const invalid = firstInvalid();
    if (invalid >= 0) {
      if (fields.length > 1) showTab(invalid);
      const problem = fields[invalid]!.field.validate();
      status.textContent = problem ? `"${fields[invalid]!.title}": ${problem}` : `Vui lòng trả lời "${fields[invalid]!.title}" trước khi gửi.`;
      return;
    }
    // Words written under "Khác" are that field's value: the list was open to them, and they reach the
    // agent as its answer to this question — not as a message after a skipped card.
    onSubmit(readAll(), fields.flatMap(({ title: label, field }) => field.read() === undefined ? [] : [{ label, value: field.summaryValue() }]));
  };
  confirm.addEventListener("click", submit);
  updateConfirmState();

  // One question is answered and sent from its own panel: a review step would only repeat it.
  if (fields.length <= 1) {
    onFieldChange = () => updateConfirmState();
    if (fields.length === 1) body.append(fields[0]!.field.panel);
    return body;
  }

  const tabs = document.createElement("div");
  tabs.className = "acw-interaction-tabs";
  tabs.setAttribute("role", "tablist");
  const panels = document.createElement("div");
  panels.className = "acw-interaction-panels";
  const summaryPanel = document.createElement("div");
  summaryPanel.className = "acw-interaction-summary-panel";
  const summaryList = document.createElement("dl");
  summaryList.className = "acw-interaction-summary";
  const tabButtons: HTMLButtonElement[] = [];
  const reviewRows = (options.reviewRows ?? []).flatMap(({ label, value }) => {
    const term = document.createElement("dt");
    term.textContent = label;
    const detail = document.createElement("dd");
    detail.textContent = value;
    return [term, detail];
  });
  const renderSummary = (): void => {
    summaryList.replaceChildren(...reviewRows, ...fields.flatMap(({ title: fieldTitle, required: needed, field }, index) => {
      const term = document.createElement("dt");
      term.textContent = fieldTitle;
      const value = document.createElement("dd");
      const unanswered = needed && !field.isAnswered();
      if (unanswered) {
        const jump = document.createElement("button");
        jump.type = "button";
        jump.className = "acw-interaction-unanswered";
        jump.textContent = "Chưa trả lời — bấm để chuyển tới câu hỏi";
        jump.addEventListener("click", () => showTab(index));
        value.append(jump);
      } else {
        value.textContent = field.summaryValue();
      }
      return [term, value];
    }));
  };
  showTab = (index: number): void => {
    const active = Math.max(0, Math.min(index, fields.length));
    fields.forEach(({ field }, i) => { field.panel.hidden = i !== active; });
    summaryPanel.hidden = active !== fields.length;
    tabButtons.forEach((button, i) => { button.dataset.active = String(i === active); });
    confirm.hidden = active !== fields.length;
    if (active === fields.length) renderSummary();
    updateConfirmState();
  };
  fields.forEach(({ title: fieldTitle }, i) => {
    const tabButton = document.createElement("button");
    tabButton.type = "button";
    tabButton.className = "acw-interaction-tab";
    tabButton.textContent = fieldTitle;
    // A long question title is cut short on its tab; the full wording stays one hover away.
    tabButton.title = fieldTitle;
    tabButton.addEventListener("click", () => showTab(i));
    tabButtons.push(tabButton);
    tabs.append(tabButton);
  });
  const reviewTabButton = document.createElement("button");
  reviewTabButton.type = "button";
  reviewTabButton.className = "acw-interaction-tab";
  reviewTabButton.dataset.summary = "true";
  reviewTabButton.textContent = "Xem lại";
  reviewTabButton.addEventListener("click", () => showTab(fields.length));
  tabButtons.push(reviewTabButton);
  tabs.append(reviewTabButton);
  // A single click already answers a choice/boolean field, so it auto-advances on its own; a
  // multi-select or free-text field has no such single moment and needs an explicit "done". A
  // choice field is both: an offered answer moves on by itself, but the click that chose "Khác"
  // is only the start of one, so its "Tiếp theo" is built and kept hidden until that happens —
  // showing it under every list of buttons would put a step in front of the common case.
  const nextButtons = fields.map(({ field }, i) => {
    const next = document.createElement("button");
    next.type = "button";
    next.className = "acw-interaction-next";
    next.textContent = "Tiếp theo →";
    next.hidden = field.auto;
    next.addEventListener("click", () => showTab(i + 1));
    field.panel.append(next);
    return next;
  });
  onFieldChange = (id) => {
    updateConfirmState();
    const index = fields.findIndex((entry) => entry.id === id);
    if (index < 0) return;
    const { field } = fields[index]!;
    tabButtons[index]!.dataset.answered = String(field.isAnswered());
    const writing = field.other?.() !== undefined;
    nextButtons[index]!.hidden = field.auto && !writing;
    // A hidden panel's controls cannot fire a change event, so this only ever runs for the
    // field on the currently active tab.
    if (field.auto && !writing && field.isAnswered() && field.validate() === undefined) showTab(index + 1);
  };
  summaryPanel.append(summaryList);
  panels.append(...fields.map(({ field }) => field.panel), summaryPanel);
  body.append(tabs, panels);
  showTab(0);
  return body;
}
