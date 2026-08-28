# Luna audit: generated USC/INA note and editorial references

Audit date: 2026-08-23. Build audited: `INASearch-Uncompressed.html`, corpus version `2026.08.21-audit.2`.

## Scope and enumeration

This audit covers generated inline references in the Title 8 source record’s non-operative material: all 2,455 notes, 118 House editorial footnotes, 81 preambles, 286 source credits, and section headings/heading annotations. It excludes Title 8 operative body text and all CFR material. The included generated-reference count is 16,870:

- notes: 14,168
- heading annotations: 124
- source-credit annotations: 2,527
- preamble annotations: 47
- House editorial-footnote annotations: 4

By hydrated target: 3,466 local USC, 1 local CFR (a source-data false-positive retained for review), 1,090 official-source-only USC, 8,510 official-source-only Public Law, 3,579 official-source-only Statutes at Large, and 224 official-source-only Federal Register references.

The exact enumeration method is: parse the `inaSearchCorpusData` JSON script from `INASearch-Uncompressed.html`; call `unpackLegalReferences()` from `tools/pack-legal-references.js`; walk each `title8.sections[i]` and collect only `notes[*]`, `houseEditorialFootnotes[*]`, section `headingReferences`, `preambleReferences`, and `sourceCreditReferences`. A reference is counted once by its containing object and reference-array field; operative `body[*]` and CFR trees are never visited. For reproduction, the following command prints the same total and category counts:

```sh
node - <<'NODE'
const fs=require('fs');
const {unpackLegalReferences}=require('./tools/pack-legal-references');
const html=fs.readFileSync('INASearch-Uncompressed.html','utf8');
const corpus=JSON.parse(html.match(/<script id="inaSearchCorpusData"[^>]*>([\s\S]*?)<\/script>/)[1]);
unpackLegalReferences(corpus);
const fields=['references','headingReferences','preambleReferences','sourceCreditReferences'];
let total=0, by={};
function collect(x,kind){if(!x||typeof x!=='object')return;if(Array.isArray(x)){x.forEach(v=>collect(v,kind));return;}
  for(const f of fields) if(Array.isArray(x[f])) { total+=x[f].length; by[kind+'/'+f]=(by[kind+'/'+f]||0)+x[f].length; }
  for(const [k,v] of Object.entries(x)) if(!fields.includes(k)) collect(v,kind);
}
for(const s of corpus.title8.sections){collect(s.notes,'notes');collect(s.houseEditorialFootnotes,'editorial-footnotes');
  collect(s.preamble,'preamble');collect(s.sourceCredit,'source-credit');
  for(const f of ['headingReferences','preambleReferences','sourceCreditReferences']) if(Array.isArray(s[f])) {total+=s[f].length;by['section/'+f]=(by['section/'+f]||0)+s[f].length;}}
console.log({sections:corpus.title8.sections.length,total,by});
NODE
```

## Findings

There are 564 hydrated `embedded-named-act-section` references whose generic named-Act fallback has no Public Law identity. In the generated build they hydrate as `https://www.govinfo.gov/app/details/PLAW-publ`, which is not a valid source target. The 561 occurrences in Title 8 notes are a repeated class; the flags TSV records exact representative instances spanning INA, Immigration Act, Federal Aviation Act, and Social Security Act contexts.

The same context resolver also emits nested parenthetical links against historical INA section numbers as if they were Title 8 sections (for example, USC 8:212/a/2 and USC 8:240A/d/1), and defaults genuinely cross-title parentheticals to Title 8 (18 USC 1351 and 22 USC 2131 examples). One “such section” link in 8 U.S.C. 1101 historical notes resolves to 8 USC 1182/III even though its antecedent is section 101(b)(1)(G)(iii). These are recorded with exact source IDs, paths, offsets, current targets, and proposed targets in `luna-audit-usc-notes-flags.tsv`.

All other included references were checked by family, resolution, rule, source span, and surrounding note/editorial context. Historical Acts, Statutes at Large, Public Laws, transferred sections, repealed/former USC citations, and official-source-only cases were retained as official-source links where the source context supports that treatment. Uninterpretable anaphora remained unlinked in the generated corpus and was not treated as a defect.
