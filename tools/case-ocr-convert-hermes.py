#!/usr/bin/env python3
"""Convert Hermes multi-engine OCR envelopes to local immutable result JSONL."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from case_index.hermes_ocr import convert_hermes_results


def main() -> None:
    parser = argparse.ArgumentParser(
        description=(
            "Validate Hermes inasearch-ocr-result/v1 envelopes against a rich "
            "local job manifest and flatten every engine layer for import"
        )
    )
    parser.add_argument("manifest", type=Path, help="Rich local manifest.jsonl used for the outbound export")
    parser.add_argument("results", type=Path, help="Hermes result JSON/JSONL file or completed-results directory")
    parser.add_argument("output", type=Path, help="Local schema-v2 JSONL to validate/import")
    parser.add_argument(
        "--require-all-jobs", action="store_true",
        help="Fail unless every manifest job has a returned envelope",
    )
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
    summary = convert_hermes_results(
        args.manifest, args.results, args.output,
        require_all_jobs=args.require_all_jobs,
        expected_worker_commit=args.expected_worker_commit,
        expected_ovis_file_store_executor_sha256=(
            args.expected_ovis_file_store_executor_sha256
        ),
    )
    print(json.dumps(summary, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
