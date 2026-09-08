#!/usr/bin/env python3
"""Focused regressions for I&N reporter occurrences and treatment grammar."""

from __future__ import annotations

import json
import sqlite3
import subprocess
import tempfile
import unittest
from pathlib import Path

from case_index.database import build_database, status_report


ROOT = Path(__file__).resolve().parents[1]


def analyze(text: str) -> dict:
    completed = subprocess.run(
        ["node", str(ROOT / "tools" / "case-citations.js")],
        input=json.dumps({"sourceId": "occurrence-test", "text": text}),
        text=True,
        capture_output=True,
        check=True,
    )
    return json.loads(completed.stdout)


class ReporterOccurrenceTests(unittest.TestCase):
    def test_under_alone_does_not_promote_a_body_citation_to_a_holding(self) -> None:
        background = analyze("The respondent filed the motion under 8 C.F.R. § 1003.1(g).")
        holding = analyze("We hold under 8 C.F.R. § 1003.1(g) that the motion was untimely.")
        self.assertEqual(background["citations"][0]["applicability"], "discussed")
        self.assertEqual(background["citations"][0]["applicabilityScore"], 0.42)
        self.assertEqual(holding["citations"][0]["applicability"], "holding-candidate")

    def test_occurrences_are_independent_of_treatment_and_keep_offsets(self) -> None:
        text = (
            "See Matter of Example, 12 I. & N. Dec.\n537, 540–542 (BIA 1967), "
            "and 25 I&N Dec. 771 (BIA 2012)."
        )
        output = analyze(text)
        self.assertEqual(output["treatments"], [])
        self.assertEqual(
            [item["canonicalCitation"] for item in output["caseCitations"]],
            ["12 I&N Dec. 537", "25 I&N Dec. 771"],
        )
        first = output["caseCitations"][0]
        self.assertEqual(first["citedCaseName"], "Matter of Example")
        self.assertEqual(first["pinpoints"], [{"startPage": 540, "endPage": 542}])
        self.assertEqual(text[first["start"] : first["end"]], first["text"])
        self.assertEqual(first["resolution"], "pending-manifest-resolution")

    def test_active_and_passive_treatments_are_deterministic(self) -> None:
        output = analyze(
            "The Board now clarifies Matter of First, 25 I&N Dec. 100 (BIA 2010). "
            "Matter of Second, 20 I&N Dec. 50 (BIA 1990) is hereby limited. "
            "We decline to follow Matter of Third, 18 I. & N. Dec. 10 (BIA 1981). "
            "The Board of Immigration Appeals withdraws from Matter of Fourth, "
            "16 I&N Dec. 20 (BIA 1977). I therefore overrule Matter of Fifth, "
            "17 I&N Dec. 30 (A.G. 1980)."
        )
        self.assertEqual(
            [item["treatment"] for item in output["treatments"]],
            ["clarified", "limited", "not-followed", "withdrawn", "overruled"],
        )
        self.assertTrue(all(item["scopeEvidence"] for item in output["treatments"]))
        self.assertEqual(output["treatments"][0]["provenance"], "explicit-current-decision-predicate-treatment")

    def test_negation_party_argument_and_named_external_treater_are_not_misattributed(self) -> None:
        output = analyze(
            "We do not overrule Matter of One, 25 I&N Dec. 1 (BIA 2009). "
            "The respondent argues Matter of Two, 25 I&N Dec. 2 (BIA 2009) is overruled. "
            "Matter of Three, 25 I&N Dec. 3 (BIA 2009), overruled by Matter of Four, "
            "26 I&N Dec. 4 (BIA 2013). Counsel requests that we vacate Matter of Five, "
            "27 I&N Dec. 5 (BIA 2018)."
        )
        self.assertEqual(len(output["caseCitations"]), 5)
        self.assertEqual(output["treatments"], [])


class ReporterOccurrenceDatabaseTests(unittest.TestCase):
    def test_database_resolves_exact_manifest_target_and_retains_scope_evidence(self) -> None:
        text = (
            "Matter of Old, 12 I. & N. Dec. 537 (BIA 1967) is hereby limited. "
            "Compare 99 I&N Dec. 999."
        )
        parsed = analyze(text)
        shared = {
            "publicationStatus": "published-precedent",
            "sourceStatus": "published",
            "sourceCollection": "eoir-precedent-volumes",
            "precedential": True,
            "pdfUrl": "https://example.test/case.pdf",
            "decidingBody": "BIA",
            "headnotes": [],
        }
        old = {
            **shared,
            "corpusKey": "eoir-old",
            "caseName": "OLD",
            "officialCitation": "12 I&N Dec. 537",
            "decisionYear": 1967,
        }
        new = {
            **shared,
            "corpusKey": "eoir-new",
            "caseName": "NEW",
            "officialCitation": "29 I&N Dec. 900",
            "decisionYear": 2026,
        }
        empty_analysis = {"citations": [], "caseCitations": [], "treatments": []}
        documents = [
            {
                "case": old,
                "sourceArtifact": {"sha256": "a" * 64},
                "extraction": {"pagesNeedingOcr": []},
                "publisherHeadnoteAnalysis": empty_analysis,
                "pages": [
                    {
                        "pageNumber": 1,
                        "selectedTextMethod": "pdf-native",
                        "selectedText": "Old.",
                        "quality": {"score": 1, "needsOcr": False},
                        **empty_analysis,
                    }
                ],
            },
            {
                "case": new,
                "sourceArtifact": {"sha256": "b" * 64},
                "extraction": {"pagesNeedingOcr": []},
                "publisherHeadnoteAnalysis": empty_analysis,
                "pages": [
                    {
                        "pageNumber": 1,
                        "selectedTextMethod": "pdf-native",
                        "selectedText": text,
                        "quality": {"score": 1, "needsOcr": False},
                        "citations": [],
                        "caseCitations": parsed["caseCitations"],
                        "treatments": parsed["treatments"],
                    }
                ],
            },
        ]
        with tempfile.TemporaryDirectory() as temporary:
            case_root = Path(temporary)
            summary = build_database(case_root, documents, [old, new])
            self.assertEqual(summary["schemaVersion"], 2)
            self.assertEqual(summary["caseCitationOccurrences"], 2)
            self.assertEqual(summary["resolvedCaseCitationOccurrences"], 1)
            database_path = case_root / "index" / "published-cases.sqlite3"
            with sqlite3.connect(database_path) as connection:
                rows = connection.execute(
                    "SELECT citation_normalized,citation_resolution,cited_case_id FROM case_citations ORDER BY id"
                ).fetchall()
                scope = connection.execute("SELECT scope_evidence FROM treatments").fetchone()[0]
            self.assertEqual(rows[0], ("12 I&N Dec. 537", "exact-official-citation", "eoir-old"))
            self.assertEqual(rows[1], ("99 I&N Dec. 999", "unresolved", None))
            self.assertIn("hereby limited", scope)
            report = status_report(database_path, "12 I&N Dec. 537")
            self.assertEqual(report["incomingCaseCitations"][0]["citing_case_id"], "eoir-new")
            self.assertEqual(report["incomingTreatments"][0]["scope_evidence"], scope)
            exported = (case_root / "index" / "case-citations.jsonl").read_text(encoding="utf-8").splitlines()
            self.assertEqual(len(exported), 2)


if __name__ == "__main__":
    unittest.main()
