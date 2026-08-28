# CFR inline-reference audit — Cycle 6

## Scope and result

This is a confirmation audit of the current rebuilt `INASearch-Uncompressed.html`, build signature `add0bc621f6bac45f3cf8f5c`. USC operative text and USC notes were excluded. No parser, product code, or corpus data was changed.

The frozen enumeration contains **22,401 generated CFR references**, of which **11 are suspect**. The suspect rows are recorded in [luna-audit-cfr-cycle6-flags.tsv](luna-audit-cfr-cycle6-flags.tsv). The remaining 22,390 references were accepted as semantically appropriate or appropriately official-source-only.

## Exact enumeration method and coverage proof

I read the current artifact's `inaSearchCorpusData`, unpacked its generated legal-reference records with the repository's reference unpacker, then made one bounded walk of every CFR container and reference field. The walk covered 3,039 CFR section records, 10 appendices, and 174 part records, including `headingReferences`, `xReferences`, `authorityReferences`, and `sourceReferences`. It selected only records whose source path began `cfr.sections[`, `cfr.appendices[`, or `cfr.parts[` and froze the resulting rows before semantic review.

The frozen record has 21,395 section references, 244 appendix references, and 762 part references (total 22,401). By field: `xReferences` 21,562; `headingReferences` 86; `authorityReferences` 622; `sourceReferences` 131. Path-sensitive coverage is 9,500 records with a nonempty generated target path plus 20 additional embedded section/list candidates with empty paths, for 9,520 parenthetical/nested candidates. Every frozen row retains its exact source path, offset/end span, text, surrounding context, and generated target; span and official-URL checks found no structural omissions, and no bare `this`, `such`, `preceding`, or `following` token was linked as a standalone generated reference.

For the required comparison, I used the saved Cycle 5 inventory by the stable key `(source_id, field, offset, end)`. The frozen delta was 32 added records, 46 changed targets, and 0 removed records (78 inventory/target deltas). The semantic pass was performed once over that frozen set; it was not re-enumerated.

## Findings

### Codification regressions — 9 references

Several newly generated named-act targets remain at an act-section search target even though the same local regulatory sentence supplies an exact USC codification:

- Higher Education Act §101(a) should resolve to 20 U.S.C. §1001(a): one reference in 8 CFR 106.1, two in 20 CFR 656.40.
- State Department Basic Authorities Act §36(a) should resolve to 22 U.S.C. §2708(a): one reference in 8 CFR 214.2.
- Fair Labor Standards Act §3(f) should resolve to 29 U.S.C. §203(f): four references in 20 CFR 655.103, 20 CFR 655.1300, 29 CFR 501.3, and 29 CFR 502.10.
- Economic Opportunity Act §222(a)(5) should resolve to 42 U.S.C. §2809(a)(5): one reference in appendix 1 to 20 CFR part 416.

The corresponding explicit USC references in those same contexts are correct; the flags concern the generated short/named-act references that fail to inherit the codification.

### Edition-year parenthetical incorrectly treated as a statutory path — 1 reference

In 20 CFR 656.40, `20 U.S.C. 1001(a)(2000)` is correctly a citation to §1001(a) with `(2000)` identifying the edition/year. The generated path `a/2000` is therefore too deep and is flagged.

### Public Law nested-path regression — 1 reference

In 8 CFR 274a.12, IIRIRA §309(f)(1) is enacted in Division C of Public Law 104-208. The current target preserves Public Law 104-208 and §309(f)(1) but drops the material `division-C` nesting retained in the Cycle 5 target; this is flagged as an exact-path regression.

### Accepted systematic changes

The other Cycle 6 deltas were accepted: newly recognized Public Law sections and codification mappings (including Refugee Act, Social Security Act, and other Act-base references) point to the appropriate official source or USC target; formatting-only Public Law path normalization such as `section-222` to `s222` did not change the cited provision. Named acts that have no safely established local/USC mapping remain official-source-only, as required.
