#!/usr/bin/env python3
"""Regression coverage for publisher note structure and lossless text offsets."""
import importlib.util
from pathlib import Path
import unittest
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('footnotes', ROOT / 'tools/generate-statute-footnotes.py')
parser = importlib.util.module_from_spec(spec)
spec.loader.exec_module(parser)


class NoteStructureTests(unittest.TestCase):
    def extract(self, xml):
        self.assertTrue(hasattr(parser, 'extract_note_layout'), 'The importer must preserve source note structure')
        return parser.extract_note_layout(ET.fromstring(xml))

    def test_heading_is_not_body_and_paragraphs_keep_source_offsets(self):
        note = self.extract('<note><heading>Funds</heading><p>First <ref>citation</ref>.</p><p>Second paragraph.</p></note>')
        self.assertEqual(note['text'], 'FundsFirst citation.Second paragraph.')
        self.assertEqual(note['bodyStart'], 5)
        self.assertEqual([(b['tag'], b['start'], b['end']) for b in note['layout']], [('p', 5, 20), ('p', 20, 37)])

    def test_quoted_subdivisions_and_table_cells_survive(self):
        note = self.extract('<note><heading>Rules</heading><p>Provided that:<quotedContent>'
                            '<subsection><num>(a)</num><heading>Scope</heading><content> First.</content>'
                            '<paragraph><num>(1)</num><content> Child.</content></paragraph></subsection>'
                            '</quotedContent></p><table><tbody><tr><td>A</td><td>B</td></tr></tbody></table></note>')
        def tags(blocks):
            return [b['tag'] for b in blocks for b in [b, *descendants(b)]]
        def descendants(b):
            return [c for child in b.get('children', []) for c in [child, *descendants(child)]]
        actual = tags(note['layout'])
        for tag in ['quotedContent', 'subsection', 'paragraph', 'content', 'table', 'tr', 'td']:
            self.assertIn(tag, actual)
        self.assertEqual(note['text'], 'RulesProvided that:(a)Scope First.(1) Child.AB')

    def test_cross_heading_and_empty_note_have_no_body(self):
        for role in ['', ' role="crossHeading"']:
            with self.subTest(role=role):
                note = self.extract('<note' + role + '><heading>Editorial Notes</heading></note>')
                self.assertEqual(note['layout'], [])
                self.assertEqual(note['bodyStart'], len(note['text']))
                self.assertEqual(note['role'], 'crossHeading' if role else '')

    def test_astral_characters_use_browser_utf16_offsets(self):
        note = self.extract('<note><heading>😀</heading><p> A </p><p> B </p></note>')
        self.assertEqual(note['text'], '😀 A B')
        self.assertEqual(note['bodyStart'], 2)
        self.assertEqual(note['layout'][-1]['end'], 6)

    def test_generated_1101_has_categories_and_all_amendment_paragraphs(self):
        source = parser.read_assigned_json(ROOT / 'src/INASearch-Statute-Footnotes.js', 'INA_SEARCH_STATUTE_FOOTNOTES')
        records = source.get('sectionNotes', {}).get('1101', [])
        self.assertTrue(records, 'The delivered overlay loses all bottom-note structure')
        categories = [r['heading'] for r in records if r['role'] == 'crossHeading']
        self.assertEqual(categories, ['Editorial Notes', 'Statutory Notes and Related Subsidiaries', 'Executive Documents'])
        amendments = next(r for r in records if r['heading'] == 'Amendments')
        xml = ET.parse(ROOT / source['sourceArtifact'])
        ns = {'u': 'http://xml.house.gov/schemas/uslm/1.0'}
        official = xml.find('.//u:section[@identifier="/us/usc/t8/s1101"]/u:notes/u:note[@topic="amendments"]', ns)
        self.assertEqual(len(amendments['layout']), len(official.findall('u:p', ns)))

    def test_grouped_sections_receive_the_same_note_structure(self):
        source = parser.read_assigned_json(ROOT / 'src/INASearch-Statute-Footnotes.js', 'INA_SEARCH_STATUTE_FOOTNOTES')
        corpus = parser.read_assigned_json(ROOT / 'src/INASearch-Corpus.js', 'INA_SEARCH_CORPUS')
        for section in corpus['title8']['sections']:
            if section.get('notes'):
                with self.subTest(section=section['section']):
                    self.assertEqual(len(source['sectionNotes'].get(section['section'], [])), len(section['notes']))


if __name__ == '__main__':
    unittest.main()
