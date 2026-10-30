import {
  AgenticError, CATALOG_BUNDLE_FORMAT, CATALOG_CHANNELS, catalogUuid, checkedCatalogChannel, type AdminPrincipalStore, type CatalogChannelName, type CatalogEditor,
  type CatalogBundle, type CatalogBundleSource, type CatalogReader, type CatalogReleaseItemRef,
} from "@0xsyncroot/contracts";
import { readCatalogBundle } from "./bundle-format.js";
import { catalogManifestHash } from "./canonical.js";
import { catalogChecksPass, NO_BUILD_DIGEST, runCatalogReleaseChecks, type CatalogCheckResult } from "./release-checks.js";
import { catalogRevisionFields } from "./validate-item.js";

/**
 * Moving one release between environments. Export writes the release a channel or id names as a bundle; import proves the
 * bundle whole, stores each body as a revision (an existing revision with the same body is reused), creates the release under
 * the bundle's id, runs the release checks and points one channel at the release only when no check failed. Import never
 * points `live`: going live is a separate, reviewed step. Running an import again changes nothing and writes no audit row.
 */

/** The capacity imported revisions and audit rows are written in. */
export const CATALOG_IMPORT_SCOPE = "import";

export interface CatalogExportRequest {
  readonly agentId: string;
  /** A release id, or a channel name whose current release is exported. */
  readonly release: string;
  readonly source: CatalogBundleSource;
}

/** Writes one release as a bundle; a release that does not exist is `validation`, a revoked one is `conflict`. */
export async function exportCatalogBundle(reader: CatalogReader, request: CatalogExportRequest): Promise<CatalogBundle> {
  const releaseId = await releaseIdOf(reader, request.agentId, request.release);
  const content = await reader.releaseContent(request.agentId, releaseId);
  if (!content) throw new AgenticError("validation", `release ${releaseId} does not exist for agent ${request.agentId}`);
  if (content.release.status === "revoked") throw new AgenticError("conflict", `release ${releaseId} is revoked and is not exported`);
  const agent = await reader.getAgent(request.agentId);
  if (!agent) throw new AgenticError("validation", `agent ${request.agentId} does not exist`);
  const manifest = content.items.map(({ itemKind, itemId, revisionId, bodyHash }) => ({ itemKind, itemId, revisionId, bodyHash }));
  if (catalogManifestHash(manifest) !== content.release.manifestHash) {
    throw new AgenticError("permanent", `release ${releaseId} holds items that do not hash to its stored manifest hash`);
  }
  return readCatalogBundle({
    bundleFormat: CATALOG_BUNDLE_FORMAT, agentId: agent.agentId, productId: agent.productId, releaseId, source: request.source, manifest,
    revisions: content.items.map(({ itemKind, itemId, revisionId, bodyFormat, schemaVersion, body }) => ({ itemKind, itemId, revisionId, bodyFormat, schemaVersion, body })),
    manifestHash: content.release.manifestHash,
  });
}

async function releaseIdOf(reader: CatalogReader, agentId: string, release: string): Promise<string> {
  if (!(CATALOG_CHANNELS as readonly string[]).includes(release)) return catalogUuid(release, "release");
  const channel = await reader.getChannel(agentId, release as CatalogChannelName);
  if (!channel) throw new AgenticError("validation", `channel ${release} of agent ${agentId} points at no release`);
  return channel.releaseId;
}

export interface CatalogImportOptions {
  /** The channel to point at the release when every check passes; `staging` when absent. `live` is refused. */
  readonly channel?: CatalogChannelName;
  /** The principal the import acts as: revision author, release creator, channel mover and audit principal. */
  readonly importedBy: string;
}

/** What one import did to the channel: pointed it, found it already pointing, or held it because a check failed. */
export type CatalogChannelOutcome = "moved" | "unchanged" | "held";

export interface CatalogImportResult {
  readonly agentId: string;
  readonly releaseId: string;
  readonly releaseNo: number;
  readonly manifestHash: string;
  readonly releaseCreated: boolean;
  readonly revisionsCreated: number;
  /** The recorded checks: the first result recorded for the release stands. */
  readonly checks: readonly CatalogCheckResult[];
  readonly passed: boolean;
  readonly channel: CatalogChannelName;
  readonly channelOutcome: CatalogChannelOutcome;
  /** Why the channel was held, one reason per line; empty when it was not. */
  readonly heldBecause: string;
}

/** The bundle's source and outcome, as the import audit row's detail. */
function importDetail(bundle: CatalogBundle, result: CatalogImportResult): string {
  return JSON.stringify({
    source: bundle.source, revisionsCreated: result.revisionsCreated, releaseCreated: result.releaseCreated, passed: result.passed,
    channel: result.channel, channelOutcome: result.channelOutcome, checks: result.checks.map(({ checkKind, status }) => ({ checkKind, status })),
  });
}

/**
 * Refuses, before anything is written, a bundle the store would refuse part-way: an agent id under another product, or a
 * release id that already holds other items. The release number is the store's to allocate, so a bundle cannot conflict on it.
 * The store keeps the same rules, so a writer racing this read still fails as a `conflict`.
 */
async function refuseConflicts(reader: CatalogReader, bundle: CatalogBundle): Promise<void> {
  const agent = await reader.getAgent(bundle.agentId);
  if (agent && agent.productId !== bundle.productId) {
    throw new AgenticError("conflict", `agent ${bundle.agentId} belongs to another product than ${bundle.productId}`);
  }
  const release = agent ? await reader.getRelease(bundle.agentId, bundle.releaseId) : undefined;
  if (release && release.manifestHash !== bundle.manifestHash) {
    throw new AgenticError("conflict", `release ${bundle.releaseId} of agent ${bundle.agentId} holds other items`);
  }
}

/**
 * Imports a bundle (any value: it is read and proved here, so no caller can skip the proof). A bundle that does not prove
 * whole is refused before anything is written.
 */
export async function importCatalogBundle(editor: CatalogEditor, audit: Pick<AdminPrincipalStore, "audit">, value: unknown, options: CatalogImportOptions): Promise<CatalogImportResult> {
  const bundle = readCatalogBundle(value);
  const channel = checkedCatalogChannel(options.channel ?? "staging");
  if (channel === "live") throw new AgenticError("validation", "channel must not be live: an import points staging at most");
  const { agentId, releaseId } = bundle;
  const by = options.importedBy;
  await refuseConflicts(editor, bundle);
  await editor.ensureAgent({ agentId, productId: bundle.productId, createdBy: by });
  const refs: CatalogReleaseItemRef[] = [];
  let revisionsCreated = 0;
  for (const revision of bundle.revisions) {
    const saved = await editor.putRevision({
      agentId, itemKind: revision.itemKind, itemId: revision.itemId, ...catalogRevisionFields(revision.itemKind, revision.itemId, revision.body),
      body: revision.body, authorId: by, authorScope: CATALOG_IMPORT_SCOPE, note: `release ${releaseId} from ${bundle.source.environment}`.slice(0, 500),
    });
    if (saved.created) revisionsCreated += 1;
    refs.push({ itemKind: revision.itemKind, itemId: revision.itemId, revisionId: saved.revision.revisionId });
  }
  const { release, created: releaseCreated } = await editor.createRelease({ agentId, releaseId, items: refs, createdBy: by });
  if (release.manifestHash !== bundle.manifestHash) throw new AgenticError("permanent", `release ${releaseId} was stored with another manifest hash`);
  const checks: CatalogCheckResult[] = [];
  for (const run of runCatalogReleaseChecks(bundle.revisions)) {
    const { check } = await editor.recordCheck({ agentId, releaseId, buildDigest: NO_BUILD_DIGEST, checkedBy: by, ...run });
    checks.push({ checkKind: run.checkKind, status: check.status, detail: check.detail ?? "" });
  }
  const passed = catalogChecksPass(checks);
  const held = [
    ...checks.filter((check) => check.status === "failed").map((check) => `check ${check.checkKind} failed`),
    ...(release.status === "revoked" ? [`release ${releaseId} is revoked`] : []),
  ];
  const current = await editor.getChannel(agentId, channel);
  const outcome: CatalogChannelOutcome = held.length > 0 ? "held" : current?.releaseId === releaseId ? "unchanged" : "moved";
  if (outcome === "moved") await editor.moveChannel({ agentId, channel, releaseId, expectedVersion: current?.version ?? null, updatedBy: by });
  const result: CatalogImportResult = {
    agentId, releaseId, releaseNo: release.releaseNo, manifestHash: release.manifestHash, releaseCreated, revisionsCreated, checks, passed,
    channel, channelOutcome: outcome, heldBecause: held.join("\n"),
  };
  const at = new Date().toISOString();
  const row = { scopeKind: "agent" as const, scopeId: agentId, principalId: by, actorScope: CATALOG_IMPORT_SCOPE, at };
  if (releaseCreated || revisionsCreated > 0) {
    await audit.audit({ ...row, action: "catalog.release.import", targetKind: "release", targetId: releaseId, afterHash: release.manifestHash, detail: importDetail(bundle, result) });
  }
  if (outcome === "moved") {
    const before = current ? await editor.getRelease(agentId, current.releaseId) : undefined;
    await audit.audit({
      ...row, action: "catalog.channel.move", targetKind: "channel", targetId: `${agentId}/${channel}`, afterHash: release.manifestHash,
      ...(before ? { beforeHash: before.manifestHash } : {}), detail: JSON.stringify({ from: current?.releaseId ?? null, to: releaseId }),
    });
  }
  return result;
}
