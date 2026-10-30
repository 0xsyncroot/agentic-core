import assert from "node:assert/strict";
import { test } from "node:test";
import type { SecurityContext } from "@0xsyncroot/contracts";
import { AsyncLocalPrincipalCredentialScope } from "@0xsyncroot/plugins-base";

function security(overrides: Partial<SecurityContext> = {}): SecurityContext {
  return {
    tenantId: "tenant-a", actorId: "user-a", permissions: new Set(["*"]),
    correlationId: "credential-test", purpose: "test", ...overrides,
  };
}

test("current returns the bound credential only inside run, for the principal it was bound to", async () => {
  const scope = new AsyncLocalPrincipalCredentialScope<string>();
  const owner = security();
  assert.equal(scope.current(owner), undefined, "nothing is bound before run");
  const seenDuring = await scope.run(owner, "token-1", async () => scope.current(owner));
  assert.equal(seenDuring, "token-1");
  assert.equal(scope.current(owner), undefined, "the binding is revoked once run settles");
});

test("current is undefined for a principal the credential was not bound to", async () => {
  const scope = new AsyncLocalPrincipalCredentialScope<string>();
  const owner = security();
  const otherTenant = security({ tenantId: "tenant-b" });
  const otherActor = security({ actorId: "user-b" });
  const otherGrant = security({ grantRevision: "grant-2" });
  await scope.run(owner, "token-1", async () => {
    assert.equal(scope.current(owner), "token-1");
    assert.equal(scope.current(otherTenant), undefined);
    assert.equal(scope.current(otherActor), undefined);
    assert.equal(scope.current(otherGrant), undefined);
  });
});

test("grantRevision defaults to 'unspecified' on both sides of the match", async () => {
  const scope = new AsyncLocalPrincipalCredentialScope<string>();
  const owner = security();
  await scope.run(owner, "token-1", async () => {
    assert.equal(scope.current(security({ grantRevision: undefined })), "token-1");
    assert.equal(scope.current(security({ grantRevision: "unspecified" })), "token-1");
  });
});

test("a credential is dropped, not just hidden, once run settles: detached work started under it reads nothing", async () => {
  const scope = new AsyncLocalPrincipalCredentialScope<string>();
  const owner = security();
  let readAfterSettle: (() => string | undefined) | undefined;
  await scope.run(owner, "token-1", async () => {
    // Captures a closure the way a detached background task would, without awaiting it.
    readAfterSettle = () => scope.current(owner);
  });
  assert.equal(readAfterSettle?.(), undefined);
});

test("an aborted signal revokes the binding immediately, before the task itself settles", async () => {
  const scope = new AsyncLocalPrincipalCredentialScope<string>();
  const owner = security();
  const controller = new AbortController();
  let duringAbort: string | undefined;
  const pending = scope.run(owner, "token-1", async () => {
    await new Promise<void>((resolve) => {
      controller.signal.addEventListener("abort", () => {
        duringAbort = scope.current(owner);
        resolve();
      }, { once: true });
    });
  }, controller.signal);
  controller.abort();
  await pending;
  assert.equal(duringAbort, undefined, "the abort listener revokes before the task's own continuation runs");
  assert.equal(scope.current(owner), undefined);
});

test("a signal already aborted before run starts establishes a revoked binding, and the task still runs", async () => {
  const scope = new AsyncLocalPrincipalCredentialScope<string>();
  const owner = security();
  const controller = new AbortController();
  controller.abort();
  let ran = false;
  const seen = await scope.run(owner, "token-1", async () => {
    ran = true;
    return scope.current(owner);
  }, controller.signal);
  assert.equal(ran, true);
  assert.equal(seen, undefined);
});

test("run with credential undefined establishes an empty scope, and the task still runs", async () => {
  const scope = new AsyncLocalPrincipalCredentialScope<string>();
  const owner = security();
  let ran = false;
  const seen = await scope.run(owner, undefined, async () => {
    ran = true;
    return scope.current(owner);
  });
  assert.equal(ran, true);
  assert.equal(seen, undefined);
});

test("a nested run shadows the outer binding for its own duration and the outer resumes after", async () => {
  const scope = new AsyncLocalPrincipalCredentialScope<string>();
  const owner = security();
  await scope.run(owner, "outer", async () => {
    assert.equal(scope.current(owner), "outer");
    await scope.run(owner, "inner", async () => {
      assert.equal(scope.current(owner), "inner");
    });
    assert.equal(scope.current(owner), "outer", "the outer binding is restored once the inner one settles");
  });
  assert.equal(scope.current(owner), undefined);
});

test("a task's own error still revokes the binding", async () => {
  const scope = new AsyncLocalPrincipalCredentialScope<string>();
  const owner = security();
  await assert.rejects(scope.run(owner, "token-1", async () => { throw new Error("boom"); }), /boom/);
  assert.equal(scope.current(owner), undefined);
});
