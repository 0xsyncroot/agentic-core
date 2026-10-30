import type { IncomingMessage, ServerResponse } from "node:http";
import type { Socket } from "node:net";

interface ParserError extends Error {
  readonly code?: string;
  readonly reason?: string;
  readonly bytesParsed?: number;
  readonly rawPacket?: unknown;
}

const PARSER_STATUS: Readonly<Record<string, string>> = Object.freeze({
  HPE_HEADER_OVERFLOW: "431 Request Header Fields Too Large",
  ERR_HTTP_REQUEST_TIMEOUT: "408 Request Timeout",
});

/**
 * Fastify's own `clientErrorHandler` option (Node's raw `http.Server` `'clientError'` event —
 * Fastify does not abstract this away, since it fires before any `FastifyRequest`/`FastifyReply`
 * exists) answers a malformed request with a generic response and moves on. That is wrong on one
 * specific, easy-to-miss race: a parser error can arrive on a socket **while the previous, valid
 * request on that same socket is still awaiting its handler** — a client pipelining a bad request
 * right behind a good one, or a proxy coalescing writes. Naively destroying the socket then also
 * drops the response the earlier, valid request is owed. This tracks the in-flight response per
 * socket (via `onResponse`/`onRequest` hooks a consumer wires in `trackResponse`) so a client
 * error only ever closes the connection *after* what was already promised finishes.
 */
export function createFastifyClientErrorHandler(logPrefix: string) {
  const responses = new WeakMap<Socket, ServerResponse>();
  const rejected = new WeakSet<Socket>();

  function trackResponse(request: IncomingMessage, response: ServerResponse): void {
    const socket = request.socket;
    responses.set(socket, response);
    response.once("close", () => {
      if (responses.get(socket) === response) responses.delete(socket);
    });
  }

  function handle(error: ParserError, socket: Socket): void {
    if (rejected.has(socket)) return;
    rejected.add(socket);
    const code = error.code ?? "unknown";
    if (code === "ECONNRESET" || code === "EPIPE" || socket.destroyed || !socket.writable) {
      socket.destroy();
      return;
    }
    // A tail after `Connection: close` is the client's slip, not a malformed request worth a line.
    if (code !== "HPE_CLOSED_CONNECTION") {
      const packet = Buffer.isBuffer(error.rawPacket) ? error.rawPacket : undefined;
      console.warn(`${logPrefix} HTTP parser rejected a request:`, JSON.stringify({
        code, reason: error.reason ?? error.message, bytesParsed: error.bytesParsed,
        packetBytes: packet?.length,
        startsWithMethod: /^[A-Z]{3,7} \//u.test(packet?.subarray(0, 16).toString("latin1") ?? ""),
      }));
    }
    const response = responses.get(socket);
    if (response && !response.writableFinished) {
      // The refused bytes are inside the request being answered: it can never complete.
      if (!response.req.complete) { socket.destroy(); return; }
      // The parser has the whole preceding request; only what followed it was refused. Stop
      // reading, let that response (JSON or SSE) finish, then close — destroying the socket, or
      // writing a status line into it here, would cost that client a result it was owed.
      socket.pause();
      response.shouldKeepAlive = false;
      if (!response.headersSent) response.setHeader("connection", "close");
      response.once("finish", () => socket.end());
      return;
    }
    if (code === "HPE_CLOSED_CONNECTION") { socket.end(); return; }
    const status = PARSER_STATUS[code] ?? "400 Bad Request";
    socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  }

  return { handle, trackResponse };
}
