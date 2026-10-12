#!/usr/bin/env python3
"""Extract page-marked OCR and candidate section headings from captured LOC PDFs.

Requires PyMuPDF (``fitz``). This is a research aid: the LOC text layer is OCR,
especially noisy in 1925, and each candidate must be checked against page image.
"""

import json
import re
from pathlib import Path

import fitz


ROOT = Path(__file__).resolve().parents[1]
LOC = ROOT / "sources/legal/raw/historical-usc/loc"
MARK = re.compile(r"^\s*((?:§{1,2}|[Ss]ection)\s*)?(\d{1,4}[a-z]?(?:[–-]\d+[a-z]?)?)\.\s*(\S.*)$")


def main():
    manifest = json.loads((LOC / "manifest.json").read_text())
    candidates = []
    summary = []
    for record in manifest["records"]:
        source = ROOT / record["file"]
        edition = record["edition"]
        chapter = record["chapter"]
        serial = record.get("serial", 1)
        stem = source.stem
        text_path = LOC / "text" / str(edition) / f"{stem}.txt"
        text_path.parent.mkdir(parents=True, exist_ok=True)
        pages = []
        with fitz.open(source) as document:
            for page_number, page in enumerate(document, 1):
                content = page.get_text()
                pages.append(f"\n=== PDF PAGE {page_number} / {len(document)} ===\n{content}")
                lines = content.splitlines()
                matches = [(index, MARK.match(line), line) for index, line in enumerate(lines)]
                matches = [(index, match, line) for index, match, line in matches if match]
                dense_toc = len(matches) >= 12 and any(line.strip().lower() in ("sec.", "se c.") for line in lines[:30])
                for index, match, line in matches:
                    marker = (match.group(1) or "").strip()
                    likely_toc = not marker and dense_toc
                    candidates.append({
                        "edition": edition,
                        "serial": serial,
                        "chapter": chapter,
                        "sectionCandidate": match.group(2),
                        "headingLine": line.strip(),
                        "marker": marker or "bare-number",
                        "explicitSectionSign": marker.startswith("§"),
                        "likelyTableOfContents": likely_toc,
                        "confidence": "high" if marker else ("low" if likely_toc else "medium"),
                        "pdfPage": page_number,
                        "sourceFile": record["file"],
                        "textFile": str(text_path.relative_to(ROOT)),
                    })
        text = "".join(pages)
        text_path.write_text(text)
        summary.append({"edition": edition, "serial": serial, "chapter": chapter,
                        "pdfPages": len(pages), "ocrCharacters": len(text),
                        "sourceFile": record["file"], "textFile": str(text_path.relative_to(ROOT))})
    out = LOC / "ocr-index.json"
    out.write_text(json.dumps({"schemaVersion": 1, "warning": "Unreviewed OCR; section headings are candidates and include false positives from tables and notes.",
                               "documents": summary, "candidates": candidates}, indent=2) + "\n")
    print(f"Extracted {len(summary)} PDFs, {sum(r['pdfPages'] for r in summary)} pages, {len(candidates)} heading candidates")
    print(f"Index: {out.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
