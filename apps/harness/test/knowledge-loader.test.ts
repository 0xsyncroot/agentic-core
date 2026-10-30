import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadLocalMarkdownKnowledge } from "../src/composition/local-markdown-knowledge-loader.js";
import { s3Config } from "@0xsyncroot/adapter-s3";
import { loadKnowledgeDocuments, objectStoreKnowledgeOptions } from "../src/composition/object-store-knowledge-loader.js";

test("knowledge loader stays inside the workspace and never follows symlinks", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-knowledge-loader-"));
  const workspace = join(root, "workspace");
  const documents = join(workspace, "documents");
  const outside = join(root, "outside");
  try {
    await mkdir(documents, { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(join(documents, "inside.md"), "# Inside\n\nTrusted", "utf8");
    await writeFile(join(outside, "outside.md"), "# Outside\n\nUntrusted", "utf8");
    await symlink(outside, join(documents, "nested-link"), "dir");
    await symlink(outside, join(workspace, "root-link"), "dir");

    const loaded = await loadLocalMarkdownKnowledge(["documents"], workspace);
    assert.deepEqual(loaded.map((document) => document.sourceRef), ["documents/inside.md"]);
    await assert.rejects(
      loadLocalMarkdownKnowledge(["root-link"], workspace),
      /symbolic link|outside the trusted workspace/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a production runtime refuses a knowledge corpus read from disk", async () => {
  const empty = {} as NodeJS.ProcessEnv;

  // The failure this prevents is not "the corpus is missing" — it is the corpus being silently
  // present and stale. A deployment missing one variable starts, answers, and consults whatever
  // was baked into the image at build time, with nothing downstream able to tell that apart from
  // the copy the operator just uploaded.
  await assert.rejects(
    () => loadKnowledgeDocuments(["apps/harness/test/fixtures/knowledge"], "production", empty),
    (error: Error) => {
      assert.match(error.message, /AGENTIC_RUNTIME_PROFILE=production/u);
      // Names every variable to set: whoever reads this at 2am should not have to find the docs.
      for (const variable of ["S3_ENDPOINT", "S3_BUCKET", "S3_ACCESS_KEY", "S3_SECRET_KEY"]) {
        assert.ok(error.message.includes(variable), `the message does not name ${variable}`);
      }
      assert.match(error.message, /apps\/harness\/test\/fixtures\/knowledge/u, "it should say which path it was about to read");
      return true;
    },
  );

  // A product that ships no corpus — Sample App sets the roots to empty, and so does the harness
  // default outside development — is unaffected. Refusing there would break a composition that
  // never wanted a corpus in the first place.
  assert.deepEqual(await loadKnowledgeDocuments([], "production", empty), []);

  // Development still reads from disk: the test suite and every local run depend on it, and this
  // rule is about what a deployment may do, not about what the loader is capable of.
  const documents = await loadKnowledgeDocuments(["apps/harness/test/fixtures/knowledge"], "development", empty);
  assert.ok(documents.length >= 5, `expected the EXAMPLE corpus from disk, got ${documents.length}`);
});

test("a folder inside a shared bucket is the key prefix, never part of the bucket name", () => {
  const env = (bucket: string, prefix?: string) => ({
    S3_ENDPOINT: "http://s3.internal.example", S3_BUCKET: bucket,
    S3_ACCESS_KEY: "a", S3_SECRET_KEY: "b",
    ...(prefix === undefined ? {} : { S3_PREFIX: prefix }),
  });
  // Left as-is the S3 client only says "Invalid bucket name" on the first call; the error has to say how to split it.
  assert.throws(() => objectStoreKnowledgeOptions(env("agent-files/example-knowledge")),
    /S3_BUCKET=agent-files and S3_PREFIX=example-knowledge\//u);
  // Without the trailing slash "example-knowledge" would also match "example-knowledge-old/...".
  assert.equal(objectStoreKnowledgeOptions(env("agent-files", "example-knowledge"))?.prefix, "example-knowledge/");
  assert.equal(objectStoreKnowledgeOptions(env("agent-files", "/example-knowledge/"))?.prefix, "example-knowledge/");
  // No folder named: the corpus is not read from the bucket at all (it also holds users' attachments).
  assert.equal(objectStoreKnowledgeOptions(env("agent-files")), undefined);
});

test("the retired AGENTIC_KNOWLEDGE_S3_* and AGENTIC_S3_* names still configure the shared bucket; a conflicting pair is refused", (context) => {
  const warnings: string[] = [];
  context.mock.method(console, "warn", (message: string) => { warnings.push(message); });
  const retired = {
    AGENTIC_KNOWLEDGE_S3_ENDPOINT: "http://127.0.0.1:9000", AGENTIC_KNOWLEDGE_S3_BUCKET: "agent-files",
    AGENTIC_KNOWLEDGE_S3_ACCESS_KEY: "a", AGENTIC_KNOWLEDGE_S3_SECRET_KEY: "b", AGENTIC_KNOWLEDGE_S3_PREFIX: "example-knowledge",
  };
  const options = objectStoreKnowledgeOptions(retired);
  assert.equal(options?.config.bucket, "agent-files");
  assert.equal(options?.prefix, "example-knowledge/");
  assert.equal(s3Config({ AGENTIC_S3_ENDPOINT: "http://127.0.0.1:9000", AGENTIC_S3_BUCKET: "b", AGENTIC_S3_ACCESS_KEY: "a", AGENTIC_S3_SECRET_KEY: "s" })?.bucket, "b");
  assert.ok(warnings.every((line) => !line.includes("127.0.0.1") && !/\bb\b"/u.test(line)), "warnings name settings, never values");
  assert.throws(() => objectStoreKnowledgeOptions({ ...retired, S3_SECRET_KEY: "other" }),
    /S3_SECRET_KEY and its retired name AGENTIC_KNOWLEDGE_S3_SECRET_KEY are both set, to different values/u);
  assert.equal(s3Config({ AUDIT_S3_ENDPOINT: "http://127.0.0.1:9000", AUDIT_S3_BUCKET: "x", AUDIT_S3_ACCESS_KEY: "a", AUDIT_S3_SECRET_KEY: "s", ...retired }, "AUDIT_S3")?.bucket,
    "x", "a prefix of its own is a separate bucket and reads no retired names");
});
