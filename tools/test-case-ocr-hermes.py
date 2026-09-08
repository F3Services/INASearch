#!/usr/bin/env python3
"""Focused tests for the inbound Hermes OCR result bridge."""

from __future__ import annotations

import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from case_index.hermes_ocr import convert_hermes_results
from case_index.ocr import (
    OCR_RESULT_SCHEMA_SHA256,
    layer_is_selectable,
    normalize_ocr_result,
)


PDF_HASH = "a" * 64
CONTAINER_DIGEST = "sha256:" + "c" * 64
PROMPT_HASH = "d" * 64
WORKER_COMMIT = "a" * 40
RECOVERY_SCHEMA = "inasearch-ocr-recovery-job/v1"
ORIGINAL_MANIFEST_HASH = "b" * 64
ENGINES = ["paddleocr-vl-1.6", "ovisocr2", "pp-ocrv6"]
ROOT = Path(__file__).resolve().parents[1]


class HermesOcrBridgeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        images = self.root / "images"
        images.mkdir()
        self.image = images / "page.png"
        self.image.write_bytes(b"synthetic-png-evidence")
        self.image_hash = hashlib.sha256(self.image.read_bytes()).hexdigest()
        self.rich = {
            "schemaVersion": 1,
            "jobId": "ocr-smoke-test-job",
            "caseId": "eoir-test",
            "pageNumber": 2,
            "source": {"pdfSha256": PDF_HASH},
            "image": {
                "path": "images/page.png", "sha256": self.image_hash,
                "format": "png", "dpi": 300, "width": 1000, "height": 1400,
            },
            "preprocessing": {
                "initialTransforms": [{
                    "operation": "pdf-render",
                    "sourceSpace": "pdf-points",
                    "targetSpace": "rendered-page-pixels",
                    "parameters": {"dpi": 300},
                    "forwardMatrix": [1, 0, 0, 0, 1, 0, 0, 0, 1],
                    "inverseMatrix": [1, 0, 0, 0, 1, 0, 0, 0, 1],
                }],
            },
        }
        self.manifest = self.root / "manifest.jsonl"
        self.write_manifest()

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def write_manifest(self) -> None:
        self.manifest.write_text(json.dumps(self.rich) + "\n", encoding="utf-8")

    def configure_recovery(self, **changes) -> tuple[str, str]:
        original_job_id = self.rich["jobId"]
        recovery_job_id = f"{original_job_id}-r2-test"
        self.rich["jobId"] = recovery_job_id
        self.rich["expectedResult"] = {
            "jobId": recovery_job_id,
            "outputSchemaSha256": OCR_RESULT_SCHEMA_SHA256,
        }
        self.rich["recovery"] = {
            "schemaVersion": RECOVERY_SCHEMA,
            "originalJobId": original_job_id,
            "recoveryJobId": recovery_job_id,
            "originalManifestSha256": ORIGINAL_MANIFEST_HASH,
            "originalImageSha256": self.image_hash,
            "workerCommit": WORKER_COMMIT,
            **changes,
        }
        self.write_manifest()
        return original_job_id, recovery_job_id

    def remote_job(self) -> dict:
        return {
            "schemaVersion": "inasearch-ocr-job/v1",
            "jobId": self.rich["jobId"],
            "caseId": self.rich["caseId"],
            "pageNumber": self.rich["pageNumber"],
            "sourcePdfSha256": PDF_HASH,
            "imageSha256": self.image_hash,
            "imageFilename": f"{self.rich['jobId']}.png",
            "renderDpi": 300,
            "preprocessing": {
                "sourceToImageTransform": [1, 0, 0, 1, 0, 0],
                "operations": [{"operation": "contrast", "parameters": {"method": "clahe"}}],
            },
            "requestedEngines": ENGINES,
        }

    def layer(self, engine: str, **changes) -> dict:
        value = {
            "engine": engine,
            "engineVersion": "1.0.0",
            "model": f"publisher/{engine}",
            "modelRevision": f"commit-{engine}",
            "promptOrTemplateSha256": PROMPT_HASH,
            "text": f"Text from {engine} with 8 U.S.C. § 1226(a).",
            "markdown": f"Text from **{engine}** with 8 U.S.C. § 1226(a).",
            "blocks": [{
                "id": f"{engine}-block", "text": "Text", "bbox": [10, 20, 900, 200],
                "confidence": None, "role": "paragraph",
            }],
            "lines": [{
                "id": f"{engine}-line", "text": "Text", "bbox": [10, 20, 300, 50],
                "confidence": 0.93, "block_id": f"{engine}-block",
            }],
            "words": [{
                "id": f"{engine}-word", "text": "Text",
                "polygon": [[10, 20], [60, 20], [60, 45], [10, 45]],
                "recognitionScore": 0.98, "line_id": f"{engine}-line",
            }],
            "coordinateSpace": {"width": 1000, "height": 1400, "units": "pixels", "origin": "top-left"},
            "confidence": None,
            "stopReason": "complete",
            "truncated": False,
            "runtimeMs": 123.5,
            "warnings": [],
            "error": None,
            "preprocessing": {
                "operations": [{
                    "operation": "deskew",
                    "forwardMatrix": [1, 0, 0, 1, 2, 3],
                    "inverseMatrix": [1, 0, 0, 1, -2, -3],
                }],
            },
        }
        value.update(changes)
        return value

    def layer_provenance(self, layer: dict, digest_character: str) -> dict:
        weights = [{
            "path": f"models/{layer['engine']}/weights.safetensors",
            "sha256": digest_character * 64,
        }]
        weight_set_hash = hashlib.sha256(
            (json.dumps(weights, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")
        ).hexdigest()
        return {
            "backend": {"type": f"{layer['engine']}-backend", "version": "backend-1"},
            "runtimeArtifact": {
                "type": "container-repo-digest" if layer["engine"] == ENGINES[0] else "venv-lock-sha256",
                "digest": "sha256:" + digest_character * 64,
                "source": f"env/{layer['engine']}.lock",
            },
            "model": {
                "name": layer["model"],
                "revision": layer["modelRevision"],
                "weightSetSha256": weight_set_hash,
                "weightFiles": weights,
            },
            "backendConfigSha256": ("1" if digest_character != "1" else "2") * 64,
            "promptOrTemplateSha256": layer["promptOrTemplateSha256"],
            "adapterSha256": "8" * 64,
            "input": {"imageSha256": self.image_hash, "sourcePdfSha256": PDF_HASH},
            "software": {
                "cudaRuntime": "12.9", "cudnn": "9.12", "paddle": "3.3.1",
                "torch": "2.11.0", "vllm": "0.22.1", "nvidiaDriver": "595.84",
            },
            "workerGitCommit": WORKER_COMMIT,
        }

    def corrected_layer(self, engine: str, **changes) -> dict:
        digest_character = {ENGINES[0]: "4", ENGINES[1]: "5", ENGINES[2]: "6"}[engine]
        value = self.layer(
            engine,
            finishReason=None if engine == ENGINES[2] else "stop",
            outputTokenCount=None if engine == ENGINES[2] else 321,
            maxOutputTokens=None if engine == ENGINES[2] else 4096,
            truncationKnown=True,
            runtimeMs=124,
            audit={"adapter": engine, "nativeResultSha256": "7" * 64},
        )
        value.update({
            "blocks": [{
                "id": 0, "order": 0, "type": "paragraph", "text": "Text",
                "box": [10, 20, 900, 200],
                "polygon": [[10, 20], [900, 20], [900, 200], [10, 200]],
                "layoutConfidence": 0.91,
            }],
            "lines": [{
                "index": 0, "text": "Text", "confidence": 0.93,
                "box": [10, 20, 300, 50],
                "polygon": [[10, 20], [300, 20], [300, 50], [10, 50]],
            }],
            "words": [{
                "lineIndex": 0, "tokenIndex": 0, "text": "Text", "box": [10, 20, 60, 45],
                "confidence": None, "containingLineConfidence": 0.93,
                "semanticUnit": "native-token-or-glyph",
            }],
        })
        value["provenance"] = self.layer_provenance(value, digest_character)
        value.update(changes)
        return value

    def legacy_envelope(self, layers: list[dict] | None = None) -> dict:
        return {
            "schemaVersion": "inasearch-ocr-result/v1",
            "job": self.remote_job(),
            "worker": {
                "workerVersion": "worker-content-sha",
                "hostClass": "rtx-5090",
                "cudaVersion": "12.8",
                "driverVersion": "570.00",
                "containerDigest": CONTAINER_DIGEST,
                "environmentManifestSha256": "e" * 64,
            },
            "layers": layers if layers is not None else [self.layer(engine) for engine in ENGINES],
            "startedAt": "2026-08-30T20:00:00Z",
            "completedAt": "2026-08-30T20:00:03Z",
        }

    def corrected_envelope(self, layers: list[dict] | None = None) -> dict:
        return {
            "schemaVersion": "inasearch-ocr-result/v1",
            "job": self.remote_job(),
            "worker": {"workerVersion": WORKER_COMMIT, "hostClass": "rtx-5090"},
            "coordinateMapping": {
                "sourceToImageTransform": [1, 0, 0, 1, 0, 0],
                "imageToSourceTransform": [1, 0, 0, 1, 0, 0],
                "operations": self.remote_job()["preprocessing"]["operations"],
            },
            "layers": layers if layers is not None else [
                self.corrected_layer(engine) for engine in ENGINES
            ],
            "startedAt": "2026-08-30T20:00:00Z",
            "completedAt": "2026-08-30T20:00:03Z",
        }

    def convert(
        self,
        envelope: dict,
        name: str = "converted.jsonl",
        **options,
    ) -> tuple[dict, list[dict], Path]:
        results = self.root / f"{name}.input"
        results.write_text(json.dumps(envelope) + "\n", encoding="utf-8")
        output = self.root / name
        summary = convert_hermes_results(
            self.manifest, results, output, require_all_jobs=True, **options,
        )
        rows = [json.loads(line) for line in output.read_text(encoding="utf-8").splitlines()]
        return summary, rows, output

    def test_all_three_layers_are_flattened_and_provenance_is_preserved(self) -> None:
        summary, rows, _output = self.convert(self.corrected_envelope())
        self.assertEqual(summary["layersWritten"], 3)
        self.assertEqual(summary["layerStatuses"], {"succeeded": 3})
        self.assertEqual([row["engine"]["name"] for row in rows], ENGINES)
        self.assertTrue(all(row["jobId"] == self.rich["jobId"] for row in rows))
        self.assertTrue(all(row["sourcePdfSha256"] == PDF_HASH for row in rows))
        self.assertTrue(all(row["imageSha256"] == self.image_hash for row in rows))
        self.assertTrue(all(len(row["preprocessing"]["transforms"]) == 3 for row in rows))
        self.assertEqual(summary["provenanceCompleteness"], {"complete-per-layer": 3})
        self.assertEqual(rows[0]["containerDigest"], "sha256:" + "4" * 64)
        self.assertEqual(rows[1]["layerProvenance"]["model"]["weightFiles"][0]["sha256"], "5" * 64)
        self.assertEqual(rows[2]["layerProvenance"]["backendConfigSha256"], "1" * 64)
        self.assertEqual(rows[2]["layerProvenance"]["adapterSha256"], "8" * 64)

        normalized = normalize_ocr_result(rows[2], self.rich["caseId"], 2, PDF_HASH)
        self.assertEqual(normalized["provenance"]["completeness"], "complete-per-layer")
        self.assertEqual(normalized["provenance"]["layer"]["software"]["cudaRuntime"], "12.9")
        self.assertEqual(normalized["provenance"]["layer"]["software"]["nvidiaDriver"], "595.84")
        self.assertEqual(normalized["provenance"]["containerDigest"], "sha256:" + "6" * 64)
        self.assertEqual(normalized["provenance"]["remoteJob"]["imageSha256"], self.image_hash)
        self.assertEqual(normalized["provenance"]["workerResultSchemaVersion"], "inasearch-ocr-result/v1")
        self.assertEqual(normalized["provenance"]["layer"]["adapterSha256"], "8" * 64)
        self.assertEqual(normalized["layout"]["lines"][0]["index"], 0)
        self.assertEqual(normalized["layout"]["words"][0]["bbox"], [10.0, 20.0, 60.0, 45.0])
        self.assertEqual(len(normalized["layout"]["blocks"][0]["polygon"]), 4)
        self.assertEqual(normalized["markdown"], rows[2]["markdown"])
        self.assertTrue(layer_is_selectable(normalized))

    def test_recovery_mapping_allows_only_the_original_image_filename_and_survives_normalization(self) -> None:
        original_job_id, recovery_job_id = self.configure_recovery()
        envelope = self.corrected_envelope()
        envelope["job"]["imageFilename"] = f"{original_job_id}.png"

        summary, rows, _output = self.convert(envelope, "recovery.jsonl")

        self.assertEqual(summary["layersWritten"], 3)
        self.assertTrue(all(row["jobId"] == recovery_job_id for row in rows))
        self.assertTrue(all(
            row["remoteJob"]["imageFilename"] == f"{original_job_id}.png"
            for row in rows
        ))
        self.assertTrue(all(
            row["recoveryProvenance"] == self.rich["recovery"] for row in rows
        ))
        normalized = normalize_ocr_result(
            rows[0], self.rich["caseId"], self.rich["pageNumber"], PDF_HASH,
        )
        self.assertEqual(
            normalized["provenance"]["recovery"]["originalJobId"],
            original_job_id,
        )
        self.assertEqual(
            normalized["provenance"]["recovery"]["recoveryJobId"],
            recovery_job_id,
        )
        self.assertEqual(
            normalized["provenance"]["recovery"]["originalManifestSha256"],
            ORIGINAL_MANIFEST_HASH,
        )

    def test_ordinary_and_recovery_jobs_both_reject_arbitrary_image_filenames(self) -> None:
        ordinary = self.corrected_envelope()
        ordinary["job"]["imageFilename"] = "some-other-safe-name.png"
        with self.assertRaisesRegex(RuntimeError, "unexpected imageFilename"):
            self.convert(ordinary, "ordinary-arbitrary-filename.jsonl")

        original_job_id, _recovery_job_id = self.configure_recovery()
        recovery = self.corrected_envelope()
        recovery["job"]["imageFilename"] = f"{original_job_id}-wrong.png"
        with self.assertRaisesRegex(RuntimeError, "unexpected imageFilename"):
            self.convert(recovery, "recovery-arbitrary-filename.jsonl")

    def test_recovery_manifest_rejects_inconsistent_or_unsafe_mappings(self) -> None:
        original_job_id, recovery_job_id = self.configure_recovery()
        envelope = self.corrected_envelope()
        envelope["job"]["imageFilename"] = f"{original_job_id}.png"
        valid_rich = json.loads(json.dumps(self.rich))

        cases = {
            "mapped recovery ID": (
                lambda job: job["recovery"].update({"recoveryJobId": f"{recovery_job_id}-other"}),
                "recoveryJobId",
            ),
            "expected result ID": (
                lambda job: job["expectedResult"].update({"jobId": original_job_id}),
                "expectedResult.jobId",
            ),
            "expected result schema": (
                lambda job: job["expectedResult"].update({"outputSchemaSha256": "f" * 64}),
                "expectedResult.outputSchemaSha256",
            ),
            "original image hash": (
                lambda job: job["recovery"].update({"originalImageSha256": "f" * 64}),
                "originalImageSha256",
            ),
            "malformed original manifest hash": (
                lambda job: job["recovery"].update({"originalManifestSha256": "not-a-digest"}),
                "originalManifestSha256",
            ),
            "unsupported recovery schema": (
                lambda job: job["recovery"].update({"schemaVersion": "recovery/v999"}),
                "unsupported schemaVersion",
            ),
            "unsafe original ID": (
                lambda job: job["recovery"].update({"originalJobId": "../escape"}),
                "originalJobId",
            ),
            "missing original manifest hash": (
                lambda job: job["recovery"].pop("originalManifestSha256"),
                "fields do not match",
            ),
            "unexpected contract field": (
                lambda job: job["recovery"].update({"filenameOverride": "anything.png"}),
                "fields do not match",
            ),
        }
        for name, (mutate, message) in cases.items():
            with self.subTest(name=name):
                self.rich = json.loads(json.dumps(valid_rich))
                mutate(self.rich)
                self.write_manifest()
                with self.assertRaisesRegex(RuntimeError, message):
                    self.convert(envelope, f"invalid-recovery-{name.replace(' ', '-')}.jsonl")

    def test_recovery_manifest_requires_one_to_one_original_job_ids(self) -> None:
        original_job_id, recovery_job_id = self.configure_recovery()
        second = json.loads(json.dumps(self.rich))
        second_recovery_job_id = f"{recovery_job_id}-second"
        second["jobId"] = second_recovery_job_id
        second["expectedResult"]["jobId"] = second_recovery_job_id
        second["recovery"]["recoveryJobId"] = second_recovery_job_id
        self.manifest.write_text(
            json.dumps(self.rich) + "\n" + json.dumps(second) + "\n",
            encoding="utf-8",
        )
        envelope = self.corrected_envelope()
        envelope["job"]["imageFilename"] = f"{original_job_id}.png"
        with self.assertRaisesRegex(RuntimeError, "duplicates recovery originalJobId"):
            self.convert(envelope, "duplicate-original-recovery-id.jsonl")

    def test_recovery_manifest_worker_commit_must_match_the_envelope(self) -> None:
        original_job_id, _recovery_job_id = self.configure_recovery(
            workerCommit="b" * 40,
        )
        envelope = self.corrected_envelope()
        envelope["job"]["imageFilename"] = f"{original_job_id}.png"
        with self.assertRaisesRegex(RuntimeError, "worker commit does not match"):
            self.convert(envelope, "recovery-worker-mismatch.jsonl")

    def test_corrected_block_polygons_preserve_three_five_and_ten_points(self) -> None:
        polygons = {
            3: [[10, 20], [900, 20], [450, 200]],
            5: [[10, 20], [500, 20], [900, 80], [700, 200], [10, 200]],
            10: [
                [10, 20], [300, 20], [500, 35], [700, 20], [900, 20],
                [900, 200], [650, 200], [450, 185], [250, 200], [10, 200],
            ],
        }
        for point_count, polygon in polygons.items():
            with self.subTest(point_count=point_count):
                envelope = self.corrected_envelope()
                envelope["layers"][0]["blocks"][0]["polygon"] = polygon
                _summary, rows, _output = self.convert(
                    envelope, f"polygon-{point_count}.jsonl"
                )
                expected = [[float(x), float(y)] for x, y in polygon]
                self.assertEqual(rows[0]["layout"]["blocks"][0]["polygon"], expected)
                normalized = normalize_ocr_result(
                    rows[0], self.rich["caseId"], 2, PDF_HASH
                )
                self.assertEqual(
                    normalized["layout"]["blocks"][0]["polygon"], expected
                )

    def test_corrected_block_polygon_cardinality_is_bounded(self) -> None:
        for point_count in (0, 1, 2, 4097):
            with self.subTest(point_count=point_count):
                envelope = self.corrected_envelope()
                envelope["layers"][0]["blocks"][0]["polygon"] = [
                    [float(index % 1000), float((index * 7) % 1400)]
                    for index in range(point_count)
                ]
                with self.assertRaisesRegex(
                    RuntimeError, "at least three points|between 3 and 4096 points"
                ):
                    self.convert(envelope, f"polygon-cardinality-{point_count}.jsonl")

    def test_corrected_block_polygon_rejects_malformed_nonfinite_and_out_of_bounds(self) -> None:
        invalid_polygons = {
            "malformed": [[10, 20], [900], [10, 200]],
            "nonfinite": [[10, 20], [900, 20], [float("nan"), 200]],
            "out-of-bounds": [[10, 20], [1001, 20], [10, 200]],
        }
        for label, polygon in invalid_polygons.items():
            with self.subTest(label=label):
                envelope = self.corrected_envelope()
                envelope["layers"][0]["blocks"][0]["polygon"] = polygon
                with self.assertRaises(RuntimeError):
                    self.convert(envelope, f"polygon-invalid-{label}.jsonl")

    def test_corrected_line_polygon_remains_a_quadrilateral(self) -> None:
        envelope = self.corrected_envelope()
        envelope["layers"][0]["lines"][0]["polygon"] = [
            [10, 20], [300, 20], [300, 50], [150, 60], [10, 50],
        ]
        with self.assertRaisesRegex(RuntimeError, "exactly four points"):
            self.convert(envelope, "line-polygon-five-points.jsonl")

    def test_paddle_unknown_truncation_is_preserved_and_never_selectable(self) -> None:
        paddle = self.corrected_layer(
            ENGINES[0], stopReason=None, finishReason=None, outputTokenCount=None,
            truncationKnown=False, truncated=None,
            warnings=["Completion and truncation are unknown."],
        )
        layers = [paddle, self.corrected_layer(ENGINES[1]), self.corrected_layer(ENGINES[2])]
        _summary, rows, _output = self.convert(self.corrected_envelope(layers), "unknown.jsonl")
        normalized = normalize_ocr_result(rows[0], self.rich["caseId"], 2, PDF_HASH)
        self.assertEqual(normalized["status"], "succeeded")
        self.assertIsNone(normalized["termination"]["stopReason"])
        self.assertFalse(normalized["termination"]["truncationKnown"])
        self.assertIsNone(normalized["termination"]["truncated"])
        self.assertIsNone(normalized["usage"]["outputTokenCount"])
        self.assertEqual(normalized["usage"]["maxOutputTokens"], 4096)
        self.assertFalse(layer_is_selectable(normalized))

    def test_ovis_cleanup_audit_retains_raw_and_cleaned_evidence(self) -> None:
        raw = "A legal page." + (" repeated" * 20)
        cleaned = "A legal page. repeated"
        audit = {
            "rawOutput": raw,
            "rawOutputSha256": hashlib.sha256(raw.encode("utf-8")).hexdigest(),
            "repeatedTailCleanupApplied": True,
            "repeatedTailCleanup": {
                "unitLength": 9, "repeatTimes": 20,
                "repeatedTailChars": 180, "retainedTailChars": 9,
            },
        }
        layers = [
            self.corrected_layer(ENGINES[0]),
            self.corrected_layer(ENGINES[1], text=cleaned, markdown=cleaned, audit=audit),
            self.corrected_layer(ENGINES[2]),
        ]
        _summary, rows, _output = self.convert(self.corrected_envelope(layers), "cleanup.jsonl")
        normalized = normalize_ocr_result(rows[1], self.rich["caseId"], 2, PDF_HASH)
        self.assertEqual(normalized["text"], cleaned)
        self.assertEqual(normalized["audit"]["rawOutput"], raw)
        self.assertTrue(normalized["audit"]["repeatedTailCleanupApplied"])
        self.assertEqual(normalized["audit"]["rawOutputSha256"], audit["rawOutputSha256"])

    def test_ovis_additive_triton_and_flashinfer_software_provenance_survives(self) -> None:
        ovis = self.corrected_layer(ENGINES[1])
        ovis["provenance"]["software"].update({
            "triton": "3.6.0",
            "flashinfer": "0.6.11.post2",
        })
        layers = [self.corrected_layer(ENGINES[0]), ovis, self.corrected_layer(ENGINES[2])]
        _summary, rows, _output = self.convert(
            self.corrected_envelope(layers), "ovis-software.jsonl"
        )
        self.assertEqual(rows[1]["layerProvenance"]["software"]["triton"], "3.6.0")
        self.assertEqual(
            rows[1]["layerProvenance"]["software"]["flashinfer"], "0.6.11.post2"
        )
        normalized = normalize_ocr_result(rows[1], self.rich["caseId"], 2, PDF_HASH)
        self.assertEqual(normalized["provenance"]["layer"]["software"]["triton"], "3.6.0")
        self.assertEqual(
            normalized["provenance"]["layer"]["software"]["flashinfer"],
            "0.6.11.post2",
        )

    def test_current_worker_and_ovis_executor_pins_gate_the_entire_local_pipeline(self) -> None:
        executor_hash = "9" * 64
        envelope = self.corrected_envelope()
        ovis = envelope["layers"][1]
        ovis["provenance"]["software"]["ovisFileStoreExecutorSha256"] = executor_hash
        ovis["audit"].update({
            "ovisFileStoreExecutorSha256": executor_hash,
            "executorInspection": {
                "method": "sha256",
                "path": "/locked/site-packages/vllm/executor/uniproc_executor.py",
            },
            "networkIsolationEvidence": {
                "systemdIpPolicy": "loopback-only",
                "ipv4MappedLoopbackObserved": True,
            },
        })
        source = self.root / "current-worker-envelope.jsonl"
        source.write_text(json.dumps(envelope) + "\n", encoding="utf-8")
        converted = self.root / "current-worker-converted.jsonl"
        pins = [
            "--expected-worker-commit", WORKER_COMMIT,
            "--expected-ovis-file-store-executor-sha256", executor_hash,
        ]
        conversion = subprocess.run(
            [
                sys.executable, str(ROOT / "tools" / "case-ocr-convert-hermes.py"),
                str(self.manifest), str(source), str(converted),
                "--require-all-jobs", *pins,
            ],
            cwd=ROOT, text=True, capture_output=True, check=True,
        )
        conversion_summary = json.loads(conversion.stdout)
        self.assertEqual(
            conversion_summary["provenancePins"]["expectedWorkerCommit"],
            WORKER_COMMIT,
        )
        rows = [json.loads(line) for line in converted.read_text(encoding="utf-8").splitlines()]
        converted_ovis = rows[1]
        self.assertEqual(
            converted_ovis["layerProvenance"]["software"]["ovisFileStoreExecutorSha256"],
            executor_hash,
        )
        self.assertEqual(
            converted_ovis["audit"]["executorInspection"]["method"], "sha256"
        )
        normalized = normalize_ocr_result(converted_ovis, self.rich["caseId"], 2, PDF_HASH)
        self.assertEqual(
            normalized["provenance"]["layer"]["software"]["ovisFileStoreExecutorSha256"],
            executor_hash,
        )
        self.assertTrue(
            normalized["audit"]["networkIsolationEvidence"]["ipv4MappedLoopbackObserved"]
        )

        validation = subprocess.run(
            [
                sys.executable, str(ROOT / "tools" / "case-ocr-validate-results.py"),
                str(self.manifest), str(converted), "--require-all-jobs", *pins,
            ],
            cwd=ROOT, text=True, capture_output=True, check=True,
        )
        self.assertTrue(json.loads(validation.stdout)["valid"])
        benchmark_json = self.root / "current-worker-benchmark.json"
        benchmark_md = self.root / "current-worker-benchmark.md"
        subprocess.run(
            [
                sys.executable, str(ROOT / "tools" / "case-ocr-benchmark.py"),
                str(self.manifest), str(converted), str(benchmark_json), str(benchmark_md),
                "--require-all-jobs", *pins,
            ],
            cwd=ROOT, text=True, capture_output=True, check=True,
        )
        benchmark = json.loads(benchmark_json.read_text(encoding="utf-8"))
        benchmark_ovis = next(
            attempt
            for page in benchmark["pages"]
            for attempt in page["attempts"]
            if attempt["engine"]["name"] == "ovisocr2"
        )
        evidence = benchmark_ovis["provenance"]["evidence"]
        self.assertEqual(
            evidence["layerProvenance"]["software"]["ovisFileStoreExecutorSha256"],
            executor_hash,
        )
        self.assertEqual(
            evidence["audit"]["executorInspection"]["path"],
            "/locked/site-packages/vllm/executor/uniproc_executor.py",
        )

        wrong_commit = "b" * 40
        wrong_envelope = self.corrected_envelope()
        wrong_envelope["worker"]["workerVersion"] = wrong_commit
        for layer in wrong_envelope["layers"]:
            layer["provenance"]["workerGitCommit"] = wrong_commit
        wrong_envelope["layers"][1]["provenance"]["software"][
            "ovisFileStoreExecutorSha256"
        ] = executor_hash
        with self.assertRaisesRegex(RuntimeError, "expected worker commit"):
            self.convert(
                wrong_envelope,
                "wrong-worker-converted.jsonl",
                expected_worker_commit=WORKER_COMMIT,
                expected_ovis_file_store_executor_sha256=executor_hash,
            )
        _summary, _wrong_rows, wrong_converted = self.convert(
            wrong_envelope, "wrong-worker-unpinned.jsonl"
        )
        for command in (
            [
                sys.executable, str(ROOT / "tools" / "case-ocr-validate-results.py"),
                str(self.manifest), str(wrong_converted), "--require-all-jobs", *pins,
            ],
            [
                sys.executable, str(ROOT / "tools" / "case-ocr-benchmark.py"),
                str(self.manifest), str(wrong_converted),
                str(self.root / "wrong-benchmark.json"),
                str(self.root / "wrong-benchmark.md"),
                "--require-all-jobs", *pins,
            ],
        ):
            rejected = subprocess.run(
                command, cwd=ROOT, text=True, capture_output=True, check=False
            )
            self.assertNotEqual(rejected.returncode, 0)
            self.assertIn("expected worker commit", rejected.stderr)

        malformed = self.corrected_envelope()
        malformed["layers"][1]["provenance"]["software"][
            "ovisFileStoreExecutorSha256"
        ] = "not-a-sha256"
        with self.assertRaisesRegex(RuntimeError, "ovisFileStoreExecutorSha256"):
            self.convert(malformed, "malformed-executor.jsonl")

    def test_pp_native_token_or_glyph_boxes_and_linked_confidence_survive(self) -> None:
        pp = self.corrected_layer(ENGINES[2])
        pp["words"] = [{
            "lineIndex": 0, "tokenIndex": 3, "text": "§",
            "box": [100, 200, 112, 232], "confidence": None,
            "containingLineConfidence": 0.987,
            "semanticUnit": "native-token-or-glyph",
        }]
        layers = [self.corrected_layer(ENGINES[0]), self.corrected_layer(ENGINES[1]), pp]
        _summary, rows, _output = self.convert(self.corrected_envelope(layers), "glyph.jsonl")
        normalized = normalize_ocr_result(rows[2], self.rich["caseId"], 2, PDF_HASH)
        glyph = normalized["layout"]["words"][0]
        self.assertEqual(glyph["text"], "§")
        self.assertEqual(glyph["bbox"], [100.0, 200.0, 112.0, 232.0])
        self.assertEqual(glyph["semanticUnit"], "native-token-or-glyph")
        self.assertEqual(glyph["lineIndex"], 0)
        self.assertEqual(glyph["tokenIndex"], 3)
        self.assertAlmostEqual(glyph["containingLineConfidence"], 0.987)

    def test_original_worker_level_v1_remains_compatible_but_is_marked_legacy(self) -> None:
        summary, rows, _output = self.convert(self.legacy_envelope(), "legacy.jsonl")
        self.assertEqual(summary["provenanceCompleteness"], {"legacy-worker-level-runtime": 3})
        normalized = normalize_ocr_result(rows[0], self.rich["caseId"], 2, PDF_HASH)
        self.assertEqual(normalized["provenance"]["completeness"], "legacy-worker-level-runtime")
        self.assertEqual(normalized["provenance"]["worker"]["cudaVersion"], "12.8")
        self.assertEqual(normalized["provenance"]["worker"]["containerDigest"], CONTAINER_DIGEST)

    def test_committed_adapter_audit_geometry_and_error_assertions_are_rejected_when_false(self) -> None:
        missing_adapter = self.corrected_envelope()
        del missing_adapter["layers"][0]["provenance"]["adapterSha256"]
        with self.assertRaisesRegex(RuntimeError, "adapter"):
            self.convert(missing_adapter, "missing-adapter.jsonl")

        false_audit = self.corrected_envelope()
        false_audit["layers"][1]["audit"] = {
            "rawOutput": "unaltered source evidence", "rawOutputSha256": "0" * 64,
        }
        with self.assertRaisesRegex(RuntimeError, "rawOutput hash mismatch"):
            self.convert(false_audit, "false-audit.jsonl")

        missing_line = self.corrected_envelope()
        missing_line["layers"][2]["words"][0]["lineIndex"] = 8
        with self.assertRaisesRegex(RuntimeError, "missing line"):
            self.convert(missing_line, "missing-line.jsonl")

        false_error = self.corrected_envelope()
        false_error["layers"][0].update({
            "stopReason": "error", "truncationKnown": False, "truncated": None,
            "error": {"type": "EngineCrash", "message": "failed"},
        })
        with self.assertRaisesRegex(RuntimeError, "retryable"):
            self.convert(false_error, "false-error.jsonl")

    def test_error_and_truncated_partial_layers_are_retained_but_not_selectable(self) -> None:
        layers = [
            self.layer(ENGINES[0]),
            self.layer(ENGINES[1], text="Partial Ovis text.", truncated=True, stopReason="max_tokens"),
            self.layer(ENGINES[2], text="Partial PP text.", error={"type": "EngineCrash", "message": "test failure"}),
        ]
        summary, rows, _output = self.convert(self.legacy_envelope(layers), "partial.jsonl")
        self.assertEqual(summary["layerStatuses"], {"failed": 2, "succeeded": 1})
        self.assertEqual(rows[1]["text"], "Partial Ovis text.")
        self.assertEqual(rows[1]["errors"][0]["type"], "TruncatedOutput")
        self.assertEqual(rows[2]["errors"][0]["type"], "EngineCrash")
        normalized = [normalize_ocr_result(row, self.rich["caseId"], 2, PDF_HASH) for row in rows]
        self.assertTrue(layer_is_selectable(normalized[0]))
        self.assertFalse(layer_is_selectable(normalized[1]))
        self.assertFalse(layer_is_selectable(normalized[2]))

    def test_conversion_is_byte_deterministic(self) -> None:
        envelope = self.corrected_envelope()
        _summary, _rows, first = self.convert(envelope, "first.jsonl")
        _summary, _rows, second = self.convert(envelope, "second.jsonl")
        self.assertEqual(first.read_bytes(), second.read_bytes())

    def test_directory_accepts_canonical_worker_result_filename(self) -> None:
        result_directory = self.root / "downloaded-results"
        result_directory.mkdir()
        canonical_name = f"{self.rich['jobId']}--{self.image_hash}.json"
        (result_directory / canonical_name).write_text(
            json.dumps(self.corrected_envelope()), encoding="utf-8"
        )
        # An unrelated JSON file in the download directory must not be treated
        # as an OCR envelope merely because it has a .json suffix.
        (result_directory / "download-metadata.json").write_text(
            json.dumps({"downloaded": True}), encoding="utf-8"
        )
        output = self.root / "canonical-directory.jsonl"
        summary = convert_hermes_results(
            self.manifest, result_directory, output, require_all_jobs=True,
        )
        rows = [json.loads(line) for line in output.read_text(encoding="utf-8").splitlines()]
        self.assertEqual(summary["envelopesConverted"], 1)
        self.assertEqual(summary["layersWritten"], 3)
        self.assertEqual([row["engine"]["name"] for row in rows], ENGINES)

    def test_outbound_transfer_ledger_is_relocatable_and_deterministic(self) -> None:
        first = self.root / "transfer-one"
        second = self.root / "transfer-two"
        command = [
            sys.executable, str(ROOT / "tools" / "case-ocr-export-hermes.py"),
            str(self.manifest),
        ]
        subprocess.run([*command, str(first)], check=True, capture_output=True, text=True)
        subprocess.run([*command, str(second)], check=True, capture_output=True, text=True)
        first_map = (first / "transfer-map.jsonl").read_bytes()
        second_map = (second / "transfer-map.jsonl").read_bytes()
        self.assertEqual(first_map, second_map)
        mapping = json.loads(first_map)
        self.assertEqual(mapping["localRichManifest"], "local-rich-manifest.jsonl")
        self.assertEqual(mapping["hermesDirectory"], f"jobs/{self.rich['jobId']}")
        job_files = sorted(path.name for path in (first / mapping["hermesDirectory"]).iterdir())
        self.assertEqual(job_files, sorted([f"{self.rich['jobId']}.png", "manifest.json"]))

    def test_hash_and_layer_set_mismatches_are_rejected(self) -> None:
        bad_hash = self.corrected_envelope()
        bad_hash["job"]["imageSha256"] = "f" * 64
        with self.assertRaisesRegex(RuntimeError, "does not match local imageSha256"):
            self.convert(bad_hash, "bad-hash.jsonl")

        missing_layer = self.legacy_envelope([self.layer(ENGINES[0]), self.layer(ENGINES[1])])
        with self.assertRaisesRegex(RuntimeError, "layer/request mismatch"):
            self.convert(missing_layer, "missing-layer.jsonl")


if __name__ == "__main__":
    unittest.main()
