import { createHash } from "node:crypto";
import { canonicalJson } from "@0xsyncroot/contracts";

export function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function sha1(value: string): string {
  return createHash("sha1").update(value).digest("hex");
}
