#!/usr/bin/env python3
"""Check hierarchy annotations against independently read publisher XML."""

import copy
import json
import re
import runpy
import unittest
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

from title8_update.uslm import import_title8


ROOT = Path(__file__).resolve().parents[1]
HOUSE_NS = '{http://xml.house.gov/schemas/uslm/1.0}'
GPO_NS = '{http://schemas.gpo.gov/xml/uslm}'
DIVISIONS = {'title', 'subtitle', 'chapter', 'subchapter', 'part', 'subpart', 'division'}
GENERATOR = runpy.run_path(str(ROOT / 'tools/generate-ina-hierarchy.py'))


def source_text(element):
    return re.sub(r'\s+', ' ', ''.join(element.itertext())).strip() if element is not None else ''


class HierarchyNotesTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        manifest = json.loads((ROOT / 'sources/legal/source-manifest.json').read_text())
        house = next(source for source in manifest['sources'] if source['id'] == 'house-title-8-uslm')
        cls.release = house['releasePoint']
        artifacts = [artifact for source in manifest['sources'] for artifact in source.get('artifacts', [])]
        archive = next(artifact for artifact in house['artifacts'] if artifact['path'].endswith('.zip'))
        with zipfile.ZipFile(ROOT / archive['path']) as zipped:
            cls.house_xml = zipped.read('usc08.xml')
        cls.house_root = ET.fromstring(cls.house_xml)
        cls.title8 = import_title8(cls.house_xml, cls.release, manifest['capturedAt'])
        gpo = next(artifact for artifact in artifacts if artifact['id'] == 'govinfo-comps-1376')
        cls.gpo_xml = (ROOT / gpo['path']).read_bytes()
        cls.gpo_root = ET.fromstring(cls.gpo_xml)
        corpus_source = (ROOT / 'src/INASearch-Corpus.js').read_text()
        corpus = json.loads(corpus_source[corpus_source.index('{'):corpus_source.rindex('}') + 1])
        cls.ina = GENERATOR['build_hierarchy'](cls.gpo_xml, corpus, manifest['capturedAt'])

    def test_all_house_division_notes_retain_source_text_and_ancestry(self):
        expected = {}

        def visit(element, breadcrumb):
            kind = element.tag.removeprefix(HOUSE_NS)
            if kind not in DIVISIONS:
                return
            number = element.find(HOUSE_NS + 'num')
            heading = source_text(element.find(HOUSE_NS + 'heading'))
            value = number.get('value')
            if kind != 'title':
                breadcrumb = breadcrumb + [{'kind': kind, 'number': value, 'title': heading}]
            notes = []
            for child in element:
                if child.tag == HOUSE_NS + 'notes':
                    notes.extend(list(child))
                elif child.tag == HOUSE_NS + 'note':
                    # The publisher's title currency declaration is metadata.
                    if kind == 'title' and source_text(child) == 'Current through ' + self.release:
                        continue
                    notes.append(child)
            if notes:
                expected[element.get('identifier')] = {
                    'kind': kind, 'number': value, 'heading': heading, 'breadcrumb': breadcrumb,
                    'notes': [(note.get('topic', ''), source_text(note.find(HOUSE_NS + 'heading')), source_text(note)) for note in notes],
                }
            for child in element:
                visit(child, breadcrumb)

        visit(self.house_root.find(HOUSE_NS + 'main/' + HOUSE_NS + 'title'), [])
        actual = self.title8.get('divisionNotes', {})
        self.assertEqual(set(actual), set(expected), 'House division annotations must not disappear during import')
        self.assertEqual(set(expected), {'/us/usc/t8/ch7'})
        for identifier, wanted in expected.items():
            record = actual[identifier]
            self.assertEqual(record['identifier'], identifier)
            for field in ('kind', 'number', 'heading', 'breadcrumb'):
                self.assertEqual(record[field], wanted[field])
            self.assertEqual([(note['topic'], note['heading'], note['text']) for note in record['notes']], wanted['notes'])
            for note in record['notes']:
                self.assertEqual(note['source']['supportingExcerpt'], note['text'])
                self.assertTrue(note['source']['url'].startswith('https://uscode.house.gov/'))

    def test_title_currency_is_intentionally_metadata(self):
        title = self.house_root.find(HOUSE_NS + 'main/' + HOUSE_NS + 'title')
        note = title.find(HOUSE_NS + 'note')
        self.assertEqual(source_text(note), 'Current through ' + self.title8['currentThrough'])
        self.assertNotIn('/us/usc/t8', self.title8.get('divisionNotes', {}))

    def test_division_notes_are_general_and_keep_direct_note_order(self):
        root = copy.deepcopy(self.house_root)
        title = root.find(HOUSE_NS + 'main/' + HOUSE_NS + 'title')
        title_note = ET.SubElement(title, HOUSE_NS + 'note', {'topic': 'miscellaneous'})
        ET.SubElement(title_note, HOUSE_NS + 'p').text = 'A substantive title note.'
        division = next(node for node in title if node.get('identifier') == '/us/usc/t8/ch7')
        division.set('identifier', '/us/usc/t8/ch70')
        division.find(HOUSE_NS + 'num').set('value', '70')
        direct = ET.SubElement(division, HOUSE_NS + 'note', {'topic': 'miscellaneous'})
        ET.SubElement(direct, HOUSE_NS + 'p').text = 'A direct division note.'
        result = import_title8(ET.tostring(root), self.release, '2026-10-13').get('divisionNotes', {})
        self.assertEqual(set(result), {'/us/usc/t8', '/us/usc/t8/ch70'})
        self.assertEqual(result['/us/usc/t8']['notes'][0]['text'], 'A substantive title note.')
        self.assertEqual(result['/us/usc/t8/ch70']['number'], '70')
        self.assertEqual(result['/us/usc/t8/ch70']['notes'][-1]['text'], 'A direct division note.')

    def test_all_gpo_toc_footnotes_and_markers_keep_source_associations(self):
        toc = self.gpo_root.find('.//' + GPO_NS + 'toc')
        notes = {}
        for note in toc.iter(GPO_NS + 'footnote'):
            notes[note.get('id')] = {
                'number': source_text(note.find(GPO_NS + 'sup')),
                'text': re.sub(r'\s+', ' ', ' '.join(''.join(child.itertext()) for child in note if child.tag != GPO_NS + 'sup')).strip(),
            }
        expected = {}
        title_number = None
        for item in toc.iter(GPO_NS + 'referenceItem'):
            role = item.get('role')
            designator = source_text(item.find(GPO_NS + 'designator'))
            if role == 'title':
                title_number = re.search(r'Title\s+([IVX]+)', designator, re.I).group(1).upper()
                node_id = 'ina:title:' + title_number
            elif role == 'chapter':
                node_id = 'ina:title:' + title_number + ':chapter:' + re.search(r'chapter\s+(\w+)', designator, re.I).group(1).upper()
            elif role == 'section':
                node_id = 'ina:section:' + re.search(r'Sec\.\s+(\w+)', designator).group(1)
            else:
                continue
            refs = [ref for ref in item.iter(GPO_NS + 'ref') if ref.get('class') == 'footnoteRef']
            if refs:
                expected[node_id] = [(source_text(ref), ref.get('idref')) for ref in refs]
        records = self.ina['sections'] + self.ina['titles'] + [chapter for title in self.ina['titles'] for chapter in title['chapters']]
        actual = {record['id']: record for record in records if record.get('tocFootnoteReferences') or record.get('tocFootnotes')}
        self.assertEqual(set(actual), set(expected), 'TOC footnotes must stay attached to the hierarchy rows they qualify')
        self.assertEqual(len(notes), 6)
        self.assertEqual(sum(len(refs) for refs in expected.values()), 7)
        seen_notes = []
        for node_id, refs in expected.items():
            record = actual[node_id]
            self.assertEqual([(ref['number'], ref['sourceIdref']) for ref in record['tocFootnoteReferences']], refs)
            self.assertEqual([ref['noteId'] for ref in record['tocFootnoteReferences']], [target if target in notes else None for _, target in refs])
            attached = record.get('tocFootnotes', [])
            self.assertEqual([note['id'] for note in attached], [target for _, target in refs if target in notes])
            for note in attached:
                self.assertEqual({'number': note['number'], 'text': note['text']}, notes[note['id']])
                self.assertTrue(note['sourceUrl'].startswith('https://www.govinfo.gov/'))
                seen_notes.append(note['id'])
        self.assertEqual(set(seen_notes), set(notes))
        self.assertEqual(actual['ina:section:276'].get('tocFootnotes', []), [])
        self.assertEqual(actual['ina:section:276']['tocFootnoteReferences'][0]['noteId'], None)


if __name__ == '__main__':
    unittest.main()
