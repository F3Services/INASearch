#!/usr/bin/env python3
"""Build INASearch's offline CFR corpus from official public sources.

Refresh mode captures immutable inputs. Cache mode performs no network access and
is the deterministic path used for review and release builds.
"""

from __future__ import annotations

import argparse
import base64
import concurrent.futures
import datetime as dt
import hashlib
import html
import json
import mimetypes
import pathlib
import re
import sys
import time
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET


ROOT = pathlib.Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT = ROOT / "src" / "INASearch-CFR.js"
PTAR_URL = "https://www.govinfo.gov/content/pkg/GPO-CFR-INDEX-{year}/html/GPO-CFR-INDEX-{year}-4.htm"
TITLES_URL = "https://www.ecfr.gov/api/versioner/v1/titles.json"
FULL_URL = "https://www.ecfr.gov/api/versioner/v1/full/{date}/title-{title}.xml"
VERSIONS_URL = "https://www.ecfr.gov/api/versioner/v1/versions/title-{title}.json?part={part}"

# The complete Title 8 CFR is always in scope. These are the cross-title parts
# expected from the 2025 PTAR Title 8 U.S.C. block; a refresh fails if it drifts.
EXPECTED_CROSS_TITLE_PARTS = {
    6: ["19", "115"],
    19: ["4"],
    20: ["416", "654", "655", "656"],
    22: ["22", "40", "41", "42", "46", "50", "51", "53", "62", "89", "131", "172"],
    28: ["8", "9", "44", "65", "68", "1100"],
    29: ["501", "502", "503", "504", "506", "507", "508"],
    31: ["501", "597"],
    34: ["676", "692"],
    42: ["34"],
    45: ["50", "51", "400", "401", "402", "410"],
}
REMOVED_PARTS = {(45, "402")}
GRAPHIC_FALLBACKS = {
    "/graphics/er15ja25.063.gif": {
        "asset": ROOT / "tools" / "cfr-assets" / "er15ja25.063.png",
        "assetSha256": "cc14c7f7afa3a8d933ff8287ad254bb317d4bdafe773092335ac0143aa1e3f13",
        "sourceUrl": "https://www.govinfo.gov/content/pkg/CFR-2025-title31-vol3/pdf/CFR-2025-title31-vol3-part501.pdf",
        "sourceFile": "CFR-2025-title31-vol3-part501.pdf",
        "sourceSha256": "f10701089b3736c9c76d00377d4079a08287c9697462a0aa4c2ce13ac5fa2392",
        "sourceBytes": 411526,
        "page": 46,
        "renderDpi": 200,
        "cropPixels": [240, 1060, 1460, 1825],
    }
}

TEXT_BLOCK_TAGS = {"P", "P2", "FP", "FP-1", "FP-2", "FP-DASH", "LI", "PSPACE", "CITA", "FR", "FRP", "SECAUTH", "PARAUTH", "XREF", "CROSSREF", "APPRO"}
HEADING_TAGS = {"HED", "HD1", "HD2", "HD3", "HD4"}
CONTAINER_TAGS = {"DIV", "EXTRACT", "EXAMPLE", "SCOL2", "NOTE", "EDNOTE", "EFFDNOT", "AUTH", "SOURCE"}
TABLE_CONTAINER_TAGS = {"THEAD", "TBODY", "TFOOT"}
INLINE_STYLES = {"I": "i", "E": "b", "B": "b", "strong": "b", "SU": "sup", "sup": "sup", "SUB": "sub"}
IGNORED_EMPTY_TAGS = {"PRTPAGE", "HALFDASH", "BR", "HR", "FTREF"}


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def clean_text(value: str | None) -> str:
    return re.sub(r"\s+", " ", value or "").strip()


def flattened(element: ET.Element) -> str:
    return clean_text("".join(element.itertext()))


def fetch(url: str) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": "INASearch-Corpus-Builder/2.0 (+offline legal research corpus)"})
    for attempt in range(7):
        try:
            with urllib.request.urlopen(request, timeout=90) as response:
                return response.read()
        except urllib.error.HTTPError as error:
            if error.code != 429 or attempt == 6:
                raise
            retry_after = error.headers.get("Retry-After")
            delay = float(retry_after) if retry_after and retry_after.isdigit() else min(2 ** attempt, 20)
            time.sleep(delay)
    raise RuntimeError(f"Could not fetch {url}")


def write_capture(path: pathlib.Path, data: bytes) -> dict:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return {"file": str(path.name), "bytes": len(data), "sha256": sha256(data)}


def read_verified(path: pathlib.Path, record: dict, label: str) -> bytes:
    data = path.read_bytes()
    if len(data) != record.get("bytes") or sha256(data) != record.get("sha256"):
        raise ValueError(f"Cached {label} failed its byte/hash check.")
    return data


def capture_path(cache: pathlib.Path, title: int, part: str | None = None) -> pathlib.Path:
    return cache / "ecfr" / (f"title-{title}.xml" if part is None else f"title-{title}-part-{part}.xml")


def extract_ptar_block(raw: bytes) -> str:
    page = raw.decode("utf-8", "replace")
    match = re.search(r"8 U\.S\.C\.(.*?)(?:\n9 U\.S\.C\.)", page, re.S)
    if not match:
        raise ValueError("The GovInfo PTAR did not contain a parseable 8 U.S.C. block.")
    return html.unescape(re.sub(r"<[^>]+>", "", match.group(1)))


def parse_ptar(raw: bytes) -> dict[tuple[int, str], list[str]]:
    block = extract_ptar_block(raw)
    mappings: dict[tuple[int, str], set[str]] = {}
    current_usc = ""
    current_title: int | None = None
    for original in block.splitlines():
        line = original.rstrip()
        if not line or "[[Page " in line:
            continue
        locator = re.match(r"^\s{2}(\d+[a-z]?(?:--\d+[a-z]?)?(?: et seq| note)?)\.{3,}(.*)$", line)
        if locator:
            current_usc = locator.group(1)
            line = locator.group(2)
            current_title = None
        if not current_usc:
            continue
        title_match = re.search(r"(?:^|\s)(\d+)\s+Parts?\s+(.+)$", line)
        if title_match:
            current_title = int(title_match.group(1))
            part_text = title_match.group(2)
        elif current_title is not None and re.match(r"^\s+[0-9]", line):
            part_text = line
        else:
            continue
        for part in re.findall(r"\b\d+[a-z]?\b", part_text):
            mappings.setdefault((current_title, part), set()).add(current_usc)
    return {key: sorted(values) for key, values in mappings.items()}


def cached_usc_sections() -> set[str]:
    source = (ROOT / "src" / "INASearch-Corpus.js").read_text(encoding="utf-8")
    payload = source[source.index("=") + 1:source.rindex(";")]
    corpus = json.loads(payload)
    return {str(section["section"]).lower() for section in corpus.get("title8", {}).get("sections", [])}


def locator_intersects_cache(locator: str, sections: set[str]) -> bool:
    value = locator.lower().replace(" et seq", "").replace(" note", "")
    if "--" in value:
        start, end = value.split("--", 1)
        numeric = [int(section) for section in sections if section.isdigit()]
        return start.isdigit() and end.isdigit() and any(int(start) <= section <= int(end) for section in numeric)
    return value in sections


def intersect_ptar_mappings(mappings: dict[tuple[int, str], list[str]]) -> dict[tuple[int, str], list[str]]:
    sections = cached_usc_sections()
    return {key: [locator for locator in locators if locator_intersects_cache(locator, sections)] for key, locators in mappings.items() if any(locator_intersects_cache(locator, sections) for locator in locators)}


def refresh(cache: pathlib.Path, year: int) -> None:
    cache.mkdir(parents=True, exist_ok=True)
    captured_at = dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    ptar_url = PTAR_URL.format(year=year)
    ptar = fetch(ptar_url)
    ptar_record = write_capture(cache / "ptar.html", ptar)
    mappings = intersect_ptar_mappings(parse_ptar(ptar))
    selected = {key for key in mappings if key[0] != 8}
    expected = {(title, part) for title, parts in EXPECTED_CROSS_TITLE_PARTS.items() for part in parts}
    if year == 2025 and selected != expected:
        missing = sorted(expected - selected)
        added = sorted(selected - expected)
        raise ValueError(f"PTAR coverage drifted. Missing expected mappings: {missing}; unexpected mappings: {added}")

    titles_raw = fetch(TITLES_URL)
    title_record = write_capture(cache / "titles.json", titles_raw)
    title_items = json.loads(titles_raw)["titles"]
    dates = {int(item["number"]): item["up_to_date_as_of"] for item in title_items if item.get("up_to_date_as_of")}
    selected_titles = sorted({8, *(title for title, _ in selected)})
    missing_dates = [title for title in selected_titles if title not in dates]
    if missing_dates:
        raise ValueError(f"eCFR did not report current-through dates for titles {missing_dates}.")

    jobs: list[tuple[int, str | None, str]] = [(8, None, FULL_URL.format(date=dates[8], title=8))]
    for title, part in sorted(selected):
        if (title, part) not in REMOVED_PARTS:
            jobs.append((title, part, FULL_URL.format(date=dates[title], title=title) + f"?part={part}"))

    source_records: dict[str, dict] = {}
    def download(job: tuple[int, str | None, str]):
        title, part, url = job
        try:
            data = fetch(url)
        except urllib.error.HTTPError as error:
            if error.code == 404 and part is not None:
                return f"{title}:{part}", {"removed": True, "title": title, "part": part}
            raise
        record = write_capture(capture_path(cache, title, part), data)
        record.update({"url": url, "title": title, "part": part, "currentThrough": dates[title]})
        return f"{title}:{part or 'all'}", record

    removed_candidates = set(REMOVED_PARTS)
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        for key, record in pool.map(download, jobs):
            if record.get("removed"):
                removed_candidates.add((record["title"], record["part"]))
            else:
                source_records[key] = record

    removed_records = {}
    for title, part in sorted(removed_candidates):
        url = VERSIONS_URL.format(title=title, part=part)
        data = fetch(url)
        record = write_capture(cache / "ecfr" / f"title-{title}-part-{part}-versions.json", data)
        record.update({"url": url, "title": title, "part": part})
        removed_records[f"{title}:{part}"] = record

    manifest = {
        "schemaVersion": 1,
        "captureTime": captured_at,
        "ptarYear": year,
        "ptar": {**ptar_record, "url": ptar_url},
        "titleMetadata": {**title_record, "url": TITLES_URL},
        "currentThrough": {str(key): value for key, value in dates.items() if key in selected_titles},
        "sources": source_records,
        "removedSources": removed_records,
    }
    (cache / "capture.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    capture_graphics(cache)


def capture_graphics(cache: pathlib.Path) -> None:
    paths = set()
    for source in sorted((cache / "ecfr").glob("*.xml")):
        paths.update(re.findall(rb'<img\s+src="([^"]+)"', source.read_bytes()))
    graphics = {}
    for raw_path in sorted(paths):
        source_path = raw_path.decode("ascii")
        name = pathlib.PurePosixPath(source_path).name
        image_url = f"https://images.federalregister.gov/{pathlib.Path(name).stem.upper()}/original.gif"
        record = {"sourcePath": source_path, "url": image_url, "available": False}
        try:
            data = fetch(image_url)
            if not (data.startswith(b"GIF8") or data.startswith(b"\x89PNG") or data.startswith(b"\xff\xd8")):
                raise ValueError("publisher returned non-image content")
            image_record = write_capture(cache / "graphics" / name, data)
            record.update(image_record)
            record["available"] = True
        except (OSError, urllib.error.URLError, ValueError) as error:
            record["error"] = str(error)
            apply_graphic_fallback(cache, source_path, record, allow_fetch=True)
        graphics[source_path] = record
    (cache / "graphics.json").write_text(json.dumps(graphics, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def apply_graphic_fallback(cache: pathlib.Path, source_path: str, record: dict, allow_fetch: bool) -> None:
    fallback = GRAPHIC_FALLBACKS.get(source_path)
    if not fallback or record.get("available"):
        return
    pdf_path = cache / "graphics" / fallback["sourceFile"]
    if allow_fetch:
        pdf_data = fetch(fallback["sourceUrl"])
        write_capture(pdf_path, pdf_data)
    elif not pdf_path.exists():
        return
    pdf_data = pdf_path.read_bytes()
    if len(pdf_data) != fallback["sourceBytes"] or sha256(pdf_data) != fallback["sourceSha256"]:
        raise ValueError(f"GovInfo fallback PDF for {source_path} failed its byte/hash check.")
    asset = fallback["asset"].read_bytes()
    if sha256(asset) != fallback["assetSha256"]:
        raise ValueError(f"Reviewed fallback crop for {source_path} failed its hash check.")
    image_name = pathlib.Path(source_path).stem + ".png"
    image_record = write_capture(cache / "graphics" / image_name, asset)
    record.update(image_record)
    record.update({
        "available": True,
        "url": fallback["sourceUrl"],
        "fallbackSource": {
            "kind": "reviewed crop from official annual CFR PDF",
            "url": fallback["sourceUrl"],
            "file": fallback["sourceFile"],
            "bytes": fallback["sourceBytes"],
            "sha256": fallback["sourceSha256"],
            "page": fallback["page"],
            "renderDpi": fallback["renderDpi"],
            "cropPixels": fallback["cropPixels"],
        },
    })
    record.pop("error", None)


def inline_runs(element: ET.Element) -> list[dict]:
    runs: list[dict] = []
    def add(text: str | None, style: str | None = None):
        value = re.sub(r"\s+", " ", text or "")
        if not value:
            return
        item = {"x": value}
        if style:
            item["s"] = style
        if runs and runs[-1].get("s") == item.get("s"):
            runs[-1]["x"] += value
        else:
            runs.append(item)
    def walk(node: ET.Element, inherited: str | None = None):
        style = INLINE_STYLES.get(node.tag, inherited)
        add(node.text, style)
        for child in node:
            walk(child, style)
            add(child.tail, style)
    walk(element)
    if runs:
        runs[0]["x"] = runs[0]["x"].lstrip()
        runs[-1]["x"] = runs[-1]["x"].rstrip()
        for index in range(1, len(runs)):
            if runs[index]["x"].startswith(" "):
                separator = "" if runs[index - 1]["x"].endswith(" ") else " "
                runs[index]["x"] = separator + runs[index]["x"].lstrip()
        runs[:] = [run for run in runs if run["x"]]
    if len(runs) == 1 and "s" not in runs[0]:
        return []
    return runs


CFR_MARKER_RE = re.compile(r"\(([A-Za-z0-9ivxlcdmIVXLCDM]+)\)")
CFR_LEADING_MARKERS_RE = re.compile(r"^\s*((?:\([A-Za-z0-9ivxlcdmIVXLCDM]+\))+)")
CFR_LEADING_RANGE_RE = re.compile(r"^\s*(\(([A-Za-z0-9ivxlcdmIVXLCDM]+)\))\s*[-–—]\s*(\(([A-Za-z0-9ivxlcdmIVXLCDM]+)\))")
CFR_RUN_IN_MARKERS_RE = re.compile(r"[—–.:;]\s*((?:\([A-Za-z0-9ivxlcdmIVXLCDM]+\))+)(?=\s|$)")
CFR_ROMAN_RE = re.compile(r"[ivxlcdm]+")


def marker_matches_level(token: str, level: int) -> bool:
    if level in {2, 5}:
        return token.isdigit()
    if level in {3, 6}:
        return token.islower() and bool(CFR_ROMAN_RE.fullmatch(token))
    if level == 4:
        return token.isalpha() and token.isupper()
    return token.isalpha() and token.islower()


def roman_value(token: str) -> int:
    values = {"i": 1, "v": 5, "x": 10, "l": 50, "c": 100, "d": 500, "m": 1000}
    total = 0
    previous = 0
    for character in reversed(token.lower()):
        value = values.get(character, 0)
        total += -value if value < previous else value
        previous = max(previous, value)
    return total


def alpha_value(token: str) -> int:
    value = 0
    for character in token.lower():
        value = value * 26 + ord(character) - ord("a") + 1
    return value


def marker_value(token: str, level: int) -> int:
    if level in {2, 5}:
        return int(token)
    if level in {3, 6}:
        return roman_value(token)
    return alpha_value(token)


def marker_level(token: str, stack: list[str]) -> int:
    candidates = [level for level in range(1, 7) if marker_matches_level(token, level)]
    if not candidates:
        return 1
    starting_children = [
        level for level in candidates
        if level == len(stack) + 1 and marker_value(token, level) == 1
    ]
    if starting_children:
        return starting_children[0]
    successors = [
        level for level in candidates
        if level <= len(stack) and stack[level - 1] != "?"
        and marker_value(token, level) == marker_value(stack[level - 1], level) + 1
    ]
    if successors:
        return max(successors)
    children = [level for level in candidates if level == len(stack) + 1]
    if children:
        return children[0]
    repeated = [level for level in candidates if level <= len(stack) and stack[level - 1].lower() == token.lower()]
    if repeated:
        return max(repeated)
    deeper = [level for level in candidates if level > len(stack)]
    if deeper:
        return min(deeper)
    available = [level for level in candidates if level <= len(stack)]
    return max(available) if available else min(candidates)


def append_marker(stack: list[str], token: str, level: int | None = None) -> str:
    level = level or marker_level(token, stack)
    del stack[level - 1:]
    while len(stack) < level - 1:
        stack.append("?")
    stack.append(token)
    return "".join(f"({value})" for value in stack if value != "?")


def paragraph_units(text: str, stack: list[str]) -> list[dict]:
    leading_range = CFR_LEADING_RANGE_RE.match(text)
    leading = leading_range or CFR_LEADING_MARKERS_RE.match(text)
    if not leading:
        return []
    units: list[dict] = []

    def record_group(group: re.Match, offset: int = 0, force_children: bool = False) -> bool:
        tokens = list(CFR_MARKER_RE.finditer(group.group(1)))
        trial = list(stack)
        records = []
        for index, token_match in enumerate(tokens):
            token = token_match.group(1)
            expected = len(trial) + 1
            if force_children and not marker_matches_level(token, expected):
                return False
            level = expected if force_children else marker_level(token, trial)
            path = append_marker(trial, token, level)
            start = offset + group.start(1) + token_match.start()
            records.append({"a": path, "s": start, "e": start + len(token_match.group(0))})
        stack[:] = trial
        units.extend(records)
        return True

    if leading_range:
        level = marker_level(leading_range.group(2), stack)
        first_path = append_marker(stack, leading_range.group(2), level)
        units.append({"a": first_path, "s": leading_range.start(1), "e": leading_range.end(1)})
        last_path = append_marker(stack, leading_range.group(4), level)
        units.append({"a": last_path, "s": leading_range.start(3), "e": leading_range.end(3)})
    else:
        record_group(leading)
    for run_in in CFR_RUN_IN_MARKERS_RE.finditer(text, leading.end()):
        if run_in.start() - leading.end() > 600:
            break
        record_group(run_in, force_children=True)
    return units


def paragraph_path(stack: list[str]) -> str:
    return "".join(f"({value})" for value in stack if value != "?")


def table_block(element: ET.Element) -> dict:
    rows = []
    for row in element.findall(".//TR"):
        cells = []
        for cell in list(row):
            if cell.tag not in {"TH", "TD"}:
                continue
            item = {"x": flattened(cell)}
            if cell.tag == "TH":
                item["h"] = 1
            colspan = cell.get("colspan")
            if colspan and colspan != "1":
                item["c"] = colspan
            cells.append(item)
        if cells:
            rows.append(cells)
    block = {"t": "table", "rows": rows}
    caption = element.find("CAPTION")
    if caption is not None and flattened(caption):
        block["caption"] = flattened(caption)
    return block


def normalized_blocks(element: ET.Element, graphics: dict, stack: list[str] | None = None) -> list[dict]:
    stack = stack if stack is not None else []
    blocks: list[dict] = []
    for child in list(element):
        tag = child.tag
        if tag == "HEAD":
            continue
        if tag in TEXT_BLOCK_TAGS:
            text = flattened(child)
            if text:
                block = {"t": "p", "x": text}
                units = paragraph_units(text, stack)
                path = paragraph_path(stack)
                if path:
                    block["a"] = path
                if units:
                    block["u"] = units
                runs = inline_runs(child)
                if runs:
                    block["r"] = runs
                if tag in {"CITA", "SECAUTH", "XREF", "CROSSREF"}:
                    block["k"] = "citation"
                blocks.append(block)
        elif tag in HEADING_TAGS:
            text = flattened(child)
            if text:
                blocks.append({"t": "h", "x": text, "l": int(tag[-1]) if tag[-1].isdigit() else 4})
        elif tag == "TABLE":
            blocks.append(table_block(child))
        elif tag.lower() == "img":
            source_path = child.get("src", "")
            record = graphics.get(source_path, {})
            block = {"t": "graphic", "src": source_path, "alt": f"Official CFR graphic {pathlib.PurePosixPath(source_path).name}"}
            if record.get("data"):
                block["data"] = record["data"]
                block["mime"] = record["mime"]
            else:
                block["unavailable"] = True
            blocks.append(block)
        elif tag == "TABLE" or tag in TABLE_CONTAINER_TAGS:
            blocks.extend(normalized_blocks(child, graphics, stack))
        elif tag == "FTNT":
            text = flattened(child)
            if text:
                blocks.append({"t": "footnote", "x": text})
        elif tag in CONTAINER_TAGS:
            nested = normalized_blocks(child, graphics, stack)
            if nested:
                if tag in {"NOTE", "EDNOTE", "EFFDNOT"}:
                    blocks.append({"t": "note", "blocks": nested})
                else:
                    blocks.extend(nested)
        elif tag.startswith("DIV"):
            # Nested structural divisions are handled by the section/appendix walk.
            continue
        elif tag in IGNORED_EMPTY_TAGS or (not flattened(child) and len(child) == 0):
            continue
        else:
            text = flattened(child)
            raise ValueError(f"Unhandled text-bearing eCFR XML element <{tag}>: {text[:120]!r}")
    return blocks


def breadcrumb(element: ET.Element, ancestors: list[dict]) -> list[dict]:
    result = [dict(item) for item in ancestors]
    head = clean_text(element.findtext("HEAD"))
    if head:
        result.append({"type": element.get("TYPE", "").lower(), "number": element.get("N", ""), "heading": head})
    return result


def source_url(title: int, hierarchy: list[dict], section: str | None = None) -> str:
    path = f"https://www.ecfr.gov/current/title-{title}"
    for item in hierarchy:
        kind = item.get("type")
        number = item.get("number")
        if kind in {"chapter", "subchapter", "part", "subpart", "subject-group"} and number:
            path += f"/{kind}-{number}"
    if section:
        path += f"/section-{section}"
    return path


def load_graphics(cache: pathlib.Path) -> dict:
    records = json.loads((cache / "graphics.json").read_text(encoding="utf-8")) if (cache / "graphics.json").exists() else {}
    for source_path, record in records.items():
        apply_graphic_fallback(cache, source_path, record, allow_fetch=False)
        if not record.get("available"):
            continue
        data = read_verified(cache / "graphics" / record["file"], record, f"graphic {source_path}")
        mime = mimetypes.guess_type(record["file"])[0] or "image/gif"
        record["data"] = base64.b64encode(data).decode("ascii")
        record["mime"] = mime
    return records


def normalize_document(raw: bytes, title: int, mappings: dict, graphics: dict) -> tuple[list[dict], list[dict], list[dict]]:
    root = ET.fromstring(raw)
    parts: list[dict] = []
    sections: list[dict] = []
    appendices: list[dict] = []

    def walk(node: ET.Element, ancestors: list[dict], part_record: dict | None = None):
        node_type = node.get("TYPE", "").lower()
        current = ancestors
        if node.tag.startswith("DIV") and node_type:
            current = breadcrumb(node, ancestors)
        if node.tag == "DIV5" and node_type == "part":
            part = node.get("N", "")
            part_record = {
                "id": f"{title}:{part}", "title": title, "part": part,
                "heading": clean_text(node.findtext("HEAD")), "hierarchy": current,
                "authority": flattened(node.find("AUTH")) if node.find("AUTH") is not None else "",
                "source": flattened(node.find("SOURCE")) if node.find("SOURCE") is not None else "",
                "url": source_url(title, current), "uscMappings": mappings.get((title, part), []),
                "sectionIds": [], "appendixIds": []
            }
            parts.append(part_record)
        elif node.tag == "DIV8" and node_type == "section" and part_record:
            number = node.get("N", "")
            head = clean_text(node.findtext("HEAD"))
            heading = re.sub(r"^§\s*[^ ]+\s*", "", head)
            record = {
                "id": f"{title}:{number}", "title": title, "section": number, "partId": part_record["id"],
                "heading": heading, "hierarchy": current, "blocks": normalized_blocks(node, graphics, []),
                "url": source_url(title, current[:-1], number)
            }
            sections.append(record)
            part_record["sectionIds"].append(record["id"])
            return
        elif node.tag == "DIV9" and part_record:
            number = node.get("N", "") or clean_text(node.findtext("HEAD"))
            record = {
                "id": f"{part_record['id']}:appendix:{len(appendices) + 1}", "title": title, "partId": part_record["id"],
                "label": number, "heading": clean_text(node.findtext("HEAD")), "hierarchy": current,
                "blocks": normalized_blocks(node, graphics, []), "url": part_record["url"]
            }
            appendices.append(record)
            part_record["appendixIds"].append(record["id"])
            return
        for child in list(node):
            if child.tag.startswith("DIV"):
                walk(child, current, part_record)
    walk(root, [])
    return parts, sections, appendices


def generate(cache: pathlib.Path, output: pathlib.Path) -> dict:
    capture = json.loads((cache / "capture.json").read_text(encoding="utf-8"))
    ptar = read_verified(cache / "ptar.html", capture["ptar"], "Parallel Table")
    read_verified(cache / "titles.json", capture["titleMetadata"], "eCFR title metadata")
    mappings = intersect_ptar_mappings(parse_ptar(ptar))
    graphics = load_graphics(cache)
    parts: list[dict] = []
    sections: list[dict] = []
    appendices: list[dict] = []
    sources = []
    for key, record in sorted(capture["sources"].items(), key=lambda item: tuple(int(x) if x.isdigit() else -1 for x in item[0].split(":"))):
        title = int(record["title"])
        part = record["part"]
        raw = read_verified(capture_path(cache, title, part), record, f"source {key}")
        p, s, a = normalize_document(raw, title, mappings, graphics)
        parts.extend(p); sections.extend(s); appendices.extend(a)
        sources.append({"title": title, "part": part, "url": record["url"], "bytes": record["bytes"], "sha256": record["sha256"], "currentThrough": record["currentThrough"]})

    removed = []
    for item in sorted(capture.get("removedSources", {}).values(), key=lambda record: (record["title"], str(record["part"]))):
        title, part = int(item["title"]), str(item["part"])
        version_file = cache / "ecfr" / f"title-{title}-part-{part}-versions.json"
        history = json.loads(read_verified(version_file, item, f"removed-part history {title}:{part}").decode("utf-8"))
        versions = history.get("content_versions") or history.get("versions") or []
        removed_on = next((item.get("date") or item.get("effective_on") for item in versions if str(item.get("removed", "")).lower() == "true" or item.get("type") == "removed"), None)
        removed.append({
            "id": f"{title}:{part}", "title": title, "part": part, "status": "removed", "removedOn": removed_on or "2026-05-26",
            "uscMappings": mappings.get((title, part), []), "historyUrl": VERSIONS_URL.format(title=title, part=part),
            "sourceBytes": item.get("bytes"), "sourceSha256": item.get("sha256"),
            "message": "This mapped part has been removed from the current eCFR; no outdated regulatory text is included."
        })

    title_counts = {}
    for section in sections:
        title_counts[str(section["title"])] = title_counts.get(str(section["title"]), 0) + 1
    graphic_records = []
    for source_path, item in sorted(graphics.items()):
        graphic_records.append({key: item[key] for key in ("sourcePath", "url", "available", "bytes", "sha256", "fallbackSource", "error") if key in item})
    result = {
        "schemaVersion": 1,
        "ptarYear": capture["ptarYear"],
        "captureTime": capture["captureTime"],
        "ptar": {**capture["ptar"], "mappingCount": len(mappings)},
        "titleMetadata": capture["titleMetadata"],
        "currentThrough": capture["currentThrough"],
        "coverage": {"core": "Complete current Title 8 CFR", "titles": sorted({part["title"] for part in parts}), "partCount": len(parts), "sectionCount": len(sections), "appendixCount": len(appendices), "sectionCountsByTitle": title_counts},
        "sources": sources,
        "graphics": graphic_records,
        "parts": parts,
        "sections": sections,
        "appendices": appendices,
        "removedParts": removed,
    }
    unavailable = [item["sourcePath"] for item in graphic_records if not item["available"]]
    result["coverage"]["graphicsCount"] = len(graphic_records)
    result["coverage"]["embeddedGraphicsCount"] = len(graphic_records) - len(unavailable)
    result["coverage"]["unavailableGraphics"] = unavailable
    output.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(result, ensure_ascii=False, separators=(",", ":"))
    output.write_text("/* Generated by tools/generate-cfr-corpus.py; do not hand edit. */\nwindow.INA_SEARCH_CFR = " + payload.replace("<", "\\u003c") + ";\n", encoding="utf-8")
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--refresh", action="store_true", help="Download and capture current official inputs.")
    mode.add_argument("--from-cache", type=pathlib.Path, help="Regenerate without network access from a capture directory.")
    parser.add_argument("--ptar-year", type=int, default=2025)
    parser.add_argument("--cache", type=pathlib.Path, default=ROOT / "tmp" / "cfr-cache")
    parser.add_argument("--output", type=pathlib.Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()
    cache = args.cache if args.refresh else args.from_cache
    if args.refresh:
        refresh(cache, args.ptar_year)
    result = generate(cache, args.output)
    coverage = result["coverage"]
    print(f"Generated {args.output}: {coverage['partCount']} parts, {coverage['sectionCount']} sections, {coverage['appendixCount']} appendices, {coverage['embeddedGraphicsCount']}/{coverage['graphicsCount']} graphics embedded")
    if coverage["unavailableGraphics"]:
        print("Unavailable graphics: " + ", ".join(coverage["unavailableGraphics"]), file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
