#!/usr/bin/env python3
"""Regression tests for source presentation retained in clean legal text."""

import importlib.util
from pathlib import Path
import unittest
import xml.etree.ElementTree as ET


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('footnotes', ROOT / 'tools/generate-statute-footnotes.py')
GEN = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(GEN)


def flatten(blocks):
    for block in blocks:
        yield block
        yield from flatten(block.get('children', []))


def utf16_slice(value, start, end):
    return value.encode('utf-16-le')[start * 2:end * 2].decode('utf-16-le')


class PresentationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root = ET.parse(ROOT / 'sources/legal/raw/usc08@119-102.xml').getroot()

    def element(self, identifier):
        return next(e for e in self.root.iter() if e.get('identifier') == identifier)

    def test_original_note_preserves_inline_emphasis_and_hanging_indent(self):
        # Removing class/tag interpretation must lose observable source emphasis.
        section = self.element('/us/usc/t8/s1101')
        note = next(n for n in section.iter() if n.tag.endswith('}note') and 'COMPREHENSIVE BORDER CONTROL STRATEGY' in ''.join(n.itertext()))
        data = GEN.extract_note_layout(note)
        heading = next(b for b in flatten(data['layout']) if 'A. Deterring Illegal Immigration At Our Borders' in utf16_slice(data['text'], b['start'], b['end']) and b['tag'] == 'p')
        self.assertTrue(heading.get('presentation', {}).get('bold'), 'Source bold paragraph is discarded')
        self.assertEqual(heading.get('presentation', {}).get('firstIndent'), -2)
        italic = [b for b in flatten([heading]) if b.get('presentation', {}).get('italic')]
        self.assertTrue(italic, 'Source italic title is discarded')

    def test_original_quote_preserves_titles_and_quote_identity(self):
        section = self.element('/us/usc/t8/s1522')
        note = next(n for n in section.iter() if n.tag.endswith('}note') and any(c.tag.endswith('}heading') and ''.join(c.itertext()) == 'Refugee Education Assistance Act of 1980' for c in n))
        data = GEN.extract_note_layout(note)
        blocks = list(flatten(data['layout']))
        self.assertEqual(sum(b['tag'] == 'title' for b in blocks), 5, 'Quoted title wrappers are discarded')
        quotes = [b for b in blocks if b['tag'] == 'quotedContent']
        source_quotes = [e for e in note.iter() if e.tag.endswith('}quotedContent')]
        self.assertEqual([b.get('origin') for b in quotes], [e.get('origin') for e in source_quotes])
        numbers = [b for b in blocks if b['tag'] == 'num']
        self.assertTrue(any(b.get('value') == '103' for b in numbers), 'Quoted section identity is discarded')

    def test_original_table_retains_empty_columns_and_publisher_styles(self):
        note = next(n for n in self.root.iter() if n.tag.endswith('}note') and any(e.tag.endswith('}table') for e in n.iter()))
        data = GEN.extract_note_layout(note)
        blocks = list(flatten(data['layout']))
        table = next(b for b in blocks if b['tag'] == 'table')
        self.assertEqual(table.get('width'), '50%')
        cols = [b for b in blocks if b['tag'] == 'col']
        self.assertEqual(len(cols), 2, 'Empty column definitions are discarded')
        self.assertTrue(all(b['start'] == b['end'] for b in cols))
        self.assertEqual(cols[0].get('style'), {'width': '52pt', 'max-width': '52pt'})
        self.assertEqual(cols[1].get('style'), {'min-width': '154pt'})
        self.assertEqual(sum(b['tag'] == 'span' for b in blocks), 4)
        self.assertEqual(sum(b.get('presentation', {}).get('leaders', False) for b in blocks), 4)
        def enclosed(children, start, end):
            for child in children:
                self.assertLessEqual(start, child['start'], 'Empty layout nodes must remain inside their parent')
                self.assertLessEqual(child['end'], end)
                enclosed(child.get('children', []), child['start'], child['end'])
        enclosed(data['layout'], 0, len(data['text'].encode('utf-16-le')) // 2)

    def test_inline_ranges_have_exact_utf16_boundaries_and_safe_styles(self):
        note = ET.fromstring('<note><heading class="centered fontsize8 smallCaps"> Header </heading><p>😀 <i>  Alpha  beta </i> tail <inline class="small-caps">Caps</inline>.</p><p style="text-align:center;position:fixed;background:url(https://invalid);width:12pt; font-size:expression(x)">Last</p></note>')
        data = GEN.extract_note_layout(note)
        italic = next((b for b in flatten(data['layout']) if b['tag'] == 'i'), None)
        self.assertIsNotNone(italic, 'Inline emphasis range is discarded')
        self.assertEqual(utf16_slice(data['text'], italic['start'], italic['end']), 'Alpha beta')
        last = data['layout'][-1]
        self.assertEqual(last.get('style'), {'text-align': 'center', 'width': '12pt'})
        self.assertEqual(data.get('headingPresentation'), {'centered': True, 'fontSize': 8, 'smallCaps': True})

    def test_footnote_removal_preserves_formatting_ranges_and_emoji_offsets(self):
        node = ET.fromstring('<paragraph><content>😀 <i>word<ref class="footnoteRef" idref="n">1</ref><note type="footnote" id="n"><num>1</num> Note.</note> words</i> tail</content></paragraph>')
        data = GEN.extract_field(node, set(), 'x:a', 'text', 'x', {})
        self.assertEqual(data['cleanText'], '😀 word words tail')
        self.assertEqual(data['footnoteReferences'][0]['offset'], 7, 'Footnote positions must use UTF-16 code units')
        italic = next((b for b in flatten(data.get('layout', [])) if b['tag'] == 'i'), None)
        self.assertIsNotNone(italic, 'Clean fields must retain inline presentation')
        self.assertEqual(utf16_slice(data['cleanText'], italic['start'], italic['end']), 'word words')

    def test_original_consecutive_chapeaux_remain_distinct(self):
        self.assertTrue(hasattr(GEN, 'extract_presentation'), 'Operative fields lack presentation extraction')
        element = self.element('/us/usc/t8/s1427/b')
        data = GEN.extract_presentation(element, GEN.OWN_TEXT_EXCLUSIONS)
        chapeaux = [b for b in data['layout'] if b['tag'] == 'chapeau']
        self.assertEqual(len(chapeaux), 2)
        self.assertTrue(utf16_slice(data['text'], chapeaux[0]['start'], chapeaux[0]['end']).startswith('Absence from the United States of more than six months'))
        self.assertTrue(utf16_slice(data['text'], chapeaux[1]['start'], chapeaux[1]['end']).startswith('Absence from the United States for a continuous period of one year'))
        self.assertLess(chapeaux[0]['end'], chapeaux[1]['start'])

    def test_original_division_note_retains_six_source_reference_ranges(self):
        chapter = self.element('/us/usc/t8/ch7')
        note = next(n for n in chapter.iter() if n.tag.endswith('}note') and any(c.tag.endswith('}heading') and ''.join(c.itertext()) == 'Codification' for c in n))
        data = GEN.extract_note_layout(note, include_references=True)
        references = data.get('uslmReferences', [])
        self.assertEqual(len(references), 6, 'Chapter editorial source references are lost')
        source_refs = [e for e in note.iter() if e.tag.endswith('}ref')]
        for original, reference in zip(source_refs, references):
            self.assertEqual(reference['houseHref'], original.get('href'))
            self.assertEqual(utf16_slice(data['text'], reference['start'], reference['end']), ' '.join(''.join(original.itertext()).split()))


if __name__ == '__main__':
    unittest.main()
