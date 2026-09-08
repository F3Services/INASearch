#!/usr/bin/env python3
"""Adapt rich local OCR jobs to Hermes's exact two-file inbox contract."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

from case_index.documents import atomic_write, load_jsonl


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_ENGINES = ["paddleocr-vl-1.6", "ovisocr2", "pp-ocrv6"]


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def affine_six(matrix: list) -> list[float]:
    if not isinstance(matrix, list) or len(matrix) != 9:
        raise RuntimeError("Local job source-to-image transform must be a 3x3 matrix")
    values = [float(value) for value in matrix]
    if values[6:] != [0.0, 0.0, 1.0]:
        raise RuntimeError("Hermes v1 accepts affine transforms only")
    # Local matrices are row-major. Hermes uses [a,b,c,d,e,f], where
    # x'=a*x+c*y+e and y'=b*x+d*y+f.
    result = [values[0], values[3], values[1], values[4], values[2], values[5]]
    determinant = result[0] * result[3] - result[1] * result[2]
    if abs(determinant) < 1e-12:
        raise RuntimeError("Hermes sourceToImageTransform must be invertible")
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description="Create exact Hermes inbox job directories from a rich local OCR manifest")
    parser.add_argument("manifest", type=Path, help="Rich local manifest.jsonl from smoke or queue export")
    parser.add_argument("output", type=Path, help="Parent directory for one two-file subdirectory per job")
    parser.add_argument("--engine", action="append", choices=DEFAULT_ENGINES, help="Repeat to override the default three-engine benchmark")
    args = parser.parse_args()
    manifest_path = args.manifest.resolve()
    rich_jobs = load_jsonl(manifest_path)
    if not rich_jobs:
        raise RuntimeError("Local OCR manifest is empty")
    engines = args.engine or DEFAULT_ENGINES
    output_root = args.output.resolve()
    jobs_root = output_root / "jobs"
    jobs_root.mkdir(parents=True, exist_ok=True)
    mappings: list[dict] = []
    for position, rich in enumerate(rich_jobs, start=1):
        job_id = rich["jobId"]
        image_source = manifest_path.parent / rich["image"]["path"]
        if not image_source.is_file() or image_source.is_symlink():
            raise RuntimeError(f"Local job image must be a regular file: {image_source}")
        image_hash = sha256(image_source)
        if image_hash != rich["image"]["sha256"]:
            raise RuntimeError(f"Local image checksum mismatch for {job_id}")
        if image_source.stat().st_size > 250 * 1024 * 1024:
            raise RuntimeError(f"Image exceeds Hermes's 250 MiB limit: {job_id}")
        transforms = rich["preprocessing"]["initialTransforms"]
        if not transforms:
            raise RuntimeError(f"Local job has no source-to-image transform: {job_id}")
        source_to_image = affine_six(transforms[0]["forwardMatrix"])
        image_name = f"{job_id}{image_source.suffix.lower()}"
        remote = {
            "schemaVersion": "inasearch-ocr-job/v1",
            "jobId": job_id,
            "caseId": rich["caseId"],
            "pageNumber": int(rich["pageNumber"]),
            "sourcePdfSha256": rich["source"]["pdfSha256"],
            "imageSha256": image_hash,
            "imageFilename": image_name,
            "renderDpi": int(rich["image"]["dpi"]),
            "preprocessing": {
                "sourceToImageTransform": source_to_image,
                "operations": [],
            },
            "requestedEngines": engines,
        }
        job_directory = jobs_root / job_id
        job_directory.mkdir(parents=True, exist_ok=True)
        allowed = {"manifest.json", image_name}
        unexpected = sorted(path.name for path in job_directory.iterdir() if path.name not in allowed)
        if unexpected:
            raise RuntimeError(f"Hermes job directory {job_directory} has unexpected files: {', '.join(unexpected)}")
        atomic_write(job_directory / "manifest.json", (json.dumps(remote, indent=2, sort_keys=True) + "\n").encode("utf-8"))
        atomic_write(job_directory / image_name, image_source.read_bytes())
        actual = sorted(path.name for path in job_directory.iterdir())
        if actual != sorted(allowed) or (job_directory / image_name).is_symlink():
            raise RuntimeError(f"Hermes job directory is not the exact two-file contract: {job_directory}")
        mappings.append({
            "jobId": job_id,
            # Keep the transfer ledger relocatable and byte-deterministic.  It
            # travels with its own copied rich manifest and job directories;
            # absolute workstation paths would become stale after transfer.
            "localRichManifest": "local-rich-manifest.jsonl",
            "hermesDirectory": f"jobs/{job_id}",
            "manifestSha256": sha256(job_directory / "manifest.json"),
            "imageSha256": image_hash,
        })
        print(f"[{position}/{len(rich_jobs)}] adapted {job_id}", flush=True)
    atomic_write(output_root / "local-rich-manifest.jsonl", manifest_path.read_bytes())
    atomic_write(output_root / "transfer-map.jsonl", b"".join(json.dumps(row, sort_keys=True).encode("utf-8") + b"\n" for row in mappings))
    print(json.dumps({
        "path": output_root.as_posix(),
        "jobDirectories": len(mappings),
        "filesPerJobDirectory": 2,
        "remoteDropDirectory": "/home/dave/inasearch-ocr-worker/inbox/drop",
        "requestedEngines": engines,
    }, indent=2))


if __name__ == "__main__":
    main()
