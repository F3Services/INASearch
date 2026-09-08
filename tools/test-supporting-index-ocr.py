#!/usr/bin/env python3
"""Focused tests for the historical EOIR topical-index OCR queue contract."""

from __future__ import annotations

import unittest

from case_index.supporting import (
    TOPICAL_INDEX_OCR_CONTRACT_ID,
    _source_page_content_sha256,
    topical_index_layout_hints,
    topical_index_ocr_contract,
    topical_index_ocr_output_schema,
)


class _FakeContents:
    def __init__(self, value: bytes) -> None:
        self.value = value

    def get_data(self) -> bytes:
        return self.value


class _FakeImage:
    mode = "1"
    size = (4, 2)

    def __init__(self, value: bytes) -> None:
        self.value = value

    def tobytes(self) -> bytes:
        return self.value


class _FakeImageFile:
    def __init__(self, value: bytes) -> None:
        self.image = _FakeImage(value)


class _FakeBox(list):
    @property
    def width(self) -> int:
        return self[2] - self[0]

    @property
    def height(self) -> int:
        return self[3] - self[1]


class _FakePage:
    mediabox = _FakeBox([0, 0, 612, 792])
    cropbox = _FakeBox([0, 0, 612, 792])
    rotation = 0

    def __init__(self, content: bytes, image: bytes) -> None:
        self._contents = _FakeContents(content)
        self.images = [_FakeImageFile(image)]

    def get_contents(self) -> _FakeContents:
        return self._contents


class SupportingIndexOcrTests(unittest.TestCase):
    def test_two_column_regions_are_valid_overlapping_hints(self) -> None:
        layout = topical_index_layout_hints(
            2550, 3300, "eoir-index-vol1-15-a-e", 1,
        )
        regions = {region["id"]: region for region in layout["regions"]}
        self.assertEqual(regions["full-page"]["bboxPx"], [0, 0, 2550, 3300])
        self.assertIn("spanning-title", regions)
        left = regions["left-column"]["bboxPx"]
        right = regions["right-column"]["bboxPx"]
        self.assertGreater(left[2] - right[0], 0)
        self.assertEqual(layout["columnOverlapPx"], left[2] - right[0])
        for region in regions.values():
            x1, y1, x2, y2 = region["bboxPx"]
            self.assertLess(x1, x2)
            self.assertLess(y1, y2)
            self.assertGreaterEqual(x1, 0)
            self.assertGreaterEqual(y1, 0)
            self.assertLessEqual(x2, 2550)
            self.assertLessEqual(y2, 3300)

    def test_output_schema_requires_hierarchy_and_cross_references(self) -> None:
        schema = topical_index_ocr_output_schema()
        self.assertEqual(
            schema["properties"]["contractId"]["const"],
            TOPICAL_INDEX_OCR_CONTRACT_ID,
        )
        required = set(schema["required"])
        self.assertTrue({"blocks", "readingOrder", "crossReferences", "reporterReferences"} <= required)
        block = schema["properties"]["blocks"]["items"]["properties"]
        self.assertIn("parentBlockId", block)
        line = block["lines"]["items"]
        self.assertIn("indentLevel", line["required"])
        reporter_description = schema["properties"]["reporterReferences"]["description"]
        self.assertIn("not EOIR IDs", reporter_description)

    def test_contract_keeps_ocr_noncanonical_and_preserves_indent(self) -> None:
        contract = topical_index_ocr_contract()
        self.assertIn("No OCR or VLM result is canonical", contract["canonicalPolicy"])
        rules = " ".join(contract["transcriptionRules"])
        self.assertIn("indentation", rules)
        self.assertIn("see/see also", rules)
        self.assertIn("volume-page", rules)

    def test_source_page_fingerprint_is_content_based(self) -> None:
        first = _source_page_content_sha256(_FakePage(b"content", b"pixels"))
        identical = _source_page_content_sha256(_FakePage(b"content", b"pixels"))
        changed = _source_page_content_sha256(_FakePage(b"content", b"pixelZ"))
        self.assertEqual(first, identical)
        self.assertNotEqual(first, changed)
        self.assertEqual(len(first), 64)


if __name__ == "__main__":
    unittest.main()
