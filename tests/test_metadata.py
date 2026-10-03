"""Deterministic tests for bounded metadata fetching and coordinator ownership."""
import collections
from concurrent.futures import ThreadPoolExecutor
import io
import os
import tempfile
import threading
import unittest
from unittest.mock import patch

import main
from tests.helpers import FakeClient, dep, version


class CountingClient(FakeClient):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.calls = collections.Counter()
        self.lock = threading.Lock()
        self.worker_threads = set()

    def count(self, kind, identifier):
        with self.lock:
            self.calls[(kind, identifier)] += 1
            self.worker_threads.add(threading.get_ident())

    def get_mod_project(self, identifier):
        self.count("project", identifier)
        return super().get_mod_project(identifier)

    def get_mod_version(self, identifier):
        self.count("versions", identifier)
        return super().get_mod_version(identifier)

    def get_version(self, identifier):
        self.count("version", identifier)
        return super().get_version(identifier)

    def get_version_from_hash(self, identifier, algorithm="sha512"):
        self.count("hash", identifier)
        return super().get_version_from_hash(identifier, algorithm)


class TestMetadataPlanning(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.config = main.InstallConfig(os.path.join(self.temp.name, "mods"),
                                         os.path.join(self.temp.name, "packs"),
                                         "26.2", "fabric", True, "release")

    def test_bounded_parallel_requests_and_coordinator_progress(self):
        client = CountingClient({pid: [version(pid, "1")] for pid in ("a", "b", "c", "d")})
        barrier = threading.Barrier(2)
        lock = threading.Lock()
        state = {"active": 0, "peak": 0}
        coordinator = threading.get_ident()
        progress_threads = []
        original_project, original_versions = client.get_mod_project, client.get_mod_version
        def overlap(method):
            def call(identifier):
                with lock:
                    state["active"] += 1
                    state["peak"] = max(state["peak"], state["active"])
                try:
                    barrier.wait(timeout=2)
                    return method(identifier)
                finally:
                    with lock:
                        state["active"] -= 1
            return call
        client.get_mod_project = overlap(original_project)
        client.get_mod_version = overlap(original_versions)
        resolver = main.Resolver(client, self.config, {}, max_workers=2,
                                 progress=lambda _: progress_threads.append(threading.get_ident()))
        plan = resolver.resolve(client.roots)
        self.assertEqual(plan.errors, {})
        self.assertEqual(state["peak"], 2)
        self.assertEqual(sum(client.calls.values()), 8)
        self.assertEqual(set(progress_threads), {coordinator})
        self.assertNotIn(coordinator, client.worker_threads)
        self.assertIsNone(resolver.metadata)

    def test_shared_dependency_and_exact_pin_cached_across_graph_passes(self):
        client = CountingClient({"a": [version("a", "1", [dep("lib", "lib-1")])],
                                 "b": [version("b", "1", [dep(pin="lib-1")])],
                                 "lib": [version("lib", "2"), version("lib", "1")]}, ["a", "b", "lib"])
        plan = main.Resolver(client, self.config, {}).resolve(client.roots)
        self.assertEqual(plan.errors, {})
        self.assertEqual(plan.nodes["lib"]["version"]["id"], "lib-1")
        self.assertEqual(client.calls[("version", "lib-1")], 1)
        self.assertTrue(all(count == 1 for count in client.calls.values()))
        self.assertEqual(client.downloads, [])

    def test_version_only_references_are_prefetched_before_any_wait(self):
        client = CountingClient({"parent": [version("parent", "1", [dep(pin="a-1"), dep(pin="b-1")])],
                                 "a": [version("a", "1")], "b": [version("b", "1")]}, ["parent"])
        barrier = threading.Barrier(2)
        original = client.get_version
        def overlapping_exact(identifier):
            barrier.wait(timeout=2)
            return original(identifier)
        client.get_version = overlapping_exact
        plan = main.Resolver(client, self.config, {}, max_workers=2).resolve(client.roots)
        self.assertEqual(plan.errors, {})
        self.assertEqual(set(plan.nodes), {"parent", "a", "b"})
        self.assertEqual(client.calls[("version", "a-1")], 1)
        self.assertEqual(client.calls[("version", "b-1")], 1)

    def test_metadata_errors_are_cached_and_independent_root_succeeds(self):
        client = CountingClient({"parent": [version("parent", "1", [dep("lib", "lib-1")])],
                                 "lib": [version("lib", "1")], "good": [version("good", "1")]}, ["parent", "good"])
        original = client.get_mod_project
        def project(identifier):
            if identifier == "lib":
                client.count("project", identifier)
                raise OSError("metadata failed")
            return original(identifier)
        client.get_mod_project = project
        plan = main.Resolver(client, self.config, {}).resolve(client.roots)
        with patch("sys.stdout", new_callable=io.StringIO):
            results = main.execute_plan(plan, client, self.config)
        self.assertEqual(client.calls[("project", "lib")], 1)
        self.assertEqual(results["parent"].status, "failed")
        self.assertEqual(results["good"].status, "downloaded")

    def test_malformed_root_does_not_fetch_or_block_valid_root(self):
        client = CountingClient({"good": [version("good", "1")]}, ["../bad", "good"])
        plan = main.Resolver(client, self.config, {}).resolve(client.roots)
        with patch("sys.stdout", new_callable=io.StringIO):
            results = main.execute_plan(plan, client, self.config)
        self.assertIn("Invalid project ID", plan.errors["../bad"])
        self.assertEqual(results["good"].status, "downloaded")
        self.assertEqual(client.calls[("project", "../bad")], 0)
        self.assertEqual(client.calls[("versions", "../bad")], 0)

    def test_duplicate_legacy_hash_lookups_are_cached(self):
        data = version("parent", "1")
        client = CountingClient({"parent": [data]}, ["parent"])
        existing = {"parent": []}
        for directory in (self.config.mods_directory, self.config.resourcepacks_directory):
            os.makedirs(directory)
            filename = "legacy.parent.jar"
            with open(os.path.join(directory, filename), "wb") as file:
                file.write(b"parent-1")
            existing["parent"].append({"id": "parent", "directory": directory, "filename": filename})
        plan = main.Resolver(client, self.config._replace(update=False), existing).resolve(client.roots)
        self.assertEqual(plan.errors, {})
        self.assertEqual(sum(count for (kind, _), count in client.calls.items() if kind == "hash"), 1)

    def test_interruption_cancels_queued_requests_and_closes_pool(self):
        client = CountingClient({"a": [version("a", "1")], "b": [version("b", "1")]})
        started, release = threading.Event(), threading.Event()
        original = client.get_mod_project
        executor_state = {}
        def blocked_project(identifier):
            started.set()
            release.wait(timeout=2)
            return original(identifier)
        client.get_mod_project = blocked_project
        class ClosingExecutor(ThreadPoolExecutor):
            def shutdown(self, wait=True):
                metadata = executor_state["resolver"].metadata_for_test
                executor_state["cancelled"] = [future.cancelled() for future in metadata.futures.values()]
                release.set()
                super().shutdown(wait=wait)
        resolver = main.Resolver(client, self.config, {}, max_workers=1)
        executor_state["resolver"] = resolver
        def progress(message):
            if "fetching project b" in message:
                self.assertTrue(started.wait(timeout=2))
                resolver.metadata_for_test = resolver.metadata
                raise KeyboardInterrupt()
        resolver.progress = progress
        with patch("main.ThreadPoolExecutor", ClosingExecutor):
            with self.assertRaises(KeyboardInterrupt):
                resolver.resolve(client.roots)
        self.assertEqual(executor_state["cancelled"], [False, True])
        self.assertEqual(client.calls[("project", "a")], 1)
        self.assertEqual(client.calls[("versions", "a")], 0)
        self.assertEqual(client.calls[("project", "b")], 0)
        self.assertIsNone(resolver.metadata)


if __name__ == "__main__":
    unittest.main()
