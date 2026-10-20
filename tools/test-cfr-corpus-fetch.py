#!/usr/bin/env python3
"""Verify compressed official-source downloads preserve the source bytes."""
import gzip
import importlib.util
import io
import pathlib
import unittest
import urllib.error
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("cfr_generator", ROOT / "tools/generate-cfr-corpus.py")
GENERATOR = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(GENERATOR)


class Response(io.BytesIO):
    def __init__(self, data, encoding=""):
        super().__init__(data)
        self.headers = {"Content-Encoding": encoding}


class FetchTests(unittest.TestCase):
    def test_compression_required_endpoint_returns_decoded_source_bytes(self):
        source = b'<DIV5 TYPE="PART" N="19"><HEAD>PART 19</HEAD></DIV5>\n'

        def endpoint(request, timeout):
            if "gzip" not in request.get_header("Accept-encoding", ""):
                raise urllib.error.HTTPError(request.full_url, 406, "Compression required", {}, None)
            return Response(gzip.compress(source), "gzip")

        with patch.object(GENERATOR.urllib.request, "urlopen", endpoint):
            self.assertEqual(GENERATOR.fetch("https://www.ecfr.gov/source.xml"), source)

    def test_uncompressed_source_is_preserved(self):
        source = b'{"titles": []}\n'
        with patch.object(GENERATOR.urllib.request, "urlopen", return_value=Response(source)):
            self.assertEqual(GENERATOR.fetch("https://www.ecfr.gov/titles.json"), source)


if __name__ == "__main__":
    unittest.main()
