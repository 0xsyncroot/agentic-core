/** @internal Validates static options and adapts legacy fields. */
function normalizeSettings(options: AgentChatOptions, composition: AgentChatComposition): WidgetSettings {
  if (!options) throw new TypeError("AgentChat options are required");
  const agentName = compact(options.agent?.name ?? options.agentName, "Agentic Agent");
  const agentProfileId = compact(options.agent?.id ?? options.agentProfileId, "") || undefined;
  const logoUrl = (options.agent?.logoUrl ?? options.logoUrl)?.trim() ?? "";
  const userName = compact(options.userName, "bạn");
  const defaultWelcomeTitle = `Xin chào ${userName}!`;
  const prompts = (options.suggestedPrompts ?? []).map((item) => item.trim()).filter(Boolean).slice(0, 8);
  const minWidth = Math.max(300, dimension(options.minWidth, 340));
  const maxWidth = Math.max(minWidth, dimension(options.maxWidth, 720));
  const width = Math.min(maxWidth, Math.max(minWidth, dimension(options.width, 410)));
  return {
    transport: composition.transport,
    connectionKey: composition.connectionKey,
    labels: resolveLabels(options.labels),
    ...(agentProfileId ? { agentProfileId } : {}),
    agentName,
    logoUrl,
    welcomeImageUrl: options.welcomeImageUrl?.trim() || logoUrl,
    subtitle: compact(options.subtitle, "Trợ lý AI luôn sẵn sàng hỗ trợ"),
    badge: options.badge?.trim() ?? "",
    userName,
    welcomeTitle: typeof options.welcomeTitle === "function" ? options.welcomeTitle : compact(options.welcomeTitle, defaultWelcomeTitle),
    welcomeMessage: typeof options.welcomeMessage === "function" ? options.welcomeMessage : compact(options.welcomeMessage, "Tôi có thể giúp gì cho bạn?"),
    placeholder: compact(options.placeholder, "Hỏi tôi bất cứ điều gì..."),
    suggestedPrompts: prompts,
    storageKey: compact(options.storageKey, `agentic-chat:${composition.connectionKey}:${agentProfileId ?? agentName}`),
    persistSession: options.persistSession !== false,
    startOpen: options.startOpen === true,
    showLauncher: options.showLauncher !== false,
    position: options.position === "left" ? "left" : "right",
    mode: options.mode === "docked" ? "docked" : "floating",
    showModeToggle: options.showModeToggle === true,
    dockLayout: options.dockLayout === "overlay" ? "overlay" : "push",
    ...(Number.isFinite(options.dockedZIndex) ? { dockedZIndex: Math.round(options.dockedZIndex as number) } : {}),
    persistMode: options.persistMode !== false,
    dockedEdgeInset: Math.min(160, Math.max(0, Math.round(Number(options.dockedEdgeInset) || 0))),
    dockedPageMinWidth: Math.max(0, Math.round(Number(options.dockedPageMinWidth) || 0)),
    dockedCovers: selectorList(options.dockedCovers),
    dockedMoves: selectorList(options.dockedMoves),
    width,
    minWidth,
    maxWidth,
    resizable: options.resizable !== false,
    persistSize: options.persistSize !== false,
    draggableLauncher: options.draggableLauncher !== false,
    persistLauncherPosition: options.persistLauncherPosition !== false,
    attachments: options.attachments !== false,
    attachmentAccept: options.attachmentAccept?.trim() || "image/*,.pdf,.doc,.docx,.xls,.xlsx,.xlsm,.csv,.txt",
    maxAttachments: Math.min(10, Math.max(1, dimension(options.maxAttachments, 5))),
    maxAttachmentBytes: Math.min(25 * 1024 * 1024, Math.max(64 * 1024, dimension(options.maxAttachmentBytes, 10 * 1024 * 1024))),
    attachmentShortcuts: options.attachmentShortcuts !== false,
  };
}

/** The host's CSS selectors for its own controls (dockedCovers, dockedMoves): strings only, a bounded few. */
function selectorList(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((selector): selector is string => typeof selector === "string" && selector.trim().length > 0 && selector.length <= 200).slice(0, 20)
    : [];
}
