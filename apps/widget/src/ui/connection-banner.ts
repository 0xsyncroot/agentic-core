/** Wording of the connection status; neutral English defaults live in core/labels.ts. */
interface AgentChatConnectionLabels {
  /** The one status line while the backend is unreachable; `connectionGaveUp` replaces it once auto-resume stops, beside a `connectionRetry` button. */
  readonly connectionLost?: string;
  readonly connectionGaveUp?: string;
  readonly connectionRetry?: string;
  /** Composer placeholder while a send waits for the connection. */
  readonly connectionWaiting?: string;
  /** Shown once in a turn that was cut off and could not be resumed. */
  readonly turnInterrupted?: string;
}

/**
 * @internal The one line that says the backend is unreachable, with "retry" once automatic
 * recovery has stopped. One element, updated in place, so a second failure cannot stack a second
 * message the way one error bubble per action would.
 */
class ConnectionBanner {
  readonly element = document.createElement("div");
  readonly #text = document.createElement("span");
  readonly #retry = document.createElement("button");
  readonly #labels: { readonly lost: string; readonly gaveUp: string; readonly retry: string };

  constructor(labels: { readonly lost: string; readonly gaveUp: string; readonly retry: string }, onRetry: () => void) {
    this.element.className = "acw-link-banner";
    this.element.hidden = true;
    this.element.setAttribute("role", "status");
    this.#retry.type = "button";
    this.#retry.className = "acw-link-retry";
    this.#retry.textContent = labels.retry;
    this.#retry.addEventListener("click", onRetry);
    this.element.append(this.#text, this.#retry);
    this.#labels = labels;
  }

  show(state: "online" | "reconnecting" | "offline"): void {
    this.element.hidden = state === "online";
    this.element.dataset.state = state;
    this.#text.textContent = state === "offline" ? this.#labels.gaveUp : state === "reconnecting" ? this.#labels.lost : "";
    this.#retry.hidden = state !== "offline";
  }
}
