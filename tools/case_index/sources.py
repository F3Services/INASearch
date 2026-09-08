"""Discover published EOIR precedent and USCIS adopted AAO decisions.

Only first-party government publication pages are accepted.  Discovery is
separate from PDF capture so a reviewed manifest can be diffed before a large,
resumable download begins.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import json
import re
import time
import urllib.parse
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from html.parser import HTMLParser
from pathlib import Path
from typing import Iterable


EOIR_INDEX_URL = "https://www.justice.gov/eoir/ag-bia-decisions"
EOIR_ALPHA_URLS = [
    "https://www.justice.gov/eoir/precedent-decision-alpha-a-e",
    "https://www.justice.gov/eoir/precedent-decision-alpha-f-j",
    "https://www.justice.gov/eoir/precedent-decision-alpha-k-o",
    "https://www.justice.gov/eoir/precedent-decision-alpha-p-t",
    "https://www.justice.gov/eoir/precedent-decision-alpha-u-z",
]
USCIS_ADOPTED_URL = (
    "https://www.uscis.gov/about-us/organization/directorates-and-program-offices/"
    "administrative-appeals-office-aao/adopted-aao-decisions"
)
USER_AGENT = "INASearch published-case source audit (contact: local research build)"

MOJIBAKE_REPLACEMENTS = {
    "Â§": "§", "Â¶": "¶", "Â": "",
    "â": "–", "â": "—", "â": "‘", "â": "’", "â": "“", "â": "”", "â¦": "…",
}


def clean_text(value: str) -> str:
    value = value.replace("\u200d", "").replace("\xa0", " ")
    for written, corrected in MOJIBAKE_REPLACEMENTS.items():
        value = value.replace(written, corrected)
    return re.sub(r"\s+", " ", value).strip()


def normalized_case_name(value: str) -> str:
    """Clean narrow catalog markup artifacts without losing written evidence."""
    name = clean_text(value).strip(" ,<>")
    return re.sub(r"\s*&\s*", " & ", name)


@dataclass(eq=False)
class Node:
    tag: str
    attrs: dict[str, str] = field(default_factory=dict)
    parent: "Node | None" = None
    children: list["Node | str"] = field(default_factory=list)

    def text(self) -> str:
        values: list[str] = []

        def visit(node: "Node | str") -> None:
            if isinstance(node, str):
                values.append(node)
            else:
                for child in node.children:
                    visit(child)

        visit(self)
        return clean_text(" ".join(values))

    def descendants(self, tag: str | None = None) -> Iterable["Node"]:
        for child in self.children:
            if isinstance(child, Node):
                if tag is None or child.tag == tag:
                    yield child
                yield from child.descendants(tag)


class TreeParser(HTMLParser):
    VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.root = Node("document")
        self.stack = [self.root]

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        node = Node(tag.lower(), {key: value or "" for key, value in attrs}, self.stack[-1])
        self.stack[-1].children.append(node)
        if node.tag not in self.VOID:
            self.stack.append(node)

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.handle_starttag(tag, attrs)
        if self.stack[-1].tag == tag.lower():
            self.stack.pop()

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        for index in range(len(self.stack) - 1, 0, -1):
            if self.stack[index].tag == tag:
                del self.stack[index:]
                return

    def handle_data(self, data: str) -> None:
        if data:
            self.stack[-1].children.append(data)


class Fetcher:
    """Polite, cache-aware first-party page fetcher."""

    def __init__(self, delay_seconds: float = 10.0) -> None:
        self.delay_seconds = max(0.0, delay_seconds)
        self.last_request_by_host: dict[str, float] = {}

    def fetch(self, url: str) -> tuple[bytes, str, dict[str, str]]:
        host = urllib.parse.urlparse(url).netloc.lower()
        last_error: Exception | None = None
        for attempt in range(1, 5):
            elapsed = time.monotonic() - self.last_request_by_host.get(host, 0.0)
            if elapsed < self.delay_seconds:
                time.sleep(self.delay_seconds - elapsed)
            request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "text/html,application/pdf"})
            try:
                with urllib.request.urlopen(request, timeout=180) as response:
                    value = response.read()
                    final_url = response.geturl()
                    headers = {key.lower(): val for key, val in response.headers.items()}
                self.last_request_by_host[host] = time.monotonic()
                return value, final_url, headers
            except (urllib.error.URLError, TimeoutError) as error:
                self.last_request_by_host[host] = time.monotonic()
                last_error = error
                if isinstance(error, urllib.error.HTTPError) and error.code not in {408, 425, 429, 500, 502, 503, 504}:
                    break
                if attempt < 4:
                    time.sleep(min(60, 2 ** attempt))
        assert last_error is not None
        raise last_error


def parse_html(value: bytes) -> Node:
    parser = TreeParser()
    parser.feed(value.decode("utf-8", errors="replace"))
    return parser.root


def absolute_url(base: str, href: str) -> str:
    joined = urllib.parse.urljoin(base, href)
    parsed = urllib.parse.urlsplit(joined)
    return urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, urllib.parse.quote(parsed.path, safe="/%:@"), parsed.query, parsed.fragment))


EOIR_CITATION = re.compile(
    r"^(?P<name>.+?),?\s*(?P<volume>\d{1,2})\s*I\s*&?\s*N(?:\s*Dec\.?)?\s*"
    # Older catalog HTML inconsistently omits the separator between the
    # deciding body and year (for example ``BIA1992``).  The year is still a
    # fixed four-digit suffix, so accepting optional whitespace is precise.
    r"(?P<page>\d+)\s*\((?P<body>[^()]*?)\s*(?P<year>\d{4})\)(?P<note>.*)$",
    re.IGNORECASE,
)
EOIR_CITATION_WITHOUT_HISTORY = re.compile(
    r"^(?P<name>.+?),?\s*(?P<volume>\d{1,2})\s*I\s*&?\s*N(?:\s*Dec\.?)?\s*"
    r"(?P<page>\d+)\s*(?P<note>.*)$",
    re.IGNORECASE,
)

# EOIR occasionally replaces an old volume-row citation with the citation of
# a later superseding case while leaving the old interim-decision PDF linked;
# several older HTML rows also contain scan/OCR damage in names or page numbers.
# Every override is anchored to the first-party PDF's printed caption, reporter
# page, or decision line; retain the anomalous listing text as evidence.
EOIR_LISTING_OVERRIDES = {
    1017: {
        "officialCitation": "8 I&N Dec. 369",
        "volume": 8,
        "reporterPage": 369,
        "overrideBasis": "EOIR interim decision 1017 PDF, printed page 369",
    },
    1200: {
        "caseName": 'PLANE "F-BHSQ"',
        "overrideBasis": "EOIR interim decision 1200 PDF, caption Matter of Plane F-BHSQ",
    },
    1411: {
        "caseName": "MARTINEZ-TORRES",
        "overrideBasis": "EOIR interim decision 1411 PDF, caption Matter of Martinez-Torres",
    },
    1563: {
        "caseName": "HALL",
        "overrideBasis": "EOIR interim decision 1563 PDF, caption Matter of Hall",
    },
    1768: {
        "caseName": "BECERRA-MIRANDA",
        "officialCitation": "12 I&N Dec. 358",
        "volume": 12,
        "reporterPage": 358,
        "decisionYear": 1967,
        "decidingBody": "BIA",
        "sourceStatus": "superseded",
        "overrideBasis": "EOIR interim decision 1768 PDF, printed page 358 and decision date Aug. 18, 1967",
    },
    1817: {
        "captureRequired": False,
        "sourceAvailability": "publisher-pdf-link-404",
        "availabilityVerifiedAt": "2026-08-30",
        "availabilityEvidence": "EOIR volume, alphabetical, and archived DHS/INS catalogs all point to the same missing first-party PDF",
    },
    1986: {
        "officialCitation": "13 I&N Dec. 316",
        "volume": 13,
        "reporterPage": 316,
        "decisionYear": 1969,
        "decidingBody": "REGIONAL COMMISSIONER",
        "overrideBasis": "EOIR interim decision 1986 PDF, printed page 316 and decision date July 23, 1969",
    },
    1989: {
        "caseName": "DEL ROSARIO",
        "overrideBasis": "EOIR interim decision 1989 PDF, caption Matter of Del Rosario",
    },
    2008: {
        "caseName": "VILANOVA-GONZALEZ",
        "officialCitation": "13 I&N Dec. 399",
        "volume": 13,
        "reporterPage": 399,
        "decisionYear": 1969,
        "decidingBody": "BIA",
        "sourceStatus": "superseded",
        "overrideBasis": "EOIR interim decision 2008 PDF, printed page 399 and decision date Oct. 17, 1969",
    },
    2009: {
        "captureRequired": False,
        "sourceAvailability": "publisher-pdf-link-404",
        "availabilityVerifiedAt": "2026-08-30",
        "availabilityEvidence": "EOIR volume, alphabetical, and archived DHS/INS catalogs all point to the same missing first-party PDF",
    },
    2381: {
        "officialCitation": "15 I&N Dec. 297", "volume": 15, "reporterPage": 297, "decisionYear": 1975, "decidingBody": "BIA",
        "overrideBasis": "EOIR interim decision 2381 PDF, printed page 297",
    },
    2409: {
        "officialCitation": "15 I&N Dec. 392", "volume": 15, "reporterPage": 392, "decisionYear": 1975, "decidingBody": "BIA",
        "overrideBasis": "EOIR interim decision 2409 PDF, printed page 392",
    },
    2436: {
        "officialCitation": "15 I&N Dec. 469", "volume": 15, "reporterPage": 469, "decisionYear": 1975, "decidingBody": "BIA",
        "overrideBasis": "EOIR interim decision 2436 PDF, printed page 469",
    },
    2606: {
        "captureRequired": False,
        "sourceAvailability": "publisher-pdf-link-404",
        "availabilityVerifiedAt": "2026-08-30",
        "availabilityEvidence": "EOIR volume and alphabetical catalogs point to the same missing first-party PDF",
    },
    3304: {
        "caseName": 'VARIG BRAZILIAN AIRLINES "FLIGHT NO. 830"',
        "overrideBasis": "EOIR interim decision 3304 PDF, caption In re Varig Brazilian Airlines Flight No. 830",
    },
    3315: {
        "caseName": 'AIR INDIA "FLIGHT NO. 101"',
        "overrideBasis": "EOIR interim decision 3315 PDF, caption In re Air India Flight No. 101",
    },
    3321: {
        "caseName": "BATISTA-HERNANDEZ",
        "overrideBasis": "EOIR interim decision 3321 PDF, caption In re Juan Batista-Hernandez",
    },
    3330: {
        "officialCitation": "21 I&N Dec. 1041", "volume": 21, "reporterPage": 1041, "decisionYear": 1997, "decidingBody": "BIA",
        "overrideBasis": "EOIR interim decision 3330 PDF, printed citation and decision date October 31, 1997",
    },
    3417: {
        "caseName": "ADENIJI",
        "overrideBasis": "EOIR interim decision 3417 PDF, caption In re Adewunmi Adeniji",
    },
    3473: {
        "caseName": "YANEZ-GARCIA",
        "overrideBasis": "EOIR interim decision 3473 PDF, caption In re Ismael Yanez-Garcia",
    },
    3489: {
        "officialCitation": "23 I&N Dec. 586", "volume": 23, "reporterPage": 586, "decisionYear": 2003, "decidingBody": "BIA",
        "overrideBasis": "EOIR interim decision 3489 PDF, printed citation 23 I&N Dec. 586 (BIA 2003)",
    },
    3500: {
        "officialCitation": "23 I&N Dec. 668", "volume": 23, "reporterPage": 668, "decisionYear": 2004, "decidingBody": "BIA",
        "overrideBasis": "EOIR interim decision 3500 PDF, printed citation and decision date September 1, 2004",
    },
    3505: {
        "caseName": "AZURIN",
        "overrideBasis": "EOIR interim decision 3505 PDF, caption In re Greg Fabian Azurin",
    },
    3538: {
        "caseName": "O’CEALLEAGH",
        "overrideBasis": "EOIR interim decision 3538 PDF, caption In re Sean O’Cealleagh",
    },
    3890: {
        "caseName": "CHAIREZ-CASTREJON",
        "overrideBasis": "EOIR interim decision 3890 PDF, caption Matter of Martin Chairez-Castrejon",
    },
    3963: {
        "caseName": "J-G-P-",
        "overrideBasis": "EOIR interim decision 3963 PDF, caption Matter of J-G-P-",
    },
    4080: {
        "caseName": "THAKKER",
        "overrideBasis": "EOIR interim decision 4080 PDF, caption Matter of Bharatkumar Girishkumar Thakker",
    },
    4081: {
        "caseName": "KHAN",
        "overrideBasis": "EOIR interim decision 4081 PDF, caption Matter of Nasir Ali Khan",
    },
    4086: {
        "caseName": "DE JESUS-PLATON",
        "overrideBasis": "EOIR interim decision 4086 PDF, caption Matter of Leobardo De Jesus-Platon",
    },
}


def _ancestor(node: Node, tag: str) -> Node | None:
    current: Node | None = node
    while current:
        if current.tag == tag:
            return current
        current = current.parent
    return None


def _following_headnotes(table: Node) -> list[str]:
    if not table.parent:
        return []
    try:
        start = table.parent.children.index(table) + 1
    except ValueError:
        return []
    notes: list[str] = []
    for sibling in table.parent.children[start:]:
        if isinstance(sibling, str):
            continue
        if sibling.tag in {"table", "hr"}:
            break
        if sibling.tag == "p":
            text = sibling.text()
            if text:
                notes.append(text)
    return notes


def normalized_deciding_body(value: str) -> str:
    written = clean_text(value).upper()
    compact = re.sub(r"[^A-Z0-9]+", "", written)
    aliases = {
        "AG": "AG", "ATTORNEYGENERAL": "AG",
        "BIA": "BIA", "BIADEC": "BIA", "AAO": "AAO",
        "RC": "REGIONAL COMMISSIONER", "REGCOMM": "REGIONAL COMMISSIONER", "REGIONALCOMMISSIONER": "REGIONAL COMMISSIONER",
        "ACTINGRC": "ACTING REGIONAL COMMISSIONER", "ACTINGREGCOMM": "ACTING REGIONAL COMMISSIONER",
        "AC": "ASSISTANT COMMISSIONER", "ASSTCOMM": "ASSISTANT COMMISSIONER", "ASSITCOMM": "ASSISTANT COMMISSIONER",
        "ACTINGAC": "ACTING ASSISTANT COMMISSIONER", "DEPUTYAC": "DEPUTY ASSISTANT COMMISSIONER", "DEPTUYAC": "DEPUTY ASSISTANT COMMISSIONER",
        "COMM": "COMMISSIONER", "COMMISSIONER": "COMMISSIONER",
        "DD": "DISTRICT DIRECTOR", "ACTINGDD": "ACTING DISTRICT DIRECTOR",
        "DIR": "DIRECTOR", "OIC": "OFFICER IN CHARGE",
    }
    return aliases.get(compact, written.rstrip(";"))


def decision_history(parenthetical: str) -> list[dict]:
    results = []
    for member in parenthetical.split(";"):
        match = re.match(r"\s*(.*?)\s*(\d{4})\s*$", member)
        if not match:
            continue
        written = clean_text(match.group(1))
        body = normalized_deciding_body(written) if written else (results[-1]["body"] if results else "")
        results.append({"body": body, "bodyWritten": written, "year": int(match.group(2))})
    return results


def eoir_listing_status(citation_text: str) -> str:
    """Promote EOIR's explicit catalog qualifications into case metadata.

    The alphabetical and volume listings append short treatment notes to a
    small number of citations.  Preserve partial qualifications separately
    from complete negative dispositions: a modified or partly overruled case
    cannot safely be represented as either simply current or simply invalid.
    """
    status_patterns = (
        ("overruled-in-part", r"\boverruled\s+in\s+part\b"),
        ("overruled", r"\boverruled\b"),
        ("superseded", r"\bsuperseded\b"),
        ("vacated", r"\bvacated\b"),
        ("withdrawn", r"\bwithdrawn\b"),
        ("modified", r"\bmodified\b"),
    )
    for status, pattern in status_patterns:
        if re.search(pattern, citation_text, re.IGNORECASE):
            return status
    return "published"


def eoir_listing_treatment(note: str | None, status: str) -> dict | None:
    """Structure EOIR's terse catalog treatment note without interpreting scope.

    The catalog usually gives only a treatment word and the later reporter
    citation.  That is enough for a high-confidence directed edge, but not for
    identifying the exact proposition affected; the written note is therefore
    retained as the evidence.
    """
    if not note or status == "published":
        return None
    citation = re.search(
        r"(?P<volume>\d{1,2})\s*I\s*&?\s*N(?:\s+Dec\.?)?\s*(?P<page>\d+)",
        note,
        re.IGNORECASE,
    )
    if not citation:
        return None
    name = re.search(
        r"Matter\s+of\s+(?P<name>.+?)(?=,?\s*\d{1,2}\s*I\s*&?\s*N)",
        note,
        re.IGNORECASE,
    )
    return {
        "treatment": status,
        "treatingCaseName": clean_text(name.group("name")).strip(" ,") if name else None,
        "treatingCaseCitation": f"{citation.group('volume')} I&N Dec. {citation.group('page')}",
        "evidence": note,
        "sourceTier": "official-publisher-catalog-status",
        "confidence": 1.0,
    }


def parse_eoir_volume(value: bytes, page_url: str, volume_hint: int | None) -> list[dict]:
    root = parse_html(value)
    results: list[dict] = []
    seen_ids: set[int] = set()
    unparsed_pdf_ids: set[int] = set()
    for anchor in root.descendants("a"):
        anchor_text = anchor.text()
        table = _ancestor(anchor, "table")
        row = _ancestor(anchor, "tr")
        anchor_cell = _ancestor(anchor, "td")
        if not table:
            continue
        record_text = row.text() if row else table.text()
        identifier_match = re.search(r"\bID\s*(\d{3,5})\b", anchor_text, re.IGNORECASE)
        numeric_anchor = re.fullmatch(r"0*(\d{3,5})", anchor_text.strip())
        numeric_id_anchor = (
            numeric_anchor and anchor_cell
            and re.search(r"\bID\s*0*" + re.escape(numeric_anchor.group(1)) + r"\b", anchor_cell.text(), re.IGNORECASE)
        )
        numeric_pdf_anchor = numeric_anchor and anchor_cell and re.search(r"\(PDF\)", anchor_cell.text(), re.IGNORECASE)
        if not identifier_match and not numeric_pdf_anchor:
            continue
        identifier = int((identifier_match or numeric_anchor).group(1))
        if identifier in seen_ids:
            continue
        href = anchor.attrs.get("href", "")
        if not href or not ("pdf" in href.lower() or "/dl" in href.lower() or "/download" in href.lower()):
            # In the `ID <a>4097</a>` variant the anchor itself is the PDF, so
            # accept a numeric anchor when its table explicitly labels it ID.
            if not (anchor_text.strip().isdigit() and re.search(r"\bID\s*" + re.escape(anchor_text.strip()), record_text, re.IGNORECASE)):
                continue
        href_identifier = re.search(r"/intdec/vol\d+/0*(\d{3,5})\.pdf(?:$|[?#])", href, re.IGNORECASE)
        if href_identifier:
            identifier = int(href_identifier.group(1))
        cells = [child for child in (row.children if row else []) if isinstance(child, Node) and child.tag in {"td", "th"}]
        citation_text = cells[0].text() if cells else re.sub(r"\bID\s*\d{3,5}\b.*$", "", record_text, flags=re.IGNORECASE).strip(" ,")
        citation = EOIR_CITATION.match(citation_text) or EOIR_CITATION_WITHOUT_HISTORY.match(citation_text)
        if not citation:
            if identifier_match or numeric_id_anchor:
                unparsed_pdf_ids.add(identifier)
            continue
        volume = int(citation.group("volume"))
        override = EOIR_LISTING_OVERRIDES.get(identifier)
        volume_mismatch = volume_hint is not None and volume != volume_hint
        year_written = citation.groupdict().get("year")
        body_written = clean_text(citation.groupdict().get("body") or "")
        parenthetical = f"{body_written} {year_written}" if year_written else ""
        history = decision_history(parenthetical) if parenthetical else []
        body = history[-1]["body"] if history else (normalized_deciding_body(body_written) or None)
        note = clean_text(citation.group("note")).strip("() ")
        source_status = eoir_listing_status(citation_text)
        case_name_written = re.sub(
            r",?\s*\d{1,2}\s*I\s*&?\s*N(?:\s+Dec\.?)?.*$", "",
            clean_text(citation.group("name")), flags=re.IGNORECASE,
        ).strip(" ,")
        case_name = normalized_case_name(case_name_written)
        record = {
            "schemaVersion": 1,
            "corpusKey": f"eoir-{identifier}",
            "sourceCollection": "eoir-precedent-volumes",
            "publicationStatus": "published-precedent",
            "precedential": True,
            "sourceStatus": source_status,
            "caseName": case_name,
            "officialCitation": f"{volume} I&N Dec. {citation.group('page')}",
            "volume": volume,
            "reporterPage": int(citation.group("page")),
            "decisionYear": int(year_written) if year_written else None,
            "decidingBody": body,
            "decidingBodies": list(dict.fromkeys(item["body"] for item in history)) or ([body] if body else []),
            "decisionHistory": history,
            "publicationNote": note or None,
            "eoirId": identifier,
            "headnotes": _following_headnotes(table),
            "landingPageUrl": page_url,
            "pdfUrl": absolute_url(page_url, href),
        }
        if case_name != case_name_written:
            record["caseNameWritten"] = case_name_written
            record["caseNameNormalization"] = "catalog-markup-and-spacing-only"
        publisher_treatment = eoir_listing_treatment(note, source_status)
        if publisher_treatment:
            record["publisherTreatment"] = publisher_treatment
        override_differs = bool(override) and any(
            record.get(field) != override.get(field)
            for field in ("caseName", "officialCitation", "volume", "reporterPage", "decisionYear", "decidingBody")
            if field in override
        )
        if volume_mismatch or override_differs:
            record["anomalousListingCitation"] = citation_text
            record["citationNeedsPdfReview"] = not bool(override)
        if override:
            record.update(override)
            record["decidingBodies"] = [record["decidingBody"]]
            record["decisionHistory"] = [{"body": record["decidingBody"], "bodyWritten": record["decidingBody"], "year": record["decisionYear"]}]
            record["citationNeedsPdfReview"] = False
        results.append(record)
        seen_ids.add(identifier)
        unparsed_pdf_ids.discard(identifier)
    if unparsed_pdf_ids:
        listed = ", ".join(str(identifier) for identifier in sorted(unparsed_pdf_ids))
        location = f"volume {volume_hint}" if volume_hint is not None else page_url
        raise RuntimeError(f"Unparsed EOIR published-decision entries on {location}: {listed}")
    return results


def discover_eoir(fetcher: Fetcher) -> tuple[list[dict], list[dict]]:
    value, final_url, headers = fetcher.fetch(EOIR_INDEX_URL)
    root = parse_html(value)
    volumes: dict[int, str] = {}
    for anchor in root.descendants("a"):
        match = re.match(r"^Volume\s+(\d{1,2})\b", anchor.text(), re.IGNORECASE)
        href = anchor.attrs.get("href", "")
        if match and href:
            volume = int(match.group(1))
            if 8 <= volume <= 99:
                volumes[volume] = absolute_url(final_url, href)
    if not all(volume in volumes for volume in range(8, 30)):
        missing = [str(volume) for volume in range(8, 30) if volume not in volumes]
        raise RuntimeError(f"EOIR master page is missing expected electronic volumes: {', '.join(missing)}")
    records: list[dict] = []
    pages = [{
        "url": final_url,
        "requestedUrl": EOIR_INDEX_URL,
        "sha256": hashlib.sha256(value).hexdigest(),
        "bytes": len(value),
        "etag": headers.get("etag"),
        "lastModified": headers.get("last-modified"),
    }]
    for volume, url in sorted(volumes.items()):
        page, page_final, page_headers = fetcher.fetch(url)
        page_records = parse_eoir_volume(page, page_final, volume)
        if not page_records:
            raise RuntimeError(f"No published decisions found on EOIR volume {volume}: {page_final}")
        records.extend(page_records)
        pages.append({
            "url": page_final,
            "requestedUrl": url,
            "sha256": hashlib.sha256(page).hexdigest(),
            "bytes": len(page),
            "etag": page_headers.get("etag"),
            "lastModified": page_headers.get("last-modified"),
            "volume": volume,
            "decisionCount": len(page_records),
        })
    volume_by_id = {record["eoirId"]: record for record in records}
    alpha_additions = 0
    for url in EOIR_ALPHA_URLS:
        page, page_final, page_headers = fetcher.fetch(url)
        page_records = parse_eoir_volume(page, page_final, None)
        if not page_records:
            raise RuntimeError(f"No published decisions found on EOIR alphabetical page: {page_final}")
        for record in page_records:
            existing = volume_by_id.get(record["eoirId"])
            if existing:
                existing.setdefault("alternateCatalogPages", []).append(page_final)
                if existing.get("decidingBody") is None and record.get("decidingBody"):
                    existing["decidingBody"] = record["decidingBody"]
                    existing["decidingBodies"] = record["decidingBodies"]
                    existing["decisionHistory"] = record["decisionHistory"]
                if existing.get("decisionYear") is None and record.get("decisionYear"):
                    existing["decisionYear"] = record["decisionYear"]
                if (
                    existing.get("officialCitation") != record.get("officialCitation")
                    or clean_text(existing.get("caseName", "")).upper() != clean_text(record.get("caseName", "")).upper()
                ):
                    existing.setdefault("catalogConflicts", []).append({
                        "source": page_final,
                        "caseName": record.get("caseName"),
                        "officialCitation": record.get("officialCitation"),
                        "pdfUrl": record.get("pdfUrl"),
                    })
                continue
            record["catalogFallback"] = "official-alphabetical-listing"
            volume_by_id[record["eoirId"]] = record
            alpha_additions += 1
        pages.append({
            "url": page_final,
            "requestedUrl": url,
            "sha256": hashlib.sha256(page).hexdigest(),
            "bytes": len(page),
            "etag": page_headers.get("etag"),
            "lastModified": page_headers.get("last-modified"),
            "catalog": "alphabetical",
            "decisionCount": len(page_records),
        })
    records = sorted(volume_by_id.values(), key=lambda record: record["eoirId"])
    if alpha_additions:
        pages[0]["alphabeticalFallbackAdditions"] = alpha_additions
    return records, pages


AAO_CITATION = re.compile(
    r"(?P<name>Matter of .+?),?\s*Adopted Decision\s+(?P<identifier>[\d-]+)\s*"
    r"\(AAO\s+(?P<date>[^)]+)\)", re.IGNORECASE,
)


def parse_uscis_adopted(value: bytes, page_url: str) -> list[dict]:
    root = parse_html(value)
    results: list[dict] = []
    for list_node in root.descendants("ul"):
        parent = list_node.parent
        if not parent:
            continue
        try:
            position = parent.children.index(list_node)
        except ValueError:
            continue
        preceding = " ".join(
            child.text() for child in parent.children[max(0, position - 4):position]
            if isinstance(child, Node) and child.tag == "p"
        ).lower()
        if "adopted" not in preceding:
            continue
        previous = "previous adopted" in preceding or "now superseded" in preceding
        for item in (child for child in list_node.children if isinstance(child, Node) and child.tag == "li"):
            text = item.text()
            match = AAO_CITATION.search(text)
            anchors = list(item.descendants("a"))
            if not match or not anchors:
                continue
            href = anchors[0].attrs.get("href", "")
            if not href:
                continue
            identifier = match.group("identifier")
            tail = clean_text(text[match.end():]).strip(" ,")
            status = "current"
            if previous:
                status = "overruled" if re.search(r"\boverruled\b", tail, re.IGNORECASE) else "superseded"
            results.append({
                "schemaVersion": 1,
                "corpusKey": f"uscis-adopted-{identifier}",
                "sourceCollection": "uscis-adopted-aao",
                "publicationStatus": "adopted-policy",
                "precedential": True,
                "sourceStatus": status,
                "caseName": clean_text(match.group("name")),
                "officialCitation": f"Adopted Decision {identifier}",
                "adoptedDecisionId": identifier,
                "decisionDateWritten": clean_text(match.group("date")),
                "decidingBody": "AAO",
                "headnotes": [],
                "sourceStatusStatement": tail or None,
                "landingPageUrl": page_url,
                "pdfUrl": absolute_url(page_url, href),
            })
    unique = {record["corpusKey"]: record for record in results}
    return sorted(unique.values(), key=lambda item: item["adoptedDecisionId"], reverse=True)


def discover_uscis(fetcher: Fetcher) -> tuple[list[dict], dict]:
    value, final_url, headers = fetcher.fetch(USCIS_ADOPTED_URL)
    records = parse_uscis_adopted(value, final_url)
    if len(records) < 20:
        raise RuntimeError(f"USCIS adopted-decision page yielded only {len(records)} decisions")
    page = {
        "url": final_url,
        "requestedUrl": USCIS_ADOPTED_URL,
        "sha256": hashlib.sha256(value).hexdigest(),
        "bytes": len(value),
        "etag": headers.get("etag"),
        "lastModified": headers.get("last-modified"),
        "decisionCount": len(records),
    }
    return records, page


def write_discovery(root: Path, records: list[dict], source_pages: list[dict]) -> None:
    root.mkdir(parents=True, exist_ok=True)
    manifest_path = root / "manifest.jsonl"
    manifest_path.write_text("".join(json.dumps(record, ensure_ascii=False, sort_keys=True) + "\n" for record in records), encoding="utf-8")
    eoir_ids = sorted(record["eoirId"] for record in records if isinstance(record.get("eoirId"), int))
    unlisted_ids = (
        [identifier for identifier in range(eoir_ids[0], eoir_ids[-1] + 1) if identifier not in set(eoir_ids)]
        if eoir_ids else []
    )
    metadata = {
        "schemaVersion": 1,
        "capturedAt": dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat(),
        "recordCount": len(records),
        "collections": {
            key: sum(record["sourceCollection"] == key for record in records)
            for key in sorted({record["sourceCollection"] for record in records})
        },
        "sourcePages": source_pages,
        "catalogDiagnostics": {
            "eoirIdRange": [eoir_ids[0], eoir_ids[-1]] if eoir_ids else None,
            "unlistedInterimDecisionIds": unlisted_ids,
            "note": "Interim-decision identifiers are not assumed contiguous. These IDs were not published as case entries on either the authoritative volume or alphabetical pages at capture time.",
        },
        "scope": {
            "included": ["EOIR electronic published precedent volumes 8-present", "USCIS current and prior adopted AAO decisions"],
            "excluded": ["AAO non-precedent decisions", "unpublished BIA decisions"],
            "knownGap": "EOIR does not expose volumes 1-7 as case-level PDFs from its current electronic volume index.",
        },
    }
    (root / "discovery.json").write_text(json.dumps(metadata, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
