import { createHash } from "node:crypto";
import { canonicalJson } from "@0xsyncroot/contracts";

export function sha256(value: unknown): string {
  return createHash("sha256").update(typeof value === "string" ? value : canonicalJson(value)).digest("hex");
}
