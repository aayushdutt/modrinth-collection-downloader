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

    def test_empty_directory(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(main.get_existing_mods(tmp), {})


if __name__ == "__main__":
    unittest.main()
