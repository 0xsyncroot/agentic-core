const elements = {
  shell: document.querySelector(".shell"),
  conversation: document.querySelector("#conversation"),
  composer: document.querySelector("#composer"),
  message: document.querySelector("#message"),
  send: document.querySelector("#send"),
  template: document.querySelector("#message-template"),
  status: document.querySelector("#connection-status"),
  statusDot: document.querySelector("#status-dot"),
  modelStatus: document.querySelector("#model-status"),
  toolList: document.querySelector("#tool-list"),
  suggestions: document.querySelector("#suggestions"),
  newSession: document.querySelector("#new-session"),
  mobileNewSession: document.querySelector("#mobile-new-session"),
  menu: document.querySelector("#menu-button"),
  backdrop: document.querySelector("#sidebar-backdrop"),
};

const SESSION_KEY = "agentic-web-session";
const SESSION_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const querySession = new URL(location.href).searchParams.get("session");
const storedSession = localStorage.getItem(SESSION_KEY);
let sessionId = SESSION_PATTERN.test(querySession || "")
  ? querySession
  : SESSION_PATTERN.test(storedSession || "") ? storedSession : `web-${crypto.randomUUID()}`;
let pending = false;
let availableTools = [];

function persistSession(push = false) {
  localStorage.setItem(SESSION_KEY, sessionId);
  const url = new URL(location.href);
  url.searchParams.set("session", sessionId);
  history[push ? "pushState" : "replaceState"]({ sessionId }, "", url);
}

function createSession() {
  sessionId = `web-${crypto.randomUUID()}`;
  persistSession(true);
}

persistSession();

function clock(at) {
  return new Intl.DateTimeFormat("vi-VN", { hour: "2-digit", minute: "2-digit" }).format(at ? new Date(at) : new Date());
}

function scrollToLatest() {
  elements.conversation.scrollTo({ top: elements.conversation.scrollHeight, behavior: "smooth" });
}

function appendMessage(role, content, at, narrations) {
  document.querySelector("#welcome")?.remove();
  const fragment = elements.template.content.cloneNode(true);
  const row = fragment.querySelector(".message-row");
  row.classList.add(role);
  fragment.querySelector(".avatar").textContent = role === "user" ? "U" : "A";
  fragment.querySelector(".role").textContent = role === "user" ? "You" : role === "error" ? "Error" : "Agentic Core";
  fragment.querySelector("time").textContent = clock(at);
  const bubble = fragment.querySelector(".bubble");
  if (role === "assistant") {
    bubble.classList.add("markdown");
    bubble.innerHTML = renderMarkdown(content);
    if (Array.isArray(narrations)) {
      const narrationList = document.createElement("div");
      narrationList.className = "assistant-narrations";
      for (const narration of narrations) {
        if (narration?.audience !== "user" || typeof narration.content !== "string" ||
            !narration.content.trim() || sameMessage(narration.content, content)) continue;
        const bubbleNarration = document.createElement("div");
        bubbleNarration.className = "bubble markdown";
        bubbleNarration.innerHTML = renderMarkdown(narration.content);
        narrationList.append(bubbleNarration);
      }
      if (narrationList.childElementCount > 0) row.insertBefore(narrationList, bubble);
    }
  } else {
    bubble.textContent = content;
  }
  elements.conversation.append(fragment);
  scrollToLatest();
  return row;
}

function createAssistantTurn() {
  document.querySelector("#welcome")?.remove();
  const row = document.createElement("article");
  row.className = "message-row assistant";
  const meta = document.createElement("div");
  meta.className = "message-meta";
  meta.innerHTML = '<span class="avatar">M</span><span class="role">Agentic Core</span>';
  const progress = document.createElement("div");
  progress.className = "turn-progress";
  const feed = document.createElement("div");
  feed.className = "operation-feed";
  const thinking = document.createElement("div");
  thinking.className = "thinking-status";
  thinking.innerHTML = '<span class="activity-spinner" aria-hidden="true"></span><span>Thinking</span>';
  progress.append(feed, thinking);
  const narrations = document.createElement("div");
  narrations.className = "assistant-narrations";
  narrations.hidden = true;
  const bubble = document.createElement("div");
  bubble.className = "bubble markdown";
  bubble.hidden = true;
  row.append(meta, progress, narrations, bubble);
  elements.conversation.append(row);
  scrollToLatest();
  return {
    row, progress, feed, thinking, narrations, bubble, activeNarrationId: "", narrationDraft: null, narrationContent: "",
    activeOutputId: "", outputContent: "",
    startedAt: performance.now(),
  };
}

function showThinking(turn, label = "Thinking") {
  turn.thinking.querySelector("span:last-child").textContent = label;
  turn.thinking.hidden = false;
  turn.progress.hidden = false;
}

function hideThinking(turn) {
  turn.thinking.hidden = true;
}

function sameMessage(left, right) {
  const normalize = (value) => String(value ?? "").replaceAll(/\s+/g, " ").trim();
  return normalize(left) === normalize(right);
}

function handleProgress(turn, progress) {
  if (progress.type === "step-started") {
    showThinking(turn, progress.step === 1 ? "Thinking" : "Reviewing results");
  } else if (progress.type === "model-attempt-started") {
    showThinking(turn, progress.step === 1 ? "Thinking" : "Reviewing results");
  } else if (progress.type === "model-attempt-discarded") {
    if (progress.willRetry) showThinking(turn, "Retrying");
  } else if (progress.type === "turn-completed") {
    hideThinking(turn);
    turn.progress.classList.add("complete");
    turn.progress.hidden = true;
  } else if (progress.type === "turn-failed") {
    hideThinking(turn);
  }
}

function handleNarration(turn, event, payload) {
  if (payload?.audience !== "user" || typeof payload.narrationId !== "string") return;
  if (event === "assistant-narration-start") {
    turn.narrationDraft?.remove();
    const narration = document.createElement("div");
    narration.className = "bubble markdown";
    turn.narrations.hidden = false;
    turn.narrations.append(narration);
    turn.activeNarrationId = payload.narrationId;
    turn.narrationDraft = narration;
    turn.narrationContent = "";
  } else if (event === "assistant-narration-delta" && payload.narrationId === turn.activeNarrationId && typeof payload.delta === "string") {
    turn.narrationContent += payload.delta;
    turn.narrationDraft.innerHTML = renderMarkdown(turn.narrationContent);
    scrollToLatest();
  } else if (event === "assistant-narration-end" && payload.narrationId === turn.activeNarrationId) {
    if (payload.status !== "completed" || !turn.narrationContent.trim()) turn.narrationDraft?.remove();
    else turn.narrationDraft.dataset.source = turn.narrationContent.trim();
    turn.narrations.hidden = turn.narrations.childElementCount === 0;
    turn.activeNarrationId = "";
    turn.narrationDraft = null;
    turn.narrationContent = "";
  }
}

function handleOutput(turn, event, payload) {
  if (payload?.audience !== "user" || typeof payload.outputId !== "string") return;
  if (event === "assistant-output-start") {
    turn.activeOutputId = payload.outputId;
    turn.outputContent = "";
    turn.bubble.replaceChildren();
    turn.bubble.hidden = true;
    turn.bubble.dataset.messageKind = "output-draft";
    turn.bubble.setAttribute("aria-busy", "true");
  } else if (event === "assistant-output-delta" && payload.outputId === turn.activeOutputId && typeof payload.delta === "string") {
    turn.outputContent += payload.delta;
    turn.bubble.innerHTML = renderMarkdown(turn.outputContent);
    turn.bubble.hidden = false;
    scrollToLatest();
  } else if (event === "assistant-output-end" && payload.outputId === turn.activeOutputId) {
    if (payload.status === "discarded") {
      turn.bubble.replaceChildren();
      turn.bubble.hidden = true;
    } else {
      turn.bubble.dataset.messageKind = "output";
    }
    turn.bubble.setAttribute("aria-busy", "false");
    turn.activeOutputId = "";
    turn.outputContent = "";
  }
}

function escapeHtml(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

function inlineMarkdown(value) {
  const parts = value.split(/(`[^`\n]+`)/g);
  return parts.map((part) => {
    if (part.startsWith("`") && part.endsWith("`")) return `<code>${escapeHtml(part.slice(1, -1))}</code>`;
    let safe = escapeHtml(part);
    safe = safe.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    safe = safe.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    safe = safe.replace(/__([^_]+)__/g, "<strong>$1</strong>");
    safe = safe.replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
    return safe;
  }).join("");
}

function renderMarkdown(markdown) {
  const lines = String(markdown ?? "").replaceAll("\r\n", "\n").split("\n");
  const output = [];
  let listType = "";
  let paragraph = [];
  let inCode = false;
  let codeLanguage = "";
  let codeLines = [];

  const closeList = () => {
    if (listType) output.push(`</${listType}>`);
    listType = "";
  };
  const flushParagraph = () => {
    if (paragraph.length) output.push(`<p>${inlineMarkdown(paragraph.join(" "))}</p>`);
    paragraph = [];
  };
  const flushBlocks = () => {
    flushParagraph();
    closeList();
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fence = line.match(/^\s*```([\w-]*)\s*$/);
    if (fence) {
      if (inCode) {
        output.push(`<pre><code class="language-${escapeHtml(codeLanguage)}">${escapeHtml(codeLines.join("\n"))}</code></pre>`);
        codeLines = [];
        codeLanguage = "";
        inCode = false;
      } else {
        flushBlocks();
        inCode = true;
        codeLanguage = fence[1] || "";
      }
      continue;
    }
    if (inCode) {
      codeLines.push(line);
      continue;
    }
    if (!line.trim()) {
      const nextLine = lines.slice(index + 1).find((candidate) => candidate.trim());
      const nextIsSameList = listType === "ul"
        ? /^\s*[-*+]\s+/.test(nextLine || "")
        : listType === "ol" && /^\s*\d+[.)]\s+/.test(nextLine || "");
      if (nextIsSameList) continue;
      flushBlocks();
      continue;
    }
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      flushBlocks();
      const level = heading[1].length;
      output.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`);
      continue;
    }
    if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
      flushBlocks();
      output.push("<hr>");
      continue;
    }
    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      flushBlocks();
      output.push(`<blockquote>${inlineMarkdown(quote[1])}</blockquote>`);
      continue;
    }
    const unordered = line.match(/^\s*[-*+]\s+(.+)$/);
    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (unordered || ordered) {
      flushParagraph();
      const nextType = unordered ? "ul" : "ol";
      if (listType !== nextType) {
        closeList();
        listType = nextType;
        output.push(`<${listType}>`);
      }
      output.push(`<li>${inlineMarkdown((unordered || ordered)[1])}</li>`);
      continue;
    }
    closeList();
    paragraph.push(line.trim());
  }
  if (inCode) output.push(`<pre><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
  flushBlocks();
  return output.join("");
}

function parseSseFrame(frame) {
  let event = "message";
  const data = [];
  for (const rawLine of frame.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.startsWith("event:")) event = line.slice(6).trim();
    if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  if (!data.length) return null;
  return { event, payload: JSON.parse(data.join("\n")) };
}

async function streamRequest(endpoint, body, turn) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { accept: "text/event-stream", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const payload = await response.json();
    throw new Error(payload.error?.message || `HTTP ${response.status}`);
  }
  if (!response.body) throw new Error("This browser does not support streaming responses.");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result;
  let streamError;

  const consume = (frame) => {
    const message = parseSseFrame(frame);
    if (!message) return;
    if (message.event === "progress") handleProgress(turn, message.payload);
    if (message.event.startsWith("assistant-output-")) handleOutput(turn, message.event, message.payload);
    if (message.event.startsWith("assistant-narration-")) handleNarration(turn, message.event, message.payload);
    if (message.event === "result") result = message.payload;
    if (message.event === "error") streamError = new Error(message.payload.message || "The request could not be completed.");
  };

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done }).replaceAll("\r\n", "\n");
    let boundary;
    while ((boundary = buffer.indexOf("\n\n")) >= 0) {
      consume(buffer.slice(0, boundary));
      buffer = buffer.slice(boundary + 2);
    }
    if (done) break;
  }
  if (buffer.trim()) consume(buffer);
  if (streamError) throw streamError;
  if (!result) throw new Error("The runtime ended without a result.");
  return result;
}

function streamTurn(content, turn) {
  return streamRequest("/api/chat/stream", { content, sessionId, requestId: crypto.randomUUID() }, turn);
}

function setPending(value) {
  pending = value;
  elements.send.disabled = value;
  elements.message.disabled = value;
  elements.send.querySelector(".send-label").textContent = value ? "Working" : "Send";
}

function showApproval(turn, result) {
  const approval = result.approval;
  if (!approval?.approvalId || approval.sessionId !== sessionId) return;
  const panel = document.createElement("div");
  panel.className = "approval-card";
  panel.dataset.interactionId = approval.approvalId;
  const title = document.createElement("strong");
  title.textContent = "Approval required";
  const description = document.createElement("span");
  description.textContent = `Cho phép sử dụng ${toolLabel(approval.toolId)}?`;
  const risk = document.createElement("span");
  risk.textContent = approval.sideEffect === "nonIdempotent"
    ? "This action can change data and must not be repeated automatically."
    : approval.sideEffect === "idempotent"
      ? "This action can change data."
      : "Access policy requires approval for this action.";
  const status = document.createElement("span");
  status.className = "approval-status";
  status.setAttribute("aria-live", "polite");
  const actions = document.createElement("div");
  actions.className = "approval-actions";
  const deny = document.createElement("button");
  deny.type = "button";
  deny.className = "approval-deny";
  deny.textContent = "Decline";
  const approve = document.createElement("button");
  approve.type = "button";
  approve.className = "approval-approve";
  approve.textContent = "Approve";
  actions.append(deny, approve);
  panel.append(title, description, risk, status, actions);
  turn.row.append(panel);

  const expired = Date.parse(approval.expiresAt) <= Date.now();
  if (expired) {
    status.textContent = "This approval request has expired.";
    deny.disabled = true;
    approve.disabled = true;
  } else {
    status.textContent = `Valid until ${clock(approval.expiresAt)}.`;
  }

  const resolve = async (decision) => {
    if (pending || panel.dataset.resolved === "true") return;
    if (Date.parse(approval.expiresAt) <= Date.now()) {
      status.textContent = "This approval request has expired.";
      deny.disabled = true;
      approve.disabled = true;
      return;
    }
    const continuation = createAssistantTurn();
    setPending(true);
    deny.disabled = true;
    approve.disabled = true;
    status.textContent = decision === "approve" ? "Approving and continuing…" : "Declining and continuing…";
    try {
      const payload = await streamRequest(
        `/api/interactions/${encodeURIComponent(approval.approvalId)}/stream`,
        { kind: "approval", sessionId, requestId: crypto.randomUUID(), decision },
        continuation,
      );
      completeTurn(continuation, payload);
      panel.dataset.resolved = "true";
      actions.remove();
      status.textContent = decision === "approve" ? "You approved this action." : "You declined this action.";
    } catch (error) {
      failTurn(continuation, error);
      status.textContent = error instanceof Error ? error.message : "Could not process the approval.";
      const nowExpired = Date.parse(approval.expiresAt) <= Date.now();
      deny.disabled = nowExpired;
      approve.disabled = nowExpired;
    } finally {
      setPending(false);
      scrollToLatest();
    }
  };
  deny.addEventListener("click", () => void resolve("deny"));
  approve.addEventListener("click", () => void resolve("approve"));
  scrollToLatest();
}

function interactionChoices(schema, keyword = "oneOf") {
  if (!schema || typeof schema !== "object") return [];
  if (Array.isArray(schema.enum)) return schema.enum.filter((value) => typeof value === "string").map((value) => ({ value, label: value }));
  if (!Array.isArray(schema[keyword])) return [];
  return schema[keyword].flatMap((candidate) => candidate && typeof candidate === "object" && typeof candidate.const === "string" && typeof candidate.title === "string"
    ? [{ value: candidate.const, label: candidate.title }] : []);
}

function showInteraction(turn, result) {
  const interaction = result.interaction;
  if (!interaction?.interactionId || interaction.sessionId !== sessionId || (interaction.kind !== "form" && interaction.kind !== "external")) return;
  const panel = document.createElement("div");
  panel.className = "approval-card interaction-card";
  panel.dataset.interactionId = interaction.interactionId;
  const title = document.createElement("strong");
  title.textContent = interaction.title || (interaction.kind === "form" ? "More information needed" : "Authorization required");
  const description = document.createElement("span");
  description.textContent = interaction.message;
  const notice = document.createElement("span");
  notice.textContent = interaction.kind === "form"
    ? "Do not enter passwords, one-time codes, tokens, API keys or payment information in this form."
    : `You will open ${new URL(interaction.url).host}; credentials do not pass through this conversation.`;
  const status = document.createElement("span");
  status.className = "approval-status";
  status.setAttribute("aria-live", "polite");
  const actions = document.createElement("div");
  actions.className = "approval-actions";
  const decline = document.createElement("button");
  decline.type = "button"; decline.className = "approval-deny"; decline.textContent = "Skip";
  const accept = document.createElement("button");
  accept.type = interaction.kind === "form" ? "submit" : "button";
  accept.className = "approval-approve";
  accept.textContent = interaction.kind === "form" ? "Submit" : "Open and continue";
  const controls = [];
  let form;
  if (interaction.kind === "form") {
    form = document.createElement("form");
    form.className = "interaction-form";
    const schema = interaction.requestedSchema && typeof interaction.requestedSchema === "object" ? interaction.requestedSchema : {};
    const properties = schema.properties && typeof schema.properties === "object" ? schema.properties : {};
    const required = new Set(Array.isArray(schema.required) ? schema.required : []);
    for (const [id, field] of Object.entries(properties).slice(0, 20)) {
      if (!field || typeof field !== "object") continue;
      const group = document.createElement("label"); group.className = "interaction-field";
      const caption = document.createElement("span"); caption.textContent = `${field.title || id}${required.has(id) ? " *" : ""}`; group.append(caption);
      const choices = interactionChoices(field);
      if (field.type === "boolean") {
        const input = document.createElement("input"); input.type = "checkbox"; input.name = id; input.checked = field.default === true; group.append(input);
        controls.push({ id, read: () => input.checked });
      } else if (field.type === "array" && field.items && typeof field.items === "object") {
        const itemChoices = interactionChoices(field.items, "anyOf");
        const select = document.createElement("select"); select.multiple = true; select.required = required.has(id);
        const defaults = new Set(Array.isArray(field.default) ? field.default.filter((item) => typeof item === "string") : []);
        for (const choice of itemChoices) {
          const option = document.createElement("option"); option.value = choice.value; option.textContent = choice.label; option.selected = defaults.has(choice.value); select.append(option);
        }
        group.append(select); controls.push({ id, read: () => [...select.selectedOptions].map((option) => option.value) });
      } else if (choices.length) {
        const select = document.createElement("select"); select.required = required.has(id);
        if (!required.has(id)) { const empty = document.createElement("option"); empty.value = ""; empty.textContent = "— Chọn —"; select.append(empty); }
        for (const choice of choices) { const option = document.createElement("option"); option.value = choice.value; option.textContent = choice.label; option.selected = field.default === choice.value; select.append(option); }
        group.append(select); controls.push({ id, read: () => select.value || undefined });
      } else {
        const input = Number(field.maxLength) > 2000 ? document.createElement("textarea") : document.createElement("input");
        input.required = required.has(id);
        if (input instanceof HTMLInputElement) {
          input.type = field.type === "number" || field.type === "integer" ? "number" : field.format === "email" ? "email" : field.format === "date" ? "date" : field.format === "date-time" ? "datetime-local" : field.format === "uri" ? "url" : "text";
          if (field.type === "integer") input.step = "1";
          if (typeof field.minimum === "number") input.min = String(field.minimum);
          if (typeof field.maximum === "number") input.max = String(field.maximum);
        } else input.rows = 3;
        if (typeof field.maxLength === "number") input.maxLength = field.maxLength;
        if (typeof field.default === "string" || typeof field.default === "number") input.value = String(field.default);
        group.append(input); controls.push({ id, read: () => !input.value && !required.has(id) ? undefined : field.type === "number" || field.type === "integer" ? Number(input.value) : input.value });
      }
      if (typeof field.description === "string" && field.description) { const hint = document.createElement("small"); hint.textContent = field.description; group.append(hint); }
      form.append(group);
    }
    actions.append(decline, accept); form.append(actions); panel.append(title, description, notice, form, status);
  } else {
    const url = document.createElement("code"); url.className = "interaction-url"; url.textContent = interaction.url;
    actions.append(decline, accept); panel.append(title, description, notice, url, status, actions);
  }
  turn.row.append(panel);
  const buttons = [...actions.querySelectorAll("button")];
  const expired = Date.parse(interaction.expiresAt) <= Date.now();
  if (expired) { status.textContent = "This request has expired."; buttons.forEach((button) => { button.disabled = true; }); }
  else status.textContent = `Valid until ${clock(interaction.expiresAt)}.`;
  const resolve = async (action, content) => {
    if (pending || panel.dataset.resolved === "true" || Date.parse(interaction.expiresAt) <= Date.now()) return;
    const continuation = createAssistantTurn(); setPending(true); buttons.forEach((button) => { button.disabled = true; }); status.textContent = "Đang tiếp tục…";
    try {
      const payload = await streamRequest(`/api/interactions/${encodeURIComponent(interaction.interactionId)}/stream`, {
        kind: interaction.kind, sessionId, requestId: crypto.randomUUID(), action, ...(content === undefined ? {} : { content }),
      }, continuation);
      completeTurn(continuation, payload); panel.dataset.resolved = "true"; actions.remove();
      status.textContent = action === "accept" ? "Your response was received." : "You skipped this request.";
    } catch (error) {
      failTurn(continuation, error); status.textContent = error instanceof Error ? error.message : "Could not continue the interaction.";
      buttons.forEach((button) => { button.disabled = Date.parse(interaction.expiresAt) <= Date.now(); });
    } finally { setPending(false); scrollToLatest(); }
  };
  decline.addEventListener("click", () => void resolve("decline"));
  if (form) form.addEventListener("submit", (event) => {
    event.preventDefault(); if (!form.reportValidity()) return;
    const content = Object.fromEntries(controls.flatMap((control) => { const value = control.read(); return value === undefined ? [] : [[control.id, value]]; }));
    void resolve("accept", content);
  });
  else accept.addEventListener("click", () => { window.open(interaction.url, "_blank", "noopener,noreferrer"); void resolve("accept"); });
  scrollToLatest();
}

function completeTurn(turn, result) {
  hideThinking(turn);
  const finalContent = result.content || "The agent finished without returning content.";
  turn.activeOutputId = "";
  turn.outputContent = "";
  turn.bubble.setAttribute("aria-busy", "false");
  turn.narrations.querySelectorAll("[data-source]").forEach((item) => {
    if (sameMessage(item.dataset.source, finalContent)) item.remove();
  });
  turn.narrations.hidden = turn.narrations.childElementCount === 0;
  turn.bubble.innerHTML = renderMarkdown(finalContent);
  turn.bubble.dataset.messageKind = "final";
  turn.bubble.hidden = false;
  turn.progress.classList.add("complete");
  turn.progress.hidden = turn.feed.childElementCount === 0;
  if (result.outcome === "awaiting_approval") showApproval(turn, result);
  if (result.outcome === "awaiting_interaction") showInteraction(turn, result);
}

function failTurn(turn, error) {
  hideThinking(turn);
  turn.row.classList.add("error");
  turn.bubble.textContent = error instanceof Error ? error.message : "Could not connect.";
  turn.bubble.hidden = false;
  turn.progress.hidden = turn.feed.childElementCount === 0;
}

async function send(content) {
  const normalized = content.trim();
  if (pending || !normalized) return;
  appendMessage("user", normalized);
  elements.message.value = "";
  resize();
  const turn = createAssistantTurn();
  setPending(true);
  try {
    const result = await streamTurn(normalized, turn);
    completeTurn(turn, result);
  } catch (error) {
    failTurn(turn, error);
  } finally {
    setPending(false);
    elements.message.focus();
    scrollToLatest();
  }
}

function toolLabel(toolId) {
  const value = toolId.replaceAll(/[_./:-]+/g, " ").trim();
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : toolId;
}

function renderTools(tools) {
  elements.toolList.replaceChildren();
  for (const tool of tools) {
    const button = document.createElement("button");
    button.className = "tool-item";
    button.type = "button";
    button.title = tool.description;
    const icon = document.createElement("span");
    icon.className = "tool-icon";
    icon.textContent = tool.id.slice(0, 1).toUpperCase();
    const copy = document.createElement("span");
    copy.className = "tool-copy";
    const name = document.createElement("strong");
    name.textContent = tool.id;
    const label = document.createElement("small");
    label.textContent = toolLabel(tool.id);
    copy.append(name, label);
    button.append(icon, copy);
    button.addEventListener("click", () => {
      elements.message.value = `Use ${tool.id} to help with my request.`;
      resize();
      elements.message.focus();
      closeSidebar();
    });
    elements.toolList.append(button);
  }
  if (!tools.length) {
    const empty = document.createElement("span");
    empty.className = "tool-loading";
    empty.textContent = "No tools enabled";
    elements.toolList.append(empty);
  }
}

function renderSuggestions(tools) {
  const container = document.querySelector("#suggestions");
  if (!container) return;
  container.replaceChildren();
  for (const tool of tools.slice(0, 4)) {
    const button = document.createElement("button");
    button.className = "suggestion";
    button.type = "button";
    const title = document.createElement("strong");
    title.textContent = toolLabel(tool.id);
    const detail = document.createElement("span");
    detail.textContent = tool.description || tool.id;
    button.append(title, detail);
    button.addEventListener("click", () => {
      elements.message.value = `Use ${tool.id} to help with my request.`;
      resize();
      elements.message.focus();
    });
    container.append(button);
  }
}

async function loadRuntime() {
  try {
    const response = await fetch("/api/runtime");
    if (!response.ok) throw new Error();
    const runtime = await response.json();
    availableTools = Array.isArray(runtime.tools) ? runtime.tools : [];
    elements.status.textContent = "Runtime ready";
    elements.statusDot.classList.add("online");
    elements.modelStatus.textContent = "Connected to the agent runtime";
    document.querySelector(".tools-panel").hidden = !Array.isArray(runtime.tools);
    renderTools(availableTools);
    renderSuggestions(availableTools);
  } catch {
    elements.status.textContent = "Disconnected";
    elements.statusDot.classList.remove("online");
    elements.modelStatus.textContent = "Could not connect to the runtime";
    renderTools([]);
  }
}

async function loadSessionHistory() {
  try {
    const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`);
    if (!response.ok) return;
    const historyPayload = await response.json();
    if (!Array.isArray(historyPayload.messages) || historyPayload.messages.length === 0) return;
    elements.conversation.replaceChildren();
    for (const message of historyPayload.messages) {
      if ((message.role === "user" || message.role === "assistant") && typeof message.content === "string") {
        const row = appendMessage(message.role, message.content, message.at, message.narrations);
        if (message.role === "assistant" && message.approval) {
          showApproval({ row, bubble: row.querySelector(".bubble") }, message);
        }
        if (message.role === "assistant" && message.interaction) {
          showInteraction({ row, bubble: row.querySelector(".bubble") }, message);
        }
      }
    }
  } catch { /* A missing history must not prevent a new conversation. */ }
}

function renderWelcome() {
  const welcome = document.createElement("div");
  welcome.className = "welcome";
  welcome.id = "welcome";
  welcome.innerHTML = '<div class="welcome-mark" aria-hidden="true">A</div><h1>Hello</h1><p>How can I help?</p><div class="suggestions" id="suggestions"></div>';
  elements.conversation.replaceChildren(welcome);
  renderSuggestions(availableTools);
}

function resize() {
  elements.message.style.height = "auto";
  elements.message.style.height = `${Math.min(elements.message.scrollHeight, 190)}px`;
}

function newConversation() {
  if (pending) return;
  createSession();
  renderWelcome();
  elements.message.value = "";
  resize();
  elements.message.focus();
}

function closeSidebar() {
  elements.shell.classList.remove("sidebar-open");
}

elements.composer.addEventListener("submit", (event) => {
  event.preventDefault();
  void send(elements.message.value);
});
elements.message.addEventListener("input", resize);
elements.message.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    elements.composer.requestSubmit();
  }
});
elements.newSession.addEventListener("click", newConversation);
elements.mobileNewSession.addEventListener("click", newConversation);
elements.menu.addEventListener("click", () => elements.shell.classList.toggle("sidebar-open"));
elements.backdrop.addEventListener("click", closeSidebar);
window.addEventListener("popstate", () => {
  const value = new URL(location.href).searchParams.get("session");
  if (!SESSION_PATTERN.test(value || "") || value === sessionId || pending) return;
  sessionId = value;
  localStorage.setItem(SESSION_KEY, sessionId);
  renderWelcome();
  void loadSessionHistory();
});

void Promise.all([loadRuntime(), loadSessionHistory()]);
elements.message.focus();
