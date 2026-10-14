#!/usr/bin/env python3
"""Independently compare presentation ranges with original House USLM XML.

The oracle rewrites a copy of the XML to remove publisher footnotes, then uses
ordinary itertext normalization to check the range text and source attributes.
It does not import the production presentation extractor or its allowlists.
"""

import argparse
from collections import Counter
import copy
import json
from pathlib import Path
import re
import xml.etree.ElementTree as ET


ROOT = Path(__file__).resolve().parents[1]
UNITS = {'section', 'subsection', 'paragraph', 'subparagraph', 'clause', 'subclause',
         'item', 'subitem', 'subsubitem', 'level'}
RETAINED = UNITS | {'title', 'subtitle', 'chapter', 'subchapter', 'part', 'subpart',
                   'division', 'p', 'num', 'heading', 'content', 'chapeau',
                   'continuation', 'quotedContent', 'table', 'colgroup', 'col',
                   'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'signature', 'name',
                   'i', 'b', 'inline', 'span', 'sourceCredit'}


def tag(element):
    return element.tag.split('}')[-1]


def normalized(element):
    return ' '.join(''.join(element.itertext()).split())


def flatten(blocks):
    for block in blocks:
        yield block
        yield from flatten(block.get('children', []))


def read_overlay(path):
    return json.loads(re.search(r'window\.INA_SEARCH_STATUTE_FOOTNOTES\s*=\s*(\{[\s\S]+\});\s*$', path.read_text())[1])


def remove_at(parent, index, count=1, strip_before=False):
    children = list(parent)
    previous = children[index - 1] if index else None
    before = previous.tail if previous is not None else parent.text
    before = before or ''
    if strip_before:
        before = before.rstrip()
    after = children[index + count - 1].tail or ''
    if previous is None:
        parent.text = before + after
    else:
        previous.tail = before + after
    for child in children[index:index + count]:
        parent.remove(child)


def clean_copy(element, exclusions=(), footnotes=True):
    element = copy.deepcopy(element)
    for index in range(len(element) - 1, -1, -1):
        if tag(element[index]) in exclusions:
            remove_at(element, index)

    def visit(parent):
        index = 0
        while index < len(parent):
            node = parent[index]
            if tag(node) == 'ref' and node.get('class') == 'footnoteRef':
                assert tag(parent[index + 1]) == 'note'
                remove_at(parent, index, 2, True)
            elif tag(node) == 'sup':
                remove_at(parent, index, 1, True)
            else:
                visit(node)
                index += 1
    if footnotes:
        visit(element)
    return element


def expected_presentation(element):
    flags = {}
    if tag(element) in ('i', 'b'):
        flags['italic' if tag(element) == 'i' else 'bold'] = True
    for value in element.get('class', '').split():
        if value in ('italic', 'bold', 'centered', 'inline', 'leaders'):
            flags[value] = True
        if value in ('smallCaps', 'small-caps'):
            flags['smallCaps'] = True
        if value == 'fontsize8':
            flags['fontSize'] = 8
        if value.startswith('indent'):
            flags['indent'] = int(value.removeprefix('indent'))
        if value.startswith('firstIndent'):
            flags['firstIndent'] = int(value.removeprefix('firstIndent'))
    return flags


def check_record(source, record, label, totals, *, exclusions=(), note=False):
    source = clean_copy(source, exclusions, footnotes=not note)
    text = normalized(source)
    assert record['text'] == text, f'{label}: full text differs from original XML'
    encoded = text.encode('utf-16-le')
    expected_nodes = [node for child in source for node in child.iter() if tag(node) in RETAINED]
    blocks = list(flatten(record['layout']))
    heading = next((child for child in source if tag(child) == 'heading'), None)
    if note and heading is not None:
        expected_nodes = [node for node in expected_nodes if all(node is not h for h in heading.iter())]
        heading_nodes = [node for child in heading for node in child.iter() if tag(node) in RETAINED]
        compare_nodes(heading_nodes, list(flatten(record.get('headingLayout', []))), normalized(heading).encode('utf-16-le'), label + '.heading', totals)
        assert record.get('headingPresentation', {}) == expected_presentation(heading), f'{label}: heading classes lost'
        totals['headingRoots'] += 1
    if not note:
        assert record.get('presentation', {}) == expected_presentation(source), f'{label}: field classes lost'
    compare_nodes(expected_nodes, blocks, encoded, label, totals)


def compare_nodes(expected, actual, encoded, label, totals):
    assert len(expected) == len(actual), f'{label}: {len(expected)} original nodes, {len(actual)} retained blocks'
    for node, block in zip(expected, actual):
        assert block['tag'] == tag(node), f'{label}: expected {tag(node)}, got {block["tag"]}'
        value = encoded[block['start'] * 2:block['end'] * 2].decode('utf-16-le')
        assert value == normalized(node), f'{label} <{tag(node)}>: range text {value!r} != source {normalized(node)!r}'
        assert block.get('presentation', {}) == expected_presentation(node), f'{label} <{tag(node)}>: source classes lost'
        for attr in ('origin', 'identifier', 'status'):
            assert block.get(attr, '') == node.get(attr, ''), f'{label}: {attr} lost'
        if tag(node) == 'num':
            assert block.get('value') == node.get('value'), f'{label}: structural number lost'
        if node.get('width'):
            assert block.get('width') == node.get('width'), f'{label}: publisher width lost'
        # These are all real CSS declarations in the original capture; USLM's
        # opaque -uslm-lc composition codes are deliberately not CSS.
        expected_style = {}
        for declaration in node.get('style', '').split(';'):
            prop, sep, val = declaration.partition(':')
            if prop.strip() == '-uslm-lc':
                continue
            if declaration.strip() == 'border=0':
                expected_style['border'] = '0'
            elif sep:
                expected_style[prop.strip()] = val.strip()
        assert block.get('style', {}) == expected_style, f'{label} <{tag(node)}>: table style differs'
        totals[tag(node)] += 1


def audit(xml_path, overlay):
    root = ET.parse(xml_path).getroot()
    elements = {}
    occurrences = Counter()
    sections = {}
    for element in root.iter():
        identifier = element.get('identifier', '')
        if tag(element) not in UNITS or not identifier.startswith('/us/usc/t8/s'):
            continue
        number = next((child.get('value', '').replace('...', ' to ') for child in element if tag(child) == 'num'), '')
        if tag(element) == 'section':
            sections[number] = element
            key = number + ':preamble'
        else:
            match = re.fullmatch(r'/us/usc/t8/s([^/\s]+)/([^\s]+)', identifier)
            if not match:
                continue
            key = match[1].replace('...', ' to ') + ':' + match[2]
        occurrences[key] += 1
        if occurrences[key] > 1:
            key += '#' + str(occurrences[key])
        elements[key] = element
    totals = Counter()
    for key, fields in overlay.get('presentationFields', {}).items():
        source = elements[key]
        for field, record in fields.items():
            if field in ('text', 'preamble'):
                field_source = source
                excluded = UNITS | {'num', 'heading', 'sourceCredit', 'notes'}
            else:
                field_source = next(child for child in source if tag(child) == field)
                excluded = ()
            check_record(field_source, record, key + '.' + field, totals, exclusions=excluded)
            totals['fields'] += 1
    for number, records in overlay['sectionNotes'].items():
        notes = next(child for child in sections[number] if tag(child) == 'notes')
        assert len(notes) == len(records)
        for index, (source, record) in enumerate(zip(notes, records)):
            check_record(source, record, number + '.note' + str(index), totals, note=True)
            totals['notes'] += 1
    for identifier, records in overlay.get('divisionNotes', {}).items():
        division = next(e for e in root.iter() if e.get('identifier') == identifier)
        notes = [n for child in division for n in (list(child) if tag(child) == 'notes' else [child]) if tag(n) == 'note']
        assert len(notes) == len(records)
        for index, (source, record) in enumerate(zip(notes, records)):
            check_record(source, record, identifier + '.note' + str(index), totals, note=True)
            totals['divisionNotes'] += 1
    # Inventory check detects an extractor that silently omits entire fields.
    source_italics = sum(tag(e) == 'i' for e in root.iter())
    assert totals['i'] == source_italics, f'Only {totals["i"]}/{source_italics} original italic spans covered'
    assert totals['col'] == 2 and totals['title'] == 5 and totals['signature'] == 30
    return dict(totals)


def delivery_cases(xml_path):
    """Source-only expectations for packed delivery and actual renderers."""
    root = ET.parse(xml_path).getroot()
    result, occurrences = [], Counter()

    def case(source, location, *, exclusions=(), note=False):
        source = clean_copy(source, exclusions, footnotes=not note)
        text = normalized(source)
        if location['kind'] == 'field' and not text:
            return
        heading = next((child for child in source if tag(child) == 'heading'), None) if note else None
        nodes = []
        for child in source:
            if child is heading:
                continue
            for node in child.iter():
                if tag(node) in RETAINED:
                    item = {'tag': tag(node), 'text': normalized(node), 'presentation': expected_presentation(node)}
                    for attr in ('origin', 'identifier', 'status', 'width', 'value'):
                        if node.get(attr) is not None:
                            item[attr] = node.get(attr)
                    style = {}
                    for declaration in node.get('style', '').split(';'):
                        prop, sep, value = declaration.partition(':')
                        if declaration.strip() == 'border=0':
                            style['border'] = '0'
                        elif sep and prop.strip() != '-uslm-lc':
                            style[prop.strip()] = value.strip()
                    if style:
                        item['style'] = style
                    nodes.append(item)
        if nodes or expected_presentation(source):
            result.append({**location, 'text': text, 'presentation': expected_presentation(source), 'nodes': nodes,
                           'start': len(normalized(heading).encode('utf-16-le')) // 2 if heading is not None else 0})
        if heading is not None:
            case(heading, {**location, 'kind': 'note-heading'}, note=False)

    for section in root.iter():
        if tag(section) != 'section' or not section.get('identifier', '').startswith('/us/usc/t8/s'):
            continue
        number = next(child.get('value', '').replace('...', ' to ') for child in section if tag(child) == 'num')
        for element in section.iter():
            if tag(element) not in UNITS or not element.get('identifier', '').startswith('/us/usc/t8/s'):
                continue
            ident = element.get('identifier')
            path = ident.split('/', 5)[5] if tag(element) != 'section' else 'preamble'
            key = number + ':' + path
            occurrences[key] += 1
            if occurrences[key] > 1:
                key += '#' + str(occurrences[key])
            case(element, {'kind': 'field', 'sourceKey': key, 'field': 'preamble' if tag(element) == 'section' else 'text'},
                 exclusions=UNITS | {'num', 'heading', 'sourceCredit', 'notes'})
            for field in ('heading', 'sourceCredit'):
                child = next((child for child in element if tag(child) == field), None)
                if child is not None:
                    case(child, {'kind': 'field', 'sourceKey': key, 'field': field})
        notes = next((child for child in section if tag(child) == 'notes'), [])
        for index, note in enumerate(notes):
            case(note, {'kind': 'note', 'section': number, 'index': index}, note=True)
    for division in root.iter():
        identifier = division.get('identifier', '')
        if tag(division) not in {'title', 'subtitle', 'chapter', 'subchapter', 'part', 'subpart', 'division'} or not identifier.startswith('/us/usc/t8'):
            continue
        notes = [note for child in division for note in (list(child) if tag(child) == 'notes' else [child]) if tag(note) == 'note']
        for index, note in enumerate(notes):
            if normalized(note).startswith('Current through '):
                continue
            case(note, {'kind': 'note', 'division': identifier, 'index': index}, note=True)
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--xml', type=Path, default=ROOT / 'sources/legal/raw/usc08@119-102.xml')
    parser.add_argument('--overlay', type=Path, default=ROOT / 'src/INASearch-Statute-Footnotes.js')
    parser.add_argument('--cases', action='store_true', help='Emit source-only expected cases for delivery tests')
    args = parser.parse_args()
    print(json.dumps(delivery_cases(args.xml) if args.cases else audit(args.xml, read_overlay(args.overlay)), sort_keys=True))


if __name__ == '__main__':
    main()
