# USC operative inline-reference audit — cycle 11

Audit date: 2026-08-25

## Scope and integrity

This is an occurrence-level audit of every row in the frozen `usc-operative` inventory, covering both `kind=reference` and `kind=parenthetical-candidate`. The audited inputs were:

- Artifact: `/Users/dave/Documents/HD QuickLookup/INASearch-Uncompressed.html`
- Task-specified artifact SHA-256: `b32f5b690ac059222ddc40dc8874ac3dd3db6b7a8aad0215bd25b5291638e8d2`
- SHA-256 verified for the artifact present during this audit: `be4e48105e7c4e626905b05bf27cb061cb6f425ccab45916f3d5b800ea7e4d87`
- Frozen inventory: `/tmp/inasearch-inline-final.ZMZVQN/uncompressed/usc-operative.jsonl`
- Frozen inventory SHA-256: `16c2831008d2a794506d981604cb9a9f6f2333c6a19c0408d5a64798d46e2ff2`

The artifact hash discrepancy is recorded explicitly: the current artifact was modified in the shared worktree (35,344,904 bytes; mtime 19:40 on August 25), and no local copy of the task-specified `b32f5b69…` artifact was available. The frozen inventory itself has the requested hash. Running the independent generator against the artifact present now produced an inventory that is byte-for-byte identical to the frozen file (`cmp` exit 0), so the row-level audit below is against the exact frozen inventory and the matching current rebuild.

## Independent method

I regenerated the inventory with the repository's standalone audit implementation, without changing parser, corpus, product, or generated-HTML files:

```text
node tools/audit-inline-references.js INASearch-Uncompressed.html <independent-output-directory>
cmp <independent-output-directory>/usc-operative.jsonl \
    /tmp/inasearch-inline-final.ZMZVQN/uncompressed/usc-operative.jsonl
```

The independent output matched byte-for-byte. I then inspected each generated reference and candidate occurrence using its exact `sourcePath`, offset, source text, context, current target, family, and resolution, and checked the enclosing statutory hierarchy (including paragraph/subparagraph/clause ancestry and intervening explicit citations). The separate standalone test also passed (`node tools/test-standalone.js`).

Every serialized reference span was round-tripped against its source field (`field.text.slice(start, end) === text`), and each generated target was checked for family, title/section path, local-versus-official resolution, and existence or absence in the indexed hierarchy. Candidate spans were likewise checked against their containing field and assigned coverage from the linked/structural/unlinked rules.

## Inventory counts and classifications

The `usc-operative` source model contains 9,373 audited text fields: 3,137 headings, 81 preambles, and 6,155 node-text fields. The frozen inventory contains 10,550 occurrence rows:

| kind | count |
| --- | ---: |
| reference | 5,543 |
| parenthetical-candidate | 5,007 |

Reference families: USC 5,243; statutes-at-large 153; public-law 144; CFR 2; unknown 1. Reference resolution: local 4,744; official-source-only 799.

Candidate coverage: linked 4,698; structural 282; unlinked 27; partial 0. Every candidate was assigned one of these classifications. Structural candidates are statutory run-ins/list labels that are not independent citations; prose candidates include ordinary parenthesized words or terms; self-references remain unlinked when the occurrence names the current unit rather than an external target. Only genuine, high-confidence citations were treated as missing links.

The independent statutory run-in index used for hierarchy checks contains 51 sections, 104 source nodes, 267 markers, and 263 indexed paths.

## Findings

The companion TSV contains the complete occurrence-level finding set:

`/Users/dave/Documents/HD QuickLookup/sources/legal/luna-audit-usc-operative-cycle11-flags.tsv`

It has 34 data rows (plus the required header):

| verdict | count | meaning |
| --- | ---: | --- |
| incorrect-target | 29 | Generated target points to the wrong statutory unit, duplicates an ancestry label, captures a later citation, or crosses into title 38. |
| invalid-source-citation | 1 | Source expressly names a statutory clause absent from the current Title 8 hierarchy; it must remain unresolved rather than be presented as a valid local target. |
| missing-link | 4 | A high-confidence parenthetical citation was left unlinked. |

The 29 incorrect targets comprise: one case-normalization error in the explicit `8 U.S.C. 1101(a)(15)(u)` citation; six §1160/§1254a/§1255a run-ins incorrectly resolved inside their current containers instead of to §1182(a)(2); one duplicated subsection path in §1153; one §1153(b)(3)(C) clause captured as a later §1182 citation; one §1182(e)(iii) clause captured as §1184(l)(iii); one sibling clause in §1160(c)(2)(B) captured under §1182; four nested §1182(n)(2)(H) clauses flattened to §1182(n); one §1254a(c)(2)(A)(iii) clause flattened to §1182(a); one §1255a(d)(2)(B)(ii) clause flattened to §1182(a); four §1257 references to §1101(a)(15)(E)/(G) flattened to §1101(a); one §1356(s)(5) clause flattened to §1154(a); and eight trailing-container captures in §§1612, 1613, and 1622 incorrectly resolved to title 38 §1304 instead of their enclosing Title 8 clauses. Exact source paths, offsets, text, current targets, proposed targets, and rationales are in the TSV.

The four missing links are §1182(a)(2)(A), §1182(a)(2)(B), and §1182(a)(7) occurrences whose surrounding wording identifies the cited paragraph unambiguously. The 27 other unlinked candidates were reviewed and intentionally left unflagged because they are structural run-ins, prose, or current-unit self-references; none was a genuine ambiguous citation requiring a target.

No parser, corpus, product, or generated-HTML edits were made for this audit. The report and TSV are the only audit deliverables.
