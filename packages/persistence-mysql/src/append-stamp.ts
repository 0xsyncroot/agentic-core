import type { PoolConnection } from "mysql2/promise";

export type AppendStampProbe = { readonly enabled: true } | { readonly enabled: false; readonly reason: string };

/** No grant on the table, no grant on the column, or no column yet (the migration has not run). */
const STAMP_UNAVAILABLE = new Set([1142, 1143, 1054]);

/**
 * Whether this account may stamp `last_appended_at` on the append path.
 *
 * The probe updates no row (`WHERE 1=0`) but is checked for privileges like a real update. A missing grant or column
 * turns the stamp off, so the append keeps its old statement and chat is unaffected; only the review projector, which
 * finds changed streams by the stamp, stands still. Any other error is not a grant question and fails the boot.
 */
export async function probeAppendStamp(connection: Pick<PoolConnection, "query">): Promise<AppendStampProbe> {
  try {
    await connection.query("UPDATE agentic_session_stream SET last_appended_at=last_appended_at WHERE 1=0");
    return { enabled: true };
  } catch (error) {
    const candidate = error as { errno?: unknown; code?: unknown } | undefined;
    if (typeof candidate?.errno === "number" && STAMP_UNAVAILABLE.has(candidate.errno)) {
      return { enabled: false, reason: typeof candidate.code === "string" ? candidate.code : `errno ${candidate.errno}` };
    }
    throw error;
  }
}
