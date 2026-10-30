#!/usr/bin/env python3
"""Execution gateway transport over the shared dispatcher and expiring file store."""
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import sys
import threading

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "document-readers"))
from file_store import FileStore
from protocol import handle_message
from session import Services, _build_dispatcher

MAX_REQUEST_BYTES = 1_048_576
MAX_OUTSTANDING = 8


def serve(input_stream, output_stream, dispatcher, workers=3):
    """Keep discovery responsive while a bounded pool performs document reads."""
    write_lock = threading.Lock()
    slots = threading.BoundedSemaphore(MAX_OUTSTANDING)

    def write(message):
        with write_lock:
            output_stream.write(json.dumps(message, ensure_ascii=False) + "\n")
            output_stream.flush()

    def dispatch(message):
        handled = handle_message(message, dispatcher)
        if handled.kind != "none":
            write({"jsonrpc": "2.0", "id": handled.id, handled.kind: getattr(handled, handled.kind)})

    def read(message):
        try:
            dispatch(message)
        finally:
            slots.release()

    with ThreadPoolExecutor(max_workers=workers) as pool:
        while True:
            line = input_stream.readline(MAX_REQUEST_BYTES + 1)
            if not line:
                break
            if len(line) > MAX_REQUEST_BYTES:
                while line and not line.endswith(b"\n"):
                    line = input_stream.readline(MAX_REQUEST_BYTES + 1)
                write({"jsonrpc": "2.0", "id": None, "error": {"code": -32600, "message": "Request exceeds the byte limit"}})
                continue
            try:
                message = json.loads(line)
            except (ValueError, UnicodeDecodeError):
                write({"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "Parse error"}})
                continue
            # Notifications have no reply and must not consume parsing slots.
            if not isinstance(message, dict) or "id" not in message:
                continue
            if message.get("method") in {"tools/call", "resources/read"}:
                if slots.acquire(blocking=False):
                    pool.submit(read, message)
                else:
                    write({"jsonrpc": "2.0", "id": message["id"], "error": {"code": -32000, "message": "Reader busy; retry later"}})
            else:
                dispatch(message)


if __name__ == "__main__":
    workers = int(os.environ.get("EXECUTION_READER_WORKERS", "3"))
    if not 1 <= workers <= MAX_OUTSTANDING:
        raise ValueError("EXECUTION_READER_WORKERS must be between 1 and 8")
    services = Services(documents=FileStore(os.environ["EXECUTION_FILES_DIR"]))
    serve(sys.stdin.buffer, sys.stdout, _build_dispatcher(services), workers)
