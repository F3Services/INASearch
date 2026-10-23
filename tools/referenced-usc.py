#!/usr/bin/env python3
"""Build one-hop, full-parent USC sections from committed official-source excerpts.

Routine regeneration: python3 tools/referenced-usc.py
Capture from an audited full-USC archive: --capture-from PATH
Neither operation changes the application or follows citations in added sections.
"""
from __future__ import annotations
import argparse
import collections
import copy
import hashlib
import html
from html.parser import HTMLParser
import json
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[1]
DEST = ROOT / 'sources/legal/referenced-usc'
HEAD_LEVELS = {'subsection-head': 0, 'paragraph-head': 1, 'subparagraph-head': 2, 'clause-head': 3, 'subclause-head': 4, 'item-head': 5, 'subitem-head': 6, 'subsubclause-head': 5, 'subsubsubclause-head': 6}
BLOCKS = {'p','h1','h2','h3','h4','h5','h6','table','pre','blockquote','li'}

def normalize(value):
    return re.sub(r'\s+', ' ', str(value or '')).strip()

def norm_section(value):
    return str(value or '').replace('–','-').replace('—','-').lower().strip()

def digest(value):
    return hashlib.sha256(value).hexdigest()

def field(source, name):
    return '\n'.join(re.findall(r'<!--\s*field-start:'+re.escape(name)+r'\s*-->(.*?)<!--\s*field-end:'+re.escape(name)+r'\s*-->', source, re.S))

class Fragment(HTMLParser):
    def __init__(self, source):
        super().__init__(convert_charrefs=True)
        self.root = {'tag':'root','attrs':{},'children':[]}
        self.stack=[self.root]
        self.feed(source)
    def handle_starttag(self, tag, attrs):
        node={'tag':tag,'attrs':dict(attrs),'children':[]}
        self.stack[-1]['children'].append(node)
        if tag not in {'br','img','hr','meta','link','input'}: self.stack.append(node)
    def handle_endtag(self, tag):
        for i in range(len(self.stack)-1,0,-1):
            if self.stack[i]['tag']==tag:
                del self.stack[i:]
                break
    def handle_data(self, value):
        self.stack[-1]['children'].append(value)

def plain(node):
    if isinstance(node,str): return node
    tag=node['tag']
    if tag in {'script','style'}: return ''
    if tag=='a' and re.fullmatch(r'#[^#]+_target',node['attrs'].get('href','')): return ''
    if tag=='img': raise ValueError('Operative image needs explicit capture; refusing silent data loss')
    value=''.join(plain(c) for c in node['children'])
    if tag=='sup': return value.translate(str.maketrans('0123456789+-=()in','⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾ⁱⁿ'))
    if tag=='sub': return value.translate(str.maketrans('0123456789+-=()','₀₁₂₃₄₅₆₇₈₉₊₋₌₍₎'))
    return value+('\n' if tag in BLOCKS or tag in {'br','tr'} else '\t' if tag in {'td','th'} else '')

def blocks(source):
    result=[]
    def walk(node):
        if isinstance(node,str):
            if normalize(node): raise ValueError('Unexpected unwrapped operative text: '+node[:80])
            return
        if node['tag'] in BLOCKS:
            if normalize(plain(node)): result.append(node)
            return
        for child in node['children']: walk(child)
    walk(Fragment(source).root)
    return result

def parse_operative(source):
    body=[]; stack=[]; preamble=[]
    parsed=blocks(source)
    uses_heads=any('subsection-head' in (b['attrs'].get('class') or '').split() for b in parsed)
    root_numeric=False
    def append_text(owner, value):
        if owner.get('children'):
            owner['children'].append({'label':'','heading':'','text':value,'children':[]})
        else:
            owner['text']=normalize(owner.get('text','')+' '+value)
    for b in parsed:
        value=normalize(plain(b)); classes=(b['attrs'].get('class') or '').split()
        match=re.match(r'^((?:\((?:[A-Za-z]{1,3}|[ivxlcdmIVXLCDM]+|[0-9]+[A-Za-z]?)\)\s*)+)',value)
        indent=re.search(r'-(\d+(?:\.\d+)?)em',' '.join(classes))
        flush=re.search(r'-flush(\d+)_hang\d+',' '.join(classes))
        physical=float(indent[1]) if indent else int(flush[1])/2 if flush else 0
        if b['tag']=='table':
            rows=[]
            def table_rows(element):
                if isinstance(element,str):return
                if element['tag']=='tr':
                    rows.append([normalize(plain(cell)) for cell in element['children'] if isinstance(cell,dict) and cell['tag'] in {'td','th'}])
                else:
                    for child in element['children']:table_rows(child)
            table_rows(b)
            node={'label':'','heading':'','text':value,'children':[],'table':{'rows':rows}}
            (stack[-1][1]['children'] if stack else body).append(node)
            continue
        if not match:
            while stack and stack[-1][2]>physical: stack.pop()
            owner=stack[-1][1] if stack else None
            if owner is not None: append_text(owner,value)
            elif body: body.append({'label':'','heading':'','text':value,'children':[]})
            else: preamble.append(value)
            continue
        labels=re.findall(r'\(([^)]+)\)',match[1]); label=labels[0]
        if not body and not stack and label.isdigit(): root_numeric=True
        hint=next((HEAD_LEVELS[c] for c in classes if c in HEAD_LEVELS),None)
        capital_parent=next((x for x in reversed(stack) if x[0]==2),None)
        next_capital=bool(capital_parent and len(label)==1 and len(capital_parent[1]['label'])==1 and ord(label)==ord(capital_parent[1]['label'])+1 and physical<=capital_parent[2])
        if hint is not None: level=hint
        elif label.isupper() and next_capital: level=2
        elif label.isdigit(): level=1
        elif label.isupper(): level=6 if len(label)>1 and (physical>=5 or not re.fullmatch('[IVXLCDM]+',label)) else 4 if re.fullmatch('[IVXLCDM]+',label) and (len(label)>1 or label in {'I','V','X'} and any(x[0]==3 for x in stack)) else 2
        elif len(label)>1:
            previous_item=next((x[1]['label'] for x in reversed(stack) if x[0]==5),'')
            next_item=len(previous_item)==len(label) and len(set(label))==1 and len(set(previous_item))==1 and ord(label[0])==ord(previous_item[0])+1
            level=5 if next_item or not re.fullmatch('[ivxlcdm]+',label) and (physical>=4 or any(x[0]==4 for x in stack)) else 3 if re.fullmatch('[ivxlcdm]+',label) else 0
        else:
            top=next((x[1]['label'] for x in stack if x[0]==0),'')
            next_top=not uses_heads and len(top)==1 and ord(label)==ord(top)+1 and physical==0
            level=3 if label in {'i','v','x'} and any(x[0] in {1,2,3} for x in stack) and not next_top else 5 if any(x[0]==4 for x in stack) and uses_heads else 0
        while stack and stack[-1][0]>=level: stack.pop()
        remainder=value[match.end():].strip()
        for offset,label in enumerate(labels):
            last=offset==len(labels)-1
            node={'label':label,'heading':remainder if last and b['tag'].startswith('h') else '', 'text':remainder if last and not b['tag'].startswith('h') else '', 'children':[]}
            (stack[-1][1]['children'] if stack else body).append(node)
            stack.append((level+offset,node,physical))
        # Recognize explicit run-in first children without changing the words.
        run=re.match(r'^(.{0,180}?—)\s*\((1|A|i)\)\s*(.*)$',remainder)
        if run and len(labels)==1 and not b['tag'].startswith('h'):
            stack[-1][1]['text']=run[1]
            child={'label':run[2],'heading':'','text':run[3],'children':[]}
            stack[-1][1]['children'].append(child)
            stack.append((level+1,child,physical))
    def fold_continuations(nodes):
        for node in nodes:
            fold_continuations(node['children'])
            trailing=[]
            while node['children'] and not node['children'][-1]['label'] and not node['children'][-1].get('table') and not node['children'][-1]['children']:
                trailing.insert(0,node['children'].pop()['text'])
            if trailing:node['continuation']=normalize(' '.join(trailing))
    fold_continuations(body)
    result={'preamble':normalize(' '.join(preamble)), 'body':body}
    original=normalize(' '.join(plain(b) for b in parsed))
    rendered=flatten_operative(result)
    # Whitespace surrounding legal markers varies in published run-ins.
    squeeze=lambda s: re.sub(r'\s+','',s)
    if squeeze(original)!=squeeze(rendered): raise ValueError('Parsed operative text differs from the original source')
    return result

def flatten_operative(section):
    result=[section.get('preamble','')]
    def visit(nodes):
        for n in nodes:
            result.extend(['('+n['label']+')' if n['label'] else '',n.get('heading',''),n.get('text','')])
            visit(n.get('children',[]));result.append(n.get('continuation',''))
    visit(section.get('body',[]))
    return normalize(' '.join(result))

def select_references(references, ina_sections):
    selected=collections.defaultdict(list);excluded=[];corrections=[]
    fixes={('42','7'):('42','1320b-7'),('18','274'):('8','1324'),('20','655.202'):('cfr','655.202'),('8','214.2'):('cfr','214.2'),('49','4106'):('pl','4106'),('22','7081'):('pl','7081'),('22','4212-421'):('range','4212-4214')}
    for original in references:
        if original.get('family')!='usc' or str(original.get('targetTitle'))=='8': continue
        r=copy.deepcopy(original);t,s=str(r.get('targetTitle')),norm_section(r.get('targetSection')); reason=None
        if r.get('context')!='operative': reason='Reference outside current operative body or preamble'
        elif norm_section(r.get('sourceSection')) not in ina_sections: reason='Reference outside INA-mapped operative provisions'
        elif not s: reason='Named group or whole title'
        elif (t,s) in fixes:
            old=(t,s);t,s=fixes[t,s]
            corrections.append({'sourceSection':r['sourceSection'],'from':':'.join(old),'to':f'{t}:{s}','reason':'Correct citation context misclassification'})
            if t in {'8','cfr','pl'}: reason='Not an additional USC section'
            elif t=='range':reason='Section range'
        if not reason:
            text=r.get('text','');after=r.get('after','')
            if re.search(r'\bet\s+seq\.?',text,re.I) or re.match(r'^\s*et\s+seq\.?',after,re.I): reason='Et seq. group'
            elif f'{t}:{s}' in {'42:14611-16','34:40311-16'}:reason='Compact section range'
            elif re.search(r'\b\d+[a-z]*\s+(?:to|through)\s+\d+[a-z]*\b',text,re.I):reason='Section range'
            elif re.search(r'\b\d+[a-z]*\s*[–—]\s*\d+[a-z]*\b',text,re.I) and not re.fullmatch(r'\d+[a-z]*-\d+',s):reason='Section range'
        if not reason:
            source_text=r.get('sourceText',r.get('text',''))
            for match in re.finditer(r'\b(\d+[a-z]*)(?:\s+(?:to|through)\s+|\s*[–—]\s*)(\d+[a-z]*)\b',source_text,re.I):
                if r.get('start',0)<match.end() and r.get('end',len(source_text))>match.start():
                    if norm_section(match[0]).replace(' ','')!=s:
                        reason='Section range';break
        if reason:
            excluded.append({**r,'reason':reason});continue
        explicit=re.search(r'\bU\.?\s*S\.?\s*C\.?\s*\d[\w–-]*((?:\([^)]*\))+)',r.get('text',''))
        if explicit:
            actual=re.findall(r'\(([^)]+)\)',explicit[1])
            if actual!=r.get('targetPath',[]):corrections.append({'target':f'{t}:{s}','fromPath':r.get('targetPath',[]),'toPath':actual,'reason':'Explicit displayed USC citation'});r['targetPath']=actual
        r['targetTitle']=t;r['targetSection']=s
        selected[f'{t}:{s}'].append(r)
    return dict(selected),excluded,corrections

NODE_REFERENCE_EXPORT = r'''
const fs=require('fs'),path=require('path'),vm=require('vm');const root=process.cwd();
function assigned(file,prop){const box={window:{}};vm.runInNewContext(fs.readFileSync(path.join(root,'src',file),'utf8'),box);return JSON.parse(JSON.stringify(box.window[prop]));}
const corpus=assigned('INASearch-Corpus.js','INA_SEARCH_CORPUS');
corpus.cfr=assigned('INASearch-CFR.js','INA_SEARCH_CFR');
corpus.inaHierarchy=assigned('INASearch-INA-Hierarchy.js','INA_SEARCH_INA_HIERARCHY');
corpus.legalReferencePolicy=assigned('INASearch-Legal-Reference-Policy.js','INA_SEARCH_LEGAL_REFERENCE_POLICY');
require('./tools/statute-footnotes').applyStatuteFootnotes(corpus,assigned('INASearch-Statute-Footnotes.js','INA_SEARCH_STATUTE_FOOTNOTES'));
require('./tools/statute-references').applyStatuteReferences(corpus,assigned('INASearch-Statute-References.js','INA_SEARCH_STATUTE_REFERENCES'));
// Validate the same complete source context as the standalone build. Exact
// exceptions in supplements must be checked, even though selection below is
// restricted to current Title 8 provisions and never follows their references.
require('./tools/historical-ina').applyHistoricalIna(corpus);
require('./tools/statute-status').applyStatuteStatusMetadata(corpus);
require('./tools/historical-usc').applyHistoricalUsc(corpus);
require('./tools/statute-run-ins').indexStatuteRunIns(corpus);
corpus.referencedUsc=JSON.parse(fs.readFileSync('sources/legal/referenced-usc/corpus.json'));
corpus.uscHierarchyLinks=JSON.parse(fs.readFileSync('sources/legal/usc-hierarchy-links.json'));
require('./tools/statute-run-ins').indexStatuteRunIns({title8:{sections:corpus.referencedUsc.titles.flatMap(title=>title.sections)}});
corpus.legalReferenceExceptions=JSON.parse(fs.readFileSync('sources/legal/embedded-reference-exceptions.json'));
corpus.historicalLocatorCorrections=JSON.parse(fs.readFileSync('sources/legal/historical-reference-locators.json'));
require('./tools/legal-references').applyGeneratedLegalReferences(corpus);
const references=[];
function visit(s,node,fieldPath,context){
 for(const key of ['heading','preamble','text','continuation']){
  const text=node[key];if(typeof text!=='string')continue;
  for(const ref of node[key==='text'?'references':key+'References']||[])references.push({...ref,text:text.slice(ref.start,ref.end),sourceSection:s.section,context:key==='heading'?'heading':context,field:fieldPath+key,before:text.slice(Math.max(0,ref.start-70),ref.start),after:text.slice(ref.end,ref.end+140),sourceText:text});
 }
 (node.children||[]).forEach((n,i)=>visit(s,n,fieldPath+'children.'+i+'.',context));
}
for(const s of corpus.title8.sections.filter(section=>!section.historical)){
 visit(s,s,'','operative');
 (s.body||[]).forEach((n,i)=>visit(s,n,'body.'+i+'.','operative'));
 (s.notes||[]).forEach((n,i)=>visit(s,n,'notes.'+i+'.','notes'));
}
const inaSections = corpus.inaCrosswalk.filter(row => !row.historicalMapping && !row.isNote && row.hasEquivalent !== false && row.uscSection).map(row => String(row.localSection || row.uscSection).toLowerCase());
process.stdout.write(JSON.stringify({references,inaSections,title8Source:corpus.sources.title8}));
'''

def load_references():
    result=subprocess.run(['node','-e',NODE_REFERENCE_EXPORT],cwd=ROOT,text=True,capture_output=True)
    if result.returncode:raise RuntimeError(result.stderr.strip())
    return json.loads(result.stdout)


def capture_sources(base, selected):
    manifest=json.loads((base/'sources/legal/full-usc/manifest.json').read_text())
    inventory={'schemaVersion':1,'edition':2024,'currentThrough':'2025-01-06','publisher':'U.S. Government Publishing Office / Office of the Law Revision Counsel','captureMethod':'Verbatim document records excerpted from SHA-256 verified official title HTML; original statute, head, sourcecredit, and operative footnote fields only.','artifacts':[],'unavailable':[]}
    (DEST/'raw').mkdir(parents=True,exist_ok=True)
    for title in sorted({int(k.split(':')[0]) for k in selected}):
        artifact=next(a for a in manifest['artifacts'] if a['title']==title and not a['appendix'] and a['path'].endswith('.htm'))
        raw=(base/artifact['path']).read_bytes()
        if digest(raw)!=artifact['sha256']:raise ValueError('Official archive hash mismatch: '+artifact['path'])
        original=json.loads((base/f'sources/legal/full-usc/generated/title-{title}.json').read_text())
        sections={norm_section(s['section']):s for s in original['sections'] if not s.get('appendix')}
        docs={re.search(r'documentid:(\S+)',part)[1]:part for part in re.split(r'(?=<!--\s*documentid:)',raw.decode()) if re.search(r'documentid:(\S+)',part)}
        for key in sorted(k for k in selected if k.startswith(str(title)+':')):
            number=key.split(':')[1];section=sections.get(number)
            if not section or section['status']!='active':
                document=section['documentId'] if section else next((doc for doc in docs if doc.startswith(f'{title}_{number}_to_')),None)
                disposition=docs.get(document,'')
                heading=normalize(plain(Fragment(field(disposition,'head') or field(disposition,'repealedhead')).root))
                status=section['status'] if section else next((word for word in ['repealed','transferred','omitted','reserved'] if word in heading.lower()),'no-current-individual-record')
                inventory['unavailable'].append({'target':key,'status':status,'heading':heading,'sourceUrl':artifact.get('url') or f'https://www.govinfo.gov/content/pkg/USCODE-2024-title{title}/html/USCODE-2024-title{title}.htm','documentId':document,'sourceTitleSha256':artifact['sha256'],'reason':'No current operative text in source edition; historical locator remains external.'});continue
            source=docs[section['documentId']]
            operative=field(source,'statute')
            if not operative.strip():raise ValueError('Active target has no operative field: '+key)
            fields=['head','statute','sourcecredit','footnote']
            excerpt='\n'.join('<!-- field-start:'+f+' -->\n'+field(source,f)+'\n<!-- field-end:'+f+' -->' for f in fields if field(source,f))
            filename=f'raw/title-{title}-section-{number}.html';blob=excerpt.encode()
            (DEST/filename).write_bytes(blob)
            metadata={k:copy.deepcopy(section[k]) for k in ['title','section','heading','status','breadcrumb','documentId','currentThrough']}
            inventory['artifacts'].append({**metadata,'target':key,'titleName':original['name'],'path':filename,'sha256':digest(blob),'bytes':len(blob),'sourceUrl':artifact.get('url') or section['url'],'sourceTitleSha256':artifact['sha256'],'sourceTitleBytes':len(raw)})
    used={a['path'] for a in inventory['artifacts']}
    for path in (DEST/'raw').glob('title-*-section-*.html'):
        if str(path.relative_to(DEST)) not in used:path.unlink()
    (DEST/'source-inventory.json').write_text(json.dumps(inventory,ensure_ascii=False,indent=2)+'\n')

def capture_current_sources(base, selected):
    """Excerpt the reviewed current OLRC title captures without changing scope."""
    manifest=json.loads((base/'manifest.json').read_text())
    release=manifest['releasePoint'];current=manifest['currentThrough']
    if not re.fullmatch(r'\d+-\d+',release) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}',current):
        raise ValueError('Invalid captured current release metadata')
    inventory={k:manifest[k] for k in ['edition','releasePoint','currentThrough','capturedAt','publisher']}
    inventory.update({'schemaVersion':1,'captureMethod':'Fields excerpted from SHA-256 verified current official OLRC title XHTML archives; head, statute, sourcecredit, and operative footnote fields only. CRLF line endings are normalized to LF; source title hashes and byte counts describe the unmodified publisher bytes.','artifacts':[],'unavailable':[]})
    (DEST/'raw').mkdir(parents=True,exist_ok=True)
    for title in sorted({int(k.split(':')[0]) for k in selected}):
        artifact=next(a for a in manifest['artifacts'] if a['title']==title)
        raw=(base/artifact['path']).read_bytes()
        if digest(raw)!=artifact['sha256']:raise ValueError('Official current archive hash mismatch: '+artifact['path'])
        # Retain malformed publisher bytes outside the selected fields without
        # silently replacing them. Each adopted excerpt is encoded strictly.
        source=raw.decode('utf-8',errors='surrogateescape')
        currency=re.search(r'AUTHORITIES-LAWS-ENACTED-THROUGH:([^<]+)-->',source)
        expected=current[5:7]+'/'+current[8:10]+'/'+current[:4]
        if not currency or normalize(currency[1])!=release+' ('+expected+')':raise ValueError('Current source currency mismatch')
        title_head=re.search(r'AUTHORITIES-USC-TITLE-NAME:TITLE\s+'+str(title)+r'\s*-\s*(.*?)\s*-->',source)
        if not title_head:raise ValueError('Missing current title metadata')
        docs={re.search(r'documentid:(\S+)',part)[1].lower():part for part in re.split(r'(?=<!--\s*documentid:)',source) if re.search(r'documentid:(\S+)',part)}
        for key in sorted(k for k in selected if k.startswith(str(title)+':')):
            number=key.split(':')[1];document=f'{title}_{number}'
            if document not in docs:
                document=next((d for d in docs if d.startswith(f'{title}_{number}_to_')),document)
            record=docs.get(document,'')
            if not record:raise ValueError('No current source disposition found: '+key)
            canonical_document=re.search(r'documentid:(\S+)',record)[1]
            canonical_number=canonical_document.removeprefix(str(title)+'_')
            heading=normalize(plain(Fragment(field(record,'head') or field(record,'repealedhead')).root))
            heading=re.sub(r'^§{1,2}\s*[^.]+\.\s*','',heading)
            operative=field(record,'statute')
            if not operative.strip():
                status=next((word for word in ['repealed','transferred','omitted','reserved'] if word in heading.lower()),'no-current-individual-record')
                inventory['unavailable'].append({'target':key,'status':status,'heading':heading,'sourceUrl':artifact['url'],'documentId':document,'sourceTitleSha256':artifact['sha256'],'reason':'No current operative text in source release; historical locator remains external.'})
                continue
            # Verify the operative source can be represented before adopting it.
            parse_operative(operative)
            cite=re.search(r'<!--\s*expcite:(.*?)\s*-->',record)
            breadcrumb=[]
            for item in (cite[1].split('!@!')[1:-1] if cite else []):
                match=re.match(r'(SUBTITLE|SUBPART|SUBCHAPTER|DIVISION|PART|CHAPTER|SUBDIVISION)\s+([^ -]+)[ -]+(.*)',item,re.I)
                if not match:raise ValueError('Unknown current hierarchy: '+item)
                breadcrumb.append({'kind':match[1].lower(),'number':match[2],'title':html.unescape(match[3])})
            if not cite:raise ValueError('Missing current section hierarchy: '+key)
            excerpt='\n'.join('<!-- field-start:'+f+' -->\n'+field(record,f)+'\n<!-- field-end:'+f+' -->' for f in ['head','statute','sourcecredit','footnote'] if field(record,f))
            filename=f'raw/title-{title}-section-{number}.html';blob=excerpt.replace('\r\n','\n').encode()
            (DEST/filename).write_bytes(blob)
            inventory['artifacts'].append({'title':title,'section':canonical_number,'heading':heading,'status':'active','breadcrumb':breadcrumb,'documentId':canonical_document,'currentThrough':current,'target':key,'titleName':html.unescape(title_head[1]),'path':filename,'sha256':digest(blob),'bytes':len(blob),'sourceUrl':artifact['url'],'sourceTitleSha256':artifact['sha256'],'sourceTitleBytes':len(raw),'releasePoint':release})
    used={a['path'] for a in inventory['artifacts']}
    for path in (DEST/'raw').glob('title-*-section-*.html'):
        if path.relative_to(DEST).as_posix() not in used:path.unlink()
    (DEST/'source-inventory.json').write_text(json.dumps(inventory,ensure_ascii=False,indent=2)+'\n')


def generate(capture_from=None, capture_current_from=None):
    exported=load_references();selected,excluded,corrections=select_references(exported['references'], set(exported['inaSections']))
    if capture_from:capture_sources(Path(capture_from),selected)
    if capture_current_from:capture_current_sources(Path(capture_current_from),selected)
    inventory=json.loads((DEST/'source-inventory.json').read_text())
    edition=inventory['edition'];current=inventory['currentThrough']
    available={a['target']:a for a in inventory['artifacts']};unavailable={a['target']:a for a in inventory['unavailable']}
    unknown=set(selected)-set(available)-set(unavailable)
    if unknown:raise ValueError('Capture official source records for new targets: '+', '.join(sorted(unknown)))
    titles={};records=[];locators=[];published_duplicates=[]
    for key in sorted(selected,key=lambda k:(int(k.split(':')[0]),int(re.match(r'\d+',k.split(':')[1])[0]),k)):
        if key not in available:continue
        a=available[key];blob=(DEST/a['path']).read_bytes()
        if digest(blob)!=a['sha256']:raise ValueError('Source excerpt hash mismatch: '+key)
        source=blob.decode();parsed=parse_operative(field(source,'statute'))
        section={k:copy.deepcopy(a[k]) for k in ['title','section','heading','status','breadcrumb']}
        section.update({'id':f"usc:{a['title']}:{a['section']}",**parsed,'notes':[], 'url':f"https://uscode.house.gov/view.xhtml?req=granuleid:USC-{edition}-title{a['title']}-section{a['section']}&num=0&edition={edition}",'source':{'edition':edition,'currentThrough':current,'publisher':inventory['publisher'],'artifact':'sources/legal/referenced-usc/'+a['path'],'sha256':a['sha256'],'url':a['sourceUrl']}})
        paths=set();path_counts=collections.Counter()
        def walk(nodes,parent=()):
            for n in nodes:
                p=parent+(n['label'],) if n['label'] else parent
                if n['label']:paths.add(p)
                if n['label']:path_counts[p]+=1
                walk(n['children'],p)
        walk(section['body'])
        duplicates=[{'path':list(p),'occurrences':count} for p,count in path_counts.items() if count>1]
        if duplicates:published_duplicates.append({'target':key,'paths':duplicates,'reason':'Repeated designators are published in the official source and retained in source order.'})
        for r in selected[key]:
            path=tuple(r.get('targetPath',[]))
            if path and path not in paths:locators.append({'target':key,'path':list(path),'sourceSection':r['sourceSection'],'text':r['text'],'reason':'Exact locator absent in source edition; full parent section is included.'})
        titles.setdefault(a['title'],{'number':a['title'],'name':a['titleName'],'sections':[]})['sections'].append(section)
        records.append({'target':key,'operativeSha256':digest(flatten_operative(section).encode()),'occurrences':len(selected[key]),'nodeCount':len(paths)})
    corpus={'schemaVersion':1,'scope':'Full parent sections directly cited by current INA-mapped operative body or preamble. No non-INA provisions, notes, supplementary material, ranges, et seq. groups, or recursive expansion.','edition':edition,'currentThrough':current,'titles':list(titles.values())}
    if inventory.get('releasePoint'):corpus['releasePoint']=inventory['releasePoint']
    corpus['version']='referenced-usc-'+digest(json.dumps(corpus,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode())[:20]
    # Retain citation evidence without copying complete Title 8 paragraphs.
    compact=lambda r:{k:v for k,v in r.items() if k not in {'sourceText','before','after'}}
    report={'schemaVersion':1,'title8Source':exported['title8Source'],'sourceEdition':edition,'sourceCurrentThrough':current,'selectedOccurrences':sum(map(len,selected.values())),'selectedTargets':len(selected),'includedSections':len(records),'includedTitles':len(titles),'selection':{k:[compact(r) for r in rs] for k,rs in selected.items()},'exclusions':[compact(r) for r in excluded],'corrections':corrections,'unavailableTargets':[unavailable[k] for k in selected if k in unavailable],'unresolvedLocators':locators,'publishedDuplicateDesignators':published_duplicates,'sourceTextChecks':records}
    DEST.mkdir(parents=True,exist_ok=True)
    (DEST/'corpus.json').write_text(json.dumps(corpus,ensure_ascii=False,separators=(',',':'))+'\n')
    (DEST/'selection.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps({k:report[k] for k in ['selectedOccurrences','selectedTargets','includedSections','includedTitles']},indent=2))
    return corpus,report

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--capture-from',type=Path)
    parser.add_argument('--capture-current-from',type=Path,help='Reviewed current OLRC title XHTML captures and manifest')
    args=parser.parse_args();generate(args.capture_from,args.capture_current_from)
