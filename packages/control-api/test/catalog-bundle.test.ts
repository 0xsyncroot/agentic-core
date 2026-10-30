import assert from "node:assert/strict";
import test from "node:test";
import { AgenticError, type CatalogBundle } from "@0xsyncroot/contracts";
import { InMemoryAdminPrincipalStore, InMemoryCatalogStore } from "@0xsyncroot/persistence-memory";
import {
  catalogBundleText, catalogManifestHash, exportCatalogBundle, importCatalogBundle, NO_BUILD_DIGEST, parseCatalogBundle, readCatalogBundle,
} from "../src/index.js";
import { releaseItems, TOOL } from "./catalog-fixture.js";

const AGENT = "ledger-agent";
const BY = "release-cli";
const SOURCE = { environment: "dev", exportedBy: BY, exportedAt: "2026-01-01T00:00:00.000Z" };

/** A source environment holding one release built from the fixture's items, with staging pointing at it. */
async function sourceRelease(items = releaseItems()) {
  const store = new InMemoryCatalogStore();
  await store.ensureAgent({ agentId: AGENT, productId: "ledger", createdBy: BY });
  const refs = [];
  for (const item of items) {
    const { revision } = await store.putRevision({
      agentId: AGENT, ...item, bodyFormat: item.itemKind === "skill" || item.itemKind === "profile" ? "markdown" : "json", schemaVersion: 1,
      displayName: item.itemId, summary: "", requiredToolCount: 0, authorId: BY, authorScope: "console",
    });
    refs.push({ itemKind: item.itemKind, itemId: item.itemId, revisionId: revision.revisionId });
  }
  const { release } = await store.createRelease({ agentId: AGENT, items: refs, createdBy: BY });
  await store.moveChannel({ agentId: AGENT, channel: "staging", releaseId: release.releaseId, expectedVersion: null, updatedBy: BY });
  return { store, release };
}

const refusal = (run: () => unknown, message: RegExp) => assert.throws(run, (error: unknown) => error instanceof AgenticError && error.code === "validation" && message.test(error.message));

test("export, import and export again keep the manifest hash and the release id", async () => {
  const { store, release } = await sourceRelease();
  const bundle = await exportCatalogBundle(store, { agentId: AGENT, release: "staging", source: SOURCE });
  assert.equal(bundle.releaseId, release.releaseId);
  assert.equal(bundle.manifestHash, release.manifestHash);
  const target = new InMemoryCatalogStore();
  const audit = new InMemoryAdminPrincipalStore();
  const imported = await importCatalogBundle(target, audit, parseCatalogBundle(catalogBundleText(bundle)), { importedBy: BY });
  assert.deepEqual([imported.releaseCreated, imported.revisionsCreated, imported.passed, imported.channelOutcome], [true, 5, true, "moved"]);
  assert.equal((await target.getChannel(AGENT, "staging"))?.releaseId, release.releaseId);
  assert.equal(await target.getChannel(AGENT, "live"), undefined);
  const again = await exportCatalogBundle(target, { agentId: AGENT, release: release.releaseId, source: { ...SOURCE, environment: "test" } });
  assert.equal(again.manifestHash, bundle.manifestHash);
  assert.equal(again.releaseId, bundle.releaseId);
  assert.deepEqual(again.revisions.map((revision) => revision.body), bundle.revisions.map((revision) => revision.body));
  assert.deepEqual((await target.checks(AGENT, release.releaseId)).map((check) => [check.checkKind, check.status, check.buildDigest === NO_BUILD_DIGEST]), [
    ["build-behaviours", "passed", true], ["build-tools", "passed", true], ["group-members", "passed", true], ["prompt-budget", "pending", true],
    ["references", "passed", true], ["required-tools", "passed", true], ["schema", "passed", true], ["skill-size", "passed", true], ["unique-ids", "passed", true],
  ]);
  assert.deepEqual(audit.auditLog().map((row) => [row.action, row.targetId, row.afterHash, row.beforeHash]), [
    ["catalog.release.import", release.releaseId, release.manifestHash, undefined], ["catalog.channel.move", `${AGENT}/staging`, release.manifestHash, undefined],
  ]);
});

test("importing the same bundle again changes nothing and writes no audit row", async () => {
  const { store } = await sourceRelease();
  const bundle = await exportCatalogBundle(store, { agentId: AGENT, release: "staging", source: SOURCE });
  const target = new InMemoryCatalogStore();
  const audit = new InMemoryAdminPrincipalStore();
  await importCatalogBundle(target, audit, bundle, { importedBy: BY });
  const channel = await target.getChannel(AGENT, "staging");
  const rows = audit.auditLog().length;
  const again = await importCatalogBundle(target, audit, bundle, { importedBy: BY });
  assert.deepEqual([again.releaseCreated, again.revisionsCreated, again.channelOutcome], [false, 0, "unchanged"]);
  assert.deepEqual(await target.getChannel(AGENT, "staging"), channel);
  assert.equal((await target.listReleases(AGENT, { limit: 10 })).length, 1);
  assert.equal(audit.auditLog().length, rows);
});

test("a tampered bundle is refused before anything is written", async () => {
  const { store } = await sourceRelease();
  const bundle = await exportCatalogBundle(store, { agentId: AGENT, release: "staging", source: SOURCE });
  const tampered = (change: (copy: { -readonly [K in keyof CatalogBundle]: unknown }) => void) => {
    const copy = JSON.parse(JSON.stringify(bundle));
    change(copy);
    return copy as unknown;
  };
  refusal(() => readCatalogBundle(tampered((copy) => { (copy.revisions as { body: string }[])[0]!.body += " "; })), /^revisions\[0\]\.body does not hash to manifest\[0\]\.bodyHash$/u);
  refusal(() => readCatalogBundle(tampered((copy) => { copy.manifestHash = "0".repeat(64); })), /^manifestHash does not match the manifest$/u);
  refusal(() => readCatalogBundle(tampered((copy) => { (copy.revisions as unknown[]).pop(); })), /^manifest\[4\] has no revision for /u);
  refusal(() => readCatalogBundle(tampered((copy) => { (copy.revisions as { bodyFormat: string }[])[0]!.bodyFormat = "markdown"; })), /^revisions\[0\]\.bodyFormat must be json/u);
  refusal(() => readCatalogBundle(tampered((copy) => { copy.bundleFormat = 2; })), /^bundleFormat /u);
  refusal(() => readCatalogBundle(tampered((copy) => { (copy.manifest as unknown[]).push((copy.manifest as unknown[])[0]); })), /^manifest\[5\] names /u);
  refusal(() => parseCatalogBundle("{"), /^bundle is not valid JSON$/u);
  const target = new InMemoryCatalogStore();
  const audit = new InMemoryAdminPrincipalStore();
  await assert.rejects(importCatalogBundle(target, audit, tampered((copy) => { copy.manifestHash = "0".repeat(64); }), { importedBy: BY }), AgenticError);
  assert.equal(await target.getAgent(AGENT), undefined);
  assert.equal(audit.auditLog().length, 0);
});

test("a release that fails a check is stored and checked, but the channel stays where it was", async () => {
  const good = await sourceRelease();
  const target = new InMemoryCatalogStore();
  const audit = new InMemoryAdminPrincipalStore();
  await importCatalogBundle(target, audit, await exportCatalogBundle(good.store, { agentId: AGENT, release: "staging", source: SOURCE }), { importedBy: BY });
  const before = await target.getChannel(AGENT, "staging");
  const broken = await sourceRelease(releaseItems({ tool: { ...TOOL, connector: "nowhere" } }));
  const bundle = await exportCatalogBundle(broken.store, { agentId: AGENT, release: "staging", source: SOURCE });
  const result = await importCatalogBundle(target, audit, bundle, { importedBy: BY });
  assert.deepEqual([result.releaseCreated, result.passed, result.channelOutcome, result.heldBecause], [true, false, "held", "check references failed"]);
  assert.deepEqual(await target.getChannel(AGENT, "staging"), before);
  assert.equal((await target.getRelease(AGENT, bundle.releaseId))?.manifestHash, catalogManifestHash(bundle.manifest));
  assert.deepEqual(audit.auditLog().map((row) => row.action), ["catalog.release.import", "catalog.channel.move", "catalog.release.import"]);
  const moved = await importCatalogBundle(target, audit, bundle, { importedBy: BY });
  assert.equal(moved.channelOutcome, "held");
});

test("an import never points live, and a revoked release is not exported", async () => {
  const { store, release } = await sourceRelease();
  const bundle = await exportCatalogBundle(store, { agentId: AGENT, release: "staging", source: SOURCE });
  await assert.rejects(importCatalogBundle(new InMemoryCatalogStore(), new InMemoryAdminPrincipalStore(), bundle, { importedBy: BY, channel: "live" }), /channel must not be live/u);
  await assert.rejects(exportCatalogBundle(store, { agentId: AGENT, release: "live", source: SOURCE }), /channel live of agent ledger-agent points at no release/u);
  const other = await store.createRelease({ agentId: AGENT, items: (await store.releaseContent(AGENT, release.releaseId))!.items.slice(0, 1), createdBy: BY });
  await store.revokeRelease(AGENT, other.release.releaseId, BY);
  await assert.rejects(exportCatalogBundle(store, { agentId: AGENT, release: other.release.releaseId, source: SOURCE }), /is revoked/u);
});

test("a bundle whose release id holds other items, or whose agent is another product's, is refused before any revision is written", async () => {
  const good = await sourceRelease();
  const goodBundle = await exportCatalogBundle(good.store, { agentId: AGENT, release: "staging", source: SOURCE });
  const target = new InMemoryCatalogStore();
  const audit = new InMemoryAdminPrincipalStore();
  await importCatalogBundle(target, audit, goodBundle, { importedBy: BY });
  const changed = await sourceRelease(releaseItems({ tool: { ...TOOL, timeoutMs: 6_000 } }));
  const other = await exportCatalogBundle(changed.store, { agentId: AGENT, release: "staging", source: SOURCE });
  const toolRevisions = () => target.revisions({ agentId: AGENT, itemKind: "tool", itemId: "ledger_read" });
  const rows = audit.auditLog().length;
  const conflict = (message: RegExp) => (error: unknown) => error instanceof AgenticError && error.code === "conflict" && message.test(error.message);
  await assert.rejects(importCatalogBundle(target, audit, { ...other, releaseId: goodBundle.releaseId }, { importedBy: BY }), conflict(/holds other items/u));
  await assert.rejects(importCatalogBundle(target, audit, { ...other, productId: "payroll" }, { importedBy: BY }), conflict(/another product/u));
  assert.equal((await toolRevisions()).length, 1);
  assert.equal((await target.listReleases(AGENT, { limit: 10 })).length, 1);
  assert.equal(audit.auditLog().length, rows);
  const imported = await importCatalogBundle(target, audit, other, { importedBy: BY });
  assert.deepEqual([imported.releaseCreated, imported.revisionsCreated, (await toolRevisions()).length], [true, 1, 2]);
});
