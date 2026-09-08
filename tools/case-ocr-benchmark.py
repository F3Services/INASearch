#!/usr/bin/env python3
"""Summarize multi-engine OCR smoke results without selecting a layer."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from case_index.ocr_benchmark import write_benchmark


def main() -> None:
    parser = argparse.ArgumentParser(
        description=(
            "Create deterministic JSON and Markdown quality summaries for converted "
            "multi-engine OCR layers. No layer is selected or adjudicated."
        )
    )
    parser.add_argument("manifest", type=Path, help="Rich smoke manifest JSONL")
    parser.add_argument("results", type=Path, help="Converted multi-layer OCR result JSONL")
    parser.add_argument("json_output", type=Path, help="Detailed benchmark JSON output")
    parser.add_argument("markdown_output", type=Path, help="Concise benchmark Markdown output")
    parser.add_argument(
        "--derived-root", type=Path,
        help=(
            "Local derived case directory; enables conservative publisher-native-text "
            "proxy comparisons when manifest quality and hashes qualify"
        ),
    )
    parser.add_argument(
        "--require-all-jobs", action="store_true",
        help="Fail unless the results contain at least one layer for every manifest job",
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
    summary = write_benchmark(
        args.manifest,
        args.results,
        args.json_output,
        args.markdown_output,
        derived_root=args.derived_root,
        require_all_jobs=args.require_all_jobs,
        expected_worker_commit=args.expected_worker_commit,
        expected_ovis_file_store_executor_sha256=(
            args.expected_ovis_file_store_executor_sha256
        ),
    )
    print(json.dumps(summary, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
