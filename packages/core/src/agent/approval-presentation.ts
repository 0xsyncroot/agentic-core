import {
  AgenticError,
  MAX_APPROVAL_PRESENTATION_FIELDS,
  type ApprovalPresentation,
  type ApprovalPresentationField,
  type ToolPolicyDecision,
} from "@0xsyncroot/contracts";
import { sha256 } from "../hash.js";

const MAX_PRESENTATION_BYTES = 4_096;
const MAX_FIELDS = MAX_APPROVAL_PRESENTATION_FIELDS;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function text(value: unknown, name: string, maximum: number): string {
  if (typeof value !== "string") throw new AgenticError("validation", `${name} must be text`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) {
    throw new AgenticError("validation", `${name} must contain 1 to ${maximum} characters`);
  }
  return normalized;
}

function field(value: unknown, index: number): ApprovalPresentationField {
  const source = record(value);
  if (!source) throw new AgenticError("validation", `Approval presentation field ${index + 1} must be an object`);
  const itemValue = source.value;
  if (!["string", "number", "boolean"].includes(typeof itemValue) ||
      (typeof itemValue === "number" && !Number.isFinite(itemValue)) || String(itemValue).length > 256) {
    throw new AgenticError("validation", `Approval presentation field ${index + 1} has an invalid value`);
  }
  return Object.freeze({
    label: text(source.label, `Approval presentation field ${index + 1} label`, 80),
    value: itemValue as string | number | boolean,
  });
}

/** Copies only the public allowlist and applies delivery-size limits at the core boundary. */
export function snapshotApprovalPresentation(value: unknown): ApprovalPresentation {
  const source = record(value);
  if (!source) throw new AgenticError("validation", "Approval presentation must be an object");
  if (source.fields !== undefined && !Array.isArray(source.fields)) {
    throw new AgenticError("validation", "Approval presentation fields must be an array");
  }
  const rawFields = Array.isArray(source.fields) ? source.fields : [];
  if (rawFields.length > MAX_FIELDS) {
    throw new AgenticError("validation", `Approval presentation supports at most ${MAX_FIELDS} fields`);
  }
  const fields = rawFields.map(field);
  const presentation: ApprovalPresentation = Object.freeze({
    summary: text(source.summary, "Approval presentation summary", 800),
    action: text(source.action, "Approval presentation action", 160),
    target: text(source.target, "Approval presentation target", 320),
    impact: text(source.impact, "Approval presentation impact", 800),
    ...(fields.length ? { fields: Object.freeze(fields) } : {}),
  });
  if (Buffer.byteLength(JSON.stringify(presentation), "utf8") > MAX_PRESENTATION_BYTES) {
    throw new AgenticError("validation", `Approval presentation exceeds ${MAX_PRESENTATION_BYTES} bytes`);
  }
  return presentation;
}

/** Adds a deterministic presentation binding without changing approvals that have no presentation. */
export function bindApprovalPresentation(
  decision: ToolPolicyDecision,
): ToolPolicyDecision {
  const { approvalPresentation: policyPresentation, ...policyBinding } = decision;
  if (decision.outcome !== "require_approval") return Object.freeze(policyBinding);
  if (policyPresentation === undefined) return decision;
  const presentation = snapshotApprovalPresentation(policyPresentation);
  return Object.freeze({
    ...policyBinding,
    actionDigest: sha256({
      protocol: "agentic.approval-presentation/v1",
      authorizationActionDigest: decision.actionDigest,
      presentation,
    }),
    approvalPresentation: presentation,
  });
}
