/** Operator-only diagnostics for exceptions that would otherwise become a generic SSE error. */
export function diagnosticError(error: unknown, key: { readonly sessionId: string; readonly requestId: string },
  env: NodeJS.ProcessEnv = process.env): Record<string, unknown> {
  const secrets = Object.entries(env).filter(([name, value]) => value && value.length >= 8 && /TOKEN|PASSWORD|SECRET|(?:ACCESS|API|ENCRYPTION)_KEY|DATABASE_URL/u.test(name)).map(([, value]) => value!);
  const clean = (text: string, limit: number): string => {
    for (const secret of secrets) text = text.replaceAll(secret, "[redacted]");
    return text.replace(/Bearer\s+[^\s"']+/giu, "Bearer [redacted]")
      .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/giu, "$1[redacted]@")
      .replace(/(https?:\/\/[^\s?"']+)\?[^\s"']+/giu, "$1?[redacted]").slice(0, limit);
  };
  const seen = new Set<unknown>();
  let remaining = 20;
  const describe = (value: unknown, depth: number): Record<string, unknown> => {
    if (remaining-- <= 0) return { message: "[error limit reached]" };
    if (!(value instanceof Error)) return { type: typeof value, message: clean(String(value), 2000) };
    if (seen.has(value) || depth > 3) return { type: value.name, message: "[cause omitted]" };
    seen.add(value);
    const code = (value as Error & { code?: unknown }).code;
    return { type: value.name, message: clean(value.message, 2000),
      ...(typeof code === "string" || typeof code === "number" ? { code: clean(String(code), 100) } : {}),
      stack: clean((value.stack ?? "").split("\n").filter(line => /^\s+at /u.test(line)).slice(0, 16).join("\n"), 4000),
      ...(value instanceof AggregateError ? {
        errors: value.errors.slice(0, 8).map((entry: unknown) => describe(entry, depth + 1)),
        ...(value.errors.length > 8 ? { omittedErrors: value.errors.length - 8 } : {}),
      } : {}),
      ...(value.cause !== undefined ? { cause: describe(value.cause, depth + 1) } : {}) };
  };
  return { time: new Date().toISOString(), event: "diagnostic.failed", sessionId: key.sessionId,
    requestId: key.requestId, error: describe(error, 0) };
}
