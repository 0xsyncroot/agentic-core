import { createHash } from "node:crypto";
import type { ReviewTranscriptEntry } from "@0xsyncroot/contracts";
import type { PersonalFieldConfig } from "../masking/config.js";
import { TURN_FACT_ENGINE_REVISION } from "../stats/turn-facts.js";
import type { TranscriptDraft, TranscriptWording } from "./transcript.js";

/** Bumped whenever the masking or transcript code changes what an entry holds for the same journal and configuration. */
export const TRANSCRIPT_ENGINE_REVISION = "2";

const digest = (text: string, chars: number) => createHash("sha256").update(text).digest("hex").slice(0, chars);

/** JSON with object keys sorted, so equal configurations give equal text whatever order their files list keys in. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * The projector revision: one value per transcript and turn-fact engine revision, personal-field configuration, wording and
 * pseudonym key (by its fingerprint, `ActorPseudonyms.keyFingerprint`). A change to any of them makes every stored
 * transcript and usage fact stale, so the projector rebuilds all sessions under a new mask version and saves their facts again.
 */
export function projectorRevision(fields: PersonalFieldConfig, wording: TranscriptWording, keyFingerprint: string): string {
  if (keyFingerprint === "") throw new Error("keyFingerprint must not be empty");
  return `m${TRANSCRIPT_ENGINE_REVISION}${digest(canonicalJson({ fields, wording, keyFingerprint, turnFacts: TURN_FACT_ENGINE_REVISION }), 8)}`;
}

/** What two builds of an entry must agree on to be the same entry; storage may drop absent optionals or re-print times. */
function entryKey(entry: TranscriptDraft | ReviewTranscriptEntry): string {
  return canonicalJson({
    entrySeq: entry.entrySeq, turnId: entry.turnId, answerIndex: entry.answerIndex ?? null, role: entry.role, bodyFormat: entry.bodyFormat,
    body: entry.body, toolLabels: (entry.toolLabels ?? []).map((tool) => [tool.toolId, tool.label]), maskedValues: entry.maskedValues,
    sourceHash: entry.sourceHash, at: Date.parse(entry.at),
  });
}

/**
 * The mask version a rebuilt transcript is filed under. Entries are immutable, so the stored version is kept only when it
 * has this revision and every stored entry equals the rebuilt one: the rebuild then only appends. Any changed entry (a tool
 * run that grew, a narration taken back, a value learnt later that masks an earlier sentence) gives a new version named
 * by the content, so rebuilding the same journal again names the same version.
 */
export function chooseMaskVersion(revision: string, entries: readonly TranscriptDraft[], stored?: { readonly version: string; readonly entries: readonly ReviewTranscriptEntry[] }): string {
  if (stored && stored.version.startsWith(`${revision}.`)) {
    const rebuilt = new Map(entries.map((entry) => [entry.entrySeq, entryKey(entry)]));
    if (stored.entries.every((entry) => rebuilt.get(entry.entrySeq) === entryKey(entry))) return stored.version;
  }
  return `${revision}.${digest(entries.map(entryKey).join("\n"), 10)}`;
}
