/**
 * @internal Where a link in the chat opens.
 *
 * A link into the page the widget is embedded in navigates that page in place: the user stays in the host application,
 * and the widget, which keeps its session, comes back with the page. Any other link opens a new tab, so following it
 * never takes the user away from the application. The case it exists for: an answer linking the record the agent has
 * just created in the host application, which a new tab would open in a second copy of the application, beside a chat
 * that no longer shows it.
 */
function opensInPlace(href: string): boolean {
  const origin = globalThis.location?.origin;
  if (!origin || origin === "null") return false;
  try { return new URL(href).origin === origin; } catch { return false; }
}

/** @internal The target attributes of a rendered link: none for a link into the host page, a new tab otherwise. */
function linkTargetAttributes(href: string): string {
  return opensInPlace(href) ? "" : ` target="_blank" rel="noopener noreferrer"`;
}

/** @internal Follows a link that was not clicked as an anchor (an action button's link) the way a rendered one opens. */
function followLink(href: string): void {
  if (opensInPlace(href)) globalThis.location.assign(href);
  else window.open(href, "_blank", "noopener,noreferrer");
}
