import { S3ObjectStore, S3_ENV_PREFIX, normalizeKeyPrefix, s3Config, type S3Config } from "@0xsyncroot/adapter-s3";
import { noticeOnce, readSetting } from "@0xsyncroot/env-settings";
import type { KnowledgeDocument } from "@0xsyncroot/contracts";
import { createKnowledgeDocument } from "@0xsyncroot/plugins-base";
import { loadLocalMarkdownKnowledge } from "./local-markdown-knowledge-loader.js";

const MAX_DOCUMENT_BYTES = 1_000_000;
const MAX_DOCUMENTS = 500;

/** Load Markdown knowledge from object storage at startup. Corpus updates require runtime reconstruction; this loader does not provide live reload. S3 transport remains in the shared adapter. */
export interface ObjectStoreKnowledgeOptions {
  readonly config: S3Config;
  readonly prefix: string;
}

/** Resolve shared S3 configuration and corpus prefix, or return undefined when no object-store corpus is selected. */
export function objectStoreKnowledgeOptions(env: NodeJS.ProcessEnv): ObjectStoreKnowledgeOptions | undefined {
  const config = s3Config(env, S3_ENV_PREFIX);
  if (!config) return undefined;
  const prefix = normalizeKeyPrefix(readSetting(env, "S3_PREFIX", { legacy: ["AGENTIC_KNOWLEDGE_S3_PREFIX"] }));
  if (!prefix) {
    noticeOnce("knowledge-prefix", "S3_PREFIX is not set: no knowledge corpus is read from object storage (only a named folder is ever read)");
    return undefined;
  }
  return { config, prefix };
}

export async function loadObjectStoreKnowledge(
  options: ObjectStoreKnowledgeOptions,
): Promise<readonly KnowledgeDocument[]> {
  const store = new S3ObjectStore(options.config);
  const objects = (await store.list(options.prefix)).filter((item) => item.key.endsWith(".md"));
  if (objects.length > MAX_DOCUMENTS) {
    throw new Error(`Knowledge prefix holds ${objects.length} documents, over the ${MAX_DOCUMENTS} cap`);
  }

  const documents: KnowledgeDocument[] = [];
  for (const object of objects) {
    const content = await store.getText(object.key, MAX_DOCUMENT_BYTES);
    // Citations expose a resolvable bucket/key reference rather than an opaque internal identifier.
    const sourceRef = `s3://${store.bucket}/${object.key}`;
    documents.push(createKnowledgeDocument({
      id: sourceRef,
      // Use the first Markdown heading, or the filename when no heading is present.
      title: content.match(/^#\s+(.+)$/mu)?.[1]?.trim() ?? object.key.split("/").pop()!.replace(/\.md$/u, ""),
      content,
      sourceRef,
      classification: "internal",
    }));
  }
  return documents;
}

/** Select configured object storage or development-only local files. Production refuses disk-backed knowledge before reading the filesystem, preventing silent use of stale image content. */
export async function loadKnowledgeDocuments(
  localRoots: readonly string[],
  profile: "development" | "production" = "development",
  env: NodeJS.ProcessEnv = process.env,
): Promise<readonly KnowledgeDocument[]> {
  const options = objectStoreKnowledgeOptions(env);
  if (options) return loadObjectStoreKnowledge(options);
  if (profile === "production" && localRoots.length > 0) {
    throw new Error(
      "Object storage is required for the knowledge corpus when AGENTIC_RUNTIME_PROFILE=production: "
      + `set S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY, S3_SECRET_KEY and S3_PREFIX (currently reading ${localRoots.join(", ")} from disk). `
      + "A corpus baked into the image is the copy from the last build, and nothing downstream can tell it apart from the one you uploaded.",
    );
  }
  return loadLocalMarkdownKnowledge(localRoots);
}
