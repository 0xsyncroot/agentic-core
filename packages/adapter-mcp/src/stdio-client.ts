import type { JsonValue } from "@0xsyncroot/contracts";
import { Client, isInputRequiredResult } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type { McpClientPort, McpRemoteResource, McpRemoteTool, McpResourceContent } from "./types.js";
import { McpToolRefusal } from "./shared.js";

export interface McpStdioProcessConfig {
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd: string;
  /** Already allowlist-filtered by the caller: only the names the config explicitly listed. */
  readonly env: Readonly<Record<string, string>>;
  readonly maxBufferSize?: number;
}

export interface McpStdioClient extends McpClientPort {
  readonly pid: number | null;
}

/**
 * Builds one stdio MCP client. The SDK's `StdioClientTransport` always spawns with `shell: false`
 * and an argv array (never a shell string) — verified against its own source, not assumed — so the
 * only injection surface left is `command`/`args`/`env` themselves, which is the caller's job to
 * keep to an explicit allowlist and an explicit environment (see stdio-plugin.ts).
 */
export function createStdioClientFactory(
  process: McpStdioProcessConfig,
  elicitationEnabled: boolean,
  onStderr: (chunk: Buffer) => void,
  onUnexpectedClose: () => void,
): () => Promise<McpStdioClient> {
  return async () => {
    const client = new Client({ name: "agentic-core", version: "0.1.0" }, {
      capabilities: { ...(elicitationEnabled ? { elicitation: { form: {}, url: {} } } : {}) },
      // Pinned to the modern revision rather than http-client.ts's "auto": stdio connectors are a
      // platform-owned, first-party child process, never an unknown third-party server, so there is
      // nothing to conservatively fall back from — "legacy" mode's plain 2025 handshake rejects a
      // modern initialize outright, which MRTR (the durable interaction path) needs. Failing hard
      // against a legacy-only server is the right trade here, not a shortcoming: a local subprocess
      // this platform builds and deploys has no excuse to be legacy, and "auto"'s silent fallback
      // would hide that misconfiguration instead of surfacing it.
      //
      // Both "auto" and pinned modes still spawn the command TWICE for stdio: `_connectNegotiated`
      // in the SDK's index.mjs sends `server/discover` on a disposable sibling process (own PID, own
      // pipes, `stderr: "ignore"`) built from the same command/args, kills it, then starts the real,
      // persistent session as a second process — confirmed by reading that source directly and by a
      // one-off process-count test (two distinct PIDs per connect). The sibling never touches this
      // factory's `transport`/`onStderr`/`onUnexpectedClose` hooks (attached only to the session
      // transport below, before connect()), and its own stderr is discarded by the SDK — verified
      // empirically too: zero stderr callbacks and zero unexpected-close callbacks fire during the
      // sibling's spawn/probe/kill. So the restart budget and stderr ring buffer in
      // stdio-process-manager.ts never see it; there is nothing there to correct for.
      versionNegotiation: { mode: { pin: "2026-07-28" } },
      inputRequired: { autoFulfill: false },
    });
    if (elicitationEnabled) client.setRequestHandler("elicitation/create", async () => ({ action: "cancel" }));
    const transport = new StdioClientTransport({
      command: process.command,
      ...(process.args ? { args: [...process.args] } : {}),
      cwd: process.cwd,
      // Always passed explicitly, never omitted: the SDK's spawn call is
      // `env: { ...getDefaultEnvironment(), ...this._serverParams.env }` (verified in stdio.mjs) —
      // that baseline is merged in unconditionally, whether `env` is supplied or not, so there is no
      // "fall back to inherited env" case to avoid by omitting it; omitting it would just mean this
      // factory adds nothing on top. `getDefaultEnvironment()` itself is never called here — its
      // `DEFAULT_INHERITED_ENV_VARS` are HOME/LOGNAME/PATH/SHELL/TERM/USER on POSIX (the Windows list
      // is APPDATA/HOMEDRIVE/HOMEPATH/LOCALAPPDATA/PATH/PROCESSOR_ARCHITECTURE/SYSTEMDRIVE/
      // SYSTEMROOT/TEMP/USERNAME/USERPROFILE/PROGRAMFILES), a small, fixed, non-secret set the SDK
      // itself decides is safe to inherit and that this adapter has no way to suppress. `process.env`
      // here is the caller's own already-allowlist-filtered object (shared.ts's `filterEnv`, built
      // from `envPassthrough` alone) — nothing beyond that fixed baseline plus the explicitly
      // allowlisted names ever reaches the child.
      env: { ...process.env },
      // "pipe", not the default "inherit": a child's stderr must reach this factory's `onStderr`
      // hook (into the bounded ring buffer `health()` reports), never the product's own stderr.
      stderr: "pipe",
      // Binary images have their own bounds (16 MiB total); base64 adds one third on the wire.
      maxBufferSize: process.maxBufferSize ?? 24 * 1024 * 1024,
    });
    // Attached before connect(): Client.connect() chains, rather than replaces, whatever handlers
    // are already on the transport (verified in its Protocol.connect implementation), so this still
    // fires alongside the SDK's own bookkeeping.
    let closedExplicitly = false;
    transport.stderr?.on("data", (chunk: Buffer) => onStderr(chunk));
    transport.onclose = () => { if (!closedExplicitly) onUnexpectedClose(); };
    await client.connect(transport);
    const resourcesSupported = client.getServerCapabilities()?.resources !== undefined;
    return {
      pid: transport.pid,
      listTools: async (cursor) => {
        const page = await client.listTools({ ...(cursor ? { cursor } : {}) });
        return { tools: page.tools as McpRemoteTool[], ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
      },
      ...(resourcesSupported ? {
        listResources: async (cursor?: string) => {
          const page = await client.listResources({ ...(cursor ? { cursor } : {}) });
          return { resources: page.resources as McpRemoteResource[], ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
        },
        readResource: async (uri: string) => {
          const result = await client.readResource({ uri });
          return { contents: result.contents as McpResourceContent[] };
        },
      } : {}),
      callTool: async (name, argumentsValue, signal, continuation) => {
        const params = {
          name, arguments: argumentsValue as Record<string, unknown>,
          ...(continuation ? { inputResponses: continuation.inputResponses, ...(continuation.requestState !== undefined ? { requestState: continuation.requestState } : {}) } : {}),
        };
        const result = await client.callTool(params as Parameters<Client["callTool"]>[0], { signal, allowInputRequired: elicitationEnabled });
        if (isInputRequiredResult(result)) return {
          kind: "input-required" as const,
          inputRequests: result.inputRequests as Record<string, JsonValue>,
          ...(result.requestState !== undefined ? { requestState: result.requestState } : {}),
        };
        if (result.isError) throw new McpToolRefusal(name, result);
        return { kind: "completed" as const, result: result as unknown as JsonValue };
      },
      close: async () => { closedExplicitly = true; await client.close(); },
    };
  };
}
