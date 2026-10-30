/** @internal Resolves browser-only presentation context. */
class AgentChatContextResolver {
  readonly #provider: AgentChatContextProvider | undefined;
  readonly #state: () => Omit<AgentChatResolveSeed, "reason" | "location" | "signal">;
  readonly #runtime: () => unknown;

  constructor(
    provider: AgentChatContextProvider | undefined,
    state: () => Omit<AgentChatResolveSeed, "reason" | "location" | "signal">,
    runtime: () => unknown,
  ) {
    this.#provider = provider;
    this.#state = state;
    this.#runtime = runtime;
  }

  async resolve(reason: AgentChatResolveReason, signal: AbortSignal): Promise<AgentChatResolveContext> {
    const seed: AgentChatResolveSeed = {
      reason,
      ...this.#state(),
      location: { href: location.href, title: document.title, referrer: document.referrer },
      signal,
    };
    const hostContext = typeof this.#provider === "function" ? await this.#provider(seed) : this.#provider;
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    const runtime = this.#runtime();
    return { ...seed, hostContext, ...(runtime === undefined ? {} : { runtime }) };
  }

  async text(source: AgentChatResolvable<string>, fallback: string, context: AgentChatResolveContext): Promise<string> {
    const value = typeof source === "function" ? await source(context) : source;
    return typeof value === "string" && value.trim() ? value.trim() : fallback;
  }
}
