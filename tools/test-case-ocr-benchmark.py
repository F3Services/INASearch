#!/usr/bin/env python3
"""Focused tests for the deterministic OCR smoke benchmark."""

from __future__ import annotations

import hashlib
import json
import random
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from case_index.ocr_benchmark import (
    NATIVE_PROXY_KIND,
    _edit_distance,
    _edit_distance_dp,
    build_benchmark,
    legal_signals,
    write_benchmark,
)


ROOT = Path(__file__).resolve().parents[1]
PDF_HASH = "a" * 64
IMAGE_HASH = "b" * 64


class OcrBenchmarkTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.derived = self.root / "derived"
        self.derived.mkdir()
        self.reference = (
            "Matter of Test, 29 I&N Dec. 379 (BIA 2026). "
            "INA section 101(a)(42)(A), 8 U.S.C. § 1101(a)(42)(A), "
            "and 8 C.F.R. § 1208.13(b) apply."
        )
        reference_hash = hashlib.sha256(self.reference.encode("utf-8")).hexdigest()
        (self.derived / "eoir-test.json").write_text(json.dumps({
            "pages": [{"pageNumber": 2, "nativeText": self.reference}],
        }), encoding="utf-8")
        self.jobs = [
            {
                "jobId": "job-trusted",
                "caseId": "eoir-test",
                "pageNumber": 2,
                "source": {"pdfSha256": PDF_HASH, "kind": "published-case"},
                "image": {"sha256": IMAGE_HASH},
                "benchmark": {"category": "born-digital", "reviewFocus": "legal tokens"},
                "nativeReference": {
                    "textSha256": reference_hash,
                    "quality": {
                        "characters": len(self.reference), "score": 1.0,
                        "needsOcr": False, "scanLikely": False,
                    },
                },
            },
            {
                "jobId": "job-scan",
                "caseId": "eoir-scan",
                "pageNumber": 1,
                "source": {"pdfSha256": "c" * 64, "kind": "published-case"},
                "image": {"sha256": "d" * 64},
                "benchmark": {"category": "old-scan", "reviewFocus": "recover text"},
                "nativeReference": {
                    "textSha256": hashlib.sha256(b"").hexdigest(),
                    "quality": {
                        "characters": 0, "score": 0.0,
                        "needsOcr": True, "scanLikely": True,
                    },
                },
            },
        ]
        self.manifest = self.root / "manifest.jsonl"
        self.manifest.write_text(
            "".join(json.dumps(item) + "\n" for item in self.jobs), encoding="utf-8"
        )
        self.rows = [
            self.result("job-trusted", "eoir-test", 2, "engine-a", self.reference, 100.0),
            self.result(
                "job-trusted", "eoir-test", 2, "engine-b",
                self.reference.replace("§ 1208.13(b)", "1208.13(b)"), 200.0,
                termination={"truncationKnown": True, "truncated": True, "stopReason": "length"},
            ),
            self.result(
                "job-scan", "eoir-scan", 1, "engine-a", "", 50.0,
                status="failed", errors=[{"message": "decode failed"}],
                sourcePdfSha256="c" * 64, imageSha256="d" * 64,
                termination={"truncationKnown": False, "truncated": None, "stopReason": None},
            ),
        ]
        self.results = self.root / "results.jsonl"
        self.results.write_text(
            "".join(json.dumps(item) + "\n" for item in self.rows), encoding="utf-8"
        )

    def tearDown(self) -> None:
        self.temporary.cleanup()

    @staticmethod
    def result(job: str, case: str, page: int, engine: str, text: str, runtime: float, **changes) -> dict:
        value = {
            "schemaVersion": 2,
            "jobId": job,
            "resultId": f"result-{job}-{engine}",
            "caseId": case,
            "pageNumber": page,
            "status": "succeeded",
            "text": text,
            "engine": {"name": engine, "version": "1.0"},
            "model": {"name": f"model/{engine}", "revision": "rev-1"},
            "containerDigest": "sha256:" + "e" * 64,
            "sourcePdfSha256": PDF_HASH,
            "imageSha256": IMAGE_HASH,
            "promptSha256": "f" * 64,
            "outputSchemaSha256": "1" * 64,
            "provenanceCompleteness": "complete-per-layer",
            "layerProvenance": {"workerGitCommit": "abc123", "backend": {"type": "test"}},
            "runtime": {"milliseconds": runtime},
            "termination": {"truncationKnown": True, "truncated": False, "stopReason": "complete"},
            "errors": [],
            "warnings": [],
        }
        value.update(changes)
        return value

    def test_legal_signals_preserve_exact_citation_strings(self) -> None:
        signals = legal_signals(self.reference)
        self.assertEqual(signals["citationsByType"]["inReporter"], ["29 I&N Dec. 379"])
        self.assertEqual(
            signals["canonicalCitationsByType"]["inReporter"],
            ["29 I&N Dec. 379"],
        )
        self.assertEqual(signals["citationsByType"]["usc"], ["8 U.S.C. § 1101(a)(42)(A)"])
        self.assertEqual(
            signals["canonicalCitationsByType"]["usc"],
            ["8 USC 1101(a)(42)(A)"],
        )
        self.assertEqual(signals["citationsByType"]["cfr"], ["8 C.F.R. § 1208.13(b)"])
        self.assertIn("INA section 101(a)(42)(A)", signals["citationsByType"]["inaSection"])
        self.assertEqual(signals["legalMarkerCounts"]["sectionSymbol"], 2)
        self.assertTrue(all("canonical" in item for item in signals["citations"]))
        self.assertTrue(all(item["start"] < item["end"] for item in signals["citations"]))

        wrapped = legal_signals("Apply 8 U.S.C.\n§ 1101(a)(42)(A) exactly.")
        self.assertEqual(
            wrapped["citationsByType"]["usc"],
            ["8 U.S.C.\n§ 1101(a)(42)(A)"],
        )
        self.assertEqual(
            wrapped["canonicalCitationsByType"]["usc"],
            ["8 USC 1101(a)(42)(A)"],
        )
        edition = legal_signals(
            "8 U.S.C. § 1182(c) (1982); section 241(a)(2) (1988)."
        )
        self.assertEqual(
            edition["canonicalCitationsByType"]["usc"], ["8 USC 1182(c)"]
        )
        self.assertEqual(
            edition["canonicalCitationsByType"]["inaSection"], ["INA 241(a)(2)"]
        )
        self.assertEqual(
            edition["citationsByType"]["usc"], ["8 U.S.C. § 1182(c)"]
        )

    def test_bit_parallel_edit_distance_matches_dp_oracle_fixed_cases(self) -> None:
        fixed_strings = [
            ("", ""),
            ("", "immigration"),
            ("kitten", "sitting"),
            ("a" * 80, "a" * 79 + "b"),
            ("ab" * 90, "ba" * 90),
            ("prefix-" + "x" * 120 + "-suffix", "prefix-" + "y" * 120 + "-suffix"),
            ("café § 212(a)(6)(C)", "cafe\u0301 § 212(a)(6)(C)"),
            ("移民法律 📜⚖️", "移民法律 📄⚖️"),
            ("Straße", "STRASSE"),
            ("\x00\n\t", "\x00\r\n"),
        ]
        for left, right in fixed_strings:
            with self.subTest(left=left, right=right):
                expected = _edit_distance_dp(left, right)
                self.assertEqual(_edit_distance(left, right), expected)
                self.assertEqual(_edit_distance(right, left), expected)

        fixed_tokens = [
            ([], []),
            ([], ["INA", "212"]),
            (["8", "usc", "1182", "a"], ["8", "cfr", "1182", "a"]),
            (["§"] * 70 + ["212"], ["§"] * 70 + ["237"]),
            (["Matter", "of", "A", "A", "A"], ["Matter", "of", "A", "B"]),
            (["unicode", "📜", "移民"], ["unicode", "📄", "移民"]),
        ]
        for left, right in fixed_tokens:
            with self.subTest(left=left, right=right):
                expected = _edit_distance_dp(left, right)
                self.assertEqual(_edit_distance(left, right), expected)
                self.assertEqual(_edit_distance(right, left), expected)

        # The public helper's generic Sequence[Any] behavior remains exact for
        # equality-comparable tokens that cannot be dictionary keys.
        unhashable_left = [[1], [2], [2], [3]]
        unhashable_right = [[1], [2], [4]]
        self.assertEqual(
            _edit_distance(unhashable_left, unhashable_right),
            _edit_distance_dp(unhashable_left, unhashable_right),
        )

    def test_bit_parallel_edit_distance_matches_seeded_random_oracle(self) -> None:
        generator = random.Random(0x1A5EA2C)
        alphabet = tuple("abAB01 .,-§é\u0301移📜")
        for case_number in range(600):
            left = "".join(
                generator.choice(alphabet) for _ in range(generator.randrange(65))
            )
            right = "".join(
                generator.choice(alphabet) for _ in range(generator.randrange(65))
            )
            with self.subTest(kind="characters", case=case_number):
                expected = _edit_distance_dp(left, right)
                self.assertEqual(_edit_distance(left, right), expected)
                self.assertEqual(_edit_distance(right, left), expected)

        vocabulary = (
            "matter", "of", "ina", "usc", "cfr", "§", "212(a)",
            "1182", "dec.", "移民", "📜", "", "repeated",
        )
        for case_number in range(600):
            left = [
                generator.choice(vocabulary) for _ in range(generator.randrange(50))
            ]
            right = [
                generator.choice(vocabulary) for _ in range(generator.randrange(50))
            ]
            with self.subTest(kind="tokens", case=case_number):
                expected = _edit_distance_dp(left, right)
                self.assertEqual(_edit_distance(left, right), expected)
                self.assertEqual(_edit_distance(right, left), expected)

    def test_report_has_engine_failures_truncation_agreement_and_proxy(self) -> None:
        report = build_benchmark(
            self.manifest, self.results, derived_root=self.derived, require_all_jobs=True
        )
        self.assertEqual(report["selection"], "none; every OCR layer remains unreviewed evidence")
        self.assertEqual(report["adjudication"], "none")
        by_engine = {item["engine"]: item for item in report["engines"]}
        self.assertEqual(by_engine["engine-a"]["attempts"], 2)
        self.assertEqual(by_engine["engine-a"]["failed"], 1)
        self.assertEqual(by_engine["engine-a"]["unknownTruncation"], 1)
        self.assertEqual(by_engine["engine-b"]["truncated"], 1)
        self.assertEqual(by_engine["engine-a"]["runtimeMilliseconds"]["median"], 75.0)
        self.assertGreater(by_engine["engine-a"]["exactLegalSignals"]["citationOccurrences"], 0)
        self.assertEqual(
            by_engine["engine-a"]["exactLegalSignals"]["pagesWithAnyCitation"], 1
        )
        self.assertEqual(report["crossEngine"]["pagePairsCompared"], 1)
        self.assertLess(report["crossEngine"]["enginePairs"][0]["meanLegalMarkerCountAgreement"], 1)
        page = report["pages"][0]
        review = page["legalCitationReview"]
        self.assertEqual(review["status"], "unanimousCanonicalAgreement")
        self.assertEqual(review["selection"], "none")
        self.assertEqual(review["majorityVote"], "not-performed")
        self.assertEqual(
            review["unitStatusCounts"]["unanimousCanonicalAgreement"], 1
        )
        cfr = next(unit for unit in review["units"] if unit["type"] == "cfr")
        self.assertEqual(cfr["canonical"], "8 CFR 1208.13(b)")
        self.assertEqual(cfr["status"], "unanimousCanonicalAgreement")
        self.assertEqual(
            [
                form["text"]
                for reading in cfr["engineReadings"]
                for form in reading["exactForms"]
            ],
            ["8 C.F.R. § 1208.13(b)", "8 C.F.R. 1208.13(b)"],
        )
        self.assertEqual(page["nativeTextProxyReference"]["status"], "available")
        self.assertEqual(page["attempts"][0]["nativeTextProxy"]["kind"], NATIVE_PROXY_KIND)
        self.assertEqual(
            page["attempts"][0]["nativeTextProxy"]["wordErrorRateProxy"], 0.0
        )
        self.assertEqual(
            page["attempts"][0]["provenance"]["evidence"]["layerProvenance"]["workerGitCommit"],
            "abc123",
        )
        self.assertEqual(
            report["pages"][1]["nativeTextProxyReference"]["status"],
            "manifest-quality-not-trustworthy",
        )

    def test_outputs_are_deterministic_and_cli_labels_proxy(self) -> None:
        first_json = self.root / "first.json"
        first_md = self.root / "first.md"
        second_json = self.root / "second.json"
        second_md = self.root / "second.md"
        first = write_benchmark(
            self.manifest, self.results, first_json, first_md,
            derived_root=self.derived, require_all_jobs=True,
        )
        second = write_benchmark(
            self.manifest, self.results, second_json, second_md,
            derived_root=self.derived, require_all_jobs=True,
        )
        self.assertEqual(first["jsonSha256"], second["jsonSha256"])
        self.assertEqual(first["markdownSha256"], second["markdownSha256"])
        self.assertIn("not human transcription gold", first_md.read_text(encoding="utf-8"))
        self.assertIn("No OCR layer was selected", first_md.read_text(encoding="utf-8"))
        self.assertIn("## Legal-citation review flags", first_md.read_text(encoding="utf-8"))
        self.assertIn("not votes or legal conclusions", first_md.read_text(encoding="utf-8"))

        cli_json = self.root / "cli.json"
        cli_md = self.root / "cli.md"
        completed = subprocess.run(
            [
                sys.executable, str(ROOT / "tools" / "case-ocr-benchmark.py"),
                str(self.manifest), str(self.results), str(cli_json), str(cli_md),
                "--derived-root", str(self.derived), "--require-all-jobs",
            ],
            cwd=ROOT, text=True, capture_output=True, check=True,
        )
        self.assertEqual(json.loads(completed.stdout)["selection"], "none")
        self.assertEqual(cli_json.read_bytes(), first_json.read_bytes())

    def test_subsection_and_reporter_page_disagreements_are_not_voted_away(self) -> None:
        third = self.result(
            "job-trusted",
            "eoir-test",
            2,
            "engine-c",
            self.reference
            .replace("29 I&N Dec. 379", "29 I&N Dec. 18")
            .replace("1101(a)(42)(A)", "1101(a)(42)(B)"),
            300.0,
        )
        results = self.root / "disagreement.jsonl"
        results.write_text(
            "".join(json.dumps(item) + "\n" for item in [*self.rows, third]),
            encoding="utf-8",
        )
        report = build_benchmark(self.manifest, results, derived_root=self.derived)
        review = report["pages"][0]["legalCitationReview"]
        self.assertEqual(review["status"], "disagreement")
        self.assertEqual(review["selection"], "none")
        self.assertEqual(review["adjudication"], "none")
        self.assertEqual(review["majorityVote"], "not-performed")

        by_canonical = {unit["canonical"]: unit for unit in review["units"]}
        self.assertEqual(
            by_canonical["8 USC 1101(a)(42)(A)"]["status"], "disagreement"
        )
        self.assertEqual(
            by_canonical["8 USC 1101(a)(42)(B)"]["status"],
            "engineUniqueReading",
        )
        self.assertEqual(
            by_canonical["29 I&N Dec. 18"]["status"], "engineUniqueReading"
        )
        self.assertNotIn("winner", json.dumps(review, sort_keys=True).casefold())

    def test_official_index_volume_page_tokens_are_contextual_and_conservative(self) -> None:
        text = (
            "12—432; 15-416; 16-416; 12432; ratio 3-1/2; "
            "Volumes 1-15; secs. 2-12; pages 3-99"
        )
        self.assertNotIn("officialReporterVolumePage", legal_signals(text)["citationsByType"])
        enabled = legal_signals(
            text, include_official_reporter_volume_pages=True
        )
        self.assertEqual(
            enabled["canonicalCitationsByType"]["officialReporterVolumePage"],
            ["12-432", "15-416"],
        )

        index_job = {
            "jobId": "job-index",
            "caseId": "eoir-index-test",
            "pageNumber": 20,
            "source": {
                "pdfSha256": PDF_HASH,
                "kind": "official-supporting-index",
            },
            "image": {"sha256": IMAGE_HASH},
            "benchmark": {
                "category": "topical-index-dense-crossrefs",
                "reviewFocus": "volume-page tokens",
            },
            "nativeReference": {
                "textSha256": hashlib.sha256(b"").hexdigest(),
                "quality": {
                    "characters": 0,
                    "score": 0.0,
                    "needsOcr": True,
                    "scanLikely": True,
                },
            },
        }
        manifest = self.root / "index-manifest.jsonl"
        manifest.write_text(json.dumps(index_job) + "\n", encoding="utf-8")
        rows = [
            self.result("job-index", "eoir-index-test", 20, "engine-a", "12—432; 13-79; ratio 3-1/2", 1),
            self.result("job-index", "eoir-index-test", 20, "engine-b", "12-432; 13—80; ratio 3-1/2", 1),
            self.result("job-index", "eoir-index-test", 20, "engine-c", "12 – 432; 13—79; ratio 3-1/2", 1),
        ]
        results = self.root / "index-results.jsonl"
        results.write_text(
            "".join(json.dumps(item) + "\n" for item in rows), encoding="utf-8"
        )
        report = build_benchmark(manifest, results, require_all_jobs=True)
        review = report["pages"][0]["legalCitationReview"]
        by_canonical = {unit["canonical"]: unit for unit in review["units"]}
        self.assertEqual(
            by_canonical["12-432"]["status"], "unanimousCanonicalAgreement"
        )
        self.assertEqual(by_canonical["13-79"]["status"], "disagreement")
        self.assertEqual(
            by_canonical["13-80"]["status"], "engineUniqueReading"
        )
        self.assertNotIn("3-1", by_canonical)

    def test_mismatched_hash_and_duplicate_engine_are_rejected(self) -> None:
        bad_hash = self.root / "bad-hash.jsonl"
        altered = dict(self.rows[0], imageSha256="0" * 64)
        bad_hash.write_text(json.dumps(altered) + "\n", encoding="utf-8")
        with self.assertRaisesRegex(RuntimeError, "imageSha256 disagrees"):
            build_benchmark(self.manifest, bad_hash)

        duplicate = self.root / "duplicate.jsonl"
        duplicate.write_text(
            json.dumps(self.rows[0]) + "\n" + json.dumps(self.rows[0]) + "\n",
            encoding="utf-8",
        )
        with self.assertRaisesRegex(RuntimeError, "duplicate engine"):
            build_benchmark(self.manifest, duplicate)


if __name__ == "__main__":
    unittest.main()
