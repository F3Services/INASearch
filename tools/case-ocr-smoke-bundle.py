#!/usr/bin/env python3
"""Build a small, transport-neutral OCR smoke/benchmark bundle."""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import struct
import subprocess
import tempfile
from pathlib import Path

from case_index.documents import atomic_write, load_jsonl
from case_index.ocr import OCR_PROMPT, OCR_PROMPT_SHA256, OCR_RESULT_CONTRACT, OCR_RESULT_SCHEMA_SHA256


ROOT = Path(__file__).resolve().parents[1]
CASE_ROOT = ROOT / "sources" / "cases"
SAMPLES = [
    ("case", "eoir-3147", 1, "centered-small-content-large-margins", "Detect content without clipping; crop only with safety margin and inverse transform."),
    ("case", "eoir-3155", 1, "textless-older-scan", "Recover a page with no native text from a long 1991 scan."),
    ("case", "eoir-1288", 3, "early-faint-scan", "Preserve 1963 typography, reporter citation, and line breaks."),
    ("case", "uscis-adopted-06-0002", 2, "aao-redactions-stamp-whitespace", "Do not hallucinate through redaction bars; preserve stamp/letterhead and reading order."),
    ("case", "uscis-adopted-06-0001", 2, "aao-scanned-attachment", "Recover an image-only USCIS adopted-decision attachment."),
    ("case", "uscis-adopted-06-0003", 1, "aao-born-digital-control", "Control page for Matter of Chawathe; exact headings and legal tokens."),
    ("case", "eoir-2822", 4, "citation-treatment-footnote-dense", "Exact 17 I&N page citations, treatment words, and footnote attachment."),
    ("case", "eoir-3206", 2, "citation-dense-scan", "Exact legal citations and parenthetical units."),
    ("case", "eoir-3044", 5, "footnotes-citations-hyphenation", "Preserve footnotes and distinguish printed line-end hyphens from word breaks."),
    ("case", "eoir-2965", 3, "older-legal-dense-hyphenation", "Exact legal tokens on a scan with frequent line-end hyphenation."),
    ("case", "eoir-939", 3, "early-reporter-scan", "Recover old reporter typography without normalizing spelling or punctuation."),
    ("case", "eoir-2493", 1, "mid-era-reporter-header", "Preserve reporter header, page number, caption, and decision date."),
    ("case", "eoir-4154", 2, "modern-born-digital-control", "Measure regression against a clean 2026 born-digital EOIR page."),
    ("supporting", "eoir-index-vol1-15-a-e", 1, "topical-index-two-column-dark-gutter", "Preserve two-column reading order, indentation, cross-references, and gutter text."),
    ("supporting", "eoir-index-vol1-15-a-e", 20, "topical-index-dense-crossrefs", "Preserve dense headings, subentries, cross-references, and volume-page tokens."),
    ("supporting", "eoir-index-vol1-15-f-z", 20, "topical-index-line-end-hyphenation", "Preserve indentation and cross-references; do not silently join uncertain hyphenation."),
]


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def render(pdftoppm: str, pdf_path: Path, page: int, output: Path, dpi: int) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="inasearch-smoke-") as temporary:
        prefix = Path(temporary) / "page"
        completed = subprocess.run(
            [pdftoppm, "-f", str(page), "-l", str(page), "-r", str(dpi), "-png", "-singlefile", str(pdf_path), str(prefix)],
            capture_output=True, text=True, check=False,
        )
        if completed.returncode:
            raise RuntimeError(f"pdftoppm failed for {pdf_path} page {page}: {completed.stderr.strip()}")
        output.write_bytes(prefix.with_suffix(".png").read_bytes())


def dimensions(path: Path) -> tuple[int, int]:
    value = path.read_bytes()[:24]
    if value[:8] != b"\x89PNG\r\n\x1a\n":
        raise RuntimeError(f"Not a PNG: {path}")
    return struct.unpack(">II", value[16:24])


def main() -> None:
    parser = argparse.ArgumentParser(description="Render the 16-page INASearch OCR smoke bundle")
    parser.add_argument("--case-root", type=Path, default=CASE_ROOT)
    parser.add_argument("--output", type=Path, help="Default: CASE_ROOT/index/ocr-smoke-bundle")
    parser.add_argument("--dpi", type=int, default=300)
    parser.add_argument("--pdftoppm", default=shutil.which("pdftoppm"))
    parser.add_argument("--refresh", action="store_true")
    args = parser.parse_args()
    if not args.pdftoppm:
        raise RuntimeError("pdftoppm is required")
    case_root = args.case_root.resolve()
    output_root = args.output.resolve() if args.output else case_root / "index" / "ocr-smoke-bundle"
    images_root = output_root / "images"
    jobs_root = output_root / "jobs"
    images_root.mkdir(parents=True, exist_ok=True)
    jobs_root.mkdir(parents=True, exist_ok=True)

    captures = {row["corpusKey"]: row for row in load_jsonl(case_root / "capture.jsonl")}
    supporting_manifest = json.loads((case_root / "supporting" / "manifest.json").read_text(encoding="utf-8"))
    supporting = {row["id"]: row for row in supporting_manifest["artifacts"]}
    prompt_hash = OCR_PROMPT_SHA256
    jobs: list[dict] = []
    for source_kind, source_id, page_number, category, focus in SAMPLES:
        if source_kind == "case":
            document = json.loads((case_root / "derived" / f"{source_id}.json").read_text(encoding="utf-8"))
            artifact = captures[source_id]
            pdf_path = Path(artifact["path"])
            pdf_path = pdf_path if pdf_path.is_absolute() else ROOT / pdf_path
            source = {
                "kind": "published-case",
                "id": source_id,
                "title": f"{document['case'].get('caseName')} - {document['case'].get('officialCitation') or document['case'].get('adoptedDecisionNumber')}",
                "publisherUrl": artifact.get("finalUrl"),
                "pdfSha256": artifact["sha256"],
            }
            native_page = next(page for page in document["pages"] if page["pageNumber"] == page_number)
            native = {"textSha256": hashlib.sha256(native_page.get("nativeText", "").encode("utf-8")).hexdigest(), "quality": native_page["quality"]}
        else:
            artifact = supporting[source_id]
            pdf_path = case_root / artifact["localPath"]
            source = {
                "kind": "official-supporting-index",
                "id": source_id,
                "title": artifact["title"],
                "publisherUrl": artifact["sourceUrl"],
                "pdfSha256": artifact["sha256"],
            }
            native = {"textSha256": hashlib.sha256(b"").hexdigest(), "quality": {"score": 0, "needsOcr": True, "characters": 0, "scanLikely": True}}
        if sha256(pdf_path) != source["pdfSha256"]:
            raise RuntimeError(f"Source checksum mismatch for {source_id}")
        sample_id = f"{source_id}-p{page_number:04d}"
        image_path = images_root / f"{sample_id}.png"
        if args.refresh or not image_path.exists():
            render(args.pdftoppm, pdf_path, page_number, image_path, args.dpi)
        width, height = dimensions(image_path)
        image_hash = sha256(image_path)
        job_id = "ocr-smoke-" + hashlib.sha256(f"{source['pdfSha256']}:{page_number}:{image_hash}:{prompt_hash}".encode("utf-8")).hexdigest()[:32]
        scale = args.dpi / 72
        job = {
            "schemaVersion": 1,
            "jobId": job_id,
            "caseId": source_id,
            "pageNumber": page_number,
            "benchmark": {"category": category, "reviewFocus": focus, "canonicalOcr": False},
            "source": source,
            "nativeReference": native,
            "image": {
                "path": f"images/{image_path.name}", "sha256": image_hash,
                "format": "png", "dpi": args.dpi, "width": width, "height": height,
            },
            "prompt": {"text": OCR_PROMPT, "sha256": prompt_hash},
            "preprocessing": {
                "initialTransforms": [{
                    "operation": "pdf-render",
                    "sourceSpace": "pdf-page-normalized-top-left-points-after-page-rotation",
                    "targetSpace": "rendered-page-pixels",
                    "forwardMatrix": [scale, 0, 0, 0, scale, 0, 0, 0, 1],
                    "inverseMatrix": [1 / scale, 0, 0, 0, 1 / scale, 0, 0, 0, 1],
                }],
                "workerMayApply": ["orientation-correction", "deskew", "contrast", "content-crop-with-safety-margin", "region-tiles"],
                "requirements": {
                    "retainUncroppedInput": True,
                    "cropSafetyMarginPixelsAt300Dpi": 75,
                    "recordEveryTransform": True,
                    "requireForwardAndInverseMatrices": True,
                    "returnAllCoordinatesIn": "rendered-page-pixels-top-left",
                },
            },
            "expectedResult": {
                "format": "one JSON object per engine/model attempt; JSONL accepted",
                "jobId": job_id,
                "outputSchemaSha256": OCR_RESULT_SCHEMA_SHA256,
                "selection": "unreviewed; never canonical or selected merely because OCR succeeded",
            },
        }
        jobs.append(job)
        atomic_write(jobs_root / f"{sample_id}.json", (json.dumps(job, indent=2, ensure_ascii=False, sort_keys=True) + "\n").encode("utf-8"))

    atomic_write(output_root / "manifest.jsonl", b"".join(json.dumps(job, ensure_ascii=False, sort_keys=True).encode("utf-8") + b"\n" for job in jobs))
    contract = {"sha256": OCR_RESULT_SCHEMA_SHA256, "contract": OCR_RESULT_CONTRACT}
    atomic_write(output_root / "result-contract.json", (json.dumps(contract, indent=2, sort_keys=True) + "\n").encode("utf-8"))
    checksums = []
    for path in sorted(item for item in output_root.rglob("*") if item.is_file() and item.name != "checksums.json"):
        checksums.append({"path": path.relative_to(output_root).as_posix(), "sha256": sha256(path), "bytes": path.stat().st_size})
    atomic_write(output_root / "checksums.json", (json.dumps(checksums, indent=2, sort_keys=True) + "\n").encode("utf-8"))
    readme = """# INASearch OCR smoke bundle

This directory is a transport-neutral 16-page benchmark. Each `jobs/*.json` file and its referenced PNG are a complete worker input. Source PDFs are not needed by the worker. The original publisher PDF hash, rendered-image hash, prompt hash, source page, preprocessing coordinate contract, and review focus are included in every job.

Return one schema-v2 OCR result object per engine/model/page attempt. Copy the job's `jobId` into the result. Pin the engine version, model revision, and container digest. Record every preprocessing transform with forward and inverse matrices, return boxes in uncropped rendered-page coordinates, and report stop/truncation/errors/runtime. Outputs are benchmark evidence only: do not label them canonical or selected.
"""
    atomic_write(output_root / "README.md", readme.encode("utf-8"))
    # README changes the bundle after the first checksum pass, so regenerate a
    # complete checksum ledger as the final operation.
    checksums = []
    for path in sorted(item for item in output_root.rglob("*") if item.is_file() and item.name != "checksums.json"):
        checksums.append({"path": path.relative_to(output_root).as_posix(), "sha256": sha256(path), "bytes": path.stat().st_size})
    atomic_write(output_root / "checksums.json", (json.dumps(checksums, indent=2, sort_keys=True) + "\n").encode("utf-8"))
    print(json.dumps({
        "path": output_root.as_posix(), "jobs": len(jobs),
        "bytes": sum(path.stat().st_size for path in output_root.rglob("*") if path.is_file()),
        "categories": [job["benchmark"]["category"] for job in jobs],
    }, indent=2))


if __name__ == "__main__":
    main()
