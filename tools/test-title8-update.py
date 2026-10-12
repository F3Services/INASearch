#!/usr/bin/env python3
"""Offline source/import regression tests; no publisher or GitHub writes."""
import io
import json
from pathlib import Path
import unittest
from unittest.mock import patch
import zipfile
import tempfile

from title8_update.source import discover, extract_zip, release_key, validate_xml
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


class ImportTests(unittest.TestCase):
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
