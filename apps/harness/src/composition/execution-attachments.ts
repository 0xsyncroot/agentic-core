import { AgenticError } from "@0xsyncroot/contracts";
import type { StoredAttachment } from "./document-attachments.js";

/** Internal binary transfer: the execution service never receives an S3 URL or credential. */
export function executionFileTransfer(endpoint: string, token: string) {
  return async (file: Omit<StoredAttachment, "tenant">, documentId?: string, signal?: AbortSignal): Promise<string> => {
    if (documentId !== undefined && !/^[0-9a-f]{32}$/.test(documentId)) throw new AgenticError("validation", "Invalid document handle");
    try {
      const response = await fetch(documentId ? `${endpoint}/${documentId}` : endpoint, {
        method: documentId ? "PUT" : "POST", redirect: "error",
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
        headers: { authorization: `Bearer ${token}`, "content-type": file.mediaType,
          "x-file-name": encodeURIComponent(file.name.slice(0, 255)) },
        body: new Uint8Array(file.bytes),
      });
      if (!response.ok) {
        await response.body?.cancel();
        const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
        throw new AgenticError(retryable ? "transient" : "validation",
          `Execution file transfer returned HTTP ${response.status}`, retryable);
      }
      // Bound metadata in bytes, then decode once so UTF-8 characters can cross stream chunks.
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (response.body) for await (const chunk of response.body) {
        size += chunk.byteLength;
        if (size > 8192) throw new AgenticError("permanent", "Execution file metadata exceeds its limit");
        chunks.push(chunk);
      }
      let metadata: unknown;
      try { metadata = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; }
      catch { throw new AgenticError("permanent", "Invalid execution file metadata"); }
      const returnedId = metadata && typeof metadata === "object" && "documentId" in metadata
        ? metadata.documentId : undefined;
      if (typeof returnedId !== "string" || !/^[0-9a-f]{32}$/.test(returnedId) || (documentId && returnedId !== documentId)) {
        throw new AgenticError("permanent", "Execution file service returned an invalid handle");
      }
      return returnedId;
    } catch (error) {
      if (error instanceof AgenticError) throw error;
      if (signal?.aborted) throw new AgenticError("cancelled", "Execution file transfer was cancelled");
      throw new AgenticError("transient", "Execution file transfer is unavailable", true);
    }
  };
}

/** The remote service is a disposable cache; only a missing/expired file needs restoring. */
export function executionFileExists(endpoint: string, token: string) {
  return async (documentId: string, signal: AbortSignal): Promise<boolean> => {
    if (!/^[0-9a-f]{32}$/.test(documentId)) throw new AgenticError("validation", "Invalid document handle");
    try {
      const response = await fetch(`${endpoint}/${documentId}`, { method: "HEAD", redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]), headers: { authorization: `Bearer ${token}` } });
      if (response.status === 404 || response.status === 410) return false;
      if (response.ok) return Number(response.headers.get("x-file-expires-at")) > Date.now() + 120_000;
      throw new AgenticError("transient", `Execution file lookup returned HTTP ${response.status}`, true);
    } catch (error) {
      if (error instanceof AgenticError) throw error;
      if (signal.aborted) throw new AgenticError("cancelled", "Execution file lookup was cancelled");
      throw new AgenticError("transient", "Execution file lookup is unavailable", true);
    }
  };
}
