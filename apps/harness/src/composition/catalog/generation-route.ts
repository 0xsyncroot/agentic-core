import { createHash } from "node:crypto";
import { AgenticError, canonicalJson, type JsonValue } from "@0xsyncroot/contracts";
import type { PluginDescriptor } from "@0xsyncroot/plugin-sdk";

/**
 * What makes one catalog generation: the release it serves, the infra snapshot it re-exports and the tool switches it was
 * built for. It is the config of the generation's identity descriptor, so the generation's snapshot id is a function of it
 * and of the descriptors the generation mounts: the same infra and the same release give the same id on every pod and rebuild.
 */
export interface GenerationIdentity {
  readonly agentId: string;
  readonly releaseId: string;
  readonly manifestHash: string;
  readonly infraSnapshotId: string;
  readonly switchesHash: string;
}

/** The release and switches a lease was built for, as the route revision names them. */
export interface GenerationRoute {
  readonly releaseId: string;
  readonly switchesHash: string;
}

const SEPARATOR = ":";

/** The hash of a tenant's tool switches (tool id → enabled), independent of their order. */
export function toolSwitchesHash(switches: Readonly<Record<string, boolean>>): string {
  const entries = Object.entries(switches).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return createHash("sha256").update(canonicalJson(entries)).digest("hex").slice(0, 32);
}

/** The switches of a tenant that turned no tool off or on: every tool of the release as the release says. */
export const NO_TOOL_SWITCHES_HASH = toolSwitchesHash({});

/**
 * `<deploy route revision>:<releaseId>:<switchesHash>`. The deploy revision may itself contain `:`, so the two catalog parts
 * are read from the right and may not contain one.
 */
export function generationRouteRevision(deployRevision: string, route: GenerationRoute): string {
  for (const [label, value] of [["releaseId", route.releaseId], ["switchesHash", route.switchesHash]] as const) {
    if (!value || value.includes(SEPARATOR)) {
      throw new AgenticError("permanent", `Catalog ${label} cannot be empty or contain "${SEPARATOR}"`);
    }
  }
  return `${deployRevision}${SEPARATOR}${route.releaseId}${SEPARATOR}${route.switchesHash}`;
}

/** The release and switches a pinned route revision names, or `undefined` when it is not one of this deployment's. */
export function parseGenerationRoute(deployRevision: string, routeRevision: string): GenerationRoute | undefined {
  const hashAt = routeRevision.lastIndexOf(SEPARATOR);
  if (hashAt <= 0) return undefined;
  const releaseAt = routeRevision.lastIndexOf(SEPARATOR, hashAt - 1);
  if (releaseAt <= 0) return undefined;
  const releaseId = routeRevision.slice(releaseAt + 1, hashAt);
  const switchesHash = routeRevision.slice(hashAt + 1);
  if (!releaseId || !switchesHash || routeRevision.slice(0, releaseAt) !== deployRevision) return undefined;
  return { releaseId, switchesHash };
}

/**
 * The generation's identity descriptor: it registers nothing, and its config is the generation identity, so the generation's
 * snapshot id names the release, the switches and the infra snapshot the generation re-exports.
 */
export function generationIdentityDescriptor(identity: GenerationIdentity): PluginDescriptor {
  const id = "io.syncroot.platform.catalog-generation";
  const config: Readonly<Record<string, JsonValue>> = { ...identity };
  return {
    trustTier: "platform-core",
    config,
    manifest: {
      manifestVersion: 1, id, version: "0.1.0", publisher: "Agentic Platform", coreApi: "^1.0.0",
      artifact: { digest: `builtin:${id}@0.1.0`, signature: "trusted-assembly" },
      requires: {}, provides: {}, permissions: {},
    },
    plugin: { validate: async () => ({ valid: true }), activate: async () => ({ dispose: () => undefined }) },
  };
}
