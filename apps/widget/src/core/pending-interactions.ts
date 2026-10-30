/** @internal A tracked card and the elements the widget settles it through. */
interface PendingInteractionEntry {
  readonly interaction: AgentChatFormInteractionChallenge;
  readonly card: HTMLElement;
  readonly status: HTMLElement;
}

/** @internal What the ledger needs from the widget: where to report, and how to lock a card whose time ran out. */
interface PendingInteractionHooks {
  readonly report: (pending: AgentChatPendingInteraction | null) => void;
  readonly expire: (entry: PendingInteractionEntry) => void;
}

/**
 * @internal The schema keyword by which a tool lets the host answer its card (`"x-host-answerable": true` at the root of
 * `requestedSchema`). Any other card — an approval, the runtime's own question, a tool's ordinary question — is the person's.
 */
const HOST_ANSWERABLE = "x-host-answerable";

/** @internal setTimeout's longest delay; a later expiry is re-armed when it fires. */
const MAX_TIMER_MS = 2_147_483_647;

/** @internal A card's expiry timer never holds a process open by itself (a test runner, a server render); in a browser it is a plain timer. */
function detachedTimer(run: () => void, delay: number): ReturnType<typeof setTimeout> {
  const timer = setTimeout(run, delay);
  (timer as unknown as { unref?: () => void }).unref?.();
  return timer;
}

/**
 * @internal The form cards still waiting for an answer, live or loaded from history, whose tool lets the host answer them
 * (`onInteractionChange`, `answerInteraction`; HOST_ANSWERABLE). A card stays while its answer is being sent — a failed send
 * leaves it answerable again — and leaves the ledger when it settles, is withdrawn, or expires — the ledger's own timer locks it then, so a card left open past its time cannot be answered by anyone.
 */
class PendingInteractionLedger {
  readonly #hooks: PendingInteractionHooks;
  readonly #entries = new Map<string, { readonly entry: PendingInteractionEntry; timer: ReturnType<typeof setTimeout> }>();
  /** The interaction last reported to the host; `null` when "none" was. */
  #reported: string | null = null;
  #reportTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(hooks: PendingInteractionHooks) {
    this.#hooks = hooks;
  }

  track(interaction: AgentChatHumanInteractionChallenge, card: HTMLElement, status: HTMLElement): void {
    if (interaction.kind !== "form" || interaction.requestedSchema[HOST_ANSWERABLE] !== true) return;
    this.#drop(interaction.interactionId);
    const entry: PendingInteractionEntry = { interaction, card, status };
    const slot = { entry, timer: this.#expiry(entry) };
    this.#entries.set(interaction.interactionId, slot);
    this.#scheduleReport();
  }

  find(interactionId: string): PendingInteractionEntry | undefined {
    return this.#entries.get(interactionId)?.entry;
  }

  /** The card settled or was withdrawn: it is no longer the host's to answer. */
  release(card: HTMLElement): void {
    const id = card.dataset.interactionId;
    if (id && this.#entries.get(id)?.entry.card === card) { this.#drop(id); this.#scheduleReport(); }
  }

  /** The conversation changed or the widget is going away: nothing is pending any more. */
  clear(): void {
    for (const id of [...this.#entries.keys()]) this.#drop(id);
    this.#scheduleReport();
  }

  #expiry(entry: PendingInteractionEntry): ReturnType<typeof setTimeout> {
    const left = Date.parse(entry.interaction.expiresAt) - Date.now();
    return detachedTimer(() => {
      const slot = this.#entries.get(entry.interaction.interactionId);
      if (!slot || slot.entry !== entry) return;
      if (Date.parse(entry.interaction.expiresAt) > Date.now()) { slot.timer = this.#expiry(entry); return; }
      this.#drop(entry.interaction.interactionId);
      this.#hooks.expire(entry);
      this.#scheduleReport();
    }, Math.max(0, Math.min(left, MAX_TIMER_MS)));
  }

  #drop(id: string): void {
    const slot = this.#entries.get(id);
    if (!slot) return;
    clearTimeout(slot.timer);
    this.#entries.delete(id);
  }

  /**
   * Reported after the current task: a card arrives while its turn is still finishing, and a host that answers at once
   * would find the widget busy. Only a change of the newest pending card is reported.
   */
  #scheduleReport(): void {
    if (this.#reportTimer !== undefined) return;
    this.#reportTimer = setTimeout(() => {
      this.#reportTimer = undefined;
      const newest = [...this.#entries.values()].at(-1)?.entry.interaction;
      const id = newest?.interactionId ?? null;
      if (id === this.#reported) return;
      this.#reported = id;
      this.#hooks.report(newest ? Object.freeze({
        interactionId: newest.interactionId, toolId: newest.toolId, requesterId: newest.requesterId,
        requestedSchema: newest.requestedSchema, expiresAt: newest.expiresAt,
      }) : null);
    }, 0);
  }
}

/** @internal A host's answer read back as the settled card shows it: each field's title beside the chosen option's title. */
function interactionAnswerEcho(schema: Readonly<Record<string, unknown>>, content: Readonly<Record<string, unknown>>): readonly AgentChatInteractionEcho[] {
  const properties = isRecord(schema.properties) ? schema.properties : {};
  return Object.entries(content).flatMap(([id, value]) => {
    const field = properties[id];
    // A field the host fills (readOnly) is not part of what the person answered.
    if (!isRecord(field) || field.readOnly === true) return [];
    const option = Array.isArray(field.oneOf) ? field.oneOf.find((choice) => isRecord(choice) && choice.const === value) : undefined;
    return [{ label: text(field.title, id), value: isRecord(option) ? text(option.title, String(value)) : String(value) }];
  });
}
