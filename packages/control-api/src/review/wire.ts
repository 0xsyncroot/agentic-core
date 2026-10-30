import type { ReviewEntryRole } from "@0xsyncroot/contracts";

/** The review console's HTTP shapes (`/admin/v1`). Every route but health needs a bearer token; errors are `{ error: { code, message } }`. */

export interface ReviewMe {
  readonly principalId: string;
  readonly displayName: string;
  readonly roles: readonly string[];
}

/** Parsed `GET /sessions` query. `from` inclusive and `to` exclusive bound startedAt; `q` is a session id prefix. */
export interface ReviewSessionFilter {
  readonly from?: string;
  readonly to?: string;
  readonly tenantId?: string;
  readonly q?: string;
  readonly limit: number;
  readonly cursor?: string;
}

export interface ReviewSessionListItem {
  readonly tenantId: string;
  readonly tenantName?: string;
  readonly sessionId: string;
  /** Six lowercase hex characters standing for the person. */
  readonly pseudonym: string;
  readonly startedAt: string;
  readonly lastTurnAt: string;
  readonly answers: number;
  /** Start of the first user message, masked; empty before a transcript exists. */
  readonly preview: string;
}

export interface ReviewSessionList {
  readonly items: readonly ReviewSessionListItem[];
  /** Opaque; pass back as `cursor` for the next page. */
  readonly nextCursor?: string;
}

/** One transcript line. A `tool` entry names the tools a run of calls used and never carries their arguments or results. */
export interface ReviewEntryView {
  readonly seq: number;
  readonly turnId: string;
  readonly role: ReviewEntryRole;
  readonly at: string;
  readonly text: string;
  readonly tools?: readonly { readonly toolId: string; readonly label: string }[];
  /** On assistant entries: the agent's display name, when the console names that agent. */
  readonly agentName?: string;
}

export interface ReviewSessionDetail {
  readonly tenantId: string;
  readonly tenantName?: string;
  readonly sessionId: string;
  readonly pseudonym: string;
  readonly startedAt: string;
  readonly maskVersion: string;
  /** The session's answer count as its header stores it; the same number the list shows, never counted from `entries`. */
  readonly answers: number;
  readonly entries: readonly ReviewEntryView[];
  /** Personal values replaced across the transcript. */
  readonly masking: { readonly values: number };
}
