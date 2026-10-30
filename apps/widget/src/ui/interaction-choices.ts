/**
 * @internal The answers a choice question offers, read off its schema, and the tappable list that
 * renders them — used by ui/interaction-field.ts for single choices, multiselects and "Khác".
 */

/**
 * @internal The choice that stands for the person's own answer on an open list (`otherAnswer`). It
 * is never sent: the words written under it are the field's value, which the server accepts there.
 */
const OTHER_CHOICE = "\u0000acw-other";

/** @internal Choice buttons past this count paginate instead of listing every option at once. */
const INTERACTION_CHOICE_PAGE_SIZE = 6;

interface InteractionChoice {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
}

/**
 * @internal Reads `oneOf: [{const, title, description?}]` (or a bare `enum`) off a schema; a `readOnly` choice is the host's to send, never a button.
 *
 * `acceptAnyOf` mirrors `HumanInteractionValidator#itemChoices` (packages/core): a multiselect's
 * `items` schema accepts `anyOf` as well as `oneOf` (older tools wrote it that way), while a
 * single-choice field's own `oneOf` has no such fallback.
 */
function interactionChoices(schema: UnknownRecord | undefined, acceptAnyOf = false): readonly InteractionChoice[] {
  if (!schema) return [];
  if (Array.isArray(schema.enum)) return schema.enum.filter((item): item is string => typeof item === "string").map((value) => ({ value, label: value }));
  const variants = schema.oneOf ?? (acceptAnyOf ? schema.anyOf : undefined);
  if (!Array.isArray(variants)) return [];
  return variants.flatMap((candidate) => isRecord(candidate) && candidate.readOnly !== true && typeof candidate.const === "string" && typeof candidate.title === "string"
    ? [{ value: candidate.const, label: candidate.title, ...(typeof candidate.description === "string" && candidate.description ? { description: candidate.description } : {}) }]
    : []);
}

/**
 * @internal Clickable choice buttons for one interaction field, paginated when there are many.
 *
 * `selected` is the caller's own state, not this function's: pagination only swaps which page of
 * buttons is on screen, and a choice made on a page that then scrolls out of view must still count.
 */
function renderInteractionChoices(
  choices: readonly InteractionChoice[],
  selected: Set<string>,
  multi: boolean,
  onChange: () => void,
): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "acw-interaction-choices";
  // Drawn as a checkbox rather than a radio, so a list that takes several answers says so before
  // the first tap.
  wrap.dataset.multi = String(multi);
  const list = document.createElement("div");
  list.className = "acw-interaction-choice-list";
  const pageCount = Math.max(1, Math.ceil(choices.length / INTERACTION_CHOICE_PAGE_SIZE));
  let page = 0;
  const pager = document.createElement("div");
  pager.className = "acw-interaction-pager";
  const prevButton = document.createElement("button");
  prevButton.type = "button";
  prevButton.className = "acw-interaction-pager-nav";
  prevButton.textContent = "‹ Trước";
  const pageLabel = document.createElement("span");
  pageLabel.className = "acw-interaction-pager-label";
  const nextButton = document.createElement("button");
  nextButton.type = "button";
  nextButton.className = "acw-interaction-pager-nav";
  nextButton.textContent = "Sau ›";
  pager.append(prevButton, pageLabel, nextButton);
  const renderPage = (): void => {
    list.replaceChildren(...choices.slice(page * INTERACTION_CHOICE_PAGE_SIZE, (page + 1) * INTERACTION_CHOICE_PAGE_SIZE).map((choice) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "acw-choice-button";
      // `data-choice` is the answer's own value: a stable hook for scripts and tests, whatever the label says.
      if (choice.value === OTHER_CHOICE) button.dataset.other = "true";
      else button.dataset.choice = choice.value;
      const title = document.createElement("span");
      title.textContent = choice.label;
      button.append(title);
      if (choice.description) {
        const description = document.createElement("small");
        description.className = "acw-choice-desc";
        description.textContent = choice.description;
        button.append(description);
      }
      button.dataset.selected = String(selected.has(choice.value));
      button.addEventListener("click", () => {
        if (multi) {
          if (selected.has(choice.value)) selected.delete(choice.value);
          else selected.add(choice.value);
        } else {
          selected.clear();
          selected.add(choice.value);
        }
        renderPage();
        onChange();
      });
      return button;
    }));
    prevButton.disabled = page === 0;
    nextButton.disabled = page >= pageCount - 1;
    pageLabel.textContent = `Trang ${page + 1}/${pageCount}`;
  };
  prevButton.addEventListener("click", () => { if (page > 0) { page -= 1; renderPage(); } });
  nextButton.addEventListener("click", () => { if (page < pageCount - 1) { page += 1; renderPage(); } });
  renderPage();
  wrap.append(list);
  if (pageCount > 1) wrap.append(pager);
  return wrap;
}
