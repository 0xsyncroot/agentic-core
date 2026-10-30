/**
 * @internal A tool's question card — a form, or consent to open an external page — as DOM. What answering it does
 * (resuming the task) stays with the widget, which receives the parts it settles the card through.
 */

/** @internal What the status line of a settled card says, by the state history reports. */
const SETTLED_INTERACTION_SENTENCE: Readonly<Record<string, string>> = Object.freeze({
  answered: "Thông tin đã được tiếp nhận.", declined: "Đã bỏ qua yêu cầu.",
  superseded: "Yêu cầu này không còn khớp với nội dung trao đổi mới nhất.",
  expired: "Yêu cầu đã hết hạn.",
});

/** @internal The status line of a card still waiting: until when it can be answered. */
function interactionValidUntil(expiresAt: string): string {
  return `Có hiệu lực đến ${new Intl.DateTimeFormat("vi-VN", { hour: "2-digit", minute: "2-digit" }).format(new Date(expiresAt))}.`;
}

/**
 * @internal A card's message as HTML: plain text, except Markdown links `[label](https://…)`, which open as a link in an
 * answer does (the host decides where). A tool that hands the person something to open — a record it created — names it here,
 * where the person is looking, whether or not the agent wrote a line about it.
 */
function interactionMessageHtml(message: string): string {
  return message.split(/(\[[^\]\n]{1,200}\]\(https?:\/\/[^\s)]+\))/u).map((part) => {
    const link = /^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/u.exec(part);
    return link ? `<a href="${escapeHtml(link[2]!)}"${linkTargetAttributes(link[2]!)}>${escapeHtml(link[1]!)}</a>` : escapeHtml(part);
  }).join("");
}

/**
 * @internal Builds the card. `accept` is called with the form's answers and the receipt the review tab read out (or
 * nothing, for an external page the person chose to open); the returned `decline` button is the widget's to wire.
 */
function buildHumanInteractionCard(
  interaction: AgentChatHumanInteractionChallenge,
  accept: (content: unknown, echo?: readonly AgentChatInteractionEcho[]) => void,
): { readonly card: HTMLElement; readonly status: HTMLElement; readonly decline: HTMLButtonElement } {
  const card = document.createElement("section");
  card.className = "acw-approval acw-interaction";
  card.dataset.interactionId = interaction.interactionId;
  // Who asked — "runtime" for the runtime's own question whether to go on — as a hook for scripts; it renders the same.
  card.dataset.requesterId = interaction.requesterId;
  card.setAttribute("aria-label", interaction.kind === "form" ? "Thông tin cần bổ sung" : "Xác thực bên ngoài");
  const title = document.createElement("strong");
  title.className = "acw-approval-title";
  title.textContent = interaction.title || (interaction.kind === "form" ? "Cần thêm thông tin" : "Cần xác thực");
  const description = document.createElement("p");
  description.className = "acw-approval-description";
  description.innerHTML = interactionMessageHtml(interaction.message);
  const status = document.createElement("span");
  status.className = "acw-approval-status";
  status.setAttribute("aria-live", "polite");
  // Set before the form is built: a form whose send button starts disabled replaces this line with its own hint and puts it back.
  status.textContent = interactionValidUntil(interaction.expiresAt);
  const decline = document.createElement("button");
  decline.type = "button"; decline.className = "acw-approval-deny"; decline.textContent = "Bỏ qua";
  const confirm = document.createElement("button");
  confirm.type = "button";
  confirm.className = "acw-approval-approve";
  confirm.textContent = interaction.kind === "form" ? "Gửi thông tin" : "Mở và tiếp tục";
  const persistentActions = document.createElement("div");
  persistentActions.className = "acw-approval-actions";
  persistentActions.append(decline, confirm);
  // The status line and the card's two answers share one row: when it lapses on the left,
  // what to do about it on the right.
  const footer = document.createElement("div");
  footer.className = "acw-interaction-footer";
  footer.append(status, persistentActions);
  if (interaction.kind === "form") {
    // Words written under "Khác" arrive as the field's own value, through the same answer.
    const body = buildInteractionForm(interaction.requestedSchema, confirm, status, (content, echo) => accept(content, echo));
    // No card-wide caution about secrets: it sits under each box there is to type into, and
    // appears once that box is clicked (see freeTextNotice in ui/interaction-field.ts).
    card.append(title, description, body, footer);
  } else {
    const notice = document.createElement("p");
    notice.className = "acw-interaction-notice";
    notice.textContent = `Sẽ mở ${new URL(interaction.url).host}; thông tin xác thực không được gửi qua cuộc trò chuyện.`;
    const body = document.createElement("code");
    body.className = "acw-interaction-url";
    body.textContent = interaction.url;
    confirm.addEventListener("click", () => {
      window.open(interaction.url, "_blank", "noopener,noreferrer");
      accept(undefined);
    });
    card.append(title, description, notice, body, footer);
  }
  return { card, status, decline };
}
