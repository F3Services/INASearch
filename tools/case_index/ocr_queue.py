"""Deterministic severe-first OCR queue and benchmark-gold manifests."""

from __future__ import annotations

import hashlib
import json
import re
import struct
from collections import Counter
from pathlib import Path

from .documents import atomic_write, load_jsonl


LEGAL_TOKEN_RE = re.compile(
    r"(?:\bINA\s+§|\b8\s+U\.\s*S\.\s*C\.|\b8\s+C\.\s*F\.\s*R\.|\b\d{1,2}\s+I\s*(?:&|and)\s*N(?:\.\s*|\s+)Dec\.)",
    re.IGNORECASE,
)
TREATMENT_RE = re.compile(
    r"\b(?:overrul(?:e|ed|ing)|supersed(?:e|ed|ing)|modify|modified|clarif(?:y|ied)|distinguish(?:ed)?|decline\s+to\s+follow|not\s+controlling)\b",
    re.IGNORECASE,
)
FOOTNOTE_RE = re.compile(r"(?m)(?:^|\n)\s*(?:\d{1,2}|\*{1,3})[.)]?\s+|\b(?:footnote|n\.)\s*\d+", re.IGNORECASE)
HYPHENATION_RE = re.compile(r"[A-Za-z]{2,}-\n[A-Za-z]{2,}")
ANNOTATION_REQUIREMENTS = [
    "verbatim legal citations and every parenthetical unit",
    "I&N case citations",
    "treatment verbs and their subjects/objects",
    "negation and limiting scope",
    "footnote markers and attachment",
    "disposition language",
    "unreadable and omitted regions",
]


def _sha(value: str | bytes) -> str:
    if isinstance(value, str):
        value = value.encode("utf-8")
    return hashlib.sha256(value).hexdigest()


def _png_info(path: Path) -> dict | None:
    if not path.exists():
        return None
    header = path.read_bytes()[:24]
    if len(header) < 24 or header[:8] != b"\x89PNG\r\n\x1a\n":
        return None
    width, height = struct.unpack(">II", header[16:24])
    return {"path": path.as_posix(), "sha256": _sha(path.read_bytes()), "width": width, "height": height}


def priority_for(page: dict) -> tuple[int, str, list[str], dict]:
    text = page.get("nativeText", "")
    quality = page["quality"]
    characters = int(quality.get("characters", len(text.strip())))
    legal_count = len(LEGAL_TOKEN_RE.findall(text))
    treatment_count = len(TREATMENT_RE.findall(text))
    footnote_count = len(FOOTNOTE_RE.findall(text))
    hyphenation_count = len(HYPHENATION_RE.findall(text))
    reasons: list[str] = []
    if characters == 0:
        score, band = 100_000, "critical-textless"
        reasons.append("native extraction is empty")
    elif characters < 80:
        score, band = 95_000 + (80 - characters), "critical-near-textless"
        reasons.append(f"native extraction has only {characters} characters")
    elif quality.get("score", 1) < 0.68:
        score, band = 85_000 + round((0.68 - quality["score"]) * 10_000), "severe-low-quality"
        reasons.append(f"native quality score is {quality['score']}")
    elif quality.get("scanLikely"):
        score, band = 50_000, "scan-rebenchmark"
        reasons.append("page is backed by a full-page raster scan")
    else:
        score, band = 20_000, "quality-review"
        reasons.append(f"native quality score is {quality.get('score')}")
    suspicious = int(quality.get("suspiciousTokenCount", 0))
    if suspicious:
        score += min(500, suspicious * 20)
        reasons.append(f"native extraction has {suspicious} suspicious OCR-like tokens")
    if legal_count:
        score += min(300, legal_count * 15)
        reasons.append(f"page contains {legal_count} legal-citation signals")
    if treatment_count:
        score += min(300, treatment_count * 50)
        reasons.append(f"page contains {treatment_count} case-treatment signals")
    signals = {
        "legalTokenCount": legal_count,
        "treatmentSignalCount": treatment_count,
        "footnoteSignalCount": footnote_count,
        "lineEndHyphenationCount": hyphenation_count,
    }
    return score, band, reasons, signals


def queue_entry(repo_root: Path, case_root: Path, document: dict, page: dict, dpi: int = 300) -> dict:
    case = document["case"]
    artifact = document["sourceArtifact"]
    score, band, reasons, signals = priority_for(page)
    image_path = case_root / "renders" / case["corpusKey"] / f"page-{int(page['pageNumber']):04d}.png"
    image = _png_info(image_path)
    try:
        relative_image = image_path.relative_to(repo_root).as_posix()
    except ValueError:
        relative_image = image_path.as_posix()
    if image:
        image["path"] = relative_image
    identity = {
        "caseId": case["corpusKey"],
        "pageNumber": int(page["pageNumber"]),
        "sourcePdfSha256": artifact["sha256"],
        "nativeTextSha256": _sha(page.get("nativeText", "")),
        "renderDpi": dpi,
    }
    return {
        "schemaVersion": 1,
        "queueId": "ocr-job-" + _sha(json.dumps(identity, sort_keys=True))[:32],
        **identity,
        "sourceKind": "published-case",
        "case": {
            "officialCitation": case.get("officialCitation"),
            "caseName": case.get("caseName"),
            "decidingBody": case.get("decidingBody"),
            "decisionYear": case.get("decisionYear"),
            "volume": case.get("volume"),
            "sourceCollection": case.get("sourceCollection"),
        },
        "source": {
            "pdfPath": artifact["path"],
            "pdfSha256": artifact["sha256"],
            "publisherUrl": artifact.get("finalUrl"),
        },
        "render": {
            "dpi": dpi,
            "format": "png",
            "outputPath": relative_image,
            "existingImage": image,
        },
        "preprocessingRequirements": {
            "retainUncroppedRender": True,
            "allowed": ["orientation-correction", "deskew", "contrast", "content-crop-with-safety-margin", "region-tiles"],
            "cropSafetyMarginPixelsAt300Dpi": 75,
            "requireForwardAndInverseMatrices": True,
            "returnCoordinatesIn": "rendered-page-pixels-top-left",
        },
        "priority": score,
        "priorityBand": band,
        "priorityReasons": reasons,
        "nativeQuality": page["quality"],
        "signals": signals,
        "existingOcrLayerIds": sorted(layer.get("layerId") for layer in page.get("ocrLayers", []) if layer.get("layerId")),
        "resultContract": {
            "format": "JSONL, one immutable result object per engine/model/page attempt",
            "selection": "none; importing a result never selects it",
        },
    }


def supporting_queue_entries(repo_root: Path, case_root: Path, dpi: int = 300) -> list[dict]:
    manifest = json.loads((case_root / "supporting" / "manifest.json").read_text(encoding="utf-8"))
    output: list[dict] = []
    for artifact in manifest["artifacts"]:
        if artifact.get("hasTextLayer") is not False or artifact.get("scan", {}).get("ocrRequired") is not True:
            continue
        pdf_path = case_root / artifact["localPath"]
        if _sha(pdf_path.read_bytes()) != artifact["sha256"]:
            raise RuntimeError(f"Supporting source checksum mismatch: {artifact['id']}")
        for page_number in range(1, int(artifact["pages"]) + 1):
            identity = {
                "caseId": artifact["id"],
                "pageNumber": page_number,
                "sourcePdfSha256": artifact["sha256"],
                "nativeTextSha256": _sha(""),
                "renderDpi": dpi,
            }
            image_path = case_root / "supporting" / "renders" / f"{artifact['id']}-page-{page_number:04d}.png"
            try:
                relative_image = image_path.relative_to(repo_root).as_posix()
            except ValueError:
                relative_image = image_path.as_posix()
            image = _png_info(image_path)
            if image:
                image["path"] = relative_image
            output.append({
                "schemaVersion": 1,
                "queueId": "ocr-job-" + _sha(json.dumps(identity, sort_keys=True))[:32],
                **identity,
                "sourceKind": "official-supporting-index",
                "case": {
                    "officialCitation": None,
                    "caseName": artifact["title"],
                    "decidingBody": "EOIR",
                    "decisionYear": None,
                    "volume": None,
                    "sourceCollection": "eoir-supporting-topical-index",
                },
                "source": {
                    "pdfPath": (case_root / artifact["localPath"]).relative_to(repo_root).as_posix(),
                    "pdfSha256": artifact["sha256"],
                    "publisherUrl": artifact["sourceUrl"],
                },
                "render": {
                    "dpi": dpi, "format": "png", "outputPath": relative_image, "existingImage": image,
                },
                "preprocessingRequirements": {
                    "retainUncroppedRender": True,
                    "allowed": ["orientation-correction", "deskew", "contrast", "content-crop-with-safety-margin", "region-tiles"],
                    "cropSafetyMarginPixelsAt300Dpi": 75,
                    "requireForwardAndInverseMatrices": True,
                    "returnCoordinatesIn": "rendered-page-pixels-top-left",
                },
                "priority": 97_000,
                "priorityBand": "official-image-only-topical-index",
                "priorityReasons": [
                    "official EOIR supporting index has no text layer",
                    "two-column layout, indentation, cross-references, and reporter tokens require structured OCR",
                ],
                "nativeQuality": {"score": 0, "needsOcr": True, "characters": 0, "scanLikely": True},
                "signals": {"legalTokenCount": 0, "treatmentSignalCount": 0, "footnoteSignalCount": 0, "lineEndHyphenationCount": 0},
                "existingOcrLayerIds": [],
                "resultContract": {
                    "format": "JSONL, one immutable result object per engine/model/page attempt",
                    "selection": "none; index-derived topics remain supporting evidence and never opinion text",
                },
            })
    return output


def _choose_diverse(candidates: list[dict], count: int, selected: set[tuple[str, int]], max_per_case: int = 2) -> list[dict]:
    chosen: list[dict] = []
    case_counts: Counter[str] = Counter(case_id for case_id, _page in selected)
    for limit in range(1, max_per_case + 1):
        for entry in candidates:
            key = (entry["caseId"], entry["pageNumber"])
            if key in selected or case_counts[entry["caseId"]] >= limit:
                continue
            selected.add(key)
            case_counts[entry["caseId"]] += 1
            chosen.append(entry)
            if len(chosen) == count:
                return chosen
    for entry in candidates:
        key = (entry["caseId"], entry["pageNumber"])
        if key not in selected:
            selected.add(key)
            chosen.append(entry)
            if len(chosen) == count:
                return chosen
    return chosen


def build_gold_set(all_entries: list[dict], queue: list[dict], count: int = 200) -> list[dict]:
    if len(all_entries) < count:
        raise RuntimeError(f"Corpus has only {len(all_entries)} pages; cannot create a {count}-page gold set")
    selected: set[tuple[str, int]] = set()
    strata: list[tuple[str, list[dict]]] = []
    case_queue = [entry for entry in queue if entry.get("sourceKind") == "published-case"]
    hardest = sorted(case_queue, key=lambda item: (-item["priority"], item["caseId"], item["pageNumber"]))
    strata.append(("hardest-double-transcription", _choose_diverse(hardest, 50, selected, 2)))
    legal = sorted(
        case_queue,
        key=lambda item: (
            -item["signals"]["legalTokenCount"], -item["signals"]["treatmentSignalCount"],
            -item["priority"], item["caseId"], item["pageNumber"],
        ),
    )
    strata.append(("legal-and-treatment-dense", _choose_diverse(legal, 50, selected, 1)))
    layout = sorted(
        case_queue,
        key=lambda item: (
            -item["signals"]["footnoteSignalCount"], -item["signals"]["lineEndHyphenationCount"],
            -item["nativeQuality"].get("characters", 0), item["caseId"], item["pageNumber"],
        ),
    )
    strata.append(("footnote-layout-and-hyphenation", _choose_diverse(layout, 40, selected, 1)))

    weak_representative = sorted(
        case_queue,
        key=lambda item: (
            item["case"].get("volume") or 999, item["case"].get("decisionYear") or 9999,
            item["caseId"], item["pageNumber"],
        ),
    )
    strata.append(("historical-scan-coverage", _choose_diverse(weak_representative, 30, selected, 1)))

    topical = [entry for entry in queue if entry.get("sourceKind") == "official-supporting-index"]
    topical_samples: list[dict] = []
    by_source: dict[str, list[dict]] = {}
    for entry in topical:
        by_source.setdefault(entry["caseId"], []).append(entry)
    for source_id in sorted(by_source):
        entries = sorted(by_source[source_id], key=lambda item: item["pageNumber"])
        positions = sorted({round(index * (len(entries) - 1) / 4) for index in range(5)})
        for position in positions:
            entry = entries[position]
            key = (entry["caseId"], entry["pageNumber"])
            if key not in selected:
                selected.add(key)
                topical_samples.append(entry)
    if len(topical_samples) != 10:
        raise RuntimeError(f"Expected ten stratified topical-index samples, found {len(topical_samples)}")
    strata.append(("official-topical-index-layout", topical_samples))
    controls = [entry for entry in all_entries if not entry["nativeQuality"].get("needsOcr")]
    control_sort = lambda item: (
        -(item["case"].get("decisionYear") or 0),
        -item["signals"]["legalTokenCount"], item["caseId"], item["pageNumber"],
    )
    aao_controls = sorted(
        [entry for entry in controls if entry["case"].get("sourceCollection") == "uscis-adopted-aao"],
        key=control_sort,
    )
    eoir_controls = sorted(
        [entry for entry in controls if entry["case"].get("sourceCollection") != "uscis-adopted-aao"],
        key=control_sort,
    )
    balanced_controls = [
        *_choose_diverse(aao_controls, 10, selected, 1),
        *_choose_diverse(eoir_controls, 10, selected, 1),
    ]
    strata.append(("born-digital-controls", balanced_controls))

    output: list[dict] = []
    for stratum, entries in strata:
        for entry in entries:
            output.append({
                **entry,
                "goldSet": {
                    "stratum": stratum,
                    "doubleTranscriptionRequired": stratum == "hardest-double-transcription",
                    "annotationRequirements": ANNOTATION_REQUIREMENTS,
                    "evaluation": [
                        "character and word error rate",
                        "exact legal-token accuracy",
                        "text omission and hallucinated-token rates",
                        "reading order and footnote attachment",
                        "runtime, retry, and truncation outcomes",
                    ],
                },
            })
    if len(output) != count:
        raise RuntimeError(f"Gold-set selection produced {len(output)} pages instead of {count}")
    return output


def generate_manifests(repo_root: Path, case_root: Path, output_root: Path, dpi: int = 300) -> dict:
    captures = {row["corpusKey"]: row for row in load_jsonl(case_root / "capture.jsonl")}
    all_entries: list[dict] = []
    queue: list[dict] = []
    for document_path in sorted((case_root / "derived").glob("*.json")):
        document = json.loads(document_path.read_text(encoding="utf-8"))
        if document["case"]["corpusKey"] not in captures:
            continue
        for page in document["pages"]:
            entry = queue_entry(repo_root, case_root, document, page, dpi)
            all_entries.append(entry)
            if page["quality"]["needsOcr"]:
                queue.append(entry)
    supporting_entries = supporting_queue_entries(repo_root, case_root, dpi)
    all_entries.extend(supporting_entries)
    queue.extend(supporting_entries)
    queue.sort(key=lambda item: (-item["priority"], item["caseId"], item["pageNumber"]))
    gold = build_gold_set(all_entries, queue)
    gold_keys = {(item["caseId"], item["pageNumber"]): item["goldSet"] for item in gold}
    queue = [
        {**item, "goldSet": gold_keys.get((item["caseId"], item["pageNumber"]))}
        for item in queue
    ]
    output_root.mkdir(parents=True, exist_ok=True)
    atomic_write(output_root / "ocr-queue.jsonl", b"".join(json.dumps(item, ensure_ascii=False, sort_keys=True).encode("utf-8") + b"\n" for item in queue))
    atomic_write(output_root / "ocr-gold-set.jsonl", b"".join(json.dumps(item, ensure_ascii=False, sort_keys=True).encode("utf-8") + b"\n" for item in gold))
    summary = {
        "schemaVersion": 1,
        "queuePages": len(queue),
        "queueCases": len({item["caseId"] for item in queue}),
        "priorityBands": dict(sorted(Counter(item["priorityBand"] for item in queue).items())),
        "goldPages": len(gold),
        "goldCases": len({item["caseId"] for item in gold}),
        "doubleTranscriptionPages": sum(item["goldSet"]["doubleTranscriptionRequired"] for item in gold),
        "goldStrata": dict(sorted(Counter(item["goldSet"]["stratum"] for item in gold).items())),
        "transport": "manifests and rendered images are self-contained filesystem artifacts; no HTTP transport is assumed",
    }
    atomic_write(output_root / "ocr-queue-summary.json", (json.dumps(summary, indent=2, sort_keys=True) + "\n").encode("utf-8"))
    return summary
