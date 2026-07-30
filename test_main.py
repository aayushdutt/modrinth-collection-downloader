"""Unit tests for main.py helpers (stdlib only, no network)."""

import os
import tempfile
import unittest

import main


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
            self._FakeClient(versions), "x", "26.2", "fabric", "mod"
        )
        self.assertEqual(got["id"], "ok")

    def test_resourcepack_matches_minecraft_loader(self):
        versions = [
            {"game_versions": ["26.2"], "loaders": ["minecraft"], "id": "pack"},
        ]
        got = main.get_latest_version(
            self._FakeClient(versions), "x", "26.2", "fabric", "resourcepack"
        )
        self.assertEqual(got["id"], "pack")

    def test_mod_ignores_minecraft_only_version(self):
        versions = [
            {"game_versions": ["26.2"], "loaders": ["minecraft"]},
        ]
        got = main.get_latest_version(
            self._FakeClient(versions), "x", "26.2", "fabric", "mod"
        )
        self.assertIsNone(got)


if __name__ == "__main__":
    unittest.main()
