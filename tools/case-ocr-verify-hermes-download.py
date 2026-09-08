#!/usr/bin/env python3
"""Create and verify a path-safe, ledger-bound Hermes result download."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from case_index.hermes_download import (
    validate_download_plan,
    verify_downloaded_results,
    write_files_from,
)


def main() -> None:
    parser = argparse.ArgumentParser(
        description=(
            "Bind a Hermes result ledger to the outbound transfer map, optionally "
            "write an rsync --files-from allowlist, and verify downloaded raw bytes."
        )
    )
    parser.add_argument("transfer_map", type=Path)
    parser.add_argument("result_ledger", type=Path)
    parser.add_argument(
        "--expected-transfer-map-sha256",
        help="Reject a local transfer map that differs from this independently recorded hash",
    )
    parser.add_argument(
        "--expected-job-count", type=int,
        help="Reject an accidentally truncated transfer map/ledger pair",
    )
    parser.add_argument("--expected-ledger-sha256")
    parser.add_argument("--expected-worker-commit")
    parser.add_argument(
        "--reject-unknown-or-error-categories", action="store_true",
        help=(
            "Allow only clean layers, exact known Ovis guard truncations, and "
            "the two exact nonselectable Paddle artifact truncations across "
            "the supported ledger contracts"
        ),
    )
    parser.add_argument("--write-files-from", type=Path)
    parser.add_argument(
        "--download-root", type=Path,
        help="Root below which the ledger's results/... paths were retrieved",
    )
    args = parser.parse_args()
    plan = validate_download_plan(
        args.transfer_map,
        args.result_ledger,
        expected_transfer_map_sha256=args.expected_transfer_map_sha256,
        expected_job_count=args.expected_job_count,
        expected_ledger_sha256=args.expected_ledger_sha256,
        expected_worker_commit=args.expected_worker_commit,
        reject_unknown_or_error_categories=args.reject_unknown_or_error_categories,
    )
    report = {
        key: value for key, value in plan.items()
        if key not in {"retrievalPaths", "results"}
    }
    report["retrievalPathCount"] = len(plan["retrievalPaths"])
    if args.write_files_from:
        report["filesFrom"] = args.write_files_from.resolve().as_posix()
        report["filesFromSha256"] = write_files_from(plan, args.write_files_from)
    if args.download_root:
        report["download"] = verify_downloaded_results(plan, args.download_root)
    print(json.dumps(report, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
