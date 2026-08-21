#!/usr/bin/env python3
"""Generate and independently audit the USCIS INA-to-U.S.C. crosswalk."""

from __future__ import annotations

import argparse
import hashlib
import html
import json
import os
import re
import tempfile
import xml.etree.ElementTree as ET
from html.parser import HTMLParser
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CORPUS_PATH = ROOT / "src" / "INASearch-Corpus.js"
MANIFEST_PATH = ROOT / "sources" / "legal" / "source-manifest.json"
AUDIT_PATH = ROOT / "sources" / "legal" / "ina-crosswalk-audit.json"
USCIS_SOURCE_URL = "https://www.uscis.gov/legal-resources/immigration-and-nationality-act"

REPEALED_TOC_ONLY = {"210A", "321", "323", "345", "348", "350", "352", "353", "354", "355"}
FORMER_SECTIONS = {
    "242A": r"title\s+II,\s+ch\.\s*5,\s*§\s*242A",
    "242B": r"title\s+II,\s+ch\.\s*5,\s*§\s*242B",
    "295": r"title\s+II,\s+ch\.\s*9,\s*§\s*295",
}
NO_EQUIVALENT = {"401", "402", "403"}
NOTE_SECTIONS = {"404", "405", "406", "407"}


def sha256(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def atomic_write(path: Path, value: str) -> None:
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(value)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_name, path)
    finally:
        if os.path.exists(temporary_name):
            os.unlink(temporary_name)


def assigned_object(path: Path) -> dict:
    source = path.read_text(encoding="utf-8")
    start = source.find("{")
    end = source.rfind("}")
    if start < 0 or end < start:
        raise RuntimeError(f"Could not locate assigned object in {path}")
    return json.loads(source[start : end + 1])


def normalized_text(value: str) -> str:
    return re.sub(r"\s+", " ", html.unescape(value or "").replace("\u200b", "")).strip()


def normalized_identifier(value: str) -> str:
    return re.sub(r"\s+", " ", str(value or "").replace("–", "-").replace("—", "-").replace("−", "-")).strip().lower()


def local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def element_text(element: ET.Element | None) -> str:
    return normalized_text("" if element is None else "".join(element.itertext()))


class CrosswalkParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.group = ""
        self.groups: list[str] = []
        self.rows: list[dict] = []
        self._accordion_depth = 0
        self._accordion_chunks: list[str] = []
        self._in_table = False
        self._row: list[dict] | None = None
        self._cell: dict | None = None

    @staticmethod
    def classes(attributes: list[tuple[str, str | None]]) -> set[str]:
        value = next((value or "" for name, value in attributes if name == "class"), "")
        return set(value.split())

    def handle_starttag(self, tag: str, attributes: list[tuple[str, str | None]]) -> None:
        classes = self.classes(attributes)
        if tag == "div" and "accordion__header" in classes:
            self._accordion_depth = 1
            self._accordion_chunks = []
            return
        if self._accordion_depth and tag == "div":
            self._accordion_depth += 1
        if tag == "table" and "dataTable" in classes:
            self._in_table = True
        elif self._in_table and tag == "tr":
            self._row = []
        elif self._row is not None and tag == "td":
            self._cell = {"chunks": [], "href": ""}
        elif self._cell is not None and tag == "a":
            self._cell["href"] = next((value or "" for name, value in attributes if name == "href"), "")

    def handle_endtag(self, tag: str) -> None:
        if self._accordion_depth and tag == "div":
            self._accordion_depth -= 1
            if self._accordion_depth == 0:
                value = normalized_text("".join(self._accordion_chunks))
                if re.match(r"Title\s+[IVX]+:", value, re.I):
                    self.group = value
                    self.groups.append(value)
                self._accordion_chunks = []
        if self._cell is not None and tag == "td":
            self._cell["text"] = normalized_text("".join(self._cell.pop("chunks")))
            assert self._row is not None
            self._row.append(self._cell)
            self._cell = None
        elif self._row is not None and tag == "tr":
            if len(self._row) == 3 and re.fullmatch(r"INA\s+[0-9]+[A-Za-z]?", self._row[0]["text"], re.I):
                self.rows.append({"group": self.group, "cells": self._row})
            self._row = None
        elif self._in_table and tag == "table":
            self._in_table = False

    def handle_data(self, data: str) -> None:
        if self._accordion_depth:
            self._accordion_chunks.append(data)
        if self._cell is not None:
            self._cell["chunks"].append(data)


def manifest_artifacts() -> tuple[dict, dict[str, dict]]:
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    artifacts = {
        artifact["id"]: artifact
        for source in manifest.get("sources", [])
        for artifact in source.get("artifacts", [])
    }
    for artifact in artifacts.values():
        value = (ROOT / artifact["path"]).read_bytes()
        if len(value) != artifact["bytes"] or sha256(value) != artifact["sha256"]:
            raise RuntimeError(f"Captured-source integrity failure: {artifact['path']}")
    return manifest, artifacts


def house_url(section: str) -> str:
    return (
        "https://uscode.house.gov/view.xhtml?req="
        f"granuleid:USC-prelim-title8-section{section}&num=0&edition=prelim"
    )


def corpus_local_section(usc_section: str, sections: list[dict]) -> str:
    target = normalized_identifier(usc_section)
    for section in sections:
        if normalized_identifier(section.get("section", "")) == target:
            return str(section["section"])
    if target.isdigit():
        number = int(target)
        for section in sections:
            match = re.fullmatch(r"(\d+)\s+to\s+(\d+)", normalized_identifier(section.get("section", "")))
            if match and int(match.group(1)) <= number <= int(match.group(2)):
                return str(section["section"])
    raise RuntimeError(f"USCIS mapping 8 U.S.C. {usc_section} has no local Title 8 record")


def parsed_crosswalk(html_bytes: bytes, corpus: dict, capture_date: str, source_hash: str) -> list[dict]:
    parser = CrosswalkParser()
    parser.feed(html_bytes.decode("utf-8"))
    if len(parser.rows) != 183 or len(parser.groups) != 5:
        raise RuntimeError(f"Expected five USCIS groups and 183 rows; found {len(parser.groups)} groups and {len(parser.rows)} rows")

    rows: list[dict] = []
    seen: set[str] = set()
    sections = corpus.get("title8", {}).get("sections", [])
    for parsed in parser.rows:
        ina_text, usc_cell, title_cell = parsed["cells"]
        ina_match = re.fullmatch(r"INA\s+([0-9]+[A-Za-z]?)", ina_text["text"], re.I)
        assert ina_match
        ina_section = ina_match.group(1).upper()
        if ina_section in seen:
            raise RuntimeError(f"Duplicate USCIS INA section {ina_section}")
        seen.add(ina_section)
        usc_label = usc_cell["text"]
        has_equivalent = normalized_identifier(usc_label) != "no equivalent"
        is_note = bool(re.search(r",\s*note$", usc_label, re.I))
        usc_match = re.match(r"8\s+U\.S\.C\.\s+([^,\s]+)", usc_label, re.I) if has_equivalent else None
        if has_equivalent and not usc_match:
            raise RuntimeError(f"Unrecognized USCIS locator for INA {ina_section}: {usc_label}")
        usc_section = normalized_identifier(usc_match.group(1)) if usc_match else ""
        local_section = "" if is_note or not has_equivalent else corpus_local_section(usc_section, sections)
        canonical_url = house_url(usc_section) if has_equivalent else ""
        supporting_excerpt = f"{ina_text['text']} | {usc_label} | {title_cell['text']}"
        source = {
            "resource": "USCIS Immigration and Nationality Act crosswalk",
            "locator": f"{parsed['group']} > {ina_text['text']} > {usc_label}",
            "url": USCIS_SOURCE_URL,
            "captureDate": capture_date,
            "sourceArtifact": "sources/legal/raw/uscis-ina-crosswalk.html",
            "sourceSha256": source_hash,
            "supportingExcerpt": supporting_excerpt,
        }
        if title_cell["href"]:
            source["sourceHref"] = title_cell["href"]
        rows.append(
            {
                "inaSection": ina_section,
                "uscSection": usc_section,
                "localSection": local_section,
                "uscLabel": usc_label,
                "title": title_cell["text"],
                "group": parsed["group"],
                "url": canonical_url,
                "isNote": is_note,
                "hasEquivalent": has_equivalent,
                "source": source,
            }
        )
    return rows


USC_PATTERN = re.compile(r"8\s*\.?\s*U\s*\.?\s*S\s*\.?\s*C\s*\.?\s+([^\]]+)", re.I)


def normalized_usc_locator(value: str) -> str:
    match = USC_PATTERN.search(value.replace("–", "-").replace("—", "-").replace("−", "-"))
    if not match:
        return ""
    locator = re.sub(r"\s+", " ", match.group(1)).strip().rstrip(".")
    locator = re.sub(r"\s*,\s*note\b", ", note", locator, flags=re.I)
    return f"8 U.S.C. {locator.lower()}"


def govinfo_evidence(xml_bytes: bytes) -> tuple[dict[str, str], dict[str, str]]:
    root = ET.fromstring(xml_bytes)
    body: dict[str, str] = {}
    toc: dict[str, str] = {}
    for element in root.iter():
        name = local_name(element.tag)
        if name == "section":
            number_element = next((child for child in element if local_name(child.tag) == "num"), None)
            number = str(number_element.attrib.get("value", "")).upper() if number_element is not None else ""
            if not number:
                continue
            notes = [child for child in element if local_name(child.tag) == "editorialNote"]
            candidates = [note for note in notes if note.attrib.get("role") == "uscRef"]
            if not candidates:
                candidates = [note for note in notes if re.fullmatch(r"\[\s*8\s*\.?\s*U\s*\.?\s*S\s*\.?\s*C\s*\.?[^]]+\]\s*", element_text(note), re.I)]
            if len(candidates) > 1:
                raise RuntimeError(f"Multiple GovInfo USC mappings for INA {number}")
            if candidates:
                locator = normalized_usc_locator(element_text(candidates[0]))
                if not locator:
                    raise RuntimeError(f"Unparseable GovInfo USC mapping for INA {number}")
                body[number] = locator
        elif name == "referenceItem":
            value = element_text(element).strip("[] ")
            match = re.match(r"(?:Sec\.|Section)\s+([0-9]+[A-Za-z]?)\.?\s*(.*)", value, re.I)
            if match:
                toc[match.group(1).upper()] = match.group(2).strip(" .")
    return body, toc


def find_text(value) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return " ".join(find_text(item) for item in value)
    if isinstance(value, dict):
        return " ".join(find_text(item) for item in value.values())
    return ""


def audit_crosswalk(rows: list[dict], corpus: dict, govinfo_xml: bytes, manifest: dict, artifacts: dict[str, dict]) -> dict:
    body, toc = govinfo_evidence(govinfo_xml)
    by_local = {str(section.get("section")): section for section in corpus.get("title8", {}).get("sections", [])}
    outcomes: list[dict] = []
    counts: dict[str, int] = {}

    for row in rows:
        ina = row["inaSection"]
        expected = normalized_usc_locator(row["uscLabel"])
        actual = body.get(ina, "")
        evidence: dict = {}
        if ina in NO_EQUIVALENT:
            if row["hasEquivalent"] or actual or ina not in toc:
                raise RuntimeError(f"INA {ina} no-equivalent evidence failed")
            outcome = "govinfo-no-equivalent"
            evidence = {"govinfoToc": toc[ina]}
        elif ina in NOTE_SECTIONS:
            if not row["isNote"] or expected != actual:
                raise RuntimeError(f"INA {ina} note mapping mismatch: USCIS {expected!r}, GovInfo {actual!r}")
            outcome = "govinfo-note-mapping"
            evidence = {"govinfoLocator": actual}
        elif actual:
            if expected != actual:
                raise RuntimeError(f"INA {ina} mapping mismatch: USCIS {expected!r}, GovInfo {actual!r}")
            if ina == "239":
                outcome = "govinfo-direct-malformed-source-normalized"
            elif ina == "329A":
                outcome = "govinfo-direct-dash-normalized"
            else:
                outcome = "govinfo-direct-mapping"
            evidence = {"govinfoLocator": actual}
        elif ina in REPEALED_TOC_ONLY:
            if "repealed" not in toc.get(ina, "").lower():
                raise RuntimeError(f"GovInfo does not identify INA {ina} as a repealed TOC-only section")
            local = by_local.get(row["localSection"])
            if not local or str(local.get("status", "current")) != "repealed":
                raise RuntimeError(f"House corpus does not independently identify {row['uscLabel']} as repealed")
            outcome = "govinfo-repealed-toc-house-codification"
            evidence = {"govinfoToc": toc[ina], "houseLocalSection": row["localSection"]}
        elif ina in FORMER_SECTIONS:
            local = by_local.get(row["localSection"])
            if ina in toc or not local or not re.search(FORMER_SECTIONS[ina], find_text(local), re.I):
                raise RuntimeError(f"House codification proof for former INA {ina} was not found")
            outcome = "house-former-section-codification"
            evidence = {"houseLocalSection": row["localSection"], "proofPattern": FORMER_SECTIONS[ina]}
        else:
            raise RuntimeError(f"INA {ina} has no independent GovInfo mapping and no reviewed exception")

        counts[outcome] = counts.get(outcome, 0) + 1
        outcomes.append(
            {
                "inaSection": ina,
                "uscLabel": row["uscLabel"],
                "localSection": row["localSection"],
                "outcome": outcome,
                "evidence": evidence,
            }
        )

    if len(outcomes) != 183 or sum(counts.values()) != 183:
        raise RuntimeError("Independent crosswalk audit did not classify all 183 rows exactly once")
    return {
        "schemaVersion": 1,
        "capturedAt": manifest["capturedAt"],
        "crosswalkRows": len(outcomes),
        "counts": counts,
        "sources": {
            "uscis": {key: artifacts["uscis-ina-crosswalk-html"][key] for key in ("path", "bytes", "sha256")},
            "govinfo": {key: artifacts["govinfo-comps-1376"][key] for key in ("path", "bytes", "sha256")},
            "house": {key: artifacts["house-title-8-xml"][key] for key in ("path", "bytes", "sha256")},
        },
        "rows": outcomes,
    }


def rendered_crosswalk(rows: list[dict]) -> str:
    value = json.dumps(rows, indent=2, ensure_ascii=False).replace("<", "\\u003c")
    return '  "inaCrosswalk": ' + value.replace("\n", "\n  ")


def replace_crosswalk(source: str, rows: list[dict]) -> str:
    start = source.find('  "inaCrosswalk": [')
    end = source.find('\n  "policyManual": {', start)
    if start < 0 or end < start:
        raise RuntimeError("Could not locate the embedded INA crosswalk in INASearch-Corpus.js")
    return source[:start] + rendered_crosswalk(rows) + "," + source[end:]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--write", action="store_true", help="Replace the embedded reviewed crosswalk and audit artifact")
    args = parser.parse_args()

    manifest, artifacts = manifest_artifacts()
    corpus = assigned_object(CORPUS_PATH)
    uscis_artifact = artifacts["uscis-ina-crosswalk-html"]
    govinfo_artifact = artifacts["govinfo-comps-1376"]
    uscis_html = (ROOT / uscis_artifact["path"]).read_bytes()
    rows = parsed_crosswalk(uscis_html, corpus, manifest["capturedAt"], uscis_artifact["sha256"])
    audit = audit_crosswalk(rows, corpus, (ROOT / govinfo_artifact["path"]).read_bytes(), manifest, artifacts)
    expected_corpus_source = replace_crosswalk(CORPUS_PATH.read_text(encoding="utf-8"), rows)
    expected_audit = json.dumps(audit, indent=2, ensure_ascii=False) + "\n"
    if args.write:
        atomic_write(CORPUS_PATH, expected_corpus_source)
        atomic_write(AUDIT_PATH, expected_audit)
    else:
        if CORPUS_PATH.read_text(encoding="utf-8") != expected_corpus_source:
            raise RuntimeError("Embedded INA crosswalk is stale; run with --write")
        if not AUDIT_PATH.exists() or AUDIT_PATH.read_text(encoding="utf-8") != expected_audit:
            raise RuntimeError("INA crosswalk audit is stale; run with --write")
    print(f"Audited {len(rows)} INA crosswalk rows: {json.dumps(audit['counts'], sort_keys=True)}")


if __name__ == "__main__":
    main()
