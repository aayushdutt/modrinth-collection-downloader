"""Deterministic HTTP and filesystem integrity checks (no external network)."""

import hashlib
from http.client import IncompleteRead
from http.server import BaseHTTPRequestHandler, HTTPServer
import io
import os
from socketserver import ThreadingMixIn
import tempfile
import threading
import unittest
from unittest.mock import patch
from urllib import error

import main


class LocalHTTPServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.server.requests.append((self.path, self.headers.get("User-Agent")))
        responses = self.server.routes.get(self.path, [(404, {}, b"missing")])
        status, headers, body = responses[0]
        if len(responses) > 1:
            responses.pop(0)
        self.send_response(status)
        for name, value in headers.items():
            self.send_header(name, str(value))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


class TestClient(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = LocalHTTPServer(("127.0.0.1", 0), Handler)
        cls.worker = threading.Thread(
            target=lambda: cls.server.serve_forever(poll_interval=0.01), daemon=True
        )
        cls.worker.start()
        cls.base_url = "http://127.0.0.1:{}".format(cls.server.server_port)

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.worker.join()

    def setUp(self):
        self.server.requests = []
        self.server.routes = {}
        self.client = main.ModrinthClient(self.base_url, timeout=3, retries=2)
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.target = os.path.join(self.directory.name, "mod.jar")
        self.sleep = patch("main.time.sleep").start()
        self.addCleanup(patch.stopall)

    def route(self, responses):
        self.server.routes["/test"] = list(responses)
        return self.base_url + "/test"

    def assert_files(self, expected):
        self.assertEqual(sorted(os.listdir(self.directory.name)), expected)

    def test_get_uses_unique_user_agent_and_exact_lookup_paths(self):
        expected = [
            "/v2/project/project", "/v2/project/project/version",
            "/v2/version/pinned", "/v2/version_file/abc?algorithm=sha1",
            "/v3/collection/collection",
        ]
        for path in expected:
            self.server.routes[path] = [(200, {}, b'{"id":"found"}')]
        calls = [
            lambda: self.client.get_mod_project("project"),
            lambda: self.client.get_mod_version("project"),
            lambda: self.client.get_version("pinned"),
            lambda: self.client.get_version_from_hash("abc", "sha1"),
            lambda: self.client.get_collection("collection"),
        ]
        for call in calls:
            self.assertEqual(call(), {"id": "found"})
        self.assertEqual([item[0] for item in self.server.requests], expected)
        self.assertTrue(all(
            "aayushdutt/modrinth-collection-downloader" in agent
            for _, agent in self.server.requests
        ))

    def test_download_checks_both_hashes_and_replaces_only_when_complete(self):
        content = b"verified jar data"
        self.route([(200, {"Content-Length": len(content)}, content)])
        with open(self.target, "wb") as old:
            old.write(b"old content")
        original_replace = os.replace
        replacements = []

        def checked_replace(source, target):
            self.assertEqual(os.path.dirname(source), self.directory.name)
            with open(target, "rb") as old:
                self.assertEqual(old.read(), b"old content")
            with open(source, "rb") as complete:
                self.assertEqual(complete.read(), content)
            replacements.append(target)
            original_replace(source, target)

        hashes = {algorithm: hashlib.new(algorithm, content).hexdigest()
                  for algorithm in ("sha512", "sha1")}
        with patch("main.os.replace", side_effect=checked_replace):
            self.assertTrue(self.client.download_file(
                self.base_url + "/test", self.target, hashes=hashes, size=len(content)
            ))
        self.assertEqual(replacements, [self.target])
        self.assertTrue(main.verify_file(self.target, hashes, len(content)))
        self.assert_files(["mod.jar"])
        self.assertIn("modrinth-collection-downloader", self.server.requests[0][1])

    def test_empty_size_hash_and_truncated_downloads_leave_no_final_file(self):
        cases = [
            ({}, b"", {}),
            ({}, b"content", {"size": 99}),
            ({}, b"content", {"hashes": {"sha512": "0" * 128}}),
            ({}, b"content", {"hashes": {"sha1": "0" * 40}}),
            ({"Content-Length": 99}, b"partial", {}),
            ({"Content-Length": "invalid"}, b"content", {}),
        ]
        for headers, content, kwargs in cases:
            with self.subTest(headers=headers, kwargs=kwargs):
                url = self.route([(200, headers, content)])
                self.assertFalse(self.client.download_file(url, self.target, **kwargs))
                self.assert_files([])
                self.assertEqual(len(self.server.requests), 1)
                self.server.requests.clear()
        self.sleep.assert_not_called()

    def test_failed_integrity_preserves_existing_destination(self):
        with open(self.target, "wb") as old:
            old.write(b"known good")
        url = self.route([(200, {}, b"bad replacement")])
        self.assertFalse(self.client.download_file(url, self.target, size=100))
        with open(self.target, "rb") as old:
            self.assertEqual(old.read(), b"known good")
        self.assert_files(["mod.jar"])

    def test_atomic_replace_disk_failure_preserves_existing_destination(self):
        with open(self.target, "wb") as old:
            old.write(b"known good")
        url = self.route([(200, {}, b"new content")])
        with patch("main.os.replace", side_effect=PermissionError("disk denied")):
            self.assertFalse(self.client.download_file(url, self.target))
        with open(self.target, "rb") as old:
            self.assertEqual(old.read(), b"known good")
        self.assert_files(["mod.jar"])
        self.sleep.assert_not_called()

    def test_transient_statuses_retry_with_bounded_reset_delays(self):
        self.route([
            (429, {"X-Ratelimit-Reset": 0.1}, b"rate limit"),
            (503, {"Retry-After": 60}, b"unavailable"),
            (200, {}, b'{"ok":true}'),
        ])
        self.assertEqual(self.client.get("/test"), {"ok": True})
        self.assertEqual(self.sleep.call_args_list[0][0], (0.1,))
        self.assertEqual(self.sleep.call_args_list[1][0], (2,))
        self.assertEqual(len(self.server.requests), 3)

    def test_invalid_or_nonfinite_retry_header_uses_default_backoff(self):
        for retry_after in ("nan", "inf", "-inf", "invalid"):
            with self.subTest(retry_after=retry_after):
                self.route([
                    (429, {"Retry-After": retry_after}, b"limited"),
                    (200, {}, b'{"ok":true}'),
                ])
                self.assertEqual(self.client.get("/test"), {"ok": True})
                self.sleep.assert_called_once_with(0.25)
                self.sleep.reset_mock()
        self.route([
            (429, {"Retry-After": "nan", "X-Ratelimit-Reset": 0.1}, b"limited"),
            (200, {}, b'{"ok":true}'),
        ])
        self.assertEqual(self.client.get("/test"), {"ok": True})
        self.sleep.assert_called_once_with(0.1)

    def test_transient_download_status_retries_without_leaving_temp_files(self):
        url = self.route([(503, {}, b"unavailable"), (200, {}, b"jar")])
        self.assertTrue(self.client.download_file(url, self.target))
        self.assertEqual(len(self.server.requests), 2)
        self.assert_files(["mod.jar"])

    def test_retry_budget_and_permanent_statuses(self):
        for status, attempts in ((500, 3), (404, 1), (403, 1)):
            with self.subTest(status=status):
                self.route([(status, {}, b"error")])
                self.assertIsNone(self.client.get("/test"))
                self.assertEqual(len(self.server.requests), attempts)
                self.server.requests.clear()

    def test_malformed_json_and_encoding_are_not_retried(self):
        for content in (b"not json", b"\xff"):
            with self.subTest(content=content):
                self.route([(200, {}, content)])
                self.assertIsNone(self.client.get("/test"))
                self.assertEqual(len(self.server.requests), 1)
                self.server.requests.clear()
        self.sleep.assert_not_called()

    def test_explicit_timeout_and_timeout_retry_budget(self):
        for failure in (TimeoutError("stalled"), error.URLError("connection reset")):
            with self.subTest(failure=failure), patch(
                "main.request.urlopen", side_effect=failure
            ) as urlopen:
                self.assertIsNone(self.client.get("/test"))
                self.assertEqual(urlopen.call_count, 3)
                self.assertTrue(all(call[1] == {"timeout": 3}
                                    for call in urlopen.call_args_list))

    def test_interrupted_reads_retry_from_fresh_temp_file(self):
        class Interrupted(io.BytesIO):
            headers = {}

            def read(self, size=-1):
                if self.tell():
                    raise IncompleteRead(b"fragment")
                return super().read(2)

        completed = io.BytesIO(b"complete content")
        completed.headers = {}
        with patch.object(self.client, "_open", side_effect=[Interrupted(b"partial"), completed]):
            self.assertTrue(self.client.download_file("unused", self.target))
        with open(self.target, "rb") as result:
            self.assertEqual(result.read(), b"complete content")
        self.assert_files(["mod.jar"])

    def test_interruption_cleans_partial_file_without_swallowing_keyboard_interrupt(self):
        class Interrupted(io.BytesIO):
            headers = {}

            def read(self, size=-1):
                if self.tell():
                    raise KeyboardInterrupt()
                return super().read(2)

        with patch.object(self.client, "_open", return_value=Interrupted(b"partial")):
            with self.assertRaises(KeyboardInterrupt):
                self.client.download_file("unused", self.target)
        self.assert_files([])
        self.sleep.assert_not_called()

    def test_malformed_integrity_metadata_fails_without_replacing_existing_file(self):
        with open(self.target, "wb") as source:
            source.write(b"old content")
        url = self.route([(200, {}, b"replacement")])
        cases = [
            {"hashes": "bad"}, {"hashes": []},
            {"hashes": {"sha512": 1}}, {"hashes": {"sha512": None}},
            {"hashes": {"sha1": None}}, {"hashes": {"sha512": ""}}, {"size": "11"},
            {"size": -1}, {"size": True}, {"size": 11.0},
        ]
        for metadata in cases:
            with self.subTest(metadata=metadata):
                self.assertFalse(main.verify_file(self.target, **metadata))
                self.assertFalse(self.client.download_file(url, self.target, **metadata))
                with open(self.target, "rb") as source:
                    self.assertEqual(source.read(), b"old content")
                self.assert_files(["mod.jar"])
        self.sleep.assert_not_called()

    def test_cleanup_failure_reports_partial_path_and_preserves_keyboard_interrupt(self):
        class Interrupted(io.BytesIO):
            headers = {}

            def read(self, size=-1):
                raise KeyboardInterrupt()

        output = io.StringIO()
        with patch.object(self.client, "_open", return_value=Interrupted()), patch(
            "main.os.unlink", side_effect=PermissionError("cleanup denied")
        ), patch("sys.stdout", output):
            with self.assertRaises(KeyboardInterrupt):
                self.client.download_file("unused", self.target)
        leftovers = os.listdir(self.directory.name)
        self.assertEqual(len(leftovers), 1)
        self.assertTrue(leftovers[0].endswith(".part"))
        self.assertIn(os.path.join(self.directory.name, leftovers[0]), output.getvalue())
        self.assertIn("cleanup denied", output.getvalue())
        self.assertFalse(os.path.exists(self.target))
        self.sleep.assert_not_called()

    def test_verify_file_checks_missing_empty_and_available_metadata(self):
        self.assertFalse(main.verify_file(self.target))
        self.assertFalse(main.verify_file(self.directory.name))
        with open(self.target, "wb") as source:
            source.write(b"")
        self.assertFalse(main.verify_file(self.target))
        with open(self.target, "wb") as source:
            source.write(b"content")
        self.assertTrue(main.verify_file(self.target))
        self.assertFalse(main.verify_file(self.target, size=8))
        self.assertTrue(main.verify_file(
            self.target, {"sha1": hashlib.sha1(b"content").hexdigest().upper()}, 7
        ))


if __name__ == "__main__":
    unittest.main()
