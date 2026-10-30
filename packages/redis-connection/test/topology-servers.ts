import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createClient } from "redis";

const SCRATCH = process.env.AGENTIC_TEST_SCRATCH ?? tmpdir();

export interface ThrowawayTopology { readonly url: string; stop(): Promise<void> }

/** Why the cluster and sentinel tests cannot run here, or undefined when they can. */
export function topologyUnavailable(): string | undefined {
  for (const binary of ["redis-server", "redis-cli"]) {
    if (spawnSync(binary, ["--version"], { stdio: "ignore" }).status !== 0) return `${binary} is not installed`;
  }
  return undefined;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(typeof address === "object" && address ? address.port : 0));
    });
  });
}

async function waitFor(check: () => Promise<boolean>, what: string, timeoutMs = 20_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    try { if (await check()) return; } catch { /* not ready */ }
    if (performance.now() > deadline) throw new Error(`${what} did not become ready`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function ping(port: number): Promise<boolean> {
  const probe = createClient({ url: `redis://127.0.0.1:${port}`, socket: { reconnectStrategy: false } });
  probe.on("error", () => undefined);
  try { await probe.connect(); await probe.ping(); return true; } finally { probe.destroy(); }
}

function cli(...args: string[]): string {
  const result = spawnSync("redis-cli", args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`redis-cli ${args[0]} failed: ${result.stdout}${result.stderr}`);
  return result.stdout;
}

class Group {
  readonly children: ChildProcess[] = [];
  readonly dir = (mkdirSync(SCRATCH, { recursive: true }), mkdtempSync(join(SCRATCH, "topology-")));
  start(args: string[], cwd: string): void {
    this.children.push(spawn("redis-server", args, { cwd, stdio: "ignore" }));
  }
  async stop(): Promise<void> {
    const exits = this.children.map((child) => child.exitCode !== null ? Promise.resolve() : new Promise((resolve) => child.once("exit", resolve)));
    for (const child of this.children) child.kill("SIGKILL");
    await Promise.all(exits);
    rmSync(this.dir, { recursive: true, force: true });
  }
}

/** Three masters, no replicas, 16384 slots split between them. */
export async function startThrowawayCluster(): Promise<ThrowawayTopology> {
  const group = new Group();
  try {
    const ports: number[] = [];
    for (let index = 0; index < 3; index += 1) {
      const port = await freePort();
      const busPort = await freePort();
      const dir = join(group.dir, `node-${index}`);
      mkdirSync(dir);
      group.start([
        "--port", String(port), "--bind", "127.0.0.1", "--save", "", "--appendonly", "no", "--dir", dir,
        "--cluster-enabled", "yes", "--cluster-config-file", "nodes.conf", "--cluster-node-timeout", "5000",
        "--cluster-port", String(busPort),
      ], dir);
      ports.push(port);
    }
    for (const port of ports) await waitFor(() => ping(port), `cluster node ${port}`);
    cli("--cluster", "create", ...ports.map((port) => `127.0.0.1:${port}`), "--cluster-replicas", "0", "--cluster-yes");
    // Each master leaves cluster_state:fail on its own schedule and answers CLUSTERDOWN until then, which node-redis does
    // not retry, so the first command after startup fails if only one node was asked.
    for (const port of ports) await waitFor(async () => /cluster_state:ok/u.test(cli("-p", String(port), "cluster", "info")), `cluster state of node ${port}`);
    await waitFor(async () => cli("-p", String(ports[2]), "cluster", "nodes").trim().split("\n").length === 3, "cluster gossip");
    return { url: `redis+cluster://${ports.map((port) => `127.0.0.1:${port}`).join(",")}`, stop: () => group.stop() };
  } catch (error) {
    await group.stop();
    throw error;
  }
}

/** One master and one sentinel that watches it under the name `mymaster`. */
export async function startThrowawaySentinel(masterName = "mymaster"): Promise<ThrowawayTopology & { readonly masterName: string }> {
  const group = new Group();
  try {
    const [master, sentinel] = [await freePort(), await freePort()];
    group.start(["--port", String(master), "--bind", "127.0.0.1", "--save", "", "--appendonly", "no", "--dir", group.dir], group.dir);
    await waitFor(() => ping(master), "sentinel master");
    const configFile = join(group.dir, "sentinel.conf");
    writeFileSync(configFile, [
      `port ${sentinel}`, "bind 127.0.0.1", `dir ${group.dir}`,
      `sentinel monitor ${masterName} 127.0.0.1 ${master} 1`, `sentinel down-after-milliseconds ${masterName} 2000`, "",
    ].join("\n"));
    group.start([configFile, "--sentinel"], group.dir);
    await waitFor(() => ping(sentinel), "sentinel");
    await waitFor(async () => cli("-p", String(sentinel), "sentinel", "get-master-addr-by-name", masterName).includes(String(master)), "sentinel master lookup");
    return { url: `redis+sentinel://127.0.0.1:${sentinel}/${masterName}`, masterName, stop: () => group.stop() };
  } catch (error) {
    await group.stop();
    throw error;
  }
}

const causeOf = (error: unknown): unknown => typeof error === "object" && error !== null ? (error as { cause?: unknown }).cause : undefined;

/**
 * `node:test` prints the message of a failed test and drops `error.cause`, so a wrapper such as "could not reach its
 * quota store" hides the Redis reply under it. The same error, class and code kept (the conformance suite asserts on
 * both), with the cause chain appended to its message once.
 */
function withCause(error: unknown): unknown {
  const chain: string[] = [];
  for (let cause = causeOf(error); cause !== undefined && chain.length < 8; cause = causeOf(cause)) chain.push(cause instanceof Error ? cause.message : String(cause));
  if (chain.length === 0 || !(error instanceof Error) || error.message.includes("\n  cause: ")) return error;
  error.message = `${error.message}\n  cause: ${chain.join("\n  cause: ")}`;
  return error;
}

/** `test` whose failure shows the cause chain. */
export function topologyTest(name: string, run: (context: TestContext) => Promise<void>): void {
  test(name, async (context) => {
    try { await run(context); } catch (error) { throw withCause(error); }
  });
}

/** `target` whose rejected calls show the cause chain, for suites that register their own tests (the conformance suite). */
export function showingCause<T extends object>(target: T): T {
  return new Proxy(target, {
    get(object, key) {
      const value: unknown = Reflect.get(object, key, object);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const result: unknown = value.apply(object, args);
        return result instanceof Promise ? result.catch((error: unknown) => { throw withCause(error); }) : result;
      };
    },
  });
}
