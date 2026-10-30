import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, test } from "node:test";
import {
  AgenticError, catalogManifestText, type CatalogBuildRegistry, type CatalogEditor, type CatalogItemKey, type CatalogReader, type CatalogRevisionInput,
} from "@0xsyncroot/contracts";

/** The catalog ports as executable cases; every engine runs them unchanged. */
export interface CatalogEngine {
  readonly editor: CatalogEditor;
  /** The writer a running service registers its build and generations with. */
  readonly builds: CatalogBuildRegistry;
  /** A reader as the agent's service opens it. */
  readonly reader: CatalogReader;
}

const unique = () => crypto.randomUUID();
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const fails = (code: string) => (error: unknown) => error instanceof AgenticError && error.code === code;
const digest = (seed: string) => sha256(seed);

async function seeded(engine: CatalogEngine) {
  const agentId = `agent-${unique()}`; const by = unique();
  await engine.editor.ensureAgent({ agentId, productId: "product-a", createdBy: by });
  const revision = (itemId: string, body: string, extra: Partial<CatalogRevisionInput> = {}): CatalogRevisionInput => ({
    agentId, itemKind: "tool", itemId, bodyFormat: "json", schemaVersion: 1, displayName: `Tool ${itemId}`, summary: "Reads a thing",
    requiredToolCount: 0, body, authorId: by, authorScope: "import", ...extra,
  });
  const draft = async (itemId: string, body: string, extra: Partial<CatalogRevisionInput> = {}) => {
    const { revision: saved } = await engine.editor.putRevision(revision(itemId, body, extra));
    const key: CatalogItemKey = { agentId, itemKind: saved.itemKind, itemId };
    const current = await engine.editor.getItem(key);
    await engine.editor.setDraft({ ...key, revisionId: saved.revisionId, expectedVersion: current ? current.version : null, updatedBy: by });
    return saved;
  };
  return { agentId, by, revision, draft };
}

export function catalogStoreConformance(name: string, make: () => Promise<CatalogEngine>): void {
  describe(`${name} catalog agents and revisions`, () => {
    test("ensureAgent creates an agent once and refuses the same id under another product", async () => {
      const { editor } = await make(); const agentId = `agent-${unique()}`; const by = unique();
      const first = await editor.ensureAgent({ agentId, productId: "product-a", createdBy: by });
      assert.equal(first.created, true);
      assert.deepEqual({ ...first.agent, createdAt: "", updatedAt: "" },
        { agentId, productId: "product-a", createdBy: by, status: "active", releaseCounter: 0, taxonomyVersion: 0, version: 0, createdAt: "", updatedAt: "" });
      const again = await editor.ensureAgent({ agentId, productId: "product-a", createdBy: unique() });
      assert.equal(again.created, false); assert.deepEqual(again.agent, first.agent);
      await assert.rejects(editor.ensureAgent({ agentId, productId: "product-b", createdBy: by }), fails("conflict"));
      assert.deepEqual(await editor.getAgent(agentId), first.agent);
      assert.equal(await editor.getAgent(`agent-${unique()}`), undefined);
    });

    test("a revision is stored once per body: the same body returns the stored revision, a new body adds one", async () => {
      const engine = await make(); const { agentId, revision } = await seeded(engine);
      const body = '{"intent":"read","label":"Bảng lương 𝔸"}';
      const first = await engine.editor.putRevision(revision("t1", body, { note: "first" }));
      assert.equal(first.created, true);
      assert.equal(first.revision.bodyHash, sha256(body));
      assert.match(first.revision.revisionId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u);
      assert.equal(first.revision.body, body); assert.equal(first.revision.note, "first"); assert.equal(first.revision.parentRevisionId, undefined);
      const again = await engine.editor.putRevision(revision("t1", body, { displayName: "Renamed", note: "second" }));
      assert.equal(again.created, false); assert.deepEqual(again.revision, first.revision);
      const next = await engine.editor.putRevision(revision("t1", `${body} `, { parentRevisionId: first.revision.revisionId }));
      assert.equal(next.created, true); assert.equal(next.revision.parentRevisionId, first.revision.revisionId);
      const other = await engine.editor.putRevision(revision("t2", body));
      assert.equal(other.created, true); assert.notEqual(other.revision.revisionId, first.revision.revisionId);
      const key = { agentId, itemKind: "tool", itemId: "t1" } as const;
      assert.deepEqual((await engine.editor.revisions(key)).map((item) => item.revisionId), [first.revision.revisionId, next.revision.revisionId]);
      assert.deepEqual(await engine.editor.getRevision(key, next.revision.revisionId), next.revision);
      assert.equal(await engine.editor.getRevision(key, other.revision.revisionId), undefined);
    });

    test("a revision is refused for a missing agent, a parent of another item, or malformed input", async () => {
      const engine = await make(); const { revision } = await seeded(engine);
      const other = (await engine.editor.putRevision(revision("t2", "{}"))).revision;
      await assert.rejects(engine.editor.putRevision({ ...revision("t1", "{}"), agentId: `agent-${unique()}` }), fails("validation"));
      await assert.rejects(engine.editor.putRevision(revision("t1", "{}", { parentRevisionId: other.revisionId })), fails("validation"));
      await assert.rejects(engine.editor.putRevision(revision("t1", "\uD800")), fails("validation"));
      await assert.rejects(engine.editor.putRevision(revision("t1", "{}", { itemKind: "widget" as never })), fails("validation"));
      await assert.rejects(engine.editor.putRevision(revision("t1", "{}", { requiredToolCount: 65_536 })), fails("validation"));
      await assert.rejects(engine.editor.putRevision(revision("t1", "{}", { displayName: "x".repeat(201) })), fails("validation"));
    });

    test("a draft pointer is created once and moved only from the version the caller read", async () => {
      const engine = await make(); const { agentId, by, revision } = await seeded(engine);
      const r1 = (await engine.editor.putRevision(revision("t1", "{}"))).revision;
      const r2 = (await engine.editor.putRevision(revision("t1", "[]"))).revision;
      const foreign = (await engine.editor.putRevision(revision("t2", "{}"))).revision;
      const key = { agentId, itemKind: "tool", itemId: "t1" } as const;
      const created = await engine.editor.setDraft({ ...key, revisionId: r1.revisionId, expectedVersion: null, updatedBy: by });
      assert.deepEqual({ ...created, updatedAt: "" }, { ...key, draftRevisionId: r1.revisionId, status: "active", version: 0, updatedBy: by, updatedAt: "" });
      await assert.rejects(engine.editor.setDraft({ ...key, revisionId: r2.revisionId, expectedVersion: null, updatedBy: by }), fails("conflict"));
      const moved = await engine.editor.setDraft({ ...key, revisionId: r2.revisionId, expectedVersion: 0, updatedBy: by });
      assert.equal(moved.version, 1); assert.equal(moved.draftRevisionId, r2.revisionId);
      await assert.rejects(engine.editor.setDraft({ ...key, revisionId: r1.revisionId, expectedVersion: 0, updatedBy: by }), fails("conflict"));
      await assert.rejects(engine.editor.setDraft({ ...key, revisionId: foreign.revisionId, expectedVersion: 1, updatedBy: by }), fails("validation"));
      const retired = await engine.editor.setDraft({ ...key, revisionId: r2.revisionId, status: "retired", expectedVersion: 1, updatedBy: by });
      assert.equal(retired.status, "retired"); assert.equal(retired.version, 2);
      assert.deepEqual(await engine.editor.getItem(key), retired);
      await engine.editor.setDraft({ agentId, itemKind: "skill", itemId: "a", revisionId: (await engine.editor.putRevision(revision("a", "# A", { itemKind: "skill", bodyFormat: "markdown" }))).revision.revisionId, expectedVersion: null, updatedBy: by });
      assert.deepEqual((await engine.editor.listItems(agentId)).map((item) => `${item.itemKind}/${item.itemId}`), ["skill/a", "tool/t1"]);
    });
  });

  describe(`${name} catalog releases`, () => {
    test("a release numbers itself, hashes its manifest and serves exactly the revisions it was made from", async () => {
      const engine = await make(); const { agentId, by, draft } = await seeded(engine);
      const b = await draft("b", '{"n":2}'); const a = await draft("a", '{"n":1}');
      const refs = [b, a].map((item) => ({ itemKind: item.itemKind, itemId: item.itemId, revisionId: item.revisionId }));
      const { release, created } = await engine.editor.createRelease({ agentId, items: refs, createdBy: by });
      assert.equal(created, true); assert.equal(release.releaseNo, 1); assert.equal(release.status, "active");
      assert.equal(release.manifestHash, sha256(catalogManifestText([a, b])));
      assert.equal(release.revokedBy, undefined);
      const content = await engine.reader.releaseContent(agentId, release.releaseId);
      assert.deepEqual(content, { release, items: [a, b] });
      assert.deepEqual(await engine.reader.getRelease(agentId, release.releaseId), release);
      assert.equal((await engine.editor.getAgent(agentId))?.releaseCounter, 1);
      await draft("a", '{"n":3}');
      assert.deepEqual(await engine.reader.releaseContent(agentId, release.releaseId), content);
      const second = await engine.editor.createRelease({ agentId, items: "drafts", createdBy: by });
      assert.equal(second.release.releaseNo, 2); assert.notEqual(second.release.manifestHash, release.manifestHash);
      assert.equal(await engine.reader.releaseContent(agentId, unique()), undefined);
    });

    test("a given release id is idempotent for the same manifest and a conflict for another", async () => {
      const engine = await make(); const { agentId, by, draft } = await seeded(engine);
      const a = await draft("a", "{}"); const b = await draft("b", "[]");
      const releaseId = unique(); const items = [{ itemKind: a.itemKind, itemId: a.itemId, revisionId: a.revisionId }];
      const first = await engine.editor.createRelease({ agentId, releaseId, items, createdBy: by });
      assert.equal(first.release.releaseId, releaseId);
      const again = await engine.editor.createRelease({ agentId, releaseId, items, createdBy: unique() });
      assert.equal(again.created, false); assert.deepEqual(again.release, first.release);
      assert.equal((await engine.editor.getAgent(agentId))?.releaseCounter, 1);
      await assert.rejects(engine.editor.createRelease({ agentId, releaseId, items: [...items, { itemKind: b.itemKind, itemId: b.itemId, revisionId: b.revisionId }], createdBy: by }), fails("conflict"));
    });

    test("a release from drafts leaves retired items out; malformed or foreign items are refused", async () => {
      const engine = await make(); const { agentId, by, draft } = await seeded(engine);
      const kept = await draft("kept", "{}"); const gone = await draft("gone", "[]");
      await engine.editor.setDraft({ agentId, itemKind: "tool", itemId: "gone", revisionId: gone.revisionId, status: "retired", expectedVersion: 0, updatedBy: by });
      const { release } = await engine.editor.createRelease({ agentId, items: "drafts", createdBy: by });
      assert.deepEqual((await engine.reader.releaseContent(agentId, release.releaseId))?.items.map((item) => item.itemId), ["kept"]);
      await assert.rejects(engine.editor.createRelease({ agentId, items: [], createdBy: by }), fails("validation"));
      const ref = { itemKind: kept.itemKind, itemId: kept.itemId, revisionId: kept.revisionId };
      await assert.rejects(engine.editor.createRelease({ agentId, items: [ref, ref], createdBy: by }), fails("validation"));
      await assert.rejects(engine.editor.createRelease({ agentId, items: [{ ...ref, itemId: "gone" }], createdBy: by }), fails("validation"));
      await assert.rejects(engine.editor.createRelease({ agentId: `agent-${unique()}`, items: [ref], createdBy: by }), fails("validation"));
      const empty = await seeded(engine);
      await assert.rejects(engine.editor.createRelease({ agentId: empty.agentId, items: "drafts", createdBy: by }), fails("validation"));
    });

    test("listReleases pages newest first", async () => {
      const engine = await make(); const { agentId, by, draft } = await seeded(engine);
      for (const body of ["1", "2", "3"]) { await draft("a", body); await engine.editor.createRelease({ agentId, items: "drafts", createdBy: by }); }
      const page = await engine.editor.listReleases(agentId, { limit: 2 });
      assert.deepEqual(page.map((item) => item.releaseNo), [3, 2]);
      assert.deepEqual((await engine.editor.listReleases(agentId, { limit: 2, beforeNo: 2 })).map((item) => item.releaseNo), [1]);
      await assert.rejects(engine.editor.listReleases(agentId, { limit: 0 }), fails("validation"));
    });
  });

  describe(`${name} catalog channels, revocation and checks`, () => {
    test("a channel is created once and moved only by compare-and-set; of two moves from one version exactly one wins", async () => {
      const engine = await make(); const { agentId, by, draft } = await seeded(engine);
      await draft("a", "1"); const r1 = (await engine.editor.createRelease({ agentId, items: "drafts", createdBy: by })).release;
      await draft("a", "2"); const r2 = (await engine.editor.createRelease({ agentId, items: "drafts", createdBy: by })).release;
      const live = await engine.editor.moveChannel({ agentId, channel: "live", releaseId: r1.releaseId, expectedVersion: null, updatedBy: by });
      assert.deepEqual({ ...live, updatedAt: "" }, { agentId, channel: "live", releaseId: r1.releaseId, version: 0, updatedBy: by, updatedAt: "" });
      await assert.rejects(engine.editor.moveChannel({ agentId, channel: "live", releaseId: r2.releaseId, expectedVersion: null, updatedBy: by }), fails("conflict"));
      const outcomes = await Promise.allSettled([r2, r1].map((release) =>
        engine.editor.moveChannel({ agentId, channel: "live", releaseId: release.releaseId, expectedVersion: 0, updatedBy: by })));
      assert.equal(outcomes.filter((item) => item.status === "fulfilled").length, 1);
      assert.ok(outcomes.filter((item) => item.status === "rejected").every((item) => fails("conflict")((item as PromiseRejectedResult).reason)));
      const now = await engine.reader.getChannel(agentId, "live");
      assert.equal(now?.version, 1);
      await engine.editor.moveChannel({ agentId, channel: "staging", releaseId: r2.releaseId, expectedVersion: null, updatedBy: by });
      assert.deepEqual((await engine.reader.channels(agentId)).map((item) => item.channel), ["live", "staging"]);
      await assert.rejects(engine.editor.moveChannel({ agentId, channel: "staging", releaseId: unique(), expectedVersion: 0, updatedBy: by }), fails("validation"));
      await assert.rejects(engine.editor.moveChannel({ agentId, channel: "beta" as never, releaseId: r1.releaseId, expectedVersion: 0, updatedBy: by }), fails("validation"));
    });

    test("revoking keeps the first revoker, is refused while a channel serves the release, and bars a channel from it", async () => {
      const engine = await make(); const { agentId, by, draft } = await seeded(engine);
      await draft("a", "1"); const r1 = (await engine.editor.createRelease({ agentId, items: "drafts", createdBy: by })).release;
      await draft("a", "2"); const r2 = (await engine.editor.createRelease({ agentId, items: "drafts", createdBy: by })).release;
      await engine.editor.moveChannel({ agentId, channel: "live", releaseId: r1.releaseId, expectedVersion: null, updatedBy: by });
      await assert.rejects(engine.editor.revokeRelease(agentId, r1.releaseId, by), fails("conflict"));
      assert.equal((await engine.reader.getRelease(agentId, r1.releaseId))?.status, "active");
      await engine.editor.moveChannel({ agentId, channel: "live", releaseId: r2.releaseId, expectedVersion: 0, updatedBy: by });
      const revoker = unique();
      const revoked = await engine.editor.revokeRelease(agentId, r1.releaseId, revoker);
      assert.equal(revoked.status, "revoked"); assert.equal(revoked.revokedBy, revoker); assert.ok(revoked.revokedAt);
      assert.deepEqual({ ...revoked, status: "active", revokedBy: undefined, revokedAt: undefined }, { ...r1, revokedBy: undefined, revokedAt: undefined });
      assert.deepEqual(await engine.editor.revokeRelease(agentId, r1.releaseId, unique()), revoked);
      assert.deepEqual(await engine.reader.getRelease(agentId, r1.releaseId), revoked);
      await assert.rejects(engine.editor.moveChannel({ agentId, channel: "live", releaseId: r1.releaseId, expectedVersion: 1, updatedBy: by }), fails("conflict"));
      await assert.rejects(engine.editor.moveChannel({ agentId, channel: "staging", releaseId: r1.releaseId, expectedVersion: null, updatedBy: by }), fails("conflict"));
      await assert.rejects(engine.editor.revokeRelease(agentId, unique(), by), fails("validation"));
    });

    test("the first check result for a release and build stands", async () => {
      const engine = await make(); const { agentId, by, draft } = await seeded(engine);
      await draft("a", "1"); const { release } = await engine.editor.createRelease({ agentId, items: "drafts", createdBy: by });
      const base = { agentId, releaseId: release.releaseId, buildDigest: digest("b1"), checkedBy: "pod-1" };
      const first = await engine.editor.recordCheck({ ...base, checkKind: "schema", status: "passed", detail: '{"errors":[]}' });
      assert.equal(first.created, true); assert.equal(first.check.status, "passed"); assert.ok(first.check.checkedAt);
      const repeat = await engine.editor.recordCheck({ ...base, checkKind: "schema", status: "failed" });
      assert.equal(repeat.created, false); assert.deepEqual(repeat.check, first.check);
      await engine.editor.recordCheck({ ...base, checkKind: "prompt-budget", status: "pending" });
      assert.deepEqual((await engine.reader.checks(agentId, release.releaseId)).map((item) => `${item.checkKind}:${item.status}`), ["prompt-budget:pending", "schema:passed"]);
      await assert.rejects(engine.editor.recordCheck({ ...base, releaseId: unique(), checkKind: "schema", status: "passed" }), fails("validation"));
      await assert.rejects(engine.editor.recordCheck({ ...base, buildDigest: "x", checkKind: "schema", status: "passed" }), fails("validation"));
    });
  });

  describe(`${name} catalog builds and generations`, () => {
    test("a build keeps every component it was registered with and adds only new ones", async () => {
      const engine = await make(); const buildDigest = digest(unique());
      const components = [{ componentKind: "behaviour", componentId: "payroll.apply" }, { componentKind: "connector-kind", componentId: "intent-adapter" }];
      assert.equal(await engine.builds.registerBuild({ buildDigest, buildVersion: "1.0.0", components: [...components].reverse() }), 2);
      assert.equal(await engine.builds.registerBuild({ buildDigest, buildVersion: "1.0.0", components }), 0);
      assert.equal(await engine.builds.registerBuild({ buildDigest, buildVersion: "1.0.0", components: [...components, { componentKind: "permission", componentId: "payroll.read" }] }), 1);
      assert.deepEqual(await engine.reader.build(buildDigest), { buildDigest, buildVersion: "1.0.0", components: [...components, { componentKind: "permission", componentId: "payroll.read" }] });
      await assert.rejects(engine.builds.registerBuild({ buildDigest, buildVersion: "2.0.0", components }), fails("conflict"));
      assert.equal(await engine.reader.build(digest(unique())), undefined);
    });

    test("a pod's generation status is replaced on each report", async () => {
      const engine = await make(); const { agentId, by, draft } = await seeded(engine);
      await draft("a", "1"); const { release } = await engine.editor.createRelease({ agentId, items: "drafts", createdBy: by });
      const base = { agentId, releaseId: release.releaseId, buildDigest: digest("b1") };
      await engine.builds.reportGeneration({ ...base, podId: "pod-b", status: "building" });
      const failed = await engine.builds.reportGeneration({ ...base, podId: "pod-b", status: "failed", errorCode: "behaviour-missing", detail: "payroll.apply" });
      assert.equal(failed.status, "failed"); assert.ok(failed.updatedAt);
      await engine.builds.reportGeneration({ ...base, podId: "pod-a", status: "ready" });
      const ready = await engine.builds.reportGeneration({ ...base, podId: "pod-b", status: "ready" });
      assert.equal(ready.errorCode, undefined); assert.equal(ready.detail, undefined);
      assert.deepEqual((await engine.reader.generations(agentId, release.releaseId)).map((item) => `${item.podId}:${item.status}`), ["pod-a:ready", "pod-b:ready"]);
      await assert.rejects(engine.builds.reportGeneration({ ...base, podId: "pod-c", status: "done" as never }), fails("validation"));
    });
  });
}
