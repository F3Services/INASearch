#!/usr/bin/env python3
"""Reproduce reviewed former Title 8 naturalization amendments from scans."""
import hashlib
import json
import re
from pathlib import Path
import fitz

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "sources/legal"
ACT50 = "sources/legal/raw/historical-usc/statutes/STATUTE-64-Pg987.pdf"
CODE46 = "sources/legal/raw/historical-usc/loc/1946/chapter-11.pdf"
rows = json.loads((DATA / "historical-usc.json").read_text())
SECTIONS_BY_NUMBER = {s["section"]: s for s in [*rows["singles"], *[m for g in rows["groups"] for m in g["members"]]]}
CAPTURES = {r["file"]: r for r in rows["sources"]}
CAPTURES.update({r["file"]: r for r in json.loads((DATA / "raw/historical-usc/naturalization-captures.json").read_text())})
REVIEWED = []


def normalize(value):
    value = re.sub(r"(?<=\w)-\s*\n(?=\w)", "", value)
    return re.sub(r"\s+", " ", value).strip()


def page_text(file, pages):
    with fitz.open(ROOT / file) as document:
        return "\n".join(
            block[4] for page in pages for block in document[page-1].get_text("blocks")
            if block[2] - block[0] > 270 and block[1] > 70
            and not re.search(r"PUBLIC LAWS|81st\s+CONG|^AMENDING", block[4])
        )


def capture(file):
    raw = (ROOT / file).read_bytes()
    source = CAPTURES[file]
    return {"file": file, "url": source.get("url", source.get("source")),
            "bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest(), "capturedAt": "2026-10-11"}


def split_quoted_units(value):
    # Only the printed paragraph starts are structural. Inline enumerations
    # stay within their parent paragraph, where the regular run-in index works.
    value = value.strip().removesuffix("”")
    markers = list(re.finditer(r"(?:^“?|\n[ \t]*“[ \t]*)\(([a-z]|\d+)\)\s+", value))
    units = []
    if markers and value[:markers[0].start()].strip():
        units.append({"path": [], "text": normalize(value[:markers[0].start()])})
    parent = None
    for index, marker in enumerate(markers):
        label = marker[1]
        if label.isalpha():
            parent = label
            path = [label]
        else:
            path = ([parent] if parent else []) + [label]
        text = normalize(value[marker.end():markers[index+1].start() if index+1 < len(markers) else len(value)])
        units.append({"path": path, "text": text.replace("wTith", "with")})
    return units


def add(number, units, pages, act_section, statute_pages):
    source = capture(ACT50)
    heading = SECTIONS_BY_NUMBER[number]["heading"]
    record = {"uscSection": number, "originalTitle": heading, "units": units,
              "sourceUrl": source["url"] + f"#page={pages[0]}", "sourceArtifact": ACT50,
              "sourceSha256": source["sha256"], "sourceCapturedAt": source["capturedAt"],
              "sourcePdfPages": pages, "lastAmendmentDate": "1950-09-23",
              "versionLabel": f"Full replacement enacted September 23, 1950, section {act_section}, 64 Stat. {statute_pages}",
              "reviewStatus": "visually-reviewed", "headingOrigin": "editorial-description",
              "headingEvidence": "Descriptive heading derived from the former Code caption; the enacted replacement has no separate catchline.",
              "transcriptionNote": "Compared with the official printed pages. Original Act section references are retained. Quotation marks surrounding the amendment, running page headings, margin annotations, and print line breaks are omitted; the OCR artifact ‘wTith’ is corrected to ‘with’."}
    record["unitsSha256"] = hashlib.sha256(json.dumps(units, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()
    REVIEWED.append(record)


for number, act_number, next_boundary, pages, amender, statute_pages in [
    ("705", "305", "Sec . 26.", [27, 28, 29], "25", "1013–1015"),
    ("725", "325", "Sec . 27.", [29], "26", "1015"),
    ("733", "333", "(b) Section 334", [30, 31], "28(a)", "1016–1017"),
    ("735", "335", "Sec . 30.", [31, 32], "29", "1017–1018"),
    ("704", "304", "Sec . 31.", [32], "30", "1018"),
]:
    raw = page_text(ACT50, pages)
    raw = raw.split("“Sec . " + act_number + ".", 1)[1].split(next_boundary, 1)[0].strip()
    units = split_quoted_units(raw)
    if number == "705":
        last = next(unit for unit in units if unit["path"] == ["d", "2"])
        last["text"], continuation = last["text"].split(" it shall be considered prima facie evidence", 1)
        next(unit for unit in units if unit["path"] == ["d"])["continuation"] = "it shall be considered prima facie evidence" + continuation
        assert [u["path"] for u in units] == [["a"], *[["a",str(i)] for i in range(1,7)], ["b"], ["c"], ["d"], ["d","1"], ["d","2"], ["e"]]
    assert units and all(unit["text"] for unit in units)
    add(number, units, pages, amender, statute_pages)

def base(number):
    section = SECTIONS_BY_NUMBER[number]
    assert section["historical"]["sourceArtifact"] == CODE46
    return section["body"][0]["text"]


def code_units(value):
    # Preserve paragraph boundaries established by the printed Code, not
    # parenthesized references occurring inside a sentence.
    value = re.sub(r"(?m)^\(([a-z]|\d+)\)", r"“(\1)", value)
    return split_quoted_units(value)


def replacement(file, start, end, pages=[1]):
    return normalize(page_text(file, pages).split(start, 1)[1].split(end, 1)[0].strip().removesuffix("”"))


def add_composed(number, units, pages, last, amendments, note, title=None):
    source = capture(CODE46)
    record = {"uscSection": number, "originalTitle": title or SECTIONS_BY_NUMBER[number]["heading"],
              "units": units, "sourceUrl": source["url"] + f"#page={pages[0]}",
              "sourceArtifact": CODE46, "sourceSha256": source["sha256"],
              "sourceCapturedAt": source["capturedAt"], "sourcePdfPages": pages,
              "lastAmendmentDate": last, "versionLabel": f"1946 Code text incorporating the cited amendments through {last}",
              "reviewStatus": "visually-reviewed", "headingOrigin": "editorial-description",
              "headingEvidence": "Descriptive heading based on the former Code caption and the cited subsequent changes.",
              "amendmentSources": [{**capture(file), "label": label} for file, label in amendments],
              "historicalEditorialNote": note,
              "transcriptionNote": "Compared with the official Code and amending-act page images. Print wrapping and form blank lengths are normalized; apparent OCR spelling and punctuation errors are corrected. Code references in unchanged text and Act references in enacted replacements are preserved as printed."}
    record["unitsSha256"] = hashlib.sha256(json.dumps(units, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()
    REVIEWED.append(record)


F47PHOTO = "sources/legal/raw/historical-usc/statutes/STATUTE-61-Pg97.pdf"
F47SICK = "sources/legal/raw/historical-usc/statutes/STATUTE-61-Pg121.pdf"
F47CERT = "sources/legal/raw/historical-usc/statutes/STATUTE-61-Pg414.pdf"
F47FEES = "sources/legal/raw/historical-usc/statutes/STATUTE-61-Pg240.pdf"
F48PETITION = "sources/legal/raw/historical-usc/statutes/STATUTE-62-Pg1026.pdf"
F50GUAM = "sources/legal/raw/historical-usc/statutes/STATUTE-64-Pg384-link.pdf"
F51VOTE = "sources/legal/raw/historical-usc/statutes/STATUTE-65-Pg191.pdf"

units = code_units(base("703").replace("only to-", "only to—"))
units.insert(-1, {"path": ["a", "5"], "text": "Guamanian persons and persons of Guamanian descent."})
add_composed("703", units, [5], "1950-08-01", [(F50GUAM, "Organic Act of Guam, section 4(b), 64 Stat. 385")],
             "The 1950 Act added paragraph (a)(5); the other paragraphs remain as printed in the 1946 Code.")

body = base("723").split(" A person who, while a citizen of the United States and prior to August 7, 1946", 1)[0].replace("milltary", "military")
assert body.endswith("the Department of State and to the Department of Justice.")
add_composed("723", [{"path": [], "text": body}], [12], "1951-08-16", [(F51VOTE, "Act of August 16, 1951, section 2, 65 Stat. 191")],
             "The 1946 Code includes a second paragraph added by the Act of August 7, 1946 for former citizens who voted abroad. Section 2 of the 1951 Act repealed that 1946 Act. The displayed text retains the military-service paragraph and omits the repealed added paragraph. The 1951 Act's separate Italian-election naturalization provision is not inserted into this section.",
             title="Former United States citizens losing citizenship by entering armed forces of nonenemy countries during World Wars I or II")

body = base("727")
for wrong, right in {"subehapter": "subchapter", "training In citizenship responsibillties": "training in citizenship responsibilities", "as ac certificate": "as a certificate"}.items():
    assert wrong in body
    body = body.replace(wrong, right)
units = code_units(body)
units[-1]["text"] = replacement(F47PHOTO, "“Sec . 327. (h)", "Approved May 16")
assert units[-1]["path"] == ["h"] and units[-1]["text"].endswith("supervision of the Commissioner.")
add_composed("727", units, [15], "1947-05-16", [(F47PHOTO, "Act of May 16, 1947, 61 Stat. 97")], "The 1947 Act replaced subsection (h); subsections (a)–(g) retain the 1946 Code wording.")

body = base("729")
for wrong, right in {"Intention": "intention", "shall lave": "shall have", "arTival": "arrival", "shall beie duty": "shall be the duty"}.items():
    assert wrong in body
    body = body.replace(wrong, right)
units = code_units(body)
units.append({"path": ["c"], "text": replacement(ACT50, "“(c) Except as otherwise", "Sec . 28.", [29,30])})
units[-1]["text"] = "Except as otherwise " + units[-1]["text"]
add_composed("729", units, [16], "1950-09-23", [(ACT50, "Act of September 23, 1950, section 27, 64 Stat. 1015")], "The 1950 Act added subsection (c); subsections (a) and (b) retain the 1946 Code wording.")

units = code_units(base("734"))
units[0]["text"] = replacement(F47SICK, "“Sec . 334. (a)", "(b) Section 334", [2])
units[1]["text"] = replacement(ACT50, "“(b) The requirement", "Sec . 29.", [31])
units[1]["text"] = "The requirement " + units[1]["text"]
units[3]["text"] = units[3]["text"].replace("beore aiy", "before any").replace("naturalization -proceedings", "naturalization proceedings")
assert [u["path"] for u in units] == [[x] for x in "abcde"]
add_composed("734", units, [19], "1950-09-23", [(F47SICK, "Act of May 31, 1947, section 3(a), 61 Stat. 122"), (ACT50, "Act of September 23, 1950, section 28(b), 64 Stat. 1017")], "Subsection (a) is the 1947 replacement, subsection (b) is the 1950 replacement, and subsections (c)–(e) retain the 1946 Code wording.")

body = replacement(F47CERT, "“Sec . 339.", "Approved July 23") + " Upon proof" + base("739").split(" Upon proof", 1)[1]
add_composed("739", [{"path": [], "text": body}], [21,22], "1947-07-23", [(F47CERT, "Act of July 23, 1947, section 2, 61 Stat. 414")], "The 1947 Act replaced the first sentence. The remaining certificate procedure retains the 1946 Code wording.")

body = base("742").replace("fees: (1)", "fees:\n\n(1)").replace("States. (h)", "States.\n\n(h)")
for wrong, right in {"receiving and .filing": "receiving and filing", "for land pay": "for and pay", "accounts. which": "accounts, which", "thi# chapter": "this chapter", "clerks In naturalization": "clerks in naturalization", "Commissioner In the Treasury": "Commissioner in the Treasury", "proceedings In which": "proceedings in which", "reasonable fee In excess": "reasonable fee in excess", "flling a petition": "filing a petition"}.items():
    assert wrong in body
    body = body.replace(wrong, right)
units = code_units(body)
eight = next(u for u in units if u["path"] == ["b", "8"])
_, continuation = eight["text"].split(" Notwithstanding the preceding", 1)
eight["text"] = replacement(F47FEES, "“(8)", "Approved July 1").replace("General,,", "General,")
next(u for u in units if u["path"] == ["b"])["continuation"] = "Notwithstanding the preceding" + continuation
assert "minimum fee of 50 cents" in eight["text"]
assert [u["path"] for u in units][-3:] == [["h"],["i"],["j"]]
add_composed("742", units, [22,23], "1947-07-01", [(F47FEES, "Act of July 1, 1947, 61 Stat. 240")], "The 1947 Act corrected paragraph (b)(8), including changing the 50-cent fee from a maximum to a minimum. The unnumbered veterans' exemption remains the continuation of subsection (b). Other provisions retain the 1946 Code wording.")


def form_blanks(value):
    """Normalize printed form rules while retaining the surrounding words."""
    value = normalize(value)
    value = re.sub(r"_+", "____", value)
    value = re.sub(r"(?<![A-Za-z0-9])-+(?![A-Za-z0-9])", "____", value)
    value = value.replace("on- (month", "on ____ (month").replace("from _(", "from ____(")
    value = value.replace("I am years old", "I am ____ years old")
    value = value.replace("height feet inches", "height ____ feet ____ inches")
    value = value.replace("weight pounds", "weight ____ pounds")
    value = value.replace("I am married", "I am ____ married")
    value = value.replace("I have children", "I have ____ children")
    value = value.replace("under the name of on", "under the name of ____, on")
    value = value.replace("under the name of , on", "under the name of ____, on")
    value = value.replace("my name be changed to .", "my name be changed to ____.")
    value = value.replace("at 'least", "at least")
    value = value.replace("Unitea btates", "United States")
    value = value.replace("t heearing", "the hearing")
    value = value.replace("disbelief In", "disbelief in")
    value = value.replace("arrival In", "arrival in")
    value = value.replace("declaration of Intention", "declaration of intention")
    value = value.replace("It Is my intention", "It is my intention")
    value = value.replace("the same Is true", "the same is true")

    value = value.replace("I. petitioner", "I, petitioner")
    value = re.sub(r" {2,}", " ", value)
    return value.strip()


def form_numbered(value, parent, count):
    markers = list(re.finditer(r"\((\d{1,2})\)\s+", value))
    assert [int(m[1]) for m in markers] == list(range(1, count + 1))
    result = []
    for i, marker in enumerate(markers):
        end = markers[i + 1].start() if i + 1 < len(markers) else len(value)
        body = form_blanks(value[marker.end():end])
        assert body
        result.append({"path": ([parent] if parent else []) + [marker[1]], "text": body})
    return result


def set_form_fields(units, number, verified):
    for index, text in verified.items():
        path = (["a"] if number == "732" else []) + [str(index)]
        target = next(unit for unit in units if unit["path"] == path)
        target["text"] = text


# Checked against the printed rule fields on 1946 Code pages 592-593. Their
# lengths are immaterial to the form, so every printed rule is four underscores.
FIELDS731 = {
    1: "My full, true, and correct name is ____ (full, true name, without abbreviation, and any other name which has been used, must appear here).",
    2: "My present place of residence is ____ (number and street), ____ (city or town), ____ (county), ____ (State).",
    5: "My personal description is as follows: Sex ____; color ____, complexion ____, color of eyes ____, color of hair ____, height ____ feet ____ inches, weight ____ pounds; visible distinctive marks ____; race ____; present nationality ____.",
    6: "I was born on ____ (month, day, and year), in ____ (city or town), ____ (county, district, province, or state), ____ (country).",
    7: "I am ____ married; the name of my wife or husband is ____; we were married on ____ (month, day, and year), at ____ (city or town), ____ (state or country); he or she was born at ____ (city or town), ____ (county, district, province, or state), ____ (country), on ____ (month, day, and year); and entered the United States at ____ (city or town), ____ (State), on ____ (month, day, and year), for permanent residence in the United States, and now resides at ____ (city or town), ____ (state or country).",
    9: "My place of last foreign residence was ____ (city or town), ____ (county, district, or province), ____ (country).",
    10: "I emigrated to the United States from ____ (city or town), ____ (country).",
    11: "My lawful entry for permanent residence in the United States was at ____ (city or town), ____ (State), under the name of ____, on ____ (month, day, and year), on the ____ (name of vessel or other means of conveyance).",
    12: "I have ____ been absent from the United States, having departed therefrom on ____ (dates of departures), from the port or ports of ____, upon the following vessels or other means of conveyance: ____ (names of vessels or conveyances upon departures); and returned to the United States on ____ (dates of return to the United States), at the port or ports of ____, upon the following vessels or other means of conveyance ____ (names of vessels or conveyances upon return).",
    13: "I have ____ heretofore made declaration of intention number ____, on ____ (month, day, and year), at ____ (city or town), ____ (county), ____ (State), in the ____ (name of court).",
}
FIELDS732 = {
    1: FIELDS731[1],
    2: FIELDS731[2],
    5: "My personal description is: Sex ____; color ____, complexion ____, color of eyes ____, color of hair ____, height ____ feet ____ inches, weight ____ pounds; visible distinctive marks ____; race ____; present nationality ____.",
    6: FIELDS731[6],
    7: "I am ____ married; the name of my wife or husband is ____; we were married on ____ (month, day, and year), at ____ (city or town), ____ (state or country); he or she was born at ____ (city or town), ____ (county, district, province, or state), ____ (country), on ____ (month, day, and year); entered the United States at ____ (city or town), ____ (State), on ____ (month, day, and year), for permanent residence in the United States, and now resides at ____ (city or town), ____ (state or country).",
    8: "I have ____ children; and the name, sex, date, and place of birth, and present place of residence of each of said children who is living are as follows: ____.",
    9: "My last place of foreign residence was ____ (city or town), ____ (county, district, or province), ____ (country).",
    10: FIELDS731[10],
    11: "My lawful entry for permanent residence in the United States was at ____ (city or town), ____ (State), under the name of ____, on ____ (month, day, and year), on the ____ (name of vessel or other means of conveyance) as shown by the certificate of my arrival attached to this petition.",
    12: "I have ____ been absent from the United States, having departed therefrom on ____ (dates of departures), from the port or ports of ____, upon the following vessels or other means of conveyance: ____ (names of vessels or conveyances upon departures); and returned to the United States on ____ (dates of return to the United States), at the port or ports of ____, upon the following vessels or other means of conveyance: ____ (names of vessels or conveyances upon return).",
    14: "I declared my intention to become a citizen of the United States on ____ (month, day, and year), in the ____ (name of court) Court of ____, at ____ (city or town), ____ (State).",
    15: "I have ____ heretofore made petition for naturalization number ____, on ____ (month, day, and year), at ____ (city or town), ____ (county), ____ (State), in the ____ (name of court), and such petition was dismissed or denied by that Court for the following reasons and causes, to wit: ____, and the cause of such dismissal or denial has since been cured or removed.",
    19: "It is my intention to renounce absolutely and forever all allegiance and fidelity to any foreign prince, potentate, state, or sovereignty of whom or which at this time I am a subject or citizen.",
}


# The 1947 Act replaced only the introductory paragraph of the declaration
# form. All eighteen numbered fields remain the 1946 Code's printed form.
intro731 = replacement(F47SICK, "“Sec . 331.", "Sec . 2.", [2]).split("applicant:", 1)[0] + "applicant:"
assert "unless prevented by sickness or other physical disability" in intro731
form731 = base("731").split("(1) My full", 1)[1]
units731 = [{"path": [], "text": intro731}, *form_numbered("(1) My full" + form731, None, 18)]
set_form_fields(units731, "731", FIELDS731)
assert units731[-1]["text"] == "So help me God."
add_composed("731", units731, [17], "1947-05-31", [(F47SICK, "Act of May 31, 1947, section 1, 61 Stat. 121–122")],
             "The 1947 Act replaced only the introductory paragraph, allowing a declaration outside the clerk's office for an applicant prevented by sickness or physical disability. Numbered form fields (1)–(18) retain the 1946 Code wording; printed rule lengths are normalized to four underscores.")
REVIEWED[-1]["headingOrigin"] = "printed-code-catchline"
REVIEWED[-1]["headingEvidence"] = "1946 Code, Title 8, section 731, page 592: Declaration of intention."

# The 1948 Act replaced section 732(a)'s introductory paragraph, and the 1947
# Act added subsection (e). Numbered form fields and (b)-(d) are unchanged.
intro732 = replacement(F48PETITION, "“Sec . 332. (a)", "Approved June 25, 1948.")
assert "not less than two nor more than seven years" in intro732
base732 = base("732")
form732 = base732[base732.index("(1) My full"):base732.index("(b) The applicant's petition")]
units732 = [{"path": ["a"], "text": intro732}, *form_numbered(form732, "a", 22)]
set_form_fields(units732, "732", FIELDS732)
b_start = base732.index("(b) The applicant's petition")
c_start = base732.index("(cl At the time", b_start)
d_start = base732.index("(d) Petitions for naturalization", c_start)
for label, raw in [("b", base732[b_start + 4:c_start]),
                   ("c", base732[c_start + 4:d_start]),
                   ("d", base732[d_start + 4:])]:
    units732.append({"path": [label], "text": form_blanks(raw)})
e_text = "If " + replacement(F47SICK, "“(e) If", "Sec . 3.", [2])
assert e_text.endswith("authorized deputy.")
units732.append({"path": ["e"], "text": e_text})
assert [u["path"] for u in units732[:3]] == [["a"], ["a", "1"], ["a", "2"]]
assert [u["path"] for u in units732[-4:]] == [["b"], ["c"], ["d"], ["e"]]
add_composed("732", units732, [17, 18, 19], "1948-06-25",
             [(F47SICK, "Act of May 31, 1947, section 2, 61 Stat. 122"),
              (F48PETITION, "Act of June 25, 1948, 62 Stat. 1026")],
             "The 1948 Act replaced subsection (a)'s introductory paragraph, changing ten years to seven. The 1947 Act added subsection (e). Form fields (a)(1)–(22) and subsections (b)–(d) retain the 1946 Code wording; form blanks are normalized to four underscores.")
REVIEWED[-1]["headingOrigin"] = "printed-code-catchline"
REVIEWED[-1]["headingEvidence"] = "1946 Code, Title 8, section 732, page 592: Petition for naturalization."

result = {"schemaVersion": 1, "reviewedAt": "2026-10-11",
          "reviewMethod": "Visual comparison with official Statutes at Large page images retained under audits/usc-history-2026-10-11/sources/naturalization-1950-p*.png",
          "captures": list({r["file"]: r for s in REVIEWED for r in [capture(s["sourceArtifact"]), *[capture(a["file"]) for a in s.get("amendmentSources", [])]]}.values()), "sections": REVIEWED}
(DATA / "historical-usc-reviewed-naturalization.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
print(f"Wrote {len(REVIEWED)} reviewed naturalization provisions")
