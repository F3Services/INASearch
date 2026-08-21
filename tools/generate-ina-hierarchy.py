#!/usr/bin/env python3
"""Generate the reviewed INA title/chapter/section hierarchy from GovInfo USLM."""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import re
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CORPUS_PATH = ROOT / "src" / "INASearch-Corpus.js"
OUTPUT_PATH = ROOT / "src" / "INASearch-INA-Hierarchy.js"
USLM_URL = "https://www.govinfo.gov/content/pkg/COMPS-1376/uslm/COMPS-1376.xml"
DETAIL_URL = "https://www.govinfo.gov/app/details/COMPS-1376"
INA_SOURCE_URL = "https://www.uscis.gov/legal-resources/immigration-and-nationality-act"
NS = {"uslm": "http://schemas.gpo.gov/xml/uslm"}
ROMAN_BY_NUMBER = {1: "I", 2: "II", 3: "III", 4: "IV", 5: "V"}

# These obsolete provisions no longer appear in the current Act's table of
# contents. Their original placement is stated in the House codification notes
# embedded in the Title 8 corpus and is verified below before they are emitted.
FORMER_PLACEMENTS = {
    "242A": (2, "5", r"title\s+II,\s+ch\.\s*5,\s*§\s*242A"),
    "242B": (2, "5", r"title\s+II,\s+ch\.\s*5,\s*§\s*242B"),
    "295": (2, "9", r"title\s+II,\s+ch\.\s*9,\s*§\s*295"),
}


def assigned_object(path: Path) -> dict:
    source = path.read_text(encoding="utf-8")
    start = source.find("{")
    end = source.rfind("}")
    if start < 0 or end < start:
        raise ValueError(f"Could not locate assigned JSON object in {path}")
    return json.loads(source[start : end + 1])


def local_name(element: ET.Element) -> str:
    return element.tag.rsplit("}", 1)[-1]


def clean_text(element: ET.Element | None) -> str:
    if element is None:
        return ""
    pieces: list[str] = []

    def visit(node: ET.Element) -> None:
        if local_name(node) == "ref" and node.attrib.get("class") == "footnoteRef":
            if node.tail:
                pieces.append(node.tail)
            return
        if node.text:
            pieces.append(node.text)
        for child in node:
            visit(child)
        if node is not element and node.tail:
            pieces.append(node.tail)

    visit(element)
    return re.sub(r"\s+", " ", "".join(pieces)).strip()


def reference_text(item: ET.Element) -> tuple[str, str]:
    children = list(item)
    designator = next((clean_text(child) for child in children if local_name(child) == "designator"), "")
    label = next((clean_text(child) for child in children if local_name(child) == "label"), "")
    if designator or label:
        return designator, label
    text = clean_text(item).strip("[] ")
    match = re.match(r"(?:Sec\.|Section)\s+([0-9]+[A-Za-z]?)\.\s*(.*)", text, re.I)
    return (f"Sec. {match.group(1)}.", match.group(2)) if match else (text, "")


def find_text(value) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return " ".join(find_text(item) for item in value)
    if isinstance(value, dict):
        return " ".join(find_text(item) for item in value.values())
    return ""


def verify_former_placements(corpus: dict) -> None:
    by_section = {str(section.get("section")): section for section in corpus.get("title8", {}).get("sections", [])}
    for ina_section, (_, _, proof) in FORMER_PLACEMENTS.items():
        row = next(row for row in corpus["inaCrosswalk"] if row["inaSection"] == ina_section)
        section = by_section.get(str(row.get("uscSection")))
        if not section or not re.search(proof, find_text(section), re.I):
            raise ValueError(f"House codification proof for former INA {ina_section} was not found")


def build_hierarchy(xml_bytes: bytes, corpus: dict, captured_on: str) -> dict:
    root = ET.fromstring(xml_bytes)
    toc = root.find(".//uslm:toc", NS)
    if toc is None:
        raise ValueError("GovInfo USLM does not contain a table of contents")

    metadata = root.find("uslm:meta", NS)

    def meta(name: str) -> str:
        value = metadata.find(f"uslm:{name}", NS) if metadata is not None else None
        return clean_text(value)

    titles: list[dict] = []
    title_by_numeric: dict[int, dict] = {}
    chapter_by_key: dict[tuple[int, str], dict] = {}
    placement: dict[str, tuple[int, str | None, str]] = {}
    current_title: dict | None = None
    current_chapter: dict | None = None

    for item in toc.iter():
        if local_name(item) != "referenceItem":
            continue
        role = item.attrib.get("role", "")
        designator, label = reference_text(item)
        if role == "title":
            match = re.search(r"Title\s+([IVX]+)", designator, re.I)
            if not match:
                raise ValueError(f"Unrecognized INA title designator: {designator}")
            roman = match.group(1).upper()
            numeric = next((number for number, value in ROMAN_BY_NUMBER.items() if value == roman), None)
            if numeric is None:
                raise ValueError(f"Unexpected INA title: {roman}")
            current_title = {
                "id": f"ina:title:{roman}",
                "number": roman,
                "numeric": numeric,
                "heading": label.strip(" ."),
                "chapters": [],
                "sectionIds": [],
            }
            titles.append(current_title)
            title_by_numeric[numeric] = current_title
            current_chapter = None
            continue
        if role == "chapter":
            if current_title is None:
                raise ValueError("INA chapter appeared before a title")
            match = re.search(r"chapter\s+([0-9]+[A-Za-z]?)", designator, re.I)
            if not match:
                raise ValueError(f"Unrecognized INA chapter designator: {designator}")
            number = match.group(1).upper()
            current_chapter = {
                "id": f"ina:title:{current_title['number']}:chapter:{number}",
                "number": number,
                "heading": label.strip(" ."),
                "sectionIds": [],
            }
            current_title["chapters"].append(current_chapter)
            chapter_by_key[(current_title["numeric"], number)] = current_chapter
            continue
        if role not in {"section", "none"}:
            continue
        match = re.search(r"(?:Sec\.|Section)\s+([0-9]+[A-Za-z]?)", designator, re.I)
        if not match and role == "none":
            match = re.search(r"(?:Sec\.|Section)\s+([0-9]+[A-Za-z]?)", clean_text(item), re.I)
        if not match:
            continue
        if current_title is None:
            raise ValueError("INA section appeared before a title")
        section = match.group(1).upper()
        if section in placement:
            raise ValueError(f"Duplicate INA section {section} in GovInfo hierarchy")
        heading = label.strip(" .") or re.sub(r"^.*?\.\s*", "", clean_text(item).strip("[] "), count=1).strip(" .")
        placement[section] = (current_title["numeric"], current_chapter["number"] if current_chapter else None, heading)

    verify_former_placements(corpus)
    crosswalk = corpus.get("inaCrosswalk", [])
    crosswalk_ids = [str(row["inaSection"]).upper() for row in crosswalk]
    if len(crosswalk_ids) != 183 or len(set(crosswalk_ids)) != 183:
        raise ValueError("Expected 183 unique USCIS INA crosswalk entries")
    missing_from_crosswalk = sorted(set(placement) - set(crosswalk_ids))
    if missing_from_crosswalk:
        raise ValueError(f"GovInfo hierarchy has sections absent from USCIS crosswalk: {missing_from_crosswalk}")
    missing_from_uslm = sorted(set(crosswalk_ids) - set(placement))
    if missing_from_uslm != sorted(FORMER_PLACEMENTS):
        raise ValueError(f"Unexpected crosswalk entries absent from GovInfo hierarchy: {missing_from_uslm}")
    for section, (title_number, chapter_number, _) in FORMER_PLACEMENTS.items():
        row = next(row for row in crosswalk if str(row["inaSection"]).upper() == section)
        placement[section] = (title_number, chapter_number, str(row.get("title") or "").strip(" ."))

    sections: list[dict] = []
    for row in crosswalk:
        ina_section = str(row["inaSection"]).upper()
        title_number, chapter_number, heading = placement[ina_section]
        title = title_by_numeric[title_number]
        chapter = chapter_by_key.get((title_number, chapter_number)) if chapter_number else None
        node_id = f"ina:section:{ina_section}"
        record = {
            "id": node_id,
            "inaSection": ina_section,
            "heading": heading or str(row.get("title") or "").strip(" ."),
            "titleId": title["id"],
            "chapterId": chapter["id"] if chapter else None,
            "sourceUrl": row.get("url") or INA_SOURCE_URL,
        }
        sections.append(record)
        (chapter["sectionIds"] if chapter else title["sectionIds"]).append(node_id)

    assigned = [section_id for title in titles for section_id in title["sectionIds"]]
    assigned += [section_id for title in titles for chapter in title["chapters"] for section_id in chapter["sectionIds"]]
    expected_ids = [f"ina:section:{section}" for section in crosswalk_ids]
    if len(assigned) != len(expected_ids) or set(assigned) != set(expected_ids):
        raise ValueError("INA hierarchy contains duplicate or orphan crosswalk entries")
    if len(titles) != 5 or sum(len(title["chapters"]) for title in titles) != 15:
        raise ValueError("INA hierarchy does not contain the expected five titles and fifteen chapters")

    return {
        "schemaVersion": 1,
        "source": {
            "name": "Immigration and Nationality Act — structured table of contents",
            "publisher": "GovInfo / U.S. Government Publishing Office",
            "url": USLM_URL,
            "detailUrl": DETAIL_URL,
            "captureDate": captured_on,
            "processedDate": meta("processedDate"),
            "currentThroughPublicLaw": meta("currentThroughPublicLaw"),
            "bytes": len(xml_bytes),
            "sha256": hashlib.sha256(xml_bytes).hexdigest(),
        },
        "crosswalkSourceUrl": INA_SOURCE_URL,
        "titles": titles,
        "sections": sections,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, help="Use a previously downloaded GovInfo USLM file")
    parser.add_argument("--output", type=Path, default=OUTPUT_PATH)
    parser.add_argument("--capture-date", default=dt.date.today().isoformat())
    args = parser.parse_args()
    xml_bytes = args.input.read_bytes() if args.input else urllib.request.urlopen(USLM_URL, timeout=60).read()
    hierarchy = build_hierarchy(xml_bytes, assigned_object(CORPUS_PATH), args.capture_date)
    source = "window.INA_SEARCH_INA_HIERARCHY = " + json.dumps(hierarchy, indent=2, ensure_ascii=False) + ";\n"
    args.output.write_text(source, encoding="utf-8")
    chapter_count = sum(len(title["chapters"]) for title in hierarchy["titles"])
    print(f"Wrote {args.output}: {len(hierarchy['titles'])} titles, {chapter_count} chapters, {len(hierarchy['sections'])} sections")


if __name__ == "__main__":
    main()
