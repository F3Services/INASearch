#!/usr/bin/env python3
"""Generate reviewable per-section Title 8 history from captured official sources."""
import csv
import hashlib
import json
import re
from difflib import SequenceMatcher
from collections import defaultdict
from pathlib import Path

import fitz
from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parent.parent
SOURCES = ROOT / 'sources/legal'
NOTES = list(csv.DictReader((SOURCES / 'usc-disposition-notes.tsv').open(), delimiter='\t'))
INVENTORY = json.loads((SOURCES / 'usc-status-inventory.json').read_text())
LOC = json.loads((SOURCES / 'raw/historical-usc/loc/manifest.json').read_text())['records']
GOV = json.loads((SOURCES / 'raw/historical-usc/govinfo/manifest.json').read_text())['records']
BY_GROUP = defaultdict(list)
for row in NOTES:
    BY_GROUP[row['group_section']].append(row)

TOKEN = r'\d+[a-z]?(?:[–-]\d+)?'
LEAD = re.compile(r'^(?:Codification\s+)?Sections?\s+((?:' + TOKEN + r')(?:\s*(?:to|and|,)\s*(?:' + TOKEN + r'))*)', re.I)
ANY_SECTION = re.compile(r'\b[Ss]ections?\s+(' + TOKEN + r')')
HEADING = re.compile(r'(?m)^(?:§\s*|Section\s+)(' + TOKEN + r')\s*[.\-](?![ \t]*\d+[ \t]+Stat\b)[ \t]*')
BAD_TITLE = re.compile(r'^(?:Repealed|Omitted|Transferred|Same;?$|See |\[)', re.I)
EDITORIAL = re.compile(r'(?im)^(?:DERIVATION|CROSS REFERENCES|AMENDMENTS|EFFECTIVE DATE|TRANSFER OF FUNCTIONS|CODI(?:F)?ICATION|REPEALS?|EDITORIAL NOTES|REFERENCES IN TEXT|SIMILAR PROVISIONS|SEPARABILITY.*|SHORT TITLE|TERMINATION OF HOSTILITIES)\s*$')
SOURCE_CREDIT = re.compile(r'\(\s*(?:(?:Jan|Feb|Mar|Apr|May|June|July|Aug|Sept|Sep|Oct|Nov|Dec)\.?\s+\d|R\.\s*S\.\s*§)', re.I)
EDITORIAL_LABELS = ('CODIFICATION', 'REFERENCES IN TEXT', 'CROSS REFERENCES', 'DERIVATION',
                    'AMENDMENTS', 'AMENDMENT', 'REPEALS', 'EFFECTIVE DATE',
                    'SIMILAR PROVISIONS', 'TERMINATION OF HOSTILITIES', 'HISTORY')


def fuzzy_editorial_boundary(fragment):
    for match in re.finditer(r'(?m)^([^\n]{4,42})$', fragment):
        line = match[1].strip()
        letters = re.sub(r'[^A-Za-z]', '', line)
        if len(letters) < 6 or len(letters) > 30: continue
        if sum(c.isupper() for c in letters) / len(letters) < .48: continue
        value = re.sub(r'[^A-Z]', '', line.upper())
        if max(SequenceMatcher(None, value, re.sub(r'[^A-Z]', '', label)).ratio()
               for label in EDITORIAL_LABELS) >= .63:
            return match.start()
    return None


def norm(s):
    return s.replace('-', '–')


def key(s):
    m = re.match(r'(\d+)([a-z]?)(?:[–-](\d+))?', s)
    return (int(m[1]), m[2], int(m[3] or 0))


def expand(a, b):
    a, b = norm(a), norm(b)
    ma, mb = re.fullmatch(r'(\d+)([a-z]?)', a), re.fullmatch(r'(\d+)([a-z]?)', b)
    if ma and mb:
        if ma[1] == mb[1] and ma[2] and mb[2]:
            return [ma[1] + chr(c) for c in range(ord(ma[2]), ord(mb[2]) + 1)]
        if int(mb[1]) - int(ma[1]) <= 100 and int(mb[1]) >= int(ma[1]):
            out = [str(n) for n in range(int(ma[1]), int(mb[1]) + 1)]
            if ma[2]: out[0] = a
            if mb[2]: out.append(b)
            return out
    ma, mb = re.fullmatch(r'(\d+)[–-](\d+)', a), re.fullmatch(r'(\d+)[–-](\d+)', b)
    if ma and mb and ma[1] == mb[1] and int(mb[2]) - int(ma[2]) <= 100:
        return [ma[1] + '–' + str(n) for n in range(int(ma[2]), int(mb[2]) + 1)]
    return [a, b]


def phrase_members(phrase):
    parts = re.split(r'\s+(?:to|and)\s+|\s*,\s*', phrase)
    operators = re.findall(r'\s+(to|and)\s+|\s*(,)\s*', phrase)
    out = [norm(parts[0])]
    for index, pair in enumerate(operators):
        nxt = norm(parts[index + 1])
        out.extend(expand(out[-1], nxt)[1:] if pair[0] else [nxt])
    return list(dict.fromkeys(out))


def note_members(row):
    text = row['exact_full_text']
    match = LEAD.match(text)
    if match:
        return phrase_members(match[1])
    return []


def descriptive_section_markers(text):
    """Exclude mentions such as 'on the subject of section 381 see ...'."""
    pattern = r'\bSections?\s+((?:' + TOKEN + r')(?:\s*(?:to|and|,)\s*(?:' + TOKEN + r'))*)'
    for match in re.finditer(pattern, text):
        tail = text[match.end():match.end()+90].lstrip()
        tail = re.sub(r'^\([a-z0-9]+\)\s*', '', tail, count=1, flags=re.I)
        if not re.match(r'(?i)^(?:,\s*(?!see\b)|was\b|were\b|related\b|relating\b|provided\b|authorized\b|required\b|permitted\b|repealed\b|omitted\b|transferred\b|is\b|are\b)', tail):
            continue
        yield match


def note_heading(text, number=None):
    if number:
        clauses = []
        found = list(descriptive_section_markers(text))
        for index, match in enumerate(found):
            if number in phrase_members(match[1]):
                end = found[index+1].start() if index + 1 < len(found) else len(text)
                clauses.append((len(phrase_members(match[1])), text[match.start():end]))
        for _, clause in sorted(clauses, key=lambda c: c[0]):
            value = note_heading(clause)
            if value: return value
    text = re.sub(r'\b(Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept|Oct|Nov|Dec|St|No)\.', r'\1·', text)
    for pattern in [r'\brelat(?:ing|ed) to ([^.]+)', r'\b(?:required|authorized|provided for|prohibited|forbidding|making|permitted|defined) ([^.]+)']:
        m = re.search(pattern, text, re.I)
        if m:
            value = m[1].strip(' ,;')
            value = re.split(r', (?:was|were|is|are|which)\b|; see |; See |\. See ', value, maxsplit=1)[0]
            if 5 <= len(value) <= 170: return (value[0].upper() + value[1:]).replace('·', '.')
    return ''


def member_note_excerpt(text, number):
    """Keep only the clause about this member from a shared House note."""
    markers = list(descriptive_section_markers(text))
    own = [i for i, match in enumerate(markers) if number in phrase_members(match[1])]
    if not own:
        return text
    index = min(own, key=lambda i: len(phrase_members(markers[i][1])))
    start = markers[index].start()
    end = markers[index + 1].start() if index + 1 < len(markers) else len(text)
    return text[start:end].strip()


EXPLICIT_OMISSION_REASONS = {
    '15': 'The provision on expatriation is now set out as a note under 8 U.S.C. § 1481.',
    '103': 'The Code note says this provision was transferred to former 5 U.S.C. § 342h, then eliminated from that title when Title 5 was enacted in 1966.',
    '103a': 'The Code note says this 1948 appropriation provision was not repeated in the Department of Justice Appropriation Act, 1949.',
    '112': 'The Code note says this provision was transferred to former 5 U.S.C. § 342i, then eliminated from that title when Title 5 was enacted in 1966.',
    '114': 'The Code note says this provision was also classified to former 5 U.S.C. § 342k, then eliminated from that title when Title 5 was enacted in 1966.',
    '118': 'The Code note says this provision expired with the appropriation act of which it was a part.',
    '131': 'The Code note says this provision was transferred to former 5 U.S.C. § 342a, then eliminated from that title when Title 5 was enacted in 1966.',
    '174': 'The Code note says this provision was transferred to former 5 U.S.C. § 342j, then eliminated from that title when Title 5 was enacted in 1966.',
    '204a': 'The Code note says former § 204b made § 204a inapplicable after June 28, 1934.',
    '204b': 'This was the time-limit provision: the Code note says it made § 204a inapplicable after June 28, 1934.',
    '228': 'The Code expressly says this provision was omitted as executed.',
    '232': 'The Code expressly says this provision expired three years after December 28, 1945.',
    '233': 'The Code expressly says this provision expired three years after December 28, 1945.',
    '234': 'The Code expressly says this provision expired three years after December 28, 1945.',
    '235': 'The Code expressly says this provision expired three years after December 28, 1945.',
    '236': 'The Code expressly says this provision expired three years after December 28, 1945.',
    '239': 'The Code expressly says this provision expired by its own terms on March 19, 1952.',
    '261': 'The Code says this provision became obsolete after repeal of former 8 U.S.C. §§ 262–297 in 1943.',
    '298': 'The Code says this provision became obsolete after repeal of former 8 U.S.C. §§ 262–297 in 1943.',
    '359': 'The Code records a 1943 Immigration and Naturalization Service opinion that former § 359 was superseded by former § 703; the note points to current 8 U.S.C. § 1422.',
    '1440a': 'The Code expressly says this provision became obsolete because petitions had to be filed by December 31, 1955.',
    '1440b': 'The Code expressly says this provision became obsolete because petitions had to be filed by December 31, 1955.',
    '1440c': 'The Code expressly says this provision became obsolete because petitions had to be filed by December 31, 1955.',
    '1440d': 'The Code expressly says this provision became obsolete because petitions had to be filed by December 31, 1955.',
}

# The printed Code uses "Same;" to inherit a subject from an earlier catchline.
# These standalone display titles state that subject while originalTitle retains
# the printed wording and headingOrigin makes the editorial expansion explicit.
CONTEXTUAL_HEADINGS = {
    '2': 'Citizenship of persons born in the Oregon Territory',
    '3': 'Citizenship of Indians, including those who served in the World War',
    '3a': 'Citizenship of Cherokee Indians',
    '3b': 'Citizenship of Indians of Metlakahtla, Alaska',
    '3c': 'Indian citizenship: property rights and rights of the United States',
    '4': 'Citizenship of Hawaiians',
    '5': 'Citizenship of Puerto Ricans',
    '8': 'Citizenship of children born abroad to alien parents upon a parent’s naturalization',
    '10': 'Citizenship of women marrying citizens: effect of repeal of former law',
    '12': 'Loss of citizenship by desertion during the Civil War',
    '16': 'Right of expatriation during time of war',
    '17': 'Presumption of expatriation through foreign naturalization or allegiance',
    '17a': 'Renunciation of United States citizenship upon marriage to a foreigner',
    '45': 'Prosecution of violations of civil rights protections',
    '46': 'Review of civil rights enforcement proceedings',
    '48': 'Action for neglect to prevent civil rights violations',
    '53': 'Fees of persons appointed to execute civil rights process',
    '72': 'Alien ownership of land in Territories: prior holdings and exceptions',
    '73': 'Alien ownership of land in Territories: inheritance and debt collection',
    '74': 'Alien ownership of land in Territories: conveyance before escheat',
    '75': 'Alien ownership of land in Territories: escheat proceedings',
    '76': 'Alien ownership of land in Territories: condemnation and sale after escheat',
    '77': 'Alien ownership of land in Territories: public lands excluded',
    '78': 'Alien ownership of land: application of territorial rights to District of Columbia',
    '84': 'Hawaii public land: restrictions on conveyance or transfer to aliens',
    '85': 'Hawaii public land: preference for persons declaring intent to become citizens',
    '86': 'Hawaii agricultural land: sale to persons declaring intent to become citizens',
    '106c': 'Effect of alien registry record on lawful permanent residence',
    '112': 'Officer and clerk enforcing alien contract labor laws',
    '137c': 'When alien instrumental musicians qualify as artists or professional actors',
    '204d': 'Definitions for Virgin Islands immigration provisions',
    '212c': 'Persons of races indigenous to India: definitions and quota allocation',
    '264': 'Chinese laborers: exemptions from suspension and certificate requirements',
    '276': 'Chinese laborers: conditions for return after departure',
    '278': 'Chinese laborers: regulations for return',
    '291': 'Chinese exclusion cases: commissioner hearing fees',
    '365': 'Naturalization of persons unable to speak English',
    '403': 'Naturalization fees during war',
    '703': 'Racial eligibility for naturalization',
    '704': 'English-language requirement for naturalization',
    '707': 'Residence requirements for naturalization',
    '708': 'Residence of clergymen and nuns temporarily absent for professional work',
    '712': 'Naturalization of alien spouse of United States citizen stationed abroad',
    '714': 'Citizenship of children born abroad to alien parents or a parent who lost United States citizenship',
    '715': 'Naturalization of child born abroad with one United States citizen parent',
    '734': 'Final hearings on naturalization petitions',
    '743': 'Postage-free mail for naturalization matters',
}


# Each correction was checked against the cited LOC page image. Keep the
# printed catchline in historical.originalTitle after correcting the OCR.
TITLE_OCR_CORRECTIONS = {
    '176': ('txpenses', 'expenses'),
    '229': ('theieof', 'thereof'),
    '233': ('immigrant,', 'immigrant.'),
    '377a': ('Declaraton', 'Declaration'),
    '387': ('natu ralization', 'naturalization'),
    '394': ('Hearing df', 'Hearing of'),
    '453': ('governing, registration', 'governing registration'),
    '502': ('subchapter Ill', 'subchapter III'),
    '903a': ('abroad,', 'abroad.'),
}
TITLE_OCR_CORRECTIONS['377a'] = [TITLE_OCR_CORRECTIONS['377a'], ('Isands', 'Islands')]
FIRST_SUBDIVISION_CAPTIONS = {
    '167', '202', '207', '209', '211', '212', '213', '220',
    '399b', '399c', '459', '746',
}


def correct_printed_title(number, title, historical_data):
    corrections = TITLE_OCR_CORRECTIONS.get(number, [])
    if isinstance(corrections, tuple): corrections = [corrections]
    for ocr, printed in corrections:
        if ocr not in title and printed in title and printed in historical_data['originalTitle']:
            continue  # An older, operative edition already has the correct print.
        assert ocr in title and ocr in historical_data['originalTitle'], (number, ocr)
        title = title.replace(ocr, printed)
        historical_data['originalTitle'] = historical_data['originalTitle'].replace(ocr, printed)
        historical_data.setdefault('transcriptionCorrections', []).append(
            {'field': 'originalTitle', 'ocr': ocr, 'printed': printed,
             'basis': 'verified against the source page image'})
    return title.rstrip('.')


def restore_first_subdivision_caption(number, title, body, historical_data):
    if number not in FIRST_SUBDIVISION_CAPTIONS: return title, body
    marker = re.search(r'\(a\)\s*', title)
    assert marker and not body.lstrip().startswith('(a)'), number
    heading = title[:marker.start()].rstrip(' -.')
    caption = title[marker.end():].strip().rstrip('.')
    assert caption and body.strip(), number
    if not heading:
        # §§ 399b–399c print only a subdivision caption, not an independent
        # section catchline. Its wording supplies the standalone display title.
        heading = caption
        historical_data['headingOrigin'] = 'derived-subdivision-caption'
        historical_data['headingEvidence'] = 'The printed Code begins this section with an (a) caption and has no separate section catchline.'
    return heading, f'(a) {caption}.\n\n{body}'


def omission_reason(number, explanation, note_ids, source_url):
    evidence = member_note_excerpt(explanation, number)
    known = number in EXPLICIT_OMISSION_REASONS
    if known:
        reason_text = EXPLICIT_OMISSION_REASONS[number]
    else:
        reason_text = f'The Code omits former 8 U.S.C. § {number} but does not state a reason for this section’s omission.'
        if evidence:
            reason_text += ' Its note says: ' + evidence
    return {'text': reason_text, 'sourceUrl': source_url, 'sourceNoteIds': note_ids,
            'reasonKnown': known, 'evidenceText': evidence}


def reflow_ocr_body(text):
    """Remove print-column wraps without altering blank lines or subdivisions."""
    output = []
    current = ''
    pending_break = False
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            pending_break = True
            continue
        if not current:
            current = line
            pending_break = False
            continue
        subdivision = bool(re.match(r'^(?:\([a-z0-9]+\)|\d+[.]|[A-Z][.])\s+', line))
        if subdivision or (pending_break and re.search(r'[.!?;:]$', current)):
            output.append(current)
            current = line
        elif current.endswith(('-', '¬')) and re.match(r'^[a-z]', line):
            current = current[:-1] + line
        else:
            current += ' ' + line
        pending_break = False
    if current: output.append(current)
    return '\n\n'.join(output).strip()


def page_text(record):
    doc = fitz.open(ROOT / record['file'])
    return '\n'.join(f'\n<<PDF PAGE {i + 1}>>\n' + page.get_text() for i, page in enumerate(doc))


def split_heading_body(fragment):
    fragment = fragment.lstrip("'’ ").strip()
    # Some print headings put a dash after the heading period, before the body.
    fragment = re.sub(r'\.[ \t]*[-–][ \t]*\n', '.\n', fragment, count=1)
    endings = [m.end() for m in re.finditer(r'[.]["”\']?\s*\n', fragment[:500])]
    starters = [m.start() + 1 for m in re.finditer(r'\n(?=(?:For the purpose|Regardless of|Any |The |No |Every |All |A person|It shall|Such |There |Nothing |Whoever )\b)', fragment[:500])]
    sentence = [m.end() for m in re.finditer(r'\.\s+(?=[A-Z])', fragment[:500])
                if not re.search(r'(?:U\.S|No|St|Mr|Mrs|Dr)\.$', fragment[:m.start()+1])]
    split = min(endings + starters + sentence) if endings or starters or sentence else None
    if split is None:
        m = re.search(r'\.\s+(?=\S)', fragment)
        if m: split = m.end()
    if split is None: return '', ''
    title = fragment[:split].strip().rstrip('. ')
    body = fragment[split:].strip()
    title = re.sub(r'(?<=[a-z])[-¬]\s*\n\s*(?=[a-z])', '', title)
    title = re.sub(r'\s+', ' ', title)
    return title, body


def extract_loc():
    by_section = defaultdict(list)
    for rec in LOC:
        text = page_text(rec)
        chapter_limits = {1:(1,18), 2:(31,32), 3:(41,56), 4:(61,65), 5:(71,86),
                          6:(100,246), 7:(261,299), 8:(331,339), 9:(351,416),
                          10:(451,460), 11:(501,1006), 12:(1101,9999)}
        starts = [m for m in HEADING.finditer(text)
                  if chapter_limits[rec['chapter']][0] <= int(re.match(r'\d+', m[1])[0]) <= chapter_limits[rec['chapter']][1]]
        for index, match in enumerate(starts):
            number = norm(match[1])
            number_base = int(re.match(r'\d+', number)[0])
            # A section body must follow the heading, rather than a table-of-contents row.
            end = starts[index + 1].start() if index + 1 < len(starts) else len(text)
            fragment = text[match.end():end]
            if len(fragment) < 80 or re.match(r'\s*\d+[.]\s', fragment): continue
            first_line_end = fragment.find('\n')
            e = EDITORIAL.search(fragment, first_line_end + 1)
            if e: fragment = fragment[:e.start()]
            fuzzy = fuzzy_editorial_boundary(fragment[first_line_end+1:])
            if fuzzy is not None: fragment = fragment[:first_line_end+1+fuzzy]
            chapter_end = re.search(r'(?m)^Chapter\s+\d+[.,\-]', fragment)
            if chapter_end: fragment = fragment[:chapter_end.start()]
            # Strip page markers and page header/footer lines while retaining the OCR text.
            fragment = re.sub(r'<<PDF PAGE \d+>>', '', fragment)
            fragment = re.sub(r'(?im)^\s*[^\n]{0,25}ALIENS AND NATIO[^\n]*$', '', fragment)
            fragment = re.sub(r'(?im)^\s*S?TITL?E?\s*8[.,\-][^\n]*$', '', fragment)
            fragment = re.sub(r'(?m)^Page\s*[,.:]?\s*\d+[^\n]*$', '', fragment)
            fragment = re.sub(r'(?m)^§\s*\d+[a-z]?\s*$', '', fragment)
            fragment = re.sub(r'(?m)^\s*\d{3,4}\s*$', '', fragment)
            fragment = re.sub(r'(?m)^\s*1\s+\d{2,4}\s*$', '', fragment)
            # OCR occasionally corrupts all-cap editorial and following chapter
            # headings. They are never part of a numbered section's operative text.
            upper = re.search(r'(?m)^[A-Z0-9][A-Z0-9 .,;:–-]{3,}$', fragment)
            if upper and len(re.findall(r'[A-Z]', upper[0])) >= 4:
                fragment = fragment[:upper.start()]
            fragment = fragment.strip()
            if len(fragment) < 80: continue
            title, body = split_heading_body(fragment)
            # A wrapped status such as "[Re-\npealed.]" is still an
            # editorial placeholder, not a surviving statutory body.
            body_start = re.sub(r'(?<=\w)-\s*\n\s*(?=\w)', '', body).lstrip()
            body_start = re.sub(r'\s+', ' ', body_start)
            if re.match(r'(?is)^(?:\[\s*(?:Repealed|Executed|Omitted|Transferred)\b|This section\b|Sections?\s*[,;(]|Subject matter of this\b|Commissioners of immigration at the several ports, for whose appointment this section\b)', body_start): continue
            credit = None
            credit_start = SOURCE_CREDIT.search(body)
            if credit_start and (re.search(r'\bStat[.,]', body[credit_start.start():credit_start.start()+600])
                                 or re.match(r'\(\s*R\.\s*S\.', body[credit_start.start():], re.I)):
                credit_end = body.find(')', credit_start.start())
                credit = body[credit_start.start():credit_end+1] if credit_end >= 0 else body[credit_start.start():]
                body = body[:credit_start.start()].rstrip()
            if not credit:
                unparenthesized = re.search(r'(?m)^(?:Jan|Feb|Mar|Apr|May|June|July|Aug|Sept|Oct|Nov|Dec)\.?\s+\d.{0,200}?Stat[.,]', body, re.S)
                if unparenthesized and unparenthesized.start() > 100:
                    credit = body[unparenthesized.start():].strip()
                    body = body[:unparenthesized.start()].rstrip()
            if (not title or 'This section' in title or
                re.match(r'^(?:relat(?:ed|ing)|\d|Jan\.|Feb\.|Mar\.|Apr\.|May |June |July |Aug\.|Sept\.|Oct\.|Nov\.|Dec\.)', title, re.I)
                    or len(title) > 300 or len(body) < 40): continue
            if BAD_TITLE.match(title) and not title.lower().startswith('same;'): continue
            page_match = list(re.finditer(r'<<PDF PAGE (\d+)>>', text[:match.start()]))
            page = int(page_match[-1][1]) if page_match else 1
            by_section[number].append((rec['edition'], len(body), title, body, rec, page, credit))
    return {section: max(rows, key=lambda r: (r[0], r[1])) for section, rows in by_section.items()}


def extract_loc_heading_only():
    by_section = defaultdict(list)
    chapter_limits = {1:(1,18), 2:(31,32), 3:(41,56), 4:(61,65), 5:(71,86),
                      6:(100,246), 7:(261,299), 8:(331,339), 9:(351,416),
                      10:(451,460), 11:(501,1006), 12:(1101,9999)}
    for rec in LOC:
        text = page_text(rec)
        starts = [m for m in HEADING.finditer(text)
                  if chapter_limits[rec['chapter']][0] <= int(re.match(r'\d+', m[1])[0]) <= chapter_limits[rec['chapter']][1]]
        for index, match in enumerate(starts):
            number = norm(match[1])
            number_base = int(re.match(r'\d+', number)[0])
            if not (chapter_limits[rec['chapter']][0] <= number_base <= chapter_limits[rec['chapter']][1]): continue
            end = starts[index+1].start() if index + 1 < len(starts) else len(text)
            fragment = text[match.end():end]
            title, _ = split_heading_body(fragment)
            if not title or len(title) > 300 or re.match(r'^(?:relat(?:ed|ing)|\d|Repealed|Omitted|Transferred)', title, re.I): continue
            page_match = list(re.finditer(r'<<PDF PAGE (\d+)>>', text[:match.start()]))
            page = int(page_match[-1][1]) if page_match else 1
            by_section[number].append((rec['edition'], title, rec, page))
    return {section: max(rows, key=lambda r: r[0]) for section, rows in by_section.items()}


def extract_gov():
    by_section = defaultdict(list)
    marker = re.compile(r'<!-- documentid:8_([0-9]+[a-z]?(?:[-–][0-9]+)?)\s+[^>]*-->')
    for rec in GOV:
        html = (ROOT / rec['file']).read_text(errors='replace')
        matches = list(marker.finditer(html))
        for i, match in enumerate(matches):
            number = norm(match[1])
            fragment = html[match.end(): matches[i+1].start() if i+1 < len(matches) else len(html)]
            heading = re.search(r'<!-- field-start:head -->(.*?)<!-- field-end:head -->', fragment, re.S)
            statute = re.search(r'<!-- field-start:statute -->(.*?)<!-- field-end:statute -->', fragment, re.S)
            if not heading or not statute: continue
            title = BeautifulSoup(heading[1], 'lxml').get_text(' ', strip=True)
            # A following grouped document has a different marker shape.
            # Never borrow its head/statute fields for a preceding single.
            if not re.match(r'^§\s*' + re.escape(number) + r'\.', title): continue
            title = re.sub(r'^§+\s*' + re.escape(number) + r'[.]?\s*', '', title).strip()
            if BAD_TITLE.match(title): continue
            block = BeautifulSoup(statute[1], 'lxml')
            paragraphs = [tag.get_text(' ', strip=True) for tag in block.find_all(['h4', 'p'])]
            body = '\n\n'.join(p for p in paragraphs if p)
            if len(body) < 40: continue
            by_section[number].append((rec['year'], len(body), title, body, rec, None))
    return {section: max(rows, key=lambda r: (r[0], r[1])) for section, rows in by_section.items()}


def extract_security_act_1950():
    file = 'sources/legal/raw/historical-usc/statutes/STATUTE-64-Pg987.pdf'
    path = ROOT / file
    if not path.exists(): return {}, None
    source = {'file': file, 'source': 'https://www.govinfo.gov/content/pkg/STATUTE-64/pdf/STATUTE-64-Pg987.pdf',
              'bytes': path.stat().st_size, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}
    doc = fitz.open(path)
    pages = []
    for page_index in range(19, 24):
        # The edition alternates side notes between margins; substantive text
        # is the long central block, regardless of its x coordinate.
        page = '\n'.join(b[4] for b in doc[page_index].get_text('blocks')
                         if len(b[4]) > 250 and b[0] < 400)
        page = re.sub(r'(?m)^98352°—51—pt\s*\.\s*I[-—– ]*64\s*$', '', page)
        pages.append((page_index + 1, page))
    joined = '\n'.join(page for _, page in pages)
    start = joined.find('Sec . 22.')
    if start < 0: raise ValueError('1950 security act §22 was not found')
    joined = joined[start:]
    outer_end = joined.find('\nSec . 23.')
    if outer_end < 0: raise ValueError('1950 security act §23 boundary was not found')
    joined = joined[:outer_end]
    quoted = list(re.finditer(r'“Sec\s*\.\s*([2-9])\.', joined))
    if [int(m[1]) for m in quoted] != list(range(2, 10)):
        raise ValueError('1950 security act quotation boundaries are incomplete')
    first = joined.find('amended to read as follows: “That')
    if first < 0: raise ValueError('1950 security act §1 start was not found')
    segments = {'137': (first + len('amended to read as follows: “'), quoted[0].start())}
    for i, match in enumerate(quoted):
        number = '137–' + str(int(match[1]) - 1)
        end = quoted[i+1].start() if i+1 < len(quoted) else re.search(r'\n[“"]?Sec\s*\.\s*10\.', joined[match.end():]).start() + match.end()
        segments[number] = (match.end(), end)
    result = {}
    for number, (lo, hi) in segments.items():
        body = joined[lo:hi].strip().rstrip('”').strip()
        body = re.sub(r'(?m)^“', '', body)
        body = re.sub(r'\s+', ' ', body)
        if len(body) < 70: raise ValueError(f'1950 security act §{number} body too short')
        result[number] = {'body': body, 'source': source, 'sourceUrl': source['source'] + '#page=20',
                          'versionLabel': '1950 amended Act of October 16, 1918 (64 Stat. 1006–1010)'}
    return result, source


def reviewed_1951_sections():
    file = 'sources/legal/raw/historical-usc/statutes/STATUTE-65-Pg28.pdf'
    path = ROOT / file
    if not path.exists(): return {}
    source = {'file': file, 'source': 'https://www.govinfo.gov/content/pkg/STATUTE-65/pdf/STATUTE-65-Pg28.pdf',
              'bytes': path.stat().st_size, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}
    sections = {
        '137–9': ('Clarification of immigration status of certain aliens',
                  'That the Attorney General is hereby authorized and directed to provide by regulations that the terms '
                  '“members of” and “affiliated with” where used in the Act of October 16, 1918, as amended, shall include '
                  'only membership or affiliation which is or was voluntary, and shall not include membership or affiliation '
                  'which is or was solely (a) when under sixteen years of age, (b) by operation of law, or (c) for purposes '
                  'of obtaining employment, food rations, or other essentials of living, and where necessary for such purposes.'),
        '137–10': ('Recordation of entry for permanent residence',
                   'The Attorney General is authorized in his discretion to record the entry of any alien to have been for '
                   'permanent residence in any case where the alien heretofore, when applying for admission for permanent '
                   'residence, was temporarily admitted pursuant to the ninth proviso of section 3 of the Immigration Act '
                   'of February 5, 1917, as amended, and whose inadmissibility for permanent residence was determined to '
                   'be solely by reason of membership or affiliation (other than membership or affiliation related to '
                   'communism) under subsection 2 of section 1 of the Act of October 16, 1918, as amended.')}
    return {number: {'title': title, 'body': body, 'source': source, 'sourceUrl': source['source'],
                     'versionLabel': '1951 act, 65 Stat. 28', 'reviewStatus': 'visually-reviewed',
                     'headingOrigin': 'editorial-description',
                     'headingEvidence': '1952 U.S. Code historical note describing this section; the 1951 act has no section heading.'}
            for number, (title, body) in sections.items()}


def former_sections_quoted_in_1946():
    source = next(r for r in LOC if r['edition'] == 1946 and r['chapter'] == 11)
    text = page_text(source)
    markers = list(re.finditer(r'["“]§\s*(389a|392[abcd])\.', text))
    if [m[1] for m in markers] != ['389a', '392a', '392b', '392c', '392d']:
        raise ValueError('1946 Code quotation of former naturalization sections is incomplete')
    result = {}
    for index, marker in enumerate(markers):
        end = markers[index+1].start() if index + 1 < len(markers) else text.find('CROSS REERENCES', marker.end())
        fragment = text[marker.end():end]
        title, body = split_heading_body(fragment)
        citation = SOURCE_CREDIT.search(body)
        if not citation or not re.search(r'\bStat[.,]', body[citation.start():citation.start()+600]):
            raise ValueError(f'1946 Code quote §{marker[1]} missing source citation')
        credits = body[citation.start():].strip().rstrip('”"').strip()
        body = body[:citation.start()].strip()
        if len(body) < 80: raise ValueError(f'1946 Code quote §{marker[1]} body too short')
        page = len(re.findall(r'<<PDF PAGE \d+>>', text[:marker.start()]))
        heading = ('Alien veterans of World War; ' + title[6:]) if title.startswith('Same; ') else title
        result[marker[1]] = {'title': heading, 'originalTitle': title, 'body': body,
                             'source': source, 'sourceUrl': source['source'] + f'#page={page}',
                             'versionLabel': '1946 U.S. Code quotation of former section',
                             'reviewStatus': 'unreviewed-ocr', 'sourceCredits': credits}
        if heading != title:
            result[marker[1]]['headingOrigin'] = 'expanded-code-reference'
            result[marker[1]]['headingEvidence'] = 'The printed former heading begins “Same”; the subject is expanded from the preceding § 392b heading.'
    return result


def visually_reviewed_acts():
    specifications = {
        '370': {
            'file': 'STATUTE-42-Pg1021-link.pdf', 'url': 'https://www.govinfo.gov/link/statute/42/1021?link-type=pdf',
            'page': 2, 'title': 'Women married to persons ineligible to citizenship',
            'body': 'That no woman whose husband is not eligible to citizenship shall be naturalized during the continuance of the marital status.',
            'versionLabel': '1922 Cable Act, 42 Stat. 1022',
            'headingEvidence': 'The 1934 U.S. Code printed “Same; women married to persons ineligible to citizenship” as the former § 370 caption.'},
        '382a': {
            'file': 'STATUTE-49-Pg1925-link.pdf', 'url': 'https://www.govinfo.gov/link/statute/49/1925?link-type=pdf',
            'page': 1, 'title': 'Absence from country; continuity of residence for naturalization',
            'body': 'No period of residence outside the United States during the five years immediately preceding the enactment of this Act shall be held to have broken the continuity of residence required by the naturalization laws if the alien proves to the satisfaction of the Secretary of Labor and the court that during all such period of absence he has been under employment by, or contract with, the United States, or such American institution of research, or American firm or corporation, described in section 1 hereof, and has been carrying on the activities described in this Act in their behalf.',
            'versionLabel': '1936 Naturalization Act amendment, 49 Stat. 1925–1926',
            'headingEvidence': 'The 1952 U.S. Code note describes this unheaded § 2 as addressing absences and continuity of residence.'},
        '382b': {
            'file': 'STATUTE-53-Pg1273.pdf', 'page': 1, 'title': 'Temporary absence of alien clergyman; residence for naturalization',
            'body': 'That any alien who has been lawfully admitted into the United States for permanent residence and who has heretofore been or may hereafter be absent temporarily from the United States solely in his or her capacity as a regularly ordained clergyman, shall be considered as residing in the United States for the purpose of naturalization notwithstanding any such absence from the United States, but he or she shall in all other respects comply with the requirements of the naturalization laws. Such alien shall prove to the satisfaction of the Secretary of Labor and the naturalization court that his or her absence from the United States has been solely in the capacity hereinbefore described.',
            'versionLabel': '1939 Naturalization Act, 53 Stat. 1273',
            'headingEvidence': 'The act caption and the 1952 U.S. Code note describe this unheaded § 1.'},
        '382c': {
            'file': 'STATUTE-53-Pg1273.pdf', 'page': 1, 'title': 'Regulations for temporary absences of alien clergymen',
            'body': 'The Commissioner of Immigration and Naturalization, with the approval of the Secretary of Labor, shall prescribe such rules and regulations as may be necessary for the enforcement of this Act.',
            'versionLabel': '1939 Naturalization Act, 53 Stat. 1273',
            'headingEvidence': 'The 1952 U.S. Code note associates unheaded § 2 with temporary absences of clergymen.'},
        '392e': {
            'file': 'STATUTE-49-Pg397.pdf', 'page': 1, 'title': 'Naturalization of certain resident alien World War veterans formerly ineligible because of race',
            'body': 'That notwithstanding the racial limitations contained within section 2169 of the Revised Statutes of the United States, as amended (U. S. C., title 8, sec. 359), and within section 14 of the Act of May 6, 1882, as amended (U. S. C., title 8, sec. 363), any alien veteran of the World War heretofore ineligible to citizenship because not a free white person or of African nativity or of African descent may be naturalized under this Act if he—\n(a) Entered the service of the armed forces of the United States prior to November 11, 1918;\n(b) Actually rendered service with the armed forces of the United States between April 6, 1917, and November 11, 1918;\n(c) Received an honorable discharge from such service for any reason other than his alienage;\n(d) Resumed his previous permanent residence in the United States or any Territory thereof; and\n(e) Has maintained a permanent residence continuously since the date of discharge and is now a permanent resident of the United States or any Territory thereof; upon compliance with all the requirements of the naturalization laws, except—\n(f) No certificate of arrival and no declaration of intention shall be required;\n(g) No additional residence shall be required before the filing of petition for certificate of citizenship; and\n(h) The petition for certificate of citizenship shall be filed with a court having naturalization jurisdiction prior to January 1, 1937.',
            'versionLabel': '1935 act, 49 Stat. 397–398',
            'headingEvidence': 'The act caption and 1952 U.S. Code note describe this unheaded § 1.'},
        '392f': {
            'file': 'STATUTE-49-Pg397.pdf', 'page': 2, 'title': 'Validation and replacement of World War veteran citizenship certificates',
            'body': 'Certificates of citizenship heretofore issued and heretofore granted by any court having naturalization jurisdiction under the provisions of the Act of May 9, 1918, or of the Act of July 19, 1919, to any alien veteran who is eligible to be naturalized under the provisions of section 1 of this Act, and orders or judgments authorizing such certificates, are hereby declared to be valid for all purposes insofar as the race of the veteran is concerned. Such certificates may be stamped, declaring their validity under this Act, by the Commissioner of Immigration and Naturalization upon submission of satisfactory proof to establish identity.\nCertificates declared valid under the foregoing paragraph, which have been lost, mutilated, destroyed, or surrendered to any official of the United States may be replaced by a new certificate bearing date of original certificate upon compliance with the provisions of section 32 (a) of the Act of June 29, 1906, as amended.',
            'versionLabel': '1935 act, 49 Stat. 398',
            'headingEvidence': 'The act § 2 is unheaded; this description follows its printed operative text.'},
        '392g': {
            'file': 'STATUTE-49-Pg397.pdf', 'page': 2, 'title': 'Waiver of naturalization-document fees for certain World War veterans',
            'body': 'On applications filed for any benefits under this Act, the requirement of fees for naturalization documents is hereby waived.',
            'versionLabel': '1935 act, 49 Stat. 398',
            'headingEvidence': 'The act § 3 is unheaded; this description follows its printed operative text.'},
        '398a': {
            'file': 'STATUTE-54-Pg178.pdf', 'page': 1, 'title': 'Patriotic address to newly naturalized citizens',
            'body': 'Either at the time of the rendition of the decree of naturalization or at such other time as the judge may fix, the judge or someone designated by him shall address the newly naturalized citizen upon the form and genius of our Government and the privileges and responsibilities of citizenship; it being the intent and purpose of this section to enlist the aid of the judiciary, in cooperation with civil and educational authorities, and patriotic organizations in a continuous effort to dignify and emphasize the significance of citizenship.',
            'versionLabel': '1940 joint resolution, 54 Stat. 178',
            'headingEvidence': 'The 1952 U.S. Code note identifies unheaded § 2 as a patriotic address to new citizens.'},
        '155a': {
            'file': 'STATUTE-64-Pg1044-2.pdf', 'page': 5, 'title': 'Exclusion and expulsion proceedings unaffected by Administrative Procedure Act',
            'body': 'Proceedings under law relating to the exclusion or expulsion of aliens shall hereafter be without regard to the provisions of sections 5, 7, and 8 of the Administrative Procedure Act (5 U. S. C. 1004, 1006, 1007).',
            'versionLabel': '1950 Supplemental Appropriation Act, 64 Stat. 1048',
            'headingEvidence': 'The 1952 U.S. Code historical note describes the effect of this unheaded appropriation provision.'},
        '237': {
            'file': 'STATUTE-61-Pg401.pdf', 'page': 1, 'title': 'Alien spouses of American citizens; racial inadmissibility',
            'body': 'The alien spouse of an American citizen by a marriage occurring before thirty days after the enactment of this Act, shall not be considered as inadmissible because of race, if otherwise admissible under this Act.',
            'versionLabel': '1947 amendment to War Brides Act, 61 Stat. 401',
            'headingEvidence': 'The printed 1947 amendment has no heading for § 6; this description reflects its operative text.'},
        '375a': {
            'file': 'STATUTE-54-Pg715.pdf', 'page': 1, 'title': 'Naturalization of aliens whose childhood was spent in the United States without declaration of intention',
            'body': 'That any alien who at the time of entering the United States is less than sixteen years of age may upon attaining the age of twenty-one years, if eligible to citizenship, be naturalized upon full and complete compliance with all the requirements of the naturalization laws, subject to the following exceptions:\n(a) No declaration of intention shall be required; and\n(b) The petition for naturalization shall be filed within one year after such alien attains the age of twenty-one years.\nSec. 2. Nothing in this Act shall be construed as preventing its application to aliens who entered the United States prior to its enactment.',
            'versionLabel': '1940 act, 54 Stat. 715–716',
            'headingEvidence': 'The act caption describes this unheaded enactment; § 2 is included because the 1952 Code cites both §§ 1–2.'},
        '732a': {
            'file': 'STATUTE-61-Pg121.pdf', 'page': 2, 'title': 'Waiver of appearance for naturalization due to illness or disability',
            'body': 'Before a declaration of intention or petition for naturalization may be made outside of the office of the clerk of court, or before a final hearing on a petition may be held or the oath of allegiance administered outside of open court, the court must satisfy itself that the illness or other disability is sufficiently serious to prevent appearance in the office of the clerk of court or the court and is of a permanent nature, or of a nature which so incapacitates the person as to prevent him from personally appearing in the office of the clerk of court or in court as otherwise required by law.',
            'versionLabel': '1947 act, 61 Stat. 122',
            'headingEvidence': 'The 1952 U.S. Code historical note describes this unheaded § 5 as a waiver of appearance or petition for naturalization.'},
    }
    result = {}
    for number, spec in specifications.items():
        file = 'sources/legal/raw/historical-usc/statutes/' + spec['file']
        path = ROOT / file
        if not path.exists(): continue
        source = {'file': file, 'source': spec.get('url', f'https://www.govinfo.gov/content/pkg/{spec["file"].split("-Pg")[0]}/pdf/{spec["file"]}'),
                  'bytes': path.stat().st_size, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}
        result[number] = {'title': spec['title'], 'body': spec['body'], 'source': source,
                          'sourceUrl': source['source'] + f'#page={spec["page"]}',
                          'versionLabel': spec['versionLabel'], 'reviewStatus': 'visually-reviewed',
                          'headingOrigin': 'editorial-description', 'headingEvidence': spec['headingEvidence']}
        if number == '375a':
            continuation_file = 'sources/legal/raw/historical-usc/statutes/STATUTE-54-Pg716.pdf'
            continuation_path = ROOT / continuation_file
            result[number]['relatedSources'] = [{'file': continuation_file,
                'source': 'https://www.govinfo.gov/content/pkg/STATUTE-54/pdf/STATUTE-54-Pg716.pdf',
                'bytes': continuation_path.stat().st_size,
                'sha256': hashlib.sha256(continuation_path.read_bytes()).hexdigest()}]
    return result


def guam_nationality_section_1950():
    file = 'sources/legal/raw/historical-usc/statutes/STATUTE-64-Pg384-link.pdf'
    path = ROOT / file
    if not path.exists(): return {}
    doc = fitz.open(path)
    first, continuation = doc[0].get_text(), doc[1].get_text()
    start = first.index('“Sec . 206. (a)')
    rest_start = continuation.index('“(d) The Commissioner')
    rest_end = continuation.index('(b) Subsection (a)', rest_start)
    body = first[start:] + '\n' + continuation[rest_start:rest_end]
    body = re.sub(r'(?m)^“', '', body)
    body = re.sub(r'(?m)^\s*“', '', body)
    body = re.sub(r'(?m)^Sec\s*\.\s*206\.\s*', '', body)
    body = re.sub(r'-\n(?=[a-z])', '', body)
    body = re.sub(r'\s*\n\s*', ' ', body).strip().rstrip('”').strip()
    if 'Section 404 (c) of this Act' not in body or len(body) < 1000:
        raise ValueError('1950 Guam nationality § 206 extraction is incomplete')
    source = {'file': file, 'source': 'https://www.govinfo.gov/link/statute/64/384?link-type=pdf',
              'bytes': path.stat().st_size, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}
    return {'606': {'title': 'Citizens by birth in Guam on and after April 11, 1899', 'body': body,
                    'source': source, 'sourceUrl': source['source'] + '#page=1',
                    'versionLabel': '1950 Organic Act of Guam, 64 Stat. 384–385',
                    'reviewStatus': 'unreviewed-ocr', 'headingOrigin': 'code-caption',
                    'headingEvidence': '1952 U.S. Code Title 8 § 606 printed this caption before transferring the text to 48 U.S.C. § 1421l.'}}


def armed_forces_naturalization_1948():
    file = 'sources/legal/raw/historical-usc/statutes/STATUTE-62-Pg281-2.pdf'
    amendment_file = 'sources/legal/raw/historical-usc/statutes/STATUTE-63-Pg282.pdf'
    path, amendment_path = ROOT / file, ROOT / amendment_file
    if not path.exists() or not amendment_path.exists(): return {}
    doc = fitz.open(path)
    first, continuation = doc[1].get_text(), doc[2].get_text()
    start = first.index('“Sec . 324A. (a)')
    end = continuation.index('Sec . 2. The eligibility')
    body = first[start:] + '\n' + continuation[continuation.index('may be naturalized immediately'):end]
    body = re.sub(r'^“Sec\s*\.\s*324A\.\s*', '', body)
    body = re.sub(r'-\n(?=[a-z])', '', body)
    body = body.replace('“', '').replace('”', '')
    body = re.sub(r'\s+', ' ', body).strip()
    if body.count('(1)') < 2 or '(7)' not in body or '(c)' not in body or len(body) < 3000:
        raise ValueError('1948 armed-forces naturalization § 324A extraction is incomplete')
    amendment_text = fitz.open(amendment_path)[0].get_text()
    if 'section 334 (e)' not in body or 'Section 334 (c)' not in amendment_text:
        raise ValueError('1949 correction to § 324A(b)(7) was not found')
    body = body.replace('section 334 (e)', 'section 334 (c)')
    source = {'file': file, 'source': 'https://www.govinfo.gov/content/pkg/STATUTE-62/pdf/STATUTE-62-Pg281-2.pdf',
              'bytes': path.stat().st_size, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}
    amendment = {'file': amendment_file, 'source': 'https://www.govinfo.gov/content/pkg/STATUTE-63/pdf/STATUTE-63-Pg282.pdf',
                 'bytes': amendment_path.stat().st_size, 'sha256': hashlib.sha256(amendment_path.read_bytes()).hexdigest()}
    return {'724a': {'title': 'Naturalization of persons serving in the armed forces during World Wars I and II',
                     'body': body, 'source': source, 'sourceUrl': source['source'] + '#page=2',
                     'versionLabel': '1948 act as corrected in 1949, 62 Stat. 282–283; 63 Stat. 282',
                     'reviewStatus': 'unreviewed-ocr', 'headingOrigin': 'editorial-description',
                     'headingEvidence': 'The 1952 U.S. Code historical note describes this unheaded § 324A.',
                     'relatedSources': [amendment]}}


def reviewed_early_code_sections():
    """Short 1925 provisions checked against the printed LOC page images."""
    source = next(rec for rec in LOC if rec['edition'] == 1925 and rec['chapter'] == 9)
    base = {'source': source, 'versionLabel': '1925 U.S. Code, Title 8',
            'reviewStatus': 'visually-reviewed'}
    entries = {
        '355': (2, 'Report of expenditures',
                'A detailed report of the expenditures under the appropriations for the Bureau of Naturalization shall be annually submitted to Congress at the beginning of each regular session thereof.'),
        '361': (3, 'Residence period necessary',
                'No alien shall be admitted to become a citizen who has not for the continued term of five years next preceding his admission resided within the United States.'),
        '374': (4, 'Declaration of intention not to be made on election day or during preceding thirty days',
                'It shall not be lawful to make a declaration of intention before the clerk of any court on election day or during the period of thirty days preceding the day of holding any election in the jurisdiction of the court.'),
        '375': (4, 'Declaration of intention not required from widow and minor children of alien dying after declaration',
                'When any alien who has declared his intention to become a citizen of the United States dies before he is actually naturalized the widow and minor children of such alien may, by complying with the other provisions of this chapter, be naturalized without making any declaration of intention.'),
        '383': (5, 'Evidence of certain period of residence by deposition',
                'In case the petitioner has not resided in the State, Territory, or the District of Columbia for a period of five years continuously and immediately preceding the filing of his petition he may establish by two witnesses, both in his petition and at the hearing, the time of his residence within the State, provided that it has been for more than one year, and the remaining portion of his five years’ residence within the United States required by law to be established may be proved by the depositions of two or more witnesses who are citizens of the United States, upon notice to the Bureau of Naturalization.'),
    }
    printed_titles = {'355': 'Same; report of expenditures',
                      '361': 'Residence period necessary',
                      '374': 'Same; not to be made on election day, etc.',
                      '375': 'Same; not required from widow and minor children of aliens dying after declaration of intention',
                      '383': 'Same; evidence of certain period of residence by deposition'}
    result = {number: {**base, 'title': title, 'originalTitle': printed_titles[number], 'body': body,
                       'sourceUrl': source['source'] + f'#page={page}'}
              for number, (page, title, body) in entries.items()}
    immigration_source = next(rec for rec in LOC if rec['edition'] == 1925 and rec['chapter'] == 6)
    result['118'] = {'title': 'Motor vehicles for enforcement of immigration and Chinese exclusion laws',
                     'originalTitle': 'Motor vehicles for enforcement of immigration and Chinese exclusion laws',
                     'body': 'The purchase, exchange, use, maintenance, and operation of motor vehicles, and allowances for horses, including motor vehicles and horses owned by immigration officers when used on official business required in the enforcement of the immigration and Chinese exclusion laws outside of the District of Columbia may be contracted for and the cost thereof paid from the appropriation for the enforcement of those laws, under such terms and conditions as the Secretary of Labor may prescribe.',
                     'source': immigration_source, 'sourceUrl': immigration_source['source'] + '#page=4',
                     'versionLabel': '1925 U.S. Code, Title 8', 'reviewStatus': 'visually-reviewed'}
    return result


def quoted_137a():
    source = next(rec for rec in LOC if rec['edition'] == 1952 and rec['chapter'] == 6)
    body = ('Any woman eligible by race to citizenship who has married a citizen of the United States before July 3, 1930, whose husband shall have been a native-born citizen and a member of the military or naval forces of the United States during the World War, and separated therefrom under honorable conditions; if otherwise admissible, shall not be excluded from admission into the United States under section 136 of this title, unless she be excluded under the provisions of that section relating to—\n'
            '(a) Persons afflicted with a loathsome or dangerous contagious disease, except tuberculosis in any form;\n'
            '(b) Polygamy;\n'
            '(c) Prostitutes, procurers, or other like immoral persons;\n'
            '(d) Persons convicted of crime: Provided, That no such wife shall be excluded because of offenses committed during legal infancy, while a minor under the age of twenty-one years, and for which the sentences imposed were less than three months, and which were committed more than five years previous to July 3, 1930;\n'
            '(e) Persons previously deported;\n'
            '(f) Contract laborers.\n'
            'After admission to the United States she shall be subject to all other provisions of former sections 9 and 10 and 367–370 of this title.')
    return {'137a': {'title': 'Married woman whose husband is native-born citizen and veteran of World War',
                     'originalTitle': 'Married woman whose husband is native-born citizen and veteran of World War',
                     'body': body, 'source': source, 'sourceUrl': source['source'] + '#page=3',
                     'versionLabel': 'Former § 137a quoted in the 1952 U.S. Code, Title 8',
                     'reviewStatus': 'unreviewed-ocr'}}


def transferred_238(gov):
    # The later codification note at § 1557 expressly identifies former § 238.
    row = gov.get('1557')
    if not row: return {}
    source = row[4]
    return {'238': {'title': 'Prevention of transportation in foreign commerce of alien women and girls under international agreement; Commissioner designated as authority to receive and preserve information',
                    'originalTitle': 'Prevention of transportation in foreign commerce of alien women and girls under international agreement; Commissioner designated as authority to receive and preserve information',
                    'body': row[3], 'source': source, 'sourceUrl': source['source'],
                    'versionLabel': f'{row[0]} U.S. Code, Title 8, § 1557 (former § 238 transferred here)',
                    'reviewStatus': 'source-destination',
                    'sourceCredits': 'June 25, 1910, ch. 395, § 6, 36 Stat. 826; Ex. Ord. No. 6166, § 14, June 10, 1933.',
                    'headingOrigin': 'destination-catchline',
                    'headingEvidence': 'The § 1557 codification note identifies this provision as previously classified to § 238.'}}


def amended_239():
    files = [f'sources/legal/raw/historical-usc/statutes/STATUTE-{vol}-Pg{page}.pdf'
             for vol, page in [(64,464),(64,465),(65,5),(65,6)]]
    if not all((ROOT / f).exists() for f in files): return {}
    sources = []
    for vol, page, file in [(64,464,files[0]),(64,465,files[1]),(65,5,files[2]),(65,6,files[3])]:
        path = ROOT / file
        sources.append({'file': file, 'source': f'https://www.govinfo.gov/content/pkg/STATUTE-{vol}/pdf/STATUTE-{vol}-Pg{page}.pdf',
                        'bytes': path.stat().st_size, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()})
    body = ('Notwithstanding the provisions of section 13(c) of the Immigration Act of 1924, as amended (8 U.S.C. 213(c)), alien spouses or unmarried minor children of United States citizens serving in, or having an honorable discharge certificate from the Armed Forces of the United States during World War II shall, if otherwise admissible under the immigration laws, be eligible to enter the United States with nonquota immigration visas issued under the provisions of section 4(a) of the Immigration Act of 1924, as amended (8 U.S.C. 204(a)): Provided, That in the cases of such alien spouses of United States citizens serving in, or having an honorable discharge certificate from the Armed Forces of the United States during World War II the marriage shall have occurred before twelve months after the enactment of this Act, as hereby amended.')
    return {'239': {'title': 'Admission of alien spouses and minor children of members of armed services',
                    'body': body, 'source': sources[3], 'sourceUrl': sources[3]['source'],
                    'versionLabel': '1950 act as amended in 1951, 64 Stat. 464–465; 65 Stat. 5–6',
                    'reviewStatus': 'visually-reviewed', 'relatedSources': sources[:3]}}


def historical(row):
    edition, _, title, body, source, page = row[:6]
    source_url = source['source'] + (f'#page={page}' if page else '')
    result = {'originalTitle': title, 'versionLabel': f'{edition} U.S. Code, Title 8',
            'sourceUrl': source_url, 'sourceArtifact': source['file'], 'sourceSha256': source['sha256'],
            'sourceCapturedAt': '2026-10-11', 'reviewStatus': 'unreviewed-ocr',
            'transcriptionNote': 'Machine-extracted text from the official edition; original source page governs any OCR discrepancy.'}
    if len(row) > 6 and row[6]: result['sourceCredits'] = row[6]
    return result


def main():
    loc, loc_titles, gov = extract_loc(), extract_loc_heading_only(), extract_gov()
    security_act, security_source = extract_security_act_1950()
    statute_overrides = {**security_act, **reviewed_1951_sections(), **former_sections_quoted_in_1946(),
                         **visually_reviewed_acts(), **guam_nationality_section_1950(), **armed_forces_naturalization_1948(),
                         **reviewed_early_code_sections(), **quoted_137a(), **transferred_238(gov), **amended_239()}
    sources = {}
    groups, singles, unresolved, audit_flags = [], [], [], []
    for record in INVENTORY['noncurrentRecords']:
        label = record['section']
        grouped = record['individualizableRange']
        if label == '1484 to 1487':
            # Four reviewed INA records are already present and take precedence.
            members = []
            for number in ['1484','1485','1486','1487']:
                note = next(r for r in BY_GROUP[label] if r['exact_full_text'].startswith('Section ' + number + ','))
                members.append({'section': number, 'status': 'repealed', 'noteIds': [note['note_id']],
                                'statusReason': {'text': note['exact_full_text'], 'sourceUrl': None, 'sourceNoteIds': [note['note_id']]}})
            groups.append({'section': label, 'members': members})
            continue
        rows = BY_GROUP[label]
        candidates = defaultdict(list)
        if grouped:
            for note in rows:
                for number in note_members(note): candidates[number].append(note)
                for embedded in descriptive_section_markers(note['exact_full_text']):
                    for number in phrase_members(embedded[1]):
                        candidates[number].append(note)
            if not candidates:
                a, b = re.split(r'\s+to\s+|,\s*', label, maxsplit=1)
                for number in expand(a,b): candidates[number] = []
            # Suppress references to other code provisions by using the House group bounds.
            low, high = re.split(r'\s+to\s+|,\s*', label, maxsplit=1)
            candidates = {n: v for n,v in candidates.items() if key(low) <= key(n) <= key(high)}
            if not candidates:
                candidates = {n: [] for n in expand(low, high)}
            # Source headings confirm numeric members of generic House range descriptions.
            for n in set(loc) | set(gov):
                if key(low) <= key(n) <= key(high) and n not in candidates:
                    # Suffixes belong only when the House group describes them or a note does.
                    if re.search('[a-z–]', n) and not any(n in x['exact_full_text'] for x in rows): continue
                    candidates[n] = []
            # Associate the most specific official note with every evidenced member.
            for note in rows:
                members = note_members(note)
                if members:
                    lo, hi = min(members, key=key), max(members, key=key)
                    members = list(dict.fromkeys(members + [n for n in candidates if key(lo) <= key(n) <= key(hi) and n in note['exact_full_text']]))
                for n in members:
                    if n in candidates and note not in candidates[n]: candidates[n].append(note)
            # Attach common group note if no member-specific note exists.
            for n in candidates:
                if not candidates[n]: candidates[n] = [r for r in rows if r['exact_full_text'] not in ('Editorial Notes',)] [:1]
        else:
            candidates = {label: rows}
        members = []
        for number in sorted(candidates, key=key):
            matched = list(dict((r['note_id'],r) for r in candidates[number]).values())
            meaningful = [r for r in matched if r['exact_full_text'] != 'Editorial Notes']
            specific = next((r for r in meaningful if number in note_members(r)), meaningful[0] if meaningful else None)
            explanation = specific['exact_full_text'] if specific else ''
            status = record['status']
            if record['section'] in ('1 to 18', '351 to 416'):
                lowered = explanation.lower()
                if 'transferred' in lowered or 'now section ' in lowered:
                    status = 'transferred'
                elif 'repealed' in lowered:
                    status = 'repealed'
                else:
                    status = 'omitted'
                if label == '351 to 416' and number == '392a': status = 'omitted'
                if label == '351 to 416' and number == '398a': status = 'transferred'
                if label == '1 to 18' and number == '15': status = 'omitted'
            row = gov.get(number) or loc.get(number)
            if row and row[4]['file']:
                sources[row[4]['file']] = row[4]
            title_row = loc_titles.get(number)
            title = (row[2] if row else '') or (title_row[1] if title_row else '') or note_heading(explanation, number)
            if title.lower().startswith('same;'):
                title = title[5:].strip()
                if title: title = title[0].upper() + title[1:]
            if number == '277': title = title.replace('certificutes', 'certificates')
            if number in CONTEXTUAL_HEADINGS: title = CONTEXTUAL_HEADINGS[number]
            if not title or BAD_TITLE.match(title): title = note_heading(explanation, number)
            if not title: unresolved.append({'section': number, 'group': label, 'gap': 'former heading'})
            note_ids = [specific['note_id']] if specific else []
            reason = (omission_reason(number, explanation, note_ids, record.get('url')) if status == 'omitted'
                      else {'text': member_note_excerpt(explanation, number), 'sourceUrl': record.get('url'),
                            'sourceNoteIds': note_ids})
            member = {'section': number, 'status': status, 'heading': title, 'noteIds': note_ids, 'statusReason': reason}
            if title_row and not row:
                _, _, title_source, title_page = title_row
                member['headingSource'] = {'sourceUrl': title_source['source'] + f'#page={title_page}',
                                           'sourceArtifact': title_source['file'], 'sourceSha256': title_source['sha256']}
                sources[title_source['file']] = title_source
            if label == '1 to 18' and number in ('13', '14'):
                member['transferTargets'] = [{'source': number, 'title': 22, 'section': '1731' if number == '13' else '1732'}]
            if label == '351 to 416' and number == '398a':
                member['transferTargets'] = [{'source': number, 'title': 36, 'section': '391', 'former': True}]
            if number == '606':
                member['transferTargets'] = [{'source': number, 'title': 48, 'section': '1421l', 'former': True}]
            if row:
                member['historical'] = historical(row)
                if number in CONTEXTUAL_HEADINGS:
                    member['historical']['headingOrigin'] = 'editorial-contextualization'
                    member['historical']['headingEvidence'] = 'The printed catchline begins "Same;"; display title expands its subject using the surrounding Code headings and statutory text.'
                member['body'] = [{'label': '', 'text': reflow_ocr_body(row[3]) if row[0] <= 1952 else row[3]}]
                member['heading'] = correct_printed_title(number, member['heading'], member['historical'])
                member['heading'], member['body'][0]['text'] = restore_first_subdivision_caption(
                    number, member['heading'], member['body'][0]['text'], member['historical'])
                if number == '277':
                    member['historical']['originalTitle'] = member['historical']['originalTitle'].replace('certificutes', 'certificates')
                visual_ocr_corrections = {'104': [('The Commissioner of Immigration and Naturallzati.,. in addition to his other duties, shall have charge, under the supervision and directinn of tho Attorney General, of the admiinistration of the Chinese exclusion laws.',
                                                   'The Commissioner of Immigration and Naturalization, in addition to his other duties, shall have charge, under the supervision and direction of the Attorney General, of the administration of the Chinese exclusion laws.')],
                                          '107': [('appointed by. the President', 'appointed by the President')],
                                          '155': [('one y6ar', 'one year')],
                                          '176': [("miscellaneous receipts.' All", 'miscellaneous receipts. All')],
                                          '231': [('April 11, (whether', 'April 11, 1899 (whether')],
                                          '242': [('subchapter IM', 'subchapter III')],
                                          '261': [("an-' Jurisdiction", 'and jurisdiction'), ('collectrs', 'collectors'), ('Its territories', 'its territories')],
                                          '502': [('subchapter MI', 'subchapter III'),
                                                  ("Puerto Rico,' and", 'Puerto Rico, and'),
                                                  ("term '\"naturalization court\"", 'term "naturalization court"'),
                                                  ('Deputy CommiSsioner', 'Deputy Commissioner'),
                                                  ("Immigration'and Naturalization", 'Immigration and Naturalization'),
                                                  ('respectively. _', 'respectively.'),
                                                  ('provided such. legitimation or adoption-takes', 'provided such legitimation or adoption takes'),
                                                  ('child is in., the legal custody', 'child is in the legal custody')],
                                          '277': [('a numl,sr.', 'a number.')],
                                          '405': [('sxity days', 'sixty days')],
                                          '504': [('804,. 805', '804, 805'), ('residence.,', 'residence.')]}
                for wrong, corrected in visual_ocr_corrections.get(number, []):
                    if wrong in member['body'][0]['text']:
                        member['body'][0]['text'] = member['body'][0]['text'].replace(wrong, corrected)
                        member['historical'].setdefault('transcriptionCorrections', []).append(
                            {'ocr': wrong, 'printed': corrected, 'basis': 'verified against the source page image'})
                if number == '104':
                    # The page footer split its source credit from the operative
                    # sentence, and the OCR mangled the credit's opening date.
                    sentence, separator, credit = member['body'][0]['text'].partition(' (Jur.e 6, 1900')
                    assert separator and sentence.endswith('Chinese exclusion laws.')
                    member['body'][0]['text'] = sentence
                    member['historical']['sourceCredits'] = '(June 6, 1900, ch. 791, § 1, 31 Stat. 611; Mar. 4, 1913, ch. 141, § 3, 37 Stat. 737; Ex. Ord. No. 6166, § 14, June 10, 1933; Reorg. Plan No. V, eff. June 14, 1940, 5 Fed. Reg. 2423, 54 Stat. 1238.)'
                    member['historical']['reviewStatus'] = 'visually-reviewed'
                if number in ('107', '176'):
                    assert row[0] == 1934, (number, row[0])
                    member['historical']['reviewStatus'] = 'visually-reviewed'
                    member['historical']['transcriptionNote'] = 'The operative text was checked against the 1934 Code page image; later editions print only editorial disposition notes.'
                if number == '212c':
                    text = member['body'][0]['text'].replace('(a,)', '(a)').replace('721a 1', '721a')
                    text = re.sub(r'1So in original\. Probably should read "212b"\. 9 4506°-47-vol\. 1-40\s*', '', text)
                    member['body'][0]['text'] = text
                    member['historical']['sourceFootnote'] = 'The printed Code refers to § 721a and footnotes it: “So in original. Probably should read ‘212b’.”'
                body = member['body'][0]['text']
                for flag, pattern in [('embedded-section-heading', r'(?m)^\s*(?:§|Section)\s*\d+[a-z]?(?:[–-]\d+)?\s*[.]'),
                                      ('page-header', r'(?im)^\s*(?:TITLE 8|Page \d+|Chapter \d+)\b'),
                                      ('editorial-heading', r'(?im)^\s*(?:DERIVATION|CODIFICATION|CROSS REFERENCES|AMENDMENTS|EDITORIAL NOTES|REPEAL)\s*$')]:
                    if re.search(pattern, body): audit_flags.append({'section': number, 'flag': flag})
            else:
                unresolved.append({'section': number, 'group': label, 'gap': 'historical text'})
            if number in statute_overrides:
                excerpt = statute_overrides[number]
                sources[excerpt['source']['file']] = excerpt['source']
                for extra in excerpt.get('relatedSources', []): sources[extra['file']] = extra
                member['body'] = [{'label': '', 'text': reflow_ocr_body(excerpt['body'])
                                   if excerpt.get('reviewStatus', 'unreviewed-ocr') == 'unreviewed-ocr'
                                   else excerpt['body']}]
                member['heading'] = excerpt.get('title', title)
                provenance_note = ('Former § 238 is represented by the officially identified § 1557 destination text.'
                                   if number == '238' else
                                   'Former text quoted in the official 1952 U.S. Code; the quoted edition is the text source.'
                                   if number == '137a' else
                                   'Text transcribed from the identified official source pages; original printed pages govern any discrepancy.'
                                   if excerpt.get('reviewStatus') == 'visually-reviewed' else
                                   'Text extracted from the identified official source pages; original printed pages govern OCR discrepancies.')
                member['historical'] = {'versionLabel': excerpt['versionLabel'],
                                        'sourceUrl': excerpt['sourceUrl'], 'sourceArtifact': excerpt['source']['file'],
                                        'sourceSha256': excerpt['source']['sha256'], 'sourceCapturedAt': '2026-10-11',
                                        'reviewStatus': excerpt.get('reviewStatus', 'unreviewed-ocr'),
                                        'transcriptionNote': provenance_note}
                if excerpt.get('originalTitle') or not excerpt.get('headingOrigin'):
                    member['historical']['originalTitle'] = excerpt.get('originalTitle', excerpt.get('title', title))
                if excerpt.get('headingOrigin'):
                    member['historical']['headingOrigin'] = excerpt['headingOrigin']
                    member['historical']['headingEvidence'] = excerpt['headingEvidence']
                if excerpt.get('sourceCredits'):
                    member['historical']['sourceCredits'] = excerpt['sourceCredits']
                if excerpt.get('relatedSources'):
                    member['historical']['relatedSources'] = [{key: value for key, value in extra.items() if key != 'bytes'}
                                                               for extra in excerpt['relatedSources']]
                unresolved = [gap for gap in unresolved if not (gap['section'] == number and gap['gap'] == 'historical text')]
            members.append(member)
        (groups if grouped else singles).append({'section': label, 'members': members} if grouped else members[0])
    out = {'schemaVersion': 1, 'generatedAt': '2026-10-11', 'sources': list(sources.values()),
           'groups': groups, 'singles': singles,
           'coverage': {'groupCount': len(groups),
                        'sectionCount': len({m['section'] for g in groups for m in g['members']} | {s['section'] for s in singles}),
                        'evidenceMemberCount': sum(len(g['members']) for g in groups) + len(singles),
                        'reviewStatus': 'unreviewed-ocr', 'auditFlags': audit_flags, 'unresolved': unresolved}}
    (SOURCES / 'historical-usc.json').write_text(json.dumps(out, ensure_ascii=False, indent=2) + '\n')
    print('groups', len(groups), 'sections', out['coverage']['sectionCount'], 'with text', out['coverage']['sectionCount'] - sum(x['gap'] == 'historical text' for x in unresolved), 'gaps', len(unresolved))
    for x in unresolved[:100]: print(x)


if __name__ == '__main__': main()
