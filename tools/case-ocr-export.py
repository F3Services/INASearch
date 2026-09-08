#!/usr/bin/env python3
"""Render a deterministic queue slice as a self-contained SSH batch."""

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


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def render(pdftoppm: str, source: Path, page_number: int, output: Path, dpi: int) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="inasearch-ocr-export-") as temporary:
        prefix = Path(temporary) / "page"
        completed = subprocess.run(
            [pdftoppm, "-f", str(page_number), "-l", str(page_number), "-r", str(dpi), "-png", "-singlefile", str(source), str(prefix)],
            capture_output=True, text=True, check=False,
        )
        if completed.returncode:
            raise RuntimeError(f"pdftoppm failed for {source} page {page_number}: {completed.stderr.strip()}")
        output.write_bytes(prefix.with_suffix(".png").read_bytes())


def dimensions(path: Path) -> tuple[int, int]:
    header = path.read_bytes()[:24]
    if len(header) < 24 or header[:8] != b"\x89PNG\r\n\x1a\n":
        raise RuntimeError(f"Rendered file is not PNG: {path}")
    return struct.unpack(">II", header[16:24])


def main() -> None:
    parser = argparse.ArgumentParser(description="Export a severe-first OCR queue slice for an SSH/Tailscale worker")
    parser.add_argument("--case-root", type=Path, default=CASE_ROOT)
    parser.add_argument("--queue", type=Path, help="Default: CASE_ROOT/index/ocr-queue.jsonl")
    parser.add_argument("--output", type=Path, required=True, help="New or matching batch directory")
    parser.add_argument("--offset", type=int, default=0)
    parser.add_argument("--limit", type=int, default=20)
    parser.add_argument("--id", action="append", help="Specific queueId; repeatable and overrides offset/limit")
    parser.add_argument("--priority-band", action="append")
    parser.add_argument("--source-kind", choices=["published-case", "official-supporting-index"])
    parser.add_argument("--pdftoppm", default=shutil.which("pdftoppm"))
    parser.add_argument("--refresh", action="store_true")
    args = parser.parse_args()
    if not args.pdftoppm:
        raise RuntimeError("pdftoppm is required")
    if args.offset < 0 or args.limit <= 0 or args.limit > 500:
        raise RuntimeError("offset must be non-negative and limit must be between 1 and 500")
    case_root = args.case_root.resolve()
    queue_path = args.queue.resolve() if args.queue else case_root / "index" / "ocr-queue.jsonl"
    rows = load_jsonl(queue_path)
    if args.priority_band:
        wanted_bands = set(args.priority_band)
        rows = [row for row in rows if row["priorityBand"] in wanted_bands]
    if args.source_kind:
        rows = [row for row in rows if row.get("sourceKind") == args.source_kind]
    if args.id:
        row_by_id = {row["queueId"]: row for row in rows}
        missing = sorted(set(args.id) - set(row_by_id))
        if missing:
            raise RuntimeError(f"Unknown or filtered queue IDs: {', '.join(missing)}")
        selected = [row_by_id[queue_id] for queue_id in args.id]
    else:
        selected = rows[args.offset:args.offset + args.limit]
    if not selected:
        raise RuntimeError("Queue selection is empty")

    output_root = args.output.resolve()
    images_root = output_root / "images"
    jobs_root = output_root / "jobs"
    existing_manifest = output_root / "manifest.jsonl"
    if existing_manifest.exists():
        old_ids = {row["jobId"] for row in load_jsonl(existing_manifest)}
        new_ids = {row["queueId"] for row in selected}
        if old_ids != new_ids:
            raise RuntimeError("Output already contains a different batch; choose a new --output directory")
    images_root.mkdir(parents=True, exist_ok=True)
    jobs_root.mkdir(parents=True, exist_ok=True)
    jobs: list[dict] = []
    for position, row in enumerate(selected, start=1):
        source_path = Path(row["source"]["pdfPath"])
        source_path = source_path if source_path.is_absolute() else ROOT / source_path
        if sha256(source_path) != row["sourcePdfSha256"]:
            raise RuntimeError(f"Source PDF checksum mismatch for {row['queueId']}")
        image_path = images_root / f"{row['queueId']}.png"
        dpi = int(row["renderDpi"])
        if args.refresh or not image_path.exists():
            render(args.pdftoppm, source_path, int(row["pageNumber"]), image_path, dpi)
        image_hash = sha256(image_path)
        width, height = dimensions(image_path)
        scale = dpi / 72
        job = {
            "schemaVersion": 1,
            "jobId": row["queueId"],
            "queuePosition": args.offset + position if not args.id else None,
            "caseId": row["caseId"],
            "pageNumber": row["pageNumber"],
            "sourceKind": row["sourceKind"],
            "priority": row["priority"],
            "priorityBand": row["priorityBand"],
            "priorityReasons": row["priorityReasons"],
            "case": row["case"],
            "source": {
                "pdfSha256": row["sourcePdfSha256"],
                "publisherUrl": row["source"].get("publisherUrl"),
            },
            "nativeReference": {
                "textSha256": row["nativeTextSha256"],
                "quality": row["nativeQuality"],
                "signals": row["signals"],
            },
            "image": {
                "path": f"images/{image_path.name}", "sha256": image_hash,
                "format": "png", "dpi": dpi, "width": width, "height": height,
            },
            "prompt": {"text": OCR_PROMPT, "sha256": OCR_PROMPT_SHA256},
            "preprocessing": {
                "initialTransforms": [{
                    "operation": "pdf-render",
                    "sourceSpace": "pdf-page-normalized-top-left-points-after-page-rotation",
                    "targetSpace": "rendered-page-pixels",
                    "parameters": {"dpi": dpi, "format": "png", "renderer": "pdftoppm"},
                    "forwardMatrix": [scale, 0, 0, 0, scale, 0, 0, 0, 1],
                    "inverseMatrix": [1 / scale, 0, 0, 0, 1 / scale, 0, 0, 0, 1],
                }],
                "workerMayApply": row["preprocessingRequirements"]["allowed"],
                "requirements": {
                    "retainUncroppedInput": True,
                    "cropSafetyMarginPixelsAt300Dpi": row["preprocessingRequirements"]["cropSafetyMarginPixelsAt300Dpi"],
                    "recordEveryTransform": True,
                    "requireForwardAndInverseMatrices": True,
                    "returnAllCoordinatesIn": "rendered-page-pixels-top-left",
                },
            },
            "expectedResult": {
                "format": "one schema-v2 JSON object per engine/model attempt; JSONL accepted",
                "jobId": row["queueId"],
                "outputSchemaSha256": OCR_RESULT_SCHEMA_SHA256,
                "selection": row["resultContract"]["selection"],
            },
            "goldSet": row.get("goldSet"),
        }
        jobs.append(job)
        atomic_write(jobs_root / f"{row['queueId']}.json", (json.dumps(job, indent=2, ensure_ascii=False, sort_keys=True) + "\n").encode("utf-8"))
        print(f"[{position}/{len(selected)}] exported {row['queueId']}", flush=True)

    atomic_write(existing_manifest, b"".join(json.dumps(job, ensure_ascii=False, sort_keys=True).encode("utf-8") + b"\n" for job in jobs))
    atomic_write(output_root / "result-contract.json", (json.dumps({"sha256": OCR_RESULT_SCHEMA_SHA256, "contract": OCR_RESULT_CONTRACT}, indent=2, sort_keys=True) + "\n").encode("utf-8"))
    readme = """# INASearch OCR batch

Each `jobs/*.json` file and referenced PNG is a complete, transport-neutral worker input. Return one schema-v2 JSON result per engine/model/page attempt and copy `jobId` into it. Keep engine version, model revision, and container digest pinned. Preserve the uncropped image; record every crop/deskew/tile transform with forward and inverse matrices; return block/word coordinates in original rendered-page pixels. Report stop reason, truncation, errors, and runtime. Results remain unreviewed alternatives until separately adjudicated.
"""
    atomic_write(output_root / "README.md", readme.encode("utf-8"))
    checksums = []
    for path in sorted(item for item in output_root.rglob("*") if item.is_file() and item.name != "checksums.json"):
        checksums.append({"path": path.relative_to(output_root).as_posix(), "sha256": sha256(path), "bytes": path.stat().st_size})
    atomic_write(output_root / "checksums.json", (json.dumps(checksums, indent=2, sort_keys=True) + "\n").encode("utf-8"))
    print(json.dumps({
        "path": output_root.as_posix(), "jobs": len(jobs),
        "bytes": sum(path.stat().st_size for path in output_root.rglob("*") if path.is_file()),
        "firstQueuePosition": args.offset + 1 if not args.id else None,
    }, indent=2))


if __name__ == "__main__":
    main()
