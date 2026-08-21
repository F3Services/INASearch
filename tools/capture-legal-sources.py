#!/usr/bin/env python3
"""Capture and verify the pinned primary-source artifacts used by INASearch.

The committed files under sources/legal/raw are immutable release inputs.  A
refresh is always explicit so a live-site change cannot silently replace the
evidence for an existing corpus release.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import tempfile
import urllib.request
import zipfile
from email.message import Message
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SOURCE_ROOT = ROOT / "sources" / "legal"
RAW_ROOT = SOURCE_ROOT / "raw"
MANIFEST_PATH = SOURCE_ROOT / "source-manifest.json"

HOUSE_RELEASE_POINT = "119-102"
HOUSE_URL = (
    "https://uscode.house.gov/download/releasepoints/us/pl/119/102/"
    "xml_usc08@119-102.zip"
)
GOVINFO_URL = "https://www.govinfo.gov/content/pkg/COMPS-1376/uslm/COMPS-1376.xml"
USCIS_URL = "https://www.uscis.gov/legal-resources/immigration-and-nationality-act"


def sha256(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def atomic_write(path: Path, value: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(value)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_name, path)
    finally:
        if os.path.exists(temporary_name):
            os.unlink(temporary_name)


def fetch(url: str) -> tuple[bytes, str, Message]:
    request = urllib.request.Request(
        url,
        headers={"User-Agent": "INASearch legal-source capture (source audit)"},
    )
    with urllib.request.urlopen(request, timeout=120) as response:
        return response.read(), response.geturl(), response.headers


def artifact(identifier: str, role: str, path: Path, value: bytes, media_type: str) -> dict:
    return {
        "id": identifier,
        "role": role,
        "path": path.relative_to(ROOT).as_posix(),
        "mediaType": media_type,
        "bytes": len(value),
        "sha256": sha256(value),
    }


def response_metadata(requested_url: str, final_url: str, headers: Message) -> dict:
    return {
        "requestedUrl": requested_url,
        "finalUrl": final_url,
        "lastModified": headers.get("Last-Modified"),
        "etag": headers.get("ETag"),
    }


def capture(captured_at: str, refresh: bool) -> dict:
    if MANIFEST_PATH.exists() and not refresh:
        raise RuntimeError(
            f"{MANIFEST_PATH.relative_to(ROOT)} already exists; pass --refresh to replace a reviewed capture"
        )

    house_zip, house_final_url, house_headers = fetch(HOUSE_URL)
    with tempfile.TemporaryDirectory(prefix="inasearch-house-") as temporary:
        archive_path = Path(temporary) / "title8.zip"
        archive_path.write_bytes(house_zip)
        with zipfile.ZipFile(archive_path) as archive:
            names = [name for name in archive.namelist() if not name.endswith("/")]
            if names != ["usc08.xml"]:
                raise RuntimeError(f"Unexpected House archive members: {names}")
            house_xml = archive.read("usc08.xml")
    if b"/us/usc/t8" not in house_xml or b"aliens and nationality" not in house_xml.lower():
        raise RuntimeError("House archive does not appear to contain Title 8 USLM")

    govinfo_xml, govinfo_final_url, govinfo_headers = fetch(GOVINFO_URL)
    if b"Immigration and Nationality Act" not in govinfo_xml or b"statuteCompilation" not in govinfo_xml:
        raise RuntimeError("GovInfo artifact does not appear to be COMPS-1376")

    uscis_html, uscis_final_url, uscis_headers = fetch(USCIS_URL)
    if uscis_html.count(b"INA ") < 180 or b"U.S. Code" not in uscis_html:
        raise RuntimeError("USCIS artifact does not contain the expected INA crosswalk")

    paths = {
        "house_zip": RAW_ROOT / f"xml_usc08@{HOUSE_RELEASE_POINT}.zip",
        "house_xml": RAW_ROOT / f"usc08@{HOUSE_RELEASE_POINT}.xml",
        "govinfo": RAW_ROOT / "COMPS-1376.xml",
        "uscis": RAW_ROOT / "uscis-ina-crosswalk.html",
    }
    atomic_write(paths["house_zip"], house_zip)
    atomic_write(paths["house_xml"], house_xml)
    atomic_write(paths["govinfo"], govinfo_xml)
    atomic_write(paths["uscis"], uscis_html)

    manifest = {
        "schemaVersion": 1,
        "capturedAt": captured_at,
        "sources": [
            {
                "id": "house-title-8-uslm",
                "publisher": "Office of the Law Revision Counsel, U.S. House of Representatives",
                "releasePoint": HOUSE_RELEASE_POINT,
                "currentThroughPublicLaw": HOUSE_RELEASE_POINT,
                **response_metadata(HOUSE_URL, house_final_url, house_headers),
                "artifacts": [
                    artifact("house-title-8-archive", "downloaded-archive", paths["house_zip"], house_zip, "application/zip"),
                    artifact("house-title-8-xml", "extracted-uslm", paths["house_xml"], house_xml, "application/xml"),
                ],
            },
            {
                "id": "govinfo-ina-compilation",
                "publisher": "U.S. Government Publishing Office",
                "packageId": "COMPS-1376",
                **response_metadata(GOVINFO_URL, govinfo_final_url, govinfo_headers),
                "artifacts": [artifact("govinfo-comps-1376", "downloaded-uslm", paths["govinfo"], govinfo_xml, "application/xml")],
            },
            {
                "id": "uscis-ina-crosswalk",
                "publisher": "U.S. Citizenship and Immigration Services",
                **response_metadata(USCIS_URL, uscis_final_url, uscis_headers),
                "artifacts": [artifact("uscis-ina-crosswalk-html", "downloaded-html", paths["uscis"], uscis_html, "text/html")],
            },
        ],
    }
    atomic_write(MANIFEST_PATH, (json.dumps(manifest, indent=2, ensure_ascii=False) + "\n").encode("utf-8"))
    return manifest


def verify() -> dict:
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    if manifest.get("schemaVersion") != 1:
        raise RuntimeError("Unsupported legal-source manifest schema")
    artifacts = [item for source in manifest.get("sources", []) for item in source.get("artifacts", [])]
    if len(artifacts) != 4:
        raise RuntimeError(f"Expected four captured legal-source artifacts, found {len(artifacts)}")
    for item in artifacts:
        path = ROOT / item["path"]
        value = path.read_bytes()
        if len(value) != item["bytes"]:
            raise RuntimeError(f"Byte-count mismatch for {item['path']}")
        if sha256(value) != item["sha256"]:
            raise RuntimeError(f"SHA-256 mismatch for {item['path']}")

    by_id = {item["id"]: item for item in artifacts}
    archive_path = ROOT / by_id["house-title-8-archive"]["path"]
    with zipfile.ZipFile(archive_path) as archive:
        if archive.read("usc08.xml") != (ROOT / by_id["house-title-8-xml"]["path"]).read_bytes():
            raise RuntimeError("Extracted House XML does not match the captured ZIP member")
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)
    capture_parser = subparsers.add_parser("capture", help="Download a reviewed set of pinned official artifacts")
    capture_parser.add_argument("--capture-date", default=dt.date.today().isoformat())
    capture_parser.add_argument("--refresh", action="store_true", help="Explicitly replace an existing reviewed capture")
    subparsers.add_parser("verify", help="Verify committed source bytes against the manifest")
    args = parser.parse_args()

    manifest = capture(args.capture_date, args.refresh) if args.command == "capture" else verify()
    artifact_count = sum(len(source.get("artifacts", [])) for source in manifest["sources"])
    print(f"Verified {artifact_count} legal-source artifacts captured {manifest['capturedAt']}")


if __name__ == "__main__":
    main()
