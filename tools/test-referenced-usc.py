#!/usr/bin/env python3
"""Behavior checks for direct-reference scope and complete source preservation."""
import importlib.util
import pathlib
import json
import collections
import unittest
ROOT = pathlib.Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("referenced_usc", ROOT / "tools/referenced-usc.py")
m = None
if SPEC and pathlib.Path(SPEC.origin).exists():
    m = importlib.util.module_from_spec(SPEC)
    SPEC.loader.exec_module(m)

class ReferencedUscTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(m, "The direct-reference corpus generator is not implemented")

    def test_full_section_keeps_uncited_siblings_and_nested_runins(self):
        html = '<p class="statutory-body">The term means—</p><p class="statutory-body">(a)(1) One.</p><p class="statutory-body-1em">(A) Two.</p><p class="statutory-body">(b) Three.</p>'
        section = m.parse_operative(html)
        self.assertEqual(section['preamble'], 'The term means—')
        self.assertEqual([n['label'] for n in section['body']], ['a', 'b'])
        self.assertEqual(section['body'][0]['children'][0]['children'][0]['text'], 'Two.')
        self.assertEqual(section['body'][1]['text'], 'Three.')

    def test_continuations_keep_original_order_between_numbered_children(self):
        source='<h4 class="subsection-head">(a) Scope</h4><p class="statutory-body-1em">(1) First.</p><p class="statutory-body">Bridge.</p><p class="statutory-body-1em">(2) Last.</p>'
        result=m.parse_operative(source)
        self.assertEqual(m.flatten_operative(result), '(a) Scope (1) First. Bridge. (2) Last.')
        self.assertEqual(result['body'][0]['children'][1]['text'],'Bridge.')
        self.assertEqual(result['body'][0]['children'][1]['label'],'')

    def test_numeric_root_definitions_preserve_roman_children(self):
        source='<h4 class="paragraph-head">(1) First</h4><h4 class="subparagraph-head">(A) Group</h4><p class="statutory-body-3em">(i) Child</p><h4 class="paragraph-head">(2) Second</h4>'
        result=m.parse_operative(source)
        self.assertEqual([n['label'] for n in result['body']], ['1','2'])
        self.assertEqual(result['body'][0]['children'][0]['children'][0]['label'], 'i')

    def test_range_endpoints_never_become_standalone_targets(self):
        source='Sections 3145 through 3148 of title 18 apply.'
        refs=[dict(family='usc',targetTitle='18',targetSection='3145',context='operative',text='3145',sourceText=source,start=9,end=13,sourceSection='1535',field='preamble')]
        selected, excluded, _=m.select_references(refs)
        self.assertEqual(selected,{})
        self.assertEqual(excluded[0]['reason'],'Section range')

    def test_long_roman_and_deep_letter_designators_remain_nested(self):
        source='<h4 class="subsection-head">(a) Group</h4><p>(1)(A)(xxxv)(I)(aa)(AA) Start.</p><p class="statutory-body-6em">(BB) Next.</p><p class="statutory-body-5em">(bb) Next item.</p><p class="statutory-body-1em">(xxxvi)(I) Next clause.</p>'
        result=m.parse_operative(source)
        clauses=result['body'][0]['children'][0]['children'][0]['children']
        self.assertEqual([n['label'] for n in clauses],['xxxv','xxxvi'])
        items=clauses[0]['children'][0]['children']
        self.assertEqual([n['label'] for n in items],['aa','bb'])
        self.assertEqual([n['label'] for n in items[0]['children']],['AA','BB'])

    def test_capital_c_is_a_subparagraph_after_roman_clauses(self):
        source='<p>(a)(1)(B)(i) First.</p><p>(ii) Second.</p><p>(C)(i) Third.</p>'
        result=m.parse_operative(source)
        subs=result['body'][0]['children'][0]['children']
        self.assertEqual([n['label'] for n in subs],['B','C'])

    def test_capital_i_returns_to_subparagraph_h_sibling(self):
        source='<p>(a)(1)(H)(iv) Before.</p><p class="statutory-body-1em">(I) Inner.</p><p>(I)(i) Sibling.</p>'
        result=m.parse_operative(source)
        subs=result['body'][0]['children'][0]['children']
        self.assertEqual([n['label'] for n in subs],['H','I'])

    def test_continuation_resets_context_before_next_roman_list(self):
        source='<p>(a)(1) Parent—</p><p class="statutory-body-1em">(C) Group—</p><p class="statutory-body-2em">(i) Child.</p><p class="statutory-body-block">Parent continuation—</p><p class="statutory-body-1em">(i) Sibling list.</p>'
        result=m.parse_operative(source)
        children=result['body'][0]['children'][0]['children']
        self.assertEqual([n['label'] for n in children],['C','','i'])

    def test_editorial_footnote_markers_do_not_enter_operative_body(self):
        source='<p>(a) Operative<sup><a href="#s_1_target">1</a></sup> text with x<sup>2</sup>.</p>'
        result=m.parse_operative(source)
        self.assertEqual(result['body'][0]['text'],'Operative text with x².')

    def test_operative_table_preserves_rows_and_cells(self):
        source='<p>(a) Limits:</p><table><tr><th>Year</th><th>Amount</th></tr><tr><td>2025</td><td>$1,000</td></tr></table>'
        result=m.parse_operative(source)
        table=result['body'][0]['children'][0]
        self.assertEqual(table['table']['rows'],[['Year','Amount'],['2025','$1,000']])
        self.assertIn('$1,000',table['text'])

    def test_trailing_unnumbered_prose_becomes_parent_continuation(self):
        source='<p>(a) Parent.</p><p class="statutory-body-1em">(1) Child.</p><p class="statutory-body">Parent tail.</p>'
        result=m.parse_operative(source)
        self.assertEqual(result['body'][0]['continuation'],'Parent tail.')
        self.assertEqual([n['label'] for n in result['body'][0]['children']],['1'])

    def test_notes_groups_and_ranges_cannot_expand_scope(self):
        refs = [dict(family='usc', targetTitle='18', targetSection='16', targetPath=['a'], sourceSection='1101', context='operative', text='18 U.S.C. 16(a)', after='', before='', start=0, end=15, field='body.0.text'),
                dict(family='usc', targetTitle='18', targetSection='17', context='notes', text='18 U.S.C. 17'),
                dict(family='usc', targetTitle='18', targetSection='18', context='operative', text='18 U.S.C. 18 et seq.', after='', before='',start=0,end=20,field='preamble',sourceSection='1101'),
                dict(family='usc', targetTitle='18', targetSection='19', context='operative', text='sections 19 through 21 of title 18', after='', before='',start=0,end=34,field='preamble',sourceSection='1102')]
        selected, excluded, corrections = m.select_references(refs)
        self.assertEqual(set(selected), {'18:16'})
        self.assertEqual(len(excluded), 3)

    def test_explicit_path_overrides_erroneous_house_markup(self):
        refs = [dict(family='usc', targetTitle='7', targetSection='2012', targetPath=['j'], sourceSection='1612', context='operative', text='7 U.S.C. 2012(r)', after='', before='', start=0,end=16,field='body.0.text')]
        selected, _, corrections = m.select_references(refs)
        self.assertEqual(selected['7:2012'][0]['targetPath'], ['r'])
        self.assertTrue(corrections)

class GeneratedCorpusTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.corpus=json.loads((ROOT/'sources/legal/referenced-usc/corpus.json').read_text())
        cls.report=json.loads((ROOT/'sources/legal/referenced-usc/selection.json').read_text())
        cls.sections={f"{t['number']}:{m.norm_section(s['section'])}":s for t in cls.corpus['titles'] for s in t['sections']}

    def test_full_parent_contains_uncited_material_and_no_bottom_notes(self):
        self.assertIn('e',[n['label'] for n in self.sections['26:501']['body']])
        self.assertEqual([n['label'] for n in self.sections['18:16']['body']],['a','b'])
        for section in self.sections.values():
            self.assertFalse(section.get('notes'))
            self.assertNotIn('sourceCredit',section)
            self.assertNotIn('operativeFootnotes',section)
            self.assertTrue(section['body'] or section['preamble'])

    def test_all_shipped_sections_have_current_direct_evidence(self):
        raw_count=sum(len(t['sections']) for t in self.corpus['titles'])
        self.assertEqual(raw_count,len(self.sections))
        for target in self.sections:
            self.assertIn(target,self.report['selection'])
            for reference in self.report['selection'][target]:
                self.assertEqual(reference['context'],'operative')
                self.assertFalse(reference['field'].startswith('notes.'))
        for excluded in ['2:192','2:194','29:1803','29:1831','29:1853','29:1855','28:2671','28:2680','18:3145','18:3148']:
            self.assertNotIn(excluded,self.sections)

    def test_repealed_and_transferred_targets_have_explicit_dispositions(self):
        unavailable={r['target']:r for r in self.report['unavailableTargets']}
        self.assertEqual(unavailable['42:259']['status'],'repealed')
        self.assertEqual(unavailable['50:4605']['status'],'repealed')
        self.assertEqual(unavailable['50:403']['status'],'transferred')
        self.assertEqual(unavailable['50:403-3']['status'],'transferred')
        self.assertTrue(all(r['sourceUrl'] for r in unavailable.values()))

    def test_every_source_excerpt_hash_and_complete_operative_text(self):
        inventory=json.loads((ROOT/'sources/legal/referenced-usc/source-inventory.json').read_text())
        for record in inventory['artifacts']:
            blob=(ROOT/'sources/legal/referenced-usc'/record['path']).read_bytes()
            self.assertEqual(m.digest(blob),record['sha256'])
            section=self.sections[record['target']]
            raw=m.field(blob.decode(),'statute')
            original=m.normalize(' '.join(m.plain(b) for b in m.blocks(raw)))
            self.assertEqual(''.join(original.split()), ''.join(m.flatten_operative(section).split()),record['target'])

if __name__ == '__main__':
    unittest.main()
