"""Capture and extract authoritative decision PDFs without losing evidence."""

from __future__ import annotations

import datetime as dt
import fcntl
import hashlib
import json
import os
import re
import subprocess
import tempfile
from pathlib import Path
from typing import Iterable

from .ocr import layer_is_selectable, normalize_ocr_result
from .sources import Fetcher


ANALYSIS_SCHEMA_VERSION = 3
ANALYSIS_INPUTS = (
    "tools/case-citations.js",
    "tools/legal-references.js",
    "src/INASearch-Corpus.js",
    "src/INASearch-CFR.js",
)


def atomic_write(path: Path, value: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(value)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_name, path)
    finally:
        if os.path.exists(temporary_name):
            os.unlink(temporary_name)


def sha256(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def analysis_fingerprint(repo_root: Path) -> str:
    """Identify the exact parser and canonical-law inputs used by derived data."""
    digest = hashlib.sha256(f"case-analysis-schema:{ANALYSIS_SCHEMA_VERSION}\n".encode("utf-8"))
    for relative in ANALYSIS_INPUTS:
        path = repo_root / relative
        digest.update(f"{relative}\0".encode("utf-8"))
        digest.update(path.read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()


def load_jsonl(path: Path) -> list[dict]:
    if not path.exists():
        raise RuntimeError(f"Missing manifest: {path}")
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def merge_jsonl_record(path: Path, record: dict, key: str) -> list[dict]:
    """Atomically merge one record while coordinating concurrent downloaders."""
    path.parent.mkdir(parents=True, exist_ok=True)
    lock_path = path.with_name(f"{path.name}.lock")
    with lock_path.open("a+b") as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        try:
            current = {item[key]: item for item in load_jsonl(path)} if path.exists() else {}
            current[record[key]] = record
            ordered = sorted(current.values(), key=lambda row: row[key])
            atomic_write(
                path,
                "".join(json.dumps(item, ensure_ascii=False, sort_keys=True) + "\n" for item in ordered).encode("utf-8"),
            )
            return ordered
        finally:
            fcntl.flock(lock.fileno(), fcntl.LOCK_UN)


def select_records(records: list[dict], identifiers: list[str] | None = None, limit: int | None = None) -> list[dict]:
    selected = records
    if identifiers:
        wanted = set(identifiers)
        selected = [record for record in records if record["corpusKey"] in wanted or str(record.get("eoirId", "")) in wanted]
        missing = wanted - {record["corpusKey"] for record in selected} - {str(record.get("eoirId", "")) for record in selected}
        if missing:
            raise RuntimeError(f"Unknown case identifiers: {', '.join(sorted(missing))}")
    return selected[:limit] if limit else selected


def download_pdfs(case_root: Path, records: list[dict], fetcher: Fetcher, refresh: bool = False) -> list[dict]:
    raw_root = case_root / "raw"
    existing_path = case_root / "capture.jsonl"
    existing = {item["corpusKey"]: item for item in load_jsonl(existing_path)} if existing_path.exists() else {}
    output = dict(existing)
    failures: list[dict] = []
    for position, record in enumerate(records, start=1):
        corpus_key = record["corpusKey"]
        if record.get("captureRequired") is False:
            print(
                f"[{position}/{len(records)}] unavailable {corpus_key} ({record.get('sourceAvailability', 'publisher-source-gap')})",
                flush=True,
            )
            continue
        pdf_path = raw_root / f"{corpus_key}.pdf"
        old = existing.get(corpus_key)
        if not refresh and old and pdf_path.exists():
            value = pdf_path.read_bytes()
            if len(value) == old["bytes"] and sha256(value) == old["sha256"]:
                print(f"[{position}/{len(records)}] cached {corpus_key}", flush=True)
                continue
        try:
            value, final_url, headers = fetcher.fetch(record["pdfUrl"])
        except Exception as error:
            failure = {"corpusKey": corpus_key, "pdfUrl": record["pdfUrl"], "error": f"{type(error).__name__}: {error}"}
            failures.append(failure)
            print(f"[{position}/{len(records)}] FAILED {corpus_key}: {failure['error']}", flush=True)
            continue
        if not value.startswith(b"%PDF-"):
            content_type = headers.get("content-type", "unknown")
            failure = {
                "corpusKey": corpus_key,
                "pdfUrl": record["pdfUrl"],
                "error": f"Response was not a PDF ({content_type}, {len(value)} bytes): {final_url}",
            }
            failures.append(failure)
            print(f"[{position}/{len(records)}] FAILED {corpus_key}: {failure['error']}", flush=True)
            continue
        atomic_write(pdf_path, value)
        try:
            stored_path = pdf_path.relative_to(case_root.parents[1]).as_posix()
        except ValueError:
            stored_path = pdf_path.as_posix()
        capture = {
            "schemaVersion": 1,
            "corpusKey": corpus_key,
            "requestedUrl": record["pdfUrl"],
            "finalUrl": final_url,
            "path": stored_path,
            "capturedAt": dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat(),
            "bytes": len(value),
            "sha256": sha256(value),
            "contentType": headers.get("content-type"),
            "etag": headers.get("etag"),
            "lastModified": headers.get("last-modified"),
        }
        output = {item["corpusKey"]: item for item in merge_jsonl_record(existing_path, capture, "corpusKey")}
        print(f"[{position}/{len(records)}] downloaded {corpus_key} ({len(value):,} bytes)", flush=True)
    failure_path = case_root / "capture-errors.jsonl"
    if failures:
        atomic_write(failure_path, "".join(json.dumps(item, ensure_ascii=False, sort_keys=True) + "\n" for item in failures).encode("utf-8"))
        raise RuntimeError(f"{len(failures)} PDFs failed; successful captures were retained and failures are in {failure_path}")
    if failure_path.exists():
        failure_path.unlink()
    # A peer downloader may have committed its last record after this process's
    # final merge.  Return the authoritative ledger, not a stale in-memory view.
    return load_jsonl(existing_path) if existing_path.exists() else list(output.values())


def _pdf_reader(path: Path):
    try:
        from pypdf import PdfReader
    except ImportError as error:
        raise RuntimeError(
            "PDF extraction requires pypdf. Run with the Codex workspace Python runtime or install pypdf."
        ) from error
    return PdfReader(str(path))


def page_quality(text: str, scan_likely: bool = False) -> dict:
    value = text or ""
    visible = [character for character in value if not character.isspace()]
    alnum = sum(character.isalnum() for character in visible)
    replacement = value.count("\ufffd")
    control = sum(ord(character) < 32 and character not in "\n\t\r" for character in value)
    words = re.findall(r"\b[A-Za-z]{2,}\b", value)
    suspicious = len(re.findall(r"(?:[A-Za-z]\d[A-Za-z]|\d[A-Za-z]\d|[|]{1,}|\ufffd)", value))
    chars = len(value.strip())
    alnum_ratio = alnum / max(1, len(visible))
    score = 1.0
    if chars < 80:
        score -= 0.75
    elif chars < 300:
        score -= 0.25
    if alnum_ratio < 0.55:
        score -= min(0.4, (0.55 - alnum_ratio) * 2)
    if len(words) < 25:
        score -= 0.2
    score -= min(0.3, (replacement + control + suspicious) / max(1, chars) * 15)
    if scan_likely:
        # A hidden OCR layer can look statistically fluent while visibly
        # containing errors (common in the PaperPort-era EOIR scans). Route
        # image-backed pages through the GPU benchmark even when text exists.
        score = min(score, 0.68)
    score = round(max(0.0, min(1.0, score)), 3)
    return {
        "score": score,
        "needsOcr": score < 0.72,
        "characters": chars,
        "wordCount": len(words),
        "alnumRatio": round(alnum_ratio, 4),
        "replacementCharacters": replacement,
        "controlCharacters": control,
        "suspiciousTokenCount": suspicious,
        "scanLikely": scan_likely,
    }


def page_raster_diagnostics(page) -> dict:
    resources = page.get("/Resources")
    resources = resources.get_object() if resources and hasattr(resources, "get_object") else (resources or {})
    objects = resources.get("/XObject", {}) if hasattr(resources, "get") else {}
    objects = objects.get_object() if objects and hasattr(objects, "get_object") else (objects or {})
    dimensions: list[list[int]] = []
    for reference in objects.values() if hasattr(objects, "values") else []:
        try:
            item = reference.get_object()
            if item.get("/Subtype") == "/Image":
                dimensions.append([int(item.get("/Width", 0)), int(item.get("/Height", 0))])
        except Exception:
            continue
    total_pixels = sum(width * height for width, height in dimensions)
    return {
        "imageCount": len(dimensions),
        "totalImagePixels": total_pixels,
        "largestImages": sorted(dimensions, key=lambda size: size[0] * size[1], reverse=True)[:5],
        "scanLikely": total_pixels >= 2_000_000,
    }


def analyze_blocks(repo_root: Path, corpus_key: str, blocks: list[dict]) -> dict[str, dict]:
    command = ["node", str(repo_root / "tools" / "case-citations.js")]
    completed = subprocess.run(
        command,
        input=json.dumps({"sourceId": corpus_key, "blocks": blocks}, ensure_ascii=False),
        text=True,
        capture_output=True,
        check=False,
    )
    if completed.returncode:
        raise RuntimeError(f"Citation analyzer failed for {corpus_key}: {completed.stderr.strip()}")
    result = json.loads(completed.stdout)
    return {block["id"]: block for block in result["blocks"]}


def analyze_headnotes(
    repo_root: Path,
    case_root: Path,
    records: list[dict],
    refresh: bool = False,
    batch_size: int = 250,
) -> dict[str, dict]:
    """Analyze official catalog headnotes for the full manifest.

    This metadata-only layer makes every discovered case searchable and lets
    explicit publisher treatment statements enter the graph before the slower
    PDF capture/extraction pass has reached that case.  Cache validity is tied
    to the exact headnote text, while the original text remains in the manifest.
    """
    output_path = case_root / "index" / "headnote-analysis.jsonl"
    fingerprint = analysis_fingerprint(repo_root)
    cached_rows = load_jsonl(output_path) if output_path.exists() and not refresh else []
    cached = {row["corpusKey"]: row for row in cached_rows}
    output: dict[str, dict] = {}
    pending: list[tuple[dict, str]] = []
    for record in records:
        text = "\n".join(record.get("headnotes", []))
        text_sha = sha256(text.encode("utf-8"))
        old = cached.get(record["corpusKey"])
        if (
            old
            and old.get("headnoteSha256") == text_sha
            and old.get("analysisFingerprint") == fingerprint
            and isinstance(old.get("analysis"), dict)
        ):
            output[record["corpusKey"]] = old["analysis"]
        else:
            pending.append((record, text_sha))

    for offset in range(0, len(pending), batch_size):
        batch = pending[offset:offset + batch_size]
        blocks = [
            {
                "id": record["corpusKey"],
                "text": "\n".join(record.get("headnotes", [])),
                "isHeadnote": True,
            }
            for record, _text_sha in batch
        ]
        analyzed = analyze_blocks(repo_root, f"headnote-catalog-{offset // batch_size + 1}", blocks)
        for record, _text_sha in batch:
            output[record["corpusKey"]] = analyzed[record["corpusKey"]]
        print(
            f"analyzed official headnotes {offset + 1}-{offset + len(batch)} of {len(pending)} uncached cases",
            flush=True,
        )

    rows = []
    for record in records:
        text = "\n".join(record.get("headnotes", []))
        rows.append({
            "schemaVersion": 1,
            "corpusKey": record["corpusKey"],
            "headnoteSha256": sha256(text.encode("utf-8")),
            "analysisFingerprint": fingerprint,
            "analysis": output[record["corpusKey"]],
        })
    atomic_write(
        output_path,
        "".join(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n" for row in rows).encode("utf-8"),
    )
    return output


def _markdown_document(document: dict) -> str:
    case = document["case"]
    artifact = document["sourceArtifact"]
    lines = [
        "---",
        "schema_version: 1",
        f"case_id: {case['corpusKey']}",
        f"official_citation: {json.dumps(case.get('officialCitation', ''), ensure_ascii=False)}",
        f"case_name: {json.dumps(case.get('caseName', ''), ensure_ascii=False)}",
        f"deciding_body: {json.dumps(case.get('decidingBody', ''), ensure_ascii=False)}",
        f"source_pdf_sha256: {artifact['sha256']}",
        f"source_url: {json.dumps(artifact['finalUrl'], ensure_ascii=False)}",
        "---",
        "",
        f"# {case.get('caseName', case['corpusKey'])}",
        "",
    ]
    if case.get("headnotes"):
        lines.extend(["## Official publisher headnotes", ""])
        lines.extend(f"{index}. {note}" for index, note in enumerate(case["headnotes"], start=1))
        lines.append("")
    lines.extend(["## Decision text", ""])
    for page in document["pages"]:
        lines.extend([
            f"<!-- page: {page['pageNumber']} | source: {case['corpusKey']} | extraction: {page['selectedTextMethod']} | quality: {page['quality']['score']} -->",
            "",
            page["selectedText"].strip(),
            "",
        ])
    return "\n".join(lines).rstrip() + "\n"


def source_citation_audit(record: dict, pages: list[dict]) -> dict:
    expected_volume = record.get("volume")
    expected_page = record.get("reporterPage")
    if not expected_volume or expected_page is None or not pages:
        return {"status": "not-applicable", "expected": record.get("officialCitation")}
    # The printed reporter header may be recoverable only through an explicitly
    # selected OCR layer.  Native text remains the fallback and is never lost.
    text = pages[0].get("selectedText") or pages[0].get("nativeText", "")
    direct = re.search(r"\b(\d{1,2})\s*I\s*&\s*N\s+Dec\.\s+(\d{1,4})\b", text, re.IGNORECASE)
    standalone = [int(match.group(1)) for match in re.finditer(r"(?m)^\s*(\d{1,4})\s*$", text)]
    detected_volume = int(direct.group(1)) if direct else int(expected_volume)
    detected_page = int(direct.group(2)) if direct else (standalone[-1] if standalone else None)
    if detected_page is None:
        status = "unavailable-needs-ocr"
    elif detected_volume == int(expected_volume) and detected_page == int(expected_page):
        status = "match"
    else:
        status = "mismatch-review"
    return {
        "status": status,
        "expected": record.get("officialCitation"),
        "detectedVolume": detected_volume if detected_page is not None else None,
        "detectedPage": detected_page,
        "method": "printed-reporter-citation" if direct else ("last-standalone-first-page-number" if standalone else None),
    }


def decision_date(text: str) -> dict | None:
    match = re.search(r"\bDecided(?:\s+by\s+(?:the\s+)?[A-Za-z ]+)?\s+([A-Z][a-z]+\s+\d{1,2},\s*\d{4})\b", text)
    if not match:
        return None
    written = match.group(1)
    try:
        parsed = dt.datetime.strptime(written, "%B %d, %Y").date().isoformat()
    except ValueError:
        parsed = None
    return {"written": written, "iso": parsed, "provenance": "decision-first-page"}


def temporal_application(text: str) -> dict | None:
    signals: list[str] = []
    for paragraph in re.split(r"\n\s*\n|(?<=[.!?])\s+(?=[A-Z])", text):
        cleaned = re.sub(r"\s+", " ", paragraph).strip()
        if not cleaned:
            continue
        if re.search(r"\b(?:apply|applied|applying|holding|order|rule)\b.{0,160}\bprospectiv(?:e|ely)\b", cleaned, re.IGNORECASE) or re.search(r"\bprospectiv(?:e|ely)\b.{0,100}\b(?:apply|holding|rule)\b", cleaned, re.IGNORECASE):
            signals.append(cleaned[:1000])
    if not signals:
        return None
    return {
        "scope": "prospective",
        "evidence": list(dict.fromkeys(signals))[:5],
        "provenance": "explicit-temporal-language",
        "confidence": 1,
        "warning": "Prospective application can depend on the event and reliance interests described by the decision; review the cited evidence.",
    }


def enrich_temporal_treatments(headnote_analysis: dict, pages: list[dict], date: dict | None) -> dict | None:
    all_text = "\n\n".join(page["selectedText"] for page in pages)
    application = temporal_application(all_text)
    if not application:
        return None
    treatments = [*headnote_analysis.get("treatments", [])]
    for page in pages:
        treatments.extend(page.get("treatments", []))
    overruled = {item.get("citedCaseCitation") for item in treatments if item.get("treatment") == "overruled"}
    # Automatic attachment is intentionally conservative. When a decision
    # overrules one uniquely identified precedent and explicitly says its new
    # holding is prospective, that temporal statement qualifies those edges.
    if len(overruled) == 1:
        for item in treatments:
            if item.get("treatment") == "overruled" and item.get("citedCaseCitation") in overruled:
                item["temporalApplication"] = {**application, "decisionDate": date}
        return {**application, "attachedTo": sorted(overruled), "decisionDate": date}
    return {**application, "attachedTo": [], "decisionDate": date, "requiresReview": True}


def extract_pdf(repo_root: Path, case_root: Path, record: dict, artifact: dict) -> dict:
    pdf_path = Path(artifact["path"])
    if not pdf_path.is_absolute():
        pdf_path = repo_root / pdf_path
    value = pdf_path.read_bytes()
    if sha256(value) != artifact["sha256"]:
        raise RuntimeError(f"Source PDF checksum mismatch for {record['corpusKey']}")
    reader = _pdf_reader(pdf_path)
    pdf_metadata = {str(key).lstrip("/"): str(value) for key, value in (reader.metadata or {}).items() if value is not None}
    metadata_scan_cue = bool(re.search(r"(?:paperport|omn[i]?page|scan|xerox)", " ".join(pdf_metadata.values()), re.IGNORECASE))
    pages: list[dict] = []
    blocks = [{"id": "headnotes", "text": "\n".join(record.get("headnotes", [])), "isHeadnote": True}]
    for page_number, page in enumerate(reader.pages, start=1):
        try:
            native_text = page.extract_text() or ""
        except Exception:
            native_text = ""
        native_text = native_text.replace("\r\n", "\n").replace("\r", "\n")
        raster = page_raster_diagnostics(page)
        scan_likely = metadata_scan_cue or raster["scanLikely"]
        quality = page_quality(native_text, scan_likely)
        pages.append({
            "pageNumber": page_number,
            "nativeText": native_text,
            "selectedText": native_text,
            "selectedTextMethod": "pdf-native",
            "textSelection": {"method": "pdf-native", "reviewStatus": "source-default"},
            "quality": quality,
            "rasterDiagnostics": raster,
            "ocrLayers": [],
            "ocrAdjudications": [],
            "citations": [],
            "caseCitations": [],
            "treatments": [],
        })
        blocks.append({"id": f"page-{page_number}", "text": native_text, "isHeadnote": False})
    analyzed = analyze_blocks(repo_root, record["corpusKey"], blocks)
    for page in pages:
        result = analyzed[f"page-{page['pageNumber']}"]
        page["citations"] = result["citations"]
        page["caseCitations"] = result.get("caseCitations", [])
        page["treatments"] = result["treatments"]
    date = decision_date(pages[0]["selectedText"] if pages else "")
    temporal = enrich_temporal_treatments(analyzed["headnotes"], pages, date)
    document = {
        "schemaVersion": 1,
        "case": record,
        "sourceArtifact": artifact,
        "extraction": {
            "createdAt": dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat(),
            "engine": "pypdf-native-plus-inasearch-citation-resolver",
            "analysisSchemaVersion": ANALYSIS_SCHEMA_VERSION,
            "analysisFingerprint": analysis_fingerprint(repo_root),
            "pdfMetadata": pdf_metadata,
            "metadataScanCue": metadata_scan_cue,
            "pageCount": len(pages),
            "nativePagesNeedingOcr": [page["pageNumber"] for page in pages if page["quality"]["needsOcr"]],
            "pagesNeedingOcr": [page["pageNumber"] for page in pages if page["quality"]["needsOcr"]],
            "pagesWithOcr": [],
            "pagesWithSelectableOcr": [],
            "pagesWithFailedOcr": [],
            "pagesWithTruncatedOcr": [],
            "pagesWithUnreviewedOcr": [],
            "pagesSelectedFromOcr": [],
            "pagesNeedingOcrReview": [],
            "sourceTextPreserved": True,
            "sourceCitationAudit": source_citation_audit(record, pages),
            "decisionDate": date,
            "temporalApplication": temporal,
        },
        "publisherHeadnoteAnalysis": analyzed["headnotes"],
        "pages": pages,
    }
    derived_root = case_root / "derived"
    atomic_write(derived_root / f"{record['corpusKey']}.json", (json.dumps(document, indent=2, ensure_ascii=False) + "\n").encode("utf-8"))
    atomic_write(derived_root / f"{record['corpusKey']}.md", _markdown_document(document).encode("utf-8"))
    return document


def reanalyze_document(repo_root: Path, case_root: Path, document: dict, record: dict, artifact: dict) -> dict:
    """Refresh semantic analysis without discarding native or imported OCR layers."""
    blocks = [{"id": "headnotes", "text": "\n".join(record.get("headnotes", [])), "isHeadnote": True}]
    blocks.extend({
        "id": f"page-{page['pageNumber']}", "text": page["selectedText"], "isHeadnote": False
    } for page in document["pages"])
    analyzed = analyze_blocks(repo_root, record["corpusKey"], blocks)
    for page in document["pages"]:
        result = analyzed[f"page-{page['pageNumber']}"]
        page["citations"] = result["citations"]
        page["caseCitations"] = result.get("caseCitations", [])
        page["treatments"] = result["treatments"]
    date = decision_date(document["pages"][0]["selectedText"] if document["pages"] else "")
    temporal = enrich_temporal_treatments(analyzed["headnotes"], document["pages"], date)
    document["case"] = record
    document["sourceArtifact"] = artifact
    document["publisherHeadnoteAnalysis"] = analyzed["headnotes"]
    document["extraction"]["analysisSchemaVersion"] = ANALYSIS_SCHEMA_VERSION
    document["extraction"]["analysisFingerprint"] = analysis_fingerprint(repo_root)
    document["extraction"]["reanalyzedAt"] = dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()
    document["extraction"]["decisionDate"] = date
    document["extraction"]["temporalApplication"] = temporal
    derived_root = case_root / "derived"
    atomic_write(derived_root / f"{record['corpusKey']}.json", (json.dumps(document, indent=2, ensure_ascii=False) + "\n").encode("utf-8"))
    atomic_write(derived_root / f"{record['corpusKey']}.md", _markdown_document(document).encode("utf-8"))
    return document


def extract_records(repo_root: Path, case_root: Path, records: list[dict], refresh: bool = False) -> list[dict]:
    captures = {item["corpusKey"]: item for item in load_jsonl(case_root / "capture.jsonl")}
    fingerprint = analysis_fingerprint(repo_root)
    documents: list[dict] = []
    for position, record in enumerate(records, start=1):
        corpus_key = record["corpusKey"]
        artifact = captures.get(corpus_key)
        if not artifact:
            raise RuntimeError(f"No captured PDF for {corpus_key}; run download first")
        output_path = case_root / "derived" / f"{corpus_key}.json"
        if output_path.exists() and not refresh:
            old = json.loads(output_path.read_text(encoding="utf-8"))
            if old.get("sourceArtifact", {}).get("sha256") == artifact["sha256"] and old.get("case") == record:
                if old.get("extraction", {}).get("analysisFingerprint") == fingerprint:
                    documents.append(old)
                    print(f"[{position}/{len(records)}] cached extraction {corpus_key}", flush=True)
                else:
                    document = reanalyze_document(repo_root, case_root, old, record, artifact)
                    documents.append(document)
                    print(f"[{position}/{len(records)}] reanalyzed {corpus_key} (text layers preserved)", flush=True)
                continue
        document = extract_pdf(repo_root, case_root, record, artifact)
        documents.append(document)
        needed = len(document["extraction"]["pagesNeedingOcr"])
        print(f"[{position}/{len(records)}] extracted {corpus_key} ({len(document['pages'])} pages; {needed} need OCR)", flush=True)
    return documents


def _migrate_page_ocr(page: dict, source_pdf_sha256: str, corpus_key: str) -> None:
    """Make old documents readable without discarding their former choice."""
    layers = page.setdefault("ocrLayers", [])
    if not isinstance(layers, list):
        raise RuntimeError(f"Page {page.get('pageNumber')} ocrLayers is not an array")
    page.setdefault("ocrAdjudications", [])
    page.setdefault("caseCitations", [])
    page.setdefault("textSelection", {"method": "pdf-native", "reviewStatus": "source-default"})
    legacy = page.get("ocrText")
    if not isinstance(legacy, dict):
        return
    legacy_item = {
        "schemaVersion": 1,
        "pageNumber": page["pageNumber"],
        **legacy,
    }
    layer = normalize_ocr_result(legacy_item, corpus_key, page["pageNumber"], source_pdf_sha256)
    layer["provenance"]["migratedFromField"] = "ocrText"
    if not any(existing.get("layerId") == layer["layerId"] for existing in layers):
        layer["importedAt"] = legacy.get("importedAt")
        layers.append(layer)
    if str(page.get("selectedTextMethod", "")).startswith("ocr:"):
        page["textSelection"] = {
            "method": "ocr-layer",
            "layerId": layer["layerId"],
            "reviewStatus": "legacy-selection-preserved-needs-review",
        }


def _is_ocr_selected(page: dict) -> bool:
    return str(page.get("selectedTextMethod", "")).startswith(("ocr:", "ocr-layer:"))


def _refresh_ocr_status(document: dict) -> None:
    extraction = document["extraction"]
    extraction["nativePagesNeedingOcr"] = extraction.get(
        "nativePagesNeedingOcr", extraction.get("pagesNeedingOcr", [])
    )
    pages_with_ocr: list[int] = []
    pages_with_selectable: list[int] = []
    pages_with_failed: list[int] = []
    pages_with_truncated: list[int] = []
    pages_with_unreviewed: list[int] = []
    pages_selected: list[int] = []
    pages_need_transcription: list[int] = []
    pages_need_review: list[int] = []
    for page in document["pages"]:
        _migrate_page_ocr(page, document["sourceArtifact"]["sha256"], document["case"]["corpusKey"])
        layers = page["ocrLayers"]
        latest_decision: dict[str, str] = {}
        for item in page.get("ocrAdjudications", []):
            if item.get("layerId"):
                latest_decision[item["layerId"]] = item.get("decision")
        rejected = {layer_id for layer_id, decision in latest_decision.items() if decision == "reject"}
        usable = [layer for layer in layers if layer_is_selectable(layer) and layer.get("layerId") not in rejected]
        if any(layer.get("status") == "succeeded" and str(layer.get("text", "")).strip() for layer in layers):
            pages_with_ocr.append(page["pageNumber"])
        if usable:
            pages_with_selectable.append(page["pageNumber"])
        if any(layer.get("status") == "failed" for layer in layers):
            pages_with_failed.append(page["pageNumber"])
        if any(layer.get("termination", {}).get("truncated") is True for layer in layers):
            pages_with_truncated.append(page["pageNumber"])
        selected = _is_ocr_selected(page)
        if selected:
            pages_selected.append(page["pageNumber"])
        elif usable:
            pages_with_unreviewed.append(page["pageNumber"])
        if page["quality"]["needsOcr"]:
            if not usable and not selected:
                pages_need_transcription.append(page["pageNumber"])
            elif not selected:
                pages_need_review.append(page["pageNumber"])
    extraction["pagesWithOcr"] = pages_with_ocr
    extraction["pagesWithSelectableOcr"] = pages_with_selectable
    extraction["pagesWithFailedOcr"] = pages_with_failed
    extraction["pagesWithTruncatedOcr"] = pages_with_truncated
    extraction["pagesWithUnreviewedOcr"] = pages_with_unreviewed
    extraction["pagesSelectedFromOcr"] = pages_selected
    extraction["pagesNeedingOcr"] = pages_need_transcription
    extraction["pagesNeedingOcrReview"] = pages_need_review


def _reanalyze_selected_text(repo_root: Path, document: dict, corpus_key: str) -> None:
    blocks = [
        {"id": f"page-{page['pageNumber']}", "text": page["selectedText"], "isHeadnote": False}
        for page in document["pages"]
    ]
    analyzed = analyze_blocks(repo_root, corpus_key, blocks)
    for page in document["pages"]:
        result = analyzed[f"page-{page['pageNumber']}"]
        page["citations"] = result["citations"]
        page["caseCitations"] = result.get("caseCitations", [])
        page["treatments"] = result["treatments"]
    date = decision_date(document["pages"][0]["selectedText"] if document["pages"] else "")
    temporal = enrich_temporal_treatments(document.get("publisherHeadnoteAnalysis", {}), document["pages"], date)
    document["extraction"]["decisionDate"] = date
    document["extraction"]["temporalApplication"] = temporal
    document["extraction"]["sourceCitationAudit"] = source_citation_audit(document["case"], document["pages"])
    document["extraction"]["analysisSchemaVersion"] = ANALYSIS_SCHEMA_VERSION
    document["extraction"]["analysisFingerprint"] = analysis_fingerprint(repo_root)


def _write_document(case_root: Path, corpus_key: str, document: dict) -> None:
    document_path = case_root / "derived" / f"{corpus_key}.json"
    atomic_write(document_path, (json.dumps(document, indent=2, ensure_ascii=False) + "\n").encode("utf-8"))
    atomic_write(case_root / "derived" / f"{corpus_key}.md", _markdown_document(document).encode("utf-8"))


def import_ocr(repo_root: Path, case_root: Path, corpus_key: str, input_path: Path) -> dict:
    """Attach validated OCR alternatives without selecting any new text.

    Legacy schema-v1 rows remain importable and are marked as incomplete
    provenance.  Rich schema-v2 rows require pinned engine/model/container
    identity, source/image hashes, transforms, layout coordinates, and explicit
    termination.  Neither path auto-promotes OCR based on a weak native page or
    an uncalibrated confidence number.
    """
    document_path = case_root / "derived" / f"{corpus_key}.json"
    document = json.loads(document_path.read_text(encoding="utf-8"))
    page_by_number = {int(page["pageNumber"]): page for page in document["pages"]}
    imported = load_jsonl(input_path)
    if not imported:
        raise RuntimeError(f"OCR input has no records: {input_path}")
    normalized: list[tuple[dict, dict]] = []
    for item in imported:
        try:
            page_number = int(item["pageNumber"])
        except (KeyError, TypeError, ValueError) as error:
            raise RuntimeError("Every OCR row needs an integer pageNumber") from error
        page = page_by_number.get(page_number)
        if page is None:
            raise RuntimeError(f"OCR row names nonexistent page {page_number} in {corpus_key}")
        layer = normalize_ocr_result(item, corpus_key, page_number, document["sourceArtifact"]["sha256"])
        normalized.append((page, layer))

    imported_at = dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()
    for page, layer in normalized:
        _migrate_page_ocr(page, document["sourceArtifact"]["sha256"], corpus_key)
        existing_ids = {item.get("layerId") for item in page["ocrLayers"]}
        if layer["layerId"] not in existing_ids:
            page["ocrLayers"].append({**layer, "importedAt": imported_at})
            page["ocrLayers"].sort(key=lambda item: item["layerId"])
    _refresh_ocr_status(document)
    _reanalyze_selected_text(repo_root, document, corpus_key)
    document["extraction"]["ocrImportedAt"] = imported_at
    _write_document(case_root, corpus_key, document)
    return document


def adjudicate_ocr_layer(
    repo_root: Path,
    case_root: Path,
    corpus_key: str,
    page_number: int,
    decision: str,
    reviewer: str,
    reason: str,
    layer_id: str | None = None,
) -> dict:
    """Select/reject an OCR layer, or explicitly return selection to native."""
    if decision not in {"select", "reject", "select-native"}:
        raise RuntimeError("OCR adjudication decision must be select, reject, or select-native")
    if not reviewer.strip() or not reason.strip():
        raise RuntimeError("OCR adjudication requires non-empty reviewer and reason")
    if decision != "select-native" and not layer_id:
        raise RuntimeError(f"OCR adjudication decision {decision} requires a layer ID")
    document_path = case_root / "derived" / f"{corpus_key}.json"
    document = json.loads(document_path.read_text(encoding="utf-8"))
    page = next((item for item in document["pages"] if int(item["pageNumber"]) == int(page_number)), None)
    if page is None:
        raise RuntimeError(f"Case {corpus_key} has no page {page_number}")
    _migrate_page_ocr(page, document["sourceArtifact"]["sha256"], corpus_key)
    layer = next((item for item in page["ocrLayers"] if item.get("layerId") == layer_id), None)
    if decision != "select-native" and layer is None:
        raise RuntimeError(f"Page {page_number} has no OCR layer {layer_id}")
    if decision == "select" and not layer_is_selectable(layer):
        raise RuntimeError("Failed, truncated, empty, or errored OCR cannot be selected")
    if decision == "reject" and page.get("textSelection", {}).get("layerId") == layer_id:
        raise RuntimeError("Select native text or another layer before rejecting the active OCR layer")

    adjudicated_at = dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()
    record = {
        "schemaVersion": 1,
        "decision": decision,
        "layerId": layer_id,
        "reviewer": reviewer.strip(),
        "reason": reason.strip(),
        "adjudicatedAt": adjudicated_at,
    }
    record["adjudicationId"] = "ocr-review-" + hashlib.sha256(
        json.dumps({"caseId": corpus_key, "pageNumber": page_number, **record}, sort_keys=True).encode("utf-8")
    ).hexdigest()[:24]
    page["ocrAdjudications"].append(record)
    if decision == "select":
        page["selectedText"] = layer["text"]
        page["selectedTextMethod"] = f"ocr-layer:{layer_id}"
        page["textSelection"] = {
            "method": "ocr-layer",
            "layerId": layer_id,
            "reviewStatus": "adjudicated",
            "adjudicationId": record["adjudicationId"],
        }
    elif decision == "select-native":
        page["selectedText"] = page.get("nativeText", "")
        page["selectedTextMethod"] = "pdf-native"
        page["textSelection"] = {
            "method": "pdf-native",
            "reviewStatus": "adjudicated",
            "adjudicationId": record["adjudicationId"],
        }

    _refresh_ocr_status(document)
    _reanalyze_selected_text(repo_root, document, corpus_key)
    document["extraction"]["ocrAdjudicatedAt"] = adjudicated_at
    _write_document(case_root, corpus_key, document)
    return document
