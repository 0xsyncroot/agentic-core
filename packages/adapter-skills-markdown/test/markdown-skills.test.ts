import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadMarkdownSkillCatalog, markdownSkillCatalog } from "@0xsyncroot/adapter-skills-markdown";

test("Markdown skill loader discovers and loads trusted SKILL.md definitions", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-skills-"));
  await mkdir(join(root, "skills", "research"), { recursive: true });
  await writeFile(join(root, "skills", "research", "SKILL.md"), `---\nid: research\nversion: 1.2.0\nname: Research\ndescription: Read trusted sources\nrequiredTools:\n  - knowledge_search\n---\nSearch first, then cite evidence.\n`);
  const catalog = await loadMarkdownSkillCatalog({ workspaceRoot: root, roots: ["skills"] });
  assert.deepEqual(catalog.list().map((skill) => skill.id), ["research"]);
  assert.equal(catalog.get("research")?.instructions, "Search first, then cite evidence.");
  const firstRevision = catalog.revision;
  await writeFile(join(root, "skills", "research", "SKILL.md"), `---\nid: research\nversion: 1.2.0\nname: Research\ndescription: Read trusted sources\nrequiredTools:\n  - knowledge_search\n---\nSearch first, verify evidence, then cite it.\n`);
  const changed = await loadMarkdownSkillCatalog({ workspaceRoot: root, roots: ["skills"] });
  assert.notEqual(changed.revision, firstRevision, "instruction-only changes must alter the catalog revision");
});

test("Markdown skill loader rejects symlinks and duplicate ids", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-skills-secure-"));
  await mkdir(join(root, "skills", "one"), { recursive: true });
  await writeFile(join(root, "outside.md"), "outside");
  await symlink(join(root, "outside.md"), join(root, "skills", "one", "linked.md"));
  await assert.rejects(loadMarkdownSkillCatalog({ workspaceRoot: root, roots: ["skills"] }), /symbolic link/i);
});

test("a skill's done criteria are read from its frontmatter and travel with it", async () => {
  const root = await mkdtemp(join(tmpdir(), "skills-done-"));
  await mkdir(join(root, "recon"), { recursive: true });
  await writeFile(join(root, "recon", "SKILL.md"), "---\nid: x.recon\nversion: 1.0.0\nname: recon\ndescription: d\ndone:\n  - \"Tổng chênh trên cùng tập người.\"\n  - \"Mỗi người lệch có nhóm nguyên nhân.\"\n---\nBody\n");
  const catalog = await loadMarkdownSkillCatalog({ roots: [root], workspaceRoot: root });
  assert.deepEqual(catalog.get("x.recon")?.done, ["Tổng chênh trên cùng tập người.", "Mỗi người lệch có nhóm nguyên nhân."]);
  await writeFile(join(root, "recon", "SKILL.md"), "---\nid: x.recon\nversion: 1.0.0\nname: recon\ndescription: d\ndone: \"not a list\"\n---\nBody\n");
  await assert.rejects(loadMarkdownSkillCatalog({ roots: [root], workspaceRoot: root }), /done must be an array/u);
  // A conditional line has one "=>" with text on both sides; an arrow meant as text would split it silently.
  await writeFile(join(root, "recon", "SKILL.md"), "---\nid: x.recon\nversion: 1.0.0\nname: recon\ndescription: d\ndone:\n  - \"nêu ký hiệu => có nguồn\"\n---\nBody\n");
  assert.deepEqual((await loadMarkdownSkillCatalog({ roots: [root], workspaceRoot: root })).get("x.recon")?.done, ["nêu ký hiệu => có nguồn"]);
  await writeFile(join(root, "recon", "SKILL.md"), "---\nid: x.recon\nversion: 1.0.0\nname: recon\ndescription: d\ndone:\n  - \"hệ số cũ => mới => từ ngày\"\n---\nBody\n");
  await assert.rejects(loadMarkdownSkillCatalog({ roots: [root], workspaceRoot: root }), /at most one "=>"/u);
});

test("a skill's closing follows one <!-- closing --> line: kept apart from its instructions, bounded, and part of the revision", async () => {
  const root = await mkdtemp(join(tmpdir(), "skills-closing-"));
  await mkdir(join(root, "recon"), { recursive: true });
  const write = (body: string) => writeFile(join(root, "recon", "SKILL.md"), `---\nid: x.recon\nversion: 1.0.0\nname: recon\ndescription: d\n---\n${body}`);
  const load = () => loadMarkdownSkillCatalog({ roots: [root], workspaceRoot: root });
  await write("Compare the two tables.\n\n<!-- closing -->\nThe report gives each cause group with its difference.\n");
  const catalog = await load();
  assert.equal(catalog.get("x.recon")?.instructions, "Compare the two tables.", "the procedure stops at the marker");
  assert.equal(catalog.get("x.recon")?.closing, "The report gives each cause group with its difference.");
  assert.equal("closing" in catalog.list()[0]!, false, "a listing carries no closing");
  await write("Compare the two tables.\n");
  const without = await load();
  assert.equal(without.get("x.recon")?.closing, undefined);
  assert.notEqual(without.revision, catalog.revision, "a changed closing changes what the agent is told");
  await write("Body\n<!-- closing -->\n");
  await assert.rejects(load(), /closing must be non-empty/u);
  await write(`Body\n<!-- closing -->\n${"x".repeat(301)}\n`);
  await assert.rejects(load(), /at most 300 characters/u);
  await write("Body\n<!-- closing -->\nOne.\n<!-- closing -->\nTwo.\n");
  await assert.rejects(load(), /only one <!-- closing --> marker/u);
});

test("a skill's write preconditions are read from its frontmatter, kept out of listings and the procedure, and part of the revision", async () => {
  const root = await mkdtemp(join(tmpdir(), "skills-preconditions-"));
  await mkdir(join(root, "flow"), { recursive: true });
  const write = (extra: string) => writeFile(join(root, "flow", "SKILL.md"),
    `---\nid: x.flow\nversion: 1.0.0\nname: flow\ndescription: d\nrequiredTools:\n  - read_data\n  - create_item\n  - other_read\n${extra}---\nRead, then create.\n`);
  const load = () => loadMarkdownSkillCatalog({ roots: [root], workspaceRoot: root });
  await write("");
  const plain = await load();
  await write("preconditions:\n  create_item:\n    after: [read_data, other_read, read_data]\n");
  const declared = await load();
  assert.deepEqual(declared.get("x.flow")?.preconditions, { create_item: { after: ["read_data", "other_read"] } });
  assert.ok(Object.isFrozen(declared.get("x.flow")?.preconditions?.create_item?.after), "the declaration is immutable");
  assert.deepEqual(declared.list(), plain.list(), "a listing (and so the prompt's skill catalog) is byte-identical");
  assert.equal("preconditions" in declared.list()[0]!, false);
  assert.equal(declared.get("x.flow")?.instructions, plain.get("x.flow")?.instructions);
  assert.equal(plain.get("x.flow")?.preconditions, undefined);
  assert.notEqual(declared.revision, plain.revision, "a changed declaration changes what the runtime enforces");
  await write("preconditions:\n  create_item:\n    after: [other_read]\n");
  assert.notEqual((await load()).revision, declared.revision);
  // Boot fails rather than enforcing less than the skill says.
  for (const [extra, error] of [
    ["preconditions:\n  create_itm:\n    after: [read_data]\n", /preconditions key "create_itm" is not one of requiredTools/u],
    ["preconditions:\n  create_item:\n    after: [read_dta]\n", /preconditions\.create_item\.after names "read_dta", which is not another of requiredTools/u],
    ["preconditions:\n  create_item:\n    after: [create_item]\n", /names "create_item", which is not another of requiredTools/u],
    ["preconditions:\n  create_item:\n    after: []\n", /must be \{ after: \[tool ids\] \} with at least one tool id/u],
    ["preconditions:\n  create_item:\n    aftr: [read_data]\n", /no other key/u],
    ["preconditions:\n  create_item:\n    after: [read_data]\n    conditions: [\"x\"]\n", /no other key/u],
    ["preconditions:\n  create_item: [read_data]\n", /must be \{ after: \[tool ids\] \}/u],
    ["preconditions: [create_item]\n", /preconditions must map write tool ids/u],
  ] as const) {
    await write(extra);
    await assert.rejects(load(), error, extra);
  }
});

test("a skill's role is read from its frontmatter, travels in listings, is part of the revision, and an unknown role fails the load", async () => {
  const root = await mkdtemp(join(tmpdir(), "skills-role-"));
  await mkdir(join(root, "docs"), { recursive: true });
  const write = (extra: string) => writeFile(join(root, "docs", "SKILL.md"), `---\nid: x.docs\nversion: 1.0.0\nname: docs\ndescription: d\n${extra}---\nRead the file.\n`);
  const load = () => loadMarkdownSkillCatalog({ roots: [root], workspaceRoot: root });
  await write("");
  const plain = await load();
  assert.equal(plain.get("x.docs")?.role, undefined, "no role written: a procedure");
  assert.equal("role" in plain.list()[0]!, false);
  await write("role: supporting\n");
  const supporting = await load();
  assert.equal(supporting.get("x.docs")?.role, "supporting");
  assert.equal(supporting.list()[0]!.role, "supporting", "the role reaches the summaries a request is weighed against");
  assert.notEqual(supporting.revision, plain.revision, "a changed role changes which skills a turn may go without");
  await write("role: procedure\n");
  assert.equal((await load()).get("x.docs")?.role, "procedure");
  await write("role: suporting\n");
  await assert.rejects(load(), /role must be "procedure" or "supporting"/u);
});

test("skills given as text make the catalog the same files make, revision included", async () => {
  const root = await mkdtemp(join(tmpdir(), "skills-text-"));
  const texts = {
    lookup: "---\nid: x.lookup\nversion: 1.0.0\nname: Lookup\ndescription: d\nrequiredTools:\n  - read_a\n  - write_b\npreconditions:\n  write_b:\n    after: [read_a]\ndone:\n  - \"Each row has a source.\"\n---\nRead first.\r\n<!-- closing -->\nCite the rows.\n",
    note: "---\nid: x.note\nversion: 2.0.0\nname: Note\ndescription: e\nrole: supporting\n---\nWrite the note.\n",
  };
  for (const [dir, text] of Object.entries(texts)) {
    await mkdir(join(root, dir), { recursive: true });
    await writeFile(join(root, dir, "SKILL.md"), text);
  }
  const files = await loadMarkdownSkillCatalog({ roots: [root], workspaceRoot: root });
  // Reversed order and other names: only the texts make the catalog.
  const fromText = markdownSkillCatalog([{ name: "release/note", text: texts.note }, { name: "release/lookup", text: texts.lookup }]);
  assert.equal(fromText.revision, files.revision);
  assert.deepEqual(fromText.list(), files.list());
  for (const { id } of files.list()) assert.deepEqual(fromText.get(id), files.get(id));
  assert.throws(() => markdownSkillCatalog([{ name: "release/a", text: texts.note }], { maxFileBytes: 10 }), /release\/a: skill file exceeds 10 bytes/u);
  assert.throws(() => markdownSkillCatalog([{ name: "a", text: texts.note }, { name: "b", text: texts.lookup }], { maxSkills: 1 }), /Skill count exceeds 1/u);
  assert.throws(() => markdownSkillCatalog([{ name: "a", text: texts.note }, { name: "b", text: texts.note }]), /Duplicate skill id: x.note/u);
});
