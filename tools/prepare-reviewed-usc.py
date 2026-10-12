#!/usr/bin/env python3
"""Reproduce visually reviewed historical USC transcriptions.

Run with the PDF dependencies in /tmp/inasearch-usc-history-venv. Source page
images and transcription decisions are recorded in historical-usc-reviewed.json.
"""
import hashlib
import json
import re
from pathlib import Path
import fitz

ROOT = Path(__file__).resolve().parents[1]
DATE = "2026-10-11"
INA = json.loads((ROOT / "sources/legal/historical-ina.json").read_text())
CAPTURES = {c["file"]: c for c in INA["captures"]}
EXTRA_CAPTURES = ROOT / "sources/legal/raw/historical-usc/reviewed-extra-captures.json"
if EXTRA_CAPTURES.exists():
    CAPTURES.update({c["file"]: c for c in json.loads(EXTRA_CAPTURES.read_text())})
LOC_CAPTURES = ROOT / "sources/legal/raw/historical-usc/loc/manifest.json"
if LOC_CAPTURES.exists():
    CAPTURES.update({c["file"]: {**c, "url": c["source"]} for c in json.loads(LOC_CAPTURES.read_text())["records"]})
APPROPRIATIONS = json.loads((ROOT / "sources/legal/raw/historical-usc/final-appropriation-captures.json").read_text())["captures"]
CAPTURES.update({c["localFile"]: {**c, "file": c["localFile"]} for c in APPROPRIATIONS})
SECTIONS = []


def text(file, page):
    with fitz.open(ROOT / file) as doc:
        return doc[page - 1].get_text()


def normalize(value):
    value = re.sub(r"(?<=\w)-\n(?=\w)", "", value)
    return re.sub(r"\s+", " ", value).strip()


def capture(file):
    data = (ROOT / file).read_bytes()
    old = CAPTURES.get(file, {})
    if old:
        url = old["url"]
    else:
        stem = Path(file).stem
        volume = stem.split("-")[1]
        url = f"https://www.govinfo.gov/content/pkg/STATUTE-{volume}/pdf/{stem}.pdf"
    return {"file": file, "url": url, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest(), "capturedAt": old.get("capturedAt", DATE)}


def add(number, heading, units, file, pages, year, last, **extra):
    c = capture(file)
    record = {"uscSection": number, "originalTitle": heading, "units": units,
              "sourceUrl": c["url"] + f"#page={pages[0]}", "sourceArtifact": file,
              "sourceSha256": c["sha256"], "sourceCapturedAt": c["capturedAt"],
              "sourcePdfPages": pages, "versionLabel": f"Historical text from the {year} U.S. Code edition",
              "lastAmendmentDate": last,
              "reviewStatus": "visually-reviewed",
              "transcriptionNote": "Checked against the official scanned pages. Print line wrapping and end-of-line word breaks are normalized; editorial notes remain separate from the former statutory body.",
              **extra}
    record["unitsSha256"] = hashlib.sha256(json.dumps(units, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()
    SECTIONS.append(record)


F58 = "sources/legal/raw/historical-ina/usc-1958-ch12.pdf"
F88 = "sources/legal/raw/historical-ina/usc-1988-ch12.pdf"
for number, page, start, heading, last in [
    ("1182a", 25, "Any alien", "Admission of aliens convicted of misdemeanor; conditions", "1954-09-03"),
    ("1182b", 25, "Any alien,", "Admission of alien spouse, child, or parent excludable for crime involving moral turpitude, conviction of two offenses, or membership in certain immoral classes; conditions", "1957-09-11"),
    ("1201a", 30, "The Secretary", "Waiver of fingerprinting requirements for nonimmigrant aliens", "1957-09-11"),
    ("1251a", 43, "The provisions", "Aliens deportable for fraud or misrepresentation; adjustment of status of certain aliens; conditions; waiver of ground of inadmissibility", "1957-09-11"),
    ("1401b", 66, "In the administration", "Physical presence in the United States; absences of less than twelve months in the aggregate", "1957-09-11"),
]:
    page_text = text(F58, page)
    begin = page_text.index(start, page_text.index(number + "."))
    raw = page_text[begin:page_text.index("CODIFICATION", begin)]
    body = normalize(re.split(r"\(Pub\. L\.|\(Sept\.", raw)[0])
    if number == "1182a":
        assert "Provided,'That" in body
        body = body.replace("Provided,'That", "Provided, That")
    add(number, heading, [{"path": [], "text": body}], F58, [page], 1958, last)

# The 1988 scan reproduces the unamended 1980 statute. Its editorial footnote
# identifies the subsequently redesignated cross-reference; retain that evidence
# in metadata, rather than incorporating the footnote marker into statutory text.
p209, p210 = text(F88, 209), text(F88, 210)
raw = p209[p209.index("(a) Appointment; rank", p209.index("§ 1525.")):]
raw = re.sub(r"Page 1401\s*§ 1525\s*$", "", raw)
tail = p210.split("\n", 1)[1].split("See References in Text note below.")[0]
raw += "\n" + tail
raw = raw.replace("1523(a)(1) 1", "1523(a)(1)")
units = []
for key, heading, next_key in [("a", "Appointment; rank", "b"), ("b", "Duties and functions", "c"), ("c", "Consultations with States, localities, etc.; reports by Secretaries of Labor and Education and inclusion of information in report of Coordinator", None)]:
    match = re.search(rf"\({key}\) [^\n]+(?:\nby Secretaries[^\n]+\nsion of information[^\n]+)?\n", raw)
    assert match, key
    end = raw.index(f"({next_key}) ", match.end()) if next_key else len(raw)
    chunk = normalize(raw[match.end():end])
    if key == "a":
        # The word is hyphenated in print, including at the line break.
        chunk = chunk.replace("Ambassador-atLarge", "Ambassador-at-Large")
        units.append({"path": [key], "heading": heading, "text": chunk})
    else:
        parts = re.split(r"(?<!\S)\(([1-9])\) ", chunk)
        introduction = parts[0].strip()
        if key == "b":
            assert introduction.endswith("for-")
            introduction = introduction[:-1] + "—"
        units.append({"path": [key], "heading": heading, **({"text": introduction} if introduction else {})})
        for n, body in zip(parts[1::2], parts[2::2]):
            units.append({"path": [key, n], "text": body.strip()})
assert len([u for u in units if u["path"][:1] == ["b"]]) == 10
assert len([u for u in units if u["path"][:1] == ["c"]]) == 3
add("1525", "United States Coordinator for Refugee Affairs", units, F88, [209, 210], 1988, "1980-03-17", historicalEditorialNote="The 1988 Code footnote explains that section 1523(a)(1), cited in subsection (c)(2), was redesignated as section 1523(a) by Public Law 100-525, section 9(jj)(2)(D), October 24, 1988.")

# Reviewed amendment text for 1205. Subsections (a) and (b) were replaced in
# 1959; the 1960 amendment changes only the deadline in subsection (a).
STAT73A = "sources/legal/raw/historical-usc/statutes/STATUTE-73-Pg490.pdf"
STAT73B = "sources/legal/raw/historical-usc/statutes/STATUTE-73-Pg491.pdf"
STAT74 = "sources/legal/raw/historical-usc/statutes/STATUTE-74-Pg504.pdf"
stat490, stat491 = text(STAT73A, 1), text(STAT73B, 1)
a_start = stat490.index('"SEC. 4. (a)') + len('"SEC. 4. (a)')
a_part = stat490[a_start:stat490.index("E 1", a_start)]
a_part += " " + stat491[stat491.index("shall thereafter"):stat491.index('"(b)')]
a_text = normalize(a_part).replace("June 30, 1960", "June 30, 1961")
assert a_text.endswith("Immigration and Nationality Act.")
b_part = stat491[stat491.index('"(b)') + 4:stat491.index("Approved September 9, 1959.")]
b_text = normalize(b_part).replace('"Any United States', 'Any United States').rstrip('"')
base1205 = text(F58, 32)
c_raw = base1205.split("(c) Validity of visa.\n", 1)[1].split("(d) Adjustment of status.", 1)[0]
d_raw = base1205.split("(d) Adjustment of status.\n", 1)[1].split("(Pub. L.", 1)[0]
amendments = [{"label": "Public Law 86-253, 73 Stat. 490", **capture(STAT73A)}, {"label": "Public Law 86-253, continuation at 73 Stat. 491", **capture(STAT73B)}, {"label": "Public Law 86-648, section 7, 74 Stat. 505", **capture(STAT74)}]
add("1205", "Nonquota immigrant visas for eligible orphans", [
    {"path": ["a"], "heading": "Issuance; termination date; limitations", "text": a_text},
    {"path": ["b"], "heading": 'Definition of "eligible orphan"', "text": b_text},
    {"path": ["c"], "heading": "Validity of visa", "text": normalize(c_raw)},
    {"path": ["d"], "heading": "Adjustment of status", "text": normalize(d_raw)},
], F58, [32], 1958, "1960-07-14", versionLabel="Historical text as amended through July 14, 1960", amendmentSources=amendments,
    transcriptionNote="1958 Code subsections (c) and (d), with subsections (a) and (b) replaced by Public Law 86-253 and the subsection (a) deadline extended by Public Law 86-648. Amendment wording is retained, including references to the Immigration and Nationality Act. Each source page was visually checked.")

# Complete replacement of the tuberculosis provision enacted in 1959.
start = stat490.index('"SEC. 6.') + len('"SEC. 6.')
body = normalize(stat490[start:stat490.index("SEC. 2.", start)]).rstrip('"')
body = body.replace("June 30,1961", "June 30, 1961")
add("1182c", "Admission of alien spouse, child, or parent afflicted with tuberculosis; termination date", [{"path": [], "text": body}], STAT73A, [1], 1959, "1959-09-09", versionLabel="Historical text as amended September 9, 1959",
    transcriptionNote="The complete replacement enacted by Public Law 86-253, section 1, is reproduced using the enacted INA citation. The prior requirement for reports to Congress was removed by that amendment. Source page visually checked; the heading describes the amended provision.")

STAT79 = "sources/legal/raw/historical-usc/statutes/STATUTE-79-Pg911.pdf"
enactment = text(STAT79, 11)
start = enactment.index("(e) Unless") + 4
body = normalize(enactment[start:enactment.index("(f) All Federal", start)])
assert body.endswith("120,000.")
add("1151a", "Limitation on number of special immigrants", [{"path": [], "text": body}], STAT79, [11], 1965, "1965-10-03", versionLabel="Historical enacted text of Public Law 89-236, section 21(e), October 3, 1965",
    headingOrigin="editorial-description", headingEvidence="The current House removal description identifies the provision as limiting the total number of special immigrants to 120,000. The enactment has no individual heading for subsection 21(e).",
    transcriptionNote="The full enacted text is reproduced with its original INA citations. It appeared as a note under section 1151 in the 1964 Code Supplement II. The descriptive heading identifies its subject; it is not represented as a quoted heading from the enactment.")

# Short-lived pre-1940 provisions absent from the captured main editions.
# Statutes at Large supplies the complete body. Descriptive headings are
# identified as editorial until a former Code catchline is independently found.
STAT52 = "sources/legal/raw/historical-usc/statutes/STATUTE-52-Pg377.pdf"
STAT50 = "sources/legal/raw/historical-usc/statutes/STATUTE-50-Pg558.pdf"
STAT49 = "sources/legal/raw/historical-usc/statutes/STATUTE-49-Pg1917.pdf"
STAT54 = "sources/legal/raw/historical-usc/statutes/STATUTE-54-Pg715.pdf"
raw = text(STAT52, 1).split("“Sec . 5c. ", 1)[1].split("Approved, May 16, 1938.", 1)[0]
body = normalize(raw).rstrip("”")
assert body.startswith("That any person of good character") and body.endswith("citizen of the United States.")
add("5a–1", "Citizenship of persons born in Puerto Rico; misinformation regarding citizenship status", [{"path": [], "text": body}], STAT52, [1], 1938, "1938-05-16",
    versionLabel="Historical enacted text of the Act of May 16, 1938, 52 Stat. 377",
    headingOrigin="editorial-description", headingEvidence="Describes the complete provision enacted as section 5c of the Puerto Rico Organic Act, formerly classified to 8 U.S.C. 5a–1.",
    transcriptionNote="Complete enacted section 5c, visually checked. References to sections 5 and 5a retain the original Act numbering. The heading describes the provision and is not represented as a quoted Code catchline.")

raw = text(STAT50, 1).split("[CHAPTER 563]", 1)[1]
for number, start, end, heading in [
    ("5d", "That any person", "Sec . 2.", "Citizenship of persons born in the Canal Zone"),
    ("5e", "Sec . 2. ", "Approved, August 4, 1937.", "Citizenship of persons born in the Republic of Panama"),
]:
    begin = raw.index(start)
    if number == "5e":
        begin += len(start)
    body = normalize(raw[begin:raw.index(end, begin)])
    assert body.endswith("citizen of the United States.")
    add(number, heading, [{"path": [], "text": body}], STAT50, [1], 1937, "1937-08-04",
        versionLabel="Historical enacted text of the Act of August 4, 1937, 50 Stat. 558",
        headingOrigin="editorial-description", headingEvidence=f"Describes section {'1' if number == '5d' else '2'} of the Act of August 4, 1937; the current House removal note identifies its former Code location.",
        transcriptionNote="Complete enacted provision, visually checked. The heading describes this individual provision and is not represented as a quoted Code catchline.")

raw = text(STAT49, 1).split("That hereafter ", 1)[1].split("Approved, June 25, 1936.", 1)[0]
body = normalize("That hereafter " + raw)
assert body.count("have terminated,") == 1
body = body.replace("have terminated,", "have terminated or who has resided continuously in the United States since the date of such marriage,,")
# The amending Act inserts a comma after its new phrase before the original
# comma; normalize that duplicated punctuation, retaining the enacted words.
body = body.replace("marriage,,", "marriage,").replace("sec. 131) ;", "sec. 131);")
add("9a", "Repatriation of native-born women married to aliens prior to September 22, 1922", [{"path": [], "text": body}], STAT49, [1], 1936, "1940-07-02",
    versionLabel="Historical text as amended July 2, 1940",
    headingOrigin="editorial-description", headingEvidence="The current House removal note describes this provision as repatriation of native-born women married to aliens prior to September 22, 1922.",
    amendmentSources=[{"label": "Act of July 2, 1940, 54 Stat. 715", **capture(STAT54)}],
    transcriptionNote="The 1936 enacted text includes the words inserted after 'terminated' by the Act of July 2, 1940. The resulting duplicate comma is normalized. Both source pages were visually checked. Original statutory citations are retained; the heading is a description, not a quoted Code catchline.")

STAT67 = "sources/legal/raw/historical-usc/statutes/STATUTE-67-Pg108.pdf"
p109, p110 = text(STAT67, 2), text(STAT67, 3)
body_a = "That, notwithstanding " + p109[p109.index("the provisions of sections 310"):p109.index("SEC. 2.")]
body_b = p109.split("SEC. 2. ", 1)[1].split("N o n c i t i z e n s", 1)[0].rstrip()
body_b += "\n" + p110[p110.index("ralization,"):p110.index("SEC. 3.")]
body_c = p110.split("SEC. 3. ", 1)[1].split("SEC. 4.", 1)[0]
body_d = p110.split("SEC. 4. ", 1)[1].split("Approved June 30, 1953.", 1)[0]
for number, heading, raw, pages in [
    ("1440a", "Naturalization of persons serving in the Armed Forces after June 24, 1950", body_a, [1, 2]),
    ("1440b", "Naturalization outside the jurisdiction of a naturalization court", body_b, [2, 3]),
    ("1440c", "Restrictions on naturalization and revocation of citizenship", body_c, [3]),
    ("1440d", 'Definition of "United States"', body_d, [3]),
]:
    body = normalize(raw.replace("Provided^", "Provided,").replace("however^", "however,"))
    body = re.sub(r"(?<=\d),(?=\d{4}\b)", ", ", body)
    body = body.replace("section) :", "section):")
    assert not any(x in body for x in ["PUBLIC LAW", "Stat.", "N o n c i t i z e n s", "27000"])
    add(number, heading, [{"path": [], "text": body}], STAT67, pages, 1953, "1953-06-30",
        versionLabel="Historical enacted text of the Act of June 30, 1953, 67 Stat. 108–110",
        headingOrigin="editorial-description", headingEvidence=f"Describes section {['1440a', '1440b', '1440c', '1440d'].index(number) + 1} of the Act of June 30, 1953. The enactment's individual sections have no catchlines.",
        transcriptionNote="Complete enacted section, visually checked against the Statutes at Large. Original Act and INA section numbering is retained. The heading describes this individual provision; it is not represented as a quoted Code catchline.",
        **({"historicalEditorialNote": "The enacted text specifies service after June 24, 1950. The current House omission note says June 29, 1950; each source is reproduced as written."} if number == "1440a" else {}))

# The 1952 edition moved this provision from section 724a–1 into a
# statutory note under section 1440 and prints its full amended wording there.
F52 = "sources/legal/raw/historical-usc/loc/1952/chapter-12.pdf"
raw = text(F52, 61).split('provided that: "', 1)[1].split('§ 1441.', 1)[0]
body = normalize(raw).rstrip('"').replace("completion Of", "completion of")
body = body.replace(" [this section]", "").replace(" [subsection (a) of this section]", "")
assert body.startswith("Notwithstanding the dates") and body.endswith("such section 329 (a).")
add("724a–1", "Naturalization of aliens enlisted in the Regular Army", [{"path": [], "text": body}], F52, [61], 1952, "1952-06-27",
    edition="1952", versionLabel="Historical text as amended June 27, 1952, printed as a statutory note under 8 U.S.C. 1440",
    transcriptionNote="Visually checked against the 1952 Code's full quotation of the amended Act of June 30, 1950. Bracketed editorial translations referring to the note's location under section 1440 are omitted; the original INA section 329 citations are retained. The former section 724a–1 catchline is separately evidenced in the 1952 Code, chapter 11, PDF page 2.")

# Section 1556 was a classification of the same provision now at 1353d.
# Its current House note expressly gives that destination; the 1988 Code
# reproduces the full provision and records no amendments after June 27, 1952.
raw = text(F88, 151).split("1353d. Disposition", 1)[1]
body = normalize(raw[raw.index("Moneys collected"):raw.index("(Aug. 22, 1940")])
add("1556", "Disposition of money received as extra compensation", [{"path": [], "text": body}], F88, [151], 1988, "1952-06-27",
    edition="1988", versionLabel="Transferred provision as printed at 8 U.S.C. 1353d in the 1988 Code",
    headingOrigin="transferred-provision-heading", headingEvidence="Heading of section 1353d in the 1988 Code; the current House note for section 1556 identifies section 1353d as its destination.",
    transcriptionNote="Full text at the expressly identified transfer destination, visually checked against the 1988 Code. That edition records the last amendment as June 27, 1952. This is not represented as a facsimile of the former section 1556 entry.",
    historicalEditorialNote="The House identifies section 1353d as the destination of former section 1556. The text shown here is the transferred provision at that destination, with its Code citations as printed in 1988.")

# The 1934 main edition predates these express 1936/1939 changes. Preserve
# unchanged paragraphs and apply the enacted replacement, with both sources.
F34N = "sources/legal/raw/historical-usc/loc/1934/chapter-09.pdf"
F36COURT = "sources/legal/raw/historical-usc/statutes/STATUTE-49-Pg1921.pdf"
F39A = "sources/legal/raw/historical-usc/statutes/STATUTE-53-Pg843.pdf"
F39B = "sources/legal/raw/historical-usc/statutes/STATUTE-53-Pg844.pdf"


def amendment(file, label):
    return {**capture(file), "label": label}


body = "\n\n".join([
    "Exclusive jurisdiction to naturalize aliens as citizens of the United States is conferred upon the following specified courts:",
    "United States district courts in the States, United States district courts for the Territories of Hawaii and Alaska, the district court of the United States for the District of Columbia; also all courts of record in any State or Territory having a seal, a clerk, and jurisdiction in actions at law or equity, or law and equity, in which the amount in controversy is unlimited.",
    "The naturalization jurisdiction of all courts herein specified, State, Territorial, and Federal, shall extend only to aliens resident within the respective judicial districts of such courts.",
])
add("357", "Jurisdiction of naturalization courts", [{"path": [], "text": body}], F34N, [2], 1934, "1936-06-25",
    versionLabel="1934 Code text incorporating the court-name change enacted June 25, 1936",
    amendmentSources=[amendment(F36COURT, "Act of June 25, 1936, 49 Stat. 1921")],
    historicalEditorialNote="The 1936 Act renamed the Supreme Court of the District of Columbia as the district court of the United States for the District of Columbia, expressly leaving its jurisdiction and functions unchanged. The displayed text incorporates that name change into the 1934 Code text.")

body = "He shall declare on oath before the clerk of any court authorized by this Act to naturalize aliens, or his authorized deputy, in the district in which such alien resides, two years at least prior to his admission, and after he has reached the age of eighteen years, that it is bona fide his intention to become a citizen of the United States and to reside permanently therein, and that he will, before being admitted to citizenship renounce forever all allegiance and fidelity to any foreign prince, potentate, state, or sovereignty. Such declaration shall set forth the name, age, occupation, personal description, place of birth, last foreign residence, the date of arrival, the name of the vessel, if any, in which he came to the United States, and the present place of residence in the United States of said alien. No declaration of intention or petition for naturalization shall be made outside of the office of the clerk of court."
add("373", "Declaration of intention", [{"path": [], "text": body}], F39A, [1], 1939, "1939-06-20",
    versionLabel="Act of June 20, 1939, section 1, 53 Stat. 843",
    headingEvidence="Former Code heading visually verified in the 1934 Code, chapter 9, PDF page 4.",
    historicalEditorialNote="Full replacement of the first subdivision of section 4 of the 1906 Act. The subdivision's introductory ordinal is omitted because the reader identifies the provision by its Code section.")

body = "\n\n".join([
    "Not less than two years nor more than seven years after he has made such declaration of intention he shall make and file, in duplicate, a petition in writing, signed by the applicant in his own handwriting and duly verified, in which petition such applicant shall state his full name, his place of residence (by street and number, if possible), his occupation, and, if possible, the date and place of his birth; the place from which he emigrated, and the date and place of his arrival in the United States, and, if he entered through a port, the name of the vessel on which he arrived; the time when and the place and name of the court where he declared his intention to become a citizen of the United States; if he is married he shall state the name of his wife and, if possible, the country of her nativity and her place of residence at the time of filing his petition; and if he has children, the name, date, and place of birth and place of residence of each child living at the time of the filing of his petition: Provided, That if he has filed his declaration before June 29, 1906, he shall not be required to sign the petition in his own handwriting.",
    "The petition shall set forth that he is not a disbeliever in or opposed to organized government or a member of or affiliated with any organization or body of persons teaching disbelief in or opposed to organized government, a polygamist or believer in the practice of polygamy, and that it is his intention to become a citizen of the United States and to renounce absolutely and forever all allegiance and fidelity to any foreign prince, potentate, state, or sovereignty, and that it is his intention to reside permanently within the United States, whether or not he has been denied admission as a citizen of the United States, and if denied, the ground or grounds of such denial, the court or courts in which such decision was rendered, and that the cause for such denial has been since cured or removed and every fact material to his naturalization and required to be proved upon the final hearing of his application.",
    "As to each period of residence at any place in the county where the petitioner resides at the time of filing his petition, there shall be included in the petition the affidavits of at least two credible witnesses, citizens of the United States, stating that each has personally known the petitioner to have been a resident at such place for such period, and that the petitioner is and during all such period has been a person of good moral character.",
])
add("379", "Petition for naturalization; when required to be filed; allegations; verification by citizen witnesses", [{"path": [], "text": body}], F34N, [5], 1934, "1939-06-20",
    versionLabel="1934 Code text with its second paragraph replaced by the Act of June 20, 1939",
    amendmentSources=[amendment(F39A, "Act of June 20, 1939, section 2, 53 Stat. 843"), amendment(F39B, "Continuation at 53 Stat. 844")],
    historicalEditorialNote="The 1939 Act replaced only the second paragraph. The first and third paragraphs are retained from the 1934 Code. All three paragraphs and the two-page amendment were compared with the printed sources.")

body = "He shall, before he is admitted to citizenship, declare on oath, in open court, that he will support the Constitution of the United States, and that he absolutely and entirely renounces and abjures all allegiance and fidelity to any foreign prince, potentate, state, or sovereignty of which he was before a citizen or subject; and he will support and defend the Constitution and laws of the United States against all enemies, foreign and domestic, and bear true faith and allegiance to the same."
add("381", "Oath renouncing foreign allegiance and to support Constitution and laws", [{"path": [], "text": body}], F39B, [1], 1939, "1939-06-20",
    versionLabel="Act of June 20, 1939, section 3, 53 Stat. 844",
    headingEvidence="Former Code heading visually verified in the 1934 Code, chapter 9, PDF page 6.",
    historicalEditorialNote="Full replacement of the third subdivision of section 4 of the 1906 Act, which the enacted amendment identifies as former 8 U.S.C. 381.")

# The later Code's disposition paragraphs are not substitutes for these laws.
F33 = "sources/legal/raw/historical-usc/statutes/STATUTE-33-Pg684-link.pdf"
body = "Provided, That the Commissioner-General of Immigration, with the approval of the Secretary of Commerce and Labor, shall have power to refund head tax heretofore and hereafter collected under section one of the immigration Act approved March third, nineteen hundred and three, upon presentation of evidence showing conclusively that such collection was erroneously made."
add("134", "Refunding head tax", [{"path": [], "text": body}], F33, [54], 1905, "1905-02-03",
    versionLabel="Act of February 3, 1905, section 1, 33 Stat. 684",
    headingEvidence="Former heading printed in the 1934 Code; the later Code contains only an executed-provision note.",
    historicalEditorialNote="The complete head-tax refund proviso is reproduced from its enactment. The surrounding appropriation for Bureau of Immigration salaries is not part of former section 134.")

F25N = "sources/legal/raw/historical-usc/loc/1925/chapter-09.pdf"
body = "When any alien, who has declared his intention to become a citizen of the United States, becomes insane before he is actually naturalized, and his wife shall thereafter make a homestead entry under the land laws of the United States, she and their minor children may, by complying with the other provisions of the naturalization laws be naturalized without making any declaration of intention."
add("371", "Wife of alien declarant becoming insane before naturalization; minor children", [{"path": [], "text": body}], F25N, [3], 1925, "1911-02-24",
    headingOrigin="editorial-contextualization", headingEvidence="The printed catchline begins ‘Same;’ and follows the naturalization-of-women provisions. The subject is stated directly for standalone display.")

F40C = "sources/legal/raw/historical-usc/loc/1940/chapter-07.pdf"
body = "All Chinese persons ordered deported under judicial writs shall be delivered by the marshal of the district or his deputy into the custody of any officer designated for that purpose by the Attorney General, for conveyance to the frontier or seaboard for deportation in the same manner as aliens deported under the immigration laws."
add("299", "Deportation officer", [{"path": [], "text": body}], F40C, [8], 1940, "1940-06-14")

# The 1950 amendment replaced the 1918 Act in full. The House later gave
# sections 5–9 one collective disposition description; its words are not five
# individual Code catchlines. Recover each enacted section and its printed
# subdivisions from 64 Stat. 1008–1010 instead.
F64SECURITY = "sources/legal/raw/historical-usc/statutes/STATUTE-64-Pg987.pdf"
security_1008, security_1009, security_1010 = (text(F64SECURITY, page) for page in (22, 23, 24))


def security_text(fragment):
    # Join alphabetic words broken only by a print line ending. A numerical
    # range such as 39 Stat. 885–887 must retain its separator.
    fragment = re.sub(r"(?<=[A-Za-z])-\s*\n\s*(?=[a-z])", "", fragment)
    return re.sub(r"\s+", " ", fragment).strip().replace("885- 887", "885–887")


def security_add(number, heading, units, pages, margin_evidence):
    assert all(unit.get("text") for unit in units), number
    assert all("PUBLIC LAWS" not in unit["text"] and "98352°" not in unit["text"] for unit in units), number
    add(number, heading, units, F64SECURITY, pages, 1950, "1950-09-23",
        versionLabel="Act of October 16, 1918, as completely amended September 23, 1950 (64 Stat. 1008–1010)",
        headingOrigin="editorial-description",
        headingEvidence=f"The enacted section has no catchline. Its subject follows the statutory text and the printed margin label(s): {margin_evidence}. The House groups sections 137–4 through 137–8 under one disposition note.",
        transcriptionNote="Complete enacted Act section, visually checked against 64 Stat. 1008–1010. Print line wraps and broken words are normalized; the Act's own section and subsection numbering is retained. The descriptive heading is not represented as a former Code catchline.")


sec5 = security_1008.split("“Sec . 5. ", 1)[1].split("“Sec . 6. ", 1)[0]
security_add("137–4", "Temporary exclusion and deportation of aliens excludable under the Act",
             [{"path": [], "text": security_text(sec5)}], [22], "‘Temporary exclusion, etc.’")

sec6_start = security_1008.index("“Sec . 6. ")
sec6_b = security_1008.index("“(b) ", sec6_start)
sec6a = security_1008[security_1008.index("(a) ", sec6_start) + 4:sec6_b]
sec6b = (security_1008[sec6_b + len("“(b) "):security_1008.index("PUBLIC LAWS—CH.", sec6_b)]
         + security_1009[security_1009.index("a detailed report"):security_1009.index("“(c) ")])
sec6c = security_1009.split("“(c) ", 1)[1].split("“(1) ", 1)[0]
sec6c1 = security_1009.split("“(1) ", 1)[1].split("“(2) ", 1)[0]
sec6c2 = security_1009.split("“(2) ", 1)[1].split("“(d) ", 1)[0]
sec6d = security_1009.split("“(d) ", 1)[1].split("“Sec . 7. ", 1)[0]
sec6_units = [
    {"path": ["a"], "text": security_text(sec6a)},
    {"path": ["b"], "text": security_text(sec6b)},
    {"path": ["c"], "text": security_text(sec6c)},
    {"path": ["c", "1"], "text": security_text(sec6c1).replace("section 1 (1) and l (3)", "section 1 (1) and 1 (3)")},
    {"path": ["c", "2"], "text": security_text(sec6c2)},
    {"path": ["d"], "text": security_text(sec6d)},
]
assert sec6_units[1]["text"].endswith("excludible under section 1 (2).")
assert sec6_units[3]["text"].endswith("necessary; and")
security_add("137–5", "Limits on admission exceptions for aliens covered by the Act", sec6_units, [22, 23], "‘Report to Congress’")

sec7 = security_1009.split("“Sec . 7. ", 1)[1].split("“Sec . 8. ", 1)[0]
security_add("137–6", "Suspension of immigration visas when a country refuses an alien's return",
             [{"path": [], "text": security_text(sec7)}], [23], "‘Acceptance of return of alien’")

sec8 = security_1009.split("“Sec . 8. ", 1)[1].split("“Sec . 9. ", 1)[0]
sec8a, sec8b = sec8.split("“(b) ", 1)
assert sec8a.startswith("(a) ")
security_add("137–7", "Penalties for assisting unlawful entry or returning after deportation", [
    {"path": ["a"], "text": security_text(sec8a[4:])},
    {"path": ["b"], "text": security_text(sec8b)},
], [23], "‘Person assisting alien to enter U.S.’ and ‘Illegal entry after deportation’")

sec9_head = security_text(security_1009.split("“Sec . 9. ", 1)[1].split("98352°", 1)[0])
sec9_tail = security_text(security_1010.split("provisions of this Act, is hereby", 1)[1].split("“Sec . 10. ", 1)[0])
assert sec9_head.endswith("any of the")
sec9 = sec9_head + " provisions of this Act, is hereby " + sec9_tail
assert sec9.endswith("whose case is within the purview of this Act.")
security_add("137–8", "Inapplicability of laws inconsistent with the Act",
             [{"path": [], "text": sec9}], [23, 24], "‘Nonapplicability’")

# Short OCR corrections below were checked against every printed body page.
generated = json.loads((ROOT / "sources/legal/historical-usc.json").read_text())
members = {s["section"]: s for s in [*generated["singles"], *[m for g in generated["groups"] for m in g["members"]]]}
for number, file, pages, year, last, corrections in [
    ("102", "sources/legal/raw/historical-usc/loc/1946/chapter-06.pdf", [4,5], 1946, "1945-10-29", {"aliens Into": "aliens into", "to Inform": "to inform", "his Judgment": "his judgment"}),
    ("277", F40C, [4,5], 1940, "1940-06-14", {"year, In cases": "year, in cases", "from wldch": "from which", "the ma.ter": "the master"}),
    ("403", F34N, [11], 1934, "1933-06-10", {"Dur- Ing": "During", "the-certificate": "the certificate"}),
    ("800", "sources/legal/raw/historical-usc/loc/1946/chapter-11.pdf", [28], 1946, "1868-07-27", {"whereas It": "whereas it", "it Is": "it is", "restricts, Impairs": "restricts, impairs"}),
]:
    section = members[number]
    body = section["body"][0]["text"]
    for wrong, right in corrections.items():
        assert wrong in body, (number, wrong)
        body = body.replace(wrong, right)
    add(number, section["heading"], [{"path": [], "text": body}], file, pages, year, last,
        headingEvidence="The former Code caption and full body were visually checked; inherited ‘Same;’ subjects are expanded for standalone display where applicable.")

for source in APPROPRIATIONS:
    number = source["section"]
    last, year, citation = {
        "103a": ("1947-07-09", 1947, "61 Stat. 292"),
        "109d": ("1950-09-06", 1950, "64 Stat. 618"),
        "117": ("1944-06-28", 1944, "58 Stat. 558"),
    }[number]
    note = "The complete provision is reproduced from its final annual appropriation enactment identified in the Code's source history, retaining the introductory proviso and closing punctuation."
    if number == "103a":
        note += " ‘Said laws’ refers to the immigration, naturalization, and alien-registration laws described in the appropriation paragraph."
    heading = members[number]["heading"].replace("lublic Health Service", "Public Health Service")
    add(number, heading, [{"path": [], "text": source["paragraphText"]}], source["localFile"], [source["physicalPage"]], year, last,
        versionLabel=f"Final annual appropriation provision, {citation}, enacted {last}",
        historicalEditorialNote=note, headingEvidence="Descriptive heading retained from the former Code caption; the appropriation proviso has no separate statutory heading.", headingOrigin="editorial-description")

IRCA_REVIEWED = ROOT / "sources/legal/historical-usc-reviewed-1186.json"
if IRCA_REVIEWED.exists():
    irca = json.loads(IRCA_REVIEWED.read_text())
    CAPTURES.update({c["file"]: c for c in irca["captures"]})
    SECTIONS.extend(irca["sections"])

# The 1996 Code prints former § 1254 as repealed and does not reproduce the
# brief final version. Compose it from the complete official 1995 Code text
# and the two precise amendments in Pub. L. 104-132, § 413(b)–(c).
GOVINFO_1995 = "sources/legal/raw/historical-usc/govinfo/USCODE-1995-title8.htm"
AEDPA_1996 = "sources/legal/raw/historical-usc/statutes/PLAW-104publ132.htm"
IIRIRA_1996 = "sources/legal/raw/historical-usc/statutes/PLAW-104publ208.htm"
gov_capture = next(c for c in json.loads((ROOT / "sources/legal/raw/historical-usc/govinfo/manifest.json").read_text())["records"]
                   if c["file"] == GOVINFO_1995)
CAPTURES[GOVINFO_1995] = {**gov_capture, "url": gov_capture["source"], "capturedAt": DATE}
for file, public_law in [(AEDPA_1996, "104publ132"), (IIRIRA_1996, "104publ208")]:
    CAPTURES[file] = {"file": file,
                      "url": f"https://www.govinfo.gov/content/pkg/PLAW-{public_law}/html/PLAW-{public_law}.htm",
                      "capturedAt": DATE}

base1254 = members["1254"]["body"][0]["text"]
old_a = "section 1251(a)(4)(D) of this title"
new_a = "subparagraph (B) or (D) of section 241(a)(4)"
old_e = "who is deportable because of a conviction for an aggravated felony"
new_e = "who is deportable under section 241(a)(4)(B) or because of a conviction for an aggravated felony"
assert base1254.count(old_a) == base1254.count(old_e) == 1
final1254 = base1254.replace(old_a, new_a).replace(old_e, new_e)
assert final1254.count(new_a) == final1254.count(new_e) == 1
markers1254 = list(re.finditer(r"(?m)^\(([a-z]|\d+)\) ", final1254))
units1254 = []
parent1254 = None
for index, marker in enumerate(markers1254):
    designation = marker[1]
    if designation.isalpha():
        parent1254 = designation
        path = [designation]
    else:
        assert parent1254
        path = [parent1254, designation]
    end = markers1254[index + 1].start() if index + 1 < len(markers1254) else len(final1254)
    units1254.append({"path": path, "text": final1254[marker.end():end].strip()})
assert [u["path"] for u in units1254 if len(u["path"]) == 1] == [[x] for x in "abcdefg"]
assert any(u["path"] == ["a", "3"] for u in units1254)
assert "\n\n".join(f"({u['path'][-1]}) {u['text']}" for u in units1254) == final1254.strip()
law132 = re.sub(r"\s+", " ", (ROOT / AEDPA_1996).read_text())
law208 = re.sub(r"\s+", " ", (ROOT / IIRIRA_1996).read_text())
assert "striking ``section 241(a)(4)(D)'' and inserting" in law132
assert "``subparagraph (B) or (D) of section 241(a)(4)''" in law132
assert "inserting ``under section 241(a)(4)(B) or''" in law132
assert "shall take effect on the date of the enactment of this" in law132
assert "Strike section 244 (8 U.S.C. 1254)" in law208
assert "first day of the first month beginning more" in law208
add("1254", "Suspension of deportation", units1254, GOVINFO_1995, [161], 1995,
    "1996-04-24", sourceUrl=capture(GOVINFO_1995)["url"],
    sourceLocator="GovInfo USCODE-1995-title8, documentid:8_1254",
    versionLabel="Former 8 U.S.C. § 1254: 1995 official Code text with Pub. L. 104-132 § 413(b)–(c) amendments effective April 24, 1996",
    validFromDate="1996-04-24", validThroughDate="1997-03-31",
    amendmentSources=[{"label": "Pub. L. 104-132 § 413(b)–(c), (g): final text and effective date", **capture(AEDPA_1996)},
                      {"label": "Pub. L. 104-208 § 308(b)(7), § 309(a): general repeal effective April 1, 1997", **capture(IIRIRA_1996)}],
    historicalEditorialNote="The general repeal became effective April 1, 1997. Pub. L. 104-208 § 309(c) preserves former procedures for certain proceedings already pending on that date; the interval here describes the generally operative pre-repeal version, not every transitional application.",
    transcriptionNote="The complete born-digital 1995 GovInfo Code text was compared with Pub. L. 104-132 § 413(b)–(c), (g). Only the two enacted substitutions are incorporated. The changed clauses retain the Act's INA section 241 cross-references, while unchanged clauses retain the Code's title 8 references. Pub. L. 104-208 § 308(b)(7) and § 309(a), (c) establish the general repeal boundary and transition caveat.")
SECTIONS[-1].pop("sourcePdfPages")  # This capture is native GovInfo HTML, not a PDF.

captures = {r["sourceArtifact"]: capture(r["sourceArtifact"]) for r in SECTIONS}
for section in SECTIONS:
    for entry in section.get("amendmentSources", []):
        captures[entry["file"]] = capture(entry["file"])
result = {"schemaVersion": 1, "reviewedAt": DATE, "reviewMethod": "Comparison to official Code and Statutes at Large page images retained in audits/usc-history-2026-10-11/sources; final § 1254 reconstructed from captured native GovInfo Code and public-law HTML", "captures": list(captures.values()), "sections": SECTIONS}
(ROOT / "sources/legal/historical-usc-reviewed.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
print(f"Wrote {len(SECTIONS)} reviewed historical sections")
