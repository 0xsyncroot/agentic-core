import type { SessionContextView, SessionEvent } from "@0xsyncroot/contracts";
import { sha256 } from "../hash.js";

export const CONTEXT_CHECKPOINT_FORMAT_VERSION = 1;
export const CONVERSATION_PROJECTOR_REVISION = "conversation-projector-v1";

export function validContextCheckpoint(checkpoint: SessionEvent): boolean {
  if (checkpoint.type !== "context/checkpoint") return false;
  const payload = checkpoint.payload as Record<string, unknown>;
  const summary = payload.summary;
  const covered = payload.coveredThroughSeq;
  if (typeof summary !== "string" || typeof payload.summaryHash !== "string" || payload.summaryHash !== sha256(summary)) return false;
  if (!Number.isInteger(covered) || Number(covered) < 0 || Number(covered) >= checkpoint.seq) return false;
  if (payload.formatVersion !== CONTEXT_CHECKPOINT_FORMAT_VERSION) return false;
  if (payload.projectorRevision !== CONVERSATION_PROJECTOR_REVISION) return false;
  return typeof payload.compactorRevision === "string" && typeof payload.inputDigest === "string";
}

export function validatedContextView(view: SessionContextView): SessionContextView | undefined {
  if (!view.checkpoint) return view;
  if (!validContextCheckpoint(view.checkpoint)) return undefined;
  const covered = Number((view.checkpoint.payload as Record<string, unknown>).coveredThroughSeq);
  const events = view.events.filter((event) => event.seq > covered);
  const hasRelevantGap = events[0] !== undefined && events[0].seq > covered + 1;
  return {
    checkpoint: view.checkpoint,
    events,
    ...(hasRelevantGap ? { truncatedBeforeSeq: events[0]!.seq } : {}),
  };
}
