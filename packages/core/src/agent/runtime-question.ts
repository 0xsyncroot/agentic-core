import { randomUUID } from "node:crypto";
import {
  RUNTIME_REQUESTER_ID,
  type EventDraft,
  type FormInteractionRequest,
  type HumanInteractionAction,
  type HumanInteractionChallenge,
  type JsonValue,
  type RuntimeSnapshot,
  type SecurityContext,
} from "@0xsyncroot/contracts";
import { sha256 } from "../hash.js";
import { toJsonValue } from "./json-value.js";

/**
 * A product's words for the one question the runtime asks on its own: whether to go on with a task
 * its own limit stopped — the step allowance, or the work-remains gate's bound on laps that brought
 * nothing new. Core writes no user-facing copy, so a product that supplies none is never asked it.
 */
export interface ContinueQuestionWording {
  /** The question: the card's message and the title of its one tab. */
  readonly question: string;
  /** The card's title; the widget's own heading when absent. */
  readonly title?: string;
  readonly continueLabel: string;
  readonly stopLabel: string;
  /** What the turn says when the user chooses to stop: the runtime ends it without calling the model. */
  readonly stopped: string;
}

/** The one field of the question, and the value of each answer. */
const FIELD = "next";
export type ContinueChoice = "continue" | "stop";

/** The question as a form: one required choice, so the card has one tab and then its review tab. */
export function continueQuestionRequest(wording: ContinueQuestionWording): FormInteractionRequest {
  return Object.freeze({
    kind: "form", message: wording.question, ...(wording.title ? { title: wording.title } : {}),
    requestedSchema: toJsonValue({
      type: "object", required: [FIELD],
      properties: { [FIELD]: { type: "string", title: wording.question, oneOf: [
        { const: "continue", title: wording.continueLabel }, { const: "stop", title: wording.stopLabel },
      ] } },
    }),
  });
}

/** Continue only on an accepted "continue": a skipped or dismissed question stops, as "stop" does. */
export function continueChoice(action: HumanInteractionAction, content: JsonValue | undefined): ContinueChoice {
  const value = content && typeof content === "object" && !Array.isArray(content) ? content[FIELD] : undefined;
  return action === "accept" && value === "continue" ? "continue" : "stop";
}

export interface RuntimeQuestionContext {
  readonly sessionId: string;
  readonly turnId: string;
  readonly stepId: string;
  readonly request: FormInteractionRequest;
  readonly runtime: RuntimeSnapshot;
  readonly runtimeRouteRevision: string;
  readonly security: SecurityContext;
  readonly agentProfileId?: string;
  readonly ttlMs: number;
}

/**
 * The question's challenge and its `interaction/requested` draft. Bound like a tool's question to
 * the person, grants, runtime, route, policy and profile it was raised under — so the same resume
 * checks apply — but to no call: there is none, and its digest is the question's own.
 */
export function createRuntimeQuestion(context: RuntimeQuestionContext): {
  readonly challenge: HumanInteractionChallenge;
  readonly draft: EventDraft;
} {
  const interactionId = randomUUID();
  const expiresAt = new Date(Date.now() + context.ttlMs).toISOString();
  const binding = {
    actionDigest: sha256(context.request), policyRevision: context.runtime.policyRevision,
    runtimeSnapshotId: context.runtime.id, runtimeRouteRevision: context.runtimeRouteRevision,
    agentProfileId: context.agentProfileId ?? "default", grantRevision: context.security.grantRevision ?? "unspecified", expiresAt,
  };
  const challenge: HumanInteractionChallenge = Object.freeze({
    ...context.request, ...binding, interactionId, sessionId: context.sessionId, turnId: context.turnId,
    callId: "", toolId: RUNTIME_REQUESTER_ID, requesterId: RUNTIME_REQUESTER_ID,
  });
  return {
    challenge,
    draft: {
      type: "interaction/requested", turnId: context.turnId, stepId: context.stepId, classification: "confidential",
      payload: toJsonValue({
        interactionId, requesterId: RUNTIME_REQUESTER_ID, request: context.request, ...binding, requestedBy: context.security.actorId,
      }),
    },
  };
}

/** What the model reads for the user's answer: their choice, in the runtime's words — never as words they typed. */
export const CONTINUE_CHOICE_MESSAGES: Readonly<Record<ContinueChoice, string>> = Object.freeze({
  continue: "The user chose to continue the remaining work of this task. Go on from where it stopped.",
  stop: "The user chose to stop this task here; its remaining work was left undone.",
});
