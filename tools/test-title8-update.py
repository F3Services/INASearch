#!/usr/bin/env python3
"""Offline source/import regression tests; no publisher or GitHub writes."""
import io
import runpy
import json
from pathlib import Path
import unittest
from unittest.mock import patch
import zipfile
import tempfile
import re
import xml.etree.ElementTree as ET
from email.message import Message

from title8_update.source import DOWNLOAD_PAGE, discover, extract_zip, official_url, release_key, validate_xml
from title8_update.uslm import import_title8
from title8_update.pipeline import check, build, changed_sections

ROOT = Path(__file__).resolve().parents[1]
NS = 'http://xml.house.gov/schemas/uslm/1.0'
ADOPTED = next(s for s in json.loads((ROOT / 'sources/legal/source-manifest.json').read_text())['sources'] if s['id'] == 'house-title-8-uslm')
XML_PATH = ROOT / next(a['path'] for a in ADOPTED['artifacts'] if a['id'] == 'house-title-8-xml')
ZIP_PATH = ROOT / next(a['path'] for a in ADOPTED['artifacts'] if a['id'] == 'house-title-8-archive')


def xml(body='', release='119-103', title='8'):
    return (f'<uscDoc xmlns="{NS}" identifier="/us/usc/t{title}"><meta>'
            f'<docNumber>{title}</docNumber><docPublicationName>Online@{release}</docPublicationName>'
            f'</meta><main><title><num value="{title}"/><heading>Aliens and Nationality</heading>'
            f'{body}</title></main></uscDoc>').encode()


def archive(content, name='usc08.xml'):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w') as z:
        z.writestr(name, content)
    return buffer.getvalue()


class DiscoveryTests(unittest.TestCase):
    def test_uscis_heading_accordions_preserve_crosswalk_groups(self):
        parser_type=runpy.run_path(str(ROOT / 'tools/generate-ina-crosswalk.py'))['CrosswalkParser']
        for tag in ['div','h4']:
            parser=parser_type()
            parser.feed(f'<{tag} class="accordion__header">Title I: <span>General Provisions</span></{tag}><div class="accordion__panel"><table class="dataTable"><tr><td>INA 101</td><td>8 U.S.C. 1101</td><td>Definitions</td></tr></table></div>')
            self.assertEqual(parser.groups,['Title I: General Provisions'])
            self.assertEqual(parser.rows[0]['group'],'Title I: General Provisions')

    def test_current_publisher_download_page_and_links(self):
        self.assertEqual(DOWNLOAD_PAGE, 'https://uscode.house.gov/download.html')
        self.assertEqual(official_url(DOWNLOAD_PAGE), DOWNLOAD_PAGE)
        page = '<a href="download/releasepoints/us/pl/119/121/xml_usc08@119-121.zip">XML</a>'
        self.assertEqual(discover(page), ('119-121', 'https://uscode.house.gov/download/releasepoints/us/pl/119/121/xml_usc08@119-121.zip'))
        with self.assertRaises(ValueError): official_url('https://uscode.house.gov/other.html')

    def test_title8_link_only_and_relative_urls(self):
        page = '<a href="releasepoints/us/pl/120/1/xml_usc07@120-1.zip">7</a><a href="releasepoints/us/pl/119/103/xml_usc08@119-103.zip">XML</a>'
        self.assertEqual(discover(page), ('119-103', 'https://uscode.house.gov/download/releasepoints/us/pl/119/103/xml_usc08@119-103.zip'))

    def test_maintenance_and_untrusted_urls_fail(self):
        for page in ['<h1>Under maintenance</h1>', '<a href="https://evil.example/xml_usc08@119-103.zip">XML</a>', '<a href="http://uscode.house.gov/download/xml_usc08@119-103.zip">XML</a>']:
            with self.subTest(page=page), self.assertRaises(ValueError): discover(page)

    def test_release_comparison_is_numeric(self):
        self.assertGreater(release_key('119-103'), release_key('119-99'))
        with self.assertRaises(ValueError): release_key('latest')

    def test_zip_and_title_validation(self):
        self.assertEqual(extract_zip(archive(xml())), xml())
        for data in [archive(xml(), '../usc08.xml'), archive(xml(), 'usc09.xml'), b'<h1>maintenance</h1>']:
            with self.subTest(data=data[:20]), self.assertRaises(ValueError): extract_zip(data)
        for content in [xml(title='9'), xml(release='119-102'), b'<!DOCTYPE x><x/>']:
            with self.subTest(content=content[:20]), self.assertRaises(ValueError): validate_xml(content, '119-103')

    def test_source_recapture_discovers_current_release_before_downloading(self):
        module = runpy.run_path(str(ROOT / 'tools/capture-legal-sources.py'))
        capture = module['capture']
        url = 'https://uscode.house.gov/download/releasepoints/us/pl/119/121/xml_usc08@119-121.zip'
        responses = {
            DOWNLOAD_PAGE: b'<a href="download/releasepoints/us/pl/119/121/xml_usc08@119-121.zip">XML</a>',
            url: archive(xml(release='119-121')),
            module['GOVINFO_URL']: (ROOT / 'sources/legal/raw/COMPS-1376.xml').read_bytes(),
            module['USCIS_URL']: (ROOT / 'sources/legal/raw/uscis-ina-crosswalk.html').read_bytes(),
        }
        with tempfile.TemporaryDirectory() as temporary:
            work=Path(temporary)
            with patch.dict(capture.__globals__, {'ROOT':work,'RAW_ROOT':work/'raw','MANIFEST_PATH':work/'manifest.json','fetch':lambda requested:(responses[requested],requested,Message())}):
                result=capture('2026-10-20',True)
            self.assertEqual(result['sources'][0]['releasePoint'],'119-121')
            self.assertEqual(result['sources'][0]['requestedUrl'],url)


class ImportTests(unittest.TestCase):
    def test_footnotes_keep_their_side_of_child_boundaries(self):
        extract = runpy.run_path(str(ROOT / 'tools/generate-statute-footnotes.py'))['extract_field']
        node = ET.fromstring('<subsection><num>a</num><chapeau>Start<sup>1</sup></chapeau>'
                             '<paragraph><num>1</num><content>One</content></paragraph>'
                             '<continuation><sup>2</sup> End</continuation></subsection>')
        field = extract(node, {'num', 'paragraph'}, '9000:a', 'text', '9000', {})
        self.assertEqual(field['cleanText'], 'Start End')
        self.assertEqual(field['childTextOffsets'], [5])
        self.assertEqual([(ref['offset'], ref['afterChild']) for ref in field['footnoteReferences']], [(5, 0), (5, 1)])

    def test_every_operative_section_preserves_original_uslm_reading_order(self):
        # The oracle walks the publisher's XML in document order, independently
        # of the importer's grouping of parent text and structural children.
        result = import_title8(XML_PATH.read_bytes(), ADOPTED['releasePoint'], '2026-08-21')
        root = ET.fromstring(XML_PATH.read_bytes())
        source = {s.get('identifier'): s for s in root.iter(f'{{{NS}}}section') if s.get('identifier')}

        def rendered(node, section=False):
            text = node.get('preamble' if section else 'text', '')
            children = node.get('body' if section else 'children', [])
            offsets = node.get('childTextOffsets', [len(text.encode('utf-16-le')) // 2] * len(children))
            encoded = text.encode('utf-16-le')
            parts = [] if section else ['(' + node['label'] + ')', node.get('heading', '')]
            cursor = 0
            for offset, child in zip(offsets, children):
                parts.extend([encoded[cursor * 2:offset * 2].decode('utf-16-le'), rendered(child)])
                cursor = offset
            parts.append(encoded[cursor * 2:].decode('utf-16-le'))
            return ' '.join(parts)

        for section in result['sections']:
            element = source[section['identifier']]
            expected = ' '.join(''.join(child.itertext()) for child in element
                                if child.tag.rsplit('}', 1)[-1] not in {'num', 'heading', 'sourceCredit', 'notes'})
            with self.subTest(section=section['section']):
                self.assertEqual(re.sub(r'\s+', '', rendered(section, True)), re.sub(r'\s+', '', expected))

    def test_multiple_middle_and_section_continuations_preserve_unicode_boundaries(self):
        data = xml('<section identifier="/us/usc/t8/s9000"><num value="9000"/><heading>Test</heading>'
                   '<chapeau>Start😀</chapeau><subsection identifier="/us/usc/t8/s9000/a"><num value="a"/>'
                   '<chapeau>First😀</chapeau><paragraph identifier="/us/usc/t8/s9000/a/1"><num value="1"/><content>One</content></paragraph>'
                   '<continuation>Middle</continuation><paragraph identifier="/us/usc/t8/s9000/a/2"><num value="2"/><content>Two</content></paragraph>'
                   '<continuation>Last</continuation></subsection><continuation>End</continuation></section>')
        section = import_title8(data, '119-103', '2026-10-13')['sections'][0]
        self.assertEqual(section.get('childTextOffsets'), [7])
        self.assertEqual(section['body'][0].get('childTextOffsets'), [7, 14])

    def test_nested_units_and_citations_are_distinct(self):
        data = xml('<chapter><num value="12"/><heading>IMMIGRATION</heading>'
                   '<section identifier="/us/usc/t8/s1101"><num value="1101"/><heading>Definitions</heading>'
                   '<subsection identifier="/us/usc/t8/s1101/a"><num value="a"/><content>See paragraph (1)(A).</content>'
                   '<paragraph identifier="/us/usc/t8/s1101/a/1"><num value="1"/><content>Parent</content>'
                   '<subparagraph identifier="/us/usc/t8/s1101/a/1/A"><num value="A"/><content>Child</content></subparagraph>'
                   '</paragraph></subsection><notes><note topic="amendments"><heading>Amendments</heading><p>A note.</p>'
                   '</note></notes></section></chapter>')
        result = import_title8(data, '119-103', '2026-10-12')
        section = result['sections'][0]
        self.assertEqual(section['body'][0]['text'], 'See paragraph (1)(A).')
        self.assertEqual(section['body'][0]['children'][0]['children'][0]['path'], ['a','1','A'])
        self.assertEqual(section['notes'][0]['text'], 'AmendmentsA note.')
        self.assertEqual(section['breadcrumb'][0]['number'], '12')

    def test_unknown_operative_structure_blocks_instead_of_dropping_text(self):
        data = xml('<section identifier="/us/usc/t8/s1101"><num value="1101"/><heading>Test</heading><newUnit>Must survive</newUnit></section>')
        with self.assertRaisesRegex(ValueError, 'Unsupported'): import_title8(data, '119-103', '2026-10-12')

    def test_unmapped_numbered_unit_cannot_smuggle_editorial_footnote_into_law(self):
        for identifier in ['', ' identifier="/us/usc/t8/s9000/b"']:
            data = xml('<section identifier="/us/usc/t8/s9000"><num value="9000"/><heading>Test</heading>'
                       '<subsection' + identifier + '><num value="a"/><content>Law<ref class="footnoteRef" href="#f">1</ref>'
                       '<note type="footnote" id="f"><num>1</num>Editorial only.</note></content></subsection></section>')
            with self.subTest(identifier=identifier), self.assertRaisesRegex(ValueError, 'identifier'):
                import_title8(data, '119-103', '2026-10-12')

    def test_captured_release_replays_every_legal_field(self):
        source = (ROOT / 'src/INASearch-Corpus.js').read_text()
        baseline = json.loads(source[source.index('{'):source.rindex('}')+1])['title8']
        result = import_title8(XML_PATH.read_bytes(), ADOPTED['releasePoint'], '2026-08-21')
        def legal(value):
            if isinstance(value, list): return [legal(x) for x in value]
            if isinstance(value, dict):
                return {k:legal(v) for k,v in value.items() if k not in {'source','sourceCreditSource','url'}}
            return value
        self.assertEqual(len(result['sections']), len(baseline['sections']))
        for old, new in zip(baseline['sections'], result['sections']):
            with self.subTest(section=old['section']): self.assertEqual(legal(new), legal(old))


class PipelineTests(unittest.TestCase):
    def test_section_continuation_order_is_an_operative_change(self):
        section = {'section': '9000', 'status': 'current', 'preamble': 'Start End', 'body': [{'label': 'a', 'text': 'Child'}]}
        before = {'sections': [section]}
        after = {'sections': [{**section, 'childTextOffsets': [5]}]}
        self.assertEqual(changed_sections(before, after), (['9000'], []))

    def test_staging_failure_records_blocked_without_export(self):
        with tempfile.TemporaryDirectory() as temp:
            work = Path(temp)
            check(work / 'check', zip_path=ZIP_PATH, release=ADOPTED['releasePoint'])
            with patch('title8_update.pipeline.tempfile.TemporaryDirectory', side_effect=OSError('No staging space')):
                with self.assertRaisesRegex(OSError, 'No staging space'):
                    build(work / 'check', work / 'candidate')
            report = json.loads((work / 'candidate/report.json').read_text())
            self.assertEqual(report['status'], 'blocked')
            self.assertEqual(report['error'], 'No staging space')
            self.assertFalse((work / 'candidate/files.json').exists())

    def test_same_release_different_bytes_are_detected(self):
        with tempfile.TemporaryDirectory() as temp:
            work = Path(temp)
            report = check(work / 'same', zip_path=ZIP_PATH, release=ADOPTED['releasePoint'])
            self.assertFalse(report['changed'])
            data = XML_PATH.read_bytes() + b'\n'
            (work / 'changed.zip').write_bytes(archive(data))
            report = check(work / 'changed', zip_path=work / 'changed.zip', release=ADOPTED['releasePoint'])
            self.assertTrue(report['changed'])
            self.assertEqual(report['release'], report['previousRelease'])

    def test_tampered_download_never_exports_candidate_or_changes_corpus(self):
        before = (ROOT / 'src/INASearch-Corpus.js').read_bytes()
        with tempfile.TemporaryDirectory() as temp:
            work = Path(temp)
            check(work / 'check', zip_path=ZIP_PATH, release=ADOPTED['releasePoint'])
            (work / 'check/usc08.xml').write_bytes(b'corrupt')
            with self.assertRaisesRegex(ValueError, 'bytes changed'): build(work / 'check', work / 'candidate')
            self.assertFalse((work / 'candidate/files.json').exists())
        self.assertEqual((ROOT / 'src/INASearch-Corpus.js').read_bytes(), before)

    def test_disposition_overlays_require_review_on_changed_status(self):
        old = {'sections': [{'section':'1','status':'repealed'}]}
        with self.assertRaisesRegex(ValueError, 'disposition'): changed_sections(old, {'sections': [{'section':'1','status':'current'}]})


if __name__ == '__main__': unittest.main()
