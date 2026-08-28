#!/usr/bin/env python3
"""Independently audit a generated CFR corpus against captured official eCFR inputs."""

from __future__ import annotations

import argparse
import hashlib
import json
import pathlib
import re
import xml.etree.ElementTree as ET
from collections import defaultdict
from html.parser import HTMLParser


ROOT = pathlib.Path(__file__).resolve().parents[1]
MATCH_TRANSLATION = str.maketrans({
    "–": "-", "—": "-", "−": "-", "‐": "-", "‑": "-",
    "“": '"', "”": '"', "‘": "'", "’": "'", "⁄": "/", "\u00ad": "",
})
PAREN_PATH_RE = re.compile(r"\(([^)]+)\)")
LEADING_MARKERS_RE = re.compile(r"^\s*((?:\([A-Za-z0-9ivxlcdmIVXLCDM]+\))+)")
LEADING_RANGE_RE = re.compile(r"^\s*\(([A-Za-z0-9ivxlcdmIVXLCDM]+)\)\s*[-–—]\s*\(([A-Za-z0-9ivxlcdmIVXLCDM]+)\)")


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def clean(value: str | None) -> str:
    return re.sub(r"\s+", " ", value or "").strip()


def canonical(value: str) -> str:
    return "".join(character for character in value.translate(MATCH_TRANSLATION) if not character.isspace())


def address(tokens: list[str]) -> str:
    return "".join(f"({token})" for token in tokens)


def load_corpus(path: pathlib.Path) -> dict:
    source = path.read_text(encoding="utf-8")
    equals = source.find("=")
    semicolon = source.rfind(";")
    if equals < 0 or semicolon < equals:
        raise ValueError(f"{path} is not a generated CFR JavaScript corpus")
    return json.loads(source[equals + 1:semicolon])


def verified_bytes(path: pathlib.Path, record: dict, label: str) -> bytes:
    data = path.read_bytes()
    if len(data) != record.get("bytes") or sha256(data) != record.get("sha256"):
        raise ValueError(f"{label} failed its captured byte/hash check: {path}")
    return data


def report_path(path: pathlib.Path) -> str:
    resolved = path.resolve()
    try:
        return str(resolved.relative_to(ROOT))
    except ValueError:
        return str(resolved)


class RenderedStructureParser(HTMLParser):
    """Small audit-only reader for the renderer's record and paragraph IDs."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.records: list[dict] = []
        self.record: dict | None = None
        self.record_stack: list[dict | None] = []
        self.paragraph_parent = ""
        self.paragraph_parent_stack: list[str] = []
        self.paragraph: dict | None = None
        self.table: dict | None = None
        self.table_depth = 0
        self.footnote_depth = 0
        self.footnote_div_stack: list[bool] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        values = {key: value or "" for key, value in attrs}
        if tag == "table":
            if self.table_depth == 0 and self.record is not None and not self.footnote_depth:
                self.table = {"dataTitle": "", "canonicalId": self.paragraph_parent, "addressable": False, "term": False, "disabled": False, "elementKind": "table", "text": []}
            self.table_depth += 1
        if tag == "div":
            self.record_stack.append(self.record)
            self.paragraph_parent_stack.append(self.paragraph_parent)
            classes = set(values.get("class", "").split())
            footnote_container = bool(classes & {"footnote", "footnotes"})
            self.footnote_div_stack.append(footnote_container)
            if footnote_container:
                self.footnote_depth += 1
            kind = "section" if "section" in classes else "appendix" if "appendix" in classes else ""
            if kind:
                self.record = {"kind": kind, "id": values.get("id", ""), "paragraphs": []}
                self.records.append(self.record)
            if values.get("id", "").startswith("p-"):
                self.paragraph_parent = values["id"]
        elif tag == "p" and self.record is not None and not self.table_depth and not self.footnote_depth:
            self.paragraph = {
                "dataTitle": values.get("data-title", ""),
                "canonicalId": values.get("id") or self.paragraph_parent,
                "addressable": bool(values.get("data-title")),
                "term": values.get("data-term", "").lower() == "true",
                "disabled": values.get("data-disable", "").lower() == "true",
                "elementKind": "p",
                "sourceTag": "p",
                "text": [],
            }
        elif tag in {"h1", "h2", "h3", "h4", "h5", "h6"} and self.record is not None and self.paragraph_parent and not self.table_depth and not self.footnote_depth:
            self.paragraph = {"dataTitle": values.get("data-title", ""), "canonicalId": self.paragraph_parent, "addressable": bool(values.get("data-title")), "term": False, "disabled": False, "elementKind": "heading", "sourceTag": tag, "text": []}

    def handle_data(self, data: str) -> None:
        if self.paragraph is not None:
            self.paragraph["text"].append(data)
        if self.table is not None:
            self.table["text"].append(data)

    def handle_endtag(self, tag: str) -> None:
        if self.paragraph is not None and tag == self.paragraph.get("sourceTag"):
            self.paragraph["text"] = clean("".join(self.paragraph["text"]))
            self.paragraph.pop("sourceTag", None)
            if self.paragraph["text"]:
                self.record["paragraphs"].append(self.paragraph)
            self.paragraph = None
        elif tag == "div" and self.record_stack:
            self.record = self.record_stack.pop()
            self.paragraph_parent = self.paragraph_parent_stack.pop()
            if self.footnote_div_stack.pop():
                self.footnote_depth -= 1
        if tag == "table" and self.table_depth:
            self.table_depth -= 1
            if self.table_depth == 0 and self.table is not None:
                self.table["text"] = clean("".join(self.table["text"]))
                if self.table["text"]:
                    self.record["paragraphs"].append(self.table)
                self.table = None


def parse_renderer(data: bytes, title: int, part: str) -> list[dict]:
    parser = RenderedStructureParser()
    parser.feed(data.decode("utf-8"))
    parser.close()
    seen = set()
    for record in parser.records:
        key = (record["kind"], record["id"])
        if not record["id"] or key in seen:
            raise ValueError(f"Title {title} Part {part} renderer has duplicate/empty record {key}")
        seen.add(key)
        prefix = f"p-{record['id']}"
        for paragraph in record["paragraphs"]:
            canonical_id = paragraph["canonicalId"]
            if canonical_id and not canonical_id.startswith(prefix):
                raise ValueError(f"Renderer paragraph {paragraph['dataTitle']!r} is outside {record['id']!r}")
            paragraph["path"] = PAREN_PATH_RE.findall(canonical_id[len(prefix):]) if canonical_id else []
            if not paragraph["addressable"] and paragraph["path"]:
                leading = LEADING_MARKERS_RE.match(paragraph["text"])
                visible = PAREN_PATH_RE.findall(leading.group(1)) if leading else []
                dotted = paragraph["path"][-1]
                if (visible and paragraph["path"][-len(visible):] == visible) or (dotted.endswith(".") and paragraph["text"].lstrip().startswith(dotted)):
                    paragraph["addressable"] = True
    return parser.records


def rendered_addresses(record: dict) -> list[str]:
    result: list[str] = []
    for paragraph in record["paragraphs"]:
        path = paragraph["path"]
        if not path or not paragraph["addressable"] or paragraph["term"] or paragraph["disabled"]:
            continue
        range_match = LEADING_RANGE_RE.match(paragraph["text"])
        if range_match:
            result.extend((address(path), address([*path[:-1], range_match.group(2)])))
            continue
        leading = LEADING_MARKERS_RE.match(paragraph["text"])
        if leading:
            visible = PAREN_PATH_RE.findall(leading.group(1))
            if len(visible) > len(path) or path[-len(visible):] != visible:
                raise ValueError(f"Renderer id/text marker disagreement at {paragraph['dataTitle']!r}")
            base = path[:-len(visible)]
            result.extend(address([*base, *visible[:index + 1]]) for index in range(len(visible)))
        else:
            result.append(address(path))
    return result


def rendered_address_groups(record: dict) -> list[dict]:
    """Return the canonical addresses belonging to each rendered legal line."""
    groups: list[dict] = []
    for paragraph in record["paragraphs"]:
        path = paragraph["path"]
        if not path or not paragraph["addressable"] or paragraph["term"] or paragraph["disabled"]:
            continue
        range_match = LEADING_RANGE_RE.match(paragraph["text"])
        if range_match:
            addresses = [address(path), address([*path[:-1], range_match.group(2)])]
        else:
            leading = LEADING_MARKERS_RE.match(paragraph["text"])
            if leading:
                visible = PAREN_PATH_RE.findall(leading.group(1))
                if len(visible) > len(path) or path[-len(visible):] != visible:
                    raise ValueError(f"Renderer id/text marker disagreement at {paragraph['dataTitle']!r}")
                base = path[:-len(visible)]
                addresses = [address([*base, *visible[:index + 1]]) for index in range(len(visible))]
            else:
                addresses = [address(path)]
        groups.append({"addresses": addresses, "textCandidates": rendered_text_candidates(paragraph["text"])})
    return groups


def block_addresses(blocks: list[dict]) -> list[str]:
    result: list[str] = []
    for block in blocks or []:
        local = []
        for unit in block.get("u", []):
            value = unit.get("a", "")
            if value and value not in local:
                local.append(value)
        value = block.get("a", "")
        if value and value not in local:
            local.append(value)
        result.extend(local)
        if block.get("t") == "note":
            result.extend(block_addresses(block.get("blocks", [])))
    return result


def block_address_groups(blocks: list[dict]) -> list[dict]:
    groups: list[dict] = []
    for block in blocks or []:
        addresses = []
        for unit in block.get("u", []):
            value = unit.get("a", "")
            if value and value not in addresses:
                addresses.append(value)
        value = block.get("a", "")
        if value and value not in addresses:
            addresses.append(value)
        if addresses:
            groups.append({"addresses": addresses, "text": canonical(corpus_body_text([block]))})
        if block.get("t") == "note":
            groups.extend(block_address_groups(block.get("blocks", [])))
    return groups


def corpus_body_text(blocks: list[dict]) -> str:
    pieces: list[str] = []
    for block in blocks or []:
        kind = block.get("t")
        if kind in {"p", "h", "footnote"}:
            pieces.append(block.get("x", ""))
        elif kind == "table":
            pieces.append(block.get("caption", ""))
            for row in block.get("rows", []):
                pieces.extend(cell.get("x", "") for cell in row)
        elif kind == "note":
            pieces.append(corpus_body_text(block.get("blocks", [])))
    return "".join(pieces)


def rendered_text_candidates(text: str) -> list[str]:
    candidates = [canonical(text)]
    without_numeric_footnote_brackets = re.sub(r"\[(\d+[A-Za-z-]*)\]", r"\1", text)
    normalized_footnote = canonical(without_numeric_footnote_brackets)
    if normalized_footnote not in candidates:
        candidates.append(normalized_footnote)
    return candidates


def rendered_contexts(record: dict) -> list[dict]:
    result: list[dict] = []
    for element in record["paragraphs"]:
        if not element["path"] or element["addressable"]:
            continue
        item = {"path": address(element["path"]), "textCandidates": rendered_text_candidates(element["text"])}
        if result and result[-1]["path"] == item["path"]:
            result[-1]["textCandidates"] = sorted({left + right for left in result[-1]["textCandidates"] for right in item["textCandidates"]})
        else:
            result.append(item)
    return result


def corpus_contexts(blocks: list[dict]) -> list[dict]:
    result: list[dict] = []
    for block in blocks or []:
        if block.get("c"):
            item = {"path": block["c"], "text": canonical(corpus_body_text([block]))}
            if result and result[-1]["path"] == item["path"]:
                result[-1]["text"] += item["text"]
            else:
                result.append(item)
        if block.get("t") == "note":
            result.extend(corpus_contexts(block.get("blocks", [])))
    return result


def xml_body_text(node: ET.Element) -> str:
    return "".join("".join(child.itertext()) for child in list(node) if child.tag != "HEAD")


def first_difference(expected: list[str], actual: list[str]) -> dict | None:
    for index in range(max(len(expected), len(actual))):
        left = expected[index] if index < len(expected) else None
        right = actual[index] if index < len(actual) else None
        if left != right:
            return {"index": index, "expected": left, "actual": right}
    return None


def all_differences(expected: list[str], actual: list[str]) -> list[dict]:
    return [
        {"index": index, "expected": expected[index] if index < len(expected) else None, "actual": actual[index] if index < len(actual) else None}
        for index in range(max(len(expected), len(actual)))
        if (expected[index] if index < len(expected) else None) != (actual[index] if index < len(actual) else None)
    ]


def renderer_text_is_subsequence(record: dict, source_text: str) -> tuple[bool, dict | None]:
    source = canonical(source_text)
    cursor = 0
    for paragraph in record["paragraphs"]:
        # Superscript numeric footnote links are rendered as [52] while the
        # XML keeps the same identifier in <SU>52</SU>.  Try the literal text
        # first so substantive brackets such as [Reserved] remain protected.
        candidates = rendered_text_candidates(paragraph["text"])
        matches = [(source.find(expected, cursor), expected) for expected in candidates]
        matches = [(found, expected) for found, expected in matches if found >= 0]
        found, expected = min(matches, default=(-1, ""), key=lambda item: item[0])
        if found < 0:
            return False, {"dataTitle": paragraph["dataTitle"], "text": paragraph["text"][:240]}
        cursor = found + len(expected)
    return True, None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache", type=pathlib.Path, required=True)
    parser.add_argument("--corpus", type=pathlib.Path, required=True)
    parser.add_argument("--baseline", type=pathlib.Path)
    parser.add_argument("--report", type=pathlib.Path, required=True)
    args = parser.parse_args()

    capture = json.loads((args.cache / "capture.json").read_text(encoding="utf-8"))
    corpus = load_corpus(args.corpus)
    baseline = load_corpus(args.baseline) if args.baseline else None
    corpus_sections = {record["id"]: record for record in corpus["sections"]}
    corpus_parts = {record["id"]: record for record in corpus["parts"]}
    corpus_appendices = defaultdict(list)
    for record in corpus["appendices"]:
        corpus_appendices[record["partId"]].append(record)
    baseline_sections = {record["id"]: record for record in baseline.get("sections", [])} if baseline else {}
    baseline_appendices = defaultdict(list)
    if baseline:
        for record in baseline.get("appendices", []):
            baseline_appendices[record["partId"]].append(record)

    renderer_by_part: dict[tuple[int, str], list[dict]] = {}
    renderer_paragraph_count = 0
    renderer_element_count = 0
    renderer_context_count = 0
    for key, record in capture.get("renderers", {}).items():
        title, part = int(record["title"]), str(record["part"])
        data = verified_bytes(args.cache / "ecfr-rendered" / record["file"], record, f"renderer {key}")
        records = parse_renderer(data, title, part)
        renderer_by_part[(title, part)] = records
        elements = [element for item in records for element in item["paragraphs"]]
        renderer_paragraph_count += sum(element["elementKind"] == "p" for element in elements)
        renderer_element_count += len(elements)
        renderer_context_count += sum(bool(element["path"]) and not element["addressable"] for element in elements)

    failures: list[dict] = []
    current_mismatches: list[dict] = []
    current_boundary_mismatches: list[dict] = []
    current_context_mismatches: list[dict] = []
    baseline_mismatches: list[dict] = []
    renderer_record_count = 0
    renderer_address_count = 0
    renderer_address_group_count = 0
    xml_record_count = 0
    seen_parts: set[str] = set()
    seen_sections: set[str] = set()
    seen_appendices: set[str] = set()

    def compare_structure(record_id: str, rendered: dict, current: dict, old: dict | None) -> None:
        nonlocal renderer_record_count, renderer_address_count, renderer_address_group_count
        expected = rendered_addresses(rendered)
        renderer_record_count += 1
        renderer_address_count += len(expected)
        actual = block_addresses(current.get("blocks", []))
        difference = first_difference(expected, actual)
        if difference:
            item = {"id": record_id, "expectedCount": len(expected), "actualCount": len(actual), "firstDifference": difference}
            current_mismatches.append(item)
            failures.append({"kind": "renderer-addresses", **item})
        expected_groups = rendered_address_groups(rendered)
        actual_groups = block_address_groups(current.get("blocks", []))
        renderer_address_group_count += len(expected_groups)
        boundary_difference = None
        for index in range(max(len(expected_groups), len(actual_groups))):
            expected_group = expected_groups[index] if index < len(expected_groups) else None
            actual_group = actual_groups[index] if index < len(actual_groups) else None
            if expected_group is None or actual_group is None or expected_group["addresses"] != actual_group["addresses"] or not any(candidate in actual_group["text"] for candidate in expected_group["textCandidates"]):
                boundary_difference = {
                    "index": index,
                    "expected": ({"addresses": expected_group["addresses"], "text": expected_group["textCandidates"][0][:240]} if expected_group else None),
                    "actual": ({"addresses": actual_group["addresses"], "text": actual_group["text"][:240]} if actual_group else None),
                }
                break
        if boundary_difference:
            item = {"id": record_id, "expectedCount": len(expected_groups), "actualCount": len(actual_groups), "firstDifference": boundary_difference}
            current_boundary_mismatches.append(item)
            failures.append({"kind": "renderer-address-boundaries", **item})
        expected_contexts = rendered_contexts(rendered)
        actual_contexts = corpus_contexts(current.get("blocks", []))
        context_difference = None
        for index in range(max(len(expected_contexts), len(actual_contexts))):
            expected_context = expected_contexts[index] if index < len(expected_contexts) else None
            actual_context = actual_contexts[index] if index < len(actual_contexts) else None
            if expected_context is None or actual_context is None or expected_context["path"] != actual_context["path"] or not any(candidate in actual_context["text"] for candidate in expected_context["textCandidates"]):
                context_difference = {
                    "index": index,
                    "expected": ({"path": expected_context["path"], "text": expected_context["textCandidates"][0][:240]} if expected_context else None),
                    "actual": ({"path": actual_context["path"], "text": actual_context["text"][:240]} if actual_context else None),
                }
                break
        if context_difference:
            item = {"id": record_id, "expectedCount": len(expected_contexts), "actualCount": len(actual_contexts), "firstDifference": context_difference}
            current_context_mismatches.append(item)
            failures.append({"kind": "renderer-context", **item})
        if old is not None:
            prior = block_addresses(old.get("blocks", []))
            old_difference = first_difference(expected, prior)
            if old_difference:
                differences = all_differences(expected, prior)
                baseline_mismatches.append({"id": record_id, "expectedCount": len(expected), "actualCount": len(prior), "differenceCount": len(differences), "firstDifference": old_difference, "differences": differences})

    for source_key, source_record in capture["sources"].items():
        data = verified_bytes(args.cache / "ecfr" / source_record["file"], source_record, f"XML source {source_key}")
        root = ET.fromstring(data)

        def walk(node: ET.Element, part_number: str = "") -> None:
            nonlocal xml_record_count
            node_type = node.get("TYPE", "").lower()
            if node.tag == "DIV5" and node_type == "part":
                part_number = node.get("N", "")
                part_id = f"{source_record['title']}:{part_number}"
                seen_parts.add(part_id)
                part = corpus_parts.get(part_id)
                if part is None:
                    failures.append({"kind": "missing-corpus-part", "id": part_id})
                else:
                    authority = clean("".join(node.find("AUTH").itertext())) if node.find("AUTH") is not None else ""
                    source = clean("".join(node.find("SOURCE").itertext())) if node.find("SOURCE") is not None else ""
                    if authority != part.get("authority", "") or source != part.get("source", ""):
                        failures.append({"kind": "part-metadata", "id": part_id})
            if node.tag == "DIV8" and node_type == "section" and part_number:
                section_id = f"{source_record['title']}:{node.get('N', '')}"
                seen_sections.add(section_id)
                xml_record_count += 1
                current = corpus_sections.get(section_id)
                if current is None:
                    failures.append({"kind": "missing-corpus-section", "id": section_id})
                    return
                source_text = xml_body_text(node)
                if canonical(source_text) != canonical(corpus_body_text(current.get("blocks", []))):
                    failures.append({"kind": "xml-text", "id": section_id})
                raw_head = clean(node.findtext("HEAD"))
                expected_heading = re.sub(r"^§\s*[^ ]+\s*", "", raw_head)
                if expected_heading != current.get("heading", ""):
                    failures.append({"kind": "section-heading", "id": section_id})
                rendered = next((item for item in renderer_by_part.get((int(source_record["title"]), part_number), []) if item["kind"] == "section" and item["id"] == node.get("N", "")), None)
                if rendered is None:
                    failures.append({"kind": "missing-renderer-section", "id": section_id})
                else:
                    okay, detail = renderer_text_is_subsequence(rendered, source_text)
                    if not okay:
                        failures.append({"kind": "renderer-text", "id": section_id, **detail})
                    compare_structure(section_id, rendered, current, baseline_sections.get(section_id))
                return
            if node.tag == "DIV9" and part_number:
                part_id = f"{source_record['title']}:{part_number}"
                appendix_index = sum(1 for value in seen_appendices if value.startswith(part_id + ":appendix:"))
                appendix_id = f"{part_id}:appendix:{appendix_index + 1}"
                seen_appendices.add(appendix_id)
                xml_record_count += 1
                current_list = corpus_appendices.get(part_id, [])
                current = current_list[appendix_index] if appendix_index < len(current_list) else None
                if current is None:
                    failures.append({"kind": "missing-corpus-appendix", "id": appendix_id})
                    return
                if canonical(xml_body_text(node)) != canonical(corpus_body_text(current.get("blocks", []))):
                    failures.append({"kind": "xml-text", "id": appendix_id})
                if clean(node.findtext("HEAD")) != current.get("heading", "") or (node.get("N", "") or clean(node.findtext("HEAD"))) != current.get("label", ""):
                    failures.append({"kind": "appendix-heading", "id": appendix_id})
                rendered_appendices = [item for item in renderer_by_part.get((int(source_record["title"]), part_number), []) if item["kind"] == "appendix"]
                rendered = rendered_appendices[appendix_index] if appendix_index < len(rendered_appendices) else None
                if rendered is None:
                    failures.append({"kind": "missing-renderer-appendix", "id": appendix_id})
                else:
                    source_text = xml_body_text(node)
                    okay, detail = renderer_text_is_subsequence(rendered, source_text)
                    if not okay:
                        failures.append({"kind": "renderer-text", "id": appendix_id, **detail})
                    old_list = baseline_appendices.get(part_id, [])
                    compare_structure(appendix_id, rendered, current, old_list[appendix_index] if appendix_index < len(old_list) else None)
                return
            for child in list(node):
                if child.tag.startswith("DIV"):
                    walk(child, part_number)

        walk(root)

    inventory_differences = {
        "partsOnlyInCorpus": sorted(set(corpus_parts) - seen_parts),
        "partsOnlyInXml": sorted(seen_parts - set(corpus_parts)),
        "sectionsOnlyInCorpus": sorted(set(corpus_sections) - seen_sections),
        "sectionsOnlyInXml": sorted(seen_sections - set(corpus_sections)),
        "appendicesOnlyInCorpus": sorted({record["id"] for record in corpus["appendices"]} - seen_appendices),
        "appendicesOnlyInXml": sorted(seen_appendices - {record["id"] for record in corpus["appendices"]}),
    }
    if any(inventory_differences.values()):
        failures.append({"kind": "inventory", **inventory_differences})

    report = {
        "schemaVersion": 2,
        "captureTime": capture["captureTime"],
        "inputs": {
            "captureManifest": {"path": report_path(args.cache / "capture.json"), "sha256": sha256((args.cache / "capture.json").read_bytes())},
            "corpus": {"path": report_path(args.corpus), "sha256": sha256(args.corpus.read_bytes())},
            "baseline": ({"path": report_path(args.baseline), "sha256": sha256(args.baseline.read_bytes())} if args.baseline else None),
        },
        "summary": {
            "result": "pass" if not failures else "fail",
            "partCount": len(seen_parts),
            "sectionCount": len(seen_sections),
            "appendixCount": len(seen_appendices),
            "xmlRecordCount": xml_record_count,
            "rendererPartCount": len(renderer_by_part),
            "rendererRecordCount": renderer_record_count,
            "rendererParagraphCount": renderer_paragraph_count,
            "rendererElementCount": renderer_element_count,
            "rendererAddressCount": renderer_address_count,
            "rendererAddressGroupCount": renderer_address_group_count,
            "rendererContextElementCount": renderer_context_count,
            "currentStructureMismatchCount": len(current_mismatches),
            "currentBoundaryMismatchCount": len(current_boundary_mismatches),
            "currentContextMismatchCount": len(current_context_mismatches),
            "baselineStructureMismatchCount": len(baseline_mismatches),
            "failureCount": len(failures),
        },
        "inventoryDifferences": inventory_differences,
        "currentStructureMismatches": current_mismatches,
        "currentBoundaryMismatches": current_boundary_mismatches,
        "currentContextMismatches": current_context_mismatches,
        "baselineStructureMismatches": baseline_mismatches,
        "failures": failures,
    }
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    summary = report["summary"]
    print(f"CFR structure audit {summary['result']}: {summary['partCount']} parts, {summary['sectionCount']} sections, {summary['appendixCount']} appendices, {summary['rendererParagraphCount']} renderer paragraphs, {summary['rendererAddressCount']} addresses")
    print(f"Current address mismatches: {summary['currentStructureMismatchCount']}; boundary mismatches: {summary['currentBoundaryMismatchCount']}; baseline mismatches: {summary['baselineStructureMismatchCount']}; failures: {summary['failureCount']}")
    return 0 if not failures else 1


if __name__ == "__main__":
    raise SystemExit(main())
