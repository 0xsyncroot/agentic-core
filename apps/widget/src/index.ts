/// <reference path="./public-api.ts" />
/// <reference path="./ui/assets.ts" />
/// <reference path="./shared/content.ts" />
/// <reference path="./core/labels.ts" />
/// <reference path="./core/settings.ts" />
/// <reference path="./ui/interaction-field.ts" />
/// <reference path="./ui/interaction-card.ts" />
/// <reference path="./core/plan-marks.ts" />
/// <reference path="./core/widget.ts" />
/// <reference path="./core/context-resolver.ts" />
/// <reference path="./transport/contracts.ts" />
/// <reference path="./transport/sse-decoder.ts" />
/// <reference path="./transport/harness-http-transport.ts" />

/** @internal Composition root. */
const globalApi: AgentChatGlobalApi = Object.freeze({
  version: WIDGET_VERSION,
  create: (options: AgentChatOptions) => new EmbeddedAgentChat(options, createAgentChatComposition(options)),
  init: (options: AgentChatOptions) => new EmbeddedAgentChat(options, createAgentChatComposition(options)),
  createHarnessTransport: (options: AgentChatConnectionOptions) => new HarnessHttpTransport(options),
});

Object.defineProperty(globalThis, "AgentChat", {
  configurable: true,
  enumerable: true,
  value: globalApi,
  writable: false,
});
