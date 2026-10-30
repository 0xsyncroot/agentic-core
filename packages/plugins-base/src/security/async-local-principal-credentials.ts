import { AsyncLocalStorage } from "node:async_hooks";
import type { PrincipalCredentialScope, SecurityContext } from "@0xsyncroot/contracts";

interface CredentialBinding<TCredential> {
  readonly tenantId: string;
  readonly actorId: string;
  readonly grantRevision: string;
  active: boolean;
  credential: TCredential | undefined;
}

/**
 * Generic `PrincipalCredentialScope` built on `node:async_hooks`, for any product that needs to
 * carry a bearer credential through one request without letting it outlive that request.
 *
 * `run` binds `credential` to the principal (tenantId + actorId + grantRevision, defaulting the
 * revision to "unspecified") for the duration of `task`, the same way a stack-scoped local would —
 * except it survives the async hops a plugin's tool call makes. The binding is revoked, both the
 * active flag and the credential value dropped, the instant `task` settles or `signal` aborts,
 * whichever comes first; a nested `run` (including one with `credential === undefined`, which still
 * runs `task`, just with nothing bound) shadows the outer binding for its own duration and restores
 * it afterwards, which is plain `AsyncLocalStorage` nesting. `current` only ever returns a value to
 * the principal it was bound to, so a plugin cannot read another tenant's or actor's credential
 * merely by running inside the same process.
 */
export class AsyncLocalPrincipalCredentialScope<TCredential> implements PrincipalCredentialScope<TCredential> {
  readonly #storage = new AsyncLocalStorage<CredentialBinding<TCredential> | undefined>();

  async run<T>(
    security: SecurityContext,
    credential: TCredential | undefined,
    task: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const binding: CredentialBinding<TCredential> | undefined = credential === undefined ? undefined : {
      tenantId: security.tenantId,
      actorId: security.actorId,
      grantRevision: security.grantRevision ?? "unspecified",
      active: true,
      credential,
    };
    const revoke = () => {
      if (!binding) return;
      binding.active = false;
      binding.credential = undefined;
    };
    if (signal?.aborted) revoke();
    else signal?.addEventListener("abort", revoke, { once: true });
    return this.#storage.run(binding, async () => {
      try { return await task(); }
      finally {
        signal?.removeEventListener("abort", revoke);
        revoke();
      }
    });
  }

  current(security: SecurityContext): TCredential | undefined {
    const binding = this.#storage.getStore();
    if (!binding?.active || binding.tenantId !== security.tenantId || binding.actorId !== security.actorId ||
        binding.grantRevision !== (security.grantRevision ?? "unspecified")) return undefined;
    return binding.credential;
  }
}
