import type { JsonValue } from "@0xsyncroot/contracts";
export function toJsonValue(value: unknown): JsonValue { return JSON.parse(JSON.stringify(value)) as JsonValue; }
