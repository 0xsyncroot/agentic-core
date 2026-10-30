import type { SecurityContext } from "./security-context.js";

/**
 * Request-scoped carrier for a credential that belongs to the authenticated principal rather than
 * to the deployment: the session handle a delivery adapter read off the request, which an adapter
 * needs when it calls a system of record *as that user*.
 *
 * It is deliberately not a field on SecurityContext. A SecurityContext is journaled, hashed into
 * principal bindings and handed to plugins; a bearer credential must be none of those things. An
 * implementation binds the value to one principal for the length of one request and revokes it when
 * that request ends, so detached async work cannot read it afterwards, and `current` returns
 * nothing unless the asking principal is the one the credential was bound to.
 */
export interface PrincipalCredentialScope<TCredential> {
  run<T>(
    security: SecurityContext,
    credential: TCredential | undefined,
    task: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T>;
  current(security: SecurityContext): TCredential | undefined;
}
