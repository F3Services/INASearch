#!/usr/bin/env python3
"""Capture official chapter/subchapter front-matter destinations."""
import hashlib
import json
from pathlib import Path
import re
from urllib.request import urlopen

SOURCE = "https://uscode.house.gov/front_matter.json"
# The printed 1996 Code's chapter-28 contents (p. 174) and subchapter
# heading (p. 553) verify this former destination; current section 1135
# belongs to a different subchapter and cannot substitute for it.
HISTORICAL_TARGETS = {
    "20:28:X": {
        "heading": "SUBCHAPTER X—POSTSECONDARY IMPROVEMENT PROGRAMS",
        "edition": "1996",
        "url": "https://www.govinfo.gov/content/pkg/USCODE-1996-title20/pdf/USCODE-1996-title20.pdf#page=553",
        "citationNote": "Former subchapter X (Postsecondary Improvement Programs). This link opens the 1996 U.S. Code."
    }
}


def main():
    raw = urlopen(SOURCE, timeout=60).read()
    source = json.loads(raw)
    release = max(source, key=lambda value: tuple(map(int, value.split("-"))))
    targets = {}
    ambiguous = {}
    for record in source[release]:
        units = record.get("path", [])
        if not units or units[-1][0] not in ("chapter", "subchapter"):
            continue
        numbers = {}
        for kind, label in units:
            match = re.match(r"\[?(?:SUBCHAPTER|CHAPTER)\s+([A-Z0-9]+(?:[–-][A-Z0-9]+)*)\b", label, re.I)
            if kind in ("chapter", "subchapter") and match:
                numbers[kind] = match[1].replace("–", "-")
        if "chapter" not in numbers or units[-1][0] not in numbers:
            continue
        key = f'{record["title"]}:{numbers["chapter"]}:{numbers.get("subchapter", "")}'
        target = {"heading": units[-1][1], "url": f'https://uscode.house.gov/us/usc/{release}/t{record["title"]}/{record["slug"]}.html'}
        if key in ambiguous:
            if target not in ambiguous[key]:
                ambiguous[key].append(target)
        elif key in targets and targets[key] != target:
            ambiguous[key] = [targets.pop(key), target]
        else:
            targets[key] = target
    output = {"schemaVersion": 1, "sourceUrl": SOURCE, "sourceSha256": hashlib.sha256(raw).hexdigest(), "releasePoint": release, "targets": targets, "ambiguous": ambiguous, "historicalTargets": HISTORICAL_TARGETS}
    destination = Path(__file__).resolve().parents[1] / "sources/legal/usc-hierarchy-links.json"
    destination.write_text(json.dumps(output, indent=2) + "\n")
    print(f"Captured {len(targets)} official chapter/subchapter destinations ({release}).")


if __name__ == "__main__":
    main()
