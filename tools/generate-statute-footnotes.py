#!/usr/bin/env python3
"""Generate structured House editorial footnotes from official Title 8 USLM XML."""

from __future__ import annotations

import argparse
import hashlib
import itertools
import json
import re
from pathlib import Path
import xml.etree.ElementTree as ET

from uslm_presentation import extract_presentation


ROOT = Path(__file__).resolve().parents[1]
CORPUS_PATH = ROOT / "src" / "INASearch-Corpus.js"
OUTPUT_PATH = ROOT / "src" / "INASearch-Statute-Footnotes.js"
MANIFEST_PATH = ROOT / "sources" / "legal" / "source-manifest.json"
STRUCTURAL = {"section", "subsection", "paragraph", "subparagraph", "clause", "subclause", "item", "subitem", "subsubitem", "level"}
OWN_TEXT_EXCLUSIONS = STRUCTURAL | {"num", "heading", "sourceCredit", "notes"}
SENTINEL_PATTERN = re.compile(r"\ue000(\d+)\ue001")


def local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def normalize(value: str) -> str:
    return re.sub(r"\s+", " ", value or "").strip()


def normalize_section_number(value: str) -> str:
    return str(value or "").replace("...", " to ")


def read_assigned_json(path: Path, property_name: str) -> dict:
    source = path.read_text(encoding="utf-8")
    match = re.search(rf"window\.{re.escape(property_name)}\s*=\s*(\{{[\s\S]*\}});\s*$", source)
    if not match:
        raise RuntimeError(f"Could not read {property_name} from {path}")
    return json.loads(match.group(1))


def corpus_sources(corpus: dict) -> dict[str, dict]:
    result: dict[str, dict] = {}
    occurrences: dict[str, int] = {}

    def walk(section_number: str, nodes: list[dict], path: list[str]) -> None:
        for node in nodes or []:
            node_path = [*path, str(node.get("label", ""))]
            base_key = f"{section_number}:{'/'.join(node_path)}"
            occurrence = occurrences.get(base_key, 0) + 1
            occurrences[base_key] = occurrence
            result[base_key if occurrence == 1 else f"{base_key}#{occurrence}"] = node
            walk(section_number, node.get("children", []), node_path)

    for section in corpus.get("title8", {}).get("sections", []):
        section_number = str(section["section"])
        result[f"{section_number}:preamble"] = section
        walk(section_number, section.get("body", []), [])
    return result


def all_text(element: ET.Element) -> str:
    return "".join(element.itertext())


def extract_note_layout(note: ET.Element, *, include_references=False) -> dict:
    """Preserve source presentation without changing citation/search text."""
    data = extract_presentation(note, clean_footnotes=False, include_references=include_references)
    heading = next((child for child in note if local_name(child.tag) == "heading"), None)
    heading_data = extract_presentation(heading, clean_footnotes=False) if heading is not None else {"text": "", "layout": []}
    layout = data["layout"]
    body_start = 0
    if heading is not None and layout and layout[0]["tag"] == "heading":
        body_start = layout.pop(0)["end"]
    result = {"heading": heading_data["text"], "text": data["text"], "role": note.get("role", ""),
              "bodyStart": body_start, "layout": layout, "headingLayout": heading_data["layout"]}
    if heading_data.get("presentation"):
        result["headingPresentation"] = heading_data["presentation"]
    if include_references:
        result["uslmReferences"] = data["uslmReferences"]
    return result


def note_text_and_references(note: ET.Element) -> tuple[str, list[dict]]:
    chunks: list[str] = [note.text or ""]
    refs: list[tuple[str, str]] = []
    children = list(note)
    for index, child in enumerate(children):
        name = local_name(child.tag)
        if name == "num" and index == 0:
            chunks.append(child.tail or "")
            continue
        if name == "ref" and child.attrib.get("class") != "footnoteRef":
            text = normalize(all_text(child))
            marker = f"\ue100{len(refs)}\ue101"
            chunks.extend([marker, all_text(child), marker.replace("\ue100", "\ue102").replace("\ue101", "\ue103")])
            refs.append((text, child.attrib.get("href", "")))
        else:
            chunks.append(all_text(child))
        chunks.append(child.tail or "")
    decorated = normalize("".join(chunks))
    output = decorated
    records: list[dict] = []
    displacement = 0
    for index, (text, href) in enumerate(refs):
        start_token = f"\ue100{index}\ue101"
        end_token = f"\ue102{index}\ue103"
        start = output.find(start_token)
        end = output.find(end_token)
        if start < 0 or end < start:
            raise RuntimeError("Could not locate a citation inside a House footnote")
        output = output[:start] + output[start + len(start_token):end] + output[end + len(end_token):]
        plain_start = start - displacement
        records.append({
            "start": plain_start,
            "end": plain_start + len(text),
            "text": text,
            "houseHref": href,
            "provenance": "house-uslm-ref",
            "ruleId": "house-uslm-ref",
        })
        displacement += len(start_token) + len(end_token)
    return normalize(output), records


def normalized_with_offsets(raw: str, event_count: int) -> tuple[str, list[int]]:
    output: list[str] = []
    offsets: list[int | None] = [None] * event_count
    pending_space = False
    index = 0
    while index < len(raw):
        marker = SENTINEL_PATTERN.match(raw, index)
        if marker:
            offsets[int(marker.group(1))] = len(output)
            pending_space = False
            index = marker.end()
            continue
        character = raw[index]
        if character.isspace():
            if output:
                pending_space = True
        else:
            if pending_space and output:
                output.append(" ")
            output.append(character)
            pending_space = False
        index += 1
    return "".join(output).strip(), [int(offset or 0) for offset in offsets]


def extract_field(element: ET.Element, exclude_direct: set[str], source_key: str, field_name: str, section_number: str, notes: dict[str, dict]) -> dict | None:
    raw_clean: list[str] = [element.text or ""]
    raw_flattened: list[str] = [element.text or ""]
    events: list[dict] = []
    child_prefixes: list[str] = []

    def append_standalone_superscript(child: ET.Element, clean: list[str], flattened: list[str]) -> None:
        """Record a repeated House footnote marker written as a bare ``sup``.

        USLM uses a paired ``ref.footnoteRef``/``note`` for the first marker,
        but some later references to the same editorial note are represented
        only by ``<sup>N</sup>``. They must be removed from operative text in
        exactly the same way and linked to the section's canonical note after
        all fields in the section have been examined.
        """
        number = normalize(all_text(child))
        if not re.fullmatch(r"\d{1,3}", number):
            raise RuntimeError(f"Unsupported standalone superscript {number!r} at {source_key}.{field_name}")
        event_index = len(events)
        clean.append(f"\ue000{event_index}\ue001")
        flattened.append(all_text(child))
        events.append({
            "number": number,
            "flattenedInsertion": number,
            "sourceLocation": {"sourceKey": source_key, "field": field_name},
            "reusedReference": True,
            "afterChild": len(child_prefixes),
        })

    def append_container(container: ET.Element, clean: list[str], flattened: list[str]) -> None:
        clean.append(container.text or "")
        flattened.append(container.text or "")
        children = list(container)
        index = 0
        while index < len(children):
            child = children[index]
            name = local_name(child.tag)
            if name == "ref" and child.attrib.get("class") == "footnoteRef":
                if index + 1 >= len(children):
                    raise RuntimeError(f"Footnote reference without note at {source_key}.{field_name}")
                note = children[index + 1]
                if local_name(note.tag) != "note" or note.attrib.get("type") != "footnote" or note.attrib.get("id") != child.attrib.get("idref"):
                    raise RuntimeError(f"Footnote reference is not followed by its note at {source_key}.{field_name}")
                xml_id = note.attrib["id"]
                number = normalize(all_text(child))
                note_number_element = next((item for item in list(note) if local_name(item.tag) == "num"), None)
                note_number = normalize(all_text(note_number_element)) if note_number_element is not None else ""
                if number != note_number:
                    raise RuntimeError(f"Footnote number mismatch for {xml_id}")
                text, citations = note_text_and_references(note)
                stable_id = f"usc-{section_number}-{xml_id}"
                event_index = len(events)
                clean.append(f"\ue000{event_index}\ue001")
                insertion = normalize(all_text(child) + all_text(note))
                flattened.extend([all_text(child), all_text(note)])
                event = {
                    "id": stable_id,
                    "xmlId": xml_id,
                    "number": number,
                    "flattenedInsertion": insertion,
                    "afterChild": len(child_prefixes),
                    "sourceLocation": {"sourceKey": source_key, "field": field_name},
                }
                events.append(event)
                existing = notes.get(xml_id)
                record = {
                    "id": stable_id,
                    "xmlId": xml_id,
                    "number": number,
                    "text": text,
                    "sourceLocation": {"sourceKey": source_key, "field": field_name},
                    "uslmReferences": citations,
                }
                if existing and existing != record:
                    raise RuntimeError(f"Conflicting House footnote record {xml_id}")
                notes[xml_id] = record
                clean.append(note.tail or "")
                flattened.append(note.tail or "")
                index += 2
                continue
            if name == "note" and child.attrib.get("type") == "footnote":
                raise RuntimeError(f"Unpaired House footnote at {source_key}.{field_name}")
            if name == "sup":
                append_standalone_superscript(child, clean, flattened)
                clean.append(child.tail or "")
                flattened.append(child.tail or "")
                index += 1
                continue
            append_container(child, clean, flattened)
            clean.append(child.tail or "")
            flattened.append(child.tail or "")
            index += 1

    raw_clean = [element.text or ""]
    raw_flattened = [element.text or ""]
    children = list(element)
    index = 0
    while index < len(children):
        child = children[index]
        name = local_name(child.tag)
        if name in exclude_direct:
            if name in STRUCTURAL:
                child_prefixes.append(''.join(raw_clean))
            raw_clean.append(child.tail or "")
            raw_flattened.append(child.tail or "")
            index += 1
            continue
        if name == "ref" and child.attrib.get("class") == "footnoteRef":
            # Wrap the field in a temporary container so the same sibling-pair logic applies.
            temporary = ET.Element("temporary")
            temporary.text = ""
            temporary.extend(children[index:])
            clean_tail: list[str] = []
            flat_tail: list[str] = []
            append_container(temporary, clean_tail, flat_tail)
            raw_clean.extend(clean_tail)
            raw_flattened.extend(flat_tail)
            break
        if name == "sup":
            append_standalone_superscript(child, raw_clean, raw_flattened)
            raw_clean.append(child.tail or "")
            raw_flattened.append(child.tail or "")
            index += 1
            continue
        append_container(child, raw_clean, raw_flattened)
        raw_clean.append(child.tail or "")
        raw_flattened.append(child.tail or "")
        index += 1

    if not events:
        return None
    clean_text, offsets = normalized_with_offsets("".join(raw_clean), len(events))
    flattened_text = normalize("".join(raw_flattened))
    for event, offset in zip(events, offsets):
        event["offset"] = offset
        if not child_prefixes:
            event.pop("afterChild", None)

    choices = [("", ""), (" ", ""), ("", " "), (" ", " ")]
    found = None
    for separators in itertools.product(choices, repeat=len(events)):
        candidate = clean_text
        displacement = 0
        for event, (prefix, suffix) in zip(events, separators):
            insertion = prefix + event["flattenedInsertion"] + suffix
            offset = event["offset"] + displacement
            candidate = candidate[:offset] + insertion + candidate[offset:]
            displacement += len(insertion)
        if normalize(candidate) == flattened_text:
            found = separators
            break
    if found is None:
        raise RuntimeError(
            f"Could not reconstruct flattened House text at {source_key}.{field_name}\n"
            f"clean={clean_text!r}\nflattened={flattened_text!r}\nevents={events!r}"
        )
    references = []
    for event, (prefix, suffix) in zip(events, found):
        event["reconstructionPrefix"] = prefix
        event["reconstructionSuffix"] = suffix
        if event.get("xmlId"):
            notes[event["xmlId"]]["sourceLocation"]["offset"] = event["offset"]
        references.append(event)
    for event in references:
        event["offset"] = len(clean_text[:event["offset"]].encode("utf-16-le")) // 2
        if event.get("xmlId"):
            notes[event["xmlId"]]["sourceLocation"]["offset"] = event["offset"]
    data = extract_presentation(element, exclude_direct)
    if data["text"] != clean_text:
        raise RuntimeError(f"Presentation/footnote text mismatch at {source_key}.{field_name}")
    result = {"flattenedText": flattened_text, "cleanText": clean_text, "footnoteReferences": references,
              "layout": data["layout"]}
    if child_prefixes:
        result['childTextOffsets'] = [len(normalized_with_offsets(prefix, len(events))[0].encode('utf-16-le')) // 2 for prefix in child_prefixes]
    return result


def safe_js_json(value: dict) -> str:
    return json.dumps(value, ensure_ascii=False, indent=2).replace("<", "\\u003c").replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")


def main() -> None:
    parser = argparse.ArgumentParser()
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    house_artifact = next(
        artifact
        for source in manifest["sources"]
        for artifact in source.get("artifacts", [])
        if artifact["id"] == "house-title-8-xml"
    )
    source_path = ROOT / house_artifact["path"]
    parser.add_argument("xml", nargs="?", type=Path, default=source_path, help="Official House USLM usc08.xml")
    parser.add_argument("--output", type=Path, default=OUTPUT_PATH, help="Output overlay JavaScript")
    args = parser.parse_args()
    xml_bytes = args.xml.read_bytes()
    xml_sha256 = hashlib.sha256(xml_bytes).hexdigest()
    if args.xml.resolve() == source_path.resolve() and (len(xml_bytes) != house_artifact["bytes"] or xml_sha256 != house_artifact["sha256"]):
        raise RuntimeError("The committed House Title 8 XML does not match the legal-source manifest")

    corpus = read_assigned_json(CORPUS_PATH, "INA_SEARCH_CORPUS")
    sources = corpus_sources(corpus)
    root = ET.fromstring(xml_bytes)
    house_source = next(source for source in manifest["sources"] if source["id"] == "house-title-8-uslm")
    occurrences: dict[str, int] = {}
    fields: dict[str, dict] = {}
    section_notes: dict[str, dict[str, dict]] = {}
    bottom_notes: dict[str, list[dict]] = {}
    division_notes: dict[str, list[dict]] = {}
    presentation_fields: dict[str, dict] = {}
    affected_source_fields = 0

    for element in root.iter():
        name = local_name(element.tag)
        identifier = element.attrib.get("identifier", "")
        if name == "section":
            number_element = next((child for child in element if local_name(child.tag) == "num"), None)
            number = normalize_section_number(number_element.get("value", "")) if number_element is not None else ""
            target_section = sources.get(f"{number}:preamble")
            container = next((child for child in element if local_name(child.tag) == "notes"), None)
            # Grouped/disposition sections can have several identifiers in one
            # attribute. Their notes still belong to the corpus's section number.
            if target_section is not None and container is not None:
                records = [extract_note_layout(note) for note in container]
                corpus_notes = target_section.get("notes", [])
                if len(records) != len(corpus_notes) or any(record["text"] != note["text"] for record, note in zip(records, corpus_notes)):
                    raise RuntimeError(f"Corpus/XML bottom-note mismatch at {number}")
                bottom_notes[number] = records
        if name not in STRUCTURAL or not identifier:
            continue
        match = re.match(r"^/us/usc/t8/s([^/\s]+)(?:/(.*))?$", identifier)
        if not match or (match.group(2) and re.search(r"\s", match.group(2))):
            continue
        section_number = normalize_section_number(match.group(1))
        base_key = f"{section_number}:{match.group(2)}" if match.group(2) else f"{section_number}:preamble"
        occurrence = occurrences.get(base_key, 0) + 1
        occurrences[base_key] = occurrence
        source_key = base_key if occurrence == 1 else f"{base_key}#{occurrence}"
        target = sources.get(source_key)
        if not target:
            continue
        notes = section_notes.setdefault(section_number, {})
        candidates = [("text" if match.group(2) else "preamble", element, OWN_TEXT_EXCLUSIONS)]
        for field_name in ["heading", "sourceCredit"]:
            field_element = next((child for child in element if local_name(child.tag) == field_name), None)
            if field_element is not None:
                candidates.append((field_name, field_element, set()))
        for field_name, field_element, exclusions in candidates:
            extracted = extract_field(field_element, exclusions, source_key, field_name, section_number, notes)
            if extracted:
                if normalize(str(target.get(field_name, ""))) != extracted["flattenedText"]:
                    raise RuntimeError(f"Corpus/XML {field_name} mismatch at {source_key}")
                fields.setdefault(source_key, {})[field_name] = extracted
                affected_source_fields += 1
            data = extract_presentation(field_element, exclusions)
            if not data["text"] and field_name not in target:
                continue
            expected_text = extracted["cleanText"] if extracted else normalize(str(target.get(field_name, "")))
            if data["text"] != expected_text:
                raise RuntimeError(f"Corpus/XML presentation mismatch at {source_key}.{field_name}")
            if data["layout"] or data.get("presentation") or data.get("style"):
                presentation_fields.setdefault(source_key, {})[field_name] = data

    # Section ranges with combined identifiers are mapped by their actual num
    # value, just like the importer. Their headings/source credits still have
    # presentation even when they do not have an operative body.
    for element in root.iter():
        tag = local_name(element.tag)
        identifier = element.get("identifier", "")
        if tag == "section":
            number_element = next((child for child in element if local_name(child.tag) == "num"), None)
            section_number = normalize_section_number(number_element.get("value", "")) if number_element is not None else ""
            source_key = f"{section_number}:preamble"
            target = sources.get(source_key)
            if target is not None:
                for field_name in ["heading", "sourceCredit"]:
                    child = next((item for item in element if local_name(item.tag) == field_name), None)
                    if child is None or field_name in presentation_fields.get(source_key, {}):
                        continue
                    data = extract_presentation(child)
                    if data["text"] != normalize(str(target.get(field_name, ""))):
                        raise RuntimeError(f"Corpus/XML presentation mismatch at {source_key}.{field_name}")
                    if data["layout"] or data.get("presentation") or data.get("style"):
                        presentation_fields.setdefault(source_key, {})[field_name] = data
        if tag not in {"title", "subtitle", "chapter", "subchapter", "part", "subpart", "division"}:
            continue
        if not identifier.startswith("/us/usc/t8"):
            continue
        notes = [note for child in element for note in (list(child) if local_name(child.tag) == "notes" else [child])
                 if local_name(note.tag) == "note"]
        records = [extract_note_layout(note, include_references=True) for note in notes
                   if normalize(all_text(note)) != "Current through " + house_source["releasePoint"]]
        if records:
            division_notes[identifier] = records

    repeated_reference_count = 0
    for source_key, source_fields in fields.items():
        section_number = source_key.split(":", 1)[0]
        notes = list(section_notes.get(section_number, {}).values())
        for field in source_fields.values():
            for reference in field["footnoteReferences"]:
                if not reference.get("reusedReference"):
                    continue
                matches = [note for note in notes if note["number"] == reference["number"]]
                if len(matches) != 1:
                    raise RuntimeError(
                        f"Standalone footnote {reference['number']} at {source_key} has {len(matches)} canonical matches"
                    )
                reference["id"] = matches[0]["id"]
                reference["xmlId"] = matches[0]["xmlId"]
                repeated_reference_count += 1

    sections = {section: list(records.values()) for section, records in section_notes.items() if records}
    footnote_count = sum(len(records) for records in sections.values())
    reference_count = sum(len(field["footnoteReferences"]) for record in fields.values() for field in record.values())
    if reference_count != footnote_count + repeated_reference_count:
        raise RuntimeError("House footnote/reference accounting is incomplete")
    result = {
        "schemaVersion": 1,
        "corpusSchemaVersion": 3,
        "sourceUrl": house_source["requestedUrl"],
        "sourceReleasePoint": house_source["releasePoint"],
        "capturedAt": house_source.get("capturedAt", manifest["capturedAt"]),
        "sourceArtifact": house_artifact["path"],
        "sourceBytes": len(xml_bytes),
        "sourceSha256": xml_sha256,
        "extraction": {"footnotes": footnote_count, "references": reference_count, "affectedFields": affected_source_fields},
        "sections": sections,
        "sectionNotes": bottom_notes,
        "divisionNotes": division_notes,
        "presentationFields": presentation_fields,
        "fields": fields,
    }
    output = "/* Generated from official House USLM Title 8 XML; rebuild with tools/generate-statute-footnotes.py. */\n"
    output += f"window.INA_SEARCH_STATUTE_FOOTNOTES = {safe_js_json(result)};\n"
    args.output.write_text(output, encoding="utf-8")
    print(json.dumps(result["extraction"]))


if __name__ == "__main__":
    main()
