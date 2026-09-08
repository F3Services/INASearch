#!/usr/bin/env python3
"""Regression tests for the ledger-bound Hermes result download verifier."""

from __future__ import annotations

import hashlib
import json
import tempfile
import unittest
from collections import Counter
from pathlib import Path

from case_index.hermes_download import (
    validate_download_plan,
    verify_downloaded_results,
    write_files_from,
)


COMMIT = "57caee14541133c9591d903e1434bd29f4398366"
ENGINES = ("pp-ocrv6", "paddleocr-vl-1.6", "ovisocr2")
ROOT = Path(__file__).resolve().parents[1]
ACTUAL_SUPPLEMENT = (
    ROOT / "sources/cases/index/hermes-gold-results/"
    "20260831T064444Z-truthful-contract"
)


class HermesDownloadTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.transfer = self.root / "transfer-map.jsonl"
        self.ledger = self.root / "result-files.sha256.json"
        self.download = self.root / "download"
        (self.download / "results").mkdir(parents=True)
        self.jobs = [
            ("ocr-job-alpha", "a" * 64),
            ("ocr-job-beta", "b" * 64),
        ]
        transfer_rows = []
        ledger_rows = []
        for index, (job_id, image_hash) in enumerate(self.jobs):
            transfer_rows.append({
                "jobId": job_id,
                "imageSha256": image_hash,
                "hermesDirectory": f"jobs/{job_id}",
                "manifestSha256": str(index + 1) * 64,
                "localRichManifest": "local-rich-manifest.jsonl",
            })
            known_truncated = index == 1
            truncation_error = {
                "type": "TruncatedGeneration",
                "message": "guarded partial",
                "retryable": False,
                "evidence": {
                    "guardConfigSha256": "d" * 64,
                    "matchedStopStringSha256": "e" * 64,
                    "matchedStopPresentInRawOutput": True,
                    "evidenceMismatch": False,
                },
            }
            envelope_layers = []
            ledger_layers = []
            for engine in ENGINES:
                truncated = engine == "ovisocr2" and known_truncated
                state = {
                    "stopReason": "truncated" if truncated else "complete",
                    "finishReason": "stop" if engine != "pp-ocrv6" else None,
                    "truncationKnown": True,
                    "truncated": truncated,
                    "error": truncation_error if truncated else None,
                }
                envelope_layers.append({
                    "engine": engine,
                    "provenance": {"workerGitCommit": COMMIT},
                    **state,
                })
                ledger_layers.append({
                    "engine": engine,
                    "workerGitCommit": COMMIT,
                    "category": "knownTruncated" if truncated else "clean",
                    **state,
                })
            envelope = {
                "schemaVersion": "inasearch-ocr-result/v1",
                "job": {
                    "schemaVersion": "inasearch-ocr-job/v1",
                    "jobId": job_id,
                    "imageSha256": image_hash,
                    "requestedEngines": list(ENGINES),
                },
                "worker": {"workerVersion": COMMIT, "hostClass": "rtx-5090"},
                "layers": envelope_layers,
            }
            content = json.dumps(envelope, sort_keys=True).encode("utf-8")
            relative = f"results/{job_id}--{image_hash}.json"
            (self.download / relative).write_bytes(content)
            ledger_rows.append({
                "jobId": job_id,
                "path": relative,
                "bytes": len(content),
                "sha256": hashlib.sha256(content).hexdigest(),
                "strictSchemaSemanticProvenanceValid": True,
                "workerVersion": COMMIT,
                "layers": ledger_layers,
            })
        self.transfer.write_text(
            "".join(json.dumps(row, sort_keys=True) + "\n" for row in transfer_rows),
            encoding="utf-8",
        )
        self.ledger.write_text(json.dumps(ledger_rows, sort_keys=True), encoding="utf-8")

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def plan(self) -> dict:
        return validate_download_plan(
            self.transfer,
            self.ledger,
            expected_transfer_map_sha256=hashlib.sha256(self.transfer.read_bytes()).hexdigest(),
            expected_job_count=2,
            expected_ledger_sha256=hashlib.sha256(self.ledger.read_bytes()).hexdigest(),
            expected_worker_commit=COMMIT,
            reject_unknown_or_error_categories=True,
        )

    def test_plan_and_exact_download_verify(self) -> None:
        plan = self.plan()
        self.assertEqual(plan["jobCount"], 2)
        self.assertEqual(plan["ledgerContract"], "smoke-result-files-v1")
        allowlist = self.root / "result-files.from"
        allowlist_hash = write_files_from(plan, allowlist)
        self.assertEqual(
            allowlist.read_text(encoding="utf-8").splitlines(),
            plan["retrievalPaths"],
        )
        self.assertEqual(allowlist_hash, hashlib.sha256(allowlist.read_bytes()).hexdigest())
        report = verify_downloaded_results(plan, self.download)
        self.assertTrue(report["valid"])
        self.assertEqual(report["verifiedFiles"], 2)

    def test_actual_gold_controller_ledger_contract(self) -> None:
        rows = json.loads(self.ledger.read_text(encoding="utf-8"))
        for row, (_job_id, image_hash) in zip(rows, self.jobs):
            row.pop("strictSchemaSemanticProvenanceValid")
            row["imageSha256"] = image_hash
            row["resultFilename"] = Path(row["path"]).name
            for layer in row["layers"]:
                layer.pop("workerGitCommit")
                layer["category"] = (
                    "truncated" if layer["category"] == "knownTruncated" else "complete"
                )
        self.ledger.write_text(json.dumps(rows, sort_keys=True), encoding="utf-8")
        plan = self.plan()
        self.assertEqual(plan["ledgerContract"], "gold-result-files-v1")
        self.assertEqual(
            plan["results"][1]["categories"],
            ["clean", "clean", "knownTruncated"],
        )
        self.assertTrue(verify_downloaded_results(plan, self.download)["valid"])

        for field, value in (
            ("imageSha256", "c" * 64),
            ("resultFilename", "wrong.json"),
        ):
            with self.subTest(field=field):
                changed = json.loads(json.dumps(rows))
                changed[0][field] = value
                candidate = self.root / f"wrong-{field}.json"
                candidate.write_text(json.dumps(changed), encoding="utf-8")
                with self.assertRaises(RuntimeError):
                    validate_download_plan(
                        self.transfer,
                        candidate,
                        expected_job_count=2,
                        expected_worker_commit=COMMIT,
                        reject_unknown_or_error_categories=True,
                    )
        missing_guard = json.loads(json.dumps(rows))
        missing_guard[1]["layers"][2]["error"].pop("evidence")
        candidate = self.root / "missing-guard-evidence.json"
        candidate.write_text(json.dumps(missing_guard), encoding="utf-8")
        with self.assertRaisesRegex(RuntimeError, "known Ovis truncation"):
            validate_download_plan(
                self.transfer,
                candidate,
                expected_job_count=2,
                expected_worker_commit=COMMIT,
                reject_unknown_or_error_categories=True,
            )

    def test_actual_truthful_supplement_ledger_and_download(self) -> None:
        transfer = ROOT / "sources/cases/index/hermes-gold-000001/transfer-map.jsonl"
        ledger = ACTUAL_SUPPLEMENT / "evidence/result-files.sha256.json"
        raw = ACTUAL_SUPPLEMENT / "raw"
        plan = validate_download_plan(
            transfer,
            ledger,
            expected_transfer_map_sha256=(
                "d7efe8afaf3d0e6b4f8359702cef600ebd96683b05645b5da5066f190d0250d3"
            ),
            expected_job_count=200,
            expected_ledger_sha256=(
                "cc15aff3cad51d17dfbd4732ddbcd43ab695df3551ede5af190828b1c04b2d49"
            ),
            expected_worker_commit=COMMIT,
            reject_unknown_or_error_categories=True,
        )
        self.assertEqual(
            plan["ledgerContract"], "truthful-supplement-result-files-v1"
        )
        self.assertEqual(
            plan["releasePolicyEvidenceStatus"],
            "pending-downloaded-envelope-verification",
        )
        counts = Counter(
            category for row in plan["results"] for category in row["categories"]
        )
        self.assertEqual(
            counts,
            {"clean": 573, "knownTruncated": 25, "knownArtifactTruncated": 2},
        )
        report = verify_downloaded_results(plan, raw)
        self.assertEqual(report["verifiedFiles"], 200)
        self.assertEqual(report["verifiedBytes"], 40_528_665)
        self.assertEqual(
            report["releasePolicyEvidenceStatus"],
            "verified-from-downloaded-envelopes",
        )

        with self.assertRaisesRegex(RuntimeError, "external expected worker commit"):
            validate_download_plan(
                transfer,
                ledger,
                expected_job_count=200,
                expected_ledger_sha256=(
                    "cc15aff3cad51d17dfbd4732ddbcd43ab695df3551ede5af190828b1c04b2d49"
                ),
                reject_unknown_or_error_categories=True,
            )

    def test_path_hash_extra_and_category_fail_closed(self) -> None:
        rows = json.loads(self.ledger.read_text(encoding="utf-8"))
        mutations = {
            "unsafe path": lambda values: values[0].update({"path": "../escape.json"}),
            "wrong release": lambda values: values[0].update({"workerVersion": "c" * 40}),
            "unknown truncation": lambda values: values[0]["layers"][2].update({"category": "unknownTruncation"}),
        }
        for name, mutate in mutations.items():
            with self.subTest(name=name):
                changed = json.loads(json.dumps(rows))
                mutate(changed)
                candidate = self.root / f"{name.replace(' ', '-')}.json"
                candidate.write_text(json.dumps(changed), encoding="utf-8")
                with self.assertRaises(RuntimeError):
                    validate_download_plan(
                        self.transfer,
                        candidate,
                        expected_worker_commit=COMMIT,
                        reject_unknown_or_error_categories=True,
                    )

        plan = self.plan()
        (self.download / "results" / "extra.json").write_text("{}", encoding="utf-8")
        with self.assertRaisesRegex(RuntimeError, "differs from the ledger"):
            verify_downloaded_results(plan, self.download)
        (self.download / "results" / "extra.json").unlink()
        result = self.download / plan["retrievalPaths"][0]
        result.write_text("{}", encoding="utf-8")
        with self.assertRaisesRegex(RuntimeError, "byte count mismatch"):
            verify_downloaded_results(plan, self.download)

    def test_symlink_root_and_envelope_provenance_fail_closed(self) -> None:
        plan = self.plan()
        linked = self.root / "download-link"
        linked.symlink_to(self.download, target_is_directory=True)
        with self.assertRaisesRegex(RuntimeError, "non-symlink"):
            verify_downloaded_results(plan, linked)

        result = self.download / plan["retrievalPaths"][0]
        envelope = json.loads(result.read_text(encoding="utf-8"))
        envelope["layers"][0]["provenance"]["workerGitCommit"] = "c" * 40
        content = json.dumps(envelope, sort_keys=True).encode("utf-8")
        result.write_bytes(content)
        plan["results"][0]["bytes"] = len(content)
        plan["results"][0]["sha256"] = hashlib.sha256(content).hexdigest()
        with self.assertRaisesRegex(RuntimeError, "layer worker mismatch"):
            verify_downloaded_results(plan, self.download)

    def test_expected_transfer_count_and_duplicate_json_keys_fail_closed(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "expected 3"):
            validate_download_plan(
                self.transfer,
                self.ledger,
                expected_job_count=3,
                expected_worker_commit=COMMIT,
            )
        duplicate = self.root / "duplicate-ledger.json"
        duplicate.write_text(
            '[{"jobId":"ocr-job-alpha","jobId":"ocr-job-beta"}]',
            encoding="utf-8",
        )
        with self.assertRaisesRegex(RuntimeError, "duplicate key"):
            validate_download_plan(
                self.transfer,
                duplicate,
                expected_job_count=2,
                expected_worker_commit=COMMIT,
            )


if __name__ == "__main__":
    unittest.main()
