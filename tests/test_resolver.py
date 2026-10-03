"""Offline regression tests for dependency planning and installation transactions."""
import io
import json
import os
import re
import shutil
import tempfile
import threading
import unittest
from unittest.mock import patch

import main
from tests.helpers import FakeClient, dep, version


class TestResolver(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.mods = os.path.join(self.temp.name, "mods")
        self.packs = os.path.join(self.temp.name, "resourcepacks")
        os.makedirs(self.mods)
        self.config = main.InstallConfig(self.mods, self.packs, "26.2", "fabric", True, "release")

    def install(self, data, directory=None, filename=None, content=None):
        directory = directory or self.mods
        os.makedirs(directory, exist_ok=True)
        artifact = data["files"][0]
        filename = filename or main.managed_filename(artifact["filename"], data["project_id"])
        path = os.path.join(directory, filename)
        with open(path, "wb") as file:
            file.write(artifact["url"].encode() if content is None else content)
        return path

    def run_plan(self, client, roots=None):
        plan = main.Resolver(client, self.config, main.merge_existing_mods(self.mods, self.packs)).resolve(
            client.roots if roots is None else roots)
        with patch("sys.stdout", new_callable=io.StringIO):
            results = main.execute_plan(plan, client, self.config)
        return plan, results

    def test_pin_and_version_only_reference_override_latest_root_in_any_order(self):
        parent = version("parent", "1", [dep(pin="lib-1")])
        for roots in (["parent", "lib"], ["lib", "parent"]):
            client = FakeClient({"parent": [parent], "lib": [version("lib", "2"), version("lib", "1")]}, roots)
            plan, results = self.run_plan(client)
            self.assertEqual(plan.nodes["lib"]["version"]["id"], "lib-1")
            self.assertTrue(all(result.status != "failed" for result in results.values()))
            self.assertNotIn("lib-2", client.downloads)

    def test_missing_dependency_blocks_parent_but_independent_root_succeeds(self):
        client = FakeClient({"parent": [version("parent", "1", [dep("missing")])],
                             "good": [version("good", "1")]})
        _, results = self.run_plan(client)
        self.assertEqual(results["parent"].status, "failed")
        self.assertEqual(results["missing"].status, "failed")
        self.assertEqual(results["good"].status, "downloaded")
        self.assertEqual(client.downloads, ["good-1"])

    def test_conflicting_pins_block_all_dependents(self):
        client = FakeClient({"a": [version("a", "1", [dep("lib", "lib-1")])],
                             "b": [version("b", "1", [dep("lib", "lib-2")])],
                             "lib": [version("lib", "2"), version("lib", "1")]}, ["a", "b"])
        _, results = self.run_plan(client)
        self.assertTrue(all(result.status == "failed" for result in results.values()))
        self.assertIn("Conflicting", results["lib"].message)
        self.assertEqual(client.downloads, [])

    def test_shared_dependency_is_downloaded_once_and_stats_count_projects_once(self):
        client = FakeClient({"a": [version("a", "1", [dep("lib")])],
                             "b": [version("b", "1", [dep("lib")])], "lib": [version("lib", "1")]}, ["a", "b"])
        plan, results = self.run_plan(client)
        self.assertEqual(client.downloads.count("lib-1"), 1)
        self.assertEqual(main.aggregate_results(plan, results)["downloaded"], 3)

    def test_cycles_fail_without_downloading(self):
        client = FakeClient({"a": [version("a", "1", [dep("b")])], "b": [version("b", "1", [dep("a")])]}, ["a"])
        _, results = self.run_plan(client)
        self.assertEqual(set(results), {"a", "b"})
        self.assertTrue(all("Cyclic" in result.message for result in results.values()))
        self.assertEqual(client.downloads, [])

    def test_no_update_uses_installed_dependencies_not_latest(self):
        old = version("parent", "1", [dep("oldlib")])
        path = self.install(old)
        self.config = self.config._replace(update=False)
        client = FakeClient({"parent": [version("parent", "2", [dep("newlib")]), old],
                             "oldlib": [version("oldlib", "1")], "newlib": [version("newlib", "1")]}, ["parent"])
        _, results = self.run_plan(client)
        self.assertEqual(client.downloads, ["oldlib-1"])
        self.assertEqual(results["parent"].status, "skipped")
        self.assertTrue(os.path.exists(path))

    def test_no_update_identifies_bytes_when_versions_reuse_filename(self):
        old = version("parent", "1", [dep("oldlib")])
        latest = version("parent", "2", [dep("newlib")])
        old["files"][0]["filename"] = latest["files"][0]["filename"] = "parent.jar"
        self.install(old)
        self.config = self.config._replace(update=False)
        client = FakeClient({"parent": [latest, old], "oldlib": [version("oldlib", "1")],
                             "newlib": [version("newlib", "1")]}, ["parent"])
        plan, results = self.run_plan(client)
        self.assertEqual(plan.nodes["parent"]["version"]["id"], "parent-1")
        self.assertEqual(results["parent"].status, "skipped")
        self.assertEqual(client.downloads, ["oldlib-1"])

    def test_no_update_legacy_filename_uses_hash_lookup(self):
        old = version("parent", "1", [dep("lib")])
        old_path = self.install(old, filename="legacy.parent.jar")
        self.config = self.config._replace(update=False)
        client = FakeClient({"parent": [old], "lib": [version("lib", "1")]}, ["parent"])
        _, results = self.run_plan(client)
        self.assertNotEqual(results["parent"].status, "failed")
        self.assertEqual(client.downloads, ["lib-1"])
        self.assertFalse(os.path.exists(old_path))
        self.assertTrue(os.path.exists(os.path.join(self.mods, "parent-1.parent.jar")))

    def test_pinned_prerelease_requires_channel_opt_in(self):
        client = FakeClient({"parent": [version("parent", "1", [dep("lib", "lib-1")])],
                             "lib": [version("lib", "1", channel="beta")]}, ["parent"])
        _, results = self.run_plan(client)
        self.assertIn("--channel", results["lib"].message)
        self.assertEqual(client.downloads, [])
        self.config = self.config._replace(max_channel="beta")
        _, results = self.run_plan(client)
        self.assertTrue(all(result.status != "failed" for result in results.values()))

    def test_duplicate_and_migration_reconcile_after_verification_only(self):
        pack = version("pack", "1", loader="minecraft")
        old = version("pack", "0", loader="minecraft")
        wrong = self.install(pack)
        previous = self.install(old, self.packs)
        canonical = self.install(pack, self.packs)
        unrelated = os.path.join(self.mods, "unmanaged.pack.jar")
        with open(unrelated, "wb") as file:
            file.write(b"leave me")
        client = FakeClient({"pack": [pack, old]}, packs=["pack"])
        _, results = self.run_plan(client)
        self.assertEqual(client.downloads, [])
        self.assertTrue(os.path.exists(canonical))
        self.assertFalse(os.path.exists(wrong))
        self.assertFalse(os.path.exists(previous))
        self.assertTrue(os.path.exists(unrelated))
        self.assertTrue(results["pack"].updated)

    def test_resourcepack_root_placement_wins_over_dependency_role(self):
        client = FakeClient({"parent": [version("parent", "1", [dep("pack")])],
                             "pack": [version("pack", "1", loader="minecraft")]}, ["parent", "pack"], ["pack"])
        _, results = self.run_plan(client)
        self.assertTrue(os.path.exists(os.path.join(self.packs, "pack-1.pack.jar")))
        self.assertNotEqual(results["parent"].status, "failed")

    def test_primary_fallback_and_corrupt_current_file_repair(self):
        data = version("a", "1", primary=False)
        target = self.install(data, content=b"corrupt")
        client = FakeClient({"a": [data]})
        _, results = self.run_plan(client)
        self.assertEqual(results["a"].status, "downloaded")
        self.assertEqual(client.downloads, ["a-1"])
        with open(target, "rb") as file:
            self.assertEqual(file.read(), b"a-1")

    def test_failed_parent_update_preserves_old_dependency_and_parent(self):
        old_parent = version("parent", "1", [dep("lib", "lib-1")])
        old_lib = version("lib", "1")
        paths = [self.install(old_parent), self.install(old_lib)]
        client = FakeClient({"parent": [version("parent", "2", [dep("lib", "lib-2")]), old_parent],
                             "lib": [version("lib", "2"), old_lib]}, ["parent"])
        client.fail.add("parent-2")
        _, results = self.run_plan(client)
        self.assertTrue(all(result.status == "failed" for result in results.values()))
        self.assertEqual(set(os.listdir(self.mods)), {os.path.basename(path) for path in paths})
        for path, content in zip(paths, (b"parent-1", b"lib-1")):
            with open(path, "rb") as file:
                self.assertEqual(file.read(), content)

    def test_failed_parent_update_preserves_removed_historical_dependency(self):
        old_parent = version("parent", "1", [dep(pin="lib-1")])
        old_lib = version("lib", "1")
        paths = [self.install(old_parent), self.install(old_lib)]
        client = FakeClient({"parent": [version("parent", "2"), old_parent],
                             "lib": [version("lib", "2"), old_lib]}, ["parent", "lib"])
        client.fail.add("parent-2")
        plan, results = self.run_plan(client)
        self.assertEqual(plan.nodes["parent"]["transaction_dependencies"], {"lib"})
        self.assertTrue(all(result.status == "failed" for result in results.values()))
        self.assertEqual(set(os.listdir(self.mods)), {os.path.basename(path) for path in paths})
        for path, content in zip(paths, (b"parent-1", b"lib-1")):
            with open(path, "rb") as file:
                self.assertEqual(file.read(), content)

    def test_bad_dependency_before_known_pin_does_not_allow_library_upgrade(self):
        old_parent, old_lib = version("parent", "1"), version("lib", "1")
        paths = [self.install(old_parent), self.install(old_lib)]
        client = FakeClient({"parent": [version("parent", "2", [dep(), dep("lib", "lib-2")]), old_parent],
                             "lib": [version("lib", "2"), old_lib]}, ["parent", "lib"])
        plan, results = self.run_plan(client)
        self.assertEqual(plan.nodes["parent"]["dependencies"], {"lib"})
        self.assertEqual(plan.nodes["lib"]["version"]["id"], "lib-2")
        self.assertTrue(all(result.status == "failed" for result in results.values()))
        self.assertEqual(client.downloads, [])
        self.assertEqual(set(os.listdir(self.mods)), {os.path.basename(path) for path in paths})

    def test_missing_pin_before_known_dependency_keeps_all_transaction_edges(self):
        old_lib = version("lib", "1")
        self.install(old_lib)
        client = FakeClient({"parent": [version("parent", "1", [dep("other", "missing-version"), dep("lib")])],
                             "other": [version("other", "1")],
                             "lib": [version("lib", "2"), old_lib]}, ["parent", "lib"])
        plan, results = self.run_plan(client)
        self.assertEqual(plan.nodes["parent"]["dependencies"], {"other", "lib"})
        self.assertTrue(all(result.status == "failed" for result in results.values()))
        self.assertEqual(client.downloads, [])

    def test_unknown_historical_owner_blocks_potential_dependency_replacements(self):
        old_parent = version("parent", "1", [dep(pin="unknown-version")])
        old_lib = version("lib", "1")
        paths = [self.install(old_parent), self.install(old_lib)]
        client = FakeClient({"parent": [version("parent", "2"), old_parent],
                             "lib": [version("lib", "2"), old_lib]}, ["parent", "lib"])
        _, results = self.run_plan(client)
        self.assertIn("Cannot identify installed dependency", results["parent"].message)
        self.assertTrue(all(result.status == "failed" for result in results.values()))
        self.assertEqual(client.downloads, [])
        self.assertEqual(set(os.listdir(self.mods)), {os.path.basename(path) for path in paths})

    def test_rejected_parent_pin_retains_cached_historical_library_transaction(self):
        old_parent = version("parent", "1", [dep("lib", "lib-1")])
        old_lib = version("lib", "1")
        paths = [self.install(old_parent), self.install(old_lib)]
        client = FakeClient({
            "parent": [version("parent", "2", channel="beta"), old_parent],
            "other": [version("other", "1", [dep("parent", "parent-2")])],
            "lib": [version("lib", "2"), old_lib],
        }, ["parent", "other", "lib"])
        plan, results = self.run_plan(client)
        self.assertIn("--channel", plan.errors["parent"])
        self.assertEqual(plan.nodes["parent"]["transaction_dependencies"], {"lib"})
        self.assertEqual(plan.nodes["parent"]["dependencies"], set())
        self.assertTrue(all(result.status == "failed" for result in results.values()))
        self.assertEqual(client.downloads, [])
        self.assertEqual(set(os.listdir(self.mods)), {os.path.basename(path) for path in paths})
        for path, content in zip(paths, (b"parent-1", b"lib-1")):
            with open(path, "rb") as file:
                self.assertEqual(file.read(), content)

    def test_commit_failure_rolls_back_updated_dependency(self):
        old_parent, old_lib = version("parent", "1"), version("lib", "1")
        paths = [self.install(old_parent), self.install(old_lib)]
        client = FakeClient({"parent": [version("parent", "2", [dep("lib", "lib-2")]), old_parent],
                             "lib": [version("lib", "2"), old_lib]}, ["parent"])
        original = main.install_project
        def install(project, *args):
            if project == "parent":
                return main.InstallResult(project, "failed", False, "simulated permissions")
            return original(project, *args)
        with patch("main.install_project", side_effect=install):
            _, results = self.run_plan(client)
        self.assertTrue(all(result.status == "failed" for result in results.values()))
        self.assertEqual(set(os.listdir(self.mods)), {os.path.basename(path) for path in paths})

    def test_interrupted_commit_rolls_back_updated_dependency(self):
        old_parent, old_lib = version("parent", "1"), version("lib", "1")
        paths = [self.install(old_parent), self.install(old_lib)]
        client = FakeClient({"parent": [version("parent", "2", [dep("lib", "lib-2")]), old_parent],
                             "lib": [version("lib", "2"), old_lib]}, ["parent"])
        original = main.install_project
        def install(project, *args):
            if project == "parent":
                raise KeyboardInterrupt()
            return original(project, *args)
        with patch("main.install_project", side_effect=install):
            with self.assertRaises(KeyboardInterrupt):
                self.run_plan(client)
        self.assertEqual(set(os.listdir(self.mods)), {os.path.basename(path) for path in paths})
        for path, content in zip(paths, (b"parent-1", b"lib-1")):
            with open(path, "rb") as file:
                self.assertEqual(file.read(), content)

    def test_no_update_corrupt_existing_fails_and_preserves_bytes(self):
        data = version("a", "1")
        path = self.install(data, content=b"partial")
        self.config = self.config._replace(update=False)
        client = FakeClient({"a": [data]})
        _, results = self.run_plan(client)
        self.assertEqual(results["a"].status, "failed")
        self.assertEqual(client.downloads, [])
        with open(path, "rb") as file:
            self.assertEqual(file.read(), b"partial")

    def test_channel_reaches_nested_dependencies_and_blocks_ancestors(self):
        client = FakeClient({"parent": [version("parent", "1", [dep("lib")])],
                             "lib": [version("lib", "1", [dep("nested")], channel="beta")],
                             "nested": [version("nested", "1", channel="alpha")]}, ["parent"])
        for channel in ("release", "beta", "alpha"):
            self.config = self.config._replace(max_channel=channel)
            _, results = self.run_plan(client)
            self.assertEqual(results["parent"].status == "failed", channel != "alpha")
        self.assertEqual(sorted(client.downloads), ["lib-1", "nested-1", "parent-1"])

    def test_superseded_version_requirements_are_removed(self):
        client = FakeClient({
            "a": [version("a", "2", [dep("lib", "lib-2")]),
                  version("a", "1", [dep("lib", "lib-1")])],
            "b": [version("b", "1", [dep("a", "a-1")])],
            "c": [version("c", "1", [dep("lib", "lib-1")])],
            "lib": [version("lib", "2"), version("lib", "1")],
        }, ["a", "b", "c"])
        plan, results = self.run_plan(client)
        self.assertEqual(plan.errors, {})
        self.assertEqual(plan.nodes["a"]["version"]["id"], "a-1")
        self.assertEqual(plan.nodes["lib"]["version"]["id"], "lib-1")
        self.assertTrue(all(result.status != "failed" for result in results.values()))
        self.assertNotIn("lib-2", client.downloads)

    def test_nonconverging_constraints_do_not_block_independent_root(self):
        client = FakeClient({"a": [version("a", "2", [dep("a", "a-1")]), version("a", "1")],
                             "good": [version("good", "1")]}, ["a", "good"])
        _, results = self.run_plan(client)
        self.assertEqual(results["a"].status, "failed")
        self.assertIn("do not converge", results["a"].message)
        self.assertEqual(results["good"].status, "downloaded")
        self.assertEqual(client.downloads, ["good-1"])

    def test_no_update_installed_pin_conflict_blocks_parent(self):
        old_lib = version("lib", "1")
        self.install(old_lib)
        self.config = self.config._replace(update=False)
        client = FakeClient({"parent": [version("parent", "1", [dep("lib", "lib-2")])],
                             "lib": [version("lib", "2"), old_lib]}, ["parent"])
        _, results = self.run_plan(client)
        self.assertIn("conflicts", results["lib"].message)
        self.assertEqual(results["parent"].status, "failed")
        self.assertEqual(client.downloads, [])

    def test_ambiguous_identical_installed_versions_fail_safely(self):
        old = version("parent", "1")
        latest = version("parent", "2", [dep("lib")])
        latest["files"] = old["files"]
        path = self.install(old)
        self.config = self.config._replace(update=False)
        client = FakeClient({"parent": [latest, old]}, ["parent"])
        _, results = self.run_plan(client)
        self.assertEqual(results["parent"].status, "failed")
        self.assertEqual(client.downloads, [])
        self.assertTrue(os.path.exists(path))

    def test_missing_artifact_does_not_block_independent_root(self):
        broken = version("broken", "1")
        broken["files"] = []
        client = FakeClient({"broken": [broken], "good": [version("good", "1")]})
        _, results = self.run_plan(client)
        self.assertEqual(results["broken"].status, "failed")
        self.assertEqual(results["good"].status, "downloaded")
        self.assertEqual(client.downloads, ["good-1"])

    def test_verified_no_op_does_not_copy_backup_or_download(self):
        client = FakeClient({"parent": [version("parent", "1", [dep("lib")])],
                             "lib": [version("lib", "1")]}, ["parent"])
        self.run_plan(client)
        client.downloads.clear()
        with patch.object(client, "download_file", side_effect=AssertionError("unexpected download")), \
                patch("main.shutil.copyfile", side_effect=AssertionError("unexpected copy")):
            _, results = self.run_plan(client)
        self.assertTrue(all(result.status == "skipped" for result in results.values()))
        self.assertEqual(client.downloads, [])

    def test_independent_components_stage_concurrently_with_bounded_workers(self):
        client = FakeClient({project: [version(project, "1")] for project in ("a", "b", "c", "d", "e", "f")})
        barrier = threading.Barrier(2)
        lock = threading.Lock()
        counts = {"active": 0, "peak": 0}
        original = client.download_file
        def download(*args, **kwargs):
            with lock:
                counts["active"] += 1
                counts["peak"] = max(counts["peak"], counts["active"])
            try:
                barrier.wait(timeout=2)
                return original(*args, **kwargs)
            finally:
                with lock:
                    counts["active"] -= 1
        client.download_file = download
        plan = main.Resolver(client, self.config, {}).resolve(client.roots)
        with patch("sys.stdout", new_callable=io.StringIO):
            results = main.execute_plan(plan, client, self.config, max_workers=2)
        self.assertEqual(counts["peak"], 2)
        self.assertEqual(len(client.downloads), 6)
        self.assertTrue(all(result.status == "downloaded" for result in results.values()))

    def test_incomplete_rollback_retains_recovery_files_and_manifest(self):
        old_parent, old_lib = version("parent", "1"), version("lib", "1")
        self.install(old_parent)
        lib_path = self.install(old_lib)
        client = FakeClient({"parent": [version("parent", "2", [dep("lib", "lib-2")]), old_parent],
                             "lib": [version("lib", "2"), old_lib]}, ["parent"])
        original_install, original_replace = main.install_project, main.os.replace
        def install(project, *args):
            if project == "parent":
                return main.InstallResult(project, "failed", False, "parent publication failed")
            return original_install(project, *args)
        def replace(source, target):
            if os.path.abspath(target) == os.path.abspath(lib_path):
                raise PermissionError("cannot restore old dependency")
            return original_replace(source, target)
        with patch("main.install_project", side_effect=install), patch("main.os.replace", side_effect=replace):
            _, results = self.run_plan(client)
        message = results["parent"].message
        self.assertIn("Rollback incomplete", message)
        recovery = message.split("original files retained at ", 1)[1]
        self.addCleanup(shutil.rmtree, recovery)
        with open(os.path.join(recovery, "originals", "original-paths.json")) as file:
            manifest = json.load(file)
        with open(os.path.join(recovery, "originals", manifest[os.path.abspath(lib_path)]), "rb") as file:
            self.assertEqual(file.read(), b"lib-1")

    def test_interrupted_incomplete_rollback_retains_staging_if_recovery_move_fails(self):
        old_parent, old_lib = version("parent", "1"), version("lib", "1")
        self.install(old_parent)
        lib_path = self.install(old_lib)
        client = FakeClient({"parent": [version("parent", "2", [dep("lib", "lib-2")]), old_parent],
                             "lib": [version("lib", "2"), old_lib]}, ["parent"])
        original_install, original_replace = main.install_project, main.os.replace
        def install(project, *args):
            if project == "parent":
                raise KeyboardInterrupt()
            return original_install(project, *args)
        def replace(source, target):
            if os.path.abspath(target) == os.path.abspath(lib_path):
                raise PermissionError("cannot restore old dependency")
            return original_replace(source, target)
        plan = main.Resolver(client, self.config, main.merge_existing_mods(self.mods, self.packs)).resolve(client.roots)
        with patch("main.install_project", side_effect=install), patch("main.os.replace", side_effect=replace), \
                patch("main.retain_recovery", side_effect=OSError("disk failure")), \
                patch("sys.stdout", new_callable=io.StringIO) as output:
            with self.assertRaises(KeyboardInterrupt):
                main.execute_plan(plan, client, self.config)
        match = re.search(r"recovery staging retained at (.+?) \(disk failure\)", output.getvalue())
        self.assertIsNotNone(match)
        staging = match.group(1)
        self.addCleanup(shutil.rmtree, staging)
        backup_dirs = [os.path.join(staging, name) for name in os.listdir(staging) if name.startswith("backups-")]
        contents = []
        for directory in backup_dirs:
            for name in os.listdir(directory):
                with open(os.path.join(directory, name), "rb") as file:
                    contents.append(file.read())
        self.assertIn(b"lib-1", contents)

    def test_main_exits_nonzero_on_failed_collection_and_prompt(self):
        client = FakeClient({})
        with patch.object(client, "get_collection", return_value=None), patch("sys.stdout", new_callable=io.StringIO):
            self.assertEqual(main.main(["-c", "bad", "-v", "26.2", "-l", "fabric", "-u", "-d", self.mods], client), 1)
        with patch("main.safe_input", side_effect=EOFError), patch("sys.stdout", new_callable=io.StringIO):
            self.assertEqual(main.main([], client), 1)


if __name__ == "__main__":
    unittest.main()
