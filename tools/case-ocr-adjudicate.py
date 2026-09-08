#!/usr/bin/env python3
"""Explicitly select or reject one imported OCR layer."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from case_index.documents import adjudicate_ocr_layer


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CASE_ROOT = ROOT / "sources" / "cases"


def main() -> None:
    parser = argparse.ArgumentParser(description="Adjudicate an imported OCR alternative; no selection is automatic")
    parser.add_argument("case_id")
    parser.add_argument("page_number", type=int)
    parser.add_argument("decision", choices=["select", "reject", "select-native"])
    parser.add_argument("--layer-id", help="Required for select/reject; shown in the derived page's ocrLayers array")
    parser.add_argument("--reviewer", required=True, help="Person or reviewed workflow responsible for this decision")
    parser.add_argument("--reason", required=True, help="Auditable reason for the decision")
    parser.add_argument("--case-root", type=Path, default=DEFAULT_CASE_ROOT)
    args = parser.parse_args()
    document = adjudicate_ocr_layer(
        ROOT,
        args.case_root.resolve(),
        args.case_id,
        args.page_number,
        args.decision,
        args.reviewer,
        args.reason,
        args.layer_id,
    )
    page = next(item for item in document["pages"] if item["pageNumber"] == args.page_number)
    print(json.dumps({
        "caseId": args.case_id,
        "pageNumber": args.page_number,
        "selectedTextMethod": page["selectedTextMethod"],
        "textSelection": page["textSelection"],
    }, indent=2))


if __name__ == "__main__":
    main()
