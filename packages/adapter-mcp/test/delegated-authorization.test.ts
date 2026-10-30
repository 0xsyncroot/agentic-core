import assert from "node:assert/strict";
import { test } from "node:test";
import { AgenticError, type PrincipalCredentialScope, type SecurityContext } from "@0xsyncroot/contracts";
import { createDelegatedPrincipalAuthorizationResolver, createMcpContextualHttpToolsPlugin } from "@0xsyncroot/adapter-mcp";

function credentialScope(bindings: Record<string, string>): PrincipalCredentialScope<string> {
  return {
    run: async (_security, _credential, task) => task(),
    current: (security) => bindings[security.actorId],
  };
}

function actor(actorId: string): SecurityContext {
  return { tenantId: "t", actorId, permissions: new Set(), correlationId: "c", purpose: "test" };
}

const context = { serverId: "example", endpoint: "https://mcp.example/mcp", agentProfileId: "default" };

test("delegated resolver exchanges once and reuses the cached token", async () => {
  const exchanges: string[] = [];
  const resolver = createDelegatedPrincipalAuthorizationResolver({
    credentials: credentialScope({ alice: "alice-session" }),
    exchange: { exchange: async (input) => { exchanges.push(input.credential); return { accessToken: "token-1", expiresInSeconds: 3600, partition: "acct-1" }; } },
  });
  const signal = new AbortController().signal;
  const first = await resolver.resolve({ ...context, security: actor("alice") }, signal);
  const second = await resolver.resolve({ ...context, security: actor("alice") }, signal);
  assert.deepEqual(exchanges, ["alice-session"]);
  assert.equal(first.partition, "acct-1");
  assert.equal(second.partition, "acct-1");
  assert.equal(await first.authProvider?.token(), "token-1");
  assert.equal(await second.authProvider?.token(), "token-1");
});

test("delegated resolver refreshes once the skew-adjusted expiry has passed", async () => {
  const realNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  try {
    let exchangeCount = 0;
    const resolver = createDelegatedPrincipalAuthorizationResolver({
      credentials: credentialScope({ alice: "alice-session" }),
      exchange: { exchange: async () => { exchangeCount += 1; return { accessToken: `token-${exchangeCount}`, expiresInSeconds: 100, partition: "acct-1" }; } },
      refreshSkewSeconds: 30,
    });
    const signal = new AbortController().signal;
    const first = await resolver.resolve({ ...context, security: actor("alice") }, signal);
    assert.equal(await first.authProvider?.token(), "token-1");
    now += 69_000; // inside the 70s skew-adjusted window: still fresh
    const stillCached = await resolver.resolve({ ...context, security: actor("alice") }, signal);
    assert.equal(await stillCached.authProvider?.token(), "token-1");
    assert.equal(exchangeCount, 1);
    now += 2_000; // past the skew-adjusted expiry
    const refreshed = await resolver.resolve({ ...context, security: actor("alice") }, signal);
    assert.equal(await refreshed.authProvider?.token(), "token-2");
    assert.equal(exchangeCount, 2);
  } finally {
    Date.now = realNow;
  }
});

test("onUnauthorized forces exactly one re-exchange and coalesces concurrent 401s", async () => {
  let exchangeCount = 0;
  const resolver = createDelegatedPrincipalAuthorizationResolver({
    credentials: credentialScope({ alice: "alice-session" }),
    exchange: { exchange: async () => { exchangeCount += 1; return { accessToken: `token-${exchangeCount}`, expiresInSeconds: 3600, partition: "acct-1" }; } },
  });
  const signal = new AbortController().signal;
  const resolved = await resolver.resolve({ ...context, security: actor("alice") }, signal);
  assert.equal(exchangeCount, 1);
  const onUnauthorized = resolved.authProvider?.onUnauthorized as ((ctx: unknown) => Promise<void>) | undefined;
  assert.ok(onUnauthorized);
  await Promise.all([onUnauthorized(undefined), onUnauthorized(undefined)]);
  assert.equal(exchangeCount, 2, "two concurrent 401s must coalesce into a single re-exchange, never a loop");
  assert.equal(await resolved.authProvider?.token(), "token-2");
});

test("a principal with no bound credential is denied, never falling back to an anonymous or service token", async () => {
  const resolver = createDelegatedPrincipalAuthorizationResolver({
    credentials: credentialScope({ alice: "alice-session" }),
    exchange: { exchange: async () => ({ accessToken: "token", expiresInSeconds: 3600, partition: "acct" }) },
  });
  await assert.rejects(
    () => resolver.resolve({ ...context, security: actor("ghost") }, new AbortController().signal),
    /no bound credential/i,
  );
});

test("two principals never share a token", async () => {
  const resolver = createDelegatedPrincipalAuthorizationResolver({
    credentials: credentialScope({ alice: "alice-session", bob: "bob-session" }),
    exchange: { exchange: async (input) => ({ accessToken: `token-${input.credential}`, expiresInSeconds: 3600, partition: `acct-${input.credential}` }) },
  });
  const signal = new AbortController().signal;
  const alice = await resolver.resolve({ ...context, security: actor("alice") }, signal);
  const bob = await resolver.resolve({ ...context, security: actor("bob") }, signal);
  assert.equal(await alice.authProvider?.token(), "token-alice-session");
  assert.equal(await bob.authProvider?.token(), "token-bob-session");
  assert.notEqual(alice.partition, bob.partition);
});

test("the same actorId under different permissions/roles/grantRevision is cached separately, not collapsed into one principal", async () => {
  // credentialScope here is keyed on actorId alone (a deliberately weak fixture, matching the test
  // above), so this isolates whether the resolver's own cache key — principalBinding, which folds
  // in permissions/roles/grantRevision too — actually separates these, not just distinct actorIds.
  let exchangeCount = 0;
  const resolver = createDelegatedPrincipalAuthorizationResolver({
    credentials: credentialScope({ alice: "alice-session" }),
    exchange: { exchange: async () => { exchangeCount += 1; return { accessToken: `token-${exchangeCount}`, expiresInSeconds: 3600, partition: `acct-${exchangeCount}` }; } },
  });
  const signal = new AbortController().signal;
  const readOnly: SecurityContext = { ...actor("alice"), permissions: new Set(["read"]) };
  const admin: SecurityContext = { ...actor("alice"), permissions: new Set(["admin"]), roles: ["ops"], grantRevision: "2" };
  const first = await resolver.resolve({ ...context, security: readOnly }, signal);
  const second = await resolver.resolve({ ...context, security: admin }, signal);
  assert.equal(exchangeCount, 2, "principalBinding must key the cache on more than actorId alone");
  assert.notEqual(await first.authProvider?.token(), await second.authProvider?.token());
});

test("the access token never appears in the plugin descriptor config or a thrown validation error", async () => {
  const secretToken = "super-secret-token";
  const resolver = createDelegatedPrincipalAuthorizationResolver({
    credentials: credentialScope({ alice: "alice-session" }),
    exchange: { exchange: async () => ({ accessToken: secretToken, expiresInSeconds: 3600, partition: "acct-1" }) },
  });
  const descriptor = createMcpContextualHttpToolsPlugin({
    serverId: "example", endpoint: "https://mcp.example/mcp", authorizationResolver: resolver,
  });
  // `descriptor.config` is a fixed object built at construction time, before resolve() has ever
  // run: checking it here without a real exchange first would pass trivially regardless of whether
  // the resolver leaks the token, so force a real exchange (and prove it happened) before asserting.
  const resolved = await resolver.resolve({ ...context, security: actor("alice") }, new AbortController().signal);
  assert.equal(await resolved.authProvider?.token(), secretToken);
  assert.equal(JSON.stringify(descriptor.config).includes(secretToken), false);

  const oversizedTokenResolver = createDelegatedPrincipalAuthorizationResolver({
    credentials: credentialScope({ alice: "alice-session" }),
    exchange: { exchange: async () => ({ accessToken: secretToken.repeat(1000), expiresInSeconds: 3600, partition: "acct-1" }) },
  });
  await assert.rejects(async () => {
    try {
      await oversizedTokenResolver.resolve({ ...context, security: actor("alice") }, new AbortController().signal);
    } catch (error) {
      assert.equal(String(error).includes(secretToken), false);
      throw error;
    }
  }, /invalid access token/i);
});

test("a token exchange that omits the partition is rejected as an agentic error, not a TypeError", async () => {
  const resolver = createDelegatedPrincipalAuthorizationResolver({
    credentials: credentialScope({ alice: "alice-session" }),
    exchange: { exchange: async () => ({ accessToken: "token-1", expiresInSeconds: 3600 } as never) },
  });
  await assert.rejects(
    () => resolver.resolve({ ...context, security: actor("alice") }, new AbortController().signal),
    (error: unknown) => error instanceof AgenticError && error.code === "permanent" && /invalid partition/.test(error.message),
  );
});

test("a hanging token exchange is cut off by exchangeTimeoutMs instead of wedging the caller", async () => {
  let aborted = false;
  const resolver = createDelegatedPrincipalAuthorizationResolver({
    credentials: credentialScope({ alice: "alice-session" }),
    exchangeTimeoutMs: 40,
    exchange: {
      exchange: async (_input, signal) => new Promise((_resolve, reject) => {
        // Holds the loop open the way a real exchange's socket would, so this test exercises the
        // ordinary path rather than the drain. The bound timer in `exchangeFresh` is ref'd and does
        // not need the help — `AbortSignal.timeout` would have, which is why it is not used there.
        const keepAlive = setTimeout(() => undefined, 5_000);
        signal.addEventListener("abort", () => {
          clearTimeout(keepAlive);
          aborted = true;
          reject(signal.reason as Error);
        }, { once: true });
      }),
    },
  });
  await assert.rejects(() => resolver.resolve({ ...context, security: actor("alice") }, new AbortController().signal));
  assert.equal(aborted, true, "the exchange must observe the bounded signal");
});

test("an expired token is refreshed by token() without the server having to answer 401", async () => {
  const realNow = Date.now;
  let now = 2_000_000;
  Date.now = () => now;
  try {
    let exchangeCount = 0;
    const resolver = createDelegatedPrincipalAuthorizationResolver({
      credentials: credentialScope({ alice: "alice-session" }),
      exchange: { exchange: async () => { exchangeCount += 1; return { accessToken: `token-${exchangeCount}`, expiresInSeconds: 60, partition: "acct-1" }; } },
      refreshSkewSeconds: 10,
    });
    const resolved = await resolver.resolve({ ...context, security: actor("alice") }, new AbortController().signal);
    assert.equal(await resolved.authProvider?.token(), "token-1");
    // Past the skew-adjusted expiry, with no further resolve() and no 401: the pooled client's own
    // token() call is what must notice, or it would present nothing and fail on a 403 server.
    now += 51_000;
    assert.equal(await resolved.authProvider?.token(), "token-2");
    assert.equal(exchangeCount, 2);
  } finally {
    Date.now = realNow;
  }
});
