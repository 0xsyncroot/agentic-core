"""Regression checks for diagnostics captured before protocol exception conversion."""
import contextlib
import io
import json
import socket as socket_module
import sys
import unittest
from concurrent import futures
from unittest.mock import MagicMock, patch

import fixtures
import http_server
from diagnostics import safe_text
from errors import ToolInputError
from file_source import FetchedDocument
from http_server import Executor, ReaderServer, _envelope
from protocol import Dispatcher, ToolSpec, handle_message
from session import Services, _build_dispatcher
from tool_catalog import build_tool_registry


def dispatcher(handler):
    return Dispatcher({"read_table": ToolSpec("test", {}, {}, handler)}, None, lambda: [], lambda _: {})


def message(rpc_id="rpc-19"):
    return {"jsonrpc": "2.0", "id": rpc_id, "method": "tools/call", "params": {
        "name": "read_table", "arguments": {"documentId": "doc-1", "sheet": "24-SNGD", "offset": 20,
        "maxRows": 30, "headerRow": 4, "credentials": "DO_NOT_LOG_ARGS", "cells": "DO_NOT_LOG_CELLS"}}}


class DiagnosticsTests(unittest.TestCase):
    def logged_call(self, handler):
        output = io.StringIO()
        executor = Executor(dispatcher(handler), 1)
        with contextlib.redirect_stderr(output):
            try:
                result = executor.call(message())
            finally:
                executor.pool.shutdown(wait=True)
        events = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual(len(events), 1)
        return result, events[0]

    def test_handled_tool_error_keeps_raise_site_and_code(self):
        def bad_input(_args, _call):
            raise ToolInputError("Column mapping does not match the header", code="column_mapping")
        result, event = self.logged_call(bad_input)
        self.assertTrue(result.result["isError"])
        self.assertEqual(event["error"]["type"], "ToolInputError")
        self.assertEqual(event["error"]["code"], "column_mapping")
        self.assertEqual(event["error"]["traceback"][-1]["function"], "bad_input")
        self.assertGreater(event["error"]["traceback"][-1]["line"], 0)
        self.assertEqual(event["sheet"], "24-SNGD")
        self.assertEqual(event["offset"], 20)
        self.assertEqual(event["rpcId"], "rpc-19")
        self.assertNotIn("DO_NOT_LOG", json.dumps(event))
        self.assertNotIn("traceback", json.dumps(_envelope(result)))

    def test_unexpected_exception_keeps_cause_without_changing_rpc_semantics(self):
        def crash(_args, _call):
            try:
                raise KeyError("missing parser state")
            except KeyError as cause:
                raise RuntimeError("Parser failed") from cause
        result, event = self.logged_call(crash)
        self.assertEqual(result.kind, "error")
        self.assertEqual(result.error["code"], -32603)
        self.assertEqual(event["error"]["type"], "RuntimeError")
        self.assertEqual(event["error"]["causes"][0]["type"], "KeyError")
        self.assertEqual(event["outcome"], "error")
        self.assertNotIn("traceback", json.dumps(_envelope(result)))

    def test_success_remains_quiet_and_calls_do_not_share_diagnostics(self):
        def handler(args, _call):
            if args.get("offset"):
                raise ToolInputError("Invalid page")
            return {"structured": {"rows": ["DO_NOT_LOG_ROWS"]}}
        source = dispatcher(handler)
        failed = handle_message(message(), source)
        good = message("ok")
        good["params"]["arguments"]["offset"] = 0
        succeeded = handle_message(good, source)
        self.assertIsNotNone(failed.diagnostic)
        self.assertIsNone(succeeded.diagnostic)
        result, event = self.logged_call(lambda _args, _call: {"structured": {"rows": ["DO_NOT_LOG_ROWS"]}})
        self.assertEqual(event["outcome"], "ok")
        self.assertNotIn("error", event)
        self.assertNotIn("DO_NOT_LOG", json.dumps(event))

    def test_messages_are_bounded_and_credentials_are_removed(self):
        with patch.dict("os.environ", {"DOCUMENT_READERS_TOKEN": "secret-test-token"}):
            text = safe_text("secret-test-token Bearer secret-bearer https://user:password@host/path?X-Amz-Signature=secret-signature")
            for secret in ["secret-test-token", "secret-bearer", "password", "secret-signature"]:
                self.assertNotIn(secret, text)
        self.assertEqual(len(safe_text("x" * 10_000)), 2000)

    def test_exception_escaping_dispatch_is_logged_and_still_raised(self):
        output = io.StringIO()
        executor = Executor(dispatcher(lambda _args, _call: {}), 1)
        with contextlib.redirect_stderr(output), patch("http_server.handle_message", side_effect=RuntimeError("dispatch broke")):
            try:
                with self.assertRaisesRegex(RuntimeError, "dispatch broke"):
                    executor.call(message())
            finally:
                executor.pool.shutdown(wait=True)
        event = json.loads(output.getvalue())
        self.assertEqual(event["error"]["type"], "RuntimeError")
        self.assertTrue(event["error"]["traceback"])


CELL = "Nguyễn Văn DO_NOT_LOG_CELL"


class Workbook:
    def read(self, document_id: str) -> FetchedDocument:
        content = fixtures.build_xlsx({"Luong": [["STT", "Nội dung"], ["1", CELL], ["2", "Trần Thị B"]]})
        return FetchedDocument(document_id, "luong.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", content)


class ContentStaysOutOfLogs(unittest.TestCase):
    def read_table(self, arguments: dict):
        output = io.StringIO()
        executor = Executor(_build_dispatcher(Services(documents=Workbook()), build_tool_registry()), 1)
        call = {"jsonrpc": "2.0", "id": "rpc-cells", "method": "tools/call",
                "params": {"name": "read_table", "arguments": {"documentId": "d", "sheet": "Luong", **arguments}}}
        with contextlib.redirect_stderr(output):
            try:
                result = executor.call(call)
            finally:
                executor.pool.shutdown(wait=True)
        return result, [json.loads(line) for line in output.getvalue().splitlines()]

    def test_header_refusal_reaches_the_model_whole_and_the_log_by_code_and_rows(self):
        result, events = self.read_table({"headerRow": 2, "columns": {"amount": ["Số tiền"]}})
        text = json.dumps(result.result, ensure_ascii=False)
        self.assertTrue(result.result["isError"])
        self.assertIn(CELL, text, "the model must still be told which cells the row holds")
        (event,) = events
        self.assertEqual(event["error"]["code"], "header_not_matched")
        self.assertEqual(event["error"]["rows"][0], 2)
        self.assertNotIn("message", event["error"])
        self.assertNotIn("DO_NOT_LOG_CELL", json.dumps(event, ensure_ascii=False))
        self.assertEqual((event["sheet"], event["headerRow"]), ("Luong", 2))

    def test_row_missing_refusal_with_titles_hint_withholds_the_hint_cells(self):
        # One title found and one not: no single row carries both, so the reader cannot choose and refuses with the hint.
        result, events = self.read_table({"headerRow": 9, "columns": {"name": ["Nguyễn Văn"], "other": ["Không có cột này"]}})
        self.assertTrue(result.result["isError"])
        self.assertIn(CELL, json.dumps(result.result, ensure_ascii=False), "the hint still reaches the model")
        (event,) = events
        self.assertEqual(event["error"]["code"], "header_not_matched")
        self.assertNotIn("DO_NOT_LOG_CELL", json.dumps(event, ensure_ascii=False))
        self.assertIn("is not a row", event["error"]["causes"][0]["message"], "the cause names no cell and keeps its sentence")

    def test_refusal_without_cells_keeps_its_sentence(self):
        _, events = self.read_table({"headerRow": 9})
        self.assertIn("headerRow 9 is not a row", events[0]["error"]["message"])

    def test_unexpected_exception_text_is_withheld(self):
        def crash(_args, _call):
            raise KeyError(CELL)
        output = io.StringIO()
        executor = Executor(dispatcher(crash), 1)
        with contextlib.redirect_stderr(output):
            try:
                executor.call(message())
            finally:
                executor.pool.shutdown(wait=True)
        event = json.loads(output.getvalue())
        self.assertEqual(event["error"]["type"], "KeyError")
        self.assertNotIn("DO_NOT_LOG_CELL", output.getvalue())
        self.assertTrue(event["error"]["traceback"])


class OldTimeout(Exception):
    """Stands for `concurrent.futures.TimeoutError` before Python 3.11, where it is not the builtin."""


class PlatformGuards(unittest.TestCase):
    def test_python_310_future_timeout_is_an_abandoned_call_not_a_crash(self):
        release = http_server.threading.Event()
        original = futures.Future.result

        def result(self, timeout=None):
            if timeout is not None and not self.done():
                raise OldTimeout()
            return original(self, timeout)

        output = io.StringIO()
        executor = Executor(dispatcher(lambda _args, _call: release.wait(5) and {"structured": {}}), 1)
        try:
            with contextlib.redirect_stderr(output), patch.object(futures, "TimeoutError", OldTimeout), \
                    patch.object(futures.Future, "result", result):
                self.assertEqual(executor.call(message()), "timeout")
        finally:
            release.set()
            executor.pool.shutdown(wait=True)
        self.assertEqual(json.loads(output.getvalue().splitlines()[0])["event"], "call.abandoned")

    def bind(self, platform: str):
        server = ReaderServer.__new__(ReaderServer)
        server.socket = MagicMock()
        seen = {}
        with patch.object(sys, "platform", platform), patch.object(socket_module, "SO_EXCLUSIVEADDRUSE", -5, create=True), \
                patch("http.server.HTTPServer.server_bind", lambda self: seen.update(reuse=self.allow_reuse_address)):
            server.server_bind()
        return server.socket.setsockopt.call_args_list, seen["reuse"]

    def test_windows_bind_is_exclusive(self):
        calls, reuse = self.bind("win32")
        self.assertFalse(reuse, "SO_REUSEADDR would let a stale reader keep sharing the port")
        self.assertEqual([call.args for call in calls], [(socket_module.SOL_SOCKET, -5, 1)])

    def test_other_platforms_keep_the_default_bind(self):
        calls, reuse = self.bind("linux")
        self.assertTrue(reuse)
        self.assertEqual(calls, [])


if __name__ == "__main__":
    unittest.main()
