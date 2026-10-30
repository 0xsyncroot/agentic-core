import type { ClaimedTurn } from "./claimed-turn.js";
import { report } from "./operation-observers.js";

/**
 * Takes in whatever the user said since the last step boundary, before the step reads anything.
 *
 * Journaled as `user/input` with `source: "interjection"` — the same event the turn's opening
 * message is, deliberately. That one decision is what makes the rest free: the conversation
 * projector already renders `user/input` as a user message, so the words reach the model in the
 * place they were actually said; history already shows it; the compactor already knows how to
 * treat a user message. A parallel channel into the step's transient feedback would have reached
 * the model too, and then been absent from the transcript the user, the auditor and the next turn
 * all read — a correction that changed the answer with nothing anywhere saying it was ever made.
 *
 * Appended before the step builds its context, since the journal view follows the writer: a
 * moment later and the words would apply a step late for no reason.
 *
 * `take()` clears what it returns, so a failed append loses those words. It is allowed to throw
 * for exactly that reason — the append failing means the session store is failing, the turn is
 * finished either way, and the user finds out. Silently dropping the sentence they typed to
 * correct the agent is the one outcome worth failing a turn to avoid.
 *
 * Nothing here bounds the text. That belongs at the edge that accepts it from the network, next
 * to the rest of the request validation and where a refusal can still reach the person who typed
 * it — the same place `content` itself is bounded, for the same reason.
 */
export async function recordInterjections(turn: ClaimedTurn, stepIndex: number, boundary = "before-model"): Promise<number> {
  await turn.input.interjections?.collect?.();
  const pending = turn.input.interjections?.take() ?? [];
  if (pending.length === 0) return 0;
  await turn.writer.append(
    pending.map((content) => ({ type: "user/input", turnId: turn.turnId, payload: { content, source: "interjection" } })),
    `interjections:${turn.turnId}:${stepIndex}:${boundary}`,
  );
  for (const content of pending) {
    report(turn.input, { type: "interjection-received", turnId: turn.turnId, step: stepIndex, content });
  }
  return pending.length;
}
