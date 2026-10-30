import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { PersistenceSelection } from "@0xsyncroot/harness";
import {
  applyResponseHeaders,
  createAgentApiHandler,
  createOriginPolicyResolver,
  type AgentApiOptions,
  type AgentApiRuntime,
  type ResponsePolicy,
} from "@0xsyncroot/agent-api";

export { InMemoryResumableAgentStreamRegistry } from "@0xsyncroot/agent-api";
export type { ResumableAgentStreamRegistry } from "@0xsyncroot/agent-api";

/** apps/web adds no options of its own beyond what the shared delivery package already exposes. */
export type WebApplicationOptions = AgentApiOptions;

const PUBLIC_ROOT = new URL("../public/", import.meta.url);
const WIDGET_ROOT = new URL("../../widget/", import.meta.url);

/** The API surface plus the dev-harness's own descriptive fields (startup logging in main.ts). */
export interface WebRuntime extends AgentApiRuntime {
  readonly model: { readonly providerId: string; readonly modelId: string; readonly features: { readonly textStreaming: boolean; readonly privateReasoning: boolean } };
  readonly storage: PersistenceSelection;
  readonly knowledgeDocuments: number;
  readonly availableTools: readonly { readonly id: string; readonly description: string }[];
  readonly host: { readonly snapshot: { readonly id: string } };
}

const STATIC_FILES = new Map([
  ["/", { root: PUBLIC_ROOT, file: "index.html", type: "text/html; charset=utf-8" }],
  ["/app.js", { root: PUBLIC_ROOT, file: "app.js", type: "text/javascript; charset=utf-8" }],
  ["/styles.css", { root: PUBLIC_ROOT, file: "styles.css", type: "text/css; charset=utf-8" }],
  ["/widget-demo/", { root: WIDGET_ROOT, file: "demo.html", type: "text/html; charset=utf-8" }],
  ["/widget-demo/demo.css", { root: WIDGET_ROOT, file: "demo.css", type: "text/css; charset=utf-8" }],
  ["/widget-demo/demo.js", { root: WIDGET_ROOT, file: "demo.js", type: "text/javascript; charset=utf-8" }],
  ["/widget-demo/dist/agentic-chat-widget.js", { root: WIDGET_ROOT, file: "dist/agentic-chat-widget.js", type: "text/javascript; charset=utf-8" }],
]);

async function staticFile(pathname: string, response: import("node:http").ServerResponse, policy: ResponsePolicy): Promise<boolean> {
  const target = STATIC_FILES.get(pathname);
  if (!target) return false;
  const content = await readFile(new URL(target.file, target.root));
  applyResponseHeaders(response, policy);
  response.statusCode = 200;
  response.setHeader("content-type", target.type);
  response.setHeader("cache-control", "no-store");
  response.end(content);
  return true;
}

/**
 * The dev/demo delivery app: the shared `@0xsyncroot/agent-api` handler for everything under `/api/*`,
 * plus this app's own static UI (widget demo pages) and its 404/redirect fallback for anything
 * that isn't. A real product backend (e.g. EXAMPLE) uses `createAgentApiHandler` directly instead
 * of this wrapper, inside its own `http.createServer` and its own static/route surface, if any.
 */
export function createWebApplication(runtime: WebRuntime, options: WebApplicationOptions = {}): Server {
  const api = createAgentApiHandler(runtime, options);
  const resolveOriginPolicy = createOriginPolicyResolver(options);
  const server = createServer(async (request, response) => {
    const handled = await api.handle(request, response);
    if (handled) return;
    // `api.handle` guards its own path with a try/catch (see createAgentApiHandler, which also
    // parses request.url first and answers 400 itself on a bad one, before this code ever runs);
    // nothing here did until this was restored. A readFile failure on a static file that should
    // always exist (a broken install, a permissions error), a write after the client disconnected,
    // or a future change to this function that can throw would otherwise escape this async handler
    // with no response ever sent and no catch anywhere above it — Node's http server does not await it.
    try {
      const policy = resolveOriginPolicy(request);
      const url = new URL(request.url ?? "/", "http://localhost");
      if (request.method === "GET" && url.pathname === "/widget-demo") {
        applyResponseHeaders(response, policy);
        response.statusCode = 308;
        response.setHeader("location", `/widget-demo/${url.search}`);
        response.end();
        return;
      }
      if (request.method === "GET" && await staticFile(url.pathname, response, policy)) return;
      applyResponseHeaders(response, policy);
      response.statusCode = 404;
      response.setHeader("content-type", "application/json; charset=utf-8");
      response.end(JSON.stringify({ error: { code: "not-found", message: "Route not found" } }));
    } catch (error) {
      console.error("apps/web: unhandled error outside the /api surface", error);
      if (response.headersSent) { response.destroy(); return; }
      response.statusCode = 500;
      response.setHeader("content-type", "application/json; charset=utf-8");
      response.end(JSON.stringify({ error: { code: "internal", message: "A technical problem prevented this request from completing." } }));
    }
  });
  server.once("close", () => { void api.close(); });
  return server;
}
