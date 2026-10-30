#!/usr/bin/env node
/**
 * Runs a Python script with extra environment variables, from either Windows cmd or a Unix shell.
 *
 * npm executes package.json scripts with cmd.exe on Windows, and cmd treats a leading
 * `NAME=value` as the program name — which is the error `'DOCUMENT_S3_ENV_PREFIX' is not
 * recognized`. This process applies those assignments itself and spawns Python with no shell,
 * so the same npm script works in both places. `python3` is the name on Ubuntu; Windows
 * installs usually answer to `py -3` or `python`.
 *
 *   node scripts/run-python.mjs NAME=value ... -- path/to/script.py [args]
 */
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

function usage() {
  console.error("usage: node scripts/run-python.mjs NAME=value ... -- script.py [args]");
  process.exit(1);
}

const argv = process.argv.slice(2);
const split = argv.indexOf("--");
if (split < 0 || split === argv.length - 1) usage();

const env = { ...process.env };
for (const item of argv.slice(0, split)) {
  const eq = item.indexOf("=");
  if (eq <= 0) usage();
  env[item.slice(0, eq)] = item.slice(eq + 1);
}
const scriptArgs = argv.slice(split + 1);

/** First interpreter that actually runs. A Windows Store alias can exist and still fail `--version`. */
async function pythonCommand() {
  const candidates = process.platform === "win32"
    ? [["py", "-3"], ["python"], ["python3"]]
    : [["python3"], ["python"]];
  for (const candidate of candidates) {
    try {
      await exec(candidate[0], [...candidate.slice(1), "--version"], { windowsHide: true });
      return candidate;
    } catch { /* this name is not a working Python 3 */ }
  }
  console.error("Python 3 was not found. On Ubuntu install python3; on Windows install Python and put `py` or `python` on PATH.");
  process.exit(1);
}

const command = await pythonCommand();
const child = spawn(command[0], [...command.slice(1), ...scriptArgs], { env, stdio: "inherit", windowsHide: true });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("error", (error) => {
  console.error(error.message);
  process.exit(1);
});
child.on("exit", (code) => process.exit(code ?? 1));
