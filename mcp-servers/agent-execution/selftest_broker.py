"""Transport regressions; parsing and grants remain owned by the shared reader."""
import io
import json
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
from broker import MAX_REQUEST_BYTES, serve
from file_store import FileStore
from session import Services, _build_dispatcher
from protocol import Dispatcher, ToolSpec
from fixtures import build_xlsx


class BrokerTests(unittest.TestCase):
    def test_malformed_input_notifications_and_bounded_frames(self):
        source = b'not-json\n' + b'x' * (MAX_REQUEST_BYTES + 1) + b'\n'
        source += b'{"method":"notifications/initialized"}\n'
        source += b'{"id":7,"method":"tools/list"}\n'
        output = io.StringIO()
        serve(io.BytesIO(source), output, _build_dispatcher(Services(documents=FileStore("unused"))))
        replies = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual(len(replies), 3)
        self.assertEqual([item["error"]["code"] for item in replies[:2]], [-32700, -32600])
        self.assertEqual(replies[2]["id"], 7)
        self.assertEqual(len(replies[2]["result"]["tools"]), 3)

    def test_metadata_remains_responsive_and_queue_is_bounded(self):
        released = threading.Event()
        def slow(_arguments, _call):
            self.assertTrue(released.wait(2))
            return {"structured": {"done": True}}
        dispatcher = Dispatcher({"slow": ToolSpec("slow", {"type": "object"}, {}, slow)}, None, lambda: [], lambda _: {})
        class Output(io.StringIO):
            def flush(self):
                if '"id": 99' in self.getvalue():
                    released.set()
        calls = [{"id": i, "method": "tools/call", "params": {"name": "slow", "arguments": {}}} for i in range(9)]
        calls.append({"id": 99, "method": "tools/list"})
        output = Output()
        serve(io.BytesIO(b"\n".join(json.dumps(call).encode() for call in calls)), output, dispatcher, workers=1)
        replies = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual(replies[0]["id"], 8)
        self.assertEqual(replies[0]["error"]["code"], -32000)
        self.assertEqual(replies[1]["id"], 99)
        self.assertEqual(len(replies), 10)

    def test_file_expiry_and_grants_use_the_shared_dispatcher(self):
        with tempfile.TemporaryDirectory() as directory:
            document_id = "a" * 32
            root = Path(directory)
            (root / document_id).write_bytes(build_xlsx({"Sample": [["Name", "Value"], ["Example", 42]]}))
            metadata = {"name": "sample.xlsx", "mediaType": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "expiresAt": time.time() * 1000 + 60_000}
            (root / f"{document_id}.json").write_text(json.dumps(metadata))
            services = Services(documents=FileStore(directory))
            dispatcher = _build_dispatcher(services)
            uri, _ = services.grants.mint("read_document", {"documentId": document_id}, lambda _: {})
            output = io.StringIO()
            serve(io.BytesIO(json.dumps({"id": 1, "method": "resources/read", "params": {"uri": uri}}).encode()), output, dispatcher)
            self.assertIn("result", json.loads(output.getvalue()))
            metadata["expiresAt"] = 0
            (root / f"{document_id}.json").write_text(json.dumps(metadata))
            output = io.StringIO()
            serve(io.BytesIO(json.dumps({"id": 2, "method": "resources/read", "params": {"uri": uri}}).encode()), output, dispatcher)
            self.assertIn("error", json.loads(output.getvalue()))


if __name__ == "__main__":
    unittest.main()
