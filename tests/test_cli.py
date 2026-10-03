"""Offline process tests against a deterministic Modrinth-shaped HTTP server."""

import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from collections import Counter
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit


REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class FixtureAPI:
    """Serve real HTTP metadata and downloads without contacting Modrinth."""

    def __init__(self):
        self.projects = {}
        self.versions = {}
        self.collection = []
        self.files = {}
        self.requests = Counter()
        self.lock = threading.Lock()
        self.download_barriers = {}
        self.overlapping_downloads = threading.Event()
        fixture = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_GET(self):
                path = urlsplit(self.path).path
                with fixture.lock:
                    fixture.requests[path] += 1
                barrier = fixture.download_barriers.get(path)
                if barrier is not None:
                    try:
                        barrier.wait(timeout=5)
                        fixture.overlapping_downloads.set()
                    except threading.BrokenBarrierError:
                        pass
                status, body, content_type, declared_size = fixture.response(path)
                self.send_response(status)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(declared_size))
                self.end_headers()
                self.wfile.write(body)
                self.close_connection = True

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.base_url = "http://127.0.0.1:{}".format(self.server.server_port)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)

    def add_version(self, project_id, version_id, filename, content=None,
                    dependencies=None, project_type="mod", primary=True):
        content = content if content is not None else (version_id + " artifact").encode()
        self.projects.setdefault(project_id, {
            "id": project_id, "title": project_id, "project_type": project_type,
        })
        file_path = "/files/" + filename
        self.files[file_path] = (content, len(content))
        version = {
            "id": version_id, "project_id": project_id,
            "version_number": version_id, "version_type": "release",
            "game_versions": ["1.20.1"],
            "loaders": ["minecraft" if project_type == "resourcepack" else "fabric"],
            "dependencies": dependencies or [],
            "files": [{
                "filename": filename, "primary": primary,
                "url": self.base_url + file_path, "size": len(content),
                "hashes": {algorithm: hashlib.new(algorithm, content).hexdigest()
                           for algorithm in ("sha512", "sha1")},
            }],
        }
        self.versions[version_id] = version
        return version

    def response(self, path):
        if path in self.files:
            body, size = self.files[path]
            return 200, body, "application/octet-stream", size
        value = None
        if path == "/v3/collection/testset":
            value = {"id": "testset", "projects": self.collection}
        elif path.startswith("/v2/project/"):
            parts = path.split("/")
            project_id = parts[3]
            if project_id in self.projects:
                if len(parts) == 4:
                    value = self.projects[project_id]
                elif len(parts) == 5 and parts[4] == "version":
                    value = [version for version in reversed(list(self.versions.values()))
                             if version["project_id"] == project_id]
        elif path.startswith("/v2/version/"):
            value = self.versions.get(path.rsplit("/", 1)[-1])
        elif path.startswith("/v2/version_file/"):
            digest = path.rsplit("/", 1)[-1]
            value = next((version for version in self.versions.values()
                          if any(digest in file["hashes"].values()
                                 for file in version["files"])), None)
        status = 200 if value is not None else 404
        body = json.dumps(value if value is not None else {"error": "not found"}).encode()
        return status, body, "application/json", len(body)


def required(project_id=None, version_id=None):
    return {"dependency_type": "required", "project_id": project_id,
            "version_id": version_id}


def installed_filename(version):
    file = version["files"][0]
    stem, extension = os.path.splitext(file["filename"])
    return "{}.{}{}".format(stem, version["project_id"], extension)


class TestCLI(unittest.TestCase):
    def setUp(self):
        self.api = FixtureAPI()
        self.addCleanup(self.api.close)
        self.tmp = tempfile.TemporaryDirectory(prefix="mcd-cli-")
        self.addCleanup(self.tmp.cleanup)
        self.mods = Path(self.tmp.name) / "mods"
        self.packs = Path(self.tmp.name) / "resourcepacks"

    def run_cli(self, *extra, collection="testset", update=True, commit_failure=None,
                request_timeout=2):
        bootstrap = "import main,sys\n"
        if commit_failure is not None:
            # Fail at the final publication boundary, after staging has succeeded.
            bootstrap += (
                "real_replace=main.os.replace\n"
                "def fail_commit(src,dst):\n"
                "    if main.os.path.abspath(dst)=={!r}:\n"
                "        raise OSError('simulated publication failure')\n"
                "    return real_replace(src,dst)\n"
                "main.os.replace=fail_commit\n"
            ).format(os.path.abspath(str(commit_failure)))
        bootstrap += (
            "client=main.ModrinthClient(base_url=sys.argv.pop(1),timeout={!r},retries=0)\n".format(request_timeout) +
            "sys.exit(main.main(client=client))\n"
        )
        return subprocess.run(
            [sys.executable, "-c", bootstrap, self.api.base_url,
             "-c", collection, "-v", "1.20.1", "-l", "fabric",
             "-d", str(self.mods), "--resourcepacks-directory", str(self.packs),
             "-u" if update else "--no-update", *extra],
            cwd=REPO_ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            universal_newlines=True, timeout=15,
        )

    def assert_success(self, result):
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def assert_failure(self, result):
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertNotIn("Traceback (most recent call last)", result.stderr)

    def artifacts(self):
        return sorted(path.name for directory in (self.mods, self.packs)
                      if directory.exists() for path in directory.iterdir()
                      if path.is_file() and not path.name.startswith("."))

    def test_planning_progress_is_visible_while_metadata_request_is_blocked(self):
        artifact = self.api.add_version("main0001", "parent01", "parent.jar")
        self.api.collection = ["main0001"]
        request_started, release_request, progress_seen = (threading.Event() for _ in range(3))
        response = self.api.response

        def blocked_response(path):
            if path == "/v2/project/main0001":
                request_started.set()
                release_request.wait(timeout=10)
            return response(path)

        self.api.response = blocked_response
        bootstrap = (
            "import main,sys; "
            "client=main.ModrinthClient(base_url=sys.argv.pop(1),timeout=10,retries=0); "
            "sys.exit(main.main(client=client))"
        )
        process = subprocess.Popen(
            [sys.executable, "-c", bootstrap, self.api.base_url,
             "-c", "testset", "-v", "1.20.1", "-l", "fabric", "-u",
             "-d", str(self.mods), "--resourcepacks-directory", str(self.packs)],
            cwd=REPO_ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            universal_newlines=True,
        )
        lines = []

        def read_output():
            for line in process.stdout:
                lines.append(line)
                if "PLANNING [1/1]: fetching project main0001" in line:
                    progress_seen.set()

        reader = threading.Thread(target=read_output, daemon=True)
        reader.start()

        def cleanup():
            release_request.set()
            if process.poll() is None:
                process.kill()
            process.wait(timeout=5)
            reader.join(timeout=5)
            process.stdout.close()

        self.addCleanup(cleanup)
        self.assertTrue(request_started.wait(timeout=5), "metadata request did not start")
        self.assertTrue(progress_seen.wait(timeout=2), "progress was buffered during the lookup")
        self.assertIsNone(process.poll())
        self.assertNotIn("Plan ready", "".join(lines))
        release_request.set()
        process.wait(timeout=10)
        reader.join(timeout=5)
        output = "".join(lines)
        self.assertEqual(process.returncode, 0, output)
        self.assertIn("Fetching versions for main0001", output)
        self.assertIn("Plan ready in", output)
        self.assertTrue((self.mods / installed_filename(artifact)).exists())

    def test_install_skip_then_update_preserves_unrelated_files(self):
        old = self.api.add_version("main0001", "old00001", "mod-1.jar")
        self.api.collection = ["main0001"]
        self.assert_success(self.run_cli())
        old_path = self.mods / installed_filename(old)
        self.assertEqual(old_path.read_bytes(), self.api.files["/files/mod-1.jar"][0])
        os.utime(str(old_path), ns=(1_000_000_000, 1_000_000_000))
        before = old_path.stat().st_mtime_ns
        self.assert_success(self.run_cli())
        self.assertEqual(old_path.stat().st_mtime_ns, before)
        self.assertEqual(self.api.requests["/files/mod-1.jar"], 1)

        unrelated = self.mods / "personal-mod.jar"
        unrelated.write_bytes(b"leave me alone")
        unidentified = self.mods / "custom.main0001.jar"
        unidentified.write_bytes(b"unrecognized local artifact")
        new = self.api.add_version("main0001", "new00001", "mod-2.jar")
        self.assert_success(self.run_cli())
        self.assertFalse(old_path.exists())
        self.assertEqual((self.mods / installed_filename(new)).read_bytes(),
                         self.api.files["/files/mod-2.jar"][0])
        self.assertEqual(unrelated.read_bytes(), b"leave me alone")
        self.assertEqual(unidentified.read_bytes(), b"unrecognized local artifact")

    def test_collection_and_directory_failures_exit_nonzero(self):
        failed = self.run_cli(collection="missing")
        self.assert_failure(failed)
        self.mods.mkdir(exist_ok=True)
        self.mods.rmdir()
        self.mods.write_bytes(b"not a directory")
        failed = self.run_cli()
        self.assert_failure(failed)
        self.assertEqual(self.mods.read_bytes(), b"not a directory")

    def test_interrupted_and_corrupt_updates_preserve_previous_install(self):
        old = self.api.add_version("main0001", "old00001", "mod-1.jar")
        self.api.collection = ["main0001"]
        self.assert_success(self.run_cli())
        old_path = self.mods / installed_filename(old)
        old_bytes = old_path.read_bytes()
        new = self.api.add_version("main0001", "new00001", "mod-2.jar", b"expected bytes")
        for label, response in (("interrupted", (b"part", len(b"expected bytes"))),
                                ("hash mismatch", (b"incorrect data", len(b"incorrect data")))):
            with self.subTest(label=label):
                self.api.files["/files/mod-2.jar"] = response
                result = self.run_cli()
                self.assert_failure(result)
                self.assertEqual(old_path.read_bytes(), old_bytes)
                self.assertFalse((self.mods / installed_filename(new)).exists())
                self.assertEqual(self.artifacts(), [old_path.name])
                self.assertFalse(any(p.name.endswith(".part") for p in self.mods.iterdir()))

    def test_parent_staging_failure_preserves_installed_dependency_component(self):
        old_dep = self.api.add_version("dep00001", "olddep01", "library-old.jar")
        old_parent = self.api.add_version("main0001", "parent01", "parent-old.jar",
                                          dependencies=[required("dep00001", "olddep01")])
        self.api.collection = ["main0001"]
        self.assert_success(self.run_cli())
        old_contents = {installed_filename(v): (self.mods / installed_filename(v)).read_bytes()
                        for v in (old_parent, old_dep)}
        new_dep = self.api.add_version("dep00001", "newdep01", "library-new.jar")
        new_parent = self.api.add_version("main0001", "parent02", "parent-new.jar",
                                          dependencies=[required("dep00001", "newdep01")])
        body = self.api.files["/files/parent-new.jar"][0]
        self.api.files["/files/parent-new.jar"] = (b"x" * len(body), len(body))
        independent = self.api.add_version("main0002", "other001", "independent.jar")
        self.api.collection.append("main0002")
        self.assert_failure(self.run_cli())
        self.assertEqual(self.api.requests["/files/library-new.jar"], 1)
        self.assertEqual(self.api.requests["/files/parent-new.jar"], 1)
        for name, content in old_contents.items():
            self.assertEqual((self.mods / name).read_bytes(), content)
        for version in (new_parent, new_dep):
            self.assertFalse((self.mods / installed_filename(version)).exists())
        self.assertTrue((self.mods / installed_filename(independent)).exists())

    def test_component_publication_failure_rolls_back_dependency_update(self):
        old_dep = self.api.add_version("dep00001", "olddep01", "library-old.jar")
        old_parent = self.api.add_version("main0001", "parent01", "parent-old.jar",
                                          dependencies=[required("dep00001", "olddep01")])
        self.api.collection = ["main0001"]
        self.assert_success(self.run_cli())
        old_contents = {installed_filename(v): (self.mods / installed_filename(v)).read_bytes()
                        for v in (old_parent, old_dep)}
        new_dep = self.api.add_version("dep00001", "newdep01", "library-new.jar")
        new_parent = self.api.add_version("main0001", "parent02", "parent-new.jar",
                                          dependencies=[required("dep00001", "newdep01")])
        failed_path = self.mods / installed_filename(new_parent)
        result = self.run_cli(commit_failure=failed_path)
        self.assert_failure(result)
        self.assertIn("simulated publication failure", result.stdout + result.stderr)
        self.assertEqual(self.api.requests["/files/library-new.jar"], 1)
        self.assertEqual(self.api.requests["/files/parent-new.jar"], 1)
        for name, content in old_contents.items():
            self.assertEqual((self.mods / name).read_bytes(), content)
        self.assertFalse(failed_path.exists())
        self.assertFalse((self.mods / installed_filename(new_dep)).exists())
        self.assertEqual(self.artifacts(), sorted(old_contents))

    def test_missing_dependency_blocks_parent_download(self):
        self.api.projects["dep00001"] = {"id": "dep00001", "title": "Missing dependency"}
        parent = self.api.add_version("main0001", "parent01", "parent.jar",
                                      dependencies=[required("dep00001")])
        self.api.collection = ["main0001"]
        result = self.run_cli()
        self.assert_failure(result)
        self.assertFalse((self.mods / installed_filename(parent)).exists())
        self.assertEqual(self.api.requests["/files/parent.jar"], 0)

    def test_independent_metadata_requests_overlap_before_downloads_and_are_bounded(self):
        versions = [self.api.add_version("root{:04d}".format(index), "ver{:05d}".format(index),
                                         "root-{}.jar".format(index)) for index in range(8)]
        self.api.collection = [version["project_id"] for version in versions]
        # Hold five independent lookups together. A serial planner cannot cross
        # this barrier; an unbounded planner will exceed the observed active cap.
        barrier = threading.Barrier(5)
        overlapping = threading.Event()
        active = maximum = 0
        premature_downloads = []
        completed_metadata = set()
        expected_metadata = {"/v2/project/" + project_id + suffix
                             for project_id in self.api.collection for suffix in ("", "/version")}
        response = self.api.response
        synchronized = {"/v2/project/" + project_id for project_id in self.api.collection[:5]}

        def tracked_response(path):
            nonlocal active, maximum
            metadata = path.startswith(("/v2/project/", "/v2/version/"))
            if metadata:
                with self.api.lock:
                    active += 1
                    maximum = max(maximum, active)
            try:
                if path in synchronized:
                    try:
                        barrier.wait(timeout=5)
                        overlapping.set()
                    except threading.BrokenBarrierError:
                        pass
                if metadata:
                    # Keep responses in flight so excess submitted work is observable.
                    time.sleep(0.05)
                if path.startswith("/files/"):
                    with self.api.lock:
                        if (not overlapping.is_set() or active or
                                expected_metadata - completed_metadata):
                            premature_downloads.append(path)
                return response(path)
            finally:
                if metadata:
                    with self.api.lock:
                        active -= 1
                        completed_metadata.add(path)

        self.api.response = tracked_response
        self.assert_success(self.run_cli(request_timeout=10))
        self.assertTrue(overlapping.is_set(), "Independent metadata lookups must overlap")
        self.assertEqual(maximum, 5, "Metadata requests must stay within the five-worker bound")
        self.assertEqual(premature_downloads, [], "Planning must finish before downloading")
        self.assertEqual(self.artifacts(), sorted(installed_filename(v) for v in versions))

    def test_metadata_error_does_not_abort_independent_project(self):
        valid = self.api.add_version("main0001", "parent01", "parent.jar")
        self.api.collection = ["missing1", "main0001"]
        result = self.run_cli()
        self.assert_failure(result)
        self.assertEqual((self.mods / installed_filename(valid)).read_bytes(),
                         self.api.files["/files/parent.jar"][0])
        self.assertIn("missing1", result.stdout)
        self.assertIn("Plan ready in", result.stdout)
        self.assertEqual(self.api.requests["/v2/project/missing1"], 1)
        self.assertEqual(self.api.requests["/files/parent.jar"], 1)

    def test_independent_collection_downloads_overlap(self):
        one = self.api.add_version("main0001", "parent01", "parent-one.jar")
        two = self.api.add_version("main0002", "parent02", "parent-two.jar")
        self.api.collection = ["main0001", "main0002"]
        barrier = threading.Barrier(2)
        self.api.download_barriers = {"/files/parent-one.jar": barrier,
                                      "/files/parent-two.jar": barrier}
        self.assert_success(self.run_cli(request_timeout=10))
        self.assertTrue(self.api.overlapping_downloads.is_set(),
                        "Independent collection downloads must run concurrently")
        self.assertEqual(self.artifacts(), sorted(installed_filename(v) for v in (one, two)))

    def test_shared_dependency_downloaded_once(self):
        dep = self.api.add_version("dep00001", "depver01", "library.jar")
        one = self.api.add_version("main0001", "parent01", "parent-one.jar",
                                   dependencies=[required("dep00001")])
        two = self.api.add_version("main0002", "parent02", "parent-two.jar",
                                   dependencies=[required("dep00001")])
        self.api.collection = ["main0001", "main0002", "dep00001"]
        self.assert_success(self.run_cli())
        self.assertEqual(self.api.requests["/files/library.jar"], 1)
        self.assertEqual(self.artifacts(), sorted(installed_filename(v) for v in (dep, one, two)))

    def test_exact_pin_and_version_only_reference_install_pinned_artifact(self):
        pinned = self.api.add_version("dep00001", "olddep01", "library-old.jar")
        latest = self.api.add_version("dep00001", "newdep01", "library-new.jar")
        self.api.add_version("main0001", "parent01", "parent-one.jar",
                             dependencies=[required("dep00001", "olddep01")])
        self.api.add_version("main0002", "parent02", "parent-two.jar",
                             dependencies=[required(version_id="olddep01")])
        # The shared dependency is also an unpinned root. Applying the older
        # exact pin forces a graph rebuild while all lookup results stay cached.
        self.api.collection = ["main0001", "main0002", "dep00001"]
        self.assert_success(self.run_cli())
        self.assertTrue((self.mods / installed_filename(pinned)).exists())
        self.assertFalse((self.mods / installed_filename(latest)).exists())
        self.assertEqual(self.api.requests["/files/library-old.jar"], 1)
        self.assertEqual(self.api.requests["/files/library-new.jar"], 0)
        self.assertEqual(self.api.requests["/v2/version/olddep01"], 1)
        for project_id in self.api.collection:
            self.assertEqual(self.api.requests["/v2/project/" + project_id], 1)
            self.assertEqual(self.api.requests["/v2/project/" + project_id + "/version"], 1)

    def test_no_update_uses_installed_version_dependencies(self):
        old_dep = self.api.add_version("dep00001", "olddep01", "old-library.jar")
        parent = self.api.add_version("main0001", "parent01", "parent-old.jar",
                                      dependencies=[required("dep00001", "olddep01")])
        self.api.collection = ["main0001"]
        self.assert_success(self.run_cli())
        old_dep_path = self.mods / installed_filename(old_dep)
        old_dep_path.unlink()
        newer_dep = self.api.add_version("dep00002", "newdep02", "new-library.jar")
        newer = self.api.add_version("main0001", "parent02", "parent-new.jar",
                                     dependencies=[required("dep00002")])
        parent_path = self.mods / installed_filename(parent)
        os.utime(str(parent_path), ns=(1_000_000_000, 1_000_000_000))
        self.assert_success(self.run_cli(update=False))
        self.assertEqual(parent_path.stat().st_mtime_ns, 1_000_000_000)
        self.assertTrue(old_dep_path.exists())
        self.assertFalse((self.mods / installed_filename(newer)).exists())
        self.assertFalse((self.mods / installed_filename(newer_dep)).exists())

    def test_corrupt_current_filename_is_repaired_instead_of_skipped(self):
        version = self.api.add_version("main0001", "parent01", "parent.jar")
        self.api.collection = ["main0001"]
        self.assert_success(self.run_cli())
        installed = self.mods / installed_filename(version)
        installed.write_bytes(b"truncated")
        self.assert_success(self.run_cli())
        self.assertEqual(installed.read_bytes(), self.api.files["/files/parent.jar"][0])
        self.assertEqual(self.api.requests["/files/parent.jar"], 2)

    def test_conflicting_pins_block_both_parents(self):
        self.api.add_version("dep00001", "olddep01", "library-old.jar")
        self.api.add_version("dep00001", "newdep01", "library-new.jar")
        one = self.api.add_version("main0001", "parent01", "parent-one.jar",
                                   dependencies=[required("dep00001", "olddep01")])
        two = self.api.add_version("main0002", "parent02", "parent-two.jar",
                                   dependencies=[required("dep00001", "newdep01")])
        self.api.collection = ["main0001", "main0002"]
        self.assert_failure(self.run_cli())
        for version in (one, two):
            self.assertFalse((self.mods / installed_filename(version)).exists())
            self.assertEqual(self.api.requests["/files/" + version["files"][0]["filename"]], 0)

    def test_primary_flag_falls_back_to_first_file(self):
        version = self.api.add_version("main0001", "parent01", "unmarked.jar", primary=False)
        self.api.collection = ["main0001"]
        self.assert_success(self.run_cli())
        self.assertTrue((self.mods / installed_filename(version)).exists())

    def test_pack_duplicates_reconciled_without_download(self):
        pack = self.api.add_version("pack0001", "packver1", "pack.zip", project_type="resourcepack")
        self.api.collection = ["pack0001"]
        self.assert_success(self.run_cli())
        pack_path = self.packs / installed_filename(pack)
        duplicate = self.mods / pack_path.name
        duplicate.write_bytes(pack_path.read_bytes())
        self.assert_success(self.run_cli())
        self.assertTrue(pack_path.exists())
        self.assertFalse(duplicate.exists())
        self.assertEqual(self.api.requests["/files/pack.zip"], 1)


if __name__ == "__main__":
    unittest.main()
