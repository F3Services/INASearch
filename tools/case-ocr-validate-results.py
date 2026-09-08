#!/usr/bin/env python3
"""Validate returned OCR envelopes against an exported job manifest."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from case_index.documents import load_jsonl
from case_index.hermes_ocr import (
    normalize_ovis_executor_pin,
    normalize_worker_commit_pin,
    validate_flat_result_provenance_pins,
)
from case_index.ocr import OCR_RESULT_SCHEMA_SHA256, normalize_ocr_result


def main() -> None:
    parser = argparse.ArgumentParser(description="Validate transport-neutral OCR result JSONL")
    parser.add_argument("manifest", type=Path)
    parser.add_argument("results", type=Path)
    parser.add_argument("--require-all-jobs", action="store_true")
    parser.add_argument(
        "--expected-worker-commit",
        help="Reject every layer not produced by this exact 40-64 hex worker commit",
    )
    parser.add_argument(
        "--expected-ovis-file-store-executor-sha256",
        help=(
            "Require Ovis layers to carry this exact SHA-256 for the loaded "
            "FileStore executor source"
        ),
    )
    args = parser.parse_args()
    worker_pin = normalize_worker_commit_pin(args.expected_worker_commit)
    executor_pin = normalize_ovis_executor_pin(
        args.expected_ovis_file_store_executor_sha256
    )
    jobs = {job["jobId"]: job for job in load_jsonl(args.manifest)}
    if not jobs:
        raise RuntimeError("Job manifest is empty")
    results = load_jsonl(args.results)
    seen: set[str] = set()
    validated: list[dict] = []
    for position, result in enumerate(results, start=1):
        job_id = result.get("jobId")
        job = jobs.get(job_id)
        if not job:
            raise RuntimeError(f"Result row {position} has unknown jobId {job_id!r}")
        if result.get("outputSchemaSha256") != OCR_RESULT_SCHEMA_SHA256:
            raise RuntimeError(f"Result {job_id} uses an unexpected OCR schema hash")
        if result.get("imageSha256") != job["image"]["sha256"]:
            raise RuntimeError(f"Result {job_id} does not match the exported page image")
        validate_flat_result_provenance_pins(
            result,
            expected_worker_commit=worker_pin,
            expected_ovis_file_store_executor_sha256=executor_pin,
            context=f"Result {job_id} row {position}",
        )
        layer = normalize_ocr_result(
            result,
            job["caseId"],
            int(job["pageNumber"]),
            job["source"]["pdfSha256"],
        )
        for transform in layer["preprocessing"]["transforms"]:
            if transform.get("forwardMatrix") is None or transform.get("inverseMatrix") is None:
                raise RuntimeError(f"Result {job_id} preprocessing transform lacks an invertible coordinate mapping")
        seen.add(job_id)
        termination = layer.get("termination", {})
        validated.append({
            "jobId": job_id,
            "layerId": layer["layerId"],
            "status": layer["status"],
            "selectableAfterReview": (
                layer["status"] == "succeeded"
                and bool(str(layer.get("text", "")).strip())
                and termination.get("truncationKnown") is True
                and termination.get("truncated") is False
                and not layer["errors"]
            ),
        })
    missing = sorted(set(jobs) - seen)
    if args.require_all_jobs and missing:
        raise RuntimeError(f"No result for {len(missing)} job(s): {', '.join(missing[:10])}")
    report = {
        "valid": True,
        "results": validated,
        "missingJobIds": missing,
    }
    if worker_pin is not None or executor_pin is not None:
        report["provenancePins"] = {
            "expectedWorkerCommit": worker_pin,
            "expectedOvisFileStoreExecutorSha256": executor_pin,
        }
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
