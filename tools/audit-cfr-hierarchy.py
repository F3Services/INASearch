#!/usr/bin/env python3
"""Classify numbering anomalies independently of the runtime hierarchy engine."""
import collections
import importlib.util
import json
import re
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('generator',ROOT/'tools/generate-cfr-corpus.py')
gen=importlib.util.module_from_spec(spec);spec.loader.exec_module(gen)
cache=ROOT/'tmp/cfr-cache';capture=json.loads((cache/'capture.json').read_text())
source=(ROOT/'src/INASearch-CFR.js').read_text();corpus=json.loads(source[source.index('=')+1:source.rindex(';')])
records={record['id']:record for record in corpus['sections']}
reviews=json.loads((ROOT/'sources/legal/cfr-hierarchy/reviewed-expectations.json').read_text())['reviews']
findings=[];unclassified=[];counts=collections.Counter();paragraphs=0
for key,source in capture['renderers'].items():
 title,part=int(source['title']),str(source['part'])
 raw=gen.read_verified(cache/'ecfr-rendered'/source['file'],source,key)
 renderer=gen.parse_enhanced_html(raw,title,part)
 for number,rendered in renderer['sections'].items():
  record=records[f'{title}:{number}']
  for position,paragraph in enumerate(rendered['paragraphs']):
   paragraphs+=1
   if not re.match(r'^\s*\([A-Za-z0-9-]+\)',paragraph['text']) or (paragraph['addressable'] and not paragraph['term'] and not paragraph['disabled']):continue
   canonical=gen.canonical_match_text(paragraph['text'])
   blocks=[(i,b) for i,b in enumerate(record['blocks']) if canonical in gen.canonical_match_text(b.get('x',''))]
   if paragraph['term'] or paragraph['disabled']:category='intentional publisher definition or disabled list'
   elif any(b.get('u') for _,b in blocks):category='restored source marker'
   elif any(review['id']==record['id'] and any(review['firstBlock']<=i<=review['lastBlock'] for i,_ in blocks) for review in reviews):category='reviewed local list or form content'
   else:category='unclassified';unclassified.append([record['id'],position])
   counts[category]+=1
   findings.append({'record':record['id'],'sourceParagraph':position,'rendererPath':gen.paragraph_path(paragraph['path']),'visibleText':paragraph['text'],'classification':category,'rendererSha256':source['sha256']})
# Independently inspect corrected markers, parent existence, styles and repeated designations.
occurrences=0;parents=set();repeated=[];italic=0
for record in [*corpus['sections'],*corpus['appendices']]:
 paths=collections.defaultdict(list)
 for i,block in enumerate(record['blocks']):
  for marker in block.get('u',[]):paths[marker['a']].append(i);occurrences+=1
  runs=block.get('r',[])
  if len(runs)>1 and runs[0]['x']=='(' and runs[1].get('s')=='i' and block.get('u'):
   expected=5 if re.fullmatch(r'\d+',runs[1]['x']) else 6 if re.fullmatch(r'[ivxlcdm]+',runs[1]['x']) else 0
   if expected:
    italic+=1
    assert len(re.findall(r'\([^()]+\)',block['u'][0]['a']))==expected,(record['id'],i)
 for path,positions in paths.items():
  tokens=re.findall(r'\([^()]+\)',path);assert ''.join(tokens)==path
  for depth in range(1,len(tokens)):
   parent=''.join(tokens[:depth]);assert parent in paths,(record['id'],path,parent);parents.add((record['id'],parent))
  if len(positions)>1:
   classification='repeated appendix outline' if not record.get('section') else 'reviewed repeated source designation'
   if record.get('section'):assert any(review['id']==record['id'] for review in reviews)
   repeated.append({'record':record['id'],'path':path,'blocks':positions,'classification':classification})
assert not unclassified,unclassified
report={'result':'pass','sourceParagraphsInspected':paragraphs,'markerFindings':dict(counts),'sourceMarkerOccurrences':occurrences,'parentPaths':len(parents),'isolatedItalicMarkersChecked':italic,'repeatedDesignations':repeated,'findings':findings}
p=ROOT/'sources/legal/cfr-hierarchy/source-findings.json';p.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
print({key:value for key,value in report.items() if key not in ['findings','repeatedDesignations']})
