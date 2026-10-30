import { AgenticError, displayIdentityFrom, type JsonValue, type RunTurnInput, type TurnApplicationContext } from "@0xsyncroot/contracts";

class ImmutableSet<T> implements ReadonlySet<T> {
  readonly #values: Set<T>;
  readonly [Symbol.toStringTag] = "Set";

  constructor(values: Iterable<T>) { this.#values = new Set(values); }
  get size(): number { return this.#values.size; }
  has(value: T): boolean { return this.#values.has(value); }
  entries(): SetIterator<[T, T]> { return this.#values.entries(); }
  keys(): SetIterator<T> { return this.#values.keys(); }
  values(): SetIterator<T> { return this.#values.values(); }
  [Symbol.iterator](): SetIterator<T> { return this.#values[Symbol.iterator](); }
  forEach(callbackfn: (value: T, value2: T, set: ReadonlySet<T>) => void, thisArg?: unknown): void {
    this.#values.forEach((value) => callbackfn.call(thisArg, value, value, this));
  }
}

function requiredIdentifier(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) throw new AgenticError("validation", `${name} cannot be empty`);
  if (normalized.length > 256) throw new AgenticError("validation", `${name} exceeds 256 characters`);
  return normalized;
}

function freezeJson<T>(value: T, name: string): T {
  const pending: Array<{ readonly value: object; readonly depth: number }> = [];
  if (value && typeof value === "object") pending.push({ value, depth: 0 });
  let nodes = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    nodes += 1;
    if (current.depth > 16 || nodes > 512) {
      throw new AgenticError("validation", `${name} exceeds structural limits`);
    }
    for (const child of Object.values(current.value)) {
      if (child && typeof child === "object") pending.push({ value: child, depth: current.depth + 1 });
    }
    Object.freeze(current.value);
  }
  return value;
}

function jsonSnapshot(value: JsonValue, name: string, maxBytes: number): JsonValue {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error();
  } catch {
    throw new AgenticError("validation", `${name} must be JSON serializable`);
  }
  if (Buffer.byteLength(serialized, "utf8") > maxBytes) {
    throw new AgenticError("validation", `${name} exceeds ${maxBytes} bytes`);
  }
  return freezeJson(JSON.parse(serialized) as JsonValue, name);
}

function stringRecord(
  value: Readonly<Record<string, string>> | undefined,
  name: string,
): Readonly<Record<string, string>> | undefined {
  if (value === undefined) return undefined;
  const entries = Object.entries(value);
  if (entries.length > 64) throw new AgenticError("validation", `${name} supports at most 64 entries`);
  const result: Record<string, string> = {};
  for (const [key, entry] of entries) {
    const normalizedKey = requiredIdentifier(key, `${name} key`);
    if (normalizedKey.length > 128 || typeof entry !== "string" || entry.length > 2_048) {
      throw new AgenticError("validation", `${name} contains an invalid entry`);
    }
    result[normalizedKey] = entry;
  }
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > 16_384) {
    throw new AgenticError("validation", `${name} exceeds 16384 bytes`);
  }
  return Object.freeze(result);
}

function verifiedSubset(
  supplied: Readonly<Record<string, string>> | undefined,
  verified: Readonly<Record<string, string>> | undefined,
): boolean {
  if (supplied === undefined) return true;
  if (verified === undefined) return Object.keys(supplied).length === 0;
  return Object.entries(supplied).every(([key, value]) => verified[key] === value);
}

function applicationContext(
  value: TurnApplicationContext | undefined,
  trustedContext: Readonly<Record<string, string>> | undefined,
): TurnApplicationContext | undefined {
  const suppliedTrusted = stringRecord(value?.trusted, "applicationContext.trusted");
  if (!verifiedSubset(suppliedTrusted, trustedContext)) {
    throw new AgenticError("denied", "applicationContext.trusted must come from verified security evidence");
  }
  const effectiveTrusted = suppliedTrusted ?? trustedContext;
  const untrusted = value?.untrusted === undefined
    ? undefined
    : jsonSnapshot(value.untrusted, "applicationContext.untrusted", 32_768);
  if (effectiveTrusted === undefined && untrusted === undefined) return undefined;
  return Object.freeze({
    ...(effectiveTrusted !== undefined ? { trusted: effectiveTrusted } : {}),
    ...(untrusted !== undefined ? { untrusted } : {}),
  });
}

/** Validates and snapshots caller-owned mutable security data at the core boundary. */
export function snapshotRunTurnInput(input: RunTurnInput): RunTurnInput {
  if (!input.content.trim()) throw new AgenticError("validation", "Input content cannot be empty");
  const idempotencyKey = input.idempotencyKey === undefined
    ? undefined
    : requiredIdentifier(input.idempotencyKey, "idempotencyKey");
  const agentProfileId = input.agentProfileId === undefined
    ? undefined
    : requiredIdentifier(input.agentProfileId, "agentProfileId");
  const authorizedAgentProfiles = input.security.authorizedAgentProfiles?.map((profile) =>
    requiredIdentifier(profile, "authorizedAgentProfile"));
  const selectedProfile = agentProfileId ?? "default";
  if (!authorizedAgentProfiles && selectedProfile !== "default") {
    throw new AgenticError("denied", `Explicit agent profile requires trusted authorization: ${selectedProfile}`);
  }
  if (authorizedAgentProfiles && !authorizedAgentProfiles.includes(selectedProfile)) {
    throw new AgenticError("denied", `Agent profile is not authorized: ${selectedProfile}`);
  }
  const trustedContext = stringRecord(input.security.trustedContext, "trustedContext");
  const identity = displayIdentityFrom(input.security.identity);
  const safeApplicationContext = applicationContext(input.applicationContext, trustedContext);
  const permissions: string[] = [];
  for (const permission of input.security.permissions) {
    if (typeof permission !== "string" || !permission.trim()) {
      throw new AgenticError("validation", "Security permissions must be non-empty strings");
    }
    permissions.push(permission);
  }
  return {
    ...input,
    sessionId: requiredIdentifier(input.sessionId, "sessionId"),
    ...(idempotencyKey ? { idempotencyKey } : {}),
    ...(agentProfileId ? { agentProfileId } : {}),
    ...(safeApplicationContext ? { applicationContext: safeApplicationContext } : {}),
    security: Object.freeze({
      tenantId: requiredIdentifier(input.security.tenantId, "tenantId"),
      actorId: requiredIdentifier(input.security.actorId, "actorId"),
      correlationId: requiredIdentifier(input.security.correlationId, "correlationId"),
      purpose: requiredIdentifier(input.security.purpose, "purpose"),
      permissions: Object.freeze(new ImmutableSet(permissions)),
      ...(input.security.authentication ? { authentication: Object.freeze({
        issuer: requiredIdentifier(input.security.authentication.issuer, "authentication.issuer"),
        subject: requiredIdentifier(input.security.authentication.subject, "authentication.subject"),
        assurance: input.security.authentication.assurance,
      }) } : {}),
      ...(input.security.roles ? { roles: Object.freeze(input.security.roles.map((role) => requiredIdentifier(role, "role"))) } : {}),
      ...(input.security.grantRevision ? { grantRevision: requiredIdentifier(input.security.grantRevision, "grantRevision") } : {}),
      ...(authorizedAgentProfiles ? { authorizedAgentProfiles: Object.freeze([...new Set(authorizedAgentProfiles)]) } : {}),
      ...(trustedContext ? { trustedContext } : {}),
      ...(identity ? { identity } : {}),
    }),
  };
}
