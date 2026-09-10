#!/usr/bin/env python3
"""Extract replay fixtures from the pinned, hash-verified eCFR capture; no network."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import xml.etree.ElementTree as ET
from html.parser import HTMLParser
ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('generator',ROOT/'tools/generate-cfr-corpus.py')
gen=importlib.util.module_from_spec(spec);spec.loader.exec_module(gen)
cache=ROOT/'tmp/cfr-cache';capture=json.loads((cache/'capture.json').read_text())
reviews=json.loads((ROOT/'sources/legal/cfr-hierarchy/reviewed-expectations.json').read_text())['reviews']
wanted={item['id'] for item in reviews}
class Sections(HTMLParser):
 def __init__(self,text):
  super().__init__(convert_charrefs=False);self.text=text;self.lines=[0];self.depth=0;self.current=None;self.sections={}
  for i,c in enumerate(text):
   if c=='\n':self.lines.append(i+1)
 def source_position(self):
  line,col=self.getpos();return self.lines[line-1]+col
 def handle_starttag(self,tag,attrs):
  attrs=dict(attrs)
  if tag=='div':
   self.depth+=1
   if 'section' in attrs.get('class','').split():self.current=(attrs['id'],self.depth,self.source_position())
 def handle_endtag(self,tag):
  if tag=='div':
   if self.current and self.depth==self.current[1]:
    key,_,start=self.current;self.sections[key]=self.text[start:self.source_position()+len('</div>')];self.current=None
   self.depth-=1
fixtures=[]
for key,source in capture['sources'].items():
 title=int(source['title']);raw=gen.read_verified(cache/'ecfr'/source['file'],source,key)
 root=ET.fromstring(raw)
 for part in root.iter('DIV5'):
  selected=[section for section in part.iter('DIV8') if f'{title}:{section.get("N")}' in wanted]
  if not selected:continue
  partnum=part.get('N');renderSource=capture['renderers'][f'{title}:{partnum}'];html=gen.read_verified(cache/'ecfr-rendered'/renderSource['file'],renderSource,key).decode()
  reader=Sections(html);reader.feed(html)
  wrapper=ET.Element('DIV5',part.attrib);head=part.find('HEAD')
  if head is not None:wrapper.append(copy.deepcopy(head))
  for section in selected:wrapper.append(copy.deepcopy(section))
  xml=ET.tostring(wrapper,encoding='unicode');rendered=f'<div class="part" id="part-{partnum}">'+ '\n'.join(reader.sections[section.get('N')] for section in selected) + '</div>'
  _,records,_=gen.normalize_document(xml.encode(),title,{}, {},{partnum:gen.parse_enhanced_html(rendered.encode(),title,partnum)})
  fixtures.append({'title':title,'part':partnum,'sourceXmlSha256':source['sha256'],'sourceRendererSha256':renderSource['sha256'],'xml':xml,'rendererHtml':rendered,'normalized':records})
path=ROOT/'sources/legal/cfr-hierarchy/download-fixtures.json'
path.write_text(json.dumps({'schemaVersion':1,'fixtures':fixtures},ensure_ascii=False,separators=(',',':'))+'\n')
print(len(fixtures),'part fixtures;',path.stat().st_size,'bytes')
