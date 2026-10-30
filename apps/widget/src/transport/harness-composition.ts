/** @internal */
function createAgentChatComposition(options: AgentChatOptions): AgentChatComposition {
  if (!options) throw new TypeError("AgentChat options are required");
  if (options.transport) {
    if (options.connection || options.apiBaseUrl?.trim()) throw new TypeError("transport cannot be combined with connection or apiBaseUrl");
    return { transport: options.transport, connectionKey: `custom:${options.agentProfileId ?? options.agent?.id ?? options.agentName ?? "agent"}` };
  }

  const legacyBase = options.apiBaseUrl?.trim();
  if (!options.connection && !legacyBase) throw new TypeError("AgentChat requires connection.baseUrl, apiBaseUrl, or transport");
  if (options.connection && legacyBase) {
    const connectionUrl = new URL(String(options.connection.baseUrl), document.baseURI).href.replace(/\/$/, "");
    const legacyUrl = new URL(legacyBase, document.baseURI).href.replace(/\/$/, "");
    if (connectionUrl !== legacyUrl) throw new TypeError("connection.baseUrl and apiBaseUrl must identify the same harness when both are provided");
  }
  const source: AgentChatConnectionOptions = options.connection ?? { baseUrl: legacyBase! };
  const legacyHeaders = options.requestHeaders;
  const headers = mergeHarnessHeaders(legacyHeaders, source.headers);
  const connection: AgentChatConnectionOptions = {
    ...source,
    ...(headers === undefined ? {} : { headers }),
    credentials: source.credentials ?? options.credentials ?? "omit",
  };
  const transport = new HarnessHttpTransport(connection);
  return { transport, connectionKey: transport.baseUrl };
}

/** @internal */
function mergeHarnessHeaders(legacy: Readonly<Record<string, string>> | undefined, current: AgentChatHeaderProvider | undefined): AgentChatHeaderProvider | undefined {
  if (!legacy || Object.keys(legacy).length === 0) return current;
  if (!current) return legacy;
  return async (context) => {
    const resolved = typeof current === "function" ? await current(context) : current;
    const headers = new Headers(legacy);
    new Headers(resolved).forEach((value, key) => headers.set(key, value));
    return headers;
  };
}
