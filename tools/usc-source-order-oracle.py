#!/usr/bin/env python3
"""Test oracle: read operative USLM in document order, without the importer.

Editorial notes/markers are excluded just as in the reader; all statutory
words, labels, headings and their order come directly from captured XML.
"""
import json
import importlib.util
from pathlib import Path
import re
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
NS = '{http://xml.house.gov/schemas/uslm/1.0}'


def source_text(element):
    tag = element.tag.removeprefix(NS)
    if tag in {'notes', 'sourceCredit', 'note', 'sup'} or element.get('class') == 'footnoteRef':
        return ''
    result = element.text or ''
    for child in element:
        result += source_text(child) + (child.tail or '')
    return result


def main():
    manifest = json.loads((ROOT / 'sources/legal/source-manifest.json').read_text())
    source = next(s for s in manifest['sources'] if s['id'] == 'house-title-8-uslm')
    artifact = next(a for a in source['artifacts'] if a['id'] == 'house-title-8-xml')
    root = ET.parse(ROOT / artifact['path']).getroot()
    records = []

    def visit(element):
        if element.tag in {NS + 'notes', NS + 'note'}:
            return
        if element.tag == NS + 'section':
            number = element.find(NS + 'num').get('value').replace('...', ' to ')
            text = ' '.join(source_text(child) for child in element if child.tag not in {NS + 'num', NS + 'heading'})
            records.append({'section': number, 'text': re.sub(r'\s+', '', text)})
            return
        for child in element:
            visit(child)

    visit(root.find(NS + 'main'))
    # Other USC titles are captured as publisher HTML, not USLM. Strip the
    # source markup directly; do not call the structural HTML importer.
    spec = importlib.util.spec_from_file_location('referenced_usc', ROOT / 'tools/referenced-usc.py')
    html_source = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(html_source)
    referenced = json.loads((ROOT / 'sources/legal/referenced-usc/corpus.json').read_text())
    external = []
    for title in referenced['titles']:
        for section in title['sections']:
            raw = (ROOT / section['source']['artifact']).read_text()
            operative = html_source.field(raw, 'statute')
            text = ' '.join(html_source.plain(block) for block in html_source.blocks(operative))
            external.append({'title': title['number'], 'section': section['section'], 'text': re.sub(r'\s+', '', text)})
    print(json.dumps({'title8': records, 'referenced': external}, ensure_ascii=False))


if __name__ == '__main__':
    main()
