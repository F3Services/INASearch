"""Integrity audit for discovery, capture, extraction, and index layers."""

from __future__ import annotations

import hashlib
import json
import sqlite3
import urllib.parse
from pathlib import Path

from .documents import ANALYSIS_SCHEMA_VERSION, analysis_fingerprint, load_jsonl
from .sources import eoir_listing_status, eoir_listing_treatment


ALLOWED_PUBLISHER_HOSTS = {"www.justice.gov", "justice.gov", "www.uscis.gov", "uscis.gov"}


def audit_case_root(repo_root: Path, case_root: Path, strict: bool = False) -> dict:
    records = load_jsonl(case_root / "manifest.jsonl")
    manifest_by_id = {record["corpusKey"]: record for record in records}
    required_manifest_ids = {
        record["corpusKey"] for record in records if record.get("captureRequired") is not False
    }
    unavailable_manifest_ids = sorted(set(manifest_by_id) - required_manifest_ids)
    discovery = json.loads((case_root / "discovery.json").read_text(encoding="utf-8"))
    errors: list[str] = []
    warnings: list[str] = []

    def unique(field: str, selected: list[dict]) -> None:
        values = [str(record.get(field, "")).lower() for record in selected]
        duplicates = sorted({value for value in values if value and values.count(value) > 1})
        if duplicates:
            errors.append(f"Duplicate {field}: {', '.join(duplicates[:10])}")

    unique("corpusKey", records)
    unique("officialCitation", [record for record in records if record["sourceCollection"] == "eoir-precedent-volumes"])
    if discovery.get("recordCount") != len(records):
        errors.append(f"Discovery count is {discovery.get('recordCount')}, manifest has {len(records)}")
    unresolved_catalog = [record["corpusKey"] for record in records if record.get("citationNeedsPdfReview")]
    if unresolved_catalog:
        errors.append(f"Unresolved EOIR catalog citations: {', '.join(unresolved_catalog)}")
    catalog_conflicts = [record["corpusKey"] for record in records if record.get("catalogConflicts")]
    if catalog_conflicts:
        warnings.append(
            f"Official volume/alphabetical catalog metadata conflicts retained for {len(catalog_conflicts)} cases; volume records and PDF-backed overrides take precedence"
        )
    if unavailable_manifest_ids:
        warnings.append(
            f"{len(unavailable_manifest_ids)} published cases have verified broken first-party PDF links and remain metadata-only: "
            + ", ".join(unavailable_manifest_ids)
        )
    stale_publisher_status = []
    for record in records:
        if record.get("sourceCollection") != "eoir-precedent-volumes":
            continue
        expected = eoir_listing_status(record.get("publicationNote") or "")
        if expected != "published" and record.get("sourceStatus") != expected:
            stale_publisher_status.append(record["corpusKey"])
    if stale_publisher_status:
        message = (
            f"{len(stale_publisher_status)} EOIR listing treatment notes are not reflected in sourceStatus; "
            "rerun discovery"
        )
        (errors if strict else warnings).append(message)
    stale_publisher_treatments = []
    for record in records:
        if record.get("sourceCollection") != "eoir-precedent-volumes":
            continue
        expected = eoir_listing_treatment(record.get("publicationNote"), record.get("sourceStatus", "published"))
        if expected and record.get("publisherTreatment") != expected:
            stale_publisher_treatments.append(record["corpusKey"])
    if stale_publisher_treatments:
        message = (
            f"{len(stale_publisher_treatments)} EOIR listing treatment targets are not structured; "
            "rerun discovery"
        )
        (errors if strict else warnings).append(message)
    for record in records:
        parsed = urllib.parse.urlparse(record.get("pdfUrl", ""))
        if parsed.scheme != "https" or parsed.hostname not in ALLOWED_PUBLISHER_HOSTS:
            errors.append(f"Non-authoritative PDF URL for {record.get('corpusKey')}: {record.get('pdfUrl')}")

    capture_path = case_root / "capture.jsonl"
    capture_rows = load_jsonl(capture_path) if capture_path.exists() else []
    capture_ids = [item["corpusKey"] for item in capture_rows]
    duplicate_capture_ids = sorted({case_id for case_id in capture_ids if capture_ids.count(case_id) > 1})
    if duplicate_capture_ids:
        errors.append(f"Duplicate capture corpus keys: {', '.join(duplicate_capture_ids[:10])}")
    captures = {item["corpusKey"]: item for item in capture_rows}
    unknown_capture_ids = sorted(set(captures) - set(manifest_by_id))
    if unknown_capture_ids:
        errors.append(f"Capture ledger contains {len(unknown_capture_ids)} cases absent from the manifest")
    capture_errors = 0
    for corpus_key, item in captures.items():
        path = Path(item["path"])
        if not path.is_absolute():
            path = repo_root / path
        if not path.exists():
            errors.append(f"Captured PDF missing for {corpus_key}: {path}")
            capture_errors += 1
            continue
        value = path.read_bytes()
        if len(value) != item["bytes"] or hashlib.sha256(value).hexdigest() != item["sha256"]:
            errors.append(f"Captured PDF checksum mismatch for {corpus_key}")
            capture_errors += 1

    supporting_manifest_path = case_root / "supporting" / "manifest.json"
    supporting_records: list[dict] = []
    supporting_captured = 0
    if supporting_manifest_path.exists():
        supporting_manifest = json.loads(supporting_manifest_path.read_text(encoding="utf-8"))
        supporting_records = supporting_manifest.get("artifacts", [])
        supporting_ids = [str(item.get("id", "")) for item in supporting_records]
        duplicate_supporting_ids = sorted({value for value in supporting_ids if value and supporting_ids.count(value) > 1})
        if duplicate_supporting_ids:
            errors.append(f"Duplicate supporting artifact ID: {', '.join(duplicate_supporting_ids)}")
        for item in supporting_records:
            artifact_id = item.get("id", "unknown")
            path = Path(item.get("localPath", ""))
            path = path if path.is_absolute() else case_root / path
            if not path.exists():
                message = f"Supporting artifact missing for {artifact_id}: {path}"
                (errors if strict else warnings).append(message)
                continue
            value = path.read_bytes()
            if len(value) != item.get("bytes") or hashlib.sha256(value).hexdigest() != item.get("sha256"):
                errors.append(f"Supporting artifact checksum mismatch for {artifact_id}")
                continue
            media_type = item.get("mediaType", "application/pdf")
            if media_type == "application/pdf" and not value.startswith(b"%PDF-"):
                errors.append(f"Supporting artifact is not a PDF for {artifact_id}")
                continue
            if media_type == "text/html" and not value.lstrip().lower().startswith((b"<!doctype html", b"<html")):
                errors.append(f"Supporting artifact is not HTML for {artifact_id}")
                continue
            if media_type not in {"application/pdf", "text/html"}:
                errors.append(f"Unsupported media type for {artifact_id}: {media_type}")
                continue
            supporting_captured += 1

    chart_artifacts = [
        item for item in supporting_records
        if item.get("role") == "first-party-informational-chart-section"
    ]
    chart_entries = 0
    chart_unresolved = 0
    chart_output_path = case_root / "supporting" / "derived" / "bia-precedent-chart.jsonl"
    chart_summary_path = case_root / "supporting" / "chart-summary.json"
    if chart_artifacts:
        if not chart_summary_path.exists() or not chart_output_path.exists():
            message = "BIA Precedent Chart supporting analysis is missing; run case-index.py supporting"
            (errors if strict else warnings).append(message)
        else:
            chart_summary = json.loads(chart_summary_path.read_text(encoding="utf-8"))
            output_value = chart_output_path.read_bytes()
            if hashlib.sha256(output_value).hexdigest() != chart_summary.get("outputSha256"):
                errors.append("BIA Precedent Chart supporting output checksum is stale")
            chart_rows = [json.loads(line) for line in output_value.decode("utf-8").splitlines() if line.strip()]
            chart_entries = len(chart_rows)
            chart_unresolved = sum(not item.get("caseId") for item in chart_rows)
            if chart_summary.get("occurrences") != chart_entries:
                errors.append("BIA Precedent Chart summary occurrence count is stale")
            unknown_chart_cases = sorted({
                item.get("caseId") for item in chart_rows
                if item.get("caseId") and item.get("caseId") not in manifest_by_id
            })
            if unknown_chart_cases:
                errors.append(f"BIA Precedent Chart resolves to {len(unknown_chart_cases)} unknown manifest cases")
            if chart_unresolved:
                warnings.append(f"{chart_unresolved} BIA Precedent Chart occurrences do not resolve to the manifest")

    affected_artifacts = [
        item for item in supporting_records
        if item.get("role") == "official-reporter-affected-decisions-table"
    ]
    affected_rows = 0
    affected_edges = 0
    affected_unresolved_treating = 0
    affected_output_path = case_root / "supporting" / "derived" / "eoir-affected-decisions.jsonl"
    affected_summary_path = case_root / "supporting" / "affected-decisions-summary.json"
    if affected_artifacts:
        if not affected_summary_path.exists() or not affected_output_path.exists():
            message = "EOIR affected-decisions supporting analysis is missing; run case-index.py supporting"
            (errors if strict else warnings).append(message)
        else:
            affected_summary = json.loads(affected_summary_path.read_text(encoding="utf-8"))
            output_value = affected_output_path.read_bytes()
            if hashlib.sha256(output_value).hexdigest() != affected_summary.get("outputSha256"):
                errors.append("EOIR affected-decisions supporting output checksum is stale")
            affected_data = [json.loads(line) for line in output_value.decode("utf-8").splitlines() if line.strip()]
            affected_rows = len(affected_data)
            affected_edges = sum(len(item.get("treatingPinpoints", [])) for item in affected_data)
            affected_unresolved_treating = sum(
                not pinpoint.get("caseId")
                for item in affected_data for pinpoint in item.get("treatingPinpoints", [])
            )
            if affected_summary.get("rows") != affected_rows:
                errors.append("EOIR affected-decisions summary row count is stale")
            if affected_summary.get("expandedEdges") != affected_edges:
                errors.append("EOIR affected-decisions summary edge count is stale")
            unknown_affected_cases = sorted({
                case_id
                for item in affected_data
                for case_id in [
                    item.get("affectedCaseId"),
                    *(pinpoint.get("caseId") for pinpoint in item.get("treatingPinpoints", [])),
                ]
                if case_id and case_id not in manifest_by_id
            })
            if unknown_affected_cases:
                errors.append(f"EOIR affected-decisions data resolves to {len(unknown_affected_cases)} unknown manifest cases")
            if affected_unresolved_treating:
                warnings.append(
                    f"{affected_unresolved_treating} EOIR affected-decisions treating pinpoints remain unresolved and retain printed evidence"
                )

    topical_artifacts = [
        item for item in supporting_records
        if item.get("role") == "official-topical-index-supporting-evidence"
        and item.get("hasTextLayer")
    ]
    topical_occurrences = 0
    topical_unresolved = 0
    topical_output_path = case_root / "supporting" / "derived" / "eoir-topical-index.jsonl"
    topical_summary_path = case_root / "supporting" / "topical-index-summary.json"
    if topical_artifacts:
        if not topical_summary_path.exists() or not topical_output_path.exists():
            message = "EOIR topical-index supporting analysis is missing; run case-index.py supporting"
            (errors if strict else warnings).append(message)
        else:
            topical_summary = json.loads(topical_summary_path.read_text(encoding="utf-8"))
            output_value = topical_output_path.read_bytes()
            if hashlib.sha256(output_value).hexdigest() != topical_summary.get("outputSha256"):
                errors.append("EOIR topical-index supporting output checksum is stale")
            topical_rows = [json.loads(line) for line in output_value.decode("utf-8").splitlines() if line.strip()]
            topical_occurrences = len(topical_rows)
            topical_unresolved = sum(not item.get("caseId") for item in topical_rows)
            if topical_summary.get("caseTopicOccurrences") != topical_occurrences:
                errors.append("EOIR topical-index summary occurrence count is stale")
            unknown_topical_cases = sorted({
                item.get("caseId") for item in topical_rows
                if item.get("caseId") and item.get("caseId") not in manifest_by_id
            })
            if unknown_topical_cases:
                errors.append(f"EOIR topical-index data resolves to {len(unknown_topical_cases)} unknown manifest cases")
            if topical_unresolved:
                warnings.append(f"{topical_unresolved} EOIR topical-index occurrences remain unresolved")

    derived_root = case_root / "derived"
    extracted = 0
    extracted_ids: list[str] = []
    extracted_index_expectations: dict[str, tuple[str, int]] = {}
    pages = 0
    pages_needing_ocr = 0
    citation_span_errors = 0
    citation_audit_mismatches: list[str] = []
    stale_analysis_ids: list[str] = []
    expected_analysis_fingerprint = analysis_fingerprint(repo_root)
    if derived_root.exists():
        for path in sorted(derived_root.glob("*.json")):
            document = json.loads(path.read_text(encoding="utf-8"))
            case_id = document["case"]["corpusKey"]
            extracted_ids.append(case_id)
            if document.get("case") != manifest_by_id.get(case_id):
                errors.append(f"Derived case metadata is stale for {case_id}")
            artifact = captures.get(case_id)
            if not artifact or document.get("sourceArtifact", {}).get("sha256") != artifact.get("sha256"):
                errors.append(f"Derived source checksum is stale or absent for {case_id}")
            extracted_index_expectations[case_id] = (
                document.get("sourceArtifact", {}).get("sha256", ""),
                len(document["pages"]),
            )
            extracted += 1
            pages += len(document["pages"])
            pages_needing_ocr += len(document["extraction"].get("pagesNeedingOcr", []))
            if (
                document["extraction"].get("analysisSchemaVersion") != ANALYSIS_SCHEMA_VERSION
                or document["extraction"].get("analysisFingerprint") != expected_analysis_fingerprint
            ):
                stale_analysis_ids.append(case_id)
            if document["extraction"].get("sourceCitationAudit", {}).get("status") == "mismatch-review":
                citation_audit_mismatches.append(case_id)
            regions = [("headnotes", "\n".join(document["case"].get("headnotes", [])), document.get("publisherHeadnoteAnalysis", {}))]
            regions.extend((f"page {page['pageNumber']}", page["selectedText"], page) for page in document["pages"])
            for label, text, region in regions:
                for citation in region.get("citations", []):
                    start, end = citation.get("start"), citation.get("end")
                    if not isinstance(start, int) or not isinstance(end, int) or text[start:end] != citation.get("text"):
                        errors.append(f"Citation span mismatch in {case_id} {label}")
                        citation_span_errors += 1
                        if citation_span_errors >= 20:
                            break
    if citation_audit_mismatches:
        warnings.append(f"Printed reporter citation needs review for {len(citation_audit_mismatches)} cases")
    if stale_analysis_ids:
        message = (
            f"Semantic citation analysis is stale for {len(stale_analysis_ids)} extracted cases; "
            "run case-index.py extract --available before rebuilding the index"
        )
        (errors if strict else warnings).append(message)

    database_path = case_root / "index" / "published-cases.sqlite3"
    indexed = 0
    indexed_full_text = 0
    unresolved_treatments = 0
    case_citation_occurrences = 0
    resolved_case_citation_occurrences = 0
    database_schema_current = False
    if database_path.exists():
        connection = sqlite3.connect(database_path)
        database_tables = {
            row[0] for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            )
        }
        database_schema_current = "case_citations" in database_tables
        indexed = connection.execute("SELECT count(*) FROM cases").fetchone()[0]
        indexed_full_text = connection.execute("SELECT count(*) FROM cases WHERE page_count > 0").fetchone()[0]
        unresolved_treatments = connection.execute("SELECT count(*) FROM treatments WHERE cited_case_id IS NULL").fetchone()[0]
        if database_schema_current:
            case_citation_occurrences = connection.execute(
                "SELECT count(*) FROM case_citations"
            ).fetchone()[0]
            resolved_case_citation_occurrences = connection.execute(
                "SELECT count(*) FROM case_citations WHERE cited_case_id IS NOT NULL"
            ).fetchone()[0]
        indexed_metadata = {
            case_id: json.loads(metadata_json)
            for case_id, metadata_json in connection.execute("SELECT case_id, metadata_json FROM cases")
        }
        indexed_document_state = {
            case_id: (source_sha256 or "", page_count)
            for case_id, source_sha256, page_count in connection.execute(
                "SELECT case_id, source_sha256, page_count FROM cases"
            )
        }
        stale_index_metadata = [
            case_id for case_id, metadata in indexed_metadata.items()
            if manifest_by_id.get(case_id) != metadata
        ]
        unknown_index_cases = sorted(set(indexed_metadata) - set(manifest_by_id))
        result = connection.execute("PRAGMA integrity_check").fetchone()[0]
        connection.close()
        if result != "ok":
            errors.append(f"SQLite integrity check failed: {result}")
        if stale_index_metadata:
            errors.append(f"SQLite metadata is stale for {len(stale_index_metadata)} cases")
        if unknown_index_cases:
            errors.append(f"SQLite contains {len(unknown_index_cases)} cases absent from the manifest")
        stale_index_documents = sorted(
            case_id for case_id, expected in extracted_index_expectations.items()
            if indexed_document_state.get(case_id) != expected
        )
        if stale_index_documents:
            message = f"SQLite full-text state is stale for {len(stale_index_documents)} extracted cases"
            (errors if strict else warnings).append(message)
        if indexed != len(records):
            warnings.append(f"SQLite contains {indexed} of {len(records)} manifest cases")
        if unresolved_treatments:
            warnings.append(f"{unresolved_treatments} explicit treatment citations do not resolve to the electronic manifest")
        if not database_schema_current:
            message = "SQLite schema predates the case-citation occurrence table; rebuild the complete index"
            (errors if strict else warnings).append(message)
        else:
            case_citation_export_path = case_root / "index" / "case-citations.jsonl"
            if not case_citation_export_path.exists():
                message = "SQLite has case-citation occurrences but the portable case-citations.jsonl export is missing"
                (errors if strict else warnings).append(message)

    duplicate_extracted_ids = sorted({case_id for case_id in extracted_ids if extracted_ids.count(case_id) > 1})
    if duplicate_extracted_ids:
        errors.append(f"Duplicate derived corpus keys: {', '.join(duplicate_extracted_ids[:10])}")
    missing_capture_ids = sorted(required_manifest_ids - set(captures))
    missing_extraction_ids = sorted(required_manifest_ids - set(extracted_ids))
    missing_captures = len(missing_capture_ids)
    missing_extractions = len(missing_extraction_ids)
    if strict and missing_captures:
        errors.append(f"Strict audit: {missing_captures} manifest cases lack captured PDFs")
    if strict and missing_extractions:
        errors.append(f"Strict audit: {missing_extractions} manifest cases lack extracted documents")
    if strict and indexed != len(records):
        errors.append(f"Strict audit: SQLite contains {indexed} of {len(records)} cases")
    if strict and indexed_full_text != len(required_manifest_ids):
        errors.append(
            f"Strict audit: SQLite has full text for {indexed_full_text} of {len(required_manifest_ids)} publisher-available cases"
        )
    return {
        "schemaVersion": 1,
        "ok": not errors,
        "strict": strict,
        "manifestCases": len(records),
        "publisherAvailableCases": len(required_manifest_ids),
        "publisherPdfUnavailableCases": len(unavailable_manifest_ids),
        "capturedPdfs": len(captures),
        "supportingArtifacts": len(supporting_records),
        "supportingArtifactsCaptured": supporting_captured,
        "supportingChartOccurrences": chart_entries,
        "supportingChartUnresolved": chart_unresolved,
        "supportingAffectedDecisionRows": affected_rows,
        "supportingAffectedDecisionEdges": affected_edges,
        "supportingAffectedTreatingUnresolved": affected_unresolved_treating,
        "supportingTopicalOccurrences": topical_occurrences,
        "supportingTopicalUnresolved": topical_unresolved,
        "stalePublisherStatuses": len(stale_publisher_status),
        "stalePublisherTreatments": len(stale_publisher_treatments),
        "extractedCases": extracted,
        "indexedCases": indexed,
        "indexedFullTextCases": indexed_full_text,
        "analysisSchemaVersion": ANALYSIS_SCHEMA_VERSION,
        "staleAnalysisCases": len(stale_analysis_ids),
        "databaseSchemaCurrent": database_schema_current,
        "caseCitationOccurrences": case_citation_occurrences,
        "resolvedCaseCitationOccurrences": resolved_case_citation_occurrences,
        "unresolvedTreatments": unresolved_treatments,
        "pages": pages,
        "pagesNeedingOcr": pages_needing_ocr,
        "missingCaptures": missing_captures,
        "missingExtractions": missing_extractions,
        "errors": errors,
        "warnings": warnings,
    }
