const params = new URL(location.href).searchParams;
const servedByHarness = location.pathname === "/widget-demo" || location.pathname === "/widget-demo/";
const defaultHarnessBaseUrl = "http://127.0.0.1:3400";

if (!servedByHarness && !params.has("api")) {
  const canonicalDemoUrl = new URL("/widget-demo/", defaultHarnessBaseUrl);
  canonicalDemoUrl.search = params.toString();
  location.replace(canonicalDemoUrl);
} else {
  bootDemo();
}

function bootDemo() {
  const harnessBaseUrl = params.get("api") || location.origin;
  const status = document.querySelector("#harness-status");
  const demoLink = document.querySelector("#harness-demo-url");
  const canonicalDemoUrl = new URL("/widget-demo/", harnessBaseUrl);
  document.querySelector("#api-url").textContent = harnessBaseUrl;
  demoLink.href = canonicalDemoUrl.href;
  demoLink.textContent = canonicalDemoUrl.href;
  let connectionFailed = false;

  async function authenticationHeaders() {
    // A real host application supplies a fresh access token from its auth session.
    // Tenant/user claims are resolved and verified by the server, never configured on the widget.
    const token = await globalThis.gatewayDemoAuth?.getAccessToken?.();
    return typeof token === "string" && token.trim()
      ? { Authorization: `Bearer ${token.trim()}` }
      : {};
  }

  function setStatus(state, message) {
    status.dataset.state = state;
    status.textContent = message;
  }

  const logo = "data:image/svg+xml," + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><rect width="120" height="120" rx="30" fill="#ecfdf5"/><circle cx="60" cy="58" r="34" fill="#dbeafe" stroke="#12b981" stroke-width="5"/><rect x="37" y="43" width="46" height="34" rx="14" fill="#fff"/><circle cx="50" cy="58" r="6" fill="#2563eb"/><circle cx="70" cy="58" r="6" fill="#2563eb"/><path d="M50 70q10 8 20 0" fill="none" stroke="#344054" stroke-width="4" stroke-linecap="round"/><path d="M60 22v-8" stroke="#12b981" stroke-width="5" stroke-linecap="round"/><circle cx="60" cy="10" r="5" fill="#2563eb"/></svg>`);

  let widget;
  widget = AgentChat.init({
    connection: { baseUrl: harnessBaseUrl, headers: authenticationHeaders },
    agent: { id: params.get("agentId") || "default", name: params.get("agentName") || "Agentic Core", logoUrl: logo },
    subtitle: "Chat powered by the full agent runtime",
    badge: "Demo",
    userName: params.get("userName") || "there",
    contextProvider: () => ({ visitorName: params.get("userName") || "there", page: location.pathname }),
    welcomeTitle: ({ hostContext }) => `Hello ${hostContext.visitorName}!`,
    welcomeMessage: ({ hostContext }) => `How can I help on ${hostContext.page}?`,
    suggestedPrompts: [
      "What can you help me with?",
      "Briefly introduce this assistant",
      "What is the current UTC time?"
    ],
    storageKey: "agentic-chat:real-harness-demo",
    persistSession: params.get("persistSession") !== "false",
    showLauncher: params.get("showLauncher") !== "false",
    mode: params.get("mode") === "floating" ? "floating" : "docked",
    position: params.get("position") === "left" ? "left" : "right",
    width: Number(params.get("width")) || 460,
    minWidth: 340,
    maxWidth: 720,
    resizable: true,
    attachments: true,
    startOpen: params.get("startOpen") !== "false",
    onReady: () => {
      if (!connectionFailed) setStatus("ready", `Connected · session ${widget.getSessionId()}`);
      const initialPrompt = params.get("prompt")?.trim();
      if (initialPrompt) void widget.send(initialPrompt);
    },
    onSessionChange: (sessionId) => {
      if (!connectionFailed) setStatus("ready", `New conversation · session ${sessionId}`);
    },
    onError: (error) => {
      connectionFailed = true;
      const harnessOrigin = new URL(harnessBaseUrl, location.href).origin;
      const crossOriginHint = harnessOrigin === location.origin
        ? ""
        : ` The demo is running on ${location.origin}; configure AGENTIC_WEB_ALLOWED_ORIGINS=${location.origin} or open the demo on the same origin.`;
      setStatus("error", `${error.message}${crossOriginHint}`);
    },
    onMessage: (message) => { document.body.dataset.lastMessageRole = message.role; },
    onNarration: (message) => { document.body.dataset.lastNarration = message.content; },
    onAction: (action) => { document.body.dataset.lastAction = action.type; },
    onResize: ({ width }) => { document.body.dataset.widgetWidth = String(width); }
  });

  window.demoChatWidget = widget;
  document.querySelector("#open-chat").addEventListener("click", () => widget.open());
  document.querySelector("#toggle-chat").addEventListener("click", () => widget.toggle());
  document.querySelector("#close-chat").addEventListener("click", () => widget.close());
}
