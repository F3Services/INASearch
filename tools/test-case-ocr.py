#!/usr/bin/env python3
"""Focused tests for provenance-safe OCR import and adjudication."""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from case_index.documents import adjudicate_ocr_layer, import_ocr
from case_index.ocr import OCR_RESULT_SCHEMA_SHA256, layer_is_selectable, normalize_ocr_result


ROOT = Path(__file__).resolve().parents[1]
PDF_HASH = "a" * 64
IMAGE_HASH = "b" * 64
CONTAINER_DIGEST = "sha256:" + "c" * 64


def result(page: int = 1, text: str = "OCR text with 8 U.S.C. § 1226(a).", **changes) -> dict:
    value = {
        "schemaVersion": 2,
        "caseId": "test-case",
        "pageNumber": page,
        "status": "succeeded",
        "text": text,
        "engine": {"name": "paddleocr-vl", "version": "1.6.0"},
        "model": {"name": "PaddlePaddle/PaddleOCR-VL-1.6", "revision": "0123456789abcdef"},
        "containerDigest": CONTAINER_DIGEST,
        "sourcePdfSha256": PDF_HASH,
        "imageSha256": IMAGE_HASH,
        "render": {"dpi": 300, "format": "png", "width": 1000, "height": 1400},
        "preprocessing": {"transforms": [{
            "operation": "pdf-render",
            "forwardMatrix": [1, 0, 0, 0, 1, 0, 0, 0, 1],
            "inverseMatrix": [1, 0, 0, 0, 1, 0, 0, 0, 1],
        }]},
        "promptSha256": "d" * 64,
        "outputSchemaSha256": OCR_RESULT_SCHEMA_SHA256,
        "layout": {
            "coordinateSpace": {"name": "rendered-page", "unit": "pixel", "origin": "top-left", "width": 1000, "height": 1400},
            "blocks": [{"id": "b1", "text": text, "bbox": [10, 20, 900, 200], "confidence": 0.94}],
            "words": [{"id": "w1", "text": "OCR", "bbox": [10, 20, 60, 45], "confidence": 0.98}],
        },
        "confidence": 0.94,
        "termination": {"stopReason": "stop", "truncated": False},
        "runtime": {"milliseconds": 120.5, "startedAt": "2026-08-30T00:00:00+00:00", "finishedAt": "2026-08-30T00:00:01+00:00"},
        "usage": {"completion_tokens": 10},
        "errors": [],
    }
    value.update(changes)
    return value


def document() -> dict:
    return {
        "schemaVersion": 1,
        "case": {"corpusKey": "test-case", "caseName": "TEST", "officialCitation": "20 I&N Dec. 1", "headnotes": []},
        "sourceArtifact": {"sha256": PDF_HASH, "finalUrl": "https://example.test/test.pdf", "path": "test.pdf"},
        "extraction": {
            "analysisSchemaVersion": 3,
            "pagesNeedingOcr": [1],
            "nativePagesNeedingOcr": [1],
            "pagesWithOcr": [],
            "pagesSelectedFromOcr": [],
        },
        "publisherHeadnoteAnalysis": {"citations": [], "caseCitations": [], "treatments": []},
        "pages": [{
            "pageNumber": 1,
            "nativeText": "Native weak text.",
            "selectedText": "Native weak text.",
            "selectedTextMethod": "pdf-native",
            "quality": {"score": 0.2, "needsOcr": True, "characters": 17},
            "citations": [], "caseCitations": [], "treatments": [],
        }],
    }


class OcrContractTests(unittest.TestCase):
    def test_v2_normalizes_full_provenance_and_coordinates(self) -> None:
        layer = normalize_ocr_result(result(), "test-case", 1, PDF_HASH)
        self.assertEqual(layer["provenance"]["model"]["revision"], "0123456789abcdef")
        self.assertEqual(layer["provenance"]["containerDigest"], CONTAINER_DIGEST)
        self.assertEqual(layer["layout"]["words"][0]["bbox"], [10.0, 20.0, 60.0, 45.0])
        self.assertTrue(layer_is_selectable(layer))

    def test_v2_rejects_schema_drift_and_out_of_bounds_coordinates(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "supported v2 contract"):
            normalize_ocr_result(result(outputSchemaSha256="e" * 64), "test-case", 1, PDF_HASH)
        bad = result()
        bad["layout"]["words"][0]["bbox"] = [10, 20, 1001, 45]
        with self.assertRaisesRegex(RuntimeError, "exceeds coordinate-space width"):
            normalize_ocr_result(bad, "test-case", 1, PDF_HASH)

    def test_truncated_layer_is_preserved_but_not_selectable(self) -> None:
        layer = normalize_ocr_result(
            result(termination={"stopReason": "length", "truncated": True}),
            "test-case", 1, PDF_HASH,
        )
        self.assertFalse(layer_is_selectable(layer))

    def test_validator_does_not_report_unknown_truncation_as_selectable(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            manifest = directory / "manifest.jsonl"
            results = directory / "results.jsonl"
            manifest.write_text(json.dumps({
                "jobId": "unknown-truncation-job",
                "caseId": "test-case",
                "pageNumber": 1,
                "source": {"pdfSha256": PDF_HASH},
                "image": {"sha256": IMAGE_HASH},
            }) + "\n", encoding="utf-8")
            row = result(
                jobId="unknown-truncation-job",
                termination={
                    "stopReason": None,
                    "finishReason": None,
                    "truncationKnown": False,
                    "truncated": None,
                },
            )
            results.write_text(json.dumps(row) + "\n", encoding="utf-8")
            completed = subprocess.run(
                [
                    sys.executable,
                    str(ROOT / "tools" / "case-ocr-validate-results.py"),
                    str(manifest),
                    str(results),
                    "--require-all-jobs",
                ],
                check=True,
                capture_output=True,
                text=True,
            )
            report = json.loads(completed.stdout)
            self.assertFalse(report["results"][0]["selectableAfterReview"])


class OcrDocumentTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.case_root = Path(self.temporary.name)
        (self.case_root / "derived").mkdir()
        (self.case_root / "derived" / "test-case.json").write_text(json.dumps(document()), encoding="utf-8")

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def write_rows(self, rows: list[dict]) -> Path:
        path = self.case_root / "results.jsonl"
        path.write_text("".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8")
        return path

    def test_import_keeps_multiple_layers_and_never_auto_selects(self) -> None:
        rows = [result(text="First OCR alternative."), result(text="Second OCR alternative.", imageSha256="f" * 64)]
        imported = import_ocr(ROOT, self.case_root, "test-case", self.write_rows(rows))
        page = imported["pages"][0]
        self.assertEqual(len(page["ocrLayers"]), 2)
        self.assertEqual(page["selectedText"], "Native weak text.")
        self.assertEqual(page["selectedTextMethod"], "pdf-native")
        self.assertEqual(imported["extraction"]["pagesNeedingOcr"], [])
        self.assertEqual(imported["extraction"]["pagesNeedingOcrReview"], [1])
        self.assertEqual(imported["extraction"]["pagesWithUnreviewedOcr"], [1])

    def test_adjudication_is_required_to_select_and_can_return_to_native(self) -> None:
        imported = import_ocr(ROOT, self.case_root, "test-case", self.write_rows([result()]))
        layer_id = imported["pages"][0]["ocrLayers"][0]["layerId"]
        selected = adjudicate_ocr_layer(
            ROOT, self.case_root, "test-case", 1, "select", "reviewer@example.test",
            "Compared against the rendered page and legal-token checklist.", layer_id,
        )
        self.assertEqual(selected["pages"][0]["selectedTextMethod"], f"ocr-layer:{layer_id}")
        self.assertEqual(selected["extraction"]["pagesSelectedFromOcr"], [1])
        native = adjudicate_ocr_layer(
            ROOT, self.case_root, "test-case", 1, "select-native", "reviewer@example.test",
            "OCR omitted a footnote; retain the native layer pending another pass.",
        )
        self.assertEqual(native["pages"][0]["selectedTextMethod"], "pdf-native")
        self.assertEqual(native["extraction"]["pagesNeedingOcrReview"], [1])

    def test_legacy_result_imports_as_partial_provenance_without_selection(self) -> None:
        legacy = {
            "schemaVersion": 1, "pageNumber": 1, "text": "Legacy OCR text.",
            "model": "legacy-model", "sourcePdfSha256": PDF_HASH,
            "imageSha256": IMAGE_HASH, "promptSha256": "d" * 64, "renderDpi": 300,
        }
        imported = import_ocr(ROOT, self.case_root, "test-case", self.write_rows([legacy]))
        page = imported["pages"][0]
        self.assertEqual(page["ocrLayers"][0]["provenance"]["completeness"], "legacy-partial")
        self.assertEqual(page["selectedTextMethod"], "pdf-native")
        self.assertNotIn("ocrText", page)


if __name__ == "__main__":
    unittest.main()
