"""HTTP driver and PASS/FAIL recorder for `selftest.py`.

Spawns `http_server.py` — the same Streamable HTTP MCP server the backend calls — and posts
JSON-RPC to `/mcp`. The official client check is `test/http.test.mjs`.
"""
from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request


class Results:
    """Prints `[PASS]`/`[FAIL]` per assertion as it happens and gives a final pass/fail verdict."""

    def __init__(self) -> None:
        self.checks: list[tuple[str, bool]] = []

    def check(self, name: str, condition: bool, detail: str = "") -> None:
        status = "PASS" if condition else "FAIL"
        suffix = f" — {detail}" if detail else ""
        print(f"[{status}] {name}{suffix}")
        self.checks.append((name, bool(condition)))

    def summarize(self) -> bool:
        failed = [name for name, ok in self.checks if not ok]
        print(f"\n{len(self.checks) - len(failed)}/{len(self.checks)} checks passed")
        if failed:
            print("FAILED: " + "; ".join(failed))
        return not failed


class HttpClient:
    """One `http_server.py` process. `responses` keeps every JSON-RPC body it returned."""

    def __init__(self, script_dir: str, source_dir: str, extra_env: dict[str, str] | None = None) -> None:
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            port = probe.getsockname()[1]
        env = {
            **os.environ,
            "DOCUMENT_READERS_TOKEN": "h" * 40,
            "DOCUMENT_SOURCE_DIR": source_dir,
            "AGENTIC_ATTACHMENTS_DIR": "",
            "PYTHONDONTWRITEBYTECODE": "1",
            **(extra_env or {}),
            "DOCUMENT_READERS_PORT": str(port),
            "DOCUMENT_READERS_BIND_HOST": "127.0.0.1",
            "DOCUMENT_READERS_ALLOWED_HOSTS": "localhost,127.0.0.1",
        }
        self.token = env["DOCUMENT_READERS_TOKEN"]
        self.base = f"http://127.0.0.1:{port}"
        self.responses: list[str] = []
        self._next_id = 1
        self._stderr: list[str] = []
        self.proc = subprocess.Popen(
            [sys.executable, "http_server.py", "--local"], cwd=script_dir,
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True, env=env,
        )
        threading.Thread(target=self._drain, daemon=True).start()
        self._wait_ready()

    def _drain(self) -> None:
        if self.proc.stderr is None:
            return
        for line in self.proc.stderr:
            self._stderr.append(line)

    def _wait_ready(self) -> None:
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            if self.proc.poll() is not None:
                raise RuntimeError("reader exited before /healthz: " + "".join(self._stderr)[-500:])
            try:
                urllib.request.urlopen(self.base + "/healthz", timeout=0.2).close()
                return
            except (urllib.error.URLError, TimeoutError):
                time.sleep(0.05)
        raise TimeoutError("reader did not open /healthz")

    def request(self, method: str, params: dict | None = None, timeout: float = 5.0) -> dict:
        message_id = self._next_id
        self._next_id += 1
        response = self._post({"jsonrpc": "2.0", "id": message_id, "method": method, **({} if params is None else {"params": params})}, timeout)
        if response.get("id") != message_id:
            raise AssertionError(f"response id {response.get('id')!r} did not match request id {message_id!r}")
        return response

    def notify(self, method: str, params: dict | None = None) -> None:
        self._post({"jsonrpc": "2.0", "method": method, **({} if params is None else {"params": params})}, 5.0, expect_body=False)

    def _post(self, message: dict, timeout: float, expect_body: bool = True) -> dict:
        body = json.dumps(message).encode()
        request = urllib.request.Request(
            self.base + "/mcp", data=body, method="POST",
            headers={"Authorization": f"Bearer {self.token}", "Content-Type": "application/json"},
        )
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read().decode()
        if not expect_body:
            return {}
        self.responses.append(raw)
        return json.loads(raw)

    def close(self) -> None:
        if self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.proc.kill()


def result_of(response: dict, results: Results, name: str) -> dict | None:
    if "error" in response:
        results.check(name, False, f"got JSON-RPC error: {response['error']}")
        return None
    return response["result"]
