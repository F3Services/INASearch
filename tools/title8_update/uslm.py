"""Import the publisher's explicit structure into INASearch's authored shape.

Inline/run-in subdivisions are intentionally left to tools/statute-run-ins.js.
This layer does not interpret parenthesized citations as child subdivisions.
"""
import re
from urllib.parse import quote

from .source import NAMESPACE, validate_xml

STRUCTURAL = {'subsection', 'paragraph', 'subparagraph', 'clause', 'subclause',
              'item', 'subitem', 'subsubitem', 'level'}
DIVISIONS = {'title', 'subtitle', 'chapter', 'subchapter', 'part', 'subpart', 'division'}
TEXT = {'content', 'chapeau', 'continuation'}
NS = {'u': NAMESPACE}


def local(element):
    return element.tag.rsplit('}', 1)[-1]


def clean(text):
    return re.sub(r'\s+', ' ', text or '').strip()


def content(element):
    return clean(''.join(element.itertext())) if element is not None else ''


def child(element, name):
    return element.find('u:' + name, NS)


def number(element):
    num = child(element, 'num')
    if num is None:
        raise ValueError('Unsupported structural unit without a num element')
    return num.get('value', content(num).strip('(). ')).replace('...', ' to ')


def check_children(element, allowed):
    if clean(element.text):
        raise ValueError('Unsupported unwrapped structural text')
    for item in element:
        if local(item) not in allowed or clean(item.tail):
            raise ValueError('Unsupported USLM structure: ' + local(item))
        # A new operative table/image needs an explicit renderer, never flatten it silently.
        if local(item) in TEXT and any(local(n) in {'table', 'img', 'image'} for n in item.iter()):
            raise ValueError('Unsupported operative table/image; review required')


def ordered_text(element, output, field):
    """Keep field offsets stable while retaining each child's source position.

    Offsets are UTF-16 code units, like JavaScript string/reference offsets.
    Missing offsets mean the traditional text-then-children order.
    """
    parts, offsets = [], []
    for item in element:
        if local(item) in TEXT:
            parts.append(content(item))
        elif local(item) in STRUCTURAL:
            offsets.append(len(clean(' '.join(parts)).encode('utf-16-le')) // 2)
    text = clean(' '.join(parts))
    if text:
        output[field] = text
    if any(offset < len(text.encode('utf-16-le')) // 2 for offset in offsets):
        output['childTextOffsets'] = offsets


def unit(element, path, section_identifier):
    check_children(element, STRUCTURAL | TEXT | {'num', 'heading'})
    label = number(element)
    current = path + [label]
    if element.get('identifier') != section_identifier + '/' + '/'.join(current):
        raise ValueError('Unsupported or missing unit identifier; footnote/reference mapping requires explicit matching paths')
    output = {'label': label}
    heading = content(child(element, 'heading'))
    if heading: output['heading'] = heading
    ordered_text(element, output, 'text')
    children = [unit(e, current, section_identifier) for e in element if local(e) in STRUCTURAL]
    if children: output['children'] = children
    output['path'] = current
    return output


def import_title8(data, release, captured_at):
    root = validate_xml(data, release)
    sections = []
    division_notes = {}
    seen = set()

    def visit(element, breadcrumb):
        kind = local(element)
        if kind in DIVISIONS:
            check_children(element, DIVISIONS | {'section', 'num', 'heading', 'toc', 'notes', 'note'})
            if kind != 'title':
                breadcrumb = breadcrumb + [{'kind': kind, 'number': number(element), 'title': content(child(element, 'heading'))}]
            notes = []
            for item in element:
                if local(item) == 'notes':
                    if any(local(note) != 'note' for note in item):
                        raise ValueError('Unsupported division note container')
                    notes.extend(item)
                elif local(item) == 'note':
                    notes.append(item)
            # The title's currency declaration is already represented by
            # currentThrough. Other title notes remain reader-facing content.
            notes = [note for note in notes if not (kind == 'title' and content(note) == 'Current through ' + release)]
            if notes:
                identifier = element.get('identifier', '')
                if identifier != '/us/usc/t8' and not identifier.startswith('/us/usc/t8/'):
                    raise ValueError('Unsupported division identifier')
                if identifier in division_notes:
                    raise ValueError('Duplicate division note identifier')
                key = identifier.removeprefix('/us/usc/t8').strip('/').replace('/', '-') or 'title'
                granule = 'USC-prelim-title8' + ''.join('-' + item['kind'] + item['number'] for item in breadcrumb)
                url = 'https://uscode.house.gov/view.xhtml?edition=prelim&num=0&req=' + quote('granuleid:' + granule)
                locator = '8 U.S.C.' + ''.join(' > ' + item['kind'].capitalize() + ' ' + item['number'] for item in breadcrumb)
                record = {'identifier': identifier, 'kind': kind, 'number': number(element),
                          'heading': content(child(element, 'heading')), 'breadcrumb': breadcrumb, 'notes': []}
                for index, note in enumerate(notes, 1):
                    heading, text, topic = content(child(note, 'heading')), content(note), note.get('topic', '')
                    record['notes'].append({'id': '8-division-' + key + '-note-' + str(index),
                                            'topic': topic, 'heading': heading, 'text': text,
                                            'source': {'resource': 'United States Code, Title 8',
                                                       'locator': locator + ' > ' + (heading or topic), 'url': url,
                                                       'captureDate': captured_at, 'supportingExcerpt': text}})
                division_notes[identifier] = record
        if kind == 'section':
            check_children(element, STRUCTURAL | TEXT | {'num', 'heading', 'sourceCredit', 'notes'})
            identifier = element.get('identifier', '')
            if not identifier.startswith('/us/usc/t8/s'):
                raise ValueError('Unsupported section identifier')
            section_number = number(element)
            if not section_number or section_number in seen:
                raise ValueError('Duplicate/empty Title 8 section number')
            seen.add(section_number)
            first_number = re.match(r'[\w-]+', section_number)[0]
            url = 'https://uscode.house.gov/view.xhtml?edition=prelim&num=0&req=' + quote('granuleid:USC-prelim-title8-section' + first_number)
            heading = content(child(element, 'heading'))
            def source(locator, excerpt):
                return {'resource': 'United States Code, Title 8', 'locator': locator, 'url': url,
                        'captureDate': captured_at, 'supportingExcerpt': excerpt}
            locator = '8 U.S.C. ' + section_number
            result = {'id': '8-' + section_number, 'section': section_number, 'heading': heading,
                      'status': element.get('status', 'current'), 'identifier': identifier, 'breadcrumb': breadcrumb}
            notes = child(element, 'notes')
            if notes is not None:
                result['notes'] = []
                for index, note in enumerate(notes, 1):
                    if local(note) != 'note': raise ValueError('Unsupported section note container')
                    h = content(child(note, 'heading'))
                    text = content(note)
                    topic = note.get('topic', '')
                    result['notes'].append({'id': result['id'] + '-note-' + str(index), 'topic': topic,
                                            'heading': h, 'text': text, 'source': source(locator + ' > ' + (h or topic), text)})
            ordered_text(element, result, 'preamble')
            body = [unit(e, [], identifier) for e in element if local(e) in STRUCTURAL]
            if body: result['body'] = body
            credit = content(child(element, 'sourceCredit'))
            if credit: result['sourceCredit'] = credit
            result['url'] = url
            result['source'] = source(locator, clean('§ ' + section_number + '. ' + heading))
            if credit: result['sourceCreditSource'] = source(locator + ' > source credit', credit)
            sections.append(result)
            return
        for item in element:
            if local(item) in DIVISIONS | {'section'}:
                visit(item, breadcrumb)

    main = child(root, 'main')
    if main is None: raise ValueError('Title 8 has no main content')
    check_children(main, {'title'})
    visit(main, [])
    if not sections: raise ValueError('Title 8 contains no sections')
    return {'title': 8, 'name': 'Aliens and Nationality', 'publication': 'Online@' + release,
            'currentThrough': release, 'sourceCreatedAt': root.findtext('u:meta/{http://purl.org/dc/terms/}created', default='', namespaces=NS),
            'isPositiveLaw': False, 'sourceUrl': 'https://uscode.house.gov/download/download.shtml',
            'divisionNotes': division_notes, 'sections': sections}
