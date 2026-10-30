import { AgenticError, type ToolInvocation } from "@0xsyncroot/contracts";
import { MAX_ATTACHMENT_BYTES, type DocumentAttachmentSettings } from "./document-attachments.js";

/** Restore a durable attachment before a reader call. No object-store credentials cross to MCP. */
export function createDocumentToolPreparation(settings: DocumentAttachmentSettings) {
  const restores = new Map<string, Promise<void>>();
  return async (name: string, invocation: ToolInvocation, signal: AbortSignal): Promise<void> => {
    if (!["read_document", "read_table", "read_cells"].includes(name)) return;
    signal.throwIfAborted();
    const args = invocation.arguments;
    const documentId = args && typeof args === "object" && !Array.isArray(args) ? args.documentId : undefined;
    if (typeof documentId !== "string" || !/^[0-9a-f]{32}$/.test(documentId)) throw new AgenticError("validation", "Invalid document handle");
    if (!settings.store) throw new AgenticError("transient", "Document archive is unavailable", true);
    const key = settings.prefix + documentId;
    const metadata = await settings.store.stat(key).catch(() => {
      throw new AgenticError("transient", "Document archive could not be reached", true);
    });
    // Check ownership even when MCP already holds the file: cached bytes are not an authority.
    if (!metadata || metadata.tenant !== invocation.security.tenantId) throw new AgenticError("denied", "The document is unavailable to this account");
    if (!metadata.size || metadata.size > MAX_ATTACHMENT_BYTES) throw new AgenticError("validation", "The archived attachment is empty or exceeds 25 MiB");
    // The reader reads the archive itself: ownership is the only thing to settle before the call.
    if (!settings.execution) return;
    let restore = restores.get(documentId);
    if (!restore) {
      const { store, execution } = settings;
      // Shared by every caller waiting on this document, so it must not obey any one caller's signal.
      const own = AbortSignal.timeout(60_000);
      restore = (async () => {
        if (await execution.exists(documentId, own)) return;
        const bytes = await store.get(key).catch(() => {
          throw new AgenticError("transient", "Archived attachment could not be downloaded", true);
        });
        if (bytes.length !== metadata.size) throw new AgenticError("permanent", "Archived attachment size does not match its metadata");
        await execution.upload({ bytes, name: metadata.name, mediaType: metadata.mediaType }, documentId, own);
      })().finally(() => { restores.delete(documentId); });
      restores.set(documentId, restore);
    }
    // Each caller stops waiting on its own signal; the restore itself keeps going for the others.
    await Promise.race([restore, new Promise<never>((_, reject) => {
      const abort = () => reject(new AgenticError("cancelled", "Document restore was cancelled"));
      if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
    })]);
    signal.throwIfAborted();
  };
}
