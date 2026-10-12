#!/usr/bin/env python3
"""Reproduce ten later-amended former Title 8 sections from official sources.

The earlier portions of partially amended sections come from the captured 1934
or 1946 Code scans. This script preserves an explicit provenance trail for
each amendment and does not claim that the base OCR was fully proofread.
"""
import hashlib
import json
import re
from pathlib import Path

import fitz

ROOT = Path(__file__).resolve().parents[1]
DATE = "2026-10-11"
SOURCE = json.loads((ROOT / "sources/legal/historical-usc.json").read_text())
MEMBERS = {row["section"]: row for row in SOURCE["singles"]}
MEMBERS.update({row["section"]: row for group in SOURCE["groups"] for row in group["members"]})
ACT_DIR = "sources/legal/raw/historical-usc/later-acts/"
ACT_1950 = "sources/legal/raw/historical-usc/statutes/STATUTE-64-Pg987.pdf"
CAPTURES = {}
RECORDS = []


def capture(file):
    if file not in CAPTURES:
        raw = (ROOT / file).read_bytes()
        if not raw.startswith(b"%PDF-"):
            raise ValueError(f"Not an official PDF capture: {file}")
        name = Path(file).stem
        if name.startswith("STATUTE-"):
            volume = name.split("-")[1]
            url = f"https://www.govinfo.gov/content/pkg/STATUTE-{volume}/pdf/{name}.pdf"
        else:
            url = next((s["historical"]["sourceUrl"].split("#", 1)[0] for s in MEMBERS.values()
                        if s.get("historical", {}).get("sourceArtifact") == file), "")
        CAPTURES[file] = {"file": file, "url": url, "bytes": len(raw),
                          "sha256": hashlib.sha256(raw).hexdigest(), "capturedAt": DATE}
    return CAPTURES[file]


def page(file, number=1):
    with fitz.open(ROOT / file) as doc:
        return doc[number - 1].get_text()


def normal(raw):
    raw = re.sub(r"(?<=\w)-\n(?=\w)", "", raw)
    raw = re.sub(r"\s+", " ", raw)
    return raw.strip().replace("  ", " ")


def base(number):
    member = MEMBERS[number]
    assert len(member["body"]) == 1, number
    file = member["historical"]["sourceArtifact"]
    capture(file)
    return member["body"][0]["text"], file


def act(name, page_number=1):
    file = ACT_DIR + name
    capture(file)
    return page(file, page_number), file


def add(number, body, source_file, pages, last_date, *, title=None, acts=(), note=None,
        reviewed="amendment-verified-base-ocr", **extra):
    source = capture(source_file)
    units = [{"path": [], "text": body}]
    record = {"uscSection": number, "originalTitle": title or MEMBERS[number]["historical"]["originalTitle"],
              "units": units, "unitsSha256": hashlib.sha256(json.dumps(units, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest(),
              "sourceUrl": source["url"] + f"#page={pages[0]}", "sourceArtifact": source_file,
              "sourceSha256": source["sha256"], "sourceCapturedAt": source["capturedAt"],
              "sourcePdfPages": pages, "versionLabel": f"Historical text as amended through {last_date}",
              "lastAmendmentDate": last_date, "reviewStatus": reviewed,
              "transcriptionNote": note or "The cited amendment was checked against the official page. Earlier Code text retains OCR provenance pending a complete page-level proofreading.",
              **extra}
    if acts:
        record["amendmentSources"] = [{"label": label, **capture(file)} for label, file in acts]
    RECORDS.append(record)


# Public Law 283 replaced the whole of former 8 U.S.C. 144.
t, f144 = act("STATUTE-66-Pg26.pdf")
raw = t[t.index("'*SEC. 8. (a)") + len("'*SEC. 8. "):t.index("SEC. 2.", t.index("'*SEC. 8. (a)"))]
body = normal(raw).rstrip(" ”\"")
body = re.sub(r'[“"]\s*(?=\([1-4b]\))', "", body)
body = body.replace("Provided^ however^", "Provided, however,")
assert body.startswith("(a) Any person") and body.endswith("to enforce criminal laws.")
assert "any means or transportation" in body  # Printed wording, not an OCR correction.
add("144", body, f144, [1], "1952-03-20", reviewed="visually-reviewed",
    displayHeading="Bringing in or harboring certain aliens; penalties; arrest authority",
    headingOrigin="editorial-description",
    headingEvidence="The 1952 replacement act has no Code catchline; originalTitle preserves the former 1946 Code catchline.",
    note="Complete replacement of Immigration Act of 1917 section 8, visually checked on 66 Stat. 26. The printed phrase 'any means or transportation' is retained as printed.")

# The complete 1947 replacement of section 12 is printed in the official 1946
# Code Supplement II, pages 135-136. LOC's PDF host is rate-limited; retain
# its direct URL and the captured first Statutes-at-Large page as corroboration.
supp148_url = "https://tile.loc.gov/storage-services/service/ll/uscode/uscode1946-00700/uscode1946-007008006/uscode1946-007008006.pdf#page=1"
body = ("Upon the arrival of any alien, United States citizen, or national, by water at any port within the United States on the North American Continent from a foreign port or port of Guam, Puerto Rico, Hawaii, or other insular possession of the United States, or at any port of the said insular possessions from any foreign port, from a port in the United States on the North American Continent, or from a port of another insular possession of the United States, it shall be the duty of the master or commanding officer, owners, or consignees of the steamer, sailing, or other vessel, having said alien, United States citizen, or national on board to deliver to the immigration officers at the port of arrival typewritten or printed lists or manifests made at the time and place of embarkation of such alien, United States citizen, or national on board such steamer or vessel, and such lists or manifests shall be in such form and contain such information as the Commissioner of Immigration and Naturalization, with the approval of the Attorney General, shall by regulation prescribe as necessary for the identification of the persons transported and for the enforcement of the immigration laws. "
"It shall further be the duty of the master or commanding officer of every vessel taking passengers from any port of the United States on the North American Continent to a foreign port or a port of Guam, Puerto Rico, Hawaii, or other insular possession of the United States, or from any port of the said insular possessions to any foreign port, to a port of the United States on the North American Continent, or to a port of another insular possession of the United States to file with the immigration officials before departure a list of all aliens, United States citizens, or nationals, taken on board, said list to be in such form and to contain such information as the Commissioner of Immigration and Naturalization, with the approval of the Attorney General, shall by regulation prescribe as necessary for the identification of the persons transported and for the enforcement of the immigration laws. "
"No master or commanding officer of any such vessel shall be granted clearance papers for his vessel until he has deposited such list or lists with the immigration officials at the port of departure and made oath that they are full and complete as to the information required to be contained therein. Any neglect or omission to comply with the requirements of this section shall be punishable as provided in section 150 of this title: Provided, That in the case of vessels making regular trips to ports of the United States the Commissioner of Immigration and Naturalization, with the approval of the Attorney General, may, when expedient, arrange for the delivery of lists of outgoing aliens, United States citizens, or nationals at a later date: Provided further, That it shall be the duty of immigration officials to record the following information regarding every resident alien and citizen or national leaving the United States by way of the Canadian or Mexican borders for permanent residence in a foreign country: Names, age, and sex; whether married or single; calling or occupation; whether able to read or write; nationality; country of birth; country of which citizen or subject; race; last permanent residence in the United States; intended future permanent residence; and time and port of last arrival in the United States; and if a United States citizen, or national, the facts on which claim to that status is based.")
_, f148 = act("STATUTE-61-Pg630.pdf")
add("148", body, f148, [1], "1947-07-30", reviewed="official-supplement-transcribed",
    title="Lists of passengers arriving or departing; record of resident aliens and other persons leaving for foreign country",
    note="Complete 1947 replacement transcribed from the official 1946 Code Supplement II, pages 135-136 (sourceUrl for the full text); print wraps normalized. The captured 61 Stat. 630 page establishes the replacement but ends before its text. The LOC PDF host returned HTTP 429 for local capture.",
    fullTextSourceUrl=supp148_url, edition="1946")
RECORDS[-1]["sourceUrl"] = supp148_url
RECORDS[-1]["sourceArtifact"] = None  # LOC full-text PDF could not be captured locally.
RECORDS[-1]["sourceSha256"] = None
RECORDS[-1].pop("sourceCapturedAt")
RECORDS[-1]["sourceAccessedAt"] = DATE
RECORDS[-1]["sourcePdfPages"] = [1, 2]
RECORDS[-1]["sourceCaptureStatus"] = "remote-only-rate-limited"
RECORDS[-1]["amendmentSources"] = [{"label": "Act of July 30, 1947, 61 Stat. 630 (enacting page)", **capture(f148)}]

# Section 155(c) was replaced; 1946 Code subsections (a), (b), and (d) remain.
old, code155 = base("155")
t, f155 = act("STATUTE-62-Pg1206.pdf")
start = t.index("“(c) In the case")
end = t.index("Approved July 1, 1948.", start)
amended_c = normal(t[start + 1:end]).rstrip("”")
assert amended_c.startswith("(c) In the case") and amended_c.endswith("fiscal year.")
body = old[:old.index("(c) In the case")].rstrip() + "\n\n" + amended_c + "\n\n" + old[old.index("(d) The provisions"):]
add("155", body, code155, [23, 24, 25], "1948-07-01", acts=[("Public Law 863, 62 Stat. 1206", f155)],
    note="Subsection (c) replaced verbatim from Public Law 863; subsections (a), (b), and (d) come from the 1946 Code OCR and retain its unreviewed-OCR warning.")

# The 1950 act replaced all of section 20, and the 1952 act appended one
# sentence to subsection (a). A single unit preserves all (a)-(e) text.
capture(ACT_1950)
d = fitz.open(ROOT / ACT_1950)
main24 = next(b[4] for b in d[23].get_text("blocks") if "“Sec . 20. (a)" in b[4])
main25 = next(b[4] for b in d[24].get_text("blocks") if b[0] < 100 and b[2] < 410 and b[1] > 110)
main26 = next(b[4] for b in d[25].get_text("blocks") if b[0] > 150 and b[1] < 130 and b[3] < 670)
raw = main24.split("“Sec . 20. (a) ", 1)[1] + main25 + main26
body1950 = normal("(a) " + raw).rstrip("”")
body1950 = re.sub(r'“(?=\([b-e]\))', "", body1950)
body1950 = body1950.replace("f oregoing", "foregoing").replace("Service.for", "Service for")
body1950 = body1950.replace("U. S. G. 137", "U. S. C. 137").replace("Februarv", "February")
body1950 = body1950.replace("October 16.1918", "October 16, 1918")
body1950 = body1950.replace("by . the Attorney General", "by the Attorney General")
t, f156 = act("STATUTE-66-Pg138.pdf")
addition = normal(t[t.index("Where no "):t.index("Approved June 18, 1952.")]).rstrip('" ')
assert addition.startswith("Where no Federal buildings") and addition.endswith("detention of aliens.")
assert "(b) Any alien" in body1950 and body1950.endswith("provided for under this Act.")
body = body1950.replace("(b) Any alien", addition + " (b) Any alien", 1)
add("156", body, ACT_1950, [24, 25, 26], "1952-06-18", reviewed="amendment-verified-act-ocr",
    displayHeading="Countries of deportation; costs, custody, supervision, and detention",
    headingOrigin="editorial-description",
    headingEvidence="The 1950 replacement act has no Code catchline; originalTitle preserves the former 1946 Code catchline.",
    acts=[("Public Law 395, 66 Stat. 138", f156)],
    note="Full replacement enacted at 64 Stat. 1010-1012, with the final sentence of subsection (a) added by 66 Stat. 138. OCR was checked for major artifacts against scanned pages; dense 1950 text remains flagged for full line-by-line proofing.")

# The 1948 act changed only section 204(a) and section 206(a)(1)(A).
t, f204 = act("STATUTE-62-Pg241.pdf")
old, code204 = base("204")
old = old.replace("alien; - I (e)", "alien;\n\n(e)").replace("at 'least", "at least").replace("seminary-, or university", "seminary, or university")
amend_a = normal(t[t.index('“(a) An immigrant'):t.index('Sec . 2. Section 6')]).strip('“” ')
assert amend_a.endswith("January 1, 1948.")
body = old[:old.index("(a) An immigrant")] + amend_a + "\n\n" + old[old.index("(b) An immigrant"):]
add("204", body, code204, [35], "1948-05-19", acts=[("Public Law 538, section 1, 62 Stat. 241", f204)])

old, code206 = base("206")
old = old.replace("specified in paragraphs\n\n(1) and (2)", "specified in paragraphs (1) and (2)").replace("such nationality. -\n\n(b)", "such nationality.\n\n(b)")
amend_a = normal(t[t.index('“(A) Quota immigrants'):t.index("Approved May 19, 1948.", t.index('“(A) Quota immigrants'))]).strip('“”). ').replace("January 1,1948", "January 1, 1948")
assert amend_a.endswith("January 1, 1948")
body = old[:old.index("(A) Quota immigrants")] + amend_a + old[old.index("; and (B)", old.index("(A) Quota immigrants")):]
add("206", body, code206, [36], "1948-05-19", acts=[("Public Law 538, section 2, 62 Stat. 241", f204)])

# Section 210(g) was added in 1948.
old, code210 = base("210")
t, f210 = act("STATUTE-62-Pg335.pdf")
new_g = normal(t[t.index('“(g) An alien'):t.index("Approved June 3, 1948.")]).strip('“” ')
new_g = new_g.replace("July 1,1924", "July 1, 1924").replace("July 5,1932", "July 5, 1932")
new_g = new_g.replace("nonimmigrants", "non-immigrants")
assert new_g.startswith("(g) An alien") and new_g.endswith("applicable to this subsection.")
body = old.rstrip() + "\n\n" + new_g
add("210", body, code210, [38], "1948-06-03", acts=[("Public Law 600, 62 Stat. 335", f210)],
    note="1948 subsection (g) is from the enacted text. Earlier subsections (a)-(f) come from the 1946 Code OCR and retain its unreviewed-OCR warning.")
# The print Code gives separate catchlines for (a)-(f). Keep them as headings,
# rather than inserting editorial catchline words into the statutory body.
subparts = re.split(r"\n\n\(([b-f])\) ", old)
assert len(subparts) == 11
units210 = [{"path": ["a"], "heading": "Persons entitled to; application; form and contents; verification; photograph accompanying",
             "text": subparts[0]}]
for letter, chunk in zip(subparts[1::2], subparts[2::2]):
    heading, text_value = chunk.split(". ", 1)
    text_value = text_value.replace("made In good faith", "made in good faith").replace("Issue the permit", "issue the permit")
    units210.append({"path": [letter], "heading": heading, "text": text_value})
units210.append({"path": ["g"], "heading": "Treaty-Merchants Return Permit", "text": new_g[4:]})
RECORDS[-1]["units"] = units210
RECORDS[-1]["unitsSha256"] = hashlib.sha256(json.dumps(units210, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()

# 1937 amendment inserted four words into the opening military-service list.
old, code388 = base("388")
t, f388 = act("STATUTE-50-Pg549.pdf")
assert 'after the words “Naval \nAuxiliary Service”, the words “or the Coast Guard”' in t
assert old.count("Naval Auxiliary Service") == 1
body = old.replace("Naval Auxiliary Service", "Naval Auxiliary Service or the Coast Guard", 1)
body = body.replace("enlist In the United States", "enlist in the United States").replace("discharge with. recommendation", "discharge with recommendation")
add("388", body, code388, [7], "1937-07-30", reviewed="visually-reviewed",
    acts=[("Act of July 30, 1937, section 3, 50 Stat. 548-549", f388)],
    note="The complete 1934 Code body was checked against the printed page; section 3 of the 1937 act inserts 'or the Coast Guard' after 'Naval Auxiliary Service' as printed at 50 Stat. 549.")

# The 1950 Internal Security Act replaced section 456 and only subsection
# 457(b), leaving 457(a), (c), and (d) from the 1946 Code.
t = d[26].get_text()
new456 = normal(t[t.index('“Sec . 35. Any alien') + len('“Sec . 35. '):t.index('(b) Subsection (b) of section 36')]).strip('” ')
assert new456.startswith("Any alien required") and new456.endswith("parent or legal guardian.")
add("456", new456, ACT_1950, [27], "1950-09-23", reviewed="visually-reviewed",
    displayHeading="Annual notice of current address by registered aliens",
    headingOrigin="editorial-description",
    headingEvidence="The 1950 replacement act has no Code catchline; originalTitle preserves the former 1946 Code catchline.",
    note="Complete replacement of Alien Registration Act section 35 in Public Law 831, section 24(a), visually checked at 64 Stat. 1013.")
old, code457 = base("457")
new_b = normal(t[t.index('“(b) Any alien') + 1:t.index("AMENDING SECTION 3 05")]).strip('” ')
assert new_b.startswith("(b) Any alien") and new_b.endswith("or both.")
body = old[:old.index("(b) Any alien")].rstrip() + "\n\n" + new_b + "\n\n" + old[old.index("(c) Any alien"):]
add("457", body, code457, [3], "1950-09-23", acts=[("Public Law 831, section 24(b), 64 Stat. 1013", ACT_1950)],
    note="Subsection (b) replaced from 64 Stat. 1013; other subsections from the 1946 Code OCR, visually spot-checked on the source page.")

assert {r["uscSection"] for r in RECORDS} == {"144", "148", "155", "156", "204", "206", "210", "388", "456", "457"}
output = {"schemaVersion": 1, "generatedAt": DATE, "captures": list(CAPTURES.values()), "sections": RECORDS}
target = ROOT / "sources/legal/historical-usc-reviewed-later.json"
target.write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n")
print(f"{len(RECORDS)} later-amended sections, {len(CAPTURES)} verified source captures -> {target}")
