import type { SecurityContext } from "@0xsyncroot/contracts";
import { createBlankRuntime } from "./bootstrap.js";

const SESSION_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const args = process.argv.slice(2);
const sessionOption = args.find((value) => value.startsWith("--session="));
const sessionId = sessionOption?.slice("--session=".length) || `cli-${crypto.randomUUID()}`;
if (!SESSION_PATTERN.test(sessionId)) throw new Error("--session must be a valid session identifier");
const content = args.filter((value) => value !== sessionOption).join(" ").trim() || "Confirm that the agent runtime is working.";
const runtime = await createBlankRuntime();
const agentProfileId = runtime.agentProfile?.id ?? "default";
const security: SecurityContext = {
  tenantId: "local-dev",
  actorId: "local-user",
  // The CLI is an explicit local-development delivery adapter; production callers authenticate upstream.
  permissions: new Set(["*", "memory.read", "memory.propose", "memory.forget"]),
  correlationId: crypto.randomUUID(),
  purpose: "blank-harness",
  authentication: { issuer: "local-development", subject: "local-user", assurance: "development" },
  grantRevision: "local-development-v1",
  authorizedAgentProfiles: [agentProfileId],
};

try {
  const result = await runtime.agent.runTurn({
    sessionId,
    content,
    security,
    idempotencyKey: crypto.randomUUID(),
  });
  console.log(result.content);
  console.error(
    JSON.stringify({
      provider: runtime.model.providerId,
      storage: runtime.storage,
      knowledgeDocuments: runtime.knowledgeDocuments,
      runtimeSnapshotId: runtime.host.snapshot.id,
      sessionId: result.sessionId,
      turnId: result.turnId,
      outcome: result.outcome,
      usage: result.usage,
      // `RunTurnResult.events` holds only this turn's journal rows (see the RunTurnResult
      // docstring in @0xsyncroot/contracts), so the count below is this turn's, not the session's.
      turnEventCount: result.events.length,
    }),
  );
} finally {
  await runtime.close();
}
