"""Deterministic quality summaries for multi-engine OCR smoke results.

The benchmark deliberately compares every returned OCR layer without choosing
or adjudicating one.  Publisher-PDF native text is used only when the smoke
manifest marks it as a high-quality, non-scan extraction and its digest still
matches the local derived case page.  Those comparisons are proxies, never
human transcription gold.
"""

from __future__ import annotations

import copy
import hashlib
import json
import math
import re
import statistics
import unicodedata
from collections import Counter, defaultdict
from itertools import combinations
from pathlib import Path
from typing import Any, Iterable, Sequence

from .documents import atomic_write, load_jsonl
from .hermes_ocr import (
    normalize_ovis_executor_pin,
    normalize_worker_commit_pin,
    validate_flat_result_provenance_pins,
)


BENCHMARK_CONTRACT = "inasearch-ocr-smoke-benchmark/v1"
LEGAL_CITATION_REVIEW_CONTRACT = "inasearch-ocr-legal-citation-review/v1"
NATIVE_PROXY_KIND = "publisher-pdf-native-text-proxy-not-human-gold"
NATIVE_PROXY_POLICY = {
    "minimumQualityScore": 0.9,
    "minimumCharacters": 100,
    "requiresNeedsOcrFalse": True,
    "requiresScanLikelyFalse": True,
    "requiresManifestAndDerivedTextSha256Match": True,
}

_WHITESPACE_RE = re.compile(r"\s+")
_WORD_RE = re.compile(r"[^\W_]+(?:[.&'\u2019/\-][^\W_]+)*|\u00a7+", re.UNICODE)

# These patterns are intentionally conservative.  A false positive would make
# exact-preservation numbers look better than the underlying OCR evidence.
_CITATION_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    (
        "inReporter",
        re.compile(
            r"\b\d{1,2}\s+(?:I\s*&\s*N|I\.\s*&\s*N\.)\s+Dec\.?\s+\d{1,4}\b",
            re.IGNORECASE,
        ),
    ),
    (
        "usc",
        re.compile(
            r"\b\d{1,2}\s+U\.?\s*S\.?\s*C\.?\s*(?:\u00a7{1,2}\s*)?"
            r"\d+[A-Za-z]?(?:\s*\((?!\d{4}\))[A-Za-z0-9-]+\))*",
            re.IGNORECASE,
        ),
    ),
    (
        "cfr",
        re.compile(
            r"\b\d{1,2}\s+C\.?\s*F\.?\s*R\.?\s*(?:\u00a7{1,2}\s*)?"
            r"\d+(?:\.\d+)?(?:\s*\((?!\d{4}\))[A-Za-z0-9-]+\))*",
            re.IGNORECASE,
        ),
    ),
    (
        "inaSection",
        re.compile(
            r"(?:\bINA\s*(?:\u00a7{1,2}|section)|\bsection)\s*"
            r"\d+[A-Za-z]?(?:\s*\((?!\d{4}\))[A-Za-z0-9-]+\))+",
            re.IGNORECASE,
        ),
    ),
)

# Topical-index pages use compact printed I&N volume-page references such as
# ``12–432``.  They are only enabled for official supporting-index jobs.  Requiring
# an explicit separator, a known historical volume (1–15), and a 1–3 digit page
# avoids guessing that broken-together OCR digits or ordinary ranges are legal
# citations.  Comma-continuation pages are deliberately not inferred.
_OFFICIAL_REPORTER_VOLUME_PAGE_PATTERN = re.compile(
    r"(?<![\w/])(?:1[0-5]|[1-9])[ \t]*[-\u2010-\u2015][ \t]*[1-9]\d{0,2}(?![\w/])"
)
_OFFICIAL_REPORTER_RANGE_PREFIX_PATTERN = re.compile(
    r"(?:\bvol(?:ume)?s?|\bsections?|\bsecs?|\bpages?|\bpp?)\.?[ \t]*$",
    re.IGNORECASE,
)

_CITATION_KIND_ORDER = {
    "inReporter": 0,
    "usc": 1,
    "cfr": 2,
    "inaSection": 3,
    "officialReporterVolumePage": 4,
}

_LEGAL_MARKER_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("sectionSymbol", re.compile(r"\u00a7")),
    ("inReporterMarker", re.compile(r"(?:I\s*&\s*N|I\.\s*&\s*N\.)", re.IGNORECASE)),
    ("uscMarker", re.compile(r"U\.?\s*S\.?\s*C\.?", re.IGNORECASE)),
    ("cfrMarker", re.compile(r"C\.?\s*F\.?\s*R\.?", re.IGNORECASE)),
    ("inaMarker", re.compile(r"\bINA\b", re.IGNORECASE)),
    ("matterOf", re.compile(r"\bMatter\s+of\b", re.IGNORECASE)),
    ("supra", re.compile(r"\bsupra\b", re.IGNORECASE)),
    ("infra", re.compile(r"\binfra\b", re.IGNORECASE)),
)

_PROVENANCE_FIELDS = (
    "schemaVersion",
    "jobId",
    "resultId",
    "jobFingerprint",
    "provenanceCompleteness",
    "caseId",
    "pageNumber",
    "engine",
    "model",
    "containerDigest",
    "sourcePdfSha256",
    "imageSha256",
    "promptSha256",
    "outputSchemaSha256",
    "render",
    "preprocessing",
    "layerProvenance",
    "provenance",
    "worker",
    "remoteJob",
    "remoteEnvelopeSha256",
    "remoteLayerIndex",
    "workerResultSchemaVersion",
    "remoteCoordinateMapping",
    "decoding",
    "audit",
)


def canonical_json(value: Any) -> bytes:
    return json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")


def _sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _sha256_path(path: Path) -> str:
    return _sha256_bytes(path.read_bytes())


def _clean_text(value: str) -> str:
    return _WHITESPACE_RE.sub(" ", unicodedata.normalize("NFKC", value)).strip()


def normalized_words(value: str) -> list[str]:
    """Return deterministic, case-insensitive words for edit comparisons."""
    return [match.group(0).casefold() for match in _WORD_RE.finditer(_clean_text(value))]


def _edit_distance_dp(left: Sequence[Any], right: Sequence[Any]) -> int:
    """Simple exact Levenshtein oracle with O(min(n,m)) memory.

    This deliberately straightforward recurrence is retained as a regression
    oracle for the bit-parallel implementation below.  Benchmark code must use
    :func:`_edit_distance`; this version is quadratic and is impractical for
    full OCR pages.
    """
    if len(left) < len(right):
        left, right = right, left
    if not right:
        return len(left)
    previous = list(range(len(right) + 1))
    for left_index, left_value in enumerate(left, start=1):
        current = [left_index]
        for right_index, right_value in enumerate(right, start=1):
            current.append(min(
                current[-1] + 1,
                previous[right_index] + 1,
                previous[right_index - 1] + (left_value != right_value),
            ))
        previous = current
    return previous[-1]


def _edit_distance(left: Sequence[Any], right: Sequence[Any]) -> int:
    """Return exact Levenshtein distance using Myers bit-parallel vectors.

    One Python integer represents the complete dynamic-programming column for
    the shorter input.  The result is identical to ``_edit_distance_dp`` while
    replacing the quadratic Python loop with C-level arbitrary-precision
    integer operations.  OCR characters and normalized word tokens are
    hashable; equality-only, unhashable tokens retain exact behavior through
    the simple oracle.
    """
    if len(left) < len(right):
        left, right = right, left

    pattern_length = len(right)
    if pattern_length == 0:
        return len(left)

    # Bit i records matches against pattern position i.  Constructing the
    # table can encounter unhashable callers even though the production inputs
    # are strings and lists of strings, so preserve the generic Sequence[Any]
    # contract with an exact fallback.
    equality_masks: dict[Any, int] = {}
    try:
        for index, value in enumerate(right):
            equality_masks[value] = equality_masks.get(value, 0) | (1 << index)
    except TypeError:
        return _edit_distance_dp(left, right)

    all_bits = (1 << pattern_length) - 1
    high_bit = 1 << (pattern_length - 1)
    positive = all_bits
    negative = 0
    distance = pattern_length

    try:
        for value in left:
            matches = equality_masks.get(value, 0)
            vertical = matches | negative
            horizontal = (((matches & positive) + positive) ^ positive) | matches
            positive_horizontal = negative | ~(horizontal | positive)
            negative_horizontal = positive & horizontal

            if positive_horizontal & high_bit:
                distance += 1
            elif negative_horizontal & high_bit:
                distance -= 1

            positive_horizontal = ((positive_horizontal << 1) | 1) & all_bits
            negative_horizontal = (negative_horizontal << 1) & all_bits
            positive = (
                negative_horizontal | ~(vertical | positive_horizontal)
            ) & all_bits
            negative = positive_horizontal & vertical
    except TypeError:
        # A hashable pattern may still be compared with an unhashable token in
        # the other input.  This is outside OCR's inputs but remains supported.
        return _edit_distance_dp(left, right)

    return distance


def _rounded(value: float | None) -> float | None:
    if value is None:
        return None
    return round(float(value), 6)


def _mean(values: Iterable[float]) -> float | None:
    materialized = list(values)
    return _rounded(statistics.fmean(materialized)) if materialized else None


def _median(values: Iterable[float]) -> float | None:
    materialized = list(values)
    return _rounded(statistics.median(materialized)) if materialized else None


def _percentile95(values: Iterable[float]) -> float | None:
    materialized = sorted(values)
    if not materialized:
        return None
    # Nearest-rank is deterministic and meaningful for tiny smoke samples.
    position = max(0, math.ceil(0.95 * len(materialized)) - 1)
    return _rounded(materialized[position])


def _citation_key(kind: str, value: str) -> str:
    return f"{kind}\u0000{value}"


def _canonical_legal_citation(kind: str, written: str) -> str:
    """Canonicalize typography only; never discard a legal locator component."""
    value = unicodedata.normalize("NFKC", written)
    if kind == "inReporter":
        match = re.fullmatch(
            r"\s*(\d{1,2})\s+(?:I\s*&\s*N|I\.\s*&\s*N\.)\s+"
            r"Dec\.?\s+(\d{1,4})\s*",
            value,
            re.IGNORECASE,
        )
        if match:
            return f"{match.group(1)} I&N Dec. {match.group(2)}"
    elif kind == "usc":
        match = re.fullmatch(
            r"\s*(\d{1,2})\s+U\.?\s*S\.?\s*C\.?\s*(?:\u00a7{1,2}\s*)?"
            r"(\d+[A-Za-z]?)((?:\s*\((?!\d{4}\))[A-Za-z0-9-]+\))*)\s*",
            value,
            re.IGNORECASE,
        )
        if match:
            suffix = "".join(match.group(3).split())
            return f"{match.group(1)} USC {match.group(2)}{suffix}"
    elif kind == "cfr":
        match = re.fullmatch(
            r"\s*(\d{1,2})\s+C\.?\s*F\.?\s*R\.?\s*(?:\u00a7{1,2}\s*)?"
            r"(\d+(?:\.\d+)?)((?:\s*\((?!\d{4}\))[A-Za-z0-9-]+\))*)\s*",
            value,
            re.IGNORECASE,
        )
        if match:
            suffix = "".join(match.group(3).split())
            return f"{match.group(1)} CFR {match.group(2)}{suffix}"
    elif kind == "inaSection":
        match = re.fullmatch(
            r"\s*(?:(?:INA\s*(?:\u00a7{1,2}|section))|section)\s*"
            r"(\d+[A-Za-z]?)((?:\s*\((?!\d{4}\))[A-Za-z0-9-]+\))+?)\s*",
            value,
            re.IGNORECASE,
        )
        if match:
            suffix = "".join(match.group(2).split())
            return f"INA {match.group(1)}{suffix}"
    elif kind == "officialReporterVolumePage":
        match = re.fullmatch(
            r"\s*((?:1[0-5]|[1-9]))[ \t]*[-\u2010-\u2015][ \t]*"
            r"([1-9]\d{0,2})\s*",
            value,
        )
        if match:
            return f"{match.group(1)}-{match.group(2)}"
    raise RuntimeError(f"recognized {kind} citation could not be canonicalized: {written!r}")


def legal_signals(
    text: str,
    *,
    include_official_reporter_volume_pages: bool = False,
) -> dict:
    """Extract exact written citations, conservative canonical units, and markers."""
    by_type: dict[str, list[str]] = {}
    canonical_by_type: dict[str, list[str]] = {}
    all_values: list[dict[str, Any]] = []
    patterns = list(_CITATION_PATTERNS)
    if include_official_reporter_volume_pages:
        patterns.append(
            ("officialReporterVolumePage", _OFFICIAL_REPORTER_VOLUME_PAGE_PATTERN)
        )
    for kind, pattern in patterns:
        matches = list(pattern.finditer(text))
        if kind == "officialReporterVolumePage":
            matches = [
                match for match in matches
                if not _OFFICIAL_REPORTER_RANGE_PREFIX_PATTERN.search(
                    text[max(0, match.start() - 24):match.start()]
                )
            ]
        values = [match.group(0) for match in matches]
        canonical_values = [
            _canonical_legal_citation(kind, written) for written in values
        ]
        by_type[kind] = values
        canonical_by_type[kind] = canonical_values
        all_values.extend(
            {
                "type": kind,
                "text": written,
                "canonical": canonical,
                "start": match.start(),
                "end": match.end(),
            }
            for match, written, canonical in zip(matches, values, canonical_values)
        )
    markers = {
        name: len(pattern.findall(text)) for name, pattern in _LEGAL_MARKER_PATTERNS
    }
    return {
        "citationCount": len(all_values),
        "citationsByType": by_type,
        "canonicalCitationsByType": canonical_by_type,
        "citations": all_values,
        "officialReporterVolumePagesEnabled": include_official_reporter_volume_pages,
        "legalMarkerCounts": markers,
    }


def _citation_counter(signals: dict) -> Counter[str]:
    return Counter(
        _citation_key(item["type"], item["text"])
        for item in signals.get("citations", [])
    )


def _canonical_citation_counter(signals: dict) -> Counter[str]:
    return Counter(
        _citation_key(item["type"], item["canonical"])
        for item in signals.get("citations", [])
    )


def _counter_prf(candidate: Counter[str], reference: Counter[str]) -> dict:
    matched = sum((candidate & reference).values())
    candidate_total = sum(candidate.values())
    reference_total = sum(reference.values())
    precision = matched / candidate_total if candidate_total else (1.0 if not reference_total else 0.0)
    recall = matched / reference_total if reference_total else (1.0 if not candidate_total else 0.0)
    f1 = (
        2 * precision * recall / (precision + recall)
        if precision + recall else 0.0
    )
    return {
        "candidateCount": candidate_total,
        "referenceCount": reference_total,
        "exactMatches": matched,
        "precision": _rounded(precision),
        "recall": _rounded(recall),
        "f1": _rounded(f1),
        "exactMultisetMatch": candidate == reference,
    }


def _marker_comparison(candidate: dict, reference: dict) -> dict:
    names = sorted(set(candidate) | set(reference))
    absolute_difference = sum(abs(int(candidate.get(name, 0)) - int(reference.get(name, 0))) for name in names)
    reference_total = sum(int(reference.get(name, 0)) for name in names)
    candidate_total = sum(int(candidate.get(name, 0)) for name in names)
    scale = max(reference_total, candidate_total)
    agreement = 1.0 if scale == 0 else max(0.0, 1.0 - absolute_difference / scale)
    return {
        "candidateCounts": {name: int(candidate.get(name, 0)) for name in names},
        "referenceCounts": {name: int(reference.get(name, 0)) for name in names},
        "absoluteCountDifference": absolute_difference,
        "countAgreement": _rounded(agreement),
        "exactCountMatch": absolute_difference == 0,
    }


def _text_comparison(candidate: str, reference: str) -> dict:
    candidate_normalized = _clean_text(candidate).casefold()
    reference_normalized = _clean_text(reference).casefold()
    character_distance = _edit_distance(candidate_normalized, reference_normalized)
    character_scale = max(len(candidate_normalized), len(reference_normalized))
    candidate_words = normalized_words(candidate)
    reference_words = normalized_words(reference)
    word_distance = _edit_distance(candidate_words, reference_words)
    word_scale = max(len(candidate_words), len(reference_words))
    return {
        "normalization": "Unicode NFKC, whitespace collapsed, case-folded",
        "normalizedCharacterEditDistance": character_distance,
        "normalizedCharacterEditSimilarity": _rounded(
            1.0 if not character_scale else 1.0 - character_distance / character_scale
        ),
        "characterErrorRateProxy": _rounded(
            character_distance / len(reference_normalized)
            if reference_normalized else (0.0 if not candidate_normalized else 1.0)
        ),
        "normalizedWordEditDistance": word_distance,
        "normalizedWordEditSimilarity": _rounded(
            1.0 if not word_scale else 1.0 - word_distance / word_scale
        ),
        "wordErrorRateProxy": _rounded(
            word_distance / len(reference_words)
            if reference_words else (0.0 if not candidate_words else 1.0)
        ),
        "candidateNormalizedCharacters": len(candidate_normalized),
        "referenceNormalizedCharacters": len(reference_normalized),
        "candidateWords": len(candidate_words),
        "referenceWords": len(reference_words),
        "normalizedTextExactMatch": candidate_normalized == reference_normalized,
    }


def _full_comparison(
    candidate: str,
    reference: str,
    *,
    include_official_reporter_volume_pages: bool = False,
) -> dict:
    candidate_signals = legal_signals(
        candidate,
        include_official_reporter_volume_pages=(
            include_official_reporter_volume_pages
        ),
    )
    reference_signals = legal_signals(
        reference,
        include_official_reporter_volume_pages=(
            include_official_reporter_volume_pages
        ),
    )
    return {
        **_text_comparison(candidate, reference),
        "exactLegalCitations": _counter_prf(
            _citation_counter(candidate_signals), _citation_counter(reference_signals)
        ),
        "canonicalLegalCitations": _counter_prf(
            _canonical_citation_counter(candidate_signals),
            _canonical_citation_counter(reference_signals),
        ),
        "legalMarkers": _marker_comparison(
            candidate_signals["legalMarkerCounts"],
            reference_signals["legalMarkerCounts"],
        ),
    }


def _load_manifest(path: Path) -> tuple[list[dict], dict[str, dict]]:
    rows = load_jsonl(path)
    if not rows:
        raise RuntimeError("OCR smoke manifest is empty")
    by_job: dict[str, dict] = {}
    for position, row in enumerate(rows, start=1):
        if not isinstance(row, dict):
            raise RuntimeError(f"OCR smoke manifest row {position} is not an object")
        job_id = str(row.get("jobId") or "")
        if not job_id or job_id in by_job:
            raise RuntimeError(f"OCR smoke manifest row {position} has a missing/duplicate jobId")
        case_id = str(row.get("caseId") or "")
        try:
            page_number = int(row.get("pageNumber"))
        except (TypeError, ValueError) as error:
            raise RuntimeError(f"OCR smoke manifest row {position} has an invalid pageNumber") from error
        if not case_id or page_number < 1:
            raise RuntimeError(f"OCR smoke manifest row {position} lacks a valid case/page")
        by_job[job_id] = row
    return rows, by_job


def _load_results(
    path: Path,
    manifest: dict[str, dict],
    *,
    expected_worker_commit: str | None = None,
    expected_ovis_file_store_executor_sha256: str | None = None,
) -> list[dict]:
    rows = load_jsonl(path)
    seen: set[tuple[str, str]] = set()
    for position, row in enumerate(rows, start=1):
        if not isinstance(row, dict):
            raise RuntimeError(f"OCR result row {position} is not an object")
        job_id = str(row.get("jobId") or "")
        if job_id not in manifest:
            raise RuntimeError(f"OCR result row {position} has unknown jobId {job_id!r}")
        rich = manifest[job_id]
        engine = row.get("engine")
        if not isinstance(engine, dict) or not str(engine.get("name") or "").strip():
            raise RuntimeError(f"OCR result row {position} lacks engine.name")
        engine_name = str(engine["name"])
        identity = (job_id, engine_name)
        if identity in seen:
            raise RuntimeError(f"OCR results duplicate engine {engine_name!r} for {job_id}")
        seen.add(identity)
        if str(row.get("caseId")) != str(rich["caseId"]):
            raise RuntimeError(f"OCR result row {position} caseId disagrees with the manifest")
        if int(row.get("pageNumber", -1)) != int(rich["pageNumber"]):
            raise RuntimeError(f"OCR result row {position} pageNumber disagrees with the manifest")
        expected_image_hash = str(rich.get("image", {}).get("sha256") or "")
        if expected_image_hash and str(row.get("imageSha256") or "") != expected_image_hash:
            raise RuntimeError(f"OCR result row {position} imageSha256 disagrees with the manifest")
        expected_pdf_hash = str(rich.get("source", {}).get("pdfSha256") or "")
        if expected_pdf_hash and str(row.get("sourcePdfSha256") or "") != expected_pdf_hash:
            raise RuntimeError(f"OCR result row {position} sourcePdfSha256 disagrees with the manifest")
        validate_flat_result_provenance_pins(
            row,
            expected_worker_commit=expected_worker_commit,
            expected_ovis_file_store_executor_sha256=(
                expected_ovis_file_store_executor_sha256
            ),
            context=f"OCR result row {position}",
        )
    return rows


def _native_reference(rich: dict, derived_root: Path | None) -> tuple[dict, str | None]:
    native = rich.get("nativeReference") if isinstance(rich.get("nativeReference"), dict) else {}
    quality = native.get("quality") if isinstance(native.get("quality"), dict) else {}
    metadata = {
        "kind": NATIVE_PROXY_KIND,
        "manifestTextSha256": native.get("textSha256"),
        "manifestQuality": copy.deepcopy(quality),
        "policy": copy.deepcopy(NATIVE_PROXY_POLICY),
    }
    if derived_root is None:
        return {**metadata, "status": "not-requested", "used": False}, None
    if (
        float(quality.get("score") or 0) < NATIVE_PROXY_POLICY["minimumQualityScore"]
        or int(quality.get("characters") or 0) < NATIVE_PROXY_POLICY["minimumCharacters"]
        or quality.get("needsOcr") is not False
        or quality.get("scanLikely") is not False
    ):
        return {**metadata, "status": "manifest-quality-not-trustworthy", "used": False}, None
    case_path = derived_root / f"{rich['caseId']}.json"
    if not case_path.is_file():
        return {**metadata, "status": "derived-case-missing", "used": False}, None
    document = json.loads(case_path.read_text(encoding="utf-8"))
    pages = document.get("pages") if isinstance(document, dict) else None
    if not isinstance(pages, list):
        return {**metadata, "status": "derived-pages-missing", "used": False}, None
    page = next(
        (item for item in pages if isinstance(item, dict) and int(item.get("pageNumber", -1)) == int(rich["pageNumber"])),
        None,
    )
    if page is None:
        return {**metadata, "status": "derived-page-missing", "used": False}, None
    text = page.get("nativeText")
    if not isinstance(text, str) or not text.strip():
        return {**metadata, "status": "derived-native-text-empty", "used": False}, None
    actual_hash = _sha256_bytes(text.encode("utf-8"))
    if actual_hash != native.get("textSha256"):
        return {
            **metadata,
            "status": "derived-native-text-hash-mismatch",
            "used": False,
            "derivedTextSha256": actual_hash,
        }, None
    return {
        **metadata,
        "status": "available",
        "used": True,
        "derivedPath": case_path.as_posix(),
        "derivedArtifactSha256": _sha256_path(case_path),
        "derivedTextSha256": actual_hash,
        "characters": len(text),
        "words": len(normalized_words(text)),
    }, text


def _row_provenance(row: dict, row_number: int) -> dict:
    evidence = {
        name: copy.deepcopy(row[name]) for name in _PROVENANCE_FIELDS if name in row
    }
    return {
        "inputRowNumber": row_number,
        "inputRecordSha256": _sha256_bytes(canonical_json(row)),
        "evidence": evidence,
    }


def _attempt(
    row: dict,
    row_number: int,
    native_text: str | None,
    *,
    include_official_reporter_volume_pages: bool = False,
) -> dict:
    text = row.get("text") if isinstance(row.get("text"), str) else ""
    status = str(row.get("status") or "")
    errors = row.get("errors") if isinstance(row.get("errors"), list) else []
    warnings = row.get("warnings") if isinstance(row.get("warnings"), list) else []
    termination = row.get("termination") if isinstance(row.get("termination"), dict) else {}
    runtime = row.get("runtime") if isinstance(row.get("runtime"), dict) else {}
    milliseconds = runtime.get("milliseconds")
    if milliseconds is not None:
        try:
            milliseconds = float(milliseconds)
        except (TypeError, ValueError) as error:
            raise RuntimeError(f"OCR result row {row_number} has nonnumeric runtime") from error
        if not math.isfinite(milliseconds) or milliseconds < 0:
            raise RuntimeError(f"OCR result row {row_number} has invalid runtime")
    attempt = {
        "engine": copy.deepcopy(row.get("engine") or {}),
        "model": copy.deepcopy(row.get("model") or {}),
        "status": status,
        "succeeded": status == "succeeded",
        "hasText": bool(text.strip()),
        "hasErrors": bool(errors),
        "errorCount": len(errors),
        "warningCount": len(warnings),
        "errors": copy.deepcopy(errors),
        "warnings": copy.deepcopy(warnings),
        "termination": {
            "truncationKnown": termination.get("truncationKnown"),
            "truncated": termination.get("truncated"),
            "stopReason": termination.get("stopReason"),
            "finishReason": termination.get("finishReason"),
        },
        "runtimeMilliseconds": _rounded(milliseconds),
        "text": {
            "characters": len(text),
            "normalizedCharacters": len(_clean_text(text)),
            "words": len(normalized_words(text)),
            "lines": len(text.splitlines()) if text else 0,
            "unclearMarkers": text.count("\u27e6unclear\u27e7"),
            "sha256": _sha256_bytes(text.encode("utf-8")),
        },
        "legalSignals": legal_signals(
            text,
            include_official_reporter_volume_pages=(
                include_official_reporter_volume_pages
            ),
        ),
        "provenance": _row_provenance(row, row_number),
        "nativeTextProxy": (
            {
                "kind": NATIVE_PROXY_KIND,
                **_full_comparison(
                    text,
                    native_text,
                    include_official_reporter_volume_pages=(
                        include_official_reporter_volume_pages
                    ),
                ),
            }
            if native_text is not None and status == "succeeded" and bool(text.strip())
            else None
        ),
    }
    return attempt


def _cross_engine(
    left: dict,
    right: dict,
    *,
    include_official_reporter_volume_pages: bool = False,
) -> dict:
    left_text = left["_rawText"]
    right_text = right["_rawText"]
    comparison = _full_comparison(
        left_text,
        right_text,
        include_official_reporter_volume_pages=(
            include_official_reporter_volume_pages
        ),
    )
    return {
        "leftEngine": left["engine"]["name"],
        "rightEngine": right["engine"]["name"],
        **comparison,
    }


def _is_official_topical_index_job(rich: dict) -> bool:
    source = rich.get("source") if isinstance(rich.get("source"), dict) else {}
    benchmark = (
        rich.get("benchmark") if isinstance(rich.get("benchmark"), dict) else {}
    )
    return (
        source.get("kind") == "official-supporting-index"
        and str(benchmark.get("category") or "").startswith("topical-index-")
    )


def _legal_unit_sort_key(value: tuple[str, str]) -> tuple[int, str, str]:
    kind, canonical = value
    return (_CITATION_KIND_ORDER.get(kind, 999), kind, canonical)


def _all_equal(values: Sequence[Any]) -> bool:
    return not values or all(value == values[0] for value in values[1:])


def _page_legal_citation_review(attempts: list[dict]) -> dict:
    """Compare exact and typography-only canonical units without adjudication."""
    compared = sorted(
        (attempt for attempt in attempts if attempt["hasText"]),
        key=lambda attempt: str(attempt["engine"]["name"]),
    )
    excluded = [
        {
            "engine": attempt["engine"]["name"],
            "reason": "empty-text-layer",
            "status": attempt["status"],
        }
        for attempt in sorted(
            (attempt for attempt in attempts if not attempt["hasText"]),
            key=lambda attempt: str(attempt["engine"]["name"]),
        )
    ]
    records_by_engine: dict[str, list[dict]] = {
        str(attempt["engine"]["name"]): list(
            attempt["legalSignals"].get("citations", [])
        )
        for attempt in compared
    }
    exact_counters: list[Counter[tuple[str, str]]] = []
    canonical_counters: list[Counter[tuple[str, str]]] = []
    for attempt in compared:
        records = records_by_engine[str(attempt["engine"]["name"])]
        exact_counters.append(
            Counter((item["type"], item["text"]) for item in records)
        )
        canonical_counters.append(
            Counter((item["type"], item["canonical"]) for item in records)
        )

    canonical_units = sorted(
        set().union(*(counter.keys() for counter in canonical_counters)),
        key=_legal_unit_sort_key,
    ) if canonical_counters else []
    units = []
    for kind, canonical in canonical_units:
        readings = []
        exact_by_engine: list[Counter[str]] = []
        for attempt in compared:
            engine = str(attempt["engine"]["name"])
            records = [
                item for item in records_by_engine[engine]
                if item["type"] == kind and item["canonical"] == canonical
            ]
            exact_counter = Counter(item["text"] for item in records)
            exact_by_engine.append(exact_counter)
            forms = []
            for written in sorted(exact_counter):
                forms.append({
                    "text": written,
                    "occurrences": exact_counter[written],
                    "spans": [
                        {"start": int(item["start"]), "end": int(item["end"])}
                        for item in records if item["text"] == written
                    ],
                })
            readings.append({
                "engine": engine,
                "occurrences": len(records),
                "exactForms": forms,
            })
        counts = [reading["occurrences"] for reading in readings]
        present = [
            reading["engine"] for reading in readings if reading["occurrences"]
        ]
        if len(compared) < 2:
            unit_status = "insufficientEngineEvidence"
        elif _all_equal(counts):
            unit_status = (
                "unanimousExactAgreement"
                if _all_equal(exact_by_engine)
                else "unanimousCanonicalAgreement"
            )
        elif len(present) == 1:
            unit_status = "engineUniqueReading"
        else:
            unit_status = "disagreement"

        engines_by_exact_form: dict[str, set[str]] = defaultdict(set)
        for reading in readings:
            for form in reading["exactForms"]:
                engines_by_exact_form[form["text"]].add(reading["engine"])
        for reading in readings:
            for form in reading["exactForms"]:
                form["uniqueToThisEngine"] = (
                    len(engines_by_exact_form[form["text"]]) == 1
                )
        units.append({
            "type": kind,
            "canonical": canonical,
            "status": unit_status,
            "presentInEngines": present,
            "absentFromEngines": [
                reading["engine"] for reading in readings
                if not reading["occurrences"]
            ],
            "engineReadings": readings,
        })

    compared_count = len(compared)
    if compared_count < 2:
        page_status = "insufficientEngineEvidence"
    elif not canonical_units:
        page_status = "noRecognizedLegalUnits"
    elif _all_equal(canonical_counters):
        page_status = (
            "unanimousExactAgreement"
            if _all_equal(exact_counters)
            else "unanimousCanonicalAgreement"
        )
    else:
        page_status = "disagreement"

    status_counts = Counter(unit["status"] for unit in units)
    unique_exact_forms = sum(
        form["uniqueToThisEngine"]
        for unit in units
        for reading in unit["engineReadings"]
        for form in reading["exactForms"]
    )
    return {
        "schemaVersion": 1,
        "contract": LEGAL_CITATION_REVIEW_CONTRACT,
        "selection": "none",
        "adjudication": "none",
        "majorityVote": "not-performed",
        "scope": "all nonempty returned engine layers; layer status and truncation are retained",
        "comparisonUnit": (
            "per-page legal-unit multisets; citation order is ignored and duplicate "
            "occurrence counts are preserved"
        ),
        "normalizationPolicy": (
            "Canonical units normalize reporter/authority punctuation, section symbols, "
            "horizontal spacing, and volume-page dash glyphs only. Digits, reporter pages, "
            "section suffixes, subsection tokens and their case remain distinct. INA and USC "
            "citations are not crosswalked or treated as equivalent."
        ),
        "status": page_status,
        "comparedEngines": [
            {
                "engine": attempt["engine"]["name"],
                "status": attempt["status"],
                "truncationKnown": attempt["termination"]["truncationKnown"],
                "truncated": attempt["termination"]["truncated"],
                "citationOccurrences": attempt["legalSignals"]["citationCount"],
            }
            for attempt in compared
        ],
        "excludedEngines": excluded,
        "citationTypes": sorted(
            {unit["type"] for unit in units},
            key=lambda kind: (_CITATION_KIND_ORDER.get(kind, 999), kind),
        ),
        "canonicalUnitCount": len(units),
        "unitStatusCounts": dict(sorted(status_counts.items())),
        "canonicalUnitsWithAnyDisagreement": sum(
            unit["status"] in {"disagreement", "engineUniqueReading"}
            for unit in units
        ),
        "engineUniqueCanonicalUnitCount": status_counts["engineUniqueReading"],
        "exactWrittenFormsUniqueToOneEngine": unique_exact_forms,
        "units": units,
    }


def _engine_summary(engine: str, attempts: list[dict]) -> dict:
    runtimes = [
        item["runtimeMilliseconds"] for item in attempts
        if item["runtimeMilliseconds"] is not None
    ]
    lengths = [item["text"]["characters"] for item in attempts if item["hasText"]]
    proxy = [item["nativeTextProxy"] for item in attempts if item["nativeTextProxy"]]
    citation_proxy = [
        item["exactLegalCitations"] for item in proxy
        if item["exactLegalCitations"]["referenceCount"] > 0
    ]
    canonical_citation_proxy = [
        item["canonicalLegalCitations"] for item in proxy
        if item["canonicalLegalCitations"]["referenceCount"] > 0
    ]
    citations_by_type: Counter[str] = Counter()
    marker_totals: Counter[str] = Counter()
    distinct_exact_citations: set[str] = set()
    for attempt in attempts:
        signals = attempt["legalSignals"]
        for kind, values in signals["citationsByType"].items():
            citations_by_type[kind] += len(values)
            distinct_exact_citations.update(_citation_key(kind, value) for value in values)
        marker_totals.update(signals["legalMarkerCounts"])
    variants = sorted({
        json.dumps(
            {"engine": item["engine"], "model": item["model"]},
            ensure_ascii=False, sort_keys=True,
        )
        for item in attempts
    })
    return {
        "engine": engine,
        "attempts": len(attempts),
        "succeeded": sum(item["succeeded"] for item in attempts),
        "failed": sum(not item["succeeded"] for item in attempts),
        "withErrors": sum(item["hasErrors"] for item in attempts),
        "withWarnings": sum(item["warningCount"] > 0 for item in attempts),
        "withText": sum(item["hasText"] for item in attempts),
        "truncated": sum(item["termination"]["truncated"] is True for item in attempts),
        "knownNonTruncated": sum(
            item["termination"]["truncationKnown"] is True
            and item["termination"]["truncated"] is False
            for item in attempts
        ),
        "unknownTruncation": sum(
            item["termination"]["truncationKnown"] is not True for item in attempts
        ),
        "runtimeMilliseconds": {
            "observations": len(runtimes),
            "mean": _mean(runtimes),
            "median": _median(runtimes),
            "p95NearestRank": _percentile95(runtimes),
            "total": _rounded(sum(runtimes)) if runtimes else None,
        },
        "textCharacters": {
            "observations": len(lengths),
            "mean": _mean(lengths),
            "median": _median(lengths),
            "total": sum(lengths),
        },
        "exactLegalSignals": {
            "pagesWithAnyCitation": sum(
                item["legalSignals"]["citationCount"] > 0 for item in attempts
            ),
            "citationOccurrences": sum(citations_by_type.values()),
            "distinctExactCitationStrings": len(distinct_exact_citations),
            "citationOccurrencesByType": dict(sorted(citations_by_type.items())),
            "legalMarkerCounts": dict(sorted(marker_totals.items())),
        },
        "nativeTextProxy": {
            "kind": NATIVE_PROXY_KIND,
            "comparisons": len(proxy),
            "meanNormalizedCharacterEditSimilarity": _mean(
                item["normalizedCharacterEditSimilarity"] for item in proxy
            ),
            "meanCharacterErrorRateProxy": _mean(
                item["characterErrorRateProxy"] for item in proxy
            ),
            "meanNormalizedWordEditSimilarity": _mean(
                item["normalizedWordEditSimilarity"] for item in proxy
            ),
            "meanWordErrorRateProxy": _mean(item["wordErrorRateProxy"] for item in proxy),
            "pagesWithReferenceLegalCitations": len(citation_proxy),
            "meanExactLegalCitationRecall": _mean(
                item["recall"] for item in citation_proxy
            ),
            "meanExactLegalCitationPrecision": _mean(
                item["precision"] for item in citation_proxy
            ),
            "meanCanonicalLegalCitationRecall": _mean(
                item["recall"] for item in canonical_citation_proxy
            ),
            "meanCanonicalLegalCitationPrecision": _mean(
                item["precision"] for item in canonical_citation_proxy
            ),
        },
        "engineModelVariants": [json.loads(item) for item in variants],
    }


def _cross_summary(comparisons: list[dict]) -> dict:
    grouped: dict[tuple[str, str], list[dict]] = defaultdict(list)
    for item in comparisons:
        grouped[(item["leftEngine"], item["rightEngine"])].append(item)
    pairs = []
    for (left, right), values in sorted(grouped.items()):
        citation_values = [
            item["exactLegalCitations"] for item in values
            if item["exactLegalCitations"]["candidateCount"]
            or item["exactLegalCitations"]["referenceCount"]
        ]
        canonical_citation_values = [
            item["canonicalLegalCitations"] for item in values
            if item["canonicalLegalCitations"]["candidateCount"]
            or item["canonicalLegalCitations"]["referenceCount"]
        ]
        pairs.append({
            "leftEngine": left,
            "rightEngine": right,
            "pagesCompared": len(values),
            "meanNormalizedWordEditSimilarity": _mean(
                item["normalizedWordEditSimilarity"] for item in values
            ),
            "meanNormalizedCharacterEditSimilarity": _mean(
                item["normalizedCharacterEditSimilarity"] for item in values
            ),
            "normalizedTextExactMatches": sum(
                item["normalizedTextExactMatch"] for item in values
            ),
            "pagesWithAnyExactLegalCitation": len(citation_values),
            "meanExactLegalCitationF1": _mean(item["f1"] for item in citation_values),
            "exactLegalCitationMultisetMatches": sum(
                item["exactMultisetMatch"] for item in citation_values
            ),
            "meanCanonicalLegalCitationF1": _mean(
                item["f1"] for item in canonical_citation_values
            ),
            "canonicalLegalCitationMultisetMatches": sum(
                item["exactMultisetMatch"] for item in canonical_citation_values
            ),
            "meanLegalMarkerCountAgreement": _mean(
                item["legalMarkers"]["countAgreement"] for item in values
            ),
        })
    return {
        "comparisonUnit": "same-page successful nonempty engine layers",
        "pagePairsCompared": len(comparisons),
        "enginePairs": pairs,
        "meanNormalizedWordEditSimilarity": _mean(
            item["normalizedWordEditSimilarity"] for item in comparisons
        ),
        "meanNormalizedCharacterEditSimilarity": _mean(
            item["normalizedCharacterEditSimilarity"] for item in comparisons
        ),
    }


def build_benchmark(
    manifest_path: Path,
    results_path: Path,
    *,
    derived_root: Path | None = None,
    require_all_jobs: bool = False,
    expected_worker_commit: str | None = None,
    expected_ovis_file_store_executor_sha256: str | None = None,
) -> dict:
    """Build a deterministic report without selecting any OCR layer."""
    manifest_path = manifest_path.resolve()
    results_path = results_path.resolve()
    if derived_root is not None:
        derived_root = derived_root.resolve()
    worker_pin = normalize_worker_commit_pin(expected_worker_commit)
    executor_pin = normalize_ovis_executor_pin(
        expected_ovis_file_store_executor_sha256
    )
    ordered_jobs, rich_by_job = _load_manifest(manifest_path)
    rows = _load_results(
        results_path,
        rich_by_job,
        expected_worker_commit=worker_pin,
        expected_ovis_file_store_executor_sha256=executor_pin,
    )
    rows_by_job: dict[str, list[tuple[int, dict]]] = defaultdict(list)
    for row_number, row in enumerate(rows, start=1):
        rows_by_job[str(row["jobId"])].append((row_number, row))
    missing = [job["jobId"] for job in ordered_jobs if job["jobId"] not in rows_by_job]
    if require_all_jobs and missing:
        raise RuntimeError(
            f"OCR results are missing {len(missing)} manifest job(s): {', '.join(missing[:10])}"
        )

    pages = []
    all_attempts: dict[str, list[dict]] = defaultdict(list)
    all_cross: list[dict] = []
    reference_statuses: Counter[str] = Counter()
    for rich in ordered_jobs:
        include_official_reporter_volume_pages = _is_official_topical_index_job(rich)
        native_metadata, native_text = _native_reference(rich, derived_root)
        reference_statuses[native_metadata["status"]] += 1
        attempts = []
        cross_inputs = []
        for row_number, row in sorted(
            rows_by_job.get(rich["jobId"], []),
            key=lambda item: str(item[1]["engine"]["name"]),
        ):
            attempt = _attempt(
                row,
                row_number,
                native_text,
                include_official_reporter_volume_pages=(
                    include_official_reporter_volume_pages
                ),
            )
            attempts.append(attempt)
            all_attempts[attempt["engine"]["name"]].append(attempt)
            if attempt["succeeded"] and attempt["hasText"]:
                cross_inputs.append({
                    "engine": attempt["engine"],
                    "_rawText": row["text"],
                })
        page_cross = [
            _cross_engine(
                left,
                right,
                include_official_reporter_volume_pages=(
                    include_official_reporter_volume_pages
                ),
            )
            for left, right in combinations(cross_inputs, 2)
        ]
        all_cross.extend(page_cross)
        pages.append({
            "jobId": rich["jobId"],
            "caseId": rich["caseId"],
            "pageNumber": int(rich["pageNumber"]),
            "category": rich.get("benchmark", {}).get("category"),
            "reviewFocus": rich.get("benchmark", {}).get("reviewFocus"),
            "nativeTextProxyReference": native_metadata,
            "attempts": attempts,
            "crossEngineComparisons": page_cross,
            "legalCitationReview": _page_legal_citation_review(attempts),
        })

    engine_summaries = [
        _engine_summary(engine, attempts)
        for engine, attempts in sorted(all_attempts.items())
    ]
    legal_review_statuses = Counter(
        page["legalCitationReview"]["status"] for page in pages
    )
    return {
        "schemaVersion": 1,
        "contract": BENCHMARK_CONTRACT,
        "selection": "none; every OCR layer remains unreviewed evidence",
        "adjudication": "none",
        "nativeTextComparisonDisclaimer": (
            "Publisher-PDF native text comparisons are automated proxies, not human transcription gold."
        ),
        "inputs": {
            "manifest": {
                "path": manifest_path.as_posix(),
                "sha256": _sha256_path(manifest_path),
            },
            "results": {
                "path": results_path.as_posix(),
                "sha256": _sha256_path(results_path),
            },
            "derivedRoot": derived_root.as_posix() if derived_root is not None else None,
            **({
                "provenancePins": {
                    "expectedWorkerCommit": worker_pin,
                    "expectedOvisFileStoreExecutorSha256": executor_pin,
                },
            } if worker_pin is not None or executor_pin is not None else {}),
        },
        "coverage": {
            "jobsInManifest": len(ordered_jobs),
            "jobsWithResults": len(ordered_jobs) - len(missing),
            "missingJobIds": missing,
            "layersEvaluated": len(rows),
            "enginesObserved": len(engine_summaries),
            "nativeTextProxyReferenceStatuses": dict(sorted(reference_statuses.items())),
        },
        "engines": engine_summaries,
        "crossEngine": _cross_summary(all_cross),
        "legalCitationReview": {
            "contract": LEGAL_CITATION_REVIEW_CONTRACT,
            "selection": "none",
            "adjudication": "none",
            "pageStatusCounts": dict(sorted(legal_review_statuses.items())),
            "pagesWithCanonicalDisagreement": sum(
                page["legalCitationReview"]["status"] == "disagreement"
                for page in pages
            ),
            "engineUniqueCanonicalUnits": sum(
                page["legalCitationReview"]["engineUniqueCanonicalUnitCount"]
                for page in pages
            ),
        },
        "pages": pages,
    }


def _percent(numerator: int, denominator: int) -> str:
    return "\u2014" if not denominator else f"{100 * numerator / denominator:.1f}%"


def _metric(value: Any, digits: int = 3) -> str:
    if value is None:
        return "\u2014"
    if isinstance(value, int):
        return str(value)
    return f"{float(value):.{digits}f}"


def _markdown_written(value: str, limit: int = 64) -> str:
    rendered = value.replace("\r", "\\r").replace("\n", "\\n")
    rendered = rendered.replace("|", "\\|")
    if len(rendered) > limit:
        rendered = rendered[:limit - 1] + "…"
    return f"“{rendered}”"


def _legal_review_examples(review: dict, limit: int = 4) -> str:
    priority = {
        "engineUniqueReading": 0,
        "disagreement": 1,
        "unanimousCanonicalAgreement": 2,
    }
    candidates = sorted(
        (
            unit for unit in review["units"]
            if unit["status"] in priority
        ),
        key=lambda unit: (
            priority[unit["status"]],
            _legal_unit_sort_key((unit["type"], unit["canonical"])),
        ),
    )
    examples = []
    for unit in candidates[:limit]:
        readings = []
        for reading in unit["engineReadings"]:
            forms = reading["exactForms"]
            if forms:
                written = ", ".join(
                    f"{_markdown_written(form['text'])}×{form['occurrences']}"
                    for form in forms[:2]
                )
                if len(forms) > 2:
                    written += f", +{len(forms) - 2} form(s)"
            else:
                written = "∅"
            readings.append(f"{reading['engine']}={written}")
        label = {
            "engineUniqueReading": "engine-unique",
            "disagreement": "disagreement",
            "unanimousCanonicalAgreement": "canonical-only agreement",
        }[unit["status"]]
        examples.append(
            f"{unit['type']} `{unit['canonical']}` ({label}: "
            f"{'; '.join(readings)})"
        )
    if len(candidates) > limit:
        examples.append(f"+{len(candidates) - limit} more in JSON")
    return "<br>".join(examples) if examples else "—"


def benchmark_markdown(report: dict) -> str:
    """Render the concise human-readable view of a benchmark JSON report."""
    coverage = report["coverage"]
    lines = [
        "# OCR smoke benchmark",
        "",
        "No OCR layer was selected or adjudicated. Publisher-PDF native-text comparisons are proxies, not human transcription gold.",
        "",
        (
            f"Coverage: {coverage['jobsWithResults']}/{coverage['jobsInManifest']} pages, "
            f"{coverage['layersEvaluated']} engine layers, {coverage['enginesObserved']} engines."
        ),
        "",
        "## Engine observations",
        "",
        "| Engine | Attempts | Success | Errors | Truncated | Unknown truncation | Median runtime (ms) | Median characters |",
        "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ]
    for engine in report["engines"]:
        lines.append(
            f"| {engine['engine']} | {engine['attempts']} | "
            f"{_percent(engine['succeeded'], engine['attempts'])} | {engine['withErrors']} | "
            f"{engine['truncated']} | {engine['unknownTruncation']} | "
            f"{_metric(engine['runtimeMilliseconds']['median'], 1)} | "
            f"{_metric(engine['textCharacters']['median'], 0)} |"
        )

    lines.extend([
        "",
        "## Cross-engine agreement",
        "",
        "| Engine pair | Pages | Word edit similarity | Character edit similarity | Exact-citation F1 | Canonical-citation F1 | Legal-marker agreement |",
        "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    ])
    for pair in report["crossEngine"]["enginePairs"]:
        lines.append(
            f"| {pair['leftEngine']} / {pair['rightEngine']} | {pair['pagesCompared']} | "
            f"{_metric(pair['meanNormalizedWordEditSimilarity'])} | "
            f"{_metric(pair['meanNormalizedCharacterEditSimilarity'])} | "
            f"{_metric(pair['meanExactLegalCitationF1'])} | "
            f"{_metric(pair['meanCanonicalLegalCitationF1'])} | "
            f"{_metric(pair['meanLegalMarkerCountAgreement'])} |"
        )

    lines.extend([
        "",
        "## Legal-citation review flags",
        "",
        (
            "These are deterministic comparison flags, not votes or legal conclusions. "
            "Canonicalization changes typography only; reporter pages, section numbers, "
            "suffixes, and every subsection token remain distinct. Exact written forms "
            "and offsets are retained in the JSON report."
        ),
        "",
        "| Page | Page status | Compared layers | Exact-agreed units | Canonical-only units | Disagreement units | Engine-unique units | Examples |",
        "| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |",
    ])
    status_labels = {
        "unanimousExactAgreement": "unanimous exact agreement",
        "unanimousCanonicalAgreement": "unanimous canonical agreement",
        "disagreement": "citation disagreement",
        "noRecognizedLegalUnits": "no recognized legal units",
        "insufficientEngineEvidence": "insufficient engine evidence",
    }
    for page in report["pages"]:
        review = page["legalCitationReview"]
        compared = review["comparedEngines"]
        incomplete = sum(
            item["status"] != "succeeded" or item["truncated"] is True
            for item in compared
        )
        compared_label = f"{len(compared)}/{len(page['attempts'])}"
        if incomplete:
            compared_label += f" ({incomplete} incomplete)"
        counts = review["unitStatusCounts"]
        lines.append(
            f"| {page['caseId']} p.{page['pageNumber']} | "
            f"{status_labels[review['status']]} | {compared_label} | "
            f"{counts.get('unanimousExactAgreement', 0)} | "
            f"{counts.get('unanimousCanonicalAgreement', 0)} | "
            f"{review['canonicalUnitsWithAnyDisagreement']} | "
            f"{review['engineUniqueCanonicalUnitCount']} | "
            f"{_legal_review_examples(review)} |"
        )

    lines.extend([
        "",
        "## Native-text proxy (not human gold)",
        "",
        "| Engine | Proxy pages | Word error rate | Character error rate | Exact-citation recall | Canonical-citation recall |",
        "| --- | ---: | ---: | ---: | ---: | ---: |",
    ])
    for engine in report["engines"]:
        proxy = engine["nativeTextProxy"]
        lines.append(
            f"| {engine['engine']} | {proxy['comparisons']} | "
            f"{_metric(proxy['meanWordErrorRateProxy'])} | "
            f"{_metric(proxy['meanCharacterErrorRateProxy'])} | "
            f"{_metric(proxy['meanExactLegalCitationRecall'])} | "
            f"{_metric(proxy['meanCanonicalLegalCitationRecall'])} |"
        )

    attention = []
    for page in report["pages"]:
        for attempt in page["attempts"]:
            reasons = []
            if not attempt["succeeded"]:
                reasons.append("failed")
            if attempt["hasErrors"]:
                reasons.append("errors")
            if not attempt["hasText"]:
                reasons.append("empty")
            if attempt["termination"]["truncated"] is True:
                reasons.append("truncated")
            elif attempt["termination"]["truncationKnown"] is not True:
                reasons.append("truncation unknown")
            if reasons:
                attention.append((page, attempt, ", ".join(reasons)))
    if attention:
        lines.extend([
            "",
            "## Mechanical review flags",
            "",
            "| Page | Engine | Flags |",
            "| --- | --- | --- |",
        ])
        for page, attempt, reason in attention:
            lines.append(
                f"| {page['caseId']} p.{page['pageNumber']} | "
                f"{attempt['engine']['name']} | {reason} |"
            )
    lines.extend(["", "All detailed per-layer metrics and provenance remain in the JSON report.", ""])
    return "\n".join(lines)


def write_benchmark(
    manifest_path: Path,
    results_path: Path,
    json_output: Path,
    markdown_output: Path,
    *,
    derived_root: Path | None = None,
    require_all_jobs: bool = False,
    expected_worker_commit: str | None = None,
    expected_ovis_file_store_executor_sha256: str | None = None,
) -> dict:
    report = build_benchmark(
        manifest_path,
        results_path,
        derived_root=derived_root,
        require_all_jobs=require_all_jobs,
        expected_worker_commit=expected_worker_commit,
        expected_ovis_file_store_executor_sha256=(
            expected_ovis_file_store_executor_sha256
        ),
    )
    json_bytes = json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True).encode("utf-8") + b"\n"
    markdown_bytes = benchmark_markdown(report).encode("utf-8")
    atomic_write(json_output.resolve(), json_bytes)
    atomic_write(markdown_output.resolve(), markdown_bytes)
    return {
        "schemaVersion": 1,
        "valid": True,
        "selection": "none",
        "jobsWithResults": report["coverage"]["jobsWithResults"],
        "layersEvaluated": report["coverage"]["layersEvaluated"],
        "json": json_output.resolve().as_posix(),
        "jsonSha256": _sha256_bytes(json_bytes),
        "markdown": markdown_output.resolve().as_posix(),
        "markdownSha256": _sha256_bytes(markdown_bytes),
    }
