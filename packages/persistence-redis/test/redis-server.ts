import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { createClient } from "redis";

const SCRATCH = "/tmp/claude-0/-root-develop-sample-app-agentic/b6d2cfe4-53ba-452a-ae89-d4512c24ad38/scratchpad";

export interface ThrowawayRedis { readonly url: string; stop(): Promise<void> }

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

export function redisServerAvailable(): boolean {
  return spawnSync("redis-server", ["--version"], { stdio: "ignore" }).status === 0;
}

/** A server nobody else uses: random port, no snapshot, no append-only file, data dir under the scratchpad. */
export async function startThrowawayRedis(): Promise<ThrowawayRedis> {
  mkdirSync(SCRATCH, { recursive: true });
  const dir = mkdtempSync(join(SCRATCH, "redis-"));
  const port = await freePort();
  const child: ChildProcess = spawn("redis-server", [
    "--port", String(port), "--bind", "127.0.0.1", "--save", "", "--appendonly", "no", "--dir", dir,
  ], { stdio: "ignore" });
  const url = `redis://127.0.0.1:${port}`;
  const deadline = Date.now() + 10_000;
  for (;;) {
    const probe = createClient({ url, socket: { reconnectStrategy: false } });
    probe.on("error", () => undefined);
    try {
      await probe.connect();
      await probe.ping();
      probe.destroy();
      break;
    } catch {
      probe.destroy();
      if (Date.now() > deadline) { child.kill("SIGKILL"); throw new Error("throwaway redis-server did not start"); }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  return {
    url,
    async stop() {
      child.kill("SIGKILL");
      await new Promise((resolve) => child.once("exit", resolve));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
