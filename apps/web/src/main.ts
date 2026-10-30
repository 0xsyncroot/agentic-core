import { createBlankRuntime } from "@0xsyncroot/harness";
import { HmacIdentityResolver, StaticDevelopmentIdentityResolver } from "@0xsyncroot/agent-api";
import { createWebApplication } from "./web-application.js";

/**
 * A config that can spawn a process is a remote-code-execution surface (see
 * `packages/adapter-mcp/src/shared.ts`'s `validateCommandAllowlist`), so this is validated
 * fail-closed: absolute paths only, no shell metacharacters, empty or unset means no stdio
 * connector may start at all. Comma-separated to match every other list in this file
 * (`AGENTIC_WEB_ALLOWED_ORIGINS`).
 *
 * This is a development/demo affordance, not a production-grade control: `apps/web` is a generic
 * harness that does not know in advance which stdio command a given deployment will point it at,
 * so it has to accept the allowlist from its environment. A real product backend does not have
 * that excuse — it knows exactly which binary its own container image ships, and hard-codes its
 * allowlist instead of trusting the environment to name it (see `EXAMPLE_STDIO_COMMAND_ALLOWLIST` in
 * `products/example/backend/src/composition/create-example-runtime.ts` for the pattern a deployable
 * product should follow).
 */
function stdioCommandAllowlist(value: string | undefined): readonly string[] | undefined {
  const commands = (value ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
  for (const command of commands) {
    if (!command.startsWith("/") || /[\s;&|`$(){}<>"'\\]/u.test(command)) {
      throw new Error(`AGENTIC_MCP_STDIO_ALLOWLIST entries must be absolute paths with no shell metacharacters: ${command}`);
    }
  }
  return commands.length > 0 ? Object.freeze(commands) : undefined;
}

const mcpStdioCommandAllowlist = stdioCommandAllowlist(process.env.AGENTIC_MCP_STDIO_ALLOWLIST);
const host = process.env.AGENTIC_WEB_HOST?.trim() || "127.0.0.1";
const port = Number(process.env.AGENTIC_WEB_PORT ?? "3400");
const allowedOrigins = (process.env.AGENTIC_WEB_ALLOWED_ORIGINS ?? "").split(",").map((value) => value.trim()).filter(Boolean);
const allowCredentials = process.env.AGENTIC_WEB_ALLOW_CREDENTIALS === "true";
const authSecret = process.env.AGENTIC_WEB_AUTH_SECRET?.trim();
const unsafeLocalIdentity = process.env.AGENTIC_WEB_UNSAFE_LOCAL_IDENTITY === "true";
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("AGENTIC_WEB_PORT must be an integer from 1 to 65535");
const remote = host !== "127.0.0.1" && host !== "localhost" && host !== "::1";
if (remote && process.env.AGENTIC_WEB_ALLOW_REMOTE !== "true") throw new Error("Remote web binding requires AGENTIC_WEB_ALLOW_REMOTE=true");
if (remote && process.env.AGENTIC_WEB_BEHIND_TLS_PROXY !== "true") throw new Error("Remote web binding requires explicit TLS proxy termination");
if (!authSecret && !unsafeLocalIdentity) {
  throw new Error("Configure AGENTIC_WEB_AUTH_SECRET or explicitly enable AGENTIC_WEB_UNSAFE_LOCAL_IDENTITY=true for a loopback development demo");
}
if (remote && !authSecret) throw new Error("Remote web listeners require AGENTIC_WEB_AUTH_SECRET");

const runtime = await createBlankRuntime(process.env, {
  ...(mcpStdioCommandAllowlist ? { mcpStdioCommandAllowlist } : {}),
});
if (runtime.config.profile === "production" && !authSecret) {
  await runtime.close();
  throw new Error("Production web profiles require AGENTIC_WEB_AUTH_SECRET");
}
const identityResolver = authSecret
  ? new HmacIdentityResolver(authSecret, process.env.AGENTIC_WEB_AUTH_ISSUER?.trim() || "agentic-control-plane", process.env.AGENTIC_WEB_AUTH_AUDIENCE?.trim() || "agentic-web")
  : new StaticDevelopmentIdentityResolver("local-dev", "local-user", [runtime.agentProfile?.id ?? "default"]);
const server = createWebApplication(
  { ...runtime, identityResolver },
  {
    allowedOrigins, allowCredentials, deploymentProfile: runtime.config.profile,
    // This dev/demo harness carries no product's own business-language error copy (unlike a
    // product backend such as EXAMPLE, which supplies `businessMessages` and leaves this false), so
    // its only way to be useful when something goes wrong is the runtime's own technical message.
    // `@0xsyncroot/agent-api` defaults this to false — safe for a product, but it silently dropped error
    // detail here when this package was extracted from what used to be this file's own inline
    // handler, which always included it.
    includeErrorDetail: runtime.config.profile !== "production",
  },
);
let stopping = false;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.error(`Received ${signal}; shutting down web harness`);
  server.closeIdleConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await runtime.close();
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

server.listen(port, host, () => {
  console.log(`Agentic Web running at http://${host}:${port}`);
  console.log(JSON.stringify({ model: runtime.model, storage: runtime.storage }));
});
