import assert from "node:assert/strict";
import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadMarkdownAgentProfile, markdownAgentProfile } from "@0xsyncroot/adapter-agent-profile-markdown";

test("loads a trusted Markdown agent identity and supported scope", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-agent-profile-"));
  const file = join(root, "AGENT.md");
  await writeFile(file, `---\nid: finance-assistant\nversion: 1.0.0\nname: Finance Assistant\ndescription: Helps users with finance workflows.\nsupportedDomains:\n  - payroll\n  - accounting\n---\nIntroduce yourself briefly when asked.\n`);
  const profile = await loadMarkdownAgentProfile({ file });
  assert.equal(profile.name, "Finance Assistant");
  assert.deepEqual(profile.supportedDomains, ["payroll", "accounting"]);
  assert.match(profile.instructions, /Introduce yourself briefly/);
  assert.equal(Object.isFrozen(profile.supportedDomains), true);
});

test("rejects agent profiles reached through symbolic links", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-agent-profile-link-"));
  const target = join(root, "target.md");
  const linked = join(root, "AGENT.md");
  await writeFile(target, "---\nid: linked-agent\nversion: 1.0.0\nname: Linked\ndescription: Linked profile\n---\nInstructions\n");
  await symlink(target, linked);
  await assert.rejects(loadMarkdownAgentProfile({ file: linked }), /regular file|symbolic link/i);
});

test("rejects profile instructions that cannot fit the bounded startup prompt", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-agent-profile-budget-"));
  const file = join(root, "AGENT.md");
  await writeFile(file, `---\nid: oversized-agent\nversion: 1.0.0\nname: Oversized\ndescription: Oversized profile\n---\n${"x".repeat(12_001)}\n`);
  await assert.rejects(loadMarkdownAgentProfile({ file }), /instructions exceed 12000 characters/i);
});

test("carries the profile's preloaded skill ids and rejects malformed ones", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-agent-profile-preload-"));
  const file = join(root, "AGENT.md");
  await writeFile(file, `---\nid: finance-assistant\nversion: 1.0.0\nname: Finance Assistant\ndescription: Helps users with finance workflows.\npreloadSkills:\n  - org.payroll\n  - org.payroll\n---\nInstructions\n`);
  const profile = await loadMarkdownAgentProfile({ file });
  assert.deepEqual(profile.preloadSkills, ["org.payroll"], "duplicate ids collapse so a skill is never injected twice");
  assert.equal(Object.isFrozen(profile.preloadSkills), true);

  const bare = join(await mkdtemp(join(tmpdir(), "gateway-agent-profile-bare-")), "AGENT.md");
  await writeFile(bare, "---\nid: bare\nversion: 1.0.0\nname: Bare\ndescription: No preload.\n---\nInstructions\n");
  assert.equal((await loadMarkdownAgentProfile({ file: bare })).preloadSkills, undefined);

  const invalid = join(await mkdtemp(join(tmpdir(), "gateway-agent-profile-invalid-")), "AGENT.md");
  await writeFile(invalid, "---\nid: invalid\nversion: 1.0.0\nname: Invalid\ndescription: Bad preload.\npreloadSkills:\n  - \"../escape\"\n---\nInstructions\n");
  await assert.rejects(loadMarkdownAgentProfile({ file: invalid }), /preloadSkills/);
});

test("what follows the closing marker is carried apart, to be sent as the end of the system prompt", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-agent-profile-closing-"));
  const head = "---\nid: closing-agent\nversion: 1.0.0\nname: Closing\ndescription: Profile with a closing section\n---\n";
  const file = join(root, "AGENT.md");
  await writeFile(file, `${head}Be concise.\n\n<!-- closing -->\nReason in the user's language.\n`);
  const profile = await loadMarkdownAgentProfile({ file });
  assert.equal(profile.instructions, "Be concise.", "the body stops at the marker");
  assert.equal(profile.closingInstructions, "Reason in the user's language.");

  const plain = join(root, "PLAIN.md");
  await writeFile(plain, `${head}Be concise.\n`);
  assert.equal((await loadMarkdownAgentProfile({ file: plain })).closingInstructions, undefined, "no marker, no closing section");

  // The end of a prompt works only while it is short and there is one of it.
  const twice = join(root, "TWICE.md");
  await writeFile(twice, `${head}Be concise.\n<!-- closing -->\nOne.\n<!-- closing -->\nTwo.\n`);
  await assert.rejects(loadMarkdownAgentProfile({ file: twice }), /only one <!-- closing --> marker/);
  const long = join(root, "LONG.md");
  await writeFile(long, `${head}Be concise.\n<!-- closing -->\n${"x".repeat(1_501)}\n`);
  await assert.rejects(loadMarkdownAgentProfile({ file: long }), /closing instructions must be non-empty and at most 1500 characters/);
});

test("carries the skills a turn may go without, which must be among the preloaded ones", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-agent-profile-conditional-"));
  const file = join(root, "AGENT.md");
  const body = (conditional: string) => `---\nid: cond-agent\nversion: 1.0.0\nname: Cond\ndescription: Conditional skills\npreloadSkills:\n  - x.ui\n  - x.payroll\nconditionalSkills:\n  - ${conditional}\n---\nInstructions\n`;
  await writeFile(file, body("x.payroll"));
  const profile = await loadMarkdownAgentProfile({ file });
  assert.deepEqual(profile.conditionalSkills, ["x.payroll"]);
  await writeFile(file, body("x.other"));
  await assert.rejects(loadMarkdownAgentProfile({ file }), /conditionalSkills must list skill ids from preloadSkills/u);
});

test("a profile given as text is the profile the file gives, content digest included", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-agent-profile-text-"));
  const file = join(root, "AGENT.md");
  const text = "---\nid: text-agent\nversion: 1.0.0\nname: Text\ndescription: From a release.\nsupportedDomains: [payroll]\npreloadSkills: [x.lookup]\n---\nAnswer briefly.\r\n<!-- closing -->\nEnd here.\n";
  await writeFile(file, text);
  const fromFile = await loadMarkdownAgentProfile({ file });
  const fromText = markdownAgentProfile(text, "release/agent");
  assert.deepEqual(fromText, fromFile);
  assert.equal(fromText.contentDigest, fromFile.contentDigest);
  assert.throws(() => markdownAgentProfile(text, "release/agent", 10), /release\/agent: agent profile exceeds 10 bytes/u);
  assert.throws(() => markdownAgentProfile(text, "release/agent", 0), /maxFileBytes must be positive/u);
});
