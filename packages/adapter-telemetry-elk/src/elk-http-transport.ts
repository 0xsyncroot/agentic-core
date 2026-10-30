import { AgenticError } from "@0xsyncroot/contracts";
import { elkAuthorizationHeader, type ElkConfig } from "./elk-config.js";
import type { ElkTransport } from "./elk-telemetry-sink.js";

export interface ElkHttpTransportOptions {
  readonly config: ElkConfig;
  /** Supplied by the composition root: an adapter never reads the process environment itself. */
  readonly env: NodeJS.ProcessEnv;
  readonly fetch?: typeof globalThis.fetch;
}

/**
 * Posts batches to Elasticsearch, or to Logstash or a collector in front of it.
 *
 * One request per batch in both modes. The difference is only framing, and the receiver's
 * authentication differs with it: Elasticsearch takes an API key, while Logstash's `http`
 * input speaks Basic auth and nothing else — so `auth.kind: api-key` against Logstash is
 * rejected at the door, which is worth knowing before a pipeline is declared broken.
 */
export class ElkHttpTransport implements ElkTransport {
  readonly #fetch: typeof globalThis.fetch;
  readonly #authorization: string | undefined;

  constructor(private readonly options: ElkHttpTransportOptions) {
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#authorization = elkAuthorizationHeader(options.config, options.env);
  }

  async send(documents: readonly Readonly<Record<string, unknown>>[]): Promise<void> {
    if (documents.length === 0) return;
    const config = this.options.config;
    // Both modes are newline-delimited; only `bulk` carries the per-document action line that
    // tells Elasticsearch where to write. A receiver in front of Elasticsearch decides the
    // index itself, so the index travels as an ordinary field there instead.
    const body = documents.map((document) => config.mode === "bulk"
      ? `${JSON.stringify({ create: { _index: config.dataStream } })}\n${JSON.stringify(document)}`
      : JSON.stringify({ ...document, "data_stream.dataset": config.dataStream })).join("\n") + "\n";
    const response = await this.#fetch(config.endpoint, {
      method: "POST",
      signal: AbortSignal.timeout(config.timeoutMs),
      redirect: "error",
      headers: {
        // Deliberately not `application/json`: Logstash's http input maps that content type to
        // its single-document `json` codec, which would swallow a whole batch as one event.
        "content-type": "application/x-ndjson",
        accept: "application/json",
        ...(this.#authorization ? { authorization: this.#authorization } : {}),
      },
      body,
    });
    if (!response.ok) {
      // The body may carry credentials-adjacent detail from a misconfigured proxy, so only the
      // status reaches the service log.
      throw new AgenticError("transient", `ELK rejected a telemetry batch with HTTP ${response.status}`, true);
    }
    // A bulk request answers 200 even when individual documents failed; reading the flag is the
    // difference between "shipped" and "the index quietly refused every document".
    if (config.mode !== "bulk") { void response.body?.cancel(); return; }
    const outcome = await response.json().catch(() => undefined) as { errors?: unknown } | undefined;
    if (outcome?.errors === true) throw new AgenticError("transient", "ELK bulk response reported document errors", true);
  }

  async close(): Promise<void> { /* fetch holds no connection this adapter owns. */ }
}
