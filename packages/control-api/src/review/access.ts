import type { AdminPrincipal, AdminPrincipalStore, MemberRole } from "@0xsyncroot/contracts";
import { ReviewRequestError } from "./errors.js";

/** The role that lets an operator list and read masked conversations. */
export const REVIEW_READER_ROLE = "review.reader";
/** The role that lets an operator read usage statistics. */
export const STATS_READER_ROLE = "stats.reader";
/** Every role a console route checks; signing in needs at least one of them, and each route still checks its own. */
export const CONSOLE_ROLE_NAMES: readonly string[] = [REVIEW_READER_ROLE, STATS_READER_ROLE];

/** What one operator may read under one role: every agent, or the agents named by their agent-scope grants of that role. */
export interface ReviewReach {
  readonly principal: AdminPrincipal;
  readonly roles: readonly string[];
  /** Undefined: every agent. */
  readonly agents?: ReadonlySet<string>;
}

/** Role names as `/me` shows them: a platform role by name, an agent role as `name@agent`. */
const roleName = (role: MemberRole) => (role.scopeKind === "platform" ? role.role : `${role.role}@${role.scopeId}`);

/** An authenticated principal and its role names, refused when it is not active or holds no console role. */
export async function consoleMember(principals: AdminPrincipalStore, principalId: string): Promise<Omit<ReviewReach, "agents">> {
  const principal = await principals.get(principalId);
  if (!principal || principal.status !== "active") throw new ReviewRequestError("forbidden", "principal is not active");
  const roles = await principals.roles(principalId);
  if (!roles.some((grant) => CONSOLE_ROLE_NAMES.includes(grant.role))) throw new ReviewRequestError("forbidden", "principal holds no console role");
  return { principal, roles: roles.map(roleName) };
}

/** Loads an authenticated principal's reach under `role`. A disabled or unknown principal, or one without the role, is refused. */
export async function reviewReach(principals: AdminPrincipalStore, principalId: string, role = REVIEW_READER_ROLE): Promise<ReviewReach> {
  const principal = await principals.get(principalId);
  if (!principal || principal.status !== "active") throw new ReviewRequestError("forbidden", "principal is not active");
  const roles = await principals.roles(principalId);
  const readers = roles.filter((grant) => grant.role === role);
  if (readers.length === 0) throw new ReviewRequestError("forbidden", `principal lacks ${role}`);
  const names = roles.map(roleName);
  if (readers.some((grant) => grant.scopeKind === "platform")) return { principal, roles: names };
  return { principal, roles: names, agents: new Set(readers.map((grant) => grant.scopeId)) };
}

/** True when the reach covers the agent's conversations. */
export const reaches = (reach: ReviewReach, agentId: string) => reach.agents === undefined || reach.agents.has(agentId);
