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
from html.parser import HTMLParser


ROOT = pathlib.Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT = ROOT / "src" / "INASearch-CFR.js"
PTAR_URL = "https://www.govinfo.gov/content/pkg/GPO-CFR-INDEX-{year}/html/GPO-CFR-INDEX-{year}-4.htm"
TITLES_URL = "https://www.ecfr.gov/api/versioner/v1/titles.json"
FULL_URL = "https://www.ecfr.gov/api/versioner/v1/full/{date}/title-{title}.xml"
RENDERER_URL = "https://www.ecfr.gov/api/renderer/v1/content/enhanced/{date}/title-{title}?part={part}"
VERSIONS_URL = "https://www.ecfr.gov/api/versioner/v1/versions/title-{title}.json?part={part}"
CFR_SCOPE_POLICY_PATH = ROOT / "sources" / "legal" / "cfr-scope-policy.json"
CFR_SCOPE_POLICY_BYTES = CFR_SCOPE_POLICY_PATH.read_bytes()
CFR_SCOPE_POLICY = json.loads(CFR_SCOPE_POLICY_BYTES)
if CFR_SCOPE_POLICY.get("schemaVersion") != 1:
    raise ValueError("Unsupported CFR scope-policy schema")
EXPECTED_CROSS_TITLE_PARTS = {
    int(title): [str(part) for part in parts]
    for title, parts in CFR_SCOPE_POLICY["crossTitleCoverage"]["expectedParts"].items()
}
REMOVED_PARTS = {
    (int(value.split(":", 1)[0]), value.split(":", 1)[1])
    for value in CFR_SCOPE_POLICY["crossTitleCoverage"].get("removedParts", [])
}
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
NOTE_TYPES = {"NOTE": "ordinary", "EDNOTE": "editorial", "EFFDNOT": "effective-date"}
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
    for attempt in range(12):
        try:
            with urllib.request.urlopen(request, timeout=90) as response:
                return response.read()
        except urllib.error.HTTPError as error:
            if error.code != 429 or attempt == 11:
                raise
            retry_after = error.headers.get("Retry-After")
            delay = float(retry_after) if retry_after and retry_after.isdigit() else min(2 ** attempt, 60)
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


def renderer_capture_path(cache: pathlib.Path, title: int, part: str) -> pathlib.Path:
    return cache / "ecfr-rendered" / f"title-{title}-part-{part}.html"


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


def validate_reviewed_scope(mappings: dict[tuple[int, str], list[str]], year: int) -> None:
    reviewed_year = int(CFR_SCOPE_POLICY["crossTitleCoverage"]["ptarYear"])
    if year != reviewed_year:
        raise ValueError(f"CFR scope policy reviews PTAR year {reviewed_year}, not {year}; update the policy before refreshing")
    selected = {key for key in mappings if key[0] != 8}
    expected = {(title, part) for title, parts in EXPECTED_CROSS_TITLE_PARTS.items() for part in parts}
    if selected != expected:
        missing = sorted(expected - selected)
        added = sorted(selected - expected)
        raise ValueError(f"PTAR coverage drifted. Missing expected mappings: {missing}; unexpected mappings: {added}")


def refresh(cache: pathlib.Path, year: int) -> None:
    reviewed_year = int(CFR_SCOPE_POLICY["crossTitleCoverage"]["ptarYear"])
    if year != reviewed_year:
        raise ValueError(f"CFR scope policy reviews PTAR year {reviewed_year}, not {year}; update the policy before refreshing")
    cache.mkdir(parents=True, exist_ok=True)
    captured_at = dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    ptar_url = PTAR_URL.format(year=year)
    ptar = fetch(ptar_url)
    ptar_record = write_capture(cache / "ptar.html", ptar)
    mappings = intersect_ptar_mappings(parse_ptar(ptar))
    validate_reviewed_scope(mappings, year)
    selected = {key for key in mappings if key[0] != 8}

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
    capture_renderers(cache)
    capture_graphics(cache)


def captured_part_keys(cache: pathlib.Path, capture: dict) -> list[tuple[int, str, str]]:
    """Return every retained part and its source date from the verified XML."""
    parts: set[tuple[int, str, str]] = set()
    for key, record in capture["sources"].items():
        title = int(record["title"])
        raw = read_verified(capture_path(cache, title, record["part"]), record, f"source {key}")
        root = ET.fromstring(raw)
        for node in root.iter("DIV5"):
            if node.get("TYPE", "").lower() != "part" or not node.get("N"):
                continue
            parts.add((title, str(node.get("N")), str(record["currentThrough"])))
    return sorted(parts, key=lambda item: (item[0], int(item[1]) if item[1].isdigit() else sys.maxsize, item[1]))


def capture_renderers(cache: pathlib.Path) -> None:
    """Capture eCFR's same-date enhanced HTML, which carries paragraph nesting."""
    capture_file = cache / "capture.json"
    capture = json.loads(capture_file.read_text(encoding="utf-8"))
    jobs = captured_part_keys(cache, capture)
    previous_records = capture.get("renderers", {})

    def download(job: tuple[int, str, str]):
        title, part, current_through = job
        url = RENDERER_URL.format(date=current_through, title=title, part=part)
        path = renderer_capture_path(cache, title, part)
        key = f"{title}:{part}"
        previous = previous_records.get(key, {})
        reusable = previous.get("url") == url and previous.get("currentThrough") == current_through and path.exists()
        data = path.read_bytes() if reusable else b""
        if reusable and (len(data) != previous.get("bytes") or sha256(data) != previous.get("sha256")):
            reusable = False
        if not reusable:
            data = fetch(url)
            time.sleep(0.35)
        record = write_capture(path, data)
        record.update({"url": url, "title": title, "part": part, "currentThrough": current_through})
        return key, record

    renderer_records = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
        for key, record in pool.map(download, jobs):
            renderer_records[key] = record
            capture["renderers"] = renderer_records
            capture_file.write_text(json.dumps(capture, indent=2, sort_keys=True) + "\n", encoding="utf-8")


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


def slice_inline_runs(runs: list[dict], start: int, end: int) -> list[dict]:
    """Return formatting runs for one exact slice of a flattened XML block."""
    if not runs or end <= start:
        return []
    sliced: list[dict] = []
    cursor = 0
    for run in runs:
        run_start, run_end = cursor, cursor + len(run["x"])
        cursor = run_end
        overlap_start, overlap_end = max(start, run_start), min(end, run_end)
        if overlap_end <= overlap_start:
            continue
        item = {"x": run["x"][overlap_start - run_start:overlap_end - run_start]}
        if run.get("s"):
            item["s"] = run["s"]
        if sliced and sliced[-1].get("s") == item.get("s"):
            sliced[-1]["x"] += item["x"]
        else:
            sliced.append(item)
    if len(sliced) == 1 and "s" not in sliced[0]:
        return []
    return sliced


CFR_MARKER_RE = re.compile(r"\(([^)]+)\)")
CFR_LEADING_MARKERS_RE = re.compile(r"^\s*((?:\([A-Za-z0-9ivxlcdmIVXLCDM]+\))+)")
CFR_LEADING_RANGE_RE = re.compile(r"^\s*(\(([A-Za-z0-9ivxlcdmIVXLCDM]+)\))\s*[-–—]\s*(\(([A-Za-z0-9ivxlcdmIVXLCDM]+)\))")
MATCH_CHARACTER_EQUIVALENTS = str.maketrans({
    "–": "-", "—": "-", "−": "-", "‐": "-", "‑": "-",
    "“": '"', "”": '"', "‘": "'", "’": "'", "⁄": "/", "\u00ad": "",
})


def paragraph_path(tokens: list[str]) -> str:
    return "".join(f"({value})" for value in tokens)


def canonical_match_text(value: str) -> str:
    return "".join(character for character in value.translate(MATCH_CHARACTER_EQUIVALENTS) if not character.isspace())


def canonical_match_map(value: str) -> tuple[str, list[int]]:
    characters: list[str] = []
    offsets: list[int] = []
    for index, source_character in enumerate(value):
        translated = source_character.translate(MATCH_CHARACTER_EQUIVALENTS)
        for character in translated:
            if character.isspace():
                continue
            characters.append(character)
            offsets.append(index)
    return "".join(characters), offsets


class EnhancedHTMLParser(HTMLParser):
    """Extract eCFR's explicit rendered paragraph hierarchy and visible text."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.records: list[dict] = []
        self.current_record: dict | None = None
        self.div_record_stack: list[dict | None] = []
        self.current_paragraph_id = ""
        self.div_paragraph_id_stack: list[str] = []
        self.current_paragraph: dict | None = None
        self.table_depth = 0
        self.current_table: dict | None = None
        self.footnote_depth = 0
        self.footnote_div_stack: list[bool] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attributes = {key: value or "" for key, value in attrs}
        if tag == "table":
            if self.table_depth == 0 and self.current_record is not None and not self.footnote_depth:
                self.current_table = {
                    "dataTitle": "", "canonicalId": self.current_paragraph_id, "addressable": False,
                    "titled": False,
                    "indent": 0, "heading": False, "disabled": False, "term": False,
                    "elementKind": "table", "textParts": [],
                }
            self.table_depth += 1
        if tag == "div":
            self.div_record_stack.append(self.current_record)
            self.div_paragraph_id_stack.append(self.current_paragraph_id)
            classes = set(attributes.get("class", "").split())
            is_footnote_container = bool(classes & {"footnote", "footnotes"})
            self.footnote_div_stack.append(is_footnote_container)
            if is_footnote_container:
                self.footnote_depth += 1
            kind = "section" if "section" in classes else "appendix" if "appendix" in classes else ""
            if kind:
                record = {"kind": kind, "id": attributes.get("id", ""), "paragraphs": [], "textParts": []}
                self.records.append(record)
                self.current_record = record
            if attributes.get("id", "").startswith("p-"):
                self.current_paragraph_id = attributes["id"]
        if tag == "p" and self.current_record is not None and not self.table_depth and not self.footnote_depth:
            paragraph_classes = set(attributes.get("class", "").split())
            indent_match = re.search(r"(?:^|\s)(?:indent|flush-paragraph)-(\d+)(?:\s|$)", attributes.get("class", ""))
            self.current_paragraph = {
                "dataTitle": attributes.get("data-title", ""),
                "canonicalId": attributes.get("id") or self.current_paragraph_id,
                "addressable": bool(attributes.get("data-title")),
                "titled": bool(attributes.get("data-title")),
                "indent": int(indent_match.group(1)) if indent_match else 0,
                "heading": any(re.fullmatch(r"hd\d+-paragraph", value) for value in paragraph_classes),
                "disabled": attributes.get("data-disable", "").lower() == "true",
                "term": attributes.get("data-term", "").lower() == "true",
                "elementKind": "p",
                "sourceTag": "p",
                "textParts": [],
            }
        elif tag in {"h1", "h2", "h3", "h4", "h5", "h6"} and self.current_record is not None and self.current_paragraph_id and not self.table_depth and not self.footnote_depth:
            self.current_paragraph = {
                "dataTitle": attributes.get("data-title", ""), "canonicalId": self.current_paragraph_id,
                "addressable": bool(attributes.get("data-title")), "titled": bool(attributes.get("data-title")), "indent": 0, "heading": True,
                "disabled": False, "term": False, "elementKind": "heading", "sourceTag": tag, "textParts": [],
            }

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.handle_starttag(tag, attrs)
        self.handle_endtag(tag)

    def handle_data(self, data: str) -> None:
        if self.current_record is not None:
            self.current_record["textParts"].append(data)
        if self.current_paragraph is not None:
            self.current_paragraph["textParts"].append(data)
        if self.current_table is not None:
            self.current_table["textParts"].append(data)

    def handle_endtag(self, tag: str) -> None:
        if self.current_paragraph is not None and tag == self.current_paragraph.get("sourceTag"):
            self.current_paragraph["text"] = clean_text("".join(self.current_paragraph.pop("textParts")))
            self.current_paragraph.pop("sourceTag", None)
            if self.current_paragraph["text"]:
                self.current_record["paragraphs"].append(self.current_paragraph)
            self.current_paragraph = None
        if tag == "div" and self.div_record_stack:
            self.current_record = self.div_record_stack.pop()
            self.current_paragraph_id = self.div_paragraph_id_stack.pop()
            if self.footnote_div_stack.pop():
                self.footnote_depth -= 1
        if tag == "table" and self.table_depth:
            self.table_depth -= 1
            if self.table_depth == 0 and self.current_table is not None:
                self.current_table["text"] = clean_text("".join(self.current_table.pop("textParts")))
                if self.current_table["text"]:
                    self.current_record["paragraphs"].append(self.current_table)
                self.current_table = None


def parse_enhanced_html(raw: bytes, title: int, part: str) -> dict:
    parser = EnhancedHTMLParser()
    parser.feed(raw.decode("utf-8"))
    parser.close()
    sections = {}
    appendices = []
    for record in parser.records:
        record["text"] = clean_text("".join(record.pop("textParts")))
        for paragraph in record["paragraphs"]:
            canonical_id = paragraph["canonicalId"]
            prefix = f"p-{record['id']}"
            if canonical_id and not canonical_id.startswith(prefix):
                raise ValueError(f"Rendered Title {title} Part {part} paragraph {paragraph['dataTitle']!r} has canonical id {canonical_id!r}, outside record {record['id']!r}")
            paragraph["path"] = CFR_MARKER_RE.findall(canonical_id[len(prefix):]) if canonical_id else []
            if not paragraph["addressable"] and paragraph["path"]:
                leading = CFR_LEADING_MARKERS_RE.match(paragraph["text"])
                visible = CFR_MARKER_RE.findall(leading.group(1)) if leading else []
                dotted = paragraph["path"][-1]
                if (visible and paragraph["path"][-len(visible):] == visible) or (dotted.endswith(".") and paragraph["text"].lstrip().startswith(dotted)):
                    paragraph["addressable"] = True
        if record["kind"] == "section":
            if not record["id"] or record["id"] in sections:
                raise ValueError(f"Rendered Title {title} Part {part} has a duplicate or empty section id {record['id']!r}")
            sections[record["id"]] = record
        else:
            appendices.append(record)
    return {"title": title, "part": part, "sections": sections, "appendices": appendices}


class ParagraphOracle:
    """Map flat XML paragraphs to same-date eCFR rendered paths without guessing."""

    def __init__(self, record: dict, label: str):
        if record is None:
            raise ValueError(f"The enhanced eCFR capture has no record for {label}")
        self.entries = record["paragraphs"]
        self.index = 0
        self.current_path: list[str] = []
        self.current_context: list[str] = []
        self.current_depth = 0
        self.label = label

    def _entry_units(self, entry: dict, text: str, entry_start: int) -> list[dict]:
        if not entry["addressable"] or entry["term"] or entry["disabled"]:
            return []
        leading_range = CFR_LEADING_RANGE_RE.match(entry["text"])
        leading = leading_range or CFR_LEADING_MARKERS_RE.match(entry["text"])
        if not leading:
            # Some appendices use an outline whose visible markers are dotted
            # tokens ("A.", "1.", "i.") rather than parentheses.  The full
            # ancestry still comes from the renderer id; only the final token
            # is printed in each XML paragraph.
            token = entry["path"][-1] if entry["path"] else ""
            rendered_start = len(entry["text"]) - len(entry["text"].lstrip())
            source_start = len(text[entry_start:]) - len(text[entry_start:].lstrip()) + entry_start
            if token.endswith(".") and entry["text"].startswith(token, rendered_start) and text.startswith(token, source_start):
                return [{"a": paragraph_path(entry["path"]), "s": source_start, "e": source_start + len(token)}]
            raise ValueError(f"Rendered {self.label} paragraph {entry['dataTitle']!r} lacks a recognized visible marker: {entry['text'][:120]!r}")
        source_leading = (CFR_LEADING_RANGE_RE if leading_range else CFR_LEADING_MARKERS_RE).match(text[entry_start:])
        if not source_leading:
            raise ValueError(f"XML text for rendered {entry['dataTitle']!r} does not expose its marker at offset {entry_start}: {text[entry_start:entry_start + 120]!r}")
        if leading_range:
            first_token, last_token = leading_range.group(2), leading_range.group(4)
            if not entry["path"] or entry["path"][-1] != first_token:
                raise ValueError(f"Rendered range {entry['dataTitle']!r} disagrees with its first marker {first_token!r}")
            first_path = entry["path"]
            last_path = [*entry["path"][:-1], last_token]
            return [
                {"a": paragraph_path(first_path), "s": entry_start + source_leading.start(1), "e": entry_start + source_leading.end(1)},
                {"a": paragraph_path(last_path), "s": entry_start + source_leading.start(3), "e": entry_start + source_leading.end(3)},
            ]
        markers = list(CFR_MARKER_RE.finditer(leading.group(1)))
        visible_tokens = [match.group(1) for match in markers]
        if not entry["path"] or len(visible_tokens) > len(entry["path"]) or entry["path"][-len(visible_tokens):] != visible_tokens:
            raise ValueError(f"Rendered path {entry['dataTitle']!r} disagrees with its visible markers {visible_tokens}")
        base_length = len(entry["path"]) - len(visible_tokens)
        # The flat XML can place several renderer paragraphs in one text node,
        # including adjacent markers such as ``(c)(1)``.  Only consume the
        # number of markers that are actually visible in this renderer entry;
        # the following marker belongs to the following canonical paragraph.
        source_markers = list(CFR_MARKER_RE.finditer(source_leading.group(1)))[:len(visible_tokens)]
        if len(source_markers) != len(visible_tokens):
            raise ValueError(f"XML text for rendered {entry['dataTitle']!r} exposes {len(source_markers)} markers, expected {len(visible_tokens)}")
        return [
            {
                "a": paragraph_path(entry["path"][:base_length + index + 1]),
                "s": entry_start + source_leading.start(1) + source_marker.start(),
                "e": entry_start + source_leading.start(1) + source_marker.end(),
            }
            for index, source_marker in enumerate(source_markers)
        ]

    def consume(self, text: str) -> tuple[list[dict], str, int, str, list[dict]]:
        canonical, offsets = canonical_match_map(text)
        search_from = 0
        units: list[dict] = []
        consumed_entries: list[dict] = []
        starting_index = self.index
        while self.index < len(self.entries):
            entry = self.entries[self.index]
            expected = canonical_match_text(entry["text"])
            if not expected:
                raise ValueError(f"Rendered {self.label} paragraph {entry['dataTitle']!r} has no visible text")
            found = canonical.find(expected, search_from)
            consumed_length = len(expected)
            if found < 0:
                # The enhanced renderer decorates XML <SU> footnote numbers as
                # bracketed links.  Match the exact text preceding the first
                # decoration; hierarchy still comes exclusively from its
                # canonical paragraph id.
                undecorated = re.split(r"\[[A-Za-z0-9-]+\]", entry["text"], maxsplit=1)[0]
                probe = canonical_match_text(undecorated)
                if probe and probe != expected:
                    found = canonical.find(probe, search_from)
                    consumed_length = len(probe)
            if found < 0:
                break
            entry_start = offsets[found]
            entry_units = self._entry_units(entry, text, entry_start)
            units.extend(entry_units)
            consumed_entries.append({"entry": entry, "start": entry_start, "units": entry_units})
            self.index += 1
            search_from = found + consumed_length
            self.current_depth = entry["indent"] or (len(entry["path"]) if not entry["addressable"] else 0)
            if entry["term"] or entry["disabled"]:
                self.current_path = []
                self.current_context = []
            elif not entry["addressable"]:
                self.current_path = []
                self.current_context = list(entry["path"])
            elif units:
                self.current_path = CFR_MARKER_RE.findall(units[-1]["a"])
                self.current_context = list(self.current_path)
        consumed = self.index != starting_index
        segments: list[dict] = []
        for index, consumed_entry in enumerate(consumed_entries):
            entry = consumed_entry["entry"]
            raw_start = 0 if index == 0 else consumed_entry["start"]
            raw_end = consumed_entries[index + 1]["start"] if index + 1 < len(consumed_entries) else len(text)
            raw = text[raw_start:raw_end]
            start = raw_start + len(raw) - len(raw.lstrip())
            end = raw_end - (len(raw) - len(raw.rstrip()))
            entry_units = [
                {**unit, "s": unit["s"] - start, "e": unit["e"] - start}
                for unit in consumed_entry["units"]
                if start <= unit["s"] < unit["e"] <= end
            ]
            address = (entry_units[-1]["a"] if entry_units else paragraph_path(entry["path"])) if entry["addressable"] and not entry["term"] and not entry["disabled"] else ""
            context = address if address else paragraph_path(entry["path"]) if entry["path"] and not entry["term"] and not entry["disabled"] else ""
            depth = entry["indent"] or (len(entry["path"]) if not entry["addressable"] else 0)
            segments.append({"start": start, "end": end, "a": address, "c": context, "d": depth, "u": entry_units})
        return units, paragraph_path(self.current_path) if consumed else "", self.current_depth if consumed else 0, paragraph_path(self.current_context) if consumed else "", segments

    def consume_nonaddressable_wrapper(self, text: str) -> bool:
        """Consume a renderer-only wrapper paragraph composed from XML children.

        The enhanced renderer sometimes combines a structural heading and its
        first XML paragraph into one non-addressable paragraph (for example an
        <EXAMPLE><HED>Example:</HED><PSPACE>...</PSPACE></EXAMPLE>).  This is
        safe to consume ahead of the individual XML blocks only when it is
        non-addressable (or explicitly marked as a term/disabled paragraph);
        legal paragraph paths are never discarded here.
        """
        if self.index >= len(self.entries):
            return False
        entry = self.entries[self.index]
        if entry["elementKind"] != "p" or (entry["addressable"] and not (entry["term"] or entry["disabled"])):
            return False
        canonical = canonical_match_text(text)
        expected = canonical_match_text(entry["text"])
        if not expected or expected not in canonical:
            return False
        self.index += 1
        self.current_depth = entry["indent"]
        self.current_path = []
        self.current_context = list(entry["path"]) if not entry["addressable"] else []
        return True

    def consume_heading(self, text: str) -> tuple[list[dict], str, int, str]:
        """Consume an addressable renderer heading stored as an XML HD element."""
        if self.index >= len(self.entries):
            return [], "", 0, ""
        entry = self.entries[self.index]
        if not entry["heading"] or canonical_match_text(entry["text"]) != canonical_match_text(text):
            return [], "", 0, ""
        self.index += 1
        self.current_path = list(entry["path"]) if entry["addressable"] else []
        self.current_context = list(entry["path"])
        self.current_depth = entry["indent"] or len(entry["path"])
        units = []
        if entry["addressable"] and entry["path"]:
            token = entry["path"][-1]
            start = len(text) - len(text.lstrip())
            if not text.startswith(token, start):
                raise ValueError(f"Rendered heading path {entry['dataTitle']!r} is not visible in XML heading {text!r}")
            units.append({"a": paragraph_path(entry["path"]), "s": start, "e": start + len(token)})
        return units, paragraph_path(self.current_path), self.current_depth, paragraph_path(self.current_context)

    def finish(self) -> None:
        if self.index != len(self.entries):
            entry = self.entries[self.index]
            raise ValueError(f"XML normalization did not consume rendered {self.label} paragraph {entry['dataTitle']!r}: {entry['text'][:160]!r}")


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


def normalized_blocks(element: ET.Element, graphics: dict, oracle: ParagraphOracle, default_depth: int = 0, default_context: str = "") -> list[dict]:
    blocks: list[dict] = []
    for child in list(element):
        tag = child.tag
        if tag == "HEAD":
            continue
        if tag in TEXT_BLOCK_TAGS:
            text = flattened(child)
            if text:
                runs = inline_runs(child)
                units, path, depth, context_path, segments = oracle.consume(text)
                if not segments:
                    segments = [{"start": 0, "end": len(text), "a": path, "c": context_path, "d": depth, "u": units}]
                for segment in segments:
                    start, end = segment["start"], segment["end"]
                    segment_text = text[start:end]
                    if not segment_text:
                        continue
                    block = {"t": "p", "x": segment_text}
                    segment_path = segment.get("a", "")
                    segment_context = segment.get("c", "")
                    if segment_path:
                        block["a"] = segment_path
                    if segment_context and segment_context != segment_path:
                        block["c"] = segment_context
                    elif default_context and not segment_path and not segment_context:
                        block["c"] = default_context
                    if segment.get("u"):
                        block["u"] = segment["u"]
                    display_depth = segment.get("d", 0) or default_depth
                    if display_depth and display_depth != len(CFR_MARKER_RE.findall(segment_path)):
                        block["d"] = display_depth
                    segment_runs = slice_inline_runs(runs, start, end)
                    if segment_runs:
                        if "".join(run["x"] for run in segment_runs) != segment_text:
                            raise ValueError(f"Formatting runs do not align after splitting rendered {oracle.label} at {start}:{end}")
                        block["r"] = segment_runs
                    if tag in {"CITA", "SECAUTH", "XREF", "CROSSREF"}:
                        block["k"] = "citation"
                    blocks.append(block)
        elif tag in HEADING_TAGS:
            text = flattened(child)
            if text:
                block = {"t": "h", "x": text, "l": int(tag[-1]) if tag[-1].isdigit() else 4}
                units, path, depth, context_path = oracle.consume_heading(text)
                if path:
                    block["a"] = path
                if context_path and context_path != path:
                    block["c"] = context_path
                elif default_context and not path:
                    block["c"] = default_context
                if units:
                    block["u"] = units
                if depth and depth != len(CFR_MARKER_RE.findall(path)):
                    block["d"] = depth
                blocks.append(block)
        elif tag == "TABLE":
            block = table_block(child)
            units, path, depth, context_path, _segments = oracle.consume(flattened(child))
            if units or path:
                raise ValueError(f"Rendered {oracle.label} table unexpectedly declares an addressable paragraph")
            if context_path:
                block["c"] = context_path
            display_depth = depth or default_depth
            if display_depth:
                block["d"] = display_depth
            blocks.append(block)
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
            blocks.extend(normalized_blocks(child, graphics, oracle, default_depth, default_context))
        elif tag == "FTNT":
            text = flattened(child)
            if text:
                blocks.append({"t": "footnote", "x": text})
        elif tag in CONTAINER_TAGS:
            nested_depth = default_depth
            nested_context = default_context
            if tag == "EXAMPLE":
                if oracle.consume_nonaddressable_wrapper(flattened(child)):
                    nested_depth = oracle.current_depth
                    nested_context = paragraph_path(oracle.current_context)
            nested = normalized_blocks(child, graphics, oracle, nested_depth, nested_context)
            if nested:
                if tag in NOTE_TYPES:
                    blocks.append({"t": "note", "noteType": NOTE_TYPES[tag], "blocks": nested})
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


def normalize_document(raw: bytes, title: int, mappings: dict, graphics: dict, rendered_parts: dict[str, dict]) -> tuple[list[dict], list[dict], list[dict]]:
    root = ET.fromstring(raw)
    parts: list[dict] = []
    sections: list[dict] = []
    appendices: list[dict] = []
    renderer_usage: dict[str, dict] = {}

    def walk(node: ET.Element, ancestors: list[dict], part_record: dict | None = None, rendered_part: dict | None = None):
        node_type = node.get("TYPE", "").lower()
        current = ancestors
        if node.tag.startswith("DIV") and node_type:
            current = breadcrumb(node, ancestors)
        if node.tag == "DIV5" and node_type == "part":
            part = node.get("N", "")
            rendered_part = rendered_parts.get(part)
            if rendered_part is None:
                raise ValueError(f"The enhanced eCFR capture has no Title {title} Part {part} record")
            renderer_usage[part] = {"sections": set(), "appendixCount": 0}
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
            rendered_record = rendered_part["sections"].get(number)
            oracle = ParagraphOracle(rendered_record, f"{title} CFR {number}")
            record = {
                "id": f"{title}:{number}", "title": title, "section": number, "partId": part_record["id"],
                "heading": heading, "hierarchy": current, "blocks": normalized_blocks(node, graphics, oracle),
                "url": source_url(title, current[:-1], number)
            }
            oracle.finish()
            sections.append(record)
            part_record["sectionIds"].append(record["id"])
            renderer_usage[str(part_record["part"])]["sections"].add(number)
            return
        elif node.tag == "DIV9" and part_record:
            number = node.get("N", "") or clean_text(node.findtext("HEAD"))
            usage = renderer_usage[str(part_record["part"])]
            appendix_index = usage["appendixCount"]
            if appendix_index >= len(rendered_part["appendices"]):
                raise ValueError(f"The enhanced eCFR capture has no rendered record for {title} CFR {number}")
            rendered_record = rendered_part["appendices"][appendix_index]
            oracle = ParagraphOracle(rendered_record, f"{title} CFR {number}")
            record = {
                "id": f"{part_record['id']}:appendix:{len(appendices) + 1}", "title": title, "partId": part_record["id"],
                "label": number, "heading": clean_text(node.findtext("HEAD")), "hierarchy": current,
                "blocks": normalized_blocks(node, graphics, oracle), "url": part_record["url"]
            }
            oracle.finish()
            appendices.append(record)
            part_record["appendixIds"].append(record["id"])
            usage["appendixCount"] += 1
            return
        for child in list(node):
            if child.tag.startswith("DIV"):
                walk(child, current, part_record, rendered_part)
    walk(root, [])
    for part, usage in renderer_usage.items():
        rendered_part = rendered_parts[part]
        missing_sections = sorted(set(rendered_part["sections"]) - usage["sections"])
        extra_sections = sorted(usage["sections"] - set(rendered_part["sections"]))
        if missing_sections or extra_sections:
            raise ValueError(f"Title {title} Part {part} XML/renderer section inventory differs; renderer-only={missing_sections}, XML-only={extra_sections}")
        if usage["appendixCount"] != len(rendered_part["appendices"]):
            raise ValueError(f"Title {title} Part {part} XML has {usage['appendixCount']} appendices but the renderer has {len(rendered_part['appendices'])}")
    return parts, sections, appendices


def generate(cache: pathlib.Path, output: pathlib.Path) -> dict:
    capture = json.loads((cache / "capture.json").read_text(encoding="utf-8"))
    ptar = read_verified(cache / "ptar.html", capture["ptar"], "Parallel Table")
    read_verified(cache / "titles.json", capture["titleMetadata"], "eCFR title metadata")
    mappings = intersect_ptar_mappings(parse_ptar(ptar))
    validate_reviewed_scope(mappings, int(capture["ptarYear"]))
    captured_removed = {
        (int(record["title"]), str(record["part"]))
        for record in capture.get("removedSources", {}).values()
    }
    if captured_removed != REMOVED_PARTS:
        raise ValueError(f"Removed-part coverage drifted. Policy: {sorted(REMOVED_PARTS)}; capture: {sorted(captured_removed)}")
    graphics = load_graphics(cache)
    expected_renderer_keys = {f"{title}:{part}" for title, part, _ in captured_part_keys(cache, capture)}
    renderer_records = capture.get("renderers", {})
    if set(renderer_records) != expected_renderer_keys:
        missing = sorted(expected_renderer_keys - set(renderer_records))
        added = sorted(set(renderer_records) - expected_renderer_keys)
        raise ValueError(f"Enhanced-renderer coverage differs from the XML part inventory. Missing: {missing}; unexpected: {added}. Run --capture-renderers for this cache.")
    rendered_by_title: dict[int, dict[str, dict]] = {}
    renderer_sources = []
    renderer_record_count = 0
    renderer_paragraph_count = 0
    renderer_element_count = 0
    renderer_addressed_element_count = 0
    renderer_titled_element_count = 0
    renderer_context_element_count = 0
    for key, record in sorted(renderer_records.items(), key=lambda item: (int(item[1]["title"]), int(item[1]["part"]) if str(item[1]["part"]).isdigit() else sys.maxsize, str(item[1]["part"]))):
        title, part = int(record["title"]), str(record["part"])
        raw = read_verified(renderer_capture_path(cache, title, part), record, f"enhanced renderer {key}")
        rendered = parse_enhanced_html(raw, title, part)
        rendered_by_title.setdefault(title, {})[part] = rendered
        rendered_records = [*rendered["sections"].values(), *rendered["appendices"]]
        renderer_record_count += len(rendered_records)
        renderer_elements = [element for item in rendered_records for element in item["paragraphs"]]
        renderer_paragraph_count += sum(element["elementKind"] == "p" for element in renderer_elements)
        renderer_element_count += len(renderer_elements)
        renderer_addressed_element_count += sum(element["addressable"] and bool(element["path"]) and not element["term"] and not element["disabled"] for element in renderer_elements)
        renderer_titled_element_count += sum(element["titled"] for element in renderer_elements)
        renderer_context_element_count += sum(bool(element["path"]) and not element["addressable"] for element in renderer_elements)
        renderer_sources.append({"title": title, "part": part, "url": record["url"], "bytes": record["bytes"], "sha256": record["sha256"], "currentThrough": record["currentThrough"]})
    parts: list[dict] = []
    sections: list[dict] = []
    appendices: list[dict] = []
    sources = []
    for key, record in sorted(capture["sources"].items(), key=lambda item: tuple(int(x) if x.isdigit() else -1 for x in item[0].split(":"))):
        title = int(record["title"])
        part = record["part"]
        raw = read_verified(capture_path(cache, title, part), record, f"source {key}")
        p, s, a = normalize_document(raw, title, mappings, graphics, rendered_by_title.get(title, {}))
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
        "scopePolicy": {
            "path": CFR_SCOPE_POLICY_PATH.relative_to(ROOT).as_posix(),
            "schemaVersion": CFR_SCOPE_POLICY["schemaVersion"],
            "reviewedAt": CFR_SCOPE_POLICY["reviewedAt"],
            "bytes": len(CFR_SCOPE_POLICY_BYTES),
            "sha256": sha256(CFR_SCOPE_POLICY_BYTES),
            "limitations": CFR_SCOPE_POLICY["limitations"],
        },
        "captureTime": capture["captureTime"],
        "ptar": {**capture["ptar"], "mappingCount": len(mappings)},
        "titleMetadata": capture["titleMetadata"],
        "currentThrough": capture["currentThrough"],
        "coverage": {"core": "Complete current Title 8 CFR", "titles": sorted({part["title"] for part in parts}), "partCount": len(parts), "sectionCount": len(sections), "appendixCount": len(appendices), "sectionCountsByTitle": title_counts},
        "sources": sources,
        "structureSources": renderer_sources,
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
    result["coverage"]["structureSourceCount"] = len(renderer_sources)
    result["coverage"]["structureRecordCount"] = renderer_record_count
    result["coverage"]["structureParagraphCount"] = renderer_paragraph_count
    result["coverage"]["structureElementCount"] = renderer_element_count
    result["coverage"]["structureAddressableElementCount"] = renderer_addressed_element_count
    result["coverage"]["structureTitledElementCount"] = renderer_titled_element_count
    result["coverage"]["structureContextElementCount"] = renderer_context_element_count
    output.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(result, ensure_ascii=False, separators=(",", ":"))
    output.write_text("/* Generated by tools/generate-cfr-corpus.py; do not hand edit. */\nwindow.INA_SEARCH_CFR = " + payload.replace("<", "\\u003c") + ";\n", encoding="utf-8")
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--refresh", action="store_true", help="Download and capture current official inputs.")
    mode.add_argument("--capture-renderers", action="store_true", help="Add same-date enhanced eCFR hierarchy evidence to an existing cache.")
    mode.add_argument("--from-cache", type=pathlib.Path, help="Regenerate without network access from a capture directory.")
    parser.add_argument("--ptar-year", type=int, default=2025)
    parser.add_argument("--cache", type=pathlib.Path, default=ROOT / "tmp" / "cfr-cache")
    parser.add_argument("--output", type=pathlib.Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()
    cache = args.cache if args.refresh or args.capture_renderers else args.from_cache
    if args.refresh:
        refresh(cache, args.ptar_year)
    elif args.capture_renderers:
        capture_renderers(cache)
    result = generate(cache, args.output)
    coverage = result["coverage"]
    print(f"Generated {args.output}: {coverage['partCount']} parts, {coverage['sectionCount']} sections, {coverage['appendixCount']} appendices, {coverage['embeddedGraphicsCount']}/{coverage['graphicsCount']} graphics embedded")
    if coverage["unavailableGraphics"]:
        print("Unavailable graphics: " + ", ".join(coverage["unavailableGraphics"]), file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
