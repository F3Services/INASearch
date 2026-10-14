"""Regenerate only in a temporary candidate tree; export only after all gates pass."""
import copy
import datetime
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

from .source import DOWNLOAD_PAGE, digest, discover, extract_zip, fetch, official_url, release_key, validate_xml
from .uslm import import_title8

ROOT = Path(__file__).resolve().parents[2]
GENERATED = [
    'src/INASearch-Corpus.js', 'src/INASearch-Statute-Footnotes.js',
    'src/INASearch-Statute-References.js', 'src/INASearch-INA-Hierarchy.js',
    'sources/legal/source-manifest.json', 'sources/legal/ina-crosswalk-audit.json',
    'sources/legal/referenced-usc/corpus.json', 'sources/legal/referenced-usc/selection.json',
    'INASearch.html', 'INASearch-Uncompressed.html',
]
REGRESSIONS = [
    'test-usc-source-order.js',
    'test-title8-update.js', 'test-mixed-citations.js',
    'test-flat-statute-reference-preview.js', 'test-historical-run-in-paths.js',
    'test-historical-reference-stability.js', 'test-reference-authorities.js',
    'test-cfr-subpart-references.js', 'test-referenced-usc-links.js',
]


def read_json(path):
    return json.loads(Path(path).read_text())


def write_json(path, value):
    Path(path).write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')


def assigned(path):
    text = Path(path).read_text()
    return json.loads(text[text.index('{'):text.rindex('}') + 1])


def write_corpus(path, value):
    text = json.dumps(value, ensure_ascii=False, indent=2).replace('<', '\\u003c').replace('\u2028', '\\u2028').replace('\u2029', '\\u2029')
    Path(path).write_text('/* INASearch public corpus. Replace as one reviewed unit. */\nwindow.INA_SEARCH_CORPUS = ' + text + ';\n')


def source_record(manifest):
    return next(s for s in manifest['sources'] if s['id'] == 'house-title-8-uslm')


def check(output, root=ROOT, zip_path=None, release=None):
    output = Path(output)
    output.mkdir(parents=True, exist_ok=True)
    # Prevent a failed/reused directory from retaining yesterday's successful report.
    write_json(output / 'report.json', {'schemaVersion': 1, 'status': 'checking', 'changed': False})
    previous = source_record(read_json(root / 'sources/legal/source-manifest.json'))
    if zip_path:
        if not release: raise ValueError('--release is required with an offline ZIP')
        release_key(release)
        congress, law = release.split('not')[0].split('-')
        url = f'https://uscode.house.gov/download/releasepoints/us/pl/{congress}/{law}/xml_usc08@{release}.zip'
        archive = Path(zip_path).read_bytes()
    else:
        release, url = discover(fetch(DOWNLOAD_PAGE).decode('utf-8'))
        archive = fetch(url)
    xml = extract_zip(archive)
    validate_xml(xml, release)
    if release_key(release) < release_key(previous['releasePoint']):
        raise ValueError('OLRC source is older than the adopted release; refusing downgrade')
    old_artifact = next(a for a in previous['artifacts'] if a['id'] == 'house-title-8-xml')
    changed = release != previous['releasePoint'] or digest(xml) != old_artifact['sha256']
    report = {'schemaVersion': 1, 'status': 'detected' if changed else 'current', 'changed': changed,
              'release': release, 'previousRelease': previous['releasePoint'], 'sourceUrl': url,
              'xmlSha256': digest(xml), 'zipSha256': digest(archive), 'xmlBytes': len(xml),
              'previousXmlSha256': old_artifact['sha256'],
              'checkedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'offlineReplay': bool(zip_path)}
    (output / 'usc08.xml').write_bytes(xml)
    (output / 'source.zip').write_bytes(archive)
    write_json(output / 'report.json', report)
    return report


def changed_sections(old, new):
    def legal(section):
        return {k:section.get(k) for k in ('identifier', 'heading', 'status', 'breadcrumb', 'preamble', 'body', 'childTextOffsets', 'sourceCredit')}
    before = {s['section']: s for s in old['sections']}
    after = {s['section']: s for s in new['sections']}
    # Historical/status overlays encode reviewed dispositions. A changed status
    # must be reconciled before those overlays can safely be applied again.
    missing = set(before) - set(after)
    dispositions = [n for n in before.keys() & after.keys() if before[n]['status'] != after[n]['status']]
    if missing or dispositions:
        raise ValueError('Section removal/disposition changed; review historical overlays: ' + ', '.join(sorted(missing | set(dispositions))))
    changed = [n for n in after if n not in before or legal(before[n]) != legal(after[n])]
    note_changes = [n for n in before.keys() & after.keys()
                    if [(x['topic'], x['heading'], x['text']) for x in before[n].get('notes', [])]
                    != [(x['topic'], x['heading'], x['text']) for x in after[n].get('notes', [])]]
    return changed, sorted(note_changes)


def run(stage, command, log):
    label = ' '.join(['python3' if arg == sys.executable else arg for arg in command])
    print('Running ' + label, flush=True)
    with log.open('a') as stream:
        stream.write('\n$ ' + label + '\n')
        stream.flush()
        result = subprocess.run(command, cwd=stage, stdout=stream, stderr=subprocess.STDOUT, timeout=900)
    if result.returncode:
        raise RuntimeError('Candidate gate failed: ' + label)


def build(check_dir, output, root=ROOT):
    check_dir, output, root = Path(check_dir).resolve(), Path(output).resolve(), Path(root).resolve()
    if output.exists():
        raise ValueError('Candidate output directory already exists; choose a fresh directory')
    output.mkdir(parents=True)
    report = read_json(check_dir / 'report.json')
    if report.get('status') not in {'detected', 'current'}:
        raise ValueError('A successful source check is required')
    archive, xml = (check_dir / 'source.zip').read_bytes(), (check_dir / 'usc08.xml').read_bytes()
    if digest(xml) != report['xmlSha256'] or digest(archive) != report['zipSha256'] or extract_zip(archive) != xml:
        raise ValueError('Checked source bytes changed before build')
    official_url(report['sourceUrl'])
    release = report['release']
    validate_xml(xml, release)
    log = output / 'build.log'
    write_json(output / 'report.json', {**report, 'status': 'building'})
    stage = None
    def redact_paths(text):
        text = text.replace(str(root), '<project>')
        return text.replace(str(stage), '<candidate>') if stage is not None else text
    try:
        with tempfile.TemporaryDirectory(prefix='inasearch-title8-') as temporary:
            stage = Path(temporary)
            for directory in ['src', 'tools', 'sources/legal']:
                shutil.copytree(root / directory, stage / directory, ignore=shutil.ignore_patterns('__pycache__', '*.pyc'))
            for name in ['package.json', 'package-lock.json', 'FAQ.md', 'LICENSE', 'THIRD-PARTY-NOTICES.txt']:
                shutil.copy2(root / name, stage / name)
            if not (root / 'node_modules').is_dir(): raise ValueError('Run npm ci before building a candidate')
            (stage / 'node_modules').symlink_to(root / 'node_modules', target_is_directory=True)
            # Baseline and candidate use exactly the same current parser/runtime.
            run(stage, ['node', 'tools/build-standalone.js'], log)
            run(stage, ['node', 'tools/title8-update-gate.js', 'snapshot', 'baseline.json'], log)
            old = assigned(stage / 'src/INASearch-Corpus.js')
            adopted = source_record(read_json(stage / 'sources/legal/source-manifest.json'))
            adopted_xml = next(a for a in adopted['artifacts'] if a['id'] == 'house-title-8-xml')
            if adopted_xml['sha256'] != report['previousXmlSha256']:
                raise ValueError('Adopted source changed after check; run check again')
            day = report['checkedAt'][:10]
            fresh = import_title8(xml, release, day)
            operative_changes, note_changes = changed_sections(old['title8'], fresh)
            version = 'title8-' + release + '-' + report['xmlSha256'][:12]
            corpus = copy.deepcopy(old)
            corpus['title8'] = fresh
            corpus['title8Update'] = {'corpusVersion': version, 'release': release, 'xmlSha256': report['xmlSha256']}
            corpus['corpusVersion'] = version
            corpus['verifiedAt'] = day
            xml_file = f'sources/legal/raw/usc08@{release}.xml'
            zip_file = f'sources/legal/raw/xml_usc08@{release}.zip'
            (stage / xml_file).write_bytes(xml)
            (stage / zip_file).write_bytes(archive)
            manifest = read_json(stage / 'sources/legal/source-manifest.json')
            house = source_record(manifest)
            house.update({'releasePoint': release, 'currentThroughPublicLaw': release,
                          'requestedUrl': report['sourceUrl'], 'finalUrl': report['sourceUrl'],
                          'capturedAt': day, 'lastModified': None, 'etag': None})
            for artifact in house['artifacts']:
                is_xml = artifact['id'] == 'house-title-8-xml'
                value = xml if is_xml else archive
                artifact.update({'path': xml_file if is_xml else zip_file, 'bytes': len(value), 'sha256': digest(value)})
            write_json(stage / 'sources/legal/source-manifest.json', manifest)
            corpus['sources']['title8'].update({'url': report['sourceUrl'], 'capturedAt': day,
                'currentThrough': release, 'sourceArtifact': xml_file, 'sourceBytes': len(xml), 'sourceSha256': digest(xml)})
            write_corpus(stage / 'src/INASearch-Corpus.js', corpus)
            for command in [
                [sys.executable, 'tools/capture-legal-sources.py', 'verify'],
                [sys.executable, 'tools/generate-statute-footnotes.py'],
                ['node', 'tools/generate-statute-references.js'],
                [sys.executable, 'tools/generate-ina-crosswalk.py', '--write'],
                [sys.executable, 'tools/generate-ina-hierarchy.py'],
                [sys.executable, 'tools/referenced-usc.py'],
                ['node', 'tools/build-standalone.js'],
                ['node', 'tools/title8-update-gate.js', 'verify', 'baseline.json'],
            ]:
                run(stage, command, log)
            for name in REGRESSIONS: run(stage, ['node', 'tools/' + name], log)
            # Export is deliberately last. Failed candidates never receive files.json.
            exported = []
            for name in GENERATED + [xml_file, zip_file]:
                src = stage / name
                data = src.read_bytes()
                if (root / name).is_file() and (root / name).read_bytes() == data: continue
                target = output / 'candidate' / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(data)
                exported.append({'path': name, 'bytes': len(data), 'sha256': digest(data)})
            write_json(output / 'files.json', exported)
            report.update({'status': 'ready', 'corpusVersion': version, 'changedOperativeSections': operative_changes,
                           'changedNoteSections': note_changes, 'sectionCount': len(fresh['sections']),
                           'files': len(exported), 'gates': ['source-integrity', 'crosswalk', 'unchanged-citations', *REGRESSIONS]})
            write_json(output / 'report.json', report)
    except Exception as error:
        message = redact_paths(str(error))
        report.update({'status': 'blocked', 'error': message})
        write_json(output / 'report.json', report)
        # No partial export is considered adoptable.
        (output / 'files.json').unlink(missing_ok=True)
        raise
    finally:
        if log.exists():
            log.write_text(redact_paths(log.read_text()))
    return report
