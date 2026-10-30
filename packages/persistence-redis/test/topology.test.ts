import { after, before, describe } from "node:test";
import { RedisSessionStore } from "../src/index.js";
import { conformance } from "../../contracts/test/session-store-conformance.js";
import {
  showingCause, startThrowawayCluster, startThrowawaySentinel, topologyUnavailable, type ThrowawayTopology,
} from "../../redis-connection/test/topology-servers.js";

/**
 * The shared SessionStore conformance suite against Redis Cluster and Redis Sentinel.
 * Each session's keys share a hash tag, so every script touches one node; the stores are built the
 * way production builds them, from a URL.
 */
function suite(name: string, start: () => Promise<ThrowawayTopology>): void {
  describe(`redis session store over ${name}`, { skip: topologyUnavailable() ?? false }, () => {
    let server: ThrowawayTopology; let store: Awaited<ReturnType<typeof RedisSessionStore.connect>>;
    before(async () => {
      server = await start();
      store = await RedisSessionStore.connect({ url: server.url, allowInsecureInternal: true });
    });
    after(async () => { await store?.close(); await server?.stop(); });

    conformance(`redis ${name}`, () => showingCause(store));
  });
}

suite("cluster", startThrowawayCluster);
suite("sentinel", startThrowawaySentinel);
