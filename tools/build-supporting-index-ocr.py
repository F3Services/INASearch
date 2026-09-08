#!/usr/bin/env python3
"""Build the non-canonical OCR queue for EOIR reporter volumes 1-15 indexes."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from case_index.supporting import build_topical_index_ocr_queue


REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CASE_ROOT = REPO_ROOT / "sources" / "cases"


def main() -> None:
    parser = argparse.ArgumentParser(
        description=(
            "Render the checksummed EOIR volumes 1-15 topical indexes at 300 DPI "
            "and emit a page-aligned, non-canonical OCR queue."
        )
    )
    parser.add_argument("--case-root", type=Path, default=DEFAULT_CASE_ROOT)
    parser.add_argument(
        "--output-root", type=Path,
        help="Override the ignored output directory (must remain below --case-root).",
    )
    parser.add_argument("--renderer", help="Explicit pdftoppm executable")
    parser.add_argument("--dpi", type=int, default=300, choices=[300])
    parser.add_argument(
        "--force", action="store_true", help="Re-render all PNGs instead of verifying/reusing them",
    )
    args = parser.parse_args()
    case_root = args.case_root.resolve()
    output_root = args.output_root.resolve() if args.output_root else None
    if output_root is not None and not output_root.is_relative_to(case_root):
        parser.error("--output-root must remain below --case-root so queue paths stay portable")
    summary = build_topical_index_ocr_queue(
        case_root, dpi=args.dpi, force=args.force,
        renderer=args.renderer, output_root=output_root,
    )
    print(json.dumps(summary, indent=2, ensure_ascii=False, sort_keys=True))


if __name__ == "__main__":
    main()
