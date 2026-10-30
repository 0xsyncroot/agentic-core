/**
 * @internal One interaction field's control — a choice, a toggle, or free text — for the
 * Claude-style question card built in ui/interaction-card.ts (spec §7 Q4 / A17).
 */

/** Mirrors HumanInteractionValidator's INTERACTION_SUGGESTION_LIMIT (packages/contracts); kept in sync by this comment. */
const INTERACTION_SUGGESTION_LIMIT = 4;
/** Mirrors INTERACTION_OTHER_ANSWER (packages/contracts): the keyword that opens a choice list to the person's own words. */
const INTERACTION_OTHER_ANSWER = "otherAnswer";

/**
 * @internal The caution against typing secrets, placed right under a box the person types into and
 * shown from the moment they first click into it: a question answered by a tap has nowhere to type
 * one, and a warning standing on every card is noise nobody reads. It stays once shown — hiding it
 * again on blur would pull "Tiếp theo" up under the pointer mid-click.
 */
function freeTextNotice(control: HTMLInputElement | HTMLTextAreaElement): HTMLElement {
  const notice = document.createElement("small");
  notice.className = "acw-interaction-notice";
  notice.textContent = "Không nhập mật khẩu, mã OTP, token, API key hoặc thông tin thanh toán vào ô này.";
  notice.hidden = true;
  control.addEventListener("focus", () => { notice.hidden = false; });
  return notice;
}

/** @internal Client-side echo of the server's own field-level checks (required is handled separately by `isAnswered`). */
function fieldValidationError(rawSchema: UnknownRecord, value: string): string | undefined {
  if (!value) return undefined;
  if (typeof rawSchema.minLength === "number" && value.length < rawSchema.minLength) return `Cần nhập tối thiểu ${rawSchema.minLength} ký tự.`;
  if (typeof rawSchema.maxLength === "number" && value.length > rawSchema.maxLength) return `Không vượt quá ${rawSchema.maxLength} ký tự.`;
  if (rawSchema.type === "number" || rawSchema.type === "integer") {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return "Giá trị phải là số.";
    if (rawSchema.type === "integer" && !Number.isInteger(numeric)) return "Giá trị phải là số nguyên.";
    if (typeof rawSchema.minimum === "number" && numeric < rawSchema.minimum) return `Giá trị tối thiểu là ${rawSchema.minimum}.`;
    if (typeof rawSchema.maximum === "number" && numeric > rawSchema.maximum) return `Giá trị tối đa là ${rawSchema.maximum}.`;
    return undefined;
  }
  if (rawSchema.format === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value)) return "Email không đúng định dạng.";
  if (rawSchema.format === "uri") { try { void new URL(value); } catch { return "Đường dẫn không đúng định dạng."; } }
  if ((rawSchema.format === "date" || rawSchema.format === "date-time") && Number.isNaN(Date.parse(value))) return "Ngày không đúng định dạng.";
  return undefined;
}

/** @internal One interaction form field, however it renders: read back its value, its answered state, its validity. */
interface InteractionField {
  readonly panel: HTMLElement;
  /** True when a single interaction (one button click, one toggle) fully answers the field. */
  readonly auto: boolean;
  read(): unknown;
  /** What the person typed under "Khác", when they chose it instead of an offered answer. */
  other?(): string | undefined;
  isAnswered(): boolean;
  /** An error message when the current value fails a schema check beyond "required", else undefined. */
  validate(): string | undefined;
  summaryValue(): string;
}

/** @internal Builds one interaction field's control, matching the type/choice shape HumanInteractionValidator accepts. */
function buildInteractionField(id: string, rawSchema: UnknownRecord, required: boolean, onChange: () => void): InteractionField {
  const panel = document.createElement("div");
  panel.className = "acw-interaction-field";
  const caption = document.createElement("span");
  caption.className = "acw-interaction-question";
  caption.textContent = text(rawSchema.title, id) + (required ? " *" : "");
  panel.append(caption);
  const choices = interactionChoices(rawSchema);
  let field: InteractionField;
  if (rawSchema.type === "boolean") {
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = rawSchema.default === true;
    input.addEventListener("change", onChange);
    panel.append(input);
    field = { panel, auto: true, read: () => input.checked, isAnswered: () => true, validate: () => undefined, summaryValue: () => input.checked ? "Có" : "Không" };
  } else if (rawSchema.type === "array" && isRecord(rawSchema.items)) {
    // Multiselect: consts live under `items.oneOf`, the same shape a single choice uses at the
    // top level — or `items.anyOf`, which the validator also accepts (older tools wrote it that
    // way; see `HumanInteractionValidator#itemChoices`).
    const itemChoices = interactionChoices(rawSchema.items, true);
    const defaults = new Set(Array.isArray(rawSchema.default) ? rawSchema.default.filter((item): item is string => typeof item === "string") : []);
    const selected = new Set(defaults);
    const labelOf = (value: string) => itemChoices.find((choice) => choice.value === value)?.label ?? value;
    const choicesElement = renderInteractionChoices(itemChoices, selected, true, () => { refreshHint(); onChange(); });
    // Pagination only shows one page of choices at a time, so a pick on a page since scrolled
    // away is otherwise invisible; this stays put under the pager regardless of the active page.
    // Only worth the extra line when there is more than one page to scroll away from.
    const hint = document.createElement("small");
    hint.className = "acw-interaction-selected-hint";
    function refreshHint(): void { hint.textContent = selected.size > 0 ? `Đã chọn: ${selected.size} mục` : ""; }
    if (itemChoices.length > INTERACTION_CHOICE_PAGE_SIZE) { refreshHint(); panel.append(choicesElement, hint); }
    else panel.append(choicesElement);
    field = {
      panel, auto: false,
      read: () => [...selected],
      isAnswered: () => !required || selected.size > 0,
      validate: () => undefined,
      summaryValue: () => selected.size > 0 ? [...selected].map(labelOf).join(", ") : "(chưa chọn)",
    };
  } else if (choices.length > 0) {
    // "Khác" is offered on an open list: one the agent drew up cannot be assumed to contain what the
    // person actually means, and with no way to say so they must either pick something wrong or
    // abandon the card. A closed list — an approval, an MCP enum, the runtime's question — has none.
    const offered = rawSchema[INTERACTION_OTHER_ANSWER] === true ? [...choices, { value: OTHER_CHOICE, label: "Khác…", description: "Tự nhập câu trả lời" }] : choices;
    const selected = new Set<string>(typeof rawSchema.default === "string" ? [rawSchema.default] : []);
    const labelOf = (value: string) => choices.find((choice) => choice.value === value)?.label ?? value;
    const otherInput = document.createElement("textarea");
    otherInput.rows = 2;
    otherInput.className = "acw-interaction-other";
    otherInput.placeholder = "Nhập câu trả lời khác";
    otherInput.hidden = true;
    otherInput.addEventListener("input", () => onChange());
    const chose = () => [...selected][0];
    const otherText = () => chose() === OTHER_CHOICE ? otherInput.value.trim() : undefined;
    const choices2 = renderInteractionChoices(offered, selected, false, () => { refresh(); onChange(); });
    const hint = document.createElement("small");
    hint.className = "acw-interaction-selected-hint";
    function refresh(): void {
      otherInput.hidden = chose() !== OTHER_CHOICE;
      if (!otherInput.hidden) otherInput.focus?.();
      hint.textContent = selected.size > 0 && chose() !== OTHER_CHOICE ? `Đã chọn: ${labelOf(chose()!)}` : "";
    }
    refresh();
    panel.append(choices2, ...(offered.length > INTERACTION_CHOICE_PAGE_SIZE ? [hint] : []), otherInput, freeTextNotice(otherInput));
    field = {
      // Still `auto`: one click on an offered answer is the whole answer and should move on. The
      // card checks validity before it advances, so picking "Khác" — which is the start of an
      // answer, not the whole of one — stays put until the words are written.
      panel, auto: true,
      // Their own words are the field's value: the list is open, and the server accepts them as such.
      read: () => chose() === OTHER_CHOICE ? otherText() || undefined : chose(),
      other: otherText,
      isAnswered: () => !required || (chose() !== undefined && (chose() !== OTHER_CHOICE || (otherText() ?? "") !== "")),
      validate: () => chose() === OTHER_CHOICE && (otherText() ?? "") === "" ? "Chưa nhập câu trả lời khác." : undefined,
      summaryValue: () => chose() === undefined ? "(chưa chọn)" : chose() === OTHER_CHOICE ? (otherText() || "(chưa nhập)") : labelOf(chose()!),
    };
  } else {
    // Built as two separate `createElement` calls, each typed to its own concrete element,
    // rather than one call plus an `instanceof HTMLInputElement` check below: that global is
    // only ever defined in a real browser, and this same field-building code also runs against
    // the stub DOM the widget's own test suite drives.
    let input: HTMLInputElement | HTMLTextAreaElement;
    if (Number(rawSchema.maxLength) > 2_000) {
      const textarea = document.createElement("textarea");
      textarea.rows = 3;
      input = textarea;
    } else {
      const control = document.createElement("input");
      control.type = rawSchema.type === "number" || rawSchema.type === "integer" ? "number"
        : rawSchema.format === "email" ? "email" : rawSchema.format === "date" ? "date"
          : rawSchema.format === "date-time" ? "datetime-local" : rawSchema.format === "uri" ? "url" : "text";
      if (rawSchema.type === "integer") control.step = "1";
      if (typeof rawSchema.minimum === "number") control.min = String(rawSchema.minimum);
      if (typeof rawSchema.maximum === "number") control.max = String(rawSchema.maximum);
      input = control;
    }
    input.name = id;
    input.required = required;
    if (typeof rawSchema.maxLength === "number") input.maxLength = rawSchema.maxLength;
    if (typeof rawSchema.default === "string" || typeof rawSchema.default === "number") input.value = String(rawSchema.default);
    const error = document.createElement("small");
    error.className = "acw-interaction-error";
    error.hidden = true;
    const revalidate = (): void => {
      const message = fieldValidationError(rawSchema, input.value.trim());
      error.textContent = message ?? "";
      error.hidden = !message;
      onChange();
    };
    input.addEventListener("input", revalidate);
    // `examples` (never `enum`/`oneOf`, which restrict the answer to only these values): quick
    // picks beside a field that still takes anything typed, for when the true set of valid
    // answers is too large to offer as strict choices but a few likely ones are worth a tap.
    const suggestions = Array.isArray(rawSchema.examples)
      ? rawSchema.examples.filter((item): item is string => typeof item === "string").slice(0, INTERACTION_SUGGESTION_LIMIT)
      : [];
    if (suggestions.length > 0) {
      const chips = document.createElement("div");
      chips.className = "acw-interaction-choice-list";
      const renderChips = (): void => {
        chips.replaceChildren(...suggestions.map((suggestion) => {
          const chip = document.createElement("button");
          chip.type = "button";
          chip.className = "acw-choice-button";
          chip.textContent = suggestion;
          chip.dataset.selected = String(input.value === suggestion);
          chip.addEventListener("click", () => { input.value = suggestion; renderChips(); revalidate(); });
          return chip;
        }));
      };
      renderChips();
      // Typing something none of the chips offered must clear whichever one used to match –
      // otherwise a chip keeps reading as picked after the accountant has typed past it.
      input.addEventListener("input", renderChips);
      panel.append(chips);
    }
    panel.append(input, error, freeTextNotice(input));
    field = {
      panel, auto: false,
      read: () => {
        if (!input.value && !required) return undefined;
        return rawSchema.type === "number" || rawSchema.type === "integer" ? Number(input.value) : input.value;
      },
      isAnswered: () => !required || input.value.trim() !== "",
      validate: () => fieldValidationError(rawSchema, input.value.trim()),
      summaryValue: () => input.value.trim() || "(chưa nhập)",
    };
  }
  if (typeof rawSchema.description === "string" && rawSchema.description) {
    const hint = document.createElement("small");
    hint.textContent = rawSchema.description;
    panel.append(hint);
  }
  return field;
}
