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
            self.assertEqual(
                mods["LQ3K71Q1"]["directory"], os.path.abspath(tmp)
            )

    def test_empty_directory(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(main.get_existing_mods(tmp), {})


class TestResourcepacksDirectory(unittest.TestCase):
    def test_sibling_of_mods(self):
        with tempfile.TemporaryDirectory() as tmp:
            mods_path = os.path.join(tmp, "mods")
            rp = main.resourcepacks_directory(mods_path)
            self.assertEqual(rp, os.path.join(tmp, "resourcepacks"))


class TestMergeExistingMods(unittest.TestCase):
    def test_resourcepacks_wins_on_duplicate_id(self):
        with tempfile.TemporaryDirectory() as tmp:
            mods_path = os.path.join(tmp, "mods")
            rp_path = os.path.join(tmp, "resourcepacks")
            os.makedirs(mods_path)
            os.makedirs(rp_path)
            open(os.path.join(mods_path, "old.ABCD1234.zip"), "w").close()
            open(os.path.join(rp_path, "new.ABCD1234.zip"), "w").close()
            merged = main.merge_existing_mods(mods_path, rp_path)
            self.assertEqual(merged["ABCD1234"]["filename"], "new.ABCD1234.zip")
            self.assertEqual(merged["ABCD1234"]["directory"], os.path.abspath(rp_path))


class TestGetLatestVersionLoaderMatching(unittest.TestCase):
    class _FakeClient:
        def __init__(self, versions):
            self._versions = versions

        def get_mod_version(self, mod_id):
            return self._versions

    def test_resourcepack_matches_minecraft_loader_when_user_loader_fabric(self):
        versions = [
            {
                "game_versions": ["1.21"],
                "loaders": ["minecraft"],
            }
        ]
        client = self._FakeClient(versions)
        got = main.get_latest_version(
            client, "x", "1.21", "fabric", "resourcepack"
        )
        self.assertIsNotNone(got)

    def test_mod_requires_explicit_loader_match(self):
        versions = [
            {
                "game_versions": ["1.21"],
                "loaders": ["minecraft"],
            }
        ]
        client = self._FakeClient(versions)
        got = main.get_latest_version(client, "x", "1.21", "fabric", "mod")
        self.assertIsNone(got)


if __name__ == "__main__":
    unittest.main()
