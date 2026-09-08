#!/usr/bin/env python3
"""Generate the deterministic OCR queue and 200-page benchmark manifest."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from case_index.ocr_queue import generate_manifests


ROOT = Path(__file__).resolve().parents[1]


def main() -> None:
    parser = argparse.ArgumentParser(description="Build severe-first OCR and stratified gold-set manifests")
    parser.add_argument("--case-root", type=Path, default=ROOT / "sources" / "cases")
    parser.add_argument("--output-root", type=Path, help="Default: CASE_ROOT/index")
    parser.add_argument("--dpi", type=int, default=300)
    args = parser.parse_args()
    case_root = args.case_root.resolve()
    output_root = args.output_root.resolve() if args.output_root else case_root / "index"
    print(json.dumps(generate_manifests(ROOT, case_root, output_root, args.dpi), indent=2))


if __name__ == "__main__":
    main()
