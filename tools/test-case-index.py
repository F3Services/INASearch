#!/usr/bin/env python3
"""Focused regression tests for published-case discovery and indexing."""

from __future__ import annotations

import json
import subprocess
import tempfile
import unittest
from pathlib import Path

from case_index.database import build_database, status_report
from case_index.documents import page_quality, source_citation_audit, temporal_application
from case_index.sources import parse_eoir_volume, parse_uscis_adopted
from case_index.supporting import (
    parse_affected_decisions_pages,
    parse_precedent_chart_section,
    parse_topical_index_columns,
    resolve_affected_decisions,
    resolve_chart_entries,
    resolve_topical_index,
)


ROOT = Path(__file__).resolve().parents[1]


class SourceParserTests(unittest.TestCase):
    def test_eoir_pdf_backed_catalog_override(self) -> None:
        html = b"""
        <table><tr><td><strong>N-</strong>, 8 I&amp;N Dec. 363 (A.C. 1959)</td>
        <td><a href='/eoir/vll/intdec/vol08/Pg369.pdf'>ID 1017</a></td></tr></table>
        """
        record = parse_eoir_volume(html, "https://www.justice.gov/eoir/test", 8)[0]
        self.assertEqual(record["officialCitation"], "8 I&N Dec. 369")
        self.assertEqual(record["reporterPage"], 369)
        self.assertIn("8 I&N Dec. 363", record["anomalousListingCitation"])
        self.assertFalse(record["citationNeedsPdfReview"])

    def test_eoir_verified_broken_publisher_pdf_is_explicit(self) -> None:
        html = b"""
        <table><tr><td><strong>PIZARRO</strong>, 12 I&amp;N Dec. 537 (Reg. Comm. 1967)</td>
        <td><a href='/eoir/vll/intdec/vol12/1817.pdf'>ID 1817</a></td></tr></table>
        """
        record = parse_eoir_volume(html, "https://www.justice.gov/eoir/test", 12)[0]
        self.assertFalse(record["captureRequired"])
        self.assertEqual(record["sourceAvailability"], "publisher-pdf-link-404")

    def test_eoir_old_row_table_and_modern_headnote(self) -> None:
        html = b"""
        <div><table><tbody>
          <tr><td><strong>C-R-</strong>, 8 I&amp;N Dec. 59 (BIA 1958)</td><td><a href='/old.pdf'>ID 0939</a></td></tr>
          <tr><td><strong>F-G-&amp; C-D-&gt;</strong>, 8 I&amp;N Dec. 65 (BIA 1958)</td><td><a href='/next.pdf'>ID 0940</a></td></tr>
          <tr><td><strong>BELTRAN</strong>, 20 I&amp;N Dec. 521 (BIA1992)</td><td><a href='/beltran.pdf'>ID 3179</a></td></tr>
          <tr><td><strong>SOFFIC</strong>,22 IN Dec 158 (BIA 1998)</td><td><a href='/soffic.pdf'>ID 3359</a></td></tr>
          <tr><td><strong>SUH</strong>, 23 I &amp; N 626 (BIA 2003)</td><td><a href='/suh.pdf'>ID 3494</a></td></tr>
          <tr><td><strong>NAVAS-ACOSTA</strong>, 23 I&amp;N Dec. 586</td><td><a href='/navas.pdf'>ID 3489</a></td></tr>
          <tr><td><strong>ALVAREZ-MUJICA</strong>, 10 I&amp;NDec. 613 (BIA 1964)</td><td><a href='/alvarez.pdf'>ID 1354</a></td></tr>
          <tr><td><strong>OLD</strong>, 22 I&amp;N Dec. 1415 (BIA 2000), Overruled by, 23 I&amp;N Dec. 207 (BIA 2002)</td><td><a href='/old-overruled.pdf'>ID 3440</a></td></tr>
          <tr><td><strong>PARTIAL</strong>, 25 I&amp;N Dec. 100 (BIA 2010), overruled in part by Matter of New 27 I&amp;N Dec. 271 (A.G. 2018)</td><td><a href='/partial.pdf'>ID 3740</a></td></tr>
          <tr><td><strong>VACATED</strong>, 24 I&amp;N Dec. 617 (A.G. 2008), vacated, 26 I&amp;N Dec. 550 (A.G. 2015)</td><td><a href='/vacated.pdf'>ID 3584</a></td></tr>
          <tr><td><strong>MODIFIED</strong>, 21 I&amp;N Dec. 1100 (BIA 1998), modified, 23 I&amp;N Dec. 195 (BIA 2002)</td><td><a href='/modified.pdf'>ID 2586</a></td></tr>
        </tbody></table>
        <table><tr><td><strong>TEST</strong>, 8 I&amp;N Dec. 700 (A.G. 1960)</td><td>ID <a href='/test/dl?inline'>1088</a> (PDF)</td></tr></table>
        <p>Section 212(a) controls. <em>Matter of C-R-</em>, 8 I&amp;N Dec. 59 (BIA 1958), modified.</p><hr></div>
        """
        records = parse_eoir_volume(html, "https://www.justice.gov/eoir/test", 8)
        self.assertEqual([record["eoirId"] for record in records], [939, 940, 3179, 3359, 3494, 3489, 1354, 3440, 3740, 3584, 2586, 1088])
        self.assertEqual(records[2]["decidingBody"], "BIA")
        self.assertEqual(records[1]["caseName"], "F-G- & C-D-")
        self.assertEqual(records[1]["caseNameWritten"], "F-G-& C-D->")
        self.assertEqual(records[3]["officialCitation"], "22 I&N Dec. 158")
        self.assertEqual(records[5]["decidingBody"], "BIA")
        self.assertEqual(records[5]["decisionYear"], 2003)
        self.assertIn("PDF", records[5]["overrideBasis"])
        self.assertEqual(records[-1]["decidingBody"], "AG")
        self.assertEqual(len(records[-1]["headnotes"]), 1)
        self.assertEqual(records[7]["sourceStatus"], "overruled")
        self.assertEqual(records[7]["publisherTreatment"]["treatingCaseCitation"], "23 I&N Dec. 207")
        self.assertEqual(records[8]["sourceStatus"], "overruled-in-part")
        self.assertEqual(records[8]["publisherTreatment"]["treatment"], "overruled-in-part")
        self.assertEqual(records[9]["sourceStatus"], "vacated")
        self.assertEqual(records[10]["sourceStatus"], "modified")

    def test_eoir_explicit_pdf_entry_cannot_disappear_silently(self) -> None:
        html = b"<table><tr><td>unrecognized citation</td><td><a href='/broken.pdf'>ID 9999</a> (PDF)</td></tr></table>"
        with self.assertRaisesRegex(RuntimeError, "9999"):
            parse_eoir_volume(html, "https://www.justice.gov/eoir/test", 29)

    def test_uscis_current_and_prior_status(self) -> None:
        html = b"""
        <div><p>Current adopted AAO decisions are listed below.</p><ul>
          <li><a href='/current.pdf'>Matter of F-M- Co.</a>, Adopted Decision 2020-01 (AAO May 5, 2020)</li>
        </ul><p>Previous adopted decisions, now superseded by USCIS policy, are listed below:</p><ul>
          <li><a href='/old.pdf'>Matter of Buschini</a>, Adopted Decision 06-0004 (AAO June 30, 2006), overruled by <a href='/new.pdf'>Matter of Vazquez</a></li>
        </ul></div>
        """
        records = parse_uscis_adopted(html, "https://www.uscis.gov/test")
        self.assertEqual({record["sourceStatus"] for record in records}, {"current", "overruled"})
        self.assertEqual(next(record for record in records if record["sourceStatus"] == "overruled")["pdfUrl"], "https://www.uscis.gov/old.pdf")

    def test_bia_precedent_chart_topics_and_incoming_treatment(self) -> None:
        html = b"""
        <html><div class='field_body'><div class='bodytext'>
          <h2>ADJUSTMENT OF STATUS</h2>
          <p><strong>Arriving Aliens</strong></p>
          <p class='Indent1'><strong><em>Matter of Old</em>, 25 I&amp;N Dec. 100 (BIA 2010)
            (overruled in part by <em>Matter of New</em>, 29 I&amp;N Dec. 200 (BIA 2026))</strong></p>
          <p class='rteindent2'>Under section 212(a) of the Act, the respondent is ineligible.</p>
        </div></div></html>
        """
        entries = parse_precedent_chart_section(html, "chart-test")
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]["primaryTopic"], "ADJUSTMENT OF STATUS")
        self.assertEqual(entries[0]["subtopic"], "Arriving Aliens")
        self.assertEqual(entries[0]["incomingHeadingTreatments"][0]["treatment"], "overruled")
        self.assertEqual(entries[0]["incomingHeadingTreatments"][0]["scope"], "partial")
        resolved = resolve_chart_entries(entries, [{
            "corpusKey": "eoir-old", "caseName": "OLD", "officialCitation": "25 I&N Dec. 100",
            "volume": 25, "reporterPage": 100, "decisionYear": 2010,
        }])
        self.assertEqual(resolved[0]["caseId"], "eoir-old")
        self.assertEqual(resolved[0]["resolution"], "exact-official-citation")

    def test_official_affected_decisions_codes_pinpoints_and_repairs(self) -> None:
        pages = ["""
        c clarified
        o   25–105   See 29–205
        f   645 F.2d 279   See l9–458
        d   21–1101   See 21–3371
        """]
        rows = parse_affected_decisions_pages(pages, "affected-test")
        self.assertEqual([row["treatment"] for row in rows], ["overruled", "followed", "distinguished"])
        self.assertEqual(rows[1]["treatingPinpoints"][0]["volume"], 19)
        self.assertEqual(rows[1]["treatingPinpoints"][0]["repairs"][0]["from"], "l9")
        records = [
            {"corpusKey": "old", "volume": 25, "reporterPage": 100, "officialCitation": "25 I&N Dec. 100"},
            {"corpusKey": "new", "volume": 29, "reporterPage": 200, "officialCitation": "29 I&N Dec. 200"},
            {"corpusKey": "v19", "volume": 19, "reporterPage": 450, "officialCitation": "19 I&N Dec. 450"},
            {"corpusKey": "v21", "volume": 21, "reporterPage": 1101, "officialCitation": "21 I&N Dec. 1101"},
        ]
        resolved = resolve_affected_decisions(rows, records)
        self.assertEqual(resolved[0]["affectedCaseId"], "old")
        self.assertEqual(resolved[0]["treatingPinpoints"][0]["caseId"], "new")
        self.assertEqual(resolved[0]["treatingPinpoints"][0]["resolution"], "reporter-pinpoint-range")
        self.assertIsNone(resolved[2]["treatingPinpoints"][0]["caseId"])
        self.assertEqual(resolved[2]["treatingPinpoints"][0]["resolution"], "unresolved-out-of-range")

    def test_official_topical_index_resolves_interim_decision_ids(self) -> None:
        columns = [{
            "sourcePage": 1,
            "sourceColumn": 1,
            "text": """
                A
                ADJUSTMENT OF STATUS:
                  sec. 245, 1952 Act, as amended:
                    inspected and admitted; #3005,
                      3153
                    unauthorized employment; #3153
            """,
        }]
        entries = parse_topical_index_columns(columns, "topical-test")
        self.assertEqual(entries[0]["primaryTopic"], "ADJUSTMENT OF STATUS:")
        self.assertIn("sec. 245", entries[0]["entryText"])
        self.assertEqual(entries[0]["eoirIds"], [3005, 3153])
        resolved = resolve_topical_index(entries, [
            {"corpusKey": "eoir-3005", "eoirId": 3005, "officialCitation": "19 I&N Dec. 1"},
            {"corpusKey": "eoir-3153", "eoirId": 3153, "officialCitation": "20 I&N Dec. 1"},
        ])
        self.assertEqual([row["caseId"] for row in resolved[:2]], ["eoir-3005", "eoir-3153"])


class CitationTests(unittest.TestCase):
    def analyze(self, text: str) -> dict:
        completed = subprocess.run(
            ["node", str(ROOT / "tools" / "case-citations.js")],
            input=json.dumps({"sourceId": "test", "text": text, "isHeadnote": True}),
            text=True,
            capture_output=True,
            check=True,
        )
        return json.loads(completed.stdout)

    def test_parallel_authorities_and_explicit_treatment(self) -> None:
        output = self.analyze(
            "Under section 212(a)(9)(B)(i)(II) of the Immigration and Nationality Act, "
            "8 U.S.C. § 1182(a)(9)(B)(i)(II), relief is unavailable. "
            "Matter of Arrabally and Yerrabelly, 25 I&N Dec. 771 (BIA 2012), overruled."
        )
        self.assertEqual({item["family"] for item in output["citations"]}, {"ina", "usc"})
        self.assertEqual(output["treatments"][0]["citedCaseName"], "Matter of Arrabally and Yerrabelly")
        self.assertEqual(output["treatments"][0]["treatment"], "overruled")

    def test_withdrawn_suffix_and_predicate_treatment(self) -> None:
        output = self.analyze(
            "Matter of First, 25 I&N Dec. 100 (BIA 2010), withdrawn. "
            "The Board withdraws from Matter of Baker, 15 I&N Dec. 50 (BIA 1974), to the extent stated."
        )
        self.assertEqual([item["treatment"] for item in output["treatments"]], ["withdrawn", "withdrawn"])

    def test_partial_overruling_is_not_flattened(self) -> None:
        suffix = self.analyze(
            "Matter of First, 25 I&N Dec. 100 (BIA 2010), overruled in part."
        )
        predicate = self.analyze(
            "The Board overrules in part Matter of First, 25 I&N Dec. 100 (BIA 2010)."
        )
        self.assertEqual(suffix["treatments"][0]["treatment"], "overruled-in-part")
        self.assertEqual(predicate["treatments"][0]["treatment"], "overruled-in-part")

    def test_ocr_repairs_are_validated_and_auditable(self) -> None:
        output = self.analyze("INA § 2l2(a)(9)(B)(i)(II) and 8 C.F.R. § l003.l(g)")
        self.assertEqual([(item["targetSection"], item["resolution"]) for item in output["citations"]], [("1182", "local"), ("1003.1", "local")])
        self.assertTrue(all(item["repairs"] for item in output["citations"]))
        self.assertEqual(output["citations"][0]["text"], "INA § 2l2(a)(9)(B)(i)(II)")

    def test_historical_authorities_are_preserved_and_edition_is_not_a_unit(self) -> None:
        output = self.analyze(
            "Under section 241(a)(2)(C) of the Act, 8 U.S.C. § 1251(a)(2)(C) (1992), "
            "and 8 C.F.R. § 242.1(a) (1992), removal followed."
        )
        self.assertEqual([item["resolution"] for item in output["citations"]], [
            "historical-unmapped", "official-source-only", "official-source-only"
        ])
        self.assertEqual(output["citations"][0]["targetSection"], "241")
        self.assertEqual(output["citations"][1]["targetPath"], ["a", "2", "C"])
        self.assertEqual(output["citations"][1]["editionYear"], 1992)
        self.assertEqual(output["citations"][2]["targetPath"], ["a"])

    def test_ocr_extra_digit_in_edition_is_repaired_only_after_path_validation(self) -> None:
        output = self.analyze("8 U.S.C. § 1226(a)(2)(B) (12006)")
        citation = output["citations"][0]
        self.assertEqual(citation["targetPath"], ["a", "2", "B"])
        self.assertEqual(citation["editionYear"], 2006)
        self.assertEqual(citation["resolution"], "local")
        self.assertEqual(citation["provenance"], "ocr-contextual-repair")
        self.assertEqual(citation["repairs"][0]["from"], "12006")

        unresolved = self.analyze("8 U.S.C. § 1226(z)(9) (12006)")["citations"][0]
        self.assertEqual(unresolved["targetPath"], ["z", "9", "12006"])
        self.assertNotIn("editionYear", unresolved)
        self.assertEqual(unresolved["repairs"], [])

    def test_quality_flags_empty_scan(self) -> None:
        self.assertTrue(page_quality("")["needsOcr"])
        self.assertFalse(page_quality("This is ordinary extracted legal prose. " * 30)["needsOcr"])

    def test_printed_reporter_page_audit(self) -> None:
        record = {"volume": 12, "reporterPage": 358, "officialCitation": "12 I&N Dec. 358"}
        pages = [{"nativeText": "Interim Decision #1768\nMatter of Example\n\n358\n"}]
        self.assertEqual(source_citation_audit(record, pages)["status"], "match")

    def test_explicit_prospective_application(self) -> None:
        result = temporal_application("In consideration of the foregoing, we will apply this new holding prospectively.")
        self.assertEqual(result["scope"], "prospective")
        self.assertEqual(result["provenance"], "explicit-temporal-language")


class DatabaseTests(unittest.TestCase):
    def test_treatment_edge_resolves_by_official_citation(self) -> None:
        base_case = {
            "publicationStatus": "published-precedent", "sourceStatus": "published", "sourceCollection": "eoir-precedent-volumes",
            "precedential": True, "pdfUrl": "https://example.test/a.pdf", "decidingBody": "BIA", "decisionYear": 2012, "headnotes": [],
        }
        documents = [
            {
                "case": {**base_case, "corpusKey": "eoir-1", "caseName": "OLD", "officialCitation": "25 I&N Dec. 771"},
                "sourceArtifact": {"sha256": "a" * 64}, "extraction": {"pagesNeedingOcr": []},
                "publisherHeadnoteAnalysis": {"citations": [], "treatments": []},
                "pages": [{"pageNumber": 1, "selectedTextMethod": "pdf-native", "selectedText": "Old.", "quality": {"score": 1, "needsOcr": False}, "citations": [], "treatments": []}],
            },
            {
                "case": {**base_case, "corpusKey": "eoir-2", "caseName": "NEW", "officialCitation": "29 I&N Dec. 830", "decisionYear": 2026},
                "sourceArtifact": {"sha256": "b" * 64}, "extraction": {"pagesNeedingOcr": []},
                "publisherHeadnoteAnalysis": {"citations": [], "treatments": [{
                    "citedCaseName": "Matter of Old", "citedCaseCitation": "25 I&N Dec. 771", "treatment": "overruled",
                    "evidence": "Old, overruled.", "relatedLegalTargets": [], "confidence": 1,
                }]},
                "pages": [{"pageNumber": 1, "selectedTextMethod": "pdf-native", "selectedText": "New.", "quality": {"score": 1, "needsOcr": False}, "citations": [], "treatments": []}],
            },
        ]
        with tempfile.TemporaryDirectory() as temporary:
            case_root = Path(temporary)
            build_database(case_root, documents)
            report = status_report(case_root / "index" / "published-cases.sqlite3", "25 I&N Dec. 771")
            self.assertEqual(report["incomingTreatments"][0]["treatment"], "overruled")
            self.assertEqual(report["incomingTreatmentConclusions"][0]["treatment"], "overruled")
            self.assertEqual(report["incomingTreatments"][0]["treating_case_citation"], "29 I&N Dec. 830")

    def test_publisher_catalog_note_creates_qualified_directed_edge(self) -> None:
        shared = {
            "publicationStatus": "published-precedent", "sourceCollection": "eoir-precedent-volumes",
            "precedential": True, "pdfUrl": "https://example.test/case.pdf", "decidingBody": "BIA",
            "headnotes": [],
        }
        records = [
            {
                **shared, "corpusKey": "eoir-old", "caseName": "OLD", "officialCitation": "25 I&N Dec. 688",
                "sourceStatus": "overruled-in-part", "decisionYear": 2012,
                "publisherTreatment": {
                    "treatment": "overruled-in-part", "treatingCaseCitation": "27 I&N Dec. 271",
                    "evidence": "overruled in part by Matter of New, 27 I&N Dec. 271", "confidence": 1,
                },
            },
            {
                **shared, "corpusKey": "eoir-new", "caseName": "NEW", "officialCitation": "27 I&N Dec. 271",
                "sourceStatus": "published", "decisionYear": 2018,
            },
        ]
        analyses = {record["corpusKey"]: {"citations": [], "treatments": []} for record in records}
        with tempfile.TemporaryDirectory() as temporary:
            case_root = Path(temporary)
            build_database(case_root, [], records, analyses)
            report = status_report(case_root / "index" / "published-cases.sqlite3", "25 I&N Dec. 688")
            self.assertEqual(report["statusSignal"], "publisher-catalog-negative-treatment-found")
            conclusion = report["incomingTreatmentConclusions"][0]
            self.assertEqual(conclusion["treatingCaseId"], "eoir-new")
            self.assertEqual(conclusion["treatment"], "overruled-in-part")
            self.assertEqual(conclusion["sourceTier"], "official-publisher-catalog-status")

    def test_metadata_only_case_is_indexed(self) -> None:
        record = {
            "corpusKey": "eoir-3", "caseName": "METADATA", "officialCitation": "29 I&N Dec. 999",
            "publicationStatus": "published-precedent", "sourceStatus": "published",
            "sourceCollection": "eoir-precedent-volumes", "precedential": True,
            "pdfUrl": "https://example.test/metadata.pdf", "decidingBody": "BIA", "decisionYear": 2026,
            "headnotes": ["Section 212(a) of the Act applies."],
        }
        with tempfile.TemporaryDirectory() as temporary:
            case_root = Path(temporary)
            summary = build_database(
                case_root, [], [record],
                {"eoir-3": {"citations": [], "treatments": []}},
            )
            self.assertEqual(summary["cases"], 1)
            self.assertEqual(summary["metadataOnlyCases"], 1)
            report = status_report(case_root / "index" / "published-cases.sqlite3", "29 I&N Dec. 999")
            self.assertEqual(report["case"]["page_count"], 0)

    def test_catalog_id_in_treatment_citation_is_contextually_repaired(self) -> None:
        base = {
            "publicationStatus": "published-precedent", "sourceStatus": "published",
            "sourceCollection": "eoir-precedent-volumes", "precedential": True,
            "pdfUrl": "https://example.test/case.pdf", "decidingBody": "BIA", "decisionYear": 1991, "headnotes": [],
        }
        records = [
            {**base, "corpusKey": "eoir-3138", "eoirId": 3138, "volume": 20, "reporterPage": 216, "caseName": "MEDRANO", "officialCitation": "20 I&N Dec. 216"},
            {**base, "corpusKey": "eoir-3154", "eoirId": 3154, "volume": 20, "reporterPage": 340, "caseName": "JUAREZ", "officialCitation": "20 I&N Dec. 340"},
        ]
        analysis = {"citations": [], "treatments": [{
            "citedCaseName": "Matter of Medrano", "citedCaseCitation": "20 I&N Dec. 3138",
            "treatment": "distinguished", "evidence": "Medrano distinguished.", "confidence": 1,
        }]}
        with tempfile.TemporaryDirectory() as temporary:
            case_root = Path(temporary)
            build_database(case_root, [], records, {"eoir-3154": analysis, "eoir-3138": {"citations": [], "treatments": []}})
            report = status_report(case_root / "index" / "published-cases.sqlite3", "20 I&N Dec. 216")
            edge = report["incomingTreatments"][0]
            self.assertEqual(edge["cited_case_citation"], "20 I&N Dec. 3138")
            self.assertEqual(edge["cited_case_citation_normalized"], "20 I&N Dec. 216")
            self.assertEqual(edge["citation_resolution"], "publisher-catalog-contextual-repair")

    def test_supporting_chart_treatment_remains_separate_and_cautious(self) -> None:
        base = {
            "publicationStatus": "published-precedent", "sourceStatus": "published",
            "sourceCollection": "eoir-precedent-volumes", "precedential": True,
            "pdfUrl": "https://example.test/case.pdf", "decidingBody": "BIA", "headnotes": [],
        }
        records = [
            {**base, "corpusKey": "eoir-old", "caseName": "OLD", "officialCitation": "25 I&N Dec. 100", "decisionYear": 2010},
            {**base, "corpusKey": "eoir-new", "caseName": "NEW", "officialCitation": "29 I&N Dec. 200", "decisionYear": 2026},
        ]
        chart = {
            "caseId": "eoir-old", "officialCitation": "25 I&N Dec. 100", "writtenCitation": "25 I&N Dec. 100",
            "sourceArtifactId": "chart-test", "primaryTopic": "ADJUSTMENT OF STATUS", "subtopic": "Arriving Aliens",
            "headingText": "Matter of Old, 25 I&N Dec. 100 (BIA 2010), overruled by Matter of New, 29 I&N Dec. 200 (BIA 2026)",
            "resolutionConfidence": 1, "analysis": {"citations": [], "treatments": []},
            "incomingHeadingTreatments": [{
                "treatingCaseCitation": "29 I&N Dec. 200", "citedCaseCitation": "25 I&N Dec. 100",
                "treatment": "overruled", "scope": "unspecified", "confidence": 0.85,
                "evidence": "Old overruled by New.",
            }],
        }
        with tempfile.TemporaryDirectory() as temporary:
            case_root = Path(temporary)
            derived = case_root / "supporting" / "derived"
            derived.mkdir(parents=True)
            (derived / "bia-precedent-chart.jsonl").write_text(json.dumps(chart) + "\n", encoding="utf-8")
            summary = build_database(case_root, [], records)
            self.assertEqual(summary["supportingTopicLinks"], 1)
            self.assertEqual(summary["supportingTreatments"], 1)
            report = status_report(case_root / "index" / "published-cases.sqlite3", "25 I&N Dec. 100")
            self.assertEqual(report["incomingTreatments"], [])
            self.assertEqual(report["supportingIncomingTreatments"][0]["treatment"], "overruled")
            self.assertEqual(report["supportingIncomingTreatmentConclusions"][0]["sourceTier"], "secondary-recall-evidence")
            self.assertEqual(report["statusSignal"], "supporting-negative-treatment-found-needs-opinion-verification")

    def test_official_reporter_treatment_is_separate_and_scope_cautious(self) -> None:
        base = {
            "publicationStatus": "published-precedent", "sourceStatus": "published",
            "sourceCollection": "eoir-precedent-volumes", "precedential": True,
            "pdfUrl": "https://example.test/case.pdf", "decidingBody": "BIA", "headnotes": [],
        }
        records = [
            {**base, "corpusKey": "eoir-old", "caseName": "OLD", "officialCitation": "25 I&N Dec. 100", "volume": 25, "reporterPage": 100, "decisionYear": 2010},
            {**base, "corpusKey": "eoir-new", "caseName": "NEW", "officialCitation": "29 I&N Dec. 200", "volume": 29, "reporterPage": 200, "decisionYear": 2026},
        ]
        affected = {
            "affectedCaseId": "eoir-old", "affectedCaseCitation": "25 I&N Dec. 100",
            "affectedAuthorityKind": "i-and-n", "affectedAuthorityText": "25–105",
            "affectedAuthorityCitation": "25 I&N Dec. 105",
            "affectedPinpoint": {"normalizedPinpoint": "25 I&N Dec. 105"},
            "affectedResolution": "reporter-pinpoint-range", "code": "o", "treatment": "overruled",
            "sourceArtifactId": "affected-test", "sourcePage": 1, "sourceLine": 2,
            "evidence": "25–105 See 29–205", "sourceTier": "official-reporter-editorial-treatment-index", "confidence": 1,
            "treatingPinpoints": [{
                "caseId": "eoir-new", "officialCitation": "29 I&N Dec. 200",
                "normalizedPinpoint": "29 I&N Dec. 205", "resolution": "reporter-pinpoint-range", "repairs": [],
            }],
        }
        with tempfile.TemporaryDirectory() as temporary:
            case_root = Path(temporary)
            derived = case_root / "supporting" / "derived"
            derived.mkdir(parents=True)
            (derived / "eoir-affected-decisions.jsonl").write_text(json.dumps(affected) + "\n", encoding="utf-8")
            summary = build_database(case_root, [], records)
            self.assertEqual(summary["reporterAffectedDecisionEdges"], 1)
            report = status_report(case_root / "index" / "published-cases.sqlite3", "25 I&N Dec. 100")
            self.assertEqual(report["incomingTreatments"], [])
            self.assertEqual(report["reporterAffectedIncoming"][0]["treatment"], "overruled")
            self.assertEqual(
                report["statusSignal"], "official-reporter-negative-treatment-found-needs-scope-review"
            )


if __name__ == "__main__":
    unittest.main()
