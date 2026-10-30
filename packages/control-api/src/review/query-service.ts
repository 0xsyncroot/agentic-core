import type { AdminPrincipalStore, ReviewQueryStore, ReviewSessionCursor, ReviewSessionSummary, ShardDirectory } from "@0xsyncroot/contracts";
import { pseudonymOf } from "../pseudonym.js";
import { consoleMember, reaches, reviewReach } from "./access.js";
import { ReviewRequestError } from "./errors.js";
import type { ReviewMe, ReviewSessionDetail, ReviewSessionFilter, ReviewSessionList, ReviewSessionListItem } from "./wire.js";

/** Characters of the first user message a list item shows. */
export const PREVIEW_CHARS = 160;

export interface ReviewQueryServiceOptions {
  readonly directory: ShardDirectory;
  /** The query store of a shard the directory names; an unknown shard id throws. */
  readonly shard: (shardId: string) => ReviewQueryStore;
  readonly principals: AdminPrincipalStore;
  /** Display name of an agent by agent id, shown on its answers. */
  readonly agentNames: Readonly<Record<string, string>>;
  readonly now?: () => Date;
}

const encodeCursor = (cursor: ReviewSessionCursor) =>
  Buffer.from(JSON.stringify([cursor.startedAt, cursor.tenantId, cursor.sessionId]), "utf8").toString("base64url");

function decodeCursor(text: string): ReviewSessionCursor {
  try {
    const value: unknown = JSON.parse(Buffer.from(text, "base64url").toString("utf8"));
    const [startedAt, tenantId, sessionId] = Array.isArray(value) && value.length === 3 ? value as unknown[] : [];
    if (typeof startedAt === "string" && typeof tenantId === "string" && typeof sessionId === "string" && !Number.isNaN(Date.parse(startedAt))) {
      return { startedAt, tenantId, sessionId };
    }
  } catch { /* falls through to the refusal below */ }
  throw new ReviewRequestError("validation", "cursor is not one this service issued");
}

/** Newest first, as every shard orders its page: (startedAt, tenantId, sessionId) descending. */
function newestFirst(a: ReviewSessionSummary, b: ReviewSessionSummary): number {
  const time = Date.parse(b.startedAt) - Date.parse(a.startedAt);
  if (time !== 0) return time;
  if (a.tenantId !== b.tenantId) return a.tenantId < b.tenantId ? 1 : -1;
  return a.sessionId === b.sessionId ? 0 : a.sessionId < b.sessionId ? 1 : -1;
}

const listItem = (summary: ReviewSessionSummary): ReviewSessionListItem => ({
  tenantId: summary.tenantId, ...(summary.tenantName !== undefined ? { tenantName: summary.tenantName } : {}), sessionId: summary.sessionId,
  pseudonym: pseudonymOf(summary.actorKey), startedAt: summary.startedAt, lastTurnAt: summary.lastTurnAt, answers: summary.answers,
  preview: summary.preview ?? "",
});

/**
 * The console's reads across shards. Every call first loads the caller's reach, then parses its input, then records the
 * attempt before reading anything: listing leaves one control-plane audit row (its filter), opening a conversation one access
 * row in the tenant's shard, also when the conversation is not found or not in reach. A read that fails is still recorded;
 * a caller without the role or with invalid input records nothing.
 */
export class ReviewQueryService {
  readonly #now: () => Date;

  constructor(private readonly options: ReviewQueryServiceOptions) {
    this.#now = options.now ?? (() => new Date());
  }

  async me(principalId: string): Promise<ReviewMe> {
    const reach = await consoleMember(this.options.principals, principalId);
    return { principalId: reach.principal.principalId, displayName: reach.principal.displayName, roles: reach.roles };
  }

  /** `filterOf` parses the request's filter; it runs only once the caller holds the role and may throw a validation error. */
  async list(principalId: string, filterOf: () => ReviewSessionFilter): Promise<ReviewSessionList> {
    const reach = await reviewReach(this.options.principals, principalId);
    const filter = filterOf();
    const after = filter.cursor !== undefined ? decodeCursor(filter.cursor) : undefined;
    await this.options.principals.audit({
      scopeKind: "platform", scopeId: "", principalId: reach.principal.principalId, actorScope: "console", action: "review.list",
      targetKind: "review_session", targetId: filter.tenantId ?? "*", detail: JSON.stringify(filter), at: this.#now().toISOString(),
    });
    const shardIds = filter.tenantId !== undefined
      ? [await this.options.directory.shardOf(filter.tenantId)]
      : (await this.options.directory.shards()).map((shard) => shard.shardId);
    const agents: readonly (string | undefined)[] = reach.agents ? [...reach.agents] : [undefined];
    const pages = await Promise.all(shardIds.flatMap((shardId) => agents.map((agentId) => this.options.shard(shardId).listSessions({
      ...(agentId !== undefined ? { agentId } : {}), ...(filter.tenantId !== undefined ? { tenantId: filter.tenantId } : {}),
      ...(filter.from !== undefined ? { from: filter.from } : {}), ...(filter.to !== undefined ? { to: filter.to } : {}),
      ...(filter.q !== undefined ? { sessionIdPrefix: filter.q } : {}), limit: filter.limit, ...(after ? { after } : {}), previewChars: PREVIEW_CHARS,
    }))));
    const merged = pages.flatMap((page) => page.items).sort(newestFirst);
    const items = merged.slice(0, filter.limit);
    const more = merged.length > filter.limit || pages.some((page) => page.next !== undefined);
    const last = items.at(-1);
    return { items: items.map(listItem), ...(more && last ? { nextCursor: encodeCursor(last) } : {}) };
  }

  /** `targetOf` parses the conversation's path ids; like `list`, it runs only once the caller holds the role. */
  async open(principalId: string, targetOf: () => { readonly tenantId: string; readonly sessionId: string }): Promise<ReviewSessionDetail> {
    const reach = await reviewReach(this.options.principals, principalId);
    const { tenantId, sessionId } = targetOf();
    const store = this.options.shard(await this.options.directory.shardOf(tenantId));
    await store.recordAccess({ tenantId, principalId: reach.principal.principalId, sessionId, action: "open", purpose: "review", at: this.#now().toISOString() });
    const session = await store.session(tenantId, sessionId);
    const maskVersion = session?.transcriptMaskVersion;
    if (!session || !maskVersion || !reaches(reach, session.agentId)) throw new ReviewRequestError("not_found", "no projected conversation");
    const entries = await store.transcript(tenantId, sessionId, maskVersion);
    const agentName = this.options.agentNames[session.agentId];
    return {
      tenantId, ...(session.tenantName !== undefined ? { tenantName: session.tenantName } : {}), sessionId, pseudonym: pseudonymOf(session.actorKey),
      startedAt: session.startedAt, maskVersion, answers: session.answers,
      entries: entries.map((entry) => ({
        seq: entry.entrySeq, turnId: entry.turnId, role: entry.role, at: entry.at, text: entry.body,
        ...(entry.toolLabels?.length ? { tools: entry.toolLabels.map(({ toolId, label }) => ({ toolId, label })) } : {}),
        ...(entry.role === "assistant" && agentName ? { agentName } : {}),
      })),
      masking: { values: entries.reduce((sum, entry) => sum + entry.maskedValues, 0) },
    };
  }
}
