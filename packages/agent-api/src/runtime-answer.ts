/**
 * What `GET /api/runtime` answers: that the service is up, and the product's own words for the
 * few lines a chat client writes itself ("thinking", "waiting for you", a lost connection).
 *
 * Those lines are the product's voice, and a client embedded in someone else's page cannot be
 * relied on to have been handed them: a page that was not showed the client's neutral English
 * defaults inside a Vietnamese product. The product states them once, here, and every page that
 * embeds the client gets them. A page that does pass its own still wins.
 */
export interface RuntimeAnswer {
  readonly status: "ok";
  readonly labels?: Readonly<Record<string, string>>;
}

export function runtimeAnswer(options: { readonly clientLabels?: Readonly<Record<string, string>> }): RuntimeAnswer {
  const labels = Object.fromEntries(Object.entries(options.clientLabels ?? {})
    .filter(([name, text]) => /^[a-zA-Z]{1,40}$/u.test(name) && typeof text === "string" && text.trim().length > 0 && text.length <= 300));
  return Object.keys(labels).length > 0 ? { status: "ok", labels } : { status: "ok" };
}
