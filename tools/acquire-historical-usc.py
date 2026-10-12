#!/usr/bin/env python3
"""Acquire official GovInfo annual Title 8 XHTML snapshots (1994-2024).

Examples:
  python3 tools/acquire-historical-usc.py --years 1994,1995,1996,2012
  python3 tools/acquire-historical-usc.py --all

The downloader preserves source bytes and records URLs, sizes, and SHA-256
digests. It does not parse or alter the application corpus.
"""

import argparse
import hashlib
import json
import re
import subprocess
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DEST = ROOT / "sources/legal/raw/historical-usc/govinfo"
FIRST_YEAR = 1994
LAST_YEAR = 2024
LOC_MAIN_CHAPTERS = {1925: range(1, 10), 1934: range(1, 10), 1940: range(1, 12), 1946: range(1, 12), 1952: range(1, 13)}
LOC_LAST_SERIAL = {1925: 8, 1934: 6, 1940: 9, 1946: 13, 1952: 14}


def parse_years(spec):
    years = set()
    for part in spec.split(","):
        part = part.strip()
        match = re.fullmatch(r"(\d{4})(?:-(\d{4}))?", part)
        if not match:
            raise argparse.ArgumentTypeError("years must be comma-separated years or ranges")
        first = int(match.group(1))
        last = int(match.group(2) or first)
        if first > last or first < FIRST_YEAR or last > LAST_YEAR:
            raise argparse.ArgumentTypeError(f"years must fall within {FIRST_YEAR}-{LAST_YEAR}")
        years.update(range(first, last + 1))
    return sorted(years)


def url_for(year):
    name = f"USCODE-{year}-title8"
    return f"https://www.govinfo.gov/content/pkg/{name}/html/{name}.htm"


def validate(data, year):
    sample = data[:250_000]
    if len(data) < 100_000 or not sample.startswith(b"<!DOCTYPE html"):
        raise ValueError(f"{year}: response is not a Title 8 XHTML file")
    if b"TITLE 8" not in sample or b"ALIENS AND NATIONALITY" not in sample.upper():
        raise ValueError(f"{year}: Title 8 markers are missing")


def acquire(year, force=False):
    target = DEST / f"USCODE-{year}-title8.htm"
    url = url_for(year)
    if target.exists() and not force:
        data = target.read_bytes()
    else:
        for attempt in range(3):
            try:
                request = urllib.request.Request(url, headers={"User-Agent": "HD-QuickLookup-historical-research/1.0"})
                with urllib.request.urlopen(request, timeout=60) as response:
                    data = response.read()
                validate(data, year)
                target.parent.mkdir(parents=True, exist_ok=True)
                temporary = target.with_suffix(".htm.tmp")
                temporary.write_bytes(data)
                temporary.replace(target)
                break
            except (OSError, urllib.error.URLError, ValueError):
                if attempt == 2:
                    raise
                time.sleep(1 + attempt)
    validate(data, year)
    return {
        "year": year,
        "file": str(target.relative_to(ROOT)),
        "source": url,
        "bytes": len(data),
        "sha256": hashlib.sha256(data).hexdigest(),
    }


def loc_url(year, serial, chapter):
    stem = f"uscode{year}-{serial:03d}008{chapter:03d}"
    return f"https://tile.loc.gov/storage-services/service/ll/uscode/uscode{year}-{serial:03d}00/{stem}/{stem}.pdf"


def loc_exists(year, serial, chapter):
    url = loc_url(year, serial, chapter)
    result = subprocess.run(
        ["curl", "-sL", "-I", "--max-time", "30", "-o", "/dev/null", "-w", "%{http_code} %{content_type}", url],
        capture_output=True, text=True, check=True,
    )
    status, _, content_type = result.stdout.partition(" ")
    if status == "200" and content_type.startswith("application/pdf"):
        return True
    if status == "404":
        return False
    raise RuntimeError(f"LOC discovery failed for {year}/{serial}/{chapter}: {result.stdout.strip()}")


def acquire_loc(year, serial, chapter, force=False):
    filename = f"chapter-{chapter:02d}.pdf" if serial == 1 else f"serial-{serial:03d}-chapter-{chapter:02d}.pdf"
    target = ROOT / f"sources/legal/raw/historical-usc/loc/{year}/{filename}"
    url = loc_url(year, serial, chapter)
    if not target.exists() or force:
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = target.with_suffix(".pdf.tmp")
        try:
            subprocess.run(["curl", "-fLsS", "--retry", "2", "--max-time", "90", "-o", str(temporary), url], check=True)
            data = temporary.read_bytes()
            if not data.startswith(b"%PDF-") or len(data) < 1000:
                raise ValueError(f"{year} serial {serial} chapter {chapter}: invalid PDF")
            temporary.replace(target)
        finally:
            temporary.unlink(missing_ok=True)
    data = target.read_bytes()
    if not data.startswith(b"%PDF-"):
        raise ValueError(f"{year} serial {serial} chapter {chapter}: invalid PDF")
    return {
        "edition": year,
        "serial": serial,
        "chapter": chapter,
        "file": str(target.relative_to(ROOT)),
        "source": url,
        "bytes": len(data),
        "sha256": hashlib.sha256(data).hexdigest(),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--years", type=parse_years, help="e.g. 1994,1996-2000,2012")
    group.add_argument("--all", action="store_true", help="all GovInfo annual editions, 1994-2024")
    group.add_argument("--loc-main", action="store_true", help="LOC Title 8 main-edition chapter PDFs, 1925-1952")
    group.add_argument("--loc-complete", action="store_true", help="LOC Title 8 main editions and available supplements, 1925-1952")
    parser.add_argument("--force", action="store_true", help="redownload existing files")
    args = parser.parse_args()
    if args.loc_main or args.loc_complete:
        jobs = [(year, 1, chapter) for year, chapters in LOC_MAIN_CHAPTERS.items() for chapter in chapters]
        if args.loc_complete:
            possible = [(year, serial, chapter) for year, chapters in LOC_MAIN_CHAPTERS.items()
                        for serial in range(2, LOC_LAST_SERIAL[year] + 1) for chapter in chapters]
            with ThreadPoolExecutor(max_workers=8) as executor:
                found = list(executor.map(lambda job: loc_exists(*job), possible))
            jobs.extend(job for job, exists in zip(possible, found) if exists)
        records = []
        for year, serial, chapter in jobs:
            record = acquire_loc(year, serial, chapter, args.force)
            records.append(record)
            print(f"{year} serial {serial} chapter {chapter}: {record['bytes']} bytes {record['sha256']}")
        manifest = ROOT / "sources/legal/raw/historical-usc/loc/manifest.json"
        manifest.write_text(json.dumps({"schemaVersion": 1, "records": records}, indent=2) + "\n")
        print(f"Manifest: {manifest.relative_to(ROOT)}")
        return
    years = list(range(FIRST_YEAR, LAST_YEAR + 1)) if args.all else args.years
    records = []
    for year in years:
        record = acquire(year, args.force)
        records.append(record)
        print(f"{year}: {record['bytes']} bytes {record['sha256']}")
    manifest = DEST / "manifest.json"
    existing = {}
    if manifest.exists():
        existing = {record["year"]: record for record in json.loads(manifest.read_text())["records"]}
    existing.update({record["year"]: record for record in records})
    manifest.write_text(json.dumps({"schemaVersion": 1, "records": [existing[y] for y in sorted(existing)]}, indent=2) + "\n")
    print(f"Manifest: {manifest.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
