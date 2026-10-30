import { createHash, randomUUID } from "node:crypto";
import {
  AgenticError, byKindThenId, catalogManifestText, catalogUuid, checkedCatalogAgentId, checkedCatalogAgentSeed, checkedCatalogBuild, checkedCatalogChannel,
  checkedCatalogChannelMove, checkedCatalogDraftUpdate, checkedCatalogGenerationReport, checkedCatalogItemKey, checkedCatalogReleaseCheck,
  checkedCatalogReleaseInput, checkedCatalogReleasePage, checkedCatalogRevision, reviewHash, reviewIdentifier, reviewTime, type CatalogAgent,
  type CatalogAgentSeed, type CatalogBuild, type CatalogBuildRegistry, type CatalogChannel, type CatalogChannelMove, type CatalogChannelName,
  type CatalogDraftUpdate, type CatalogEditor, type CatalogGenerationReport, type CatalogGenerationStatus, type CatalogItem, type CatalogItemKey,
  type CatalogRelease, type CatalogReleaseCheck, type CatalogReleaseCheckInput, type CatalogReleaseCheckRecorded, type CatalogReleaseContent,
  type CatalogReleaseCreated, type CatalogReleaseInput, type CatalogReleaseItem, type CatalogReleasePage, type CatalogRevision,
  type CatalogRevisionInput, type CatalogRevisionSaved,
} from "@0xsyncroot/contracts";
import { freezeDeep } from "./freeze.js";

const key = (...parts: readonly string[]) => parts.join("\u0000");
const itemKey = (item: CatalogItemKey) => key(item.agentId, item.itemKind, item.itemId);
const now = () => reviewTime(new Date().toISOString(), "at");
/** The body hash is over the body's own characters, not a JSON encoding of them. */
const textHash = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const byItem = byKindThenId<{ itemKind: string; itemId: string }>((item) => [item.itemKind, item.itemId]);
const byText = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

interface BuildRow { readonly buildVersion: string; readonly components: Map<string, { readonly componentKind: string; readonly componentId: string }> }

/**
 * The catalog in one process, under the rules of the MySQL engine: revisions, releases, release items, checks and build
 * components are never changed once stored, and nothing is removed. Every returned record is frozen.
 */
export class InMemoryCatalogStore implements CatalogEditor, CatalogBuildRegistry {
  readonly #agents = new Map<string, CatalogAgent>();
  readonly #revisions = new Map<string, CatalogRevision[]>();
  readonly #items = new Map<string, CatalogItem>();
  readonly #releases = new Map<string, CatalogRelease[]>();
  readonly #releaseItems = new Map<string, readonly CatalogReleaseItem[]>();
  readonly #channels = new Map<string, CatalogChannel>();
  readonly #checks = new Map<string, CatalogReleaseCheck>();
  readonly #builds = new Map<string, BuildRow>();
  readonly #generations = new Map<string, CatalogGenerationStatus>();

  async ensureAgent(seed: CatalogAgentSeed): Promise<{ readonly agent: CatalogAgent; readonly created: boolean }> {
    const checked = checkedCatalogAgentSeed(seed);
    const existing = this.#agents.get(checked.agentId);
    if (existing) {
      if (existing.productId !== checked.productId) throw new AgenticError("conflict", "The agent id belongs to another product");
      return { agent: existing, created: false };
    }
    const at = now();
    const agent = freezeDeep({ ...checked, status: "active" as const, releaseCounter: 0, taxonomyVersion: 0, version: 0, createdAt: at, updatedAt: at });
    this.#agents.set(agent.agentId, agent);
    return { agent, created: true };
  }

  async getAgent(agentId: string): Promise<CatalogAgent | undefined> { return this.#agents.get(checkedCatalogAgentId(agentId)); }

  async putRevision(input: CatalogRevisionInput): Promise<CatalogRevisionSaved> {
    const checked = checkedCatalogRevision(input);
    this.#agent(checked.agentId);
    const stored = this.#revisions.get(itemKey(checked)) ?? [];
    const bodyHash = textHash(checked.body);
    const same = stored.find((item) => item.bodyHash === bodyHash);
    if (same) return { revision: same, created: false };
    if (checked.parentRevisionId !== undefined && !stored.some((item) => item.revisionId === checked.parentRevisionId)) {
      throw new AgenticError("validation", "parentRevisionId must be a revision of the same item");
    }
    const revision = freezeDeep({ ...checked, revisionId: randomUUID(), bodyHash, createdAt: now() });
    this.#revisions.set(itemKey(checked), [...stored, revision]);
    return { revision, created: true };
  }

  async getRevision(itemKeyInput: CatalogItemKey, revisionId: string): Promise<CatalogRevision | undefined> {
    const checked = checkedCatalogItemKey(itemKeyInput); const id = catalogUuid(revisionId, "revisionId");
    return (this.#revisions.get(itemKey(checked)) ?? []).find((item) => item.revisionId === id);
  }

  async revisions(itemKeyInput: CatalogItemKey): Promise<readonly CatalogRevision[]> {
    return [...(this.#revisions.get(itemKey(checkedCatalogItemKey(itemKeyInput))) ?? [])];
  }

  async setDraft(update: CatalogDraftUpdate): Promise<CatalogItem> {
    const checked = checkedCatalogDraftUpdate(update);
    if (!(this.#revisions.get(itemKey(checked)) ?? []).some((item) => item.revisionId === checked.revisionId)) {
      throw new AgenticError("validation", "revisionId must be a revision of the item");
    }
    const existing = this.#items.get(itemKey(checked));
    if (checked.expectedVersion === null ? existing !== undefined : existing?.version !== checked.expectedVersion) {
      throw new AgenticError("conflict", "The item changed since it was read");
    }
    const { agentId, itemKind, itemId, revisionId, status, updatedBy } = checked;
    const item = freezeDeep({ agentId, itemKind, itemId, draftRevisionId: revisionId, status, version: existing ? existing.version + 1 : 0, updatedBy, updatedAt: now() });
    this.#items.set(itemKey(item), item);
    return item;
  }

  async getItem(itemKeyInput: CatalogItemKey): Promise<CatalogItem | undefined> { return this.#items.get(itemKey(checkedCatalogItemKey(itemKeyInput))); }

  async listItems(agentId: string): Promise<readonly CatalogItem[]> {
    const id = checkedCatalogAgentId(agentId);
    return [...this.#items.values()].filter((item) => item.agentId === id).sort(byItem);
  }

  async createRelease(input: CatalogReleaseInput): Promise<CatalogReleaseCreated> {
    const checked = checkedCatalogReleaseInput(input);
    const agent = this.#agent(checked.agentId);
    const refs = checked.items === "drafts"
      ? [...this.#items.values()].filter((item) => item.agentId === agent.agentId && item.status === "active")
        .map(({ itemKind, itemId, draftRevisionId }) => ({ itemKind, itemId, revisionId: draftRevisionId }))
      : checked.items;
    if (refs.length === 0) throw new AgenticError("validation", "The agent has no active item to release");
    const items = refs.map((ref) => {
      const revision = (this.#revisions.get(itemKey({ agentId: agent.agentId, ...ref })) ?? []).find((item) => item.revisionId === ref.revisionId);
      if (!revision) throw new AgenticError("validation", `No revision ${ref.revisionId} of ${ref.itemKind} ${ref.itemId}`);
      return { ...ref, bodyHash: revision.bodyHash };
    }).sort(byItem);
    const manifestHash = textHash(catalogManifestText(items));
    const releases = this.#releases.get(agent.agentId) ?? [];
    const existing = checked.releaseId === undefined ? undefined : releases.find((item) => item.releaseId === checked.releaseId);
    if (existing) {
      if (existing.manifestHash !== manifestHash) throw new AgenticError("conflict", "The release id holds other items");
      return { release: existing, created: false };
    }
    const at = now(); const releaseNo = agent.releaseCounter + 1;
    const release = freezeDeep({
      agentId: agent.agentId, releaseId: checked.releaseId ?? randomUUID(), releaseNo, manifestHash, status: "active" as const, createdBy: checked.createdBy, createdAt: at,
    });
    this.#agents.set(agent.agentId, freezeDeep({ ...agent, releaseCounter: releaseNo, version: agent.version + 1, updatedAt: at }));
    this.#releases.set(agent.agentId, [...releases, release]);
    this.#releaseItems.set(key(agent.agentId, release.releaseId), freezeDeep(items));
    return { release, created: true };
  }

  async getRelease(agentId: string, releaseId: string): Promise<CatalogRelease | undefined> {
    const id = checkedCatalogAgentId(agentId); const release = catalogUuid(releaseId, "releaseId");
    return (this.#releases.get(id) ?? []).find((item) => item.releaseId === release);
  }

  async releaseContent(agentId: string, releaseId: string): Promise<CatalogReleaseContent | undefined> {
    const release = await this.getRelease(agentId, releaseId);
    if (!release) return undefined;
    const items = (this.#releaseItems.get(key(release.agentId, release.releaseId)) ?? []).map((ref) => {
      const revision = (this.#revisions.get(itemKey({ agentId: release.agentId, ...ref })) ?? []).find((item) => item.revisionId === ref.revisionId);
      if (!revision) throw new AgenticError("permanent", `Release ${release.releaseId} names a revision that is not stored`);
      return revision;
    });
    return { release, items };
  }

  async listReleases(agentId: string, page: CatalogReleasePage): Promise<readonly CatalogRelease[]> {
    const id = checkedCatalogAgentId(agentId); const checked = checkedCatalogReleasePage(page);
    return (this.#releases.get(id) ?? []).filter((item) => checked.beforeNo === undefined || item.releaseNo < checked.beforeNo)
      .sort((left, right) => right.releaseNo - left.releaseNo).slice(0, checked.limit);
  }

  async revokeRelease(agentId: string, releaseId: string, revokedBy: string): Promise<CatalogRelease> {
    const release = await this.getRelease(agentId, releaseId);
    const by = reviewIdentifier(revokedBy, "revokedBy", 36);
    if (!release) throw new AgenticError("validation", "No such release");
    if (release.status === "revoked") return release;
    if ([...this.#channels.values()].some((item) => item.agentId === release.agentId && item.releaseId === release.releaseId)) {
      throw new AgenticError("conflict", "A channel serves this release; move it first");
    }
    const revoked = freezeDeep({ ...release, status: "revoked" as const, revokedBy: by, revokedAt: now() });
    const releases = this.#releases.get(release.agentId) ?? [];
    this.#releases.set(release.agentId, releases.map((item) => (item.releaseId === release.releaseId ? revoked : item)));
    return revoked;
  }

  async moveChannel(move: CatalogChannelMove): Promise<CatalogChannel> {
    const checked = checkedCatalogChannelMove(move);
    const release = await this.getRelease(checked.agentId, checked.releaseId);
    if (!release) throw new AgenticError("validation", "No such release");
    if (release.status === "revoked") throw new AgenticError("conflict", "A revoked release cannot be served");
    const existing = this.#channels.get(key(checked.agentId, checked.channel));
    if (checked.expectedVersion === null ? existing !== undefined : existing?.version !== checked.expectedVersion) {
      throw new AgenticError("conflict", "The channel changed since it was read");
    }
    const { agentId, channel, releaseId, updatedBy } = checked;
    const moved = freezeDeep({ agentId, channel, releaseId, version: existing ? existing.version + 1 : 0, updatedBy, updatedAt: now() });
    this.#channels.set(key(agentId, channel), moved);
    return moved;
  }

  async getChannel(agentId: string, channel: CatalogChannelName): Promise<CatalogChannel | undefined> {
    return this.#channels.get(key(checkedCatalogAgentId(agentId), checkedCatalogChannel(channel)));
  }

  async channels(agentId: string): Promise<readonly CatalogChannel[]> {
    const id = checkedCatalogAgentId(agentId);
    return [...this.#channels.values()].filter((item) => item.agentId === id).sort((left, right) => byText(left.channel, right.channel));
  }

  async recordCheck(input: CatalogReleaseCheckInput): Promise<CatalogReleaseCheckRecorded> {
    const checked = checkedCatalogReleaseCheck(input);
    if (!(await this.getRelease(checked.agentId, checked.releaseId))) throw new AgenticError("validation", "No such release");
    const id = key(checked.agentId, checked.releaseId, checked.checkKind, checked.buildDigest);
    const existing = this.#checks.get(id);
    if (existing) return { check: existing, created: false };
    const check = freezeDeep({ ...checked, checkedAt: now() });
    this.#checks.set(id, check);
    return { check, created: true };
  }

  async checks(agentId: string, releaseId: string): Promise<readonly CatalogReleaseCheck[]> {
    const id = checkedCatalogAgentId(agentId); const release = catalogUuid(releaseId, "releaseId");
    return [...this.#checks.values()].filter((item) => item.agentId === id && item.releaseId === release)
      .sort(byKindThenId((item) => [item.checkKind, item.buildDigest]));
  }

  async registerBuild(build: CatalogBuild): Promise<number> {
    const checked = checkedCatalogBuild(build);
    const row = this.#builds.get(checked.buildDigest) ?? { buildVersion: checked.buildVersion, components: new Map() };
    if (row.buildVersion !== checked.buildVersion) throw new AgenticError("conflict", "The build digest is registered under another build version");
    let added = 0;
    for (const component of checked.components) {
      const id = key(component.componentKind, component.componentId);
      if (!row.components.has(id)) { row.components.set(id, freezeDeep({ ...component })); added += 1; }
    }
    if (row.components.size > 0) this.#builds.set(checked.buildDigest, row);
    return added;
  }

  async build(buildDigest: string): Promise<CatalogBuild | undefined> {
    const digest = reviewHash(buildDigest, "buildDigest");
    const row = this.#builds.get(digest);
    if (!row) return undefined;
    const components = [...row.components.values()].sort(byKindThenId((item) => [item.componentKind, item.componentId]));
    return freezeDeep({ buildDigest: digest, buildVersion: row.buildVersion, components });
  }

  async reportGeneration(report: CatalogGenerationReport): Promise<CatalogGenerationStatus> {
    const checked = checkedCatalogGenerationReport(report);
    if (!(await this.getRelease(checked.agentId, checked.releaseId))) throw new AgenticError("validation", "No such release");
    const status = freezeDeep({ ...checked, updatedAt: now() });
    this.#generations.set(key(checked.agentId, checked.releaseId, checked.podId), status);
    return status;
  }

  async generations(agentId: string, releaseId: string): Promise<readonly CatalogGenerationStatus[]> {
    const id = checkedCatalogAgentId(agentId); const release = catalogUuid(releaseId, "releaseId");
    return [...this.#generations.values()].filter((item) => item.agentId === id && item.releaseId === release)
      .sort((left, right) => byText(left.podId, right.podId));
  }

  #agent(agentId: string): CatalogAgent {
    const agent = this.#agents.get(agentId);
    if (!agent) throw new AgenticError("validation", "No such agent");
    return agent;
  }
}
