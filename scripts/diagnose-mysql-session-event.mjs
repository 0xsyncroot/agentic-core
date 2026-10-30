import { createPool } from "mysql2/promise";
import { AesGcmEnvelopeProtector, DerivedTenantKeyProvider } from "@0xsyncroot/adapter-crypto-node";
import { readStorageSettings } from "../apps/harness/src/composition/storage-settings.ts";
import { decodeEventRow } from "../packages/persistence-mysql/src/event-row.ts";
import { MySqlSessionWriteRepository } from "../packages/persistence-mysql/src/session-write-repository.ts";
import { sessionEventHashFormat } from "../packages/persistence-mysql/src/session-event-integrity.ts";
import { diagnoseEventRow } from "../packages/persistence-mysql/src/session-event-diagnosis.ts";
import { MySqlSessionStore } from "../packages/persistence-mysql/src/session-store.ts";
import { diagnosticError } from "./diagnostic-error.ts";

// Operator-only, read-only diagnosis. No payload dumps; turn mode includes bounded tool errors.
async function main() {
  const turnMode = process.argv[2] === "--turn";
  const eventId = process.argv[turnMode ? 3 : 2];
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(eventId ?? "")) {
    throw Object.assign(new Error(), { code: "event_uuid_required" });
  }
  const storage = readStorageSettings(process.env);
  if (storage.selection.sessions !== "mysql") throw Object.assign(new Error(), { code: "session_provider_not_mysql" });
  const key = process.env.AGENTIC_DATA_ENCRYPTION_KEY?.trim();
  const bytes = key ? Buffer.from(key, "base64url") : undefined;
  if (bytes && bytes.length !== 32) throw Object.assign(new Error(), { code: "invalid_encryption_key" });
  const protector = bytes ? new AesGcmEnvelopeProtector(new DerivedTenantKeyProvider(bytes,
    process.env.AGENTIC_DATA_ENCRYPTION_KEY_ID?.trim() || "local-v1")) : undefined;
  const pool = createPool({ uri: storage.urls.sessions, connectionLimit: 1, timezone: "Z", supportBigNumbers: true, bigNumberStrings: true });
  try {
    if (turnMode) {
      const [scope] = await pool.execute("SELECT tenant_id,session_id FROM agentic_session_event WHERE turn_id=? LIMIT 1", [eventId]);
      if (!scope.length) { console.log(JSON.stringify({ turnId: eventId, result: "not-found" })); process.exitCode = 2; return; }
      const [streams] = await pool.execute(`SELECT owner_actor_id,current_seq,active_turn_id,
        lease_expires_at,lease_expires_at>UTC_TIMESTAMP(6) AS lease_valid
        FROM agentic_session_stream WHERE tenant_id=? AND session_id=?`, [scope[0].tenant_id, scope[0].session_id]);
      const [requests] = await pool.execute(`SELECT status,error_code,result_seq FROM agentic_session_turn_request
        WHERE tenant_id=? AND session_id=? AND turn_id=?`, [scope[0].tenant_id, scope[0].session_id, eventId]);
      let contextRead;
      try {
        const context = await new MySqlSessionStore(pool, protector).loadContext(scope[0].session_id, {
          tenantId: scope[0].tenant_id, actorId: streams[0]?.owner_actor_id ?? "diagnostic", permissions: new Set(),
          purpose: "read-only-diagnostic", correlationId: eventId,
        });
        contextRead = { status: "ok", events: context.events.length, checkpoint: !!context.checkpoint };
      } catch (error) {
        contextRead = { status: "failed", error: diagnosticError(error, { sessionId: scope[0].session_id, requestId: eventId }).error };
      }
      // Walk the session index rather than sorting large JSON payloads in MySQL.
      const [rows] = await pool.execute(`SELECT * FROM agentic_session_event FORCE INDEX (session_seq)
        WHERE tenant_id=? AND session_id=? AND turn_id=?
        AND type IN ('tool/result','assistant/narration','assistant/message','turn/failed') ORDER BY seq DESC LIMIT 101`,
      [scope[0].tenant_id, scope[0].session_id, eventId]);
      const observations = [];
      for (const row of rows.slice(0, 100).reverse()) {
        const meta = { eventId: row.event_id, seq: Number(row.seq), type: row.type };
        try {
          const event = await decodeEventRow(row, new MySqlSessionWriteRepository(protector));
          const body = event.payload;
          const error = event.type === "turn/failed" ? body : body?.error;
          const detail = typeof error?.message === "string" ? error.message
            .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/giu, "$1[redacted]@")
            .replace(/Bearer\s+[^\s"']+/giu, "Bearer [redacted]").slice(0, 1000) : undefined;
          observations.push({ ...meta, hash: sessionEventHashFormat(event, row.integrity_hash),
            ...(event.type === "tool/result" ? { toolId: body?.toolId, state: body?.state } : {}),
            ...(error ? { error: { code: error.code, message: detail } } : {}),
            ...(event.type.startsWith("assistant/") ? { hasText: typeof body?.content === "string" && !!body.content.trim() } : {}) });
        } catch { observations.push({ ...meta, hash: "decode-failed" }); }
      }
      console.log(JSON.stringify({ turnId: eventId, result: "turn-diagnostic", latestRelevantEvents: observations.length,
        contextRead, turnRequest: requests[0] ?? null, session: streams[0] ? {
          currentSeq: Number(streams[0].current_seq), activeTurnId: streams[0].active_turn_id,
          leaseValidNow: !!streams[0].lease_valid, leaseExpiresAt: streams[0].lease_expires_at,
        } : null,
        truncated: rows.length > 100, observations }, null, 2));
      return;
    }
    const [rows] = await pool.execute("SELECT *, CAST(payload AS CHAR) AS payload_text FROM agentic_session_event WHERE event_id=? LIMIT 1", [eventId]);
    if (!rows.length) { console.log(JSON.stringify({ eventId, result: "not-found" })); process.exitCode = 2; return; }
    const row = rows[0];
    const report = { eventId, sessionId: row.session_id, turnId: row.turn_id, type: row.type, seq: Number(row.seq),
      locale: Intl.Collator().resolvedOptions().locale };
    try {
      const diagnosis = await diagnoseEventRow(row, new MySqlSessionWriteRepository(protector), row.payload_text);
      console.log(JSON.stringify({ ...report, ...diagnosis }, null, 2));
      if (diagnosis.result !== "canonical" && diagnosis.result !== "legacy-mysql") process.exitCode = 2;
    } catch {
      console.log(JSON.stringify({ ...report, result: "decode-failed", hint: "Check the backend encryption key/key ID and stored JSON/timestamps" }, null, 2));
      process.exitCode = 2;
    }
  } finally { await pool.end(); }
}

main().catch((error) => {
  // Driver exceptions can contain SQL/connection details; expose only their code.
  console.error(JSON.stringify({ result: "diagnostic-failed", code: error.code ?? error.name ?? "Error" }));
  process.exitCode = 1;
});
