import type { IncomingMessage } from "node:http";
import type { IdentityResolver, ResumableAgent, RunTurnResult, SecurityContext } from "@0xsyncroot/contracts";
import { resolveRequestIdentity } from "./identity-resolvers.js";
import { readInteractionInput, resolveInteraction } from "./interaction-api.js";

export async function resumeApproval(
  request: IncomingMessage, agent: ResumableAgent, identityResolver: IdentityResolver, approvalId: string,
  attributes?: Readonly<Record<string, string>>,
  runWithRequestScope?: (context: { readonly request: IncomingMessage; readonly security: SecurityContext }, task: () => Promise<RunTurnResult>) => Promise<RunTurnResult>,
): Promise<{ readonly result: RunTurnResult; readonly startedAt: number }> {
  const input = await readInteractionInput(request, "approval");
  const security = await resolveRequestIdentity(request, identityResolver, "agent-api-approval", undefined, attributes);
  const startedAt = performance.now();
  const task = () => resolveInteraction(agent, security, approvalId, input);
  const result = await (runWithRequestScope ? runWithRequestScope({ request, security }, task) : task());
  return { result, startedAt };
}
