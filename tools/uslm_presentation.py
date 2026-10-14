"""Recover safe USLM presentation as ranges over normalized legal text.

This module emits data, never publisher HTML or arbitrary CSS. Range coordinates
are UTF-16 code units so the browser can apply presentation to the same strings
used by citation, copy, and search handling.
"""

from bisect import bisect_left
import re


STRUCTURAL = {'title', 'subtitle', 'chapter', 'subchapter', 'part', 'subpart',
              'division', 'section', 'subsection', 'paragraph', 'subparagraph',
              'clause', 'subclause', 'item', 'subitem', 'subsubitem', 'level'}
LAYOUT_TAGS = STRUCTURAL | {
    'p', 'num', 'heading', 'content', 'chapeau', 'continuation', 'quotedContent',
    'table', 'colgroup', 'col', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td',
    'signature', 'name', 'i', 'b', 'inline', 'span', 'sourceCredit',
}
SENTINEL = re.compile(r'\ue000\d+\ue001')
DIMENSION = re.compile(r'-?(?:\d+(?:\.\d+)?|\.\d+)(?:pt|px|em|rem|%)?\Z')
DIMENSION_PROPERTIES = {
    'width', 'min-width', 'max-width', 'font-size', 'line-height', 'text-indent',
    'padding-left', 'padding-right', 'padding-top', 'padding-bottom',
}
ENUM_PROPERTIES = {
    'text-align': {'left', 'right', 'center', 'justify'},
    'vertical-align': {'top', 'middle', 'bottom', 'baseline'},
    'border-collapse': {'collapse', 'separate'},
    'font-style': {'normal', 'italic'},
    'font-weight': {'normal', 'bold'},
    'font-variant': {'normal', 'small-caps'},
}


def local_name(tag):
    return tag.rsplit('}', 1)[-1]


def safe_style(value):
    """Keep only bounded presentation declarations used by source tables."""
    result = {}
    for declaration in (value or '').split(';'):
        if declaration.strip().lower() == 'border=0':
            result['border'] = '0'
            continue
        property_name, separator, val = declaration.partition(':')
        property_name, val = property_name.strip().lower(), val.strip().lower()
        if not separator:
            continue
        if property_name in ENUM_PROPERTIES and val in ENUM_PROPERTIES[property_name]:
            result[property_name] = val
        elif property_name in DIMENSION_PROPERTIES and DIMENSION.fullmatch(val):
            number = float(re.match(r'-?(?:\d+(?:\.\d+)?|\.\d+)', val)[0])
            if abs(number) <= 10000 and (number >= 0 or property_name == 'text-indent'):
                result[property_name] = val
        elif property_name == 'border' and val == '0':
            result[property_name] = val
    return result


def presentation(element):
    result = {}
    tag = local_name(element.tag)
    if tag == 'i':
        result['italic'] = True
    if tag == 'b':
        result['bold'] = True
    for token in element.get('class', '').split():
        if token in {'italic', 'bold', 'centered', 'inline', 'leaders'}:
            result[token] = True
        elif token in {'smallCaps', 'small-caps'}:
            result['smallCaps'] = True
        elif token == 'fontsize8':
            result['fontSize'] = 8
        elif re.fullmatch(r'indent\d+', token):
            result['indent'] = int(token[6:])
        elif re.fullmatch(r'firstIndent-?\d+', token):
            result['firstIndent'] = int(token[11:])
    return result


def extract_presentation(element, exclude_direct=frozenset(), *, clean_footnotes=True, include_references=False):
    """Extract field text and hierarchical safe presentation without children.

    Only *direct* exclusions are omitted, allowing quotations nested within an
    included content element to retain their own independent hierarchy. Empty
    nodes survive, including table columns and the publisher's empty header.
    """
    chunks, raw_length, references = [], 0, []

    def append(value):
        nonlocal raw_length
        value = value or ''
        chunks.append(value)
        raw_length += len(value)

    def walk(node, is_root=False):
        start = raw_length
        append(node.text)
        children = []
        entries = list(node)
        index = 0
        while index < len(entries):
            child = entries[index]
            tag = local_name(child.tag)
            if is_root and tag in exclude_direct:
                append(child.tail)
            elif clean_footnotes and tag == 'ref' and child.get('class') == 'footnoteRef':
                if index + 1 >= len(entries) or local_name(entries[index + 1].tag) != 'note' or entries[index + 1].get('id') != child.get('idref'):
                    raise ValueError('Unpaired footnote reference in presentation extraction')
                append('\ue0000\ue001')
                index += 1
                append(entries[index].tail)
            elif clean_footnotes and tag == 'sup':
                append('\ue0000\ue001')
                append(child.tail)
            elif clean_footnotes and tag == 'note' and child.get('type') == 'footnote':
                raise ValueError('Unpaired footnote in presentation extraction')
            else:
                children.extend(walk(child))
                append(child.tail)
            index += 1
        tag = local_name(node.tag)
        if include_references and tag == 'ref' and node.get('class') != 'footnoteRef':
            references.append({'start': start, 'end': raw_length, 'houseHref': node.get('href', ''),
                               'provenance': 'house-uslm-ref', 'ruleId': 'house-uslm-ref'})
        if is_root or tag not in LAYOUT_TAGS:
            return children
        block = {'tag': tag, 'start': start, 'end': raw_length}
        if children:
            block['children'] = children
        display = presentation(node)
        if display:
            block['presentation'] = display
            if 'indent' in display:
                block['indent'] = display['indent']
        style = safe_style(node.get('style'))
        if style:
            block['style'] = style
        for attr in ['origin', 'identifier', 'status']:
            if node.get(attr):
                block[attr] = node.get(attr)
        if tag == 'num' and node.get('value') is not None:
            block['value'] = node.get('value')
        for attr in ['colspan', 'rowspan']:
            value = node.get(attr, '')
            if value.isdigit() and 0 < int(value) <= 100:
                block[attr] = int(value)
        width = node.get('width', '').strip()
        if width and DIMENSION.fullmatch(width) and not width.startswith('-'):
            block['width'] = width
        return [block]

    layout = walk(element, True)
    raw = ''.join(chunks)
    output, source_positions, character_starts, character_ends = [], [], [], []
    index, length, pending_space = 0, 0, False
    while index < len(raw):
        marker = SENTINEL.match(raw, index)
        if marker:
            pending_space = False
            index = marker.end()
            continue
        char = raw[index]
        if char.isspace():
            pending_space = bool(output)
        else:
            if pending_space:
                output.append(' ')
                length += 1
            source_positions.append(index)
            character_starts.append(length)
            output.append(char)
            length += 2 if ord(char) > 0xffff else 1
            character_ends.append(length)
            pending_space = False
        index += 1

    def convert(block, parent_start=0, parent_end=None):
        if parent_end is None:
            parent_end = length
        first = bisect_left(source_positions, block['start'])
        after = bisect_left(source_positions, block['end'])
        if first < after:
            block['start'], block['end'] = character_starts[first], character_ends[after - 1]
        else:
            position = character_starts[first] if first < len(character_starts) else length
            position = min(parent_end, max(parent_start, position))
            block['start'] = block['end'] = position
        for child in block.get('children', []):
            convert(child, block['start'], block['end'])

    for block in layout:
        convert(block)
    result = {'text': ''.join(output), 'layout': layout}
    if include_references:
        encoded = result['text'].encode('utf-16-le')
        for reference in references:
            convert(reference)
            reference['text'] = encoded[reference['start'] * 2:reference['end'] * 2].decode('utf-16-le')
        result['uslmReferences'] = references
    display = presentation(element)
    if display:
        result['presentation'] = display
    style = safe_style(element.get('style'))
    if style:
        result['style'] = style
    return result
