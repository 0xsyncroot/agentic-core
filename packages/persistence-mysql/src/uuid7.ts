import { randomBytes } from "node:crypto";

let lastMs = 0;
let sequence = 0;

/**
 * A UUIDv7 (RFC 9562): 48 bits of Unix milliseconds, then a 12-bit counter that orders ids made in the same millisecond by
 * this process, then random bits. Insert-only rows keyed by it land at the end of their index and sort by creation.
 */
export function uuid7(): string {
  let now = Date.now();
  if (now <= lastMs) {
    sequence += 1;
    if (sequence > 0xfff) { lastMs += 1; sequence = 0; }
    now = lastMs;
  } else {
    lastMs = now;
    sequence = randomBytes(2).readUInt16BE(0) & 0x7ff;
  }
  const bytes = randomBytes(16);
  bytes.writeUIntBE(now, 0, 6);
  bytes[6] = 0x70 | (sequence >> 8);
  bytes[7] = sequence & 0xff;
  bytes[8] = 0x80 | (bytes[8]! & 0x3f);
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
