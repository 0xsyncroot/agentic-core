import type { IncomingMessage } from "node:http";
import { AgenticError } from "@0xsyncroot/contracts";

const MAX_BODY_BYTES = 64 * 1024;

export async function readJsonBody<T>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += value.length;
    if (size > MAX_BODY_BYTES) throw new AgenticError("validation", "Request body exceeds 64 KiB");
    chunks.push(value);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T; }
  catch { throw new AgenticError("validation", "Request body must be valid JSON"); }
}
