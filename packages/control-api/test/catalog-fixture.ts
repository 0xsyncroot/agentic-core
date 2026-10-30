import { canonicalJson, type CatalogItemKind } from "@0xsyncroot/contracts";
import type { CatalogCheckItem } from "../src/index.js";

/** A small release that passes every check run without a build: one connector, group, tool, skill and profile. */

export const TOOL = {
  connector: "ledger", intent: "Ledger.Read", kind: "report", access: "read", sideEffect: "none", permission: ["ledger.read"], group: "ledger-read",
  traceLabel: "Reading the ledger", description: "Reads ledger rows for one period.", inputSchema: { type: "object", properties: { period: { type: "string" } } },
  timeoutMs: 5_000,
};
export const CONNECTOR = { kind: "intent-adapter", connection: "ledger-api" };
export const GROUP = { purpose: "Read the ledger.", order: 0, toolIds: ["ledger_read"] };

export const SKILL = `---
id: ledger.review
version: 1.0.0
name: Ledger review
description: Reviews a ledger period.
requiredTools:
  - ledger_read
done:
  - rows read => every row is reported
---
Read the ledger with ledger_read, then report each row.
<!-- closing -->
Report every row.
`;

export const PROFILE = `---
id: ledger-agent
version: 1.0.0
name: Ledger agent
description: Answers questions about a ledger.
preloadSkills:
  - ledger.review
---
You answer questions about the ledger.
`;

export function jsonItem(itemKind: CatalogItemKind, itemId: string, body: object): CatalogCheckItem {
  return { itemKind, itemId, body: canonicalJson(body) };
}

export function releaseItems(overrides: { readonly tool?: object; readonly skill?: string } = {}): CatalogCheckItem[] {
  return [
    jsonItem("connector", "ledger", CONNECTOR), jsonItem("group", "ledger-read", GROUP), jsonItem("tool", "ledger_read", overrides.tool ?? TOOL),
    { itemKind: "skill", itemId: "ledger.review", body: overrides.skill ?? SKILL }, { itemKind: "profile", itemId: "ledger-agent", body: PROFILE },
  ];
}
