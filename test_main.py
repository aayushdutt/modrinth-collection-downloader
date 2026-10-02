"""Unit tests for main.py helpers (stdlib only, no network)."""

import io
import os
import tempfile
import unittest
from unittest.mock import Mock, patch

import main


class TestParseArgs(unittest.TestCase):
    CLI_ARGS = ["-c", "YyGKtxlz", "-v", "26.2", "-l", "fabric", "-u"]

    def test_complete_arguments_never_prompt(self):
        for terminal in (True, False):
            with self.subTest(terminal=terminal), patch(
                "sys.stdin.isatty", return_value=terminal
            ), patch("main.safe_input") as prompt:
                args = main.parse_args(self.CLI_ARGS)
                self.assertEqual(args.channel, "release")
                prompt.assert_not_called()

    def test_interactive_prerelease_choice_works_with_piped_stdin(self):
        for terminal in (True, False):
            for answer, expected in (("y", "alpha"), ("", "release")):
                with self.subTest(terminal=terminal, answer=answer), patch(
                    "sys.stdin.isatty", return_value=terminal
                ), patch(
                    "main.safe_input", side_effect=["YyGKtxlz", "26.2", "", "", answer]
                ) as prompt:
                    args = main.parse_args([])
                    self.assertEqual(args.channel, expected)
                    self.assertEqual(args.loader, "fabric")
                    self.assertTrue(args.update)
                    self.assertIn("prerelease", prompt.call_args[0][0])

    def test_explicit_channel_skips_prerelease_prompt(self):
        for flags, expected in (
            (["--channel", "release"], "release"),
            (["--channel", "beta"], "beta"),
            (["--channel", "alpha"], "alpha"),
            (["--allow-prerelease"], "alpha"),
        ):
            with self.subTest(flags=flags), patch(
                "main.safe_input", side_effect=["YyGKtxlz", "26.2", "", ""]
            ) as prompt:
                self.assertEqual(main.parse_args(flags).channel, expected)
                self.assertEqual(prompt.call_count, 4)

    def test_conflicting_channels_fail_before_prompting(self):
        with patch("main.safe_input") as prompt, patch("sys.stderr", new_callable=io.StringIO):
            with self.assertRaises(SystemExit) as error:
                main.parse_args(["--channel", "release", "--allow-prerelease"])
            self.assertEqual(error.exception.code, 2)
            prompt.assert_not_called()


class TestExtractCollectionId(unittest.TestCase):
    def test_plain_id(self):
        self.assertEqual(main.extract_collection_id("5OBQuutT"), "5OBQuutT")

    def test_https_url(self):
        self.assertEqual(
            main.extract_collection_id(
                "https://modrinth.com/collection/5OBQuutT"
            ),
            "5OBQuutT",
        )

    def test_http_www_url(self):
        self.assertEqual(
            main.extract_collection_id(
                "http://www.modrinth.com/collection/abc123?foo=1"
            ),
            "abc123",
        )

    def test_strips_whitespace(self):
        self.assertEqual(main.extract_collection_id("  xyz  "), "xyz")


class TestValidateDirectory(unittest.TestCase):
    def test_creates_missing_directory(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "nested", "mods")
            self.assertTrue(main.validate_directory(path))
            self.assertTrue(os.path.isdir(path))

    def test_rejects_file_path(self):
        with tempfile.NamedTemporaryFile(delete=False) as f:
            path = f.name
        try:
            self.assertFalse(main.validate_directory(path))
        finally:
            os.unlink(path)


class TestGetExistingMods(unittest.TestCase):
    def test_parses_mod_id_from_filename(self):
        with tempfile.TemporaryDirectory() as tmp:
            open(os.path.join(tmp, "foo-bar.LQ3K71Q1.jar"), "w").close()
            mods = main.get_existing_mods(tmp)
            self.assertIn("LQ3K71Q1", mods)
            self.assertEqual(mods["LQ3K71Q1"]["filename"], "foo-bar.LQ3K71Q1.jar")
            self.assertEqual(mods["LQ3K71Q1"]["directory"], os.path.abspath(tmp))

    def test_empty_directory(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(main.get_existing_mods(tmp), {})


class TestDefaultResourcepacksDirectory(unittest.TestCase):
    def test_sibling_of_mods_directory(self):
        with tempfile.TemporaryDirectory() as tmp:
            mods_dir = os.path.join(tmp, "mods")
            expected = os.path.join(tmp, "resourcepacks")
            self.assertEqual(main.default_resourcepacks_directory(mods_dir), expected)


class TestMergeExistingMods(unittest.TestCase):
    def test_merges_both_directories_resourcepacks_win_on_conflict(self):
        with tempfile.TemporaryDirectory() as tmp:
            mods_dir = os.path.join(tmp, "mods")
            packs_dir = os.path.join(tmp, "resourcepacks")
            os.makedirs(mods_dir)
            os.makedirs(packs_dir)
            open(os.path.join(mods_dir, "old.AAAA1111.jar"), "w").close()
            open(os.path.join(packs_dir, "pack.BBBB2222.zip"), "w").close()
            open(os.path.join(packs_dir, "moved.AAAA1111.zip"), "w").close()

            merged = main.merge_existing_mods(mods_dir, packs_dir)
            self.assertEqual(merged["BBBB2222"]["filename"], "pack.BBBB2222.zip")
            self.assertEqual(merged["BBBB2222"]["directory"], os.path.abspath(packs_dir))
            self.assertEqual(merged["AAAA1111"]["filename"], "moved.AAAA1111.zip")
            self.assertEqual(merged["AAAA1111"]["directory"], os.path.abspath(packs_dir))


class TestVersionMatchesLoader(unittest.TestCase):
    def test_exact_loader_match(self):
        self.assertTrue(
            main._version_matches_loader(
                {"loaders": ["fabric"]}, "fabric", "mod"
            )
        )

    def test_resourcepack_accepts_minecraft_loader(self):
        self.assertTrue(
            main._version_matches_loader(
                {"loaders": ["minecraft"]}, "fabric", "resourcepack"
            )
        )

    def test_mod_does_not_accept_minecraft_for_other_loader(self):
        self.assertFalse(
            main._version_matches_loader(
                {"loaders": ["minecraft"]}, "fabric", "mod"
            )
        )


class TestResolveTargetDirectory(unittest.TestCase):
    def test_mod_goes_to_mods(self):
        self.assertEqual(
            main.resolve_target_directory("mod", "/m", "/rp"),
            "/m",
        )

    def test_resourcepack_goes_to_resourcepacks(self):
        self.assertEqual(
            main.resolve_target_directory("resourcepack", "/m", "/rp"),
            "/rp",
        )

    def test_resourcepack_dependency_stays_in_mods(self):
        self.assertEqual(
            main.resolve_target_directory(
                "resourcepack", "/m", "/rp", is_dependency=True
            ),
            "/m",
        )


class TestSelectVersion(unittest.TestCase):
    RELEASE = {"game_versions": ["26.2"], "loaders": ["fabric"], "version_type": "release", "id": "rel"}
    BETA = {"game_versions": ["26.2"], "loaders": ["fabric"], "version_type": "beta", "id": "beta"}
    ALPHA = {"game_versions": ["26.2"], "loaders": ["fabric"], "version_type": "alpha", "id": "alpha"}

    def test_release_beats_newer_alpha(self):
        versions = [self.ALPHA, self.RELEASE]
        got = main.select_version(versions, "26.2", "fabric", "mod", "alpha")
        self.assertEqual(got["id"], "rel")

    def test_release_only_skips_beta(self):
        versions = [self.BETA]
        got = main.select_version(versions, "26.2", "fabric", "mod", "release")
        self.assertIsNone(got)

    def test_beta_channel_falls_back_to_beta(self):
        versions = [self.BETA, self.ALPHA]
        got = main.select_version(versions, "26.2", "fabric", "mod", "beta")
        self.assertEqual(got["id"], "beta")

    def test_alpha_channel_allows_alpha(self):
        versions = [self.ALPHA]
        got = main.select_version(versions, "26.2", "fabric", "mod", "alpha")
        self.assertEqual(got["id"], "alpha")

    def test_picks_newest_within_same_channel(self):
        older_release = {
            **self.RELEASE,
            "id": "rel-old",
            "version_number": "1.0.0",
        }
        newer_release = {
            **self.RELEASE,
            "id": "rel-new",
            "version_number": "2.0.0",
        }
        versions = [newer_release, older_release]
        got = main.select_version(versions, "26.2", "fabric", "mod", "release")
        self.assertEqual(got["id"], "rel-new")


class TestGetLatestVersion(unittest.TestCase):
    class _FakeClient:
        def __init__(self, versions):
            self._versions = versions

        def get_mod_version(self, mod_id):
            return self._versions

    def test_picks_matching_fabric_mod(self):
        versions = [
            {"game_versions": ["26.2"], "loaders": ["forge"]},
            {"game_versions": ["26.2"], "loaders": ["fabric"], "id": "ok"},
        ]
        got = main.get_latest_version(
            self._FakeClient(versions), "x", "26.2", "fabric", "mod", "release"
        )
        self.assertEqual(got["id"], "ok")

    def test_release_only_ignores_newer_alpha(self):
        versions = [
            {"game_versions": ["26.2"], "loaders": ["fabric"], "version_type": "alpha", "id": "alpha"},
            {"game_versions": ["26.2"], "loaders": ["fabric"], "version_type": "release", "id": "rel"},
        ]
        got = main.get_latest_version(
            self._FakeClient(versions), "x", "26.2", "fabric", "mod", "release"
        )
        self.assertEqual(got["id"], "rel")

    def test_resourcepack_matches_minecraft_loader(self):
        versions = [
            {"game_versions": ["26.2"], "loaders": ["minecraft"], "id": "pack"},
        ]
        got = main.get_latest_version(
            self._FakeClient(versions), "x", "26.2", "fabric", "resourcepack", "release"
        )
        self.assertEqual(got["id"], "pack")

    def test_mod_ignores_minecraft_only_version(self):
        versions = [
            {"game_versions": ["26.2"], "loaders": ["minecraft"]},
        ]
        got = main.get_latest_version(
            self._FakeClient(versions), "x", "26.2", "fabric", "mod", "release"
        )
        self.assertIsNone(got)


class TestDownloadDependencies(unittest.TestCase):
    def test_channel_policy_reaches_nested_dependencies_and_skipped_mods(self):
        def version(project_id, channel, dependency=None):
            return {
                "id": project_id + "-version",
                "version_type": channel,
                "game_versions": ["26.2"],
                "loaders": ["fabric"],
                "dependencies": (
                    [{"project_id": dependency, "dependency_type": "required"}]
                    if dependency else []
                ),
                "files": [{"primary": True, "filename": project_id + ".jar", "url": project_id}],
            }

        versions = {
            "parent": [version("parent", "release", "dep")],
            "dep": [version("dep", "beta", "nested")],
            "nested": [version("nested", "alpha")],
        }
        for update in (True, False):
            for channel, expected_deps in (
                ("release", []), ("beta", ["dep"]), ("alpha", ["dep", "nested"])
            ):
                with self.subTest(update=update, channel=channel), tempfile.TemporaryDirectory() as tmp:
                    mods_dir = os.path.join(tmp, "mods")
                    os.makedirs(mods_dir)
                    parent_filename = "parent.parent.jar" if update else "installed.parent.jar"
                    parent_path = os.path.join(mods_dir, parent_filename)
                    if not update:
                        with open(parent_path, "wb") as installed:
                            installed.write(b"original")

                    def download(url, filename):
                        with open(filename, "wb") as target:
                            target.write(b"downloaded")
                        return True

                    client = Mock(spec=main.ModrinthClient)
                    client.get_mod_project.side_effect = lambda pid: {"title": pid, "project_type": "mod"}
                    client.get_mod_version.side_effect = versions.__getitem__
                    client.download_file.side_effect = download
                    stats = {"downloaded": 0, "updated": 0, "skipped": 0, "failed": 0}
                    failed = []
                    with patch("sys.stdout", new_callable=io.StringIO):
                        main.download_mod(
                            "parent", client, mods_dir, os.path.join(tmp, "resourcepacks"),
                            "26.2", "fabric", update, main.get_existing_mods(mods_dir),
                            stats, failed, max_channel=channel,
                        )
                    self.assertEqual(
                        set(os.listdir(mods_dir)),
                        {parent_filename} | {pid + "." + pid + ".jar" for pid in expected_deps},
                    )
                    self.assertEqual(failed, {"release": ["dep"], "beta": ["nested"], "alpha": []}[channel])
                    self.assertEqual(stats["failed"], len(failed))
                    with open(parent_path, "rb") as installed:
                        self.assertEqual(installed.read(), b"downloaded" if update else b"original")


if __name__ == "__main__":
    unittest.main()
