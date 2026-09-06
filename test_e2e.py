"""End-to-end tests against the live Modrinth API.

Uses the public test collection:
https://modrinth.com/collection/YyGKtxlz

Downloads once, then asserts install layout, dependency resolution,
idempotent update/skip behavior, and resource-pack migration.

Run:
  python3 -m unittest test_e2e -v
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from urllib import error, request

REPO_ROOT = os.path.dirname(os.path.abspath(__file__))
TEST_COLLECTION = "YyGKtxlz"
MC_VERSION = "26.2"
LOADER = "fabric"
API = "https://api.modrinth.com"


def _api_get(path: str):
    with request.urlopen(f"{API}{path}", timeout=20) as resp:
        return json.loads(resp.read())


def _files(directory: str) -> list[str]:
    if not os.path.isdir(directory):
        return []
    return sorted(
        f for f in os.listdir(directory) if os.path.isfile(os.path.join(directory, f))
    )


def _has_project(files: list[str], project_id: str) -> bool:
    return any(f".{project_id}." in name for name in files)


def _version_matches(version: dict, project_type: str, max_channel: str = "release") -> bool:
    game_versions = version.get("game_versions") or []
    loaders = version.get("loaders") or []
    if MC_VERSION not in game_versions:
        return False
    loader_ok = LOADER in loaders or (
        project_type == "resourcepack" and "minecraft" in loaders
    )
    if not loader_ok:
        return False
    version_type = version.get("version_type") or "release"
    allowed = {"release"}
    if max_channel in ("beta", "alpha"):
        allowed.add("beta")
    if max_channel == "alpha":
        allowed.add("alpha")
    return version_type in allowed


def _select_expected_version(versions: list, project_type: str, max_channel: str = "release"):
    matching = [v for v in versions if _version_matches(v, project_type, max_channel)]
    for channel in ("release", "beta", "alpha"):
        if max_channel == "release" and channel != "release":
            continue
        if max_channel == "beta" and channel == "alpha":
            continue
        for version in matching:
            if (version.get("version_type") or "release") == channel:
                return version
    return None


def _log(msg: str) -> None:
    print(f"  {msg}", flush=True)


class TestE2ECollectionDownload(unittest.TestCase):
    """Single live download against collection YyGKtxlz, then all assertions."""

    def test_download_update_skip_and_migrate(self):
        _log(f"resolving collection {TEST_COLLECTION} for {MC_VERSION}/{LOADER}...")
        try:
            collection = _api_get(f"/v3/collection/{TEST_COLLECTION}")
        except (error.URLError, TimeoutError, json.JSONDecodeError) as exc:
            self.skipTest(f"Modrinth API unreachable: {exc}")

        project_ids = list(collection.get("projects") or [])
        if not project_ids:
            self.skipTest(f"Collection {TEST_COLLECTION} has no projects")

        projects = {}
        required_deps = set()
        needs_prerelease = False
        for project_id in project_ids:
            project = _api_get(f"/v2/project/{project_id}")
            versions = _api_get(f"/v2/project/{project_id}/version")
            project_type = project.get("project_type") or "mod"
            match = _select_expected_version(versions, project_type, "release")
            if match is None:
                match = _select_expected_version(versions, project_type, "alpha")
                if match is None:
                    self.skipTest(
                        f"No version for {project.get('title')} with "
                        f"MC {MC_VERSION} / loader {LOADER}"
                    )
                needs_prerelease = True
            title = project.get("title") or project_id
            projects[project_id] = {
                "title": title,
                "type": project_type,
                "version": match,
            }
            _log(f"found {title} ({project_type}) -> {match.get('version_number')}")
            for dep in match.get("dependencies") or []:
                if dep.get("dependency_type") == "required" and dep.get("project_id"):
                    required_deps.add(dep["project_id"])

        channel_flag = ["--allow-prerelease"] if needs_prerelease else ["--channel", "release"]
        if needs_prerelease:
            _log("collection includes prerelease-only projects; using --allow-prerelease")

        mod_ids = [pid for pid, info in projects.items() if info["type"] != "resourcepack"]
        pack_ids = [pid for pid, info in projects.items() if info["type"] == "resourcepack"]
        if not mod_ids or not pack_ids:
            self.skipTest(
                "Collection must include at least one mod and one resource pack "
                f"(mods={len(mod_ids)}, packs={len(pack_ids)})"
            )
        if not required_deps:
            self.skipTest(
                "Collection needs a project with a required dependency for this e2e run"
            )
        _log(
            f"plan: {len(mod_ids)} mods, {len(pack_ids)} packs, "
            f"{len(required_deps)} required deps"
        )

        tmp = tempfile.mkdtemp(prefix="mcd-e2e-")
        mods_dir = os.path.join(tmp, "mods")
        packs_dir = os.path.join(tmp, "resourcepacks")
        try:
            # --- 1) Initial download ---
            first = self._run("1/4 initial download", mods_dir, packs_dir, *channel_flag, "-u")
            self.assertEqual(
                first.returncode,
                0,
                msg=f"stdout:\n{first.stdout}\nstderr:\n{first.stderr}",
            )
            self.assertNotIn("ERROR: Collection", first.stdout)

            mods = _files(mods_dir)
            packs = _files(packs_dir)
            _log(f"mods/: {mods}")
            _log(f"resourcepacks/: {packs}")

            for project_id in mod_ids:
                self.assertTrue(
                    _has_project(mods, project_id),
                    f"expected mod {projects[project_id]['title']} ({project_id}) in mods/: {mods}",
                )
            for project_id in pack_ids:
                self.assertFalse(
                    _has_project(mods, project_id),
                    f"resource pack {project_id} should not be in mods/: {mods}",
                )
                self.assertTrue(
                    _has_project(packs, project_id),
                    f"expected pack {projects[project_id]['title']} ({project_id}) in resourcepacks/: {packs}",
                )
            for dep_id in required_deps:
                self.assertTrue(
                    _has_project(mods, dep_id),
                    f"expected required dependency {dep_id} in mods/: {mods}",
                )
            self.assertFalse(
                any(name.lower().endswith(".zip") for name in mods),
                f"zip files should not land in mods/: {mods}",
            )
            self.assertIn("SUMMARY", first.stdout)

            # --- 2) Idempotent update: no re-downloads ---
            before_mods = set(mods)
            before_packs = set(packs)
            second = self._run(
                "2/4 update (expect skips)", mods_dir, packs_dir, *channel_flag, "-u"
            )
            self.assertEqual(second.returncode, 0, msg=second.stdout + second.stderr)
            self.assertNotIn("DOWNLOADING:", second.stdout)
            self.assertEqual(set(_files(mods_dir)), before_mods)
            self.assertEqual(set(_files(packs_dir)), before_packs)

            # --- 3) --no-update leaves files untouched ---
            third = self._run(
                "3/4 --no-update (expect skips)",
                mods_dir,
                packs_dir,
                *channel_flag,
                "--no-update",
            )
            self.assertEqual(third.returncode, 0, msg=third.stdout + third.stderr)
            self.assertNotIn("DOWNLOADING:", third.stdout)
            self.assertNotIn("UPDATING:", third.stdout)
            self.assertNotIn("MOVED:", third.stdout)
            self.assertEqual(set(_files(mods_dir)), before_mods)
            self.assertEqual(set(_files(packs_dir)), before_packs)

            # --- 4) Migrate pack that was left under mods/ ---
            pack_id = pack_ids[0]
            pack_name = next(n for n in _files(packs_dir) if f".{pack_id}." in n)
            shutil.move(
                os.path.join(packs_dir, pack_name),
                os.path.join(mods_dir, pack_name),
            )
            _log(f"moved {pack_name} into mods/ to simulate old layout")
            self.assertTrue(_has_project(_files(mods_dir), pack_id))
            self.assertFalse(_has_project(_files(packs_dir), pack_id))

            fourth = self._run(
                "4/4 migrate pack back to resourcepacks/",
                mods_dir,
                packs_dir,
                *channel_flag,
                "-u",
            )
            self.assertEqual(fourth.returncode, 0, msg=fourth.stdout + fourth.stderr)
            self.assertTrue(
                _has_project(_files(packs_dir), pack_id),
                _files(packs_dir),
            )
            self.assertFalse(
                _has_project(_files(mods_dir), pack_id),
                _files(mods_dir),
            )
            self.assertTrue(
                ("MOVED:" in fourth.stdout) or ("REMOVED:" in fourth.stdout),
                fourth.stdout,
            )
            _log("all e2e assertions passed")
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def _run(
        self, label: str, mods_dir: str, packs_dir: str, *extra_args: str
    ) -> subprocess.CompletedProcess:
        cmd = [
            sys.executable,
            os.path.join(REPO_ROOT, "main.py"),
            "-c",
            TEST_COLLECTION,
            "-v",
            MC_VERSION,
            "-l",
            LOADER,
            "-d",
            mods_dir,
            "--resourcepacks-directory",
            packs_dir,
            *extra_args,
        ]
        _log(f"--- {label} ---")
        started = time.monotonic()
        proc = subprocess.Popen(
            cmd,
            cwd=REPO_ROOT,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
        )
        lines: list[str] = []
        try:
            assert proc.stdout is not None
            for line in proc.stdout:
                lines.append(line)
                sys.stdout.write(f"    {line}")
                sys.stdout.flush()
            returncode = proc.wait(timeout=180)
        finally:
            if proc.stdout is not None:
                proc.stdout.close()
            if proc.poll() is None:
                proc.kill()
                proc.wait()
        elapsed = time.monotonic() - started
        _log(f"--- {label} done in {elapsed:.1f}s (exit {returncode}) ---")
        return subprocess.CompletedProcess(
            cmd, returncode, stdout="".join(lines), stderr=""
        )


if __name__ == "__main__":
    unittest.main()
