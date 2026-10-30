import type { JsonValue } from "@0xsyncroot/contracts";

export function objectArguments(value: JsonValue): Record<string, JsonValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Arguments must be an object");
  return value;
}

export function stringArgument(args: Record<string, JsonValue>, name: string, maxLength = 4_000): string {
  const value = args[name];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string`);
  if (value.length > maxLength) throw new Error(`${name} exceeds ${maxLength} characters`);
  return value;
}

export function integerArgument(args: Record<string, JsonValue>, name: string, fallback: number, min: number, max: number): number {
  const value = args[name] ?? fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}
