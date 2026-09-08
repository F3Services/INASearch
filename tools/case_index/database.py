"""Build the local SQLite/FTS case, authority, and treatment index."""

from __future__ import annotations

import json
import re
import sqlite3
from pathlib import Path

from .documents import atomic_write


SCHEMA = """
PRAGMA foreign_keys = ON;
CREATE TABLE cases (
  case_id TEXT PRIMARY KEY,
  case_name TEXT NOT NULL,
  official_citation TEXT NOT NULL,
  deciding_body TEXT,
  decision_year INTEGER,
  publication_status TEXT NOT NULL,
  source_status TEXT NOT NULL,
  source_collection TEXT NOT NULL,
  precedential INTEGER NOT NULL,
  pdf_url TEXT NOT NULL,
  source_sha256 TEXT NOT NULL,
  page_count INTEGER NOT NULL,
  pages_needing_ocr INTEGER NOT NULL,
  metadata_json TEXT NOT NULL
);
CREATE TABLE pages (
  case_id TEXT NOT NULL REFERENCES cases(case_id) ON DELETE CASCADE,
  page_number INTEGER NOT NULL,
  text_method TEXT NOT NULL,
  quality_score REAL NOT NULL,
  needs_ocr INTEGER NOT NULL,
  text TEXT NOT NULL,
  PRIMARY KEY (case_id, page_number)
);
CREATE TABLE case_citations (
  id INTEGER PRIMARY KEY,
  citing_case_id TEXT NOT NULL REFERENCES cases(case_id) ON DELETE CASCADE,
  cited_case_id TEXT REFERENCES cases(case_id),
  page_number INTEGER,
  source_region TEXT NOT NULL,
  start_offset INTEGER NOT NULL,
  end_offset INTEGER NOT NULL,
  written_text TEXT NOT NULL,
  written_citation TEXT NOT NULL,
  citation_normalized TEXT NOT NULL,
  citation_resolution TEXT NOT NULL,
  cited_case_name TEXT,
  reporter_volume INTEGER NOT NULL,
  reporter_page INTEGER NOT NULL,
  pinpoints_json TEXT NOT NULL,
  cited_case_body TEXT,
  cited_case_year INTEGER,
  evidence TEXT NOT NULL,
  provenance TEXT NOT NULL,
  confidence REAL NOT NULL,
  repairs_json TEXT NOT NULL,
  self_citation INTEGER NOT NULL
);
CREATE INDEX case_citation_citing_idx ON case_citations(citing_case_id, page_number, start_offset);
CREATE INDEX case_citation_cited_idx ON case_citations(cited_case_id, citing_case_id);
CREATE INDEX case_citation_reporter_idx ON case_citations(reporter_volume, reporter_page);
CREATE TABLE legal_citations (
  id INTEGER PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(case_id) ON DELETE CASCADE,
  page_number INTEGER,
  source_region TEXT NOT NULL,
  written_text TEXT NOT NULL,
  family TEXT NOT NULL,
  target_kind TEXT,
  target_title TEXT,
  target_section TEXT,
  target_path_json TEXT NOT NULL,
  resolution TEXT NOT NULL,
  provenance TEXT NOT NULL,
  confidence REAL NOT NULL,
  applicability TEXT NOT NULL,
  applicability_score REAL NOT NULL,
  evidence TEXT,
  repairs_json TEXT NOT NULL,
  alternatives_json TEXT NOT NULL
);
CREATE INDEX legal_target_idx ON legal_citations(family, target_title, target_section);
CREATE TABLE rule_applicability (
  case_id TEXT NOT NULL REFERENCES cases(case_id) ON DELETE CASCADE,
  canonical_target_key TEXT NOT NULL,
  target_kind TEXT NOT NULL,
  target_title TEXT NOT NULL,
  target_section TEXT NOT NULL,
  target_path_json TEXT NOT NULL,
  max_score REAL NOT NULL,
  classification TEXT NOT NULL,
  occurrences INTEGER NOT NULL,
  headnote_mentions INTEGER NOT NULL,
  evidence_json TEXT NOT NULL,
  PRIMARY KEY (case_id, canonical_target_key)
);
CREATE INDEX rule_applicability_target_idx ON rule_applicability(canonical_target_key, max_score DESC);
CREATE TABLE supporting_topics (
  id INTEGER PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(case_id) ON DELETE CASCADE,
  source_artifact_id TEXT NOT NULL,
  primary_topic TEXT,
  subtopic TEXT,
  heading_text TEXT NOT NULL,
  source_tier TEXT NOT NULL,
  confidence REAL NOT NULL
);
CREATE INDEX supporting_topic_case_idx ON supporting_topics(case_id, primary_topic, subtopic);
CREATE INDEX supporting_topic_name_idx ON supporting_topics(primary_topic, subtopic, case_id);
CREATE TABLE supporting_treatments (
  id INTEGER PRIMARY KEY,
  treating_case_id TEXT REFERENCES cases(case_id),
  cited_case_id TEXT REFERENCES cases(case_id),
  treating_case_citation TEXT NOT NULL,
  cited_case_citation TEXT NOT NULL,
  treatment TEXT NOT NULL,
  scope TEXT NOT NULL,
  evidence_kind TEXT NOT NULL,
  source_artifact_id TEXT NOT NULL,
  evidence TEXT NOT NULL,
  source_tier TEXT NOT NULL,
  confidence REAL NOT NULL
);
CREATE INDEX supporting_treatment_target_idx ON supporting_treatments(cited_case_id, cited_case_citation);
CREATE TABLE reporter_affected_decisions (
  id INTEGER PRIMARY KEY,
  affected_case_id TEXT REFERENCES cases(case_id),
  treating_case_id TEXT REFERENCES cases(case_id),
  affected_authority_kind TEXT NOT NULL,
  affected_authority_text TEXT NOT NULL,
  affected_authority_citation TEXT NOT NULL,
  affected_case_citation TEXT,
  affected_pinpoint TEXT,
  treating_case_citation TEXT NOT NULL,
  treating_pinpoint TEXT NOT NULL,
  treatment_code TEXT NOT NULL,
  treatment TEXT NOT NULL,
  affected_resolution TEXT NOT NULL,
  treating_resolution TEXT NOT NULL,
  source_artifact_id TEXT NOT NULL,
  source_page INTEGER NOT NULL,
  source_line INTEGER NOT NULL,
  evidence TEXT NOT NULL,
  repairs_json TEXT NOT NULL,
  source_tier TEXT NOT NULL,
  confidence REAL NOT NULL
);
CREATE INDEX reporter_affected_target_idx ON reporter_affected_decisions(affected_case_id, affected_authority_citation);
CREATE INDEX reporter_affected_treating_idx ON reporter_affected_decisions(treating_case_id, treating_case_citation);
CREATE TABLE treatments (
  id INTEGER PRIMARY KEY,
  treating_case_id TEXT NOT NULL REFERENCES cases(case_id) ON DELETE CASCADE,
  cited_case_id TEXT REFERENCES cases(case_id),
  cited_case_name TEXT NOT NULL,
  cited_case_citation TEXT NOT NULL,
  cited_case_citation_normalized TEXT NOT NULL,
  citation_resolution TEXT NOT NULL,
  citation_repairs_json TEXT NOT NULL,
  treatment TEXT NOT NULL,
  page_number INTEGER,
  source_region TEXT NOT NULL,
  evidence TEXT NOT NULL,
  scope_evidence TEXT NOT NULL,
  related_legal_targets_json TEXT NOT NULL,
  temporal_scope TEXT,
  temporal_evidence_json TEXT NOT NULL,
  decision_date TEXT,
  confidence REAL NOT NULL
);
CREATE INDEX treatment_target_idx ON treatments(cited_case_id, cited_case_citation);
CREATE VIRTUAL TABLE case_fts USING fts5(case_id UNINDEXED, case_name, official_citation, headnotes, decision_text, tokenize='unicode61');
"""


def _citation_identity(citation: dict) -> tuple:
    return (
        citation.get("family"), str(citation.get("targetTitle", "")), str(citation.get("targetSection", "")),
        json.dumps(citation.get("targetPath", []), ensure_ascii=False), citation.get("written_text", citation.get("text", "")),
    )


def _canonical_target(citation: dict) -> tuple[str, str, str, list[str]] | None:
    target_kind = str(citation.get("targetKind", ""))
    title = str(citation.get("targetTitle", ""))
    section = str(citation.get("targetSection", ""))
    path = [str(token) for token in citation.get("targetPath", [])]
    if not target_kind or not title or not section or citation.get("resolution") not in {"local", "official-source-only", "historical-unmapped"}:
        return None
    return target_kind, title, section, path


def _case_name_key(value: str) -> str:
    value = str(value).upper().replace("MATTER OF", "", 1)
    return "".join(character for character in value if character.isalnum())


def _resolve_treatment_case(
    treatment: dict,
    citation_to_record: dict[str, dict],
    eoir_id_to_records: dict[int, list[dict]],
) -> tuple[str | None, str, str, list[dict]]:
    written = treatment["citedCaseCitation"]
    exact = citation_to_record.get(written.lower())
    if exact:
        return exact["corpusKey"], exact["officialCitation"], "exact-official-citation", []

    # Some EOIR catalog headnotes contain the linked interim-decision ID where
    # the reporter page should be (for example ``20 I&N Dec. 3138`` for
    # MEDRANO, ID 3138, officially 20 I&N Dec. 216).  Repair only when volume,
    # ID, and normalized case name all agree with one manifest record.
    match = re.fullmatch(r"(\d{1,2}) I&N Dec\. (\d{3,5})", written, re.IGNORECASE)
    if match:
        volume, possible_id = int(match.group(1)), int(match.group(2))
        candidates = [
            record for record in eoir_id_to_records.get(possible_id, [])
            if record.get("volume") == volume
            and record.get("eoirId") == possible_id
            and _case_name_key(record.get("caseName", "")) == _case_name_key(treatment.get("citedCaseName", ""))
        ]
        if len(candidates) == 1:
            candidate = candidates[0]
            return (
                candidate["corpusKey"], candidate["officialCitation"], "publisher-catalog-contextual-repair",
                [{
                    "component": "reporterPage", "from": str(possible_id), "to": str(candidate["reporterPage"]),
                    "reason": "written page equals the matching EOIR interim-decision ID",
                }],
            )
    return None, written, "unresolved", []


def _resolve_case_citation(
    occurrence: dict,
    citation_to_record: dict[str, dict],
) -> tuple[str | None, str, str]:
    """Resolve a reporter occurrence only when its canonical start page is exact.

    Pinpoints are intentionally not used as fallback start pages, and names are
    retained as evidence rather than treated as identifiers.  This prevents a
    plausible-looking OCR or short-form citation from silently becoming an edge.
    """
    normalized = str(occurrence.get("canonicalCitation", ""))
    exact = citation_to_record.get(normalized.lower())
    if exact:
        return exact["corpusKey"], exact["officialCitation"], "exact-official-citation"
    return None, normalized, "unresolved"


def build_database(
    case_root: Path,
    documents: list[dict],
    records: list[dict] | None = None,
    headnote_analyses: dict[str, dict] | None = None,
) -> dict:
    """Build an all-case metadata index, enriched by available full text."""
    document_by_id = {document["case"]["corpusKey"]: document for document in documents}
    records = records or [document["case"] for document in documents]
    headnote_analyses = headnote_analyses or {}
    index_root = case_root / "index"
    index_root.mkdir(parents=True, exist_ok=True)
    database_path = index_root / "published-cases.sqlite3"
    temporary_path = index_root / ".published-cases.sqlite3.tmp"
    if temporary_path.exists():
        temporary_path.unlink()
    connection = sqlite3.connect(temporary_path)
    connection.executescript(SCHEMA)
    citations_count = 0
    case_citations_count = 0
    resolved_case_citations_count = 0
    treatments_count = 0
    applicability_count = 0
    supporting_topic_count = 0
    supporting_treatment_count = 0
    reporter_affected_count = 0
    reporter_topical_count = 0
    citation_export: list[dict] = []
    case_citation_export: list[dict] = []
    applicability_export: list[dict] = []
    for case in records:
        case_id = case["corpusKey"]
        document = document_by_id.get(case_id)
        pages = document.get("pages", []) if document else []
        artifact = document.get("sourceArtifact", {}) if document else {}
        extraction = document.get("extraction", {}) if document else {}
        connection.execute(
            "INSERT INTO cases VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                case["corpusKey"], case.get("caseName", ""), case.get("officialCitation", ""), case.get("decidingBody"),
                case.get("decisionYear"), case["publicationStatus"], case["sourceStatus"], case["sourceCollection"],
                int(case["precedential"]), case["pdfUrl"], artifact.get("sha256", ""), len(pages),
                len(extraction.get("pagesNeedingOcr", [])), json.dumps(case, ensure_ascii=False),
            ),
        )
        page_texts = []
        for page in pages:
            page_texts.append(page["selectedText"])
            connection.execute(
                "INSERT INTO pages VALUES (?, ?, ?, ?, ?, ?)",
                (case["corpusKey"], page["pageNumber"], page["selectedTextMethod"], page["quality"]["score"], int(page["quality"]["needsOcr"]), page["selectedText"]),
            )
        connection.execute(
            "INSERT INTO case_fts VALUES (?, ?, ?, ?, ?)",
            (case["corpusKey"], case.get("caseName", ""), case.get("officialCitation", ""), "\n".join(case.get("headnotes", [])), "\n\n".join(page_texts)),
        )

    valid_case_ids = {record["corpusKey"] for record in records}
    citation_to_record = {record.get("officialCitation", "").lower(): record for record in records}
    eoir_id_to_records: dict[int, list[dict]] = {}
    for record in records:
        if isinstance(record.get("eoirId"), int):
            eoir_id_to_records.setdefault(record["eoirId"], []).append(record)
    seen_topics: set[tuple] = set()
    supporting_chart_path = case_root / "supporting" / "derived" / "bia-precedent-chart.jsonl"
    supporting_chart = []
    if supporting_chart_path.exists():
        supporting_chart = [
            json.loads(line) for line in supporting_chart_path.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]
        for entry in supporting_chart:
            case_id = entry.get("caseId")
            if case_id not in valid_case_ids:
                continue
            identity = (
                case_id, entry.get("primaryTopic"), entry.get("subtopic"), "secondary-recall-evidence",
            )
            if identity in seen_topics:
                continue
            seen_topics.add(identity)
            connection.execute(
                """INSERT INTO supporting_topics
                (case_id,source_artifact_id,primary_topic,subtopic,heading_text,source_tier,confidence)
                VALUES (?,?,?,?,?,?,?)""",
                (
                    case_id, entry.get("sourceArtifactId", ""), entry.get("primaryTopic"), entry.get("subtopic"),
                    entry.get("headingText", ""), "secondary-recall-evidence", float(entry.get("resolutionConfidence", 0)),
                ),
            )
            supporting_topic_count += 1

    topical_index_path = case_root / "supporting" / "derived" / "eoir-topical-index.jsonl"
    if topical_index_path.exists():
        for entry in (
            json.loads(line) for line in topical_index_path.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ):
            case_id = entry.get("caseId")
            if case_id not in valid_case_ids:
                continue
            identity = (
                case_id, entry.get("primaryTopic"), entry.get("entryText"),
                "official-reporter-topical-index",
            )
            if identity in seen_topics:
                continue
            seen_topics.add(identity)
            connection.execute(
                """INSERT INTO supporting_topics
                (case_id,source_artifact_id,primary_topic,subtopic,heading_text,source_tier,confidence)
                VALUES (?,?,?,?,?,?,?)""",
                (
                    case_id, entry.get("sourceArtifactId", ""), entry.get("primaryTopic"),
                    entry.get("entryText"), entry.get("evidence", ""),
                    "official-reporter-topical-index", float(entry.get("confidence", 0)),
                ),
            )
            supporting_topic_count += 1
            reporter_topical_count += 1

    affected_decisions_path = case_root / "supporting" / "derived" / "eoir-affected-decisions.jsonl"
    affected_decisions = []
    if affected_decisions_path.exists():
        affected_decisions = [
            json.loads(line) for line in affected_decisions_path.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]
        for row in affected_decisions:
            affected_case_id = row.get("affectedCaseId")
            if affected_case_id not in valid_case_ids:
                affected_case_id = None
            affected_pinpoint = row.get("affectedPinpoint") or {}
            for pinpoint in row.get("treatingPinpoints", []):
                treating_case_id = pinpoint.get("caseId")
                if treating_case_id not in valid_case_ids:
                    treating_case_id = None
                connection.execute(
                    """INSERT INTO reporter_affected_decisions
                    (affected_case_id,treating_case_id,affected_authority_kind,affected_authority_text,
                    affected_authority_citation,affected_case_citation,affected_pinpoint,treating_case_citation,
                    treating_pinpoint,treatment_code,treatment,affected_resolution,treating_resolution,
                    source_artifact_id,source_page,source_line,evidence,repairs_json,source_tier,confidence)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                    (
                        affected_case_id, treating_case_id, row.get("affectedAuthorityKind", "unknown"),
                        row.get("affectedAuthorityText", ""), row.get("affectedAuthorityCitation", ""),
                        row.get("affectedCaseCitation"), affected_pinpoint.get("normalizedPinpoint"),
                        pinpoint.get("officialCitation") or pinpoint.get("normalizedPinpoint", ""),
                        pinpoint.get("normalizedPinpoint", ""), row.get("code", ""), row.get("treatment", ""),
                        row.get("affectedResolution", "unresolved"), pinpoint.get("resolution", "unresolved"),
                        row.get("sourceArtifactId", ""), int(row.get("sourcePage", 0)), int(row.get("sourceLine", 0)),
                        row.get("evidence", ""), json.dumps(pinpoint.get("repairs", []), ensure_ascii=False),
                        row.get("sourceTier", "official-reporter-editorial-treatment-index"),
                        float(row.get("confidence", 0)),
                    ),
                )
                reporter_affected_count += 1

    pending_treatments: list[tuple[str, int | None, str, dict]] = []
    for case in records:
        case_id = case["corpusKey"]
        document = document_by_id.get(case_id)
        headnote_analysis = (
            document.get("publisherHeadnoteAnalysis", {})
            if document else headnote_analyses.get(case_id, {})
        )
        regions = [(None, "publisher-headnote", headnote_analysis)]
        regions.extend((page["pageNumber"], "decision-page", page) for page in (document.get("pages", []) if document else []))
        seen_citations: set[tuple] = set()
        seen_case_citations: set[tuple] = set()
        applicability: dict[str, dict] = {}
        for page_number, source_region, region in regions:
            for occurrence in region.get("caseCitations", []):
                identity = (
                    page_number, source_region, int(occurrence.get("start", 0)), int(occurrence.get("end", 0)),
                    occurrence.get("canonicalCitation", ""),
                )
                if identity in seen_case_citations:
                    continue
                seen_case_citations.add(identity)
                cited_case_id, normalized_citation, resolution = _resolve_case_citation(
                    occurrence, citation_to_record
                )
                is_self_citation = bool(cited_case_id and cited_case_id == case_id)
                connection.execute(
                    """INSERT INTO case_citations
                    (citing_case_id,cited_case_id,page_number,source_region,start_offset,end_offset,
                    written_text,written_citation,citation_normalized,citation_resolution,cited_case_name,
                    reporter_volume,reporter_page,pinpoints_json,cited_case_body,cited_case_year,evidence,
                    provenance,confidence,repairs_json,self_citation)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                    (
                        case_id, cited_case_id, page_number, source_region, int(occurrence.get("start", 0)),
                        int(occurrence.get("end", 0)), occurrence.get("text", ""),
                        occurrence.get("writtenCitation", ""), normalized_citation, resolution,
                        occurrence.get("citedCaseName"), int(occurrence.get("citedCaseVolume", 0)),
                        int(occurrence.get("citedCasePage", 0)),
                        json.dumps(occurrence.get("pinpoints", []), ensure_ascii=False),
                        occurrence.get("citedCaseBody"), occurrence.get("citedCaseYear"),
                        occurrence.get("evidence", ""), occurrence.get("provenance", "unknown"),
                        float(occurrence.get("confidence", 0)),
                        json.dumps(occurrence.get("repairs", []), ensure_ascii=False), int(is_self_citation),
                    ),
                )
                case_citations_count += 1
                resolved_case_citations_count += int(cited_case_id is not None)
                case_citation_export.append({
                    "citingCaseId": case_id, "citedCaseId": cited_case_id, "pageNumber": page_number,
                    "sourceRegion": source_region, "citationNormalized": normalized_citation,
                    "citationResolution": resolution, "selfCitation": is_self_citation, **occurrence,
                })
            for citation in region.get("citations", []):
                identity = (page_number, source_region, *_citation_identity(citation))
                if identity in seen_citations:
                    continue
                seen_citations.add(identity)
                connection.execute(
                    """INSERT INTO legal_citations
                    (case_id,page_number,source_region,written_text,family,target_kind,target_title,target_section,target_path_json,resolution,provenance,confidence,applicability,applicability_score,evidence,repairs_json,alternatives_json)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                    (
                        case_id, page_number, source_region, citation.get("text", ""), citation.get("family", "unknown"), citation.get("targetKind"),
                        str(citation.get("targetTitle", "")), str(citation.get("targetSection", "")), json.dumps(citation.get("targetPath", [])),
                        citation.get("resolution", "unresolved"), citation.get("provenance", "unknown"), float(citation.get("confidence", 0)),
                        citation.get("applicability", "discussed"), float(citation.get("applicabilityScore", 0)), citation.get("evidence"),
                        json.dumps(citation.get("repairs", [])), json.dumps(citation.get("alternatives", [])),
                    ),
                )
                citations_count += 1
                citation_export.append({"caseId": case_id, "pageNumber": page_number, **citation})
                target = _canonical_target(citation)
                if target:
                    target_kind, target_title, target_section, target_path = target
                    target_key = f"{target_kind}:{target_title}:{target_section}:{'/'.join(target_path)}"
                    aggregate = applicability.setdefault(target_key, {
                        "caseId": case_id, "canonicalTargetKey": target_key, "targetKind": target_kind,
                        "targetTitle": target_title, "targetSection": target_section, "targetPath": target_path,
                        "maxScore": 0.0, "occurrences": 0, "headnoteMentions": 0, "evidence": [],
                    })
                    aggregate["maxScore"] = max(aggregate["maxScore"], float(citation.get("applicabilityScore", 0)))
                    aggregate["occurrences"] += 1
                    aggregate["headnoteMentions"] += int(source_region == "publisher-headnote")
                    evidence = citation.get("evidence")
                    if evidence and evidence not in aggregate["evidence"] and len(aggregate["evidence"]) < 5:
                        aggregate["evidence"].append(evidence)
            for treatment in region.get("treatments", []):
                pending_treatments.append((case_id, page_number, source_region, treatment))
        for aggregate in applicability.values():
            aggregate["classification"] = "holding-candidate" if aggregate["maxScore"] >= 0.8 else "discussed"
            connection.execute(
                "INSERT INTO rule_applicability VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                (
                    case_id, aggregate["canonicalTargetKey"], aggregate["targetKind"], aggregate["targetTitle"], aggregate["targetSection"],
                    json.dumps(aggregate["targetPath"]), aggregate["maxScore"], aggregate["classification"], aggregate["occurrences"],
                    aggregate["headnoteMentions"], json.dumps(aggregate["evidence"], ensure_ascii=False),
                ),
            )
            applicability_export.append(aggregate)
            applicability_count += 1
    for affected_case in records:
        publisher_treatment = affected_case.get("publisherTreatment")
        if not publisher_treatment:
            continue
        treating_case = citation_to_record.get(
            str(publisher_treatment.get("treatingCaseCitation", "")).lower()
        )
        if not treating_case:
            continue
        pending_treatments.append((
            treating_case["corpusKey"],
            None,
            "publisher-catalog-note",
            {
                "citedCaseName": affected_case.get("caseName", ""),
                "citedCaseCitation": affected_case.get("officialCitation", ""),
                "treatment": publisher_treatment.get("treatment", ""),
                "evidence": publisher_treatment.get("evidence", ""),
                "relatedLegalTargets": [],
                "confidence": float(publisher_treatment.get("confidence", 1.0)),
            },
        ))

    seen_supporting_treatments: set[tuple] = set()
    for entry in supporting_chart:
        chart_case_id = entry.get("caseId")
        chart_case_citation = entry.get("officialCitation") or entry.get("writtenCitation", "")
        if not chart_case_id:
            continue
        for treatment in entry.get("analysis", {}).get("treatments", []):
            cited_case_id, normalized_citation, _resolution, _repairs = _resolve_treatment_case(
                treatment, citation_to_record, eoir_id_to_records
            )
            identity = (
                chart_case_id, cited_case_id, treatment.get("treatment"), treatment.get("evidence"),
                entry.get("sourceArtifactId"), "chart-headnote",
            )
            if identity in seen_supporting_treatments:
                continue
            seen_supporting_treatments.add(identity)
            connection.execute(
                """INSERT INTO supporting_treatments
                (treating_case_id,cited_case_id,treating_case_citation,cited_case_citation,treatment,scope,evidence_kind,source_artifact_id,evidence,source_tier,confidence)
                VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    chart_case_id, cited_case_id, chart_case_citation, normalized_citation,
                    treatment.get("treatment", ""), "unspecified", "chart-headnote", entry.get("sourceArtifactId", ""),
                    treatment.get("evidence", ""), "secondary-recall-evidence", min(0.85, float(treatment.get("confidence", 0))),
                ),
            )
            supporting_treatment_count += 1
        for treatment in entry.get("incomingHeadingTreatments", []):
            treating_record = citation_to_record.get(treatment.get("treatingCaseCitation", "").lower())
            treating_case_id = treating_record.get("corpusKey") if treating_record else None
            treating_citation = treating_record.get("officialCitation") if treating_record else treatment.get("treatingCaseCitation", "")
            identity = (
                treating_case_id, chart_case_id, treatment.get("treatment"), treatment.get("evidence"),
                entry.get("sourceArtifactId"), "chart-heading-annotation",
            )
            if identity in seen_supporting_treatments:
                continue
            seen_supporting_treatments.add(identity)
            connection.execute(
                """INSERT INTO supporting_treatments
                (treating_case_id,cited_case_id,treating_case_citation,cited_case_citation,treatment,scope,evidence_kind,source_artifact_id,evidence,source_tier,confidence)
                VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    treating_case_id, chart_case_id, treating_citation, chart_case_citation,
                    treatment.get("treatment", ""), treatment.get("scope", "unspecified"), "chart-heading-annotation",
                    entry.get("sourceArtifactId", ""), treatment.get("evidence", ""), "secondary-recall-evidence",
                    float(treatment.get("confidence", 0)),
                ),
            )
            supporting_treatment_count += 1
    for treating_case_id, page_number, source_region, treatment in pending_treatments:
        cited_case_id, normalized_citation, citation_resolution, citation_repairs = _resolve_treatment_case(
            treatment, citation_to_record, eoir_id_to_records
        )
        connection.execute(
            """INSERT INTO treatments
            (treating_case_id,cited_case_id,cited_case_name,cited_case_citation,cited_case_citation_normalized,citation_resolution,citation_repairs_json,treatment,page_number,source_region,evidence,scope_evidence,related_legal_targets_json,temporal_scope,temporal_evidence_json,decision_date,confidence)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                treating_case_id, cited_case_id, treatment["citedCaseName"], treatment["citedCaseCitation"], normalized_citation,
                citation_resolution, json.dumps(citation_repairs, ensure_ascii=False), treatment["treatment"], page_number,
                source_region, treatment["evidence"], treatment.get("scopeEvidence", treatment["evidence"]),
                json.dumps(treatment.get("relatedLegalTargets", [])),
                treatment.get("temporalApplication", {}).get("scope"),
                json.dumps(treatment.get("temporalApplication", {}).get("evidence", []), ensure_ascii=False),
                treatment.get("temporalApplication", {}).get("decisionDate", {}).get("iso"),
                float(treatment.get("confidence", 0)),
            ),
        )
        treatments_count += 1
    connection.commit()
    connection.execute("PRAGMA optimize")
    connection.close()
    temporary_path.replace(database_path)
    atomic_write(index_root / "legal-citations.jsonl", "".join(json.dumps(item, ensure_ascii=False, sort_keys=True) + "\n" for item in citation_export).encode("utf-8"))
    atomic_write(index_root / "case-citations.jsonl", "".join(json.dumps(item, ensure_ascii=False, sort_keys=True) + "\n" for item in case_citation_export).encode("utf-8"))
    atomic_write(index_root / "rule-applicability.jsonl", "".join(json.dumps(item, ensure_ascii=False, sort_keys=True) + "\n" for item in applicability_export).encode("utf-8"))
    summary = {
        "schemaVersion": 2,
        "database": database_path.as_posix(),
        "cases": len(records),
        "fullTextCases": len(document_by_id),
        "metadataOnlyCases": len(records) - len(document_by_id),
        "pages": sum(len(document["pages"]) for document in documents),
        "citations": citations_count,
        "caseCitationOccurrences": case_citations_count,
        "resolvedCaseCitationOccurrences": resolved_case_citations_count,
        "ruleApplicabilityLinks": applicability_count,
        "treatments": treatments_count,
        "supportingTopicLinks": supporting_topic_count,
        "officialTopicalLinks": reporter_topical_count,
        "supportingTreatments": supporting_treatment_count,
        "reporterAffectedDecisionEdges": reporter_affected_count,
        "pagesNeedingOcr": sum(len(document["extraction"]["pagesNeedingOcr"]) for document in documents),
    }
    atomic_write(index_root / "build-summary.json", (json.dumps(summary, indent=2) + "\n").encode("utf-8"))
    return summary


def status_report(database_path: Path, citation: str) -> dict:
    connection = sqlite3.connect(database_path)
    connection.row_factory = sqlite3.Row
    case = connection.execute("SELECT * FROM cases WHERE lower(official_citation)=lower(?) OR case_id=?", (citation, citation)).fetchone()
    if not case:
        raise RuntimeError(f"Case not found: {citation}")
    incoming = [dict(row) for row in connection.execute(
        """SELECT t.*, c.case_name AS treating_case_name, c.official_citation AS treating_case_citation, c.decision_year AS treating_case_year
        FROM treatments t JOIN cases c ON c.case_id=t.treating_case_id WHERE t.cited_case_id=? ORDER BY c.decision_year DESC, t.id DESC""",
        (case["case_id"],),
    )]
    outgoing = [dict(row) for row in connection.execute(
        """SELECT t.*, c.case_name AS cited_resolved_case_name, c.official_citation AS cited_resolved_case_citation
        FROM treatments t LEFT JOIN cases c ON c.case_id=t.cited_case_id WHERE t.treating_case_id=? ORDER BY t.id""",
        (case["case_id"],),
    )]
    incoming_case_citations = [dict(row) for row in connection.execute(
        """SELECT cc.*, c.case_name AS citing_case_name, c.official_citation AS citing_case_citation,
        c.decision_year AS citing_case_year
        FROM case_citations cc JOIN cases c ON c.case_id=cc.citing_case_id
        WHERE cc.cited_case_id=? ORDER BY c.decision_year DESC, cc.page_number, cc.start_offset, cc.id""",
        (case["case_id"],),
    )]
    outgoing_case_citations = [dict(row) for row in connection.execute(
        """SELECT cc.*, c.case_name AS cited_resolved_case_name,
        c.official_citation AS cited_resolved_case_citation
        FROM case_citations cc LEFT JOIN cases c ON c.case_id=cc.cited_case_id
        WHERE cc.citing_case_id=? ORDER BY cc.page_number, cc.start_offset, cc.id""",
        (case["case_id"],),
    )]
    applicability = [dict(row) for row in connection.execute(
        "SELECT * FROM rule_applicability WHERE case_id=? ORDER BY max_score DESC, canonical_target_key",
        (case["case_id"],),
    )]
    supporting_topics = [dict(row) for row in connection.execute(
        "SELECT * FROM supporting_topics WHERE case_id=? ORDER BY primary_topic, subtopic, id",
        (case["case_id"],),
    )]
    supporting_incoming = [dict(row) for row in connection.execute(
        "SELECT * FROM supporting_treatments WHERE cited_case_id=? ORDER BY id",
        (case["case_id"],),
    )]
    supporting_outgoing = [dict(row) for row in connection.execute(
        "SELECT * FROM supporting_treatments WHERE treating_case_id=? ORDER BY id",
        (case["case_id"],),
    )]
    reporter_incoming = [dict(row) for row in connection.execute(
        """SELECT r.*, c.case_name AS treating_case_name, c.decision_year AS treating_case_year
        FROM reporter_affected_decisions r LEFT JOIN cases c ON c.case_id=r.treating_case_id
        WHERE r.affected_case_id=? ORDER BY c.decision_year DESC, r.source_page, r.source_line, r.id""",
        (case["case_id"],),
    )]
    reporter_outgoing = [dict(row) for row in connection.execute(
        """SELECT r.*, c.case_name AS affected_case_name
        FROM reporter_affected_decisions r LEFT JOIN cases c ON c.case_id=r.affected_case_id
        WHERE r.treating_case_id=? ORDER BY r.source_page, r.source_line, r.id""",
        (case["case_id"],),
    )]
    connection.close()
    for treatment in [*incoming, *outgoing]:
        treatment["related_legal_targets"] = json.loads(treatment.pop("related_legal_targets_json"))
        treatment["temporal_evidence"] = json.loads(treatment.pop("temporal_evidence_json"))
        treatment["citation_repairs"] = json.loads(treatment.pop("citation_repairs_json"))
    for occurrence in [*incoming_case_citations, *outgoing_case_citations]:
        occurrence["pinpoints"] = json.loads(occurrence.pop("pinpoints_json"))
        occurrence["repairs"] = json.loads(occurrence.pop("repairs_json"))
    for item in applicability:
        item["target_path"] = json.loads(item.pop("target_path_json"))
        item["evidence"] = json.loads(item.pop("evidence_json"))
    for item in [*reporter_incoming, *reporter_outgoing]:
        item["repairs"] = json.loads(item.pop("repairs_json"))
    negative = {"overruled", "overruled-in-part", "vacated", "withdrawn", "superseded", "abrogated", "reversed", "disapproved", "not-followed", "limited", "modified"}
    negative_signals = [item for item in incoming if item["treatment"] in negative]
    direct_negative_signals = [item for item in negative_signals if item.get("source_region") != "publisher-catalog-note"]
    catalog_negative_signals = [item for item in negative_signals if item.get("source_region") == "publisher-catalog-note"]
    supporting_negative_signals = [item for item in supporting_incoming if item["treatment"] in negative]
    reporter_negative_signals = [item for item in reporter_incoming if item["treatment"] in negative]
    publisher_negative = case["source_status"] in {"overruled", "superseded", "withdrawn", "vacated"}
    publisher_qualified = case["source_status"] in {"overruled-in-part", "modified", "limited"}

    def treatment_conclusions(rows: list[dict], supporting: bool = False) -> list[dict]:
        grouped: dict[tuple, dict] = {}
        for item in rows:
            identity = (
                item.get("treating_case_id"), item.get("cited_case_id"), item.get("treatment"),
                item.get("temporal_scope") if not supporting else item.get("scope"),
            )
            conclusion = grouped.setdefault(identity, {
                "treatingCaseId": item.get("treating_case_id"),
                "treatingCaseCitation": item.get("treating_case_citation"),
                "citedCaseId": item.get("cited_case_id"),
                "citedCaseCitation": item.get("cited_case_citation_normalized") or item.get("cited_case_citation"),
                "treatment": item.get("treatment"),
                "scope": item.get("scope") if supporting else item.get("temporal_scope"),
                "evidence": [],
                "sourceTier": "secondary-recall-evidence" if supporting else None,
                "sourceTiers": ["secondary-recall-evidence"] if supporting else [],
            })
            evidence = {
                "evidence": item.get("evidence"),
                "confidence": item.get("confidence"),
            }
            if supporting:
                evidence.update({
                    "evidenceKind": item.get("evidence_kind"),
                    "sourceArtifactId": item.get("source_artifact_id"),
                })
            else:
                evidence.update({
                    "sourceRegion": item.get("source_region"),
                    "pageNumber": item.get("page_number"),
                })
                source_tier = (
                    "official-publisher-catalog-status"
                    if item.get("source_region") == "publisher-catalog-note"
                    else "opinion-or-publisher-headnote"
                )
                if source_tier not in conclusion["sourceTiers"]:
                    conclusion["sourceTiers"].append(source_tier)
            if evidence not in conclusion["evidence"]:
                conclusion["evidence"].append(evidence)
        results = list(grouped.values())
        for conclusion in results:
            if not supporting:
                conclusion["sourceTier"] = (
                    conclusion["sourceTiers"][0]
                    if len(conclusion["sourceTiers"]) == 1
                    else "multiple-primary-evidence-tiers"
                )
        return results

    def reporter_conclusions(rows: list[dict]) -> list[dict]:
        grouped: dict[tuple, dict] = {}
        for item in rows:
            identity = (
                item.get("treating_case_id"), item.get("affected_case_id"), item.get("treatment"),
                item.get("affected_pinpoint"), item.get("treating_pinpoint"),
            )
            conclusion = grouped.setdefault(identity, {
                "treatingCaseId": item.get("treating_case_id"),
                "treatingCaseCitation": item.get("treating_case_citation"),
                "treatingPinpoint": item.get("treating_pinpoint"),
                "affectedCaseId": item.get("affected_case_id"),
                "affectedCaseCitation": item.get("affected_case_citation"),
                "affectedPinpoint": item.get("affected_pinpoint"),
                "treatmentCode": item.get("treatment_code"),
                "treatment": item.get("treatment"),
                "scope": "requires-treating-opinion-review",
                "sourceTier": "official-reporter-editorial-treatment-index",
                "evidence": [],
            })
            evidence = {
                "sourceArtifactId": item.get("source_artifact_id"),
                "sourcePage": item.get("source_page"),
                "sourceLine": item.get("source_line"),
                "evidence": item.get("evidence"),
                "confidence": item.get("confidence"),
            }
            if evidence not in conclusion["evidence"]:
                conclusion["evidence"].append(evidence)
        return list(grouped.values())

    return {
        "case": dict(case),
        "incomingTreatments": incoming,
        "incomingTreatmentConclusions": treatment_conclusions(incoming),
        "outgoingTreatments": outgoing,
        "incomingCaseCitations": incoming_case_citations,
        "outgoingCaseCitations": outgoing_case_citations,
        "ruleApplicability": applicability,
        "supportingTopics": supporting_topics,
        "supportingIncomingTreatments": supporting_incoming,
        "supportingIncomingTreatmentConclusions": treatment_conclusions(supporting_incoming, supporting=True),
        "supportingOutgoingTreatments": supporting_outgoing,
        "reporterAffectedIncoming": reporter_incoming,
        "reporterAffectedIncomingConclusions": reporter_conclusions(reporter_incoming),
        "reporterAffectedOutgoing": reporter_outgoing,
        "coverage": "full-text" if case["page_count"] else "official-metadata-and-headnotes-only",
        "statusSignal": (
            "explicit-negative-treatment-found" if direct_negative_signals
            else "publisher-catalog-negative-treatment-found" if catalog_negative_signals
            else "publisher-negative-status" if publisher_negative
            else "publisher-qualified-status-needs-scope-review" if publisher_qualified
            else "official-reporter-negative-treatment-found-needs-scope-review" if reporter_negative_signals
            else "supporting-negative-treatment-found-needs-opinion-verification" if supporting_negative_signals
            else "no-explicit-negative-treatment-found"
        ),
        "warning": "Treatment is issue-, date-, and jurisdiction-specific. The official affected-decisions table ends at volume 25 and its codes require review of the cited page and treating opinion; it does not capture later statutory or regulatory displacement. Supporting chart evidence is expressly noncomprehensive. This report is evidence, not a single validity signal.",
    }
