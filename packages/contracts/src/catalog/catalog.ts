/**
 * Catalog ports: the configuration an agent runs with, kept as immutable revisions and published as immutable releases that
 * channels point at. The catalog is control-plane data shared by every tenant. Revisions, releases, release items, checks
 * and build rows are only ever inserted; an item's draft pointer, a channel's release, a release's revocation and a
 * generation's status are the only things that change. Nothing is deleted: removing an item is a status change. Who did what
 * is written through `AdminPrincipalStore.audit`.
 *
 * Times are ISO 8601 UTC with six fractional digits, stamped by the store. Versions start at 0 and grow by one on each change;
 * a write naming a version that is not the current one is a `conflict`. A reference to a row that does not exist (agent,
 * revision, release) is `validation`.
 */

/** The kinds of item a release holds; what each kind's body must contain is the console's schema, not the store's. */
export const CATALOG_ITEM_KINDS = ["tool", "connector", "skill", "profile", "group"] as const;
export type CatalogItemKind = (typeof CATALOG_ITEM_KINDS)[number];

/** Channels a release is served on. Which release is live is only ever read from its channel. */
export const CATALOG_CHANNELS = ["staging", "live"] as const;
export type CatalogChannelName = (typeof CATALOG_CHANNELS)[number];

export type CatalogBodyFormat = "markdown" | "json";
export type CatalogAgentStatus = "active" | "disabled";
/** A `retired` item stays stored with its revisions but is left out of a release built from drafts. */
export type CatalogItemStatus = "active" | "retired";
export type CatalogReleaseStatus = "active" | "revoked";
/** `pending` records a check this environment could not run, so a later run with the build can settle it. */
export type CatalogCheckStatus = "passed" | "failed" | "pending";
export type CatalogGenerationState = "building" | "ready" | "failed";

export interface CatalogAgentSeed {
  readonly agentId: string;
  readonly productId: string;
  readonly createdBy: string;
}

export interface CatalogAgent extends CatalogAgentSeed {
  readonly status: CatalogAgentStatus;
  /** The number of releases created so far; the next release gets `releaseCounter + 1`. */
  readonly releaseCounter: number;
  readonly taxonomyVersion: number;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CatalogItemKey {
  readonly agentId: string;
  readonly itemKind: CatalogItemKind;
  readonly itemId: string;
}

/**
 * One revision as its author submits it. `displayName`, `summary` and `requiredToolCount` are derived from `body` by the
 * caller before submitting, so lists never parse bodies; the store keeps them as given. `body` is already in its canonical
 * text form: the store hashes exactly these characters.
 */
export interface CatalogRevisionInput extends CatalogItemKey {
  readonly parentRevisionId?: string;
  readonly bodyFormat: CatalogBodyFormat;
  readonly schemaVersion: number;
  readonly displayName: string;
  readonly summary: string;
  readonly requiredToolCount: number;
  readonly body: string;
  readonly authorId: string;
  /** The capacity the author acted in, for example `console`, `import` or `mcp`. */
  readonly authorScope: string;
  readonly note?: string;
}

export interface CatalogRevision extends CatalogRevisionInput {
  readonly revisionId: string;
  /** sha256 hex of the UTF-8 bytes of `body`. */
  readonly bodyHash: string;
  readonly createdAt: string;
}

/** `created` is false when the item already had a revision with this body; that revision is returned unchanged. */
export interface CatalogRevisionSaved {
  readonly revision: CatalogRevision;
  readonly created: boolean;
}

export interface CatalogItem extends CatalogItemKey {
  readonly draftRevisionId: string;
  readonly status: CatalogItemStatus;
  readonly version: number;
  readonly updatedBy: string;
  readonly updatedAt: string;
}

/**
 * Points an item's draft at one of its revisions. `expectedVersion: null` creates the item and is a `conflict` when it
 * exists; a number is the version the caller read. `status` defaults to `active`.
 */
export interface CatalogDraftUpdate extends CatalogItemKey {
  readonly revisionId: string;
  readonly status?: CatalogItemStatus;
  readonly expectedVersion: number | null;
  readonly updatedBy: string;
}

export interface CatalogReleaseItemRef {
  readonly itemKind: CatalogItemKind;
  readonly itemId: string;
  readonly revisionId: string;
}

export interface CatalogReleaseItem extends CatalogReleaseItemRef {
  readonly bodyHash: string;
}

/**
 * A release to create. `items: "drafts"` takes the draft of every active item of the agent, read in one consistent snapshot.
 * A given `releaseId` (a UUID) keeps an imported release's identity: when it exists with the same manifest hash it is
 * returned unchanged, with another manifest it is a `conflict`. A release holds at least one item and each item once.
 */
export interface CatalogReleaseInput {
  readonly agentId: string;
  readonly releaseId?: string;
  readonly items: readonly CatalogReleaseItemRef[] | "drafts";
  readonly createdBy: string;
}

export interface CatalogRelease {
  readonly agentId: string;
  readonly releaseId: string;
  /** 1 for the agent's first release, then one more for each. */
  readonly releaseNo: number;
  /** sha256 hex of `catalogManifestText` over the release's items. */
  readonly manifestHash: string;
  readonly status: CatalogReleaseStatus;
  readonly revokedBy?: string;
  readonly revokedAt?: string;
  readonly createdBy: string;
  readonly createdAt: string;
}

export interface CatalogReleaseCreated {
  readonly release: CatalogRelease;
  readonly created: boolean;
}

/** A release with every revision it holds, in (itemKind, itemId) order: what a runtime generation is built from. */
export interface CatalogReleaseContent {
  readonly release: CatalogRelease;
  readonly items: readonly CatalogRevision[];
}

/** Newest first; `beforeNo` continues after the last release of the previous page. */
export interface CatalogReleasePage {
  readonly limit: number;
  readonly beforeNo?: number;
}

export interface CatalogChannel {
  readonly agentId: string;
  readonly channel: CatalogChannelName;
  readonly releaseId: string;
  readonly version: number;
  readonly updatedBy: string;
  readonly updatedAt: string;
}

/**
 * Points a channel at an active release by compare-and-set: `expectedVersion: null` creates the channel (a `conflict` when it
 * exists), a number must be its current version. Every move adds one to the version, even to the release it already shows,
 * so a caller that wants a rerun to change nothing compares the release first. A revoked release is a `conflict`.
 */
export interface CatalogChannelMove {
  readonly agentId: string;
  readonly channel: CatalogChannelName;
  readonly releaseId: string;
  readonly expectedVersion: number | null;
  readonly updatedBy: string;
}

export interface CatalogReleaseCheckInput {
  readonly agentId: string;
  readonly releaseId: string;
  readonly checkKind: string;
  /** The build the check ran against (see `CatalogBuild`). */
  readonly buildDigest: string;
  readonly status: CatalogCheckStatus;
  readonly detail?: string;
  /** A principal id, or the pod that ran the check. */
  readonly checkedBy: string;
}

export interface CatalogReleaseCheck extends CatalogReleaseCheckInput {
  readonly checkedAt: string;
}

/** The first result recorded for (release, checkKind, buildDigest) stands; `created` is false when one was already there. */
export interface CatalogReleaseCheckRecorded {
  readonly check: CatalogReleaseCheck;
  readonly created: boolean;
}

/** One thing a running build provides, for example a behaviour, a connector kind or a permission name. */
export interface CatalogBuildComponent {
  readonly componentKind: string;
  readonly componentId: string;
}

/** What one build of the agent's service provides, identified by a sha256 hex digest the build computes. */
export interface CatalogBuild {
  readonly buildDigest: string;
  readonly buildVersion: string;
  readonly components: readonly CatalogBuildComponent[];
}

export interface CatalogGenerationReport {
  readonly agentId: string;
  readonly releaseId: string;
  readonly podId: string;
  readonly buildDigest: string;
  readonly status: CatalogGenerationState;
  readonly errorCode?: string;
  readonly detail?: string;
}

export interface CatalogGenerationStatus extends CatalogGenerationReport {
  readonly updatedAt: string;
}

/** What a runtime reads to serve a release. Every method reads only; none caches. */
export interface CatalogReader {
  getAgent(agentId: string): Promise<CatalogAgent | undefined>;
  /** One row by primary key: what a resumed turn checks for `revoked`. */
  getRelease(agentId: string, releaseId: string): Promise<CatalogRelease | undefined>;
  releaseContent(agentId: string, releaseId: string): Promise<CatalogReleaseContent | undefined>;
  getChannel(agentId: string, channel: CatalogChannelName): Promise<CatalogChannel | undefined>;
  /** Every channel of the agent, in channel-name order. */
  channels(agentId: string): Promise<readonly CatalogChannel[]>;
  /** The checks recorded for a release, in (checkKind, buildDigest) order. */
  checks(agentId: string, releaseId: string): Promise<readonly CatalogReleaseCheck[]>;
  /** The build's components in (componentKind, componentId) order; `undefined` when nothing was registered under the digest. */
  build(buildDigest: string): Promise<CatalogBuild | undefined>;
  /** What each pod reported for a release, in podId order. */
  generations(agentId: string, releaseId: string): Promise<readonly CatalogGenerationStatus[]>;
}

/** What the console changes. */
export interface CatalogEditor extends CatalogReader {
  /** Creates the agent when missing; an agent with this id under another product is a `conflict`. */
  ensureAgent(seed: CatalogAgentSeed): Promise<{ readonly agent: CatalogAgent; readonly created: boolean }>;
  /** Stores a revision, or returns the item's existing revision with the same body hash. A parent must be a revision of the same item. */
  putRevision(input: CatalogRevisionInput): Promise<CatalogRevisionSaved>;
  getRevision(key: CatalogItemKey, revisionId: string): Promise<CatalogRevision | undefined>;
  /** Every revision of the item, oldest first. */
  revisions(key: CatalogItemKey): Promise<readonly CatalogRevision[]>;
  /** The revision must belong to the item. */
  setDraft(update: CatalogDraftUpdate): Promise<CatalogItem>;
  getItem(key: CatalogItemKey): Promise<CatalogItem | undefined>;
  /** Every item of the agent, retired ones included, in (itemKind, itemId) order. */
  listItems(agentId: string): Promise<readonly CatalogItem[]>;
  createRelease(input: CatalogReleaseInput): Promise<CatalogReleaseCreated>;
  listReleases(agentId: string, page: CatalogReleasePage): Promise<readonly CatalogRelease[]>;
  /**
   * Marks a release revoked, keeping the first revoker and time on a repeat. A release a channel points at is a `conflict`:
   * move the channel away first, so no channel ever serves a revoked release.
   */
  revokeRelease(agentId: string, releaseId: string, revokedBy: string): Promise<CatalogRelease>;
  moveChannel(move: CatalogChannelMove): Promise<CatalogChannel>;
  /** The release must exist. */
  recordCheck(input: CatalogReleaseCheckInput): Promise<CatalogReleaseCheckRecorded>;
}

/** What a running service writes about itself. */
export interface CatalogBuildRegistry {
  /** Adds the build's components that are not stored yet and returns how many it added; stored rows never change. */
  registerBuild(build: CatalogBuild): Promise<number>;
  /** Creates or replaces the pod's status for the release. */
  reportGeneration(report: CatalogGenerationReport): Promise<CatalogGenerationStatus>;
}
