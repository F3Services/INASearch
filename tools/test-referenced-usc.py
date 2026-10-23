#!/usr/bin/env python3
"""Behavior checks for direct-reference scope and complete source preservation."""
import importlib.util
import pathlib
import json
import collections
import unittest
import tempfile
from unittest.mock import patch
ROOT = pathlib.Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("referenced_usc", ROOT / "tools/referenced-usc.py")
m = None
if SPEC and pathlib.Path(SPEC.origin).exists():
    m = importlib.util.module_from_spec(SPEC)
    SPEC.loader.exec_module(m)

class ReferencedUscTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(m, "The direct-reference corpus generator is not implemented")

    def test_reference_export_validates_full_corpus_without_selecting_historical_bodies(self):
        exported = m.load_references()
        selected, _, _ = m.select_references(exported['references'], set(exported['inaSections']))
        self.assertIn('18:16', selected)
        self.assertTrue(any(ref['sourceSection'] == '1101' for ref in selected['18:16']))
        historical = json.loads((ROOT / 'sources/legal/historical-ina.json').read_text())
        historical_sections = {str(record['uscSection']) for record in historical['sections']}
        self.assertFalse(historical_sections.intersection(exported['inaSections']))
        self.assertFalse(any(ref['sourceSection'] in historical_sections for ref in exported['references']))

    def test_reference_export_still_rejects_stale_exact_source_exceptions(self):
        injection = "corpus.legalReferenceExceptions.exceptions.push({...corpus.legalReferenceExceptions.exceptions[0],id:'stale-export-test',sourceId:'missing-export-source'});"
        script = m.NODE_REFERENCE_EXPORT.replace("require('./tools/legal-references').applyGeneratedLegalReferences(corpus);", injection + "require('./tools/legal-references').applyGeneratedLegalReferences(corpus);")
        with patch.object(m, 'NODE_REFERENCE_EXPORT', script):
            with self.assertRaisesRegex(RuntimeError, 'Stale embedded-reference exceptions:.*stale-export-test'):
                m.load_references()

    def test_current_capture_preserves_source_fields_and_publisher_currency(self):
        source = """<!-- AUTHORITIES-LAWS-ENACTED-THROUGH:119-121 (10/09/2026) -->
<!-- AUTHORITIES-USC-TITLE-NAME:TITLE 18 - CRIMES AND CRIMINAL PROCEDURE -->
<!-- documentid:18_16 currentthrough:20261009_119-121 -->
<!-- expcite:TITLE 18-CRIMES AND CRIMINAL PROCEDURE!@!PART I-CRIMES!@!CHAPTER 1-GENERAL PROVISIONS!@!Sec. 16 -->
<!-- field-start:head --><h3>§16. Crime of violence defined</h3><!-- field-end:head -->
<!-- field-start:statute --><p>The term means—</p><p>(a) An offense.</p><!-- field-end:statute -->
<!-- field-start:sourcecredit --><p>Added by law.</p><!-- field-end:sourcecredit -->
<!-- field-start:footnote --><p>Official footnote.</p><!-- field-end:footnote -->
<!-- documentid:18_17 currentthrough:20261009_119-121 -->
<!-- field-start:repealedhead --><h3>§17. Repealed.</h3><!-- field-end:repealedhead -->
<!-- documentid:18_2251A currentthrough:20261009_119-121 -->
<!-- expcite:TITLE 18-CRIMES AND CRIMINAL PROCEDURE!@!CHAPTER 110-SEXUAL EXPLOITATION!@!Sec. 2251A -->
<!-- field-start:head --><h3>§2251A. Test</h3><!-- field-end:head -->
<!-- field-start:statute --><p>Current law.</p><!-- field-end:statute -->"""
        with tempfile.TemporaryDirectory() as temporary:
            base=pathlib.Path(temporary); dest=base/'output'; dest.mkdir()
            # Publisher title files can contain malformed bytes in unrelated
            # bottom notes. Included operative fields must remain strict UTF-8.
            blob=source.encode()+b'\n<!-- field-start:notes -->\xff<!-- field-end:notes -->';(base/'title-18.htm').write_bytes(blob)
            manifest={'edition':'prelim','releasePoint':'119-121','currentThrough':'2026-10-09','capturedAt':'2026-10-20','publisher':'OLRC','artifacts':[{'title':18,'path':'title-18.htm','sha256':m.digest(blob),'url':'https://uscode.house.gov/download/releasepoints/us/pl/119/121/htm_usc18@119-121.zip'}]}
            (base/'manifest.json').write_text(json.dumps(manifest))
            with patch.object(m,'DEST',dest): m.capture_current_sources(base,{'18:16':[], '18:17':[], '18:2251a':[]})
            inventory=json.loads((dest/'source-inventory.json').read_text())
            self.assertEqual(inventory['currentThrough'],'2026-10-09')
            self.assertEqual(inventory['releasePoint'],'119-121')
            artifact=inventory['artifacts'][0]
            self.assertEqual(artifact['heading'],'Crime of violence defined')
            self.assertEqual(artifact['breadcrumb'],[{'kind':'part','number':'I','title':'CRIMES'},{'kind':'chapter','number':'1','title':'GENERAL PROVISIONS'}])
            self.assertEqual(m.field((dest/artifact['path']).read_text(),'footnote').strip(),'<p>Official footnote.</p>')
            self.assertEqual(inventory['unavailable'][0]['status'],'repealed')
            self.assertEqual(inventory['artifacts'][1]['section'],'2251A')

    def test_only_ina_operative_citations_select_external_sections(self):
        base = dict(family='usc', targetTitle='18', context='operative', text='18 U.S.C. 16', sourceSection='1101')
        refs = [dict(base, targetSection='16'),
                dict(base, targetSection='17', sourceSection='1611'),
                dict(base, targetSection='18', context='notes')]
        selected, excluded, _ = m.select_references(refs, {'1101'})
        self.assertEqual(set(selected), {'18:16'})
        self.assertEqual(len(excluded), 2)

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
        selected, excluded, _=m.select_references(refs, {'1101', '1102', '1182', '1535'})
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
        selected, excluded, corrections = m.select_references(refs, {'1101', '1102', '1182', '1535'})
        self.assertEqual(set(selected), {'18:16'})
        self.assertEqual(len(excluded), 3)

    def test_explicit_path_overrides_erroneous_house_markup(self):
        refs = [dict(family='usc', targetTitle='7', targetSection='2012', targetPath=['j'], sourceSection='1101', context='operative', text='7 U.S.C. 2012(r)', after='', before='', start=0,end=16,field='body.0.text')]
        selected, _, corrections = m.select_references(refs, {'1101', '1102', '1182', '1535'})
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
        for excluded in ['42:1396b','26:6103','5:552a','6:485','2:192','2:194','29:1803','29:1831','29:1853','29:1855','28:2671','28:2680','18:3145','18:3148']:
            self.assertNotIn(excluded,self.sections)

    def test_repealed_and_transferred_targets_have_explicit_dispositions(self):
        unavailable={r['target']:r for r in self.report['unavailableTargets']}
        self.assertEqual(unavailable['42:259']['status'],'repealed')
        self.assertEqual(unavailable['50:4605']['status'],'repealed')
        self.assertNotIn('50:403', unavailable)
        self.assertNotIn('50:403-3', unavailable)
        self.assertTrue(all(r['sourceUrl'] for r in unavailable.values()))

    def test_every_source_excerpt_hash_and_complete_operative_text(self):
        inventory=json.loads((ROOT/'sources/legal/referenced-usc/source-inventory.json').read_text())
        for record in inventory['artifacts']:
            blob=(ROOT/'sources/legal/referenced-usc'/record['path']).read_bytes()
            self.assertEqual(m.digest(blob),record['sha256'])
            if record['target'] not in self.sections: continue
            section=self.sections[record['target']]
            raw=m.field(blob.decode(),'statute')
            original=m.normalize(' '.join(m.plain(b) for b in m.blocks(raw)))
            self.assertEqual(''.join(original.split()), ''.join(m.flatten_operative(section).split()),record['target'])

if __name__ == '__main__':
    unittest.main()
