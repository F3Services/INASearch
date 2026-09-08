"""Parse first-party supporting indexes without confusing them with opinions."""

from __future__ import annotations

import bisect
import hashlib
import json
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

from .documents import _pdf_reader, analyze_blocks, atomic_write
from .sources import Node, clean_text, parse_html


CHART_CASE = re.compile(
    r"^(?P<name>Matter\s*of\s+.+?),\s*(?P<volume>\d{1,2})\s*I\s*&\s*N"
    r"(?:\s*Dec\.?)?\s*(?P<page>\d{1,4})(?:\s*\((?P<history>[^)]*?\d{4})\))?",
    re.IGNORECASE,
)
INCOMING_CHART_TREATMENT = re.compile(
    r"(?P<treatment>overruled|superseded|superceded|modified|vacated|withdrawn)"
    r"(?:\s+in\s+part)?(?:\s+by|\s*,)?\s*"
    r"(?P<name>Matter\s*of\s+.+?),\s*(?P<volume>\d{1,2})\s*I\s*&\s*N"
    r"(?:\s*Dec\.?)?\s*(?P<page>\d{1,4})(?:\s*\((?P<history>[^)]*?\d{4})\))?",
    re.IGNORECASE,
)

AFFECTED_DECISION_CODES = {
    "c": "clarified",
    "d": "distinguished",
    "e": "explained",
    "f": "followed",
    "g": "generally-cited",
    "j": "followed-in-jurisdiction-only",
    "m": "modified",
    "n": "not-followed",
    "o": "overruled",
    "r": "reaffirmed",
    "s": "superseded",
    "v": "vacated",
}
AFFECTED_ENTRY_START = re.compile(
    rf"^\s*(?P<code>[{''.join(AFFECTED_DECISION_CODES)}])\s+(?P<body>\d.*)$"
)
AFFECTED_SEE = re.compile(r"\bSee\s+(?P<targets>.+?)\s*$")
AFFECTED_PINPOINT = re.compile(r"(?P<volume>[0-9lI]{1,2})[–-](?P<page>\d{1,4})")
AFFECTED_SOURCE_PINPOINT = re.compile(r"^(?P<volume>\d{1,2})[–-](?P<page>\d{1,4})\b")
EXTERNAL_AUTHORITY = re.compile(
    r"^(?P<citation>\d+\s+(?:F\.\s*Supp\.?\s*(?:2d|3d)?|F\.(?:2d|3d)?|F\.|U\.S\.|"
    r"S\.\s*Ct\.|A\.2d|N\.W\.\s*(?:2d)?|P\.(?:2d|3d))\s+\d+)",
    re.IGNORECASE,
)
INDEX_CASE_ID = re.compile(r"\b(?:2[5-9]\d{2}|3\d{3})\b")
INDEX_HEADER_FRAGMENTS = (
    "Index  to Prece", "Index to Prece", "Interim Decisio", "This index covers",
    "previous index", "Volumes 1 through", "Volume 25for", "27. See Volume",
)

TOPICAL_INDEX_OCR_CONTRACT_ID = "eoir-topical-index-vol1-15-ocr-v1"
TOPICAL_INDEX_OCR_OUTPUT_ROOT = Path(
    "supporting/derived/topical-index-ocr-queue-v1"
)
TOPICAL_INDEX_IMAGE_ARTIFACTS = {
    "eoir-index-vol1-15-a-e",
    "eoir-index-vol1-15-f-z",
}


def _case_name_key(value: str) -> str:
    value = re.sub(r"^Matter\s*of\s+", "", str(value), flags=re.IGNORECASE)
    return "".join(character for character in value.upper() if character.isalnum())


def _contains_strong(node: Node) -> bool:
    return any(True for _item in node.descendants("strong"))


def _body_blocks(value: bytes) -> list[Node]:
    root = parse_html(value)
    body = next(
        (
            node for node in root.descendants("div")
            if "field_body" in node.attrs.get("class", "").split()
        ),
        None,
    )
    if body is None:
        raise RuntimeError("BIA Precedent Chart page has no field_body content")
    blocks: list[Node] = []

    def visit(node: Node) -> None:
        for child in node.children:
            if not isinstance(child, Node):
                continue
            if child.tag in {"h2", "h3", "h4", "p"}:
                blocks.append(child)
            else:
                visit(child)

    visit(body)
    return blocks


def _parse_chart_case_heading(text: str) -> dict | None:
    match = CHART_CASE.match(text)
    if not match:
        return None
    history = clean_text(match.group("history") or "")
    year_match = re.search(r"(\d{4})\s*$", history)
    body = clean_text(history[:year_match.start()] if year_match else history).strip(" ;,")
    return {
        "caseNameWritten": clean_text(match.group("name")),
        "writtenCitation": f"{int(match.group('volume'))} I&N Dec. {int(match.group('page'))}",
        "volumeWritten": int(match.group("volume")),
        "reporterPageWritten": int(match.group("page")),
        "decidingBodyWritten": body or None,
        "decisionYearWritten": int(year_match.group(1)) if year_match else None,
        "headingText": text,
    }


def _incoming_heading_treatments(entry: dict) -> list[dict]:
    output = []
    source_citation = entry["writtenCitation"]
    for match in INCOMING_CHART_TREATMENT.finditer(entry["headingText"]):
        written = match.group("treatment").lower()
        treatment = "superseded" if written == "superceded" else written
        output.append({
            "treatingCaseName": clean_text(match.group("name")),
            "treatingCaseCitation": f"{int(match.group('volume'))} I&N Dec. {int(match.group('page'))}",
            "citedCaseCitation": source_citation,
            "treatment": treatment,
            "scope": "partial" if re.search(r"in\s+part", match.group(0), re.IGNORECASE) else "unspecified",
            "evidence": entry["headingText"],
            "provenance": "first-party-informational-chart-heading",
            "confidence": 0.85,
        })
    return output


def parse_precedent_chart_section(value: bytes, source_artifact_id: str) -> list[dict]:
    """Return every chart occurrence with its topic path and headnote text."""
    entries: list[dict] = []
    current: dict | None = None
    primary_topic: str | None = None
    subtopic: str | None = None

    def flush() -> None:
        nonlocal current
        if current is None:
            return
        current["incomingHeadingTreatments"] = _incoming_heading_treatments(current)
        entries.append(current)
        current = None

    for node in _body_blocks(value):
        text = node.text()
        if not text:
            continue
        if node.tag in {"h2", "h3", "h4"}:
            flush()
            primary_topic = text
            subtopic = None
            continue
        classes = set(node.attrs.get("class", "").split())
        # Chart headnotes sometimes begin with a cited ``Matter of`` case.
        # Actual entry headings are bold (occasionally nested in an unclassed
        # Indent1 div); do not promote ordinary rteindent prose to a case.
        heading = _parse_chart_case_heading(text) if "Indent1" in classes or _contains_strong(node) else None
        if heading:
            flush()
            current = {
                "schemaVersion": 1,
                "sourceArtifactId": source_artifact_id,
                "primaryTopic": primary_topic,
                "subtopic": subtopic,
                **heading,
                "headnotes": [],
            }
            continue
        likely_headnote = bool(classes & {"rteindent1", "rteindent2", "Indent2", "indent2"})
        if current is not None and (likely_headnote or not _contains_strong(node)):
            current["headnotes"].append(text)
            continue
        if _contains_strong(node) and len(text) <= 240:
            flush()
            subtopic = text
            continue
        if current is not None:
            current["headnotes"].append(text)
    flush()
    return entries


def resolve_chart_entries(entries: list[dict], records: list[dict]) -> list[dict]:
    citation_map = {record.get("officialCitation", "").lower(): record for record in records}
    name_map: dict[str, list[dict]] = {}
    for record in records:
        name_map.setdefault(_case_name_key(record.get("caseName", "")), []).append(record)
    output = []
    for entry in entries:
        exact = citation_map.get(entry["writtenCitation"].lower())
        repairs: list[dict] = []
        method = "exact-official-citation"
        confidence = 1.0
        resolved = exact
        if resolved is None:
            candidates = [
                record for record in name_map.get(_case_name_key(entry["caseNameWritten"]), [])
                if record.get("volume") == entry["volumeWritten"]
            ]
            if entry.get("decisionYearWritten"):
                same_year = [record for record in candidates if record.get("decisionYear") == entry["decisionYearWritten"]]
                if same_year:
                    candidates = same_year
            if len(candidates) == 1:
                resolved = candidates[0]
                method = "normalized-case-name-volume-year"
                confidence = 0.82
                if entry["writtenCitation"] != resolved.get("officialCitation"):
                    repairs.append({
                        "component": "officialCitation",
                        "from": entry["writtenCitation"],
                        "to": resolved.get("officialCitation"),
                        "reason": "unique manifest case name, volume, and decision year",
                    })
            else:
                method = "unresolved"
                confidence = 0.0
        output.append({
            **entry,
            "caseId": resolved.get("corpusKey") if resolved else None,
            "officialCitation": resolved.get("officialCitation") if resolved else None,
            "resolution": method,
            "resolutionConfidence": confidence,
            "resolutionRepairs": repairs,
        })
    return output


def build_precedent_chart(repo_root: Path, case_root: Path, records: list[dict]) -> dict:
    manifest_path = case_root / "supporting" / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    artifacts = [
        artifact for artifact in manifest.get("artifacts", [])
        if artifact.get("role") == "first-party-informational-chart-section"
    ]
    entries: list[dict] = []
    source_hashes = []
    for artifact in artifacts:
        path = Path(artifact["localPath"])
        path = path if path.is_absolute() else case_root / path
        value = path.read_bytes()
        value_hash = hashlib.sha256(value).hexdigest()
        if value_hash != artifact["sha256"]:
            raise RuntimeError(f"Supporting chart checksum mismatch for {artifact['id']}")
        parsed = parse_precedent_chart_section(value, artifact["id"])
        entries.extend(parsed)
        source_hashes.append({"id": artifact["id"], "sha256": value_hash, "entries": len(parsed)})

    resolved = resolve_chart_entries(entries, records)
    for offset in range(0, len(resolved), 200):
        batch = resolved[offset:offset + 200]
        blocks = [{
            "id": str(index),
            "text": "\n".join(entry["headnotes"]),
            "isHeadnote": True,
        } for index, entry in enumerate(batch)]
        analyzed = analyze_blocks(repo_root, f"bia-precedent-chart-{offset // 200 + 1}", blocks)
        for index, entry in enumerate(batch):
            entry["analysis"] = analyzed[str(index)]

    output_root = case_root / "supporting" / "derived"
    output_path = output_root / "bia-precedent-chart.jsonl"
    atomic_write(
        output_path,
        "".join(json.dumps(entry, ensure_ascii=False, sort_keys=True) + "\n" for entry in resolved).encode("utf-8"),
    )
    unresolved = [entry for entry in resolved if not entry["caseId"]]
    topic_links = {
        (entry["caseId"], entry.get("primaryTopic"), entry.get("subtopic"))
        for entry in resolved if entry["caseId"]
    }
    explicit_treatments = sum(len(entry["analysis"].get("treatments", [])) for entry in resolved)
    incoming_treatments = sum(len(entry["incomingHeadingTreatments"]) for entry in resolved)
    summary = {
        "schemaVersion": 1,
        "sourceTier": "secondary-recall-evidence",
        "publisherDisclaimerApplies": True,
        "sources": source_hashes,
        "occurrences": len(resolved),
        "resolvedOccurrences": len(resolved) - len(unresolved),
        "unresolvedOccurrences": len(unresolved),
        "uniqueResolvedCases": len({entry["caseId"] for entry in resolved if entry["caseId"]}),
        "topicLinks": len(topic_links),
        "explicitHeadnoteTreatments": explicit_treatments,
        "incomingHeadingTreatments": incoming_treatments,
        "outputSha256": hashlib.sha256(output_path.read_bytes()).hexdigest(),
        "unresolvedExamples": [{
            "sourceArtifactId": entry["sourceArtifactId"],
            "headingText": entry["headingText"],
            "writtenCitation": entry["writtenCitation"],
        } for entry in unresolved[:25]],
    }
    atomic_write(
        case_root / "supporting" / "chart-summary.json",
        (json.dumps(summary, indent=2, ensure_ascii=False) + "\n").encode("utf-8"),
    )
    return summary


def parse_affected_decisions_pages(pages: list[str], source_artifact_id: str) -> list[dict]:
    """Parse the formal reporter table without discarding printed anomalies.

    The left-hand authority and each ``See`` reference can be a pinpoint page,
    rather than the first page of an I&N decision. Resolution therefore happens
    in a separate range-aware pass. Native extraction has one known ``l9`` OCR
    error; it is repaired only in a ``See`` pinpoint and the repair is recorded.
    """
    rows: list[dict] = []
    for page_number, page_text in enumerate(pages, start=1):
        current: dict | None = None

        def flush() -> None:
            nonlocal current
            if current is None:
                return
            evidence = " ".join(current["parts"])
            see = AFFECTED_SEE.search(evidence)
            if not see:
                raise RuntimeError(
                    f"Affected-decisions entry has no See reference on PDF page {page_number}, "
                    f"line {current['sourceLine']}: {evidence}"
                )
            affected_text = evidence[:see.start()].strip()
            pinpoints: list[dict] = []
            seen: set[tuple[int, int]] = set()
            for match in AFFECTED_PINPOINT.finditer(see.group("targets")):
                written_volume = match.group("volume")
                normalized_volume = written_volume.replace("l", "1").replace("I", "1")
                identity = (int(normalized_volume), int(match.group("page")))
                if identity in seen:
                    continue
                seen.add(identity)
                repairs = []
                if written_volume != normalized_volume:
                    repairs.append({
                        "component": "treatingReporterVolume",
                        "from": written_volume,
                        "to": normalized_volume,
                        "reason": "validated OCR-confusable character inside an I&N reporter pinpoint",
                    })
                pinpoints.append({
                    "written": match.group(0),
                    "volume": identity[0],
                    "page": identity[1],
                    "normalizedPinpoint": f"{identity[0]} I&N Dec. {identity[1]}",
                    "repairs": repairs,
                })
            if not pinpoints:
                raise RuntimeError(
                    f"Affected-decisions entry has no parseable I&N target on PDF page {page_number}: {evidence}"
                )
            source_pinpoint = AFFECTED_SOURCE_PINPOINT.match(affected_text)
            external = EXTERNAL_AUTHORITY.match(affected_text)
            rows.append({
                "schemaVersion": 1,
                "sourceArtifactId": source_artifact_id,
                "sourcePage": page_number,
                "sourceLine": current["sourceLine"],
                "code": current["code"],
                "treatment": AFFECTED_DECISION_CODES[current["code"]],
                "affectedAuthorityText": affected_text,
                "affectedAuthorityKind": "i-and-n" if source_pinpoint else "judicial-or-other",
                "affectedAuthorityCitation": (
                    f"{int(source_pinpoint.group('volume'))} I&N Dec. {int(source_pinpoint.group('page'))}"
                    if source_pinpoint else external.group("citation") if external else affected_text
                ),
                "affectedPinpoint": ({
                    "written": source_pinpoint.group(0),
                    "volume": int(source_pinpoint.group("volume")),
                    "page": int(source_pinpoint.group("page")),
                    "normalizedPinpoint": (
                        f"{int(source_pinpoint.group('volume'))} I&N Dec. {int(source_pinpoint.group('page'))}"
                    ),
                } if source_pinpoint else None),
                "treatingPinpoints": pinpoints,
                "evidence": evidence,
                "sourceTier": "official-reporter-editorial-treatment-index",
                "confidence": 1.0,
            })
            current = None

        for source_line, line in enumerate(page_text.splitlines(), start=1):
            match = AFFECTED_ENTRY_START.match(line)
            if match:
                flush()
                current = {
                    "code": match.group("code"),
                    "sourceLine": source_line,
                    "parts": [match.group("body").strip()],
                }
                continue
            stripped = line.strip()
            if current is not None and stripped and not re.fullmatch(r"[IVXLCDM]+", stripped):
                current["parts"].append(stripped)
        flush()
    return rows


def _reporter_ranges(records: list[dict]) -> dict[int, list[dict]]:
    ranges: dict[int, list[dict]] = {}
    for record in records:
        volume = record.get("volume")
        page = record.get("reporterPage")
        if isinstance(volume, int) and isinstance(page, int):
            ranges.setdefault(volume, []).append(record)
    for volume in ranges:
        ranges[volume].sort(key=lambda record: record["reporterPage"])
    return ranges


def _resolve_reporter_pinpoint(pinpoint: dict, ranges: dict[int, list[dict]]) -> dict:
    candidates = ranges.get(pinpoint["volume"], [])
    starts = [record["reporterPage"] for record in candidates]
    offset = bisect.bisect_right(starts, pinpoint["page"]) - 1
    if offset < 0:
        return {**pinpoint, "caseId": None, "officialCitation": None, "resolution": "unresolved"}
    record = candidates[offset]
    next_start = candidates[offset + 1]["reporterPage"] if offset + 1 < len(candidates) else None
    # The last decision in a volume has no following start-page boundary. A
    # generous ceiling prevents a publisher/extraction typo such as 21-3371
    # from being assigned to the decision beginning at 21 I&N Dec. 1199.
    if next_start is None and pinpoint["page"] - record["reporterPage"] > 200:
        return {**pinpoint, "caseId": None, "officialCitation": None, "resolution": "unresolved-out-of-range"}
    return {
        **pinpoint,
        "caseId": record["corpusKey"],
        "officialCitation": record["officialCitation"],
        "resolution": (
            "exact-official-citation" if pinpoint["page"] == record["reporterPage"]
            else "reporter-pinpoint-range"
        ),
    }


def resolve_affected_decisions(rows: list[dict], records: list[dict]) -> list[dict]:
    ranges = _reporter_ranges(records)
    output: list[dict] = []
    for row in rows:
        affected_pinpoint = row.get("affectedPinpoint")
        affected_resolution = (
            _resolve_reporter_pinpoint(affected_pinpoint, ranges) if affected_pinpoint else None
        )
        treating = [_resolve_reporter_pinpoint(pinpoint, ranges) for pinpoint in row["treatingPinpoints"]]
        output.append({
            **row,
            "affectedCaseId": affected_resolution.get("caseId") if affected_resolution else None,
            "affectedCaseCitation": affected_resolution.get("officialCitation") if affected_resolution else None,
            "affectedResolution": affected_resolution.get("resolution") if affected_resolution else "external-authority",
            "treatingPinpoints": treating,
        })
    return output


def build_affected_decisions(case_root: Path, records: list[dict]) -> dict:
    manifest = json.loads((case_root / "supporting" / "manifest.json").read_text(encoding="utf-8"))
    artifacts = [
        artifact for artifact in manifest.get("artifacts", [])
        if artifact.get("role") == "official-reporter-affected-decisions-table"
    ]
    rows: list[dict] = []
    source_hashes = []
    for artifact in artifacts:
        path = Path(artifact["localPath"])
        path = path if path.is_absolute() else case_root / path
        value = path.read_bytes()
        value_hash = hashlib.sha256(value).hexdigest()
        if value_hash != artifact["sha256"]:
            raise RuntimeError(f"Affected-decisions checksum mismatch for {artifact['id']}")
        reader = _pdf_reader(path)
        pages = []
        for page in reader.pages:
            try:
                pages.append(page.extract_text(extraction_mode="layout") or "")
            except TypeError:
                pages.append(page.extract_text() or "")
        parsed = parse_affected_decisions_pages(pages, artifact["id"])
        rows.extend(parsed)
        source_hashes.append({"id": artifact["id"], "sha256": value_hash, "pages": len(pages), "rows": len(parsed)})

    resolved = resolve_affected_decisions(rows, records)
    output_path = case_root / "supporting" / "derived" / "eoir-affected-decisions.jsonl"
    atomic_write(
        output_path,
        "".join(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n" for row in resolved).encode("utf-8"),
    )
    edges = [
        (row, pinpoint) for row in resolved for pinpoint in row["treatingPinpoints"]
    ]
    code_counts = {
        code: sum(row["code"] == code for row in resolved)
        for code in AFFECTED_DECISION_CODES
    }
    summary = {
        "schemaVersion": 1,
        "sourceTier": "official-reporter-editorial-treatment-index",
        "coverageCutoff": "Reporter volume 25; revised May 23, 2014",
        "sources": source_hashes,
        "rows": len(resolved),
        "expandedEdges": len(edges),
        "codeCounts": code_counts,
        "affectedInCasesResolved": sum(bool(row.get("affectedCaseId")) for row in resolved),
        "affectedExternalOrUnresolved": sum(not row.get("affectedCaseId") for row in resolved),
        "treatingPinpointsResolved": sum(bool(pinpoint.get("caseId")) for _row, pinpoint in edges),
        "treatingPinpointsUnresolved": sum(not pinpoint.get("caseId") for _row, pinpoint in edges),
        "outputSha256": hashlib.sha256(output_path.read_bytes()).hexdigest(),
        "limitations": [
            "The table stops at reporter volume 25 and directs readers to the volume 15 cumulative table for volumes 1-15.",
            "A code characterizes treatment at a cited reporter page; the affected proposition and scope must be verified in the treating opinion.",
            "The table does not identify displacement caused solely by later statutes, regulations, or policy changes.",
        ],
    }
    atomic_write(
        case_root / "supporting" / "affected-decisions-summary.json",
        (json.dumps(summary, indent=2, ensure_ascii=False) + "\n").encode("utf-8"),
    )
    return summary


def _looks_index_heading(text: str) -> bool:
    if re.fullmatch(r"[A-Z]", text):
        return False
    before_colon = text.split(":", 1)[0]
    letters = [character for character in before_colon if character.isalpha()]
    return bool(
        len(letters) >= 4
        and sum(character.isupper() for character in letters) / len(letters) >= 0.88
    )


def _join_wrapped_text(value: str) -> str:
    value = re.sub(r"(?<=\w)-\s+(?=\w)", "", value)
    return clean_text(value)


def parse_topical_index_columns(columns: list[dict], source_artifact_id: str) -> list[dict]:
    """Parse two-column EOIR topical indexes into ID-bearing subject entries."""
    output: list[dict] = []
    primary_topic: str | None = None
    pending_heading: str | None = None

    for column in columns:
        physical_lines = []
        for source_line, line in enumerate(column["text"].splitlines(), start=1):
            stripped = line.strip()
            if (
                not stripped
                or re.fullmatch(r"\d{1,3}", stripped)
                or any(fragment in stripped for fragment in INDEX_HEADER_FRAGMENTS)
            ):
                continue
            physical_lines.append({
                "indent": len(line) - len(line.lstrip()),
                "text": stripped,
                "sourceLine": source_line,
            })
        if not physical_lines:
            continue
        base_indent = min(
            line["indent"] for line in physical_lines
            if not re.fullmatch(r"[A-Z]", line["text"])
        )
        current: dict | None = None

        def flush() -> None:
            nonlocal current
            if current is None:
                return
            evidence = " ".join(current["parts"])
            if "#" not in evidence:
                current = None
                return
            post_hash = evidence[evidence.find("#"):]
            eoir_ids = []
            for match in INDEX_CASE_ID.finditer(post_hash):
                eoir_id = int(match.group(0))
                if eoir_id not in eoir_ids:
                    eoir_ids.append(eoir_id)
            if eoir_ids:
                entry_text = re.sub(r"#\s*(?:\d{4}\s*,?\s*)+", "", evidence).strip(" ,;")
                output.append({
                    "schemaVersion": 1,
                    "sourceArtifactId": source_artifact_id,
                    "sourcePage": column["sourcePage"],
                    "sourceColumn": column["sourceColumn"],
                    "sourceLine": current["sourceLine"],
                    "primaryTopicWritten": primary_topic,
                    "primaryTopic": _join_wrapped_text(primary_topic or "UNCLASSIFIED"),
                    "entryTextWritten": entry_text,
                    "entryText": _join_wrapped_text(entry_text),
                    "eoirIds": eoir_ids,
                    "evidence": evidence,
                    "sourceTier": "official-reporter-topical-index",
                    "confidence": 1.0,
                })
            current = None

        for line in physical_lines:
            relative_indent = line["indent"] - base_indent
            is_heading = (
                relative_indent <= 2
                and "#" not in line["text"]
                and _looks_index_heading(line["text"])
            )
            if is_heading:
                flush()
                if pending_heading and pending_heading.endswith("-"):
                    primary_topic = pending_heading[:-1] + line["text"]
                elif pending_heading and ":" not in pending_heading:
                    primary_topic = f"{pending_heading} {line['text']}"
                else:
                    primary_topic = line["text"]
                pending_heading = primary_topic if ":" not in primary_topic else None
                continue
            pending_heading = None
            if current is None:
                current = {
                    "indent": line["indent"],
                    "sourceLine": line["sourceLine"],
                    "parts": [line["text"]],
                }
                continue
            has_reference = "#" in " ".join(current["parts"])
            numeric_continuation = bool(re.fullmatch(
                r"\d{4}(?:\s*,\s*\d{4})*\s*,?", line["text"]
            ))
            if has_reference and not numeric_continuation:
                flush()
                current = {
                    "indent": line["indent"],
                    "sourceLine": line["sourceLine"],
                    "parts": [line["text"]],
                }
            elif not has_reference and line["indent"] <= current["indent"]:
                flush()
                current = {
                    "indent": line["indent"],
                    "sourceLine": line["sourceLine"],
                    "parts": [line["text"]],
                }
            else:
                current["parts"].append(line["text"])
        flush()
    return output


def resolve_topical_index(entries: list[dict], records: list[dict]) -> list[dict]:
    by_eoir_id = {
        record["eoirId"]: record for record in records
        if isinstance(record.get("eoirId"), int)
    }
    output = []
    for entry in entries:
        for eoir_id in entry["eoirIds"]:
            record = by_eoir_id.get(eoir_id)
            output.append({
                **entry,
                "eoirId": eoir_id,
                "caseId": record.get("corpusKey") if record else None,
                "officialCitation": record.get("officialCitation") if record else None,
                "resolution": "exact-eoir-interim-decision-id" if record else "unresolved",
            })
    return output


def build_topical_indexes(case_root: Path, records: list[dict]) -> dict:
    manifest = json.loads((case_root / "supporting" / "manifest.json").read_text(encoding="utf-8"))
    artifacts = [
        artifact for artifact in manifest.get("artifacts", [])
        if artifact.get("role") == "official-topical-index-supporting-evidence"
        and artifact.get("hasTextLayer")
    ]
    try:
        import pdfplumber
    except ImportError as error:
        raise RuntimeError(
            "Topical-index extraction requires pdfplumber. Run with the Codex workspace Python runtime."
        ) from error

    entries: list[dict] = []
    source_hashes = []
    for artifact in artifacts:
        path = Path(artifact["localPath"])
        path = path if path.is_absolute() else case_root / path
        value_hash = hashlib.sha256(path.read_bytes()).hexdigest()
        if value_hash != artifact["sha256"]:
            raise RuntimeError(f"Topical-index checksum mismatch for {artifact['id']}")
        columns = []
        with pdfplumber.open(path) as document:
            for page_number, page in enumerate(document.pages, start=1):
                boxes = [
                    (0, 0, page.width / 2, page.height),
                    (page.width / 2, 0, page.width, page.height),
                ]
                for column_number, box in enumerate(boxes, start=1):
                    text = page.crop(box).extract_text(
                        layout=True, x_tolerance=2, y_tolerance=2,
                    ) or ""
                    columns.append({
                        "sourcePage": page_number,
                        "sourceColumn": column_number,
                        "text": text,
                    })
        parsed = parse_topical_index_columns(columns, artifact["id"])
        entries.extend(parsed)
        source_hashes.append({
            "id": artifact["id"], "sha256": value_hash,
            "pages": artifact.get("pages"), "subjectEntries": len(parsed),
        })

    resolved = resolve_topical_index(entries, records)
    output_path = case_root / "supporting" / "derived" / "eoir-topical-index.jsonl"
    atomic_write(
        output_path,
        "".join(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n" for row in resolved).encode("utf-8"),
    )
    unresolved = [row for row in resolved if not row.get("caseId")]
    unique_links = {
        (row.get("caseId"), row.get("primaryTopic"), row.get("entryText"))
        for row in resolved if row.get("caseId")
    }
    summary = {
        "schemaVersion": 1,
        "sourceTier": "official-reporter-topical-index",
        "sources": source_hashes,
        "subjectEntries": len(entries),
        "caseTopicOccurrences": len(resolved),
        "resolvedOccurrences": len(resolved) - len(unresolved),
        "unresolvedOccurrences": len(unresolved),
        "uniqueResolvedCases": len({row["caseId"] for row in resolved if row.get("caseId")}),
        "uniqueTopicLinks": len(unique_links),
        "outputSha256": hashlib.sha256(output_path.read_bytes()).hexdigest(),
        "unresolvedExamples": [{
            "sourceArtifactId": row["sourceArtifactId"],
            "sourcePage": row["sourcePage"],
            "eoirId": row["eoirId"],
            "evidence": row["evidence"],
        } for row in unresolved[:25]],
        "limitations": [
            "These are reporter subject associations, not holdings or later-treatment conclusions.",
            "Image-only volumes 1-15 remain routed to the OCR workflow and are not included in this native-text snapshot.",
        ],
    }
    atomic_write(
        case_root / "supporting" / "topical-index-summary.json",
        (json.dumps(summary, indent=2, ensure_ascii=False) + "\n").encode("utf-8"),
    )
    return summary


def _canonical_json(value: object) -> bytes:
    return json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":"),
    ).encode("utf-8")


def _box(width: int, height: int, left: float, top: float, right: float, bottom: float) -> list[int]:
    return [
        round(width * left), round(height * top),
        round(width * right), round(height * bottom),
    ]


def topical_index_layout_hints(
    width: int, height: int, source_artifact_id: str, source_page: int,
) -> dict:
    """Return conservative scan regions without destructively cropping a page.

    The scans contain binding bars and occasional adjacent-page bleed.  The
    full render remains the OCR input of record; overlapping column regions are
    hints/tiles that let a layout model recover small type and indentation.
    """
    regions = [
        {
            "id": "full-page",
            "role": "source-of-record",
            "bboxPx": [0, 0, width, height],
        },
        {
            "id": "safe-content",
            "role": "non-destructive-layout-hint",
            "bboxPx": _box(width, height, 0.17, 0.02, 0.95, 0.98),
        },
        {
            "id": "left-column",
            "role": "overlapping-ocr-tile",
            "bboxPx": _box(width, height, 0.19, 0.02, 0.56, 0.98),
        },
        {
            "id": "right-column",
            "role": "overlapping-ocr-tile",
            "bboxPx": _box(width, height, 0.49, 0.02, 0.95, 0.98),
        },
        {
            "id": "folio-and-imprint",
            "role": "footer-reconciliation-hint",
            "bboxPx": _box(width, height, 0.25, 0.88, 0.95, 0.995),
        },
    ]
    reading_order = {
        "default": ["left-column", "right-column", "folio-and-imprint"],
        "rule": (
            "Detect any heading spanning the gutter from the full-page image first; "
            "then read each column top-to-bottom, left column before right column."
        ),
    }
    if source_artifact_id == "eoir-index-vol1-15-a-e" and source_page == 1:
        regions.append({
            "id": "spanning-title",
            "role": "spanning-header-candidate",
            "bboxPx": _box(width, height, 0.17, 0.10, 0.95, 0.30),
        })
        reading_order["default"] = [
            "spanning-title", "left-column", "right-column", "folio-and-imprint",
        ]
    return {
        "coordinateSystem": "image-pixels-top-left-origin",
        "pageLayout": "two-column-with-possible-spanning-headings",
        "regions": regions,
        "readingOrder": reading_order,
        "columnOverlapPx": regions[2]["bboxPx"][2] - regions[3]["bboxPx"][0],
        "preserveIndentation": True,
        "preservePrintedLineBreaks": True,
        "doNotCropSourceOfRecord": True,
    }


def topical_index_ocr_output_schema() -> dict:
    """Schema for provisional OCR layers from the historical topical index."""
    bbox = {
        "type": "array", "items": {"type": "integer", "minimum": 0},
        "minItems": 4, "maxItems": 4,
        "description": "[left, top, right, bottom] in 300-DPI image pixels.",
    }
    return {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "$id": f"urn:inasearch:{TOPICAL_INDEX_OCR_CONTRACT_ID}:output",
        "title": "EOIR volumes 1-15 topical-index OCR candidate layer",
        "type": "object",
        "additionalProperties": True,
        "required": [
            "schemaVersion", "contractId", "jobId", "layerStatus", "engine",
            "page", "blocks", "readingOrder", "crossReferences",
            "reporterReferences", "quality",
        ],
        "properties": {
            "schemaVersion": {"const": 1},
            "contractId": {"const": TOPICAL_INDEX_OCR_CONTRACT_ID},
            "jobId": {"type": "string", "minLength": 1},
            "layerStatus": {
                "enum": ["candidate-unreviewed", "candidate-reviewed", "rejected"],
                "description": "OCR is never canonical merely because a job completed.",
            },
            "engine": {
                "type": "object", "additionalProperties": True,
                "required": ["name", "version", "modelRevision", "runtimeDigest"],
                "properties": {
                    "name": {"type": "string"},
                    "version": {"type": "string"},
                    "modelRevision": {"type": "string"},
                    "runtimeDigest": {"type": "string"},
                },
            },
            "page": {
                "type": "object", "additionalProperties": True,
                "required": [
                    "sourceArtifactId", "sourcePage", "sourcePdfSha256",
                    "sourcePageContentSha256", "inputImageSha256",
                ],
                "properties": {
                    "sourceArtifactId": {"type": "string"},
                    "sourcePage": {"type": "integer", "minimum": 1},
                    "sourcePdfSha256": {"type": "string", "pattern": "^[0-9a-f]{64}$"},
                    "sourcePageContentSha256": {"type": "string", "pattern": "^[0-9a-f]{64}$"},
                    "inputImageSha256": {"type": "string", "pattern": "^[0-9a-f]{64}$"},
                },
            },
            "blocks": {
                "type": "array",
                "items": {
                    "type": "object", "additionalProperties": True,
                    "required": ["id", "role", "bboxPx", "text", "lines"],
                    "properties": {
                        "id": {"type": "string"},
                        "role": {
                            "enum": [
                                "spanning-heading", "topic-heading", "continued-heading",
                                "entry", "cross-reference", "folio", "publisher-imprint",
                                "scan-artifact", "unknown",
                            ],
                        },
                        "bboxPx": bbox,
                        "text": {"type": "string"},
                        "normalizedText": {"type": ["string", "null"]},
                        "parentBlockId": {"type": ["string", "null"]},
                        "lines": {
                            "type": "array",
                            "items": {
                                "type": "object", "additionalProperties": True,
                                "required": ["text", "bboxPx", "indentLevel"],
                                "properties": {
                                    "text": {"type": "string"},
                                    "bboxPx": bbox,
                                    "indentLevel": {"type": "integer", "minimum": 0},
                                    "indentXPx": {"type": ["integer", "null"], "minimum": 0},
                                },
                            },
                        },
                    },
                },
            },
            "readingOrder": {"type": "array", "items": {"type": "string"}},
            "crossReferences": {
                "type": "array",
                "items": {
                    "type": "object", "additionalProperties": True,
                    "required": ["sourceBlockId", "relation", "cueText", "targetText"],
                    "properties": {
                        "sourceBlockId": {"type": "string"},
                        "relation": {"enum": ["see", "see-also", "continued", "other"]},
                        "cueText": {"type": "string"},
                        "targetText": {"type": "string"},
                    },
                },
            },
            "reporterReferences": {
                "type": "array",
                "description": "Printed volume-page references (for example 12-432), not EOIR IDs.",
                "items": {
                    "type": "object", "additionalProperties": True,
                    "required": ["sourceBlockId", "written", "volume", "page"],
                    "properties": {
                        "sourceBlockId": {"type": "string"},
                        "written": {"type": "string"},
                        "volume": {"type": "integer", "minimum": 1, "maximum": 15},
                        "page": {"type": "integer", "minimum": 1},
                    },
                },
            },
            "quality": {
                "type": "object", "additionalProperties": True,
                "required": ["complete", "truncated", "notes"],
                "properties": {
                    "complete": {"type": "boolean"},
                    "truncated": {"type": "boolean"},
                    "notes": {"type": "array", "items": {"type": "string"}},
                },
            },
        },
    }


def topical_index_ocr_contract() -> dict:
    return {
        "schemaVersion": 1,
        "contractId": TOPICAL_INDEX_OCR_CONTRACT_ID,
        "sourceClass": "official-reporter-topical-index-scan",
        "outputLayerStatus": "candidate-unreviewed",
        "canonicalPolicy": (
            "No OCR or VLM result is canonical until source-image comparison and "
            "citation/structure validation have selected it."
        ),
        "inputPolicy": {
            "useFullPageImageAsSourceOfRecord": True,
            "columnRegionsAreNonDestructiveHints": True,
            "noThirdPartyApiUpload": True,
        },
        "transcriptionRules": [
            "Transcribe the printed words and punctuation; keep normalized text in a separate field.",
            "Preserve printed line boundaries, indentation levels, headings, and Continued labels.",
            "Read a spanning heading before the two columns, then read left top-to-bottom before right.",
            "Extract every see/see also cross-reference with its cue and target text.",
            "Extract every printed volume-page reporter reference, including multiple references on one entry.",
            "Do not reinterpret a volume-page reporter reference as an EOIR interim-decision number.",
            "Represent illegible text explicitly and set quality.complete false; never silently omit it.",
            "Exclude binding bars, adjacent-page bleed, and scanner marks as scan-artifact blocks.",
        ],
        "requiredQualityChecks": [
            "all visible non-artifact regions accounted for",
            "readingOrder names every text block exactly once",
            "cross-reference targets preserve hierarchical indentation",
            "reporter references reconcile to visible source tokens",
            "truncation/stop state recorded",
        ],
        "outputSchema": "output-schema.json",
    }


def _source_page_content_sha256(page: object) -> str:
    """Fingerprint decoded source-page content independent of PDF object IDs."""
    media_box = [float(value) for value in page.mediabox]
    crop_box = [float(value) for value in page.cropbox]
    digest = hashlib.sha256(_canonical_json({
        "mediaBox": media_box,
        "cropBox": crop_box,
        "rotation": int(page.rotation or 0),
    }))
    contents = page.get_contents()
    if contents is not None:
        digest.update(contents.get_data())
    for image_file in page.images:
        image = image_file.image
        digest.update(_canonical_json({"mode": image.mode, "size": list(image.size)}))
        digest.update(image.tobytes())
    return digest.hexdigest()


def _renderer_version(renderer: str) -> str:
    process = subprocess.run(
        [renderer, "-v"], check=True, stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT, text=True,
    )
    return process.stdout.splitlines()[0].strip()


def _render_topical_index_page(
    renderer: str, source_path: Path, source_page: int, output_path: Path,
    dpi: int, force: bool,
) -> None:
    if output_path.exists() and not force:
        return
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".render-", dir=output_path.parent) as temporary:
        prefix = Path(temporary) / "page"
        subprocess.run([
            renderer, "-f", str(source_page), "-l", str(source_page),
            "-r", str(dpi), "-singlefile", "-png", str(source_path), str(prefix),
        ], check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        rendered = prefix.with_suffix(".png")
        if not rendered.exists():
            raise RuntimeError(
                f"Renderer produced no PNG for {source_path.name} page {source_page}"
            )
        rendered.replace(output_path)


def _fraction_below(histogram: list[int], threshold: int) -> float:
    total = sum(histogram)
    return sum(histogram[:threshold]) / total if total else 0.0


def _rendered_page_metrics(path: Path, layout: dict) -> dict:
    try:
        from PIL import Image
    except ImportError as error:
        raise RuntimeError(
            "Topical-index queue inspection requires Pillow; use the bundled workspace Python runtime."
        ) from error
    with Image.open(path) as image:
        width, height = image.size
        gray = image.convert("L")
        safe = next(region for region in layout["regions"] if region["id"] == "safe-content")
        safe_histogram = gray.crop(tuple(safe["bboxPx"])).histogram()
        full_histogram = gray.histogram()
        ink_mask = gray.point([255 if value < 240 else 0 for value in range(256)])
        observed_ink = ink_mask.getbbox()
        margin_width = max(1, round(width * 0.17))
        left_fraction = _fraction_below(gray.crop((0, 0, margin_width, height)).histogram(), 200)
        right_fraction = _fraction_below(
            gray.crop((width - margin_width, 0, width, height)).histogram(), 200,
        )
        safe_fraction = _fraction_below(safe_histogram, 200)
        flags = []
        if left_fraction > max(0.02, safe_fraction * 1.35):
            flags.append("left-margin-scan-artifact-or-adjacent-page-bleed")
        if right_fraction > max(0.02, safe_fraction * 1.35):
            flags.append("right-margin-scan-artifact-or-adjacent-page-bleed")
        return {
            "widthPx": width,
            "heightPx": height,
            "mode": image.mode,
            "fullPageDarkPixelFraction": round(_fraction_below(full_histogram, 200), 8),
            "safeContentDarkPixelFraction": round(safe_fraction, 8),
            "observedInkBoundsPx": list(observed_ink) if observed_ink else None,
            "blankPage": safe_fraction < 0.002,
            "automatedQualityFlags": flags,
        }


def _topical_index_ocr_artifacts(case_root: Path) -> list[dict]:
    manifest = json.loads(
        (case_root / "supporting" / "manifest.json").read_text(encoding="utf-8")
    )
    by_id = {artifact.get("id"): artifact for artifact in manifest.get("artifacts", [])}
    missing = sorted(TOPICAL_INDEX_IMAGE_ARTIFACTS - set(by_id))
    if missing:
        raise RuntimeError(f"Supporting manifest lacks OCR source: {', '.join(missing)}")
    artifacts = [by_id[artifact_id] for artifact_id in sorted(TOPICAL_INDEX_IMAGE_ARTIFACTS)]
    for artifact in artifacts:
        if artifact.get("role") != "official-topical-index-supporting-evidence":
            raise RuntimeError(f"Unexpected supporting role for {artifact['id']}")
        if artifact.get("hasTextLayer") is not False:
            raise RuntimeError(f"Expected image-only topical index for {artifact['id']}")
    return artifacts


def build_topical_index_ocr_queue(
    case_root: Path, *, dpi: int = 300, force: bool = False,
    renderer: str | None = None, output_root: Path | None = None,
) -> dict:
    """Render and describe all image-only volumes 1-15 topical-index pages."""
    case_root = case_root.resolve()
    if dpi != 300:
        raise ValueError("The topical-index OCR contract is fixed at 300 DPI")
    renderer = renderer or shutil.which("pdftoppm")
    if not renderer:
        raise RuntimeError("pdftoppm is required to render the topical-index queue")
    renderer_version = _renderer_version(renderer)
    output_root = (
        output_root.resolve() if output_root is not None
        else case_root / TOPICAL_INDEX_OCR_OUTPUT_ROOT
    )
    contract = topical_index_ocr_contract()
    output_schema = topical_index_ocr_output_schema()
    atomic_write(
        output_root / "contract.json",
        json.dumps(contract, indent=2, ensure_ascii=False, sort_keys=True).encode("utf-8") + b"\n",
    )
    atomic_write(
        output_root / "output-schema.json",
        json.dumps(output_schema, indent=2, ensure_ascii=False, sort_keys=True).encode("utf-8") + b"\n",
    )

    records: list[dict] = []
    source_summaries = []
    first_page_by_content_hash: dict[str, str] = {}
    first_page_by_image_hash: dict[str, str] = {}
    for artifact in _topical_index_ocr_artifacts(case_root):
        source_path = Path(artifact["localPath"])
        source_path = source_path if source_path.is_absolute() else case_root / source_path
        source_value = source_path.read_bytes()
        source_hash = hashlib.sha256(source_value).hexdigest()
        if source_hash != artifact["sha256"]:
            raise RuntimeError(f"Topical-index checksum mismatch for {artifact['id']}")
        reader = _pdf_reader(source_path)
        expected_pages = int(artifact["pages"])
        if len(reader.pages) != expected_pages:
            raise RuntimeError(
                f"Topical-index page count mismatch for {artifact['id']}: "
                f"{len(reader.pages)} != {expected_pages}"
            )
        source_summary = {
            "sourceArtifactId": artifact["id"],
            "sourcePdfSha256": source_hash,
            "sourcePdfBytes": len(source_value),
            "pages": len(reader.pages),
            "sourcePdfPath": artifact["localPath"],
        }
        source_summaries.append(source_summary)
        for source_page, page in enumerate(reader.pages, start=1):
            job_id = f"{artifact['id']}-page-{source_page:03d}"
            image_path = output_root / "renders" / artifact["id"] / f"page-{source_page:03d}.png"
            _render_topical_index_page(
                renderer, source_path, source_page, image_path, dpi, force,
            )
            # Layout is based on the 300-DPI pixel dimensions and stays a hint,
            # never a replacement for the preserved full-page render.
            try:
                from PIL import Image
            except ImportError as error:
                raise RuntimeError(
                    "Topical-index queue inspection requires Pillow; use the bundled workspace Python runtime."
                ) from error
            with Image.open(image_path) as image:
                width, height = image.size
            layout = topical_index_layout_hints(width, height, artifact["id"], source_page)
            metrics = _rendered_page_metrics(image_path, layout)
            image_hash = hashlib.sha256(image_path.read_bytes()).hexdigest()
            page_content_hash = _source_page_content_sha256(page)
            prior_content_page = first_page_by_content_hash.get(page_content_hash)
            prior_image_page = first_page_by_image_hash.get(image_hash)
            if prior_content_page and prior_image_page != prior_content_page:
                raise RuntimeError(
                    f"Source/render duplicate mismatch for {job_id}: "
                    f"{prior_content_page} != {prior_image_page}"
                )
            duplicate_of = prior_content_page
            first_page_by_content_hash.setdefault(page_content_hash, job_id)
            first_page_by_image_hash.setdefault(image_hash, job_id)
            pdf_width = float(page.mediabox.width)
            pdf_height = float(page.mediabox.height)
            identity_hash = hashlib.sha256(_canonical_json({
                "sourcePdfSha256": source_hash,
                "sourcePage": source_page,
                "sourcePageContentSha256": page_content_hash,
            })).hexdigest()
            quality_flags = list(metrics.pop("automatedQualityFlags"))
            if artifact["id"] == "eoir-index-vol1-15-f-z" and source_page == 33:
                quality_flags.extend([
                    "visually-confirmed-left-adjacent-page-bleed",
                    "visually-confirmed-terminal-page-content-shift",
                ])
            if duplicate_of:
                quality_flags.append("exact-duplicate-page-content-and-render")
            if metrics["blankPage"]:
                quality_flags.append("automated-blank-page-candidate")
            relative_image_path = str(image_path.relative_to(case_root))
            records.append({
                "schemaVersion": 1,
                "contractId": TOPICAL_INDEX_OCR_CONTRACT_ID,
                "jobId": job_id,
                "status": (
                    "skip-blank" if metrics["blankPage"] else
                    "reuse-identical-page" if duplicate_of else "ready-for-ocr"
                ),
                "ocrRecommended": not metrics["blankPage"] and duplicate_of is None,
                "reuseOcrFromJobId": duplicate_of,
                "source": {
                    "sourceArtifactId": artifact["id"],
                    "publisher": artifact.get("publisher"),
                    "title": artifact.get("title"),
                    "sourceUrl": artifact.get("sourceUrl"),
                    "sourcePdfPath": artifact["localPath"],
                    "sourcePdfSha256": source_hash,
                    "sourcePage": source_page,
                    "sourcePageCount": len(reader.pages),
                    "sourcePageIdentitySha256": identity_hash,
                    "sourcePageContentSha256": page_content_hash,
                    "pdfGeometry": {
                        "widthPt": pdf_width,
                        "heightPt": pdf_height,
                        "rotationDegrees": int(page.rotation or 0),
                    },
                },
                "image": {
                    "path": relative_image_path,
                    "sha256": image_hash,
                    "bytes": image_path.stat().st_size,
                    "dpi": dpi,
                    **metrics,
                    "rendering": {
                        "renderer": Path(renderer).name,
                        "rendererVersion": renderer_version,
                        "recipe": [
                            "pdftoppm", "-f", str(source_page), "-l", str(source_page),
                            "-r", str(dpi), "-singlefile", "-png", "SOURCE_PDF",
                            "OUTPUT_PREFIX",
                        ],
                    },
                },
                "coordinates": {
                    "image": "top-left-origin-pixels",
                    "pdf": "bottom-left-origin-points",
                    "pdfToImage": {
                        "scaleX": width / pdf_width,
                        "scaleY": height / pdf_height,
                        "formula": "x_px=x_pt*scaleX; y_px=(heightPt-y_pt)*scaleY",
                    },
                },
                "layoutHints": layout,
                "qualityFlags": sorted(set(quality_flags)),
                "expectedOutputSchemaPath": str(
                    (output_root / "output-schema.json").relative_to(case_root)
                ),
            })

    queue_value = b"".join(
        _canonical_json(record) + b"\n" for record in records
    )
    queue_path = output_root / "queue.jsonl"
    atomic_write(queue_path, queue_value)
    rendered_bytes = sum(record["image"]["bytes"] for record in records)
    duplicate_records = [record for record in records if record["reuseOcrFromJobId"]]
    blank_records = [record for record in records if record["image"]["blankPage"]]
    ready_records = [record for record in records if record["ocrRecommended"]]
    tesseract_path = shutil.which("tesseract")
    summary = {
        "schemaVersion": 1,
        "contractId": TOPICAL_INDEX_OCR_CONTRACT_ID,
        "sources": source_summaries,
        "sourcePdfs": len(source_summaries),
        "pages": len(records),
        "uniquePageContents": len({record["source"]["sourcePageContentSha256"] for record in records}),
        "uniqueRenderedImages": len({record["image"]["sha256"] for record in records}),
        "readyForOcr": len(ready_records),
        "exactDuplicatePages": len(duplicate_records),
        "blankPageCandidates": len(blank_records),
        "renderedBytes": rendered_bytes,
        "dpi": dpi,
        "renderer": {"name": Path(renderer).name, "version": renderer_version},
        "cpuBaseline": {
            "engine": "tesseract",
            "available": bool(tesseract_path),
            "generated": False,
            "status": (
                "not-generated; queue builder intentionally leaves OCR layers to a separate worker"
                if tesseract_path else "not-generated; tesseract is not installed"
            ),
            "canonical": False,
        },
        "queuePath": str(queue_path.relative_to(case_root)),
        "queueSha256": hashlib.sha256(queue_value).hexdigest(),
        "contractPath": str((output_root / "contract.json").relative_to(case_root)),
        "contractSha256": hashlib.sha256((output_root / "contract.json").read_bytes()).hexdigest(),
        "outputSchemaPath": str((output_root / "output-schema.json").relative_to(case_root)),
        "outputSchemaSha256": hashlib.sha256(
            (output_root / "output-schema.json").read_bytes()
        ).hexdigest(),
        "representativeVisualQa": [
            "eoir-index-vol1-15-a-e-page-001",
            "eoir-index-vol1-15-a-e-page-020",
            "eoir-index-vol1-15-a-e-page-041",
            "eoir-index-vol1-15-f-z-page-017",
            "eoir-index-vol1-15-f-z-page-033",
        ],
        "limitations": [
            "The queue is a rendering and layout contract, not an OCR result or canonical transcription.",
            "The scans include binding bars, adjacent-page bleed, skew/noise, small type, and hierarchical indentation.",
            "The final F-Z page has visually confirmed adjacent-page bleed and shifted terminal-page content.",
            "A-E page 41 and F-Z page 1 are exact duplicate overlap pages and should share one reviewed OCR result.",
        ],
    }
    summary_value = json.dumps(
        summary, indent=2, ensure_ascii=False, sort_keys=True,
    ).encode("utf-8") + b"\n"
    atomic_write(output_root / "summary.json", summary_value)

    # Re-open every final image and re-check each byte hash after all writes.
    for record in records:
        path = case_root / record["image"]["path"]
        if hashlib.sha256(path.read_bytes()).hexdigest() != record["image"]["sha256"]:
            raise RuntimeError(f"Rendered topical-index image changed during build: {path}")
    return summary


def build_supporting_indexes(repo_root: Path, case_root: Path, records: list[dict]) -> dict:
    chart = build_precedent_chart(repo_root, case_root, records)
    affected = build_affected_decisions(case_root, records)
    topical = build_topical_indexes(case_root, records)
    return {
        "schemaVersion": 1,
        "precedentChart": chart,
        "affectedDecisions": affected,
        "topicalIndexes": topical,
    }
