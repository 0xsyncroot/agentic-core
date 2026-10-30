import { createHmac, randomUUID } from "node:crypto";
import {
  AgenticError,
  TOOL_EXECUTION_RESPONSE_PROTOCOL,
  type JsonValue,
  type ToolExecutionBroker,
  type ToolExecutionResponse,
  type ToolHandlerResult,
} from "@0xsyncroot/contracts";

const MAX_RESPONSE_BYTES = 1024 * 1024;

export interface SignedHttpToolExecutionBrokerOptions {
  readonly baseUrl: string;
  readonly secret: string;
  readonly allowInsecureLoopback?: boolean;
  readonly fetchImplementation?: typeof fetch;
}

function loopback(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1" || hostname === "[::1]";
}

function payload(command: Parameters<ToolExecutionBroker["dispatch"]>[0]): string {
  const security = command.invocation.security;
  return JSON.stringify({
    tool: { id: command.definition.id, version: command.definition.version },
    invocation: {
      callId: command.invocation.callId, sessionId: command.invocation.sessionId,
      turnId: command.invocation.turnId, stepId: command.invocation.stepId,
        arguments: command.invocation.arguments, idempotencyKey: command.invocation.idempotencyKey,
        ...(command.invocation.interaction ? { interaction: command.invocation.interaction } : {}),
      security: {
        tenantId: security.tenantId, actorId: security.actorId,
        permissions: [...security.permissions].sort(), correlationId: security.correlationId,
        purpose: security.purpose, roles: security.roles ?? [], grantRevision: security.grantRevision ?? "unspecified",
      },
    },
  });
}

/** Signed RPC adapter for a separately sandboxed first-party tool worker. */
export class SignedHttpToolExecutionBroker implements ToolExecutionBroker {
  readonly #url: URL;
  readonly #secret: Buffer;
  readonly #fetch: typeof fetch;

  constructor(options: SignedHttpToolExecutionBrokerOptions) {
    this.#url = new URL("v1/tools/dispatch", options.baseUrl.endsWith("/") ? options.baseUrl : `${options.baseUrl}/`);
    this.#secret = Buffer.from(options.secret, "utf8");
    this.#fetch = options.fetchImplementation ?? fetch;
    if (this.#secret.length < 32) throw new Error("Tool broker secret must contain at least 32 bytes");
    if (this.#url.protocol !== "https:" && !(options.allowInsecureLoopback && this.#url.protocol === "http:" && loopback(this.#url.hostname))) {
      throw new Error("Tool broker requires HTTPS (HTTP is allowed only for an explicit loopback development profile)");
    }
  }

  async dispatch(command: Parameters<ToolExecutionBroker["dispatch"]>[0], signal: AbortSignal): Promise<ToolHandlerResult> {
    const body = payload(command);
    const timestamp = Date.now().toString();
    const nonce = randomUUID();
    const signature = createHmac("sha256", this.#secret).update(`${timestamp}.${nonce}.${body}`).digest("base64url");
    let response: Response;
    try {
      response = await this.#fetch(this.#url, {
        method: "POST", signal, body,
        headers: {
          "content-type": "application/json", "x-gateway-timestamp": timestamp,
          "x-gateway-nonce": nonce, "x-gateway-signature": signature,
          "x-gateway-idempotency-key": command.invocation.idempotencyKey,
        },
      });
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      throw new AgenticError("transient", `Tool broker transport failed: ${error instanceof Error ? error.message : "unknown error"}`);
    }
    const declaredLength = Number(response.headers.get("content-length") ?? 0);
    if (declaredLength > MAX_RESPONSE_BYTES) throw new AgenticError("budget-exceeded", "Tool broker response exceeds 1 MiB");
    const text = await response.text();
    if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) throw new AgenticError("budget-exceeded", "Tool broker response exceeds 1 MiB");
    if (!response.ok) {
      const code = response.status === 401 || response.status === 403 ? "denied" : response.status >= 500 ? "transient" : "permanent";
      throw new AgenticError(code, `Tool broker rejected ${command.definition.id} with HTTP ${response.status}`);
    }
    try {
      const envelope = JSON.parse(text) as { result?: JsonValue; outcome?: ToolExecutionResponse };
      if (envelope.outcome?.protocol === TOOL_EXECUTION_RESPONSE_PROTOCOL &&
          (envelope.outcome.kind === "completed" || envelope.outcome.kind === "interaction-required")) {
        return envelope.outcome;
      }
      if (!("result" in envelope)) throw new Error();
      return envelope.result as JsonValue;
    } catch {
      throw new AgenticError("permanent", "Tool broker returned an invalid result envelope");
    }
  }
}
