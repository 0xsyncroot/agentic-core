import { AgenticError, type JsonValue, type SessionEvent, type TurnApplicationContext } from "@0xsyncroot/contracts";

function freezeJson<T>(value: T): T {
  const pending: object[] = [];
  if (value && typeof value === "object") pending.push(value);
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const child of Object.values(current)) if (child && typeof child === "object") pending.push(child);
    Object.freeze(current);
  }
  return value;
}

/** Rehydrates only the context durably bound to the originating turn. */
export function applicationContextForTurn(
  events: readonly SessionEvent[],
  turnId: string | undefined,
): TurnApplicationContext | undefined {
  if (!turnId) return undefined;
  const event = events.find((candidate) => candidate.turnId === turnId && candidate.type === "application/context");
  if (!event) return undefined;
  let serialized: string;
  try { serialized = JSON.stringify(event.payload); }
  catch { throw new AgenticError("permanent", "Durable application context is invalid"); }
  if (Buffer.byteLength(serialized, "utf8") > 49_152) {
    throw new AgenticError("permanent", "Durable application context exceeds its bound");
  }
  const snapshot = JSON.parse(serialized) as Record<string, JsonValue>;
  let trusted: Readonly<Record<string, string>> | undefined;
  if (snapshot.trusted !== undefined) {
    if (!snapshot.trusted || typeof snapshot.trusted !== "object" || Array.isArray(snapshot.trusted) ||
        Object.values(snapshot.trusted).some((value) => typeof value !== "string")) {
      throw new AgenticError("permanent", "Durable trusted application context is invalid");
    }
    trusted = Object.freeze(snapshot.trusted as Record<string, string>);
  }
  return freezeJson({
    ...(trusted ? { trusted } : {}),
    ...(snapshot.untrusted !== undefined ? { untrusted: snapshot.untrusted } : {}),
  });
}
