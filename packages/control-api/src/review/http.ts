import { createHash, timingSafeEqual } from "node:crypto";
import { usageBuckets } from "@0xsyncroot/contracts";
import { REVIEW_ERROR_STATUS, ReviewRequestError, type ReviewErrorCode } from "./errors.js";
import type { UsageStatsService } from "../stats/service.js";
import type { UsageRange, UsageSeriesRange } from "../stats/wire.js";
import type { ReviewQueryService } from "./query-service.js";
import type { ReviewSessionFilter } from "./wire.js";

/** A handler's answer, for whichever HTTP server the product runs. */
export interface ReviewHttpResponse {
  readonly status: number;
  readonly body: unknown;
}

/** One configured bearer token and the principal it signs in. */
export interface ReviewTokenEntry {
  readonly token: string;
  readonly principalId: string;
}

export const DEFAULT_PAGE = 30;
export const MAX_PAGE = 50;
/** The most points one series request may ask for; a longer range is refused as validation, never cut. */
export const MAX_USAGE_SERIES_POINTS = 400;
const BUCKET_MS = { day: 86_400_000, week: 7 * 86_400_000 } as const;
const MAX_ID_CHARS = 200;
const MAX_CURSOR_CHARS = 1000;
const MIN_TOKEN_CHARS = 32;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/u;
const CONTROL = /\p{Cc}/u;

const digestOf = (text: string) => createHash("sha256").update(text, "utf8").digest();

/**
 * Bearer tokens configured with the deployment, each naming one principal. The presented token is compared with every
 * configured one through fixed-length digests in constant time, so timing tells nothing about how much of it matched.
 */
export class StaticTokenAuthenticator {
  readonly #entries: readonly { readonly digest: Buffer; readonly principalId: string }[];

  constructor(entries: readonly ReviewTokenEntry[]) {
    if (entries.length === 0) throw new Error("at least one console token is required");
    for (const entry of entries) if (entry.token.length < MIN_TOKEN_CHARS) throw new Error(`a console token must be at least ${MIN_TOKEN_CHARS} characters`);
    this.#entries = entries.map((entry) => ({ digest: digestOf(entry.token), principalId: entry.principalId }));
  }

  /** The principal of a `Bearer <token>` header, or undefined. */
  principalOf(authorization: string | undefined): string | undefined {
    const match = /^Bearer ([^\s]+)$/u.exec(authorization?.trim() ?? "");
    if (!match?.[1]) return undefined;
    const presented = digestOf(match[1]);
    let found: string | undefined;
    for (const entry of this.#entries) if (timingSafeEqual(presented, entry.digest)) found ??= entry.principalId;
    return found;
  }
}

type Query = Readonly<Record<string, unknown>>;

function single(query: Query, name: string, maxChars: number): string | undefined {
  const value = query[name];
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string") throw new ReviewRequestError("validation", `${name} must be given once`);
  if (value.length > maxChars || CONTROL.test(value)) throw new ReviewRequestError("validation", `${name} is not valid`);
  return value;
}

function instant(query: Query, name: string): string | undefined {
  const value = single(query, name, 40);
  if (value === undefined) return undefined;
  if (!ISO_INSTANT.test(value) || Number.isNaN(Date.parse(value))) throw new ReviewRequestError("validation", `${name} must be an ISO instant`);
  return new Date(value).toISOString();
}

/** Parses the list query; anything outside the documented range is refused rather than clamped. */
export function parseSessionFilter(query: Query): ReviewSessionFilter {
  const limitText = single(query, "limit", 3);
  const limit = limitText === undefined ? DEFAULT_PAGE : /^\d+$/u.test(limitText) ? Number(limitText) : Number.NaN;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE) throw new ReviewRequestError("validation", `limit must be 1 to ${MAX_PAGE}`);
  const from = instant(query, "from");
  const to = instant(query, "to");
  if (from !== undefined && to !== undefined && Date.parse(from) >= Date.parse(to)) throw new ReviewRequestError("validation", "from must be before to");
  const tenantId = single(query, "tenantId", MAX_ID_CHARS);
  const q = single(query, "q", MAX_ID_CHARS);
  const cursor = single(query, "cursor", MAX_CURSOR_CHARS);
  return { limit, ...(from ? { from } : {}), ...(to ? { to } : {}), ...(tenantId ? { tenantId } : {}), ...(q ? { q } : {}), ...(cursor ? { cursor } : {}) };
}

/** Parses a statistics range: both bounds required, `from` before `to`. */
export function parseUsageRange(query: Query): UsageRange {
  const from = instant(query, "from");
  const to = instant(query, "to");
  if (from === undefined || to === undefined) throw new ReviewRequestError("validation", "from and to are required");
  if (Date.parse(from) >= Date.parse(to)) throw new ReviewRequestError("validation", "from must be before to");
  return { from, to };
}

/**
 * Parses a series request: the range and a required bucket, `day` or `week`, giving at most `MAX_USAGE_SERIES_POINTS` points.
 * A range longer than that many whole buckets plus one is refused before any bucket is built; a shorter one is counted exactly,
 * partial first and last buckets included.
 */
export function parseUsageSeriesRange(query: Query): UsageSeriesRange {
  const range = parseUsageRange(query);
  const bucket = single(query, "bucket", 4);
  if (bucket !== "day" && bucket !== "week") throw new ReviewRequestError("validation", "bucket must be day or week");
  const tooMany = () => new ReviewRequestError("validation", `a series has at most ${MAX_USAGE_SERIES_POINTS} points`);
  if (Date.parse(range.to) - Date.parse(range.from) > (MAX_USAGE_SERIES_POINTS + 1) * BUCKET_MS[bucket]) throw tooMany();
  if (usageBuckets(range.from, range.to, bucket).length > MAX_USAGE_SERIES_POINTS) throw tooMany();
  return { ...range, bucket };
}

function pathId(value: string, name: string): string {
  if (value === "" || value.length > MAX_ID_CHARS || CONTROL.test(value)) throw new ReviewRequestError("validation", `${name} is not valid`);
  return value;
}

export interface ReviewHttpOptions {
  readonly authenticator: StaticTokenAuthenticator;
  readonly service: ReviewQueryService;
  readonly stats: UsageStatsService;
  /** The sentence a reader sees for each error code. */
  readonly messages: Readonly<Record<ReviewErrorCode, string>>;
  /** Receives a failure answered as `internal`, for the product's log. */
  readonly onInternalError?: (error: unknown) => void;
}

/**
 * The console routes without a web framework: each takes the request's parts and returns status and body. A route hands its
 * parser to the service as a thunk, so the caller's role is checked before any part is parsed: a caller without the role is
 * refused as forbidden whatever it sent.
 */
export class ReviewHttpHandlers {
  constructor(private readonly options: ReviewHttpOptions) {}

  health(): ReviewHttpResponse {
    return { status: 200, body: { status: "ok" } };
  }

  me(authorization: string | undefined): Promise<ReviewHttpResponse> {
    return this.#guard(authorization, (principalId) => this.options.service.me(principalId));
  }

  sessions(authorization: string | undefined, query: Query): Promise<ReviewHttpResponse> {
    return this.#guard(authorization, (principalId) => this.options.service.list(principalId, () => parseSessionFilter(query)));
  }

  session(authorization: string | undefined, tenantId: string, sessionId: string): Promise<ReviewHttpResponse> {
    return this.#guard(authorization, (principalId) =>
      this.options.service.open(principalId, () => ({ tenantId: pathId(tenantId, "tenantId"), sessionId: pathId(sessionId, "sessionId") })));
  }

  statsOverview(authorization: string | undefined, query: Query): Promise<ReviewHttpResponse> {
    return this.#guard(authorization, (principalId) => this.options.stats.overview(principalId, () => parseUsageRange(query)));
  }

  statsSeries(authorization: string | undefined, query: Query): Promise<ReviewHttpResponse> {
    return this.#guard(authorization, (principalId) => this.options.stats.series(principalId, () => parseUsageSeriesRange(query)));
  }

  #error(code: ReviewErrorCode): ReviewHttpResponse {
    return { status: REVIEW_ERROR_STATUS[code], body: { error: { code, message: this.options.messages[code] } } };
  }

  async #guard(authorization: string | undefined, run: (principalId: string) => Promise<unknown>): Promise<ReviewHttpResponse> {
    const principalId = this.options.authenticator.principalOf(authorization);
    if (principalId === undefined) return this.#error("unauthorized");
    try {
      return { status: 200, body: await run(principalId) };
    } catch (error) {
      if (error instanceof ReviewRequestError) return this.#error(error.code);
      this.options.onInternalError?.(error);
      return this.#error("internal");
    }
  }
}
