"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const functionSource = require("./test-function-source");
const command = require("../src/INASearch-Command");
const cfrHierarchy = require("../src/INASearch-CFR-Hierarchy");
const { hydratePackedCorpus } = require("../src/INASearch-Corpus-Packing");

function createParser() {
  const source = fs.readFileSync(path.join(__dirname, "../src/INASearch.template.html"), "utf8");
  const html = fs.readFileSync(path.join(__dirname, "../INASearch-Uncompressed.html"), "utf8");
  const corpus = hydratePackedCorpus(JSON.parse(html.match(/<script id="inaSearchCorpusData"[^>]*>([\s\S]*?)<\/script>/)[1]));
  const norm = value => String(value || "").replace(/[^a-z0-9-]/gi, "").toLowerCase();
  const sectionMap = new Map(corpus.title8.sections.map(section => [norm(section.section), section]));
  const inaMap = new Map(corpus.inaCrosswalk.map(row => [norm(row.inaSection), row]));
  const uscToIna = new Map(corpus.inaCrosswalk.filter(row => row.uscSection).map(row => [norm(row.uscSection), row]));
  const cfrSectionsByNumber = new Map();
  for (const record of corpus.cfr.sections) {
    const key = norm(record.section);
    if (!cfrSectionsByNumber.has(key)) cfrSectionsByNumber.set(key, []);
    cfrSectionsByNumber.get(key).push(record);
  }
  const context = vm.createContext({
    INA_SEARCH_COMMAND: command, INASearchCfrHierarchy: cfrHierarchy,
    corpus, sectionMap, inaMap, uscToIna, hasLocalUscCache: true,
    knownInaCitationPaths: new Map(), knownUscCitationPaths: new Map(),
    inaMappedSection: row => sectionMap.get(norm(row?.localSection || row?.uscSection)),
    statuteStatus: section => section.status || "active",
    statuteNodeAtPath: (section, parts) => {
      let nodes = section?.body || [], node;
      for (const part of parts) { node = nodes.find(item => item.label === part); if (!node) return null; nodes = node.children || []; }
      return node;
    },
    citationPathKey: (section, parts) => `${norm(section)}:${parts.map(norm).join("/")}`,
    cfrSectionNumberKey: norm, cfrSectionsByNumber,
    cfrSectionMap: new Map(corpus.cfr.sections.map(record => [`${record.title}:${norm(record.section)}`, record])),
    cfrPartsByNumber: new Map(), cfrPartsByTitle: new Map(),
    parseCfrHierarchy: () => null, parseUscHierarchy: () => null, parseAct: () => null,
    isHierarchyBrowse: () => false, INA_SOURCE_URL: "https://www.uscis.gov/laws-and-policy/legislation/immigration-and-nationality-act",
    officialTextFragment: (url, parts) => url + parts.join("/"), houseSectionUrl: section => `https://uscode.house.gov/${section}`,
    inaSourceRecord: row => ({ kind: "ina", item: row }),
    parseIna: raw => context.parseStatuteSectionOrFamily("ina", raw),
    normCitationPart: norm, normalize: norm,
    cachedCfrBlockPaths: record => cfrHierarchy.index(record).paths,
    cfrUnitPaths: record => [[], ...cfrHierarchy.index(record).paths.map(command.scanCitationPath).map(syntax => syntax.segments.map(segment => segment.text))],
    statuteUnitPaths: section => [[], ...context.collectStructuralCitationPaths(section.body), ...(section.runInPaths || [])]
  });
  const start = source.indexOf("    const compactStatutePathIndexes = new Map();");
  const end = source.indexOf("\n\n    function structuredCloneSafe(", start);
  const names = ["canonicalPath", "componentTokens", "compactHierarchyTokens", "unverifiedCitationPath", "resolveComponents", "resolveKnownCitationPath", "findKnownPrefix", "letteredIdentifierFamily", "statuteSectionFamilyResult", "parseStatuteSectionOrFamily", "parseExternalStatute", "parseFallbackStatute", "parseLocalStatute", "indexedCfrSection", "resolveIndexedCfrPath", "parseCfr", "parseCitation", "citationInputCanContinue", "searchScopeDescriptor", "inferredSearchScopeEndpoint", "searchScopeRange", "parseSearchScope"];
  vm.runInContext(source.slice(start, end) + "\n" + names.map(name => functionSource(source, name)).join("\n"), context);
  return { api: context, corpus };
}

function run() {
  const { api, corpus } = createParser();
  const plain = value => JSON.parse(JSON.stringify(value));
  const expect = (input, label) => {
    const result = api.parseCitation(input);
    assert(result?.valid, `${input} must resolve, got ${result?.message || "unrecognized"}`);
    assert.equal(result.label, label, input);
    return result;
  };
  expect("274a", "INA 274A");
  expect("274(a)", "INA 274(a)");
  for (const notation of ["a2b", "(a)2b", "(a)2(B)", "(a)(2)b", "a(2)b", "(a)(2)(B)"]) {
    expect(`274${notation}`, "INA 274(a)(2)(B)");
    expect(`INA274${notation}`, "INA 274(a)(2)(B)");
    expect(`8 U.S.C. 1324${notation}`, "8 U.S.C. 1324(a)(2)(B)");
    expect(`USC1324${notation}`, "8 U.S.C. 1324(a)(2)(B)");
  }
  for (const notation of ["(h)2iA", "h(2)iA", "(h)(2)i(A)", "h2(i)A"]) {
    expect(`214.2${notation}`, "8 CFR 214.2(h)(2)(i)(A)");
    expect(`8 CFR214.2${notation}`, "8 CFR 214.2(h)(2)(i)(A)");
  }
  expect("INA101(a)15H(2)a", "INA 101(a)(15)(H)(ii)(a)");
  expect("8 USC 1101(a)15H(2)a", "8 U.S.C. 1101(a)(15)(H)(ii)(a)");
  expect("99 CFR999.1(h)2iA", "99 CFR 999.1(h)(2)(i)(A)");
  assert(!api.parseCitation("99 CFR999.1(h)2(")?.valid, "Unfinished external CFR citations must not navigate");
  api.hasLocalUscCache = false;
  expect("INA274(a)2B", "INA 274(a)(2)(B)");
  assert(!api.parseCitation("INA274(a)2(")?.valid, "Unfinished external statutes must not navigate");
  api.hasLocalUscCache = true;
  assert(!api.parseFallbackStatute('ina', '274(a)2(').valid, 'Unfinished INA input must remain incomplete even without a corpus');
  for (const input of ["274(a2)b", "INA274(a)99z", "8 USC1324(a)99z", "214.2(h)99z"]) {
    assert(!api.parseCitation(input)?.valid, `${input} must not resolve to a broader or split unit`);
    assert(api.citationInputCanContinue(input), `${input} must stay in citation handling`);
  }
  for (const input of ["274(", "274(a", "274(a)2(", "INA274(a)2(", "8 CFR214.2(h)2("]) {
    assert(!api.parseCitation(input)?.valid, `${input} must not navigate until finished`);
    assert(api.citationInputCanContinue(input), `${input} must remain a citation prefix`);
  }
  for (const input of ["274(a)(2))", "274((a))2b"]) {
    assert(!api.parseCitation(input)?.valid, `${input} is malformed`);
    assert(api.citationInputCanContinue(input), `${input} must remain in citation handling`);
  }
  for (const input of ["waiver", "INA waiver", "274 waiver", '"274(a)2b"', "274(a)2b OR waiver"]) assert(!api.citationInputCanContinue(input), input);
  const structural = { body: [{ label: "a", children: [{ label: "2", children: [{ label: "B" }] }] }] };
  assert.deepEqual(plain(api.resolveComponents(structural, "(a)2b")).path, ["a", "2", "B"]);
  const invalid = api.resolveComponents(structural, "(a)2z");
  assert(!invalid.valid); assert.deepEqual(plain(invalid.path), ["a", "2"]); assert.deepEqual(plain(invalid.suggestions), ["B"]);
  assert(!api.resolveComponents(structural, "(a2)b").valid);

  const ambiguous = expect("Ina 101(a)15oiii", "INA 101(a)(15)(O)(iii)");
  const option = ambiguous.ambiguity.options.find(item => item.path.join("/") === "a/15/O/ii/I");
  assert(option, "Mixed notation must preserve legitimate ambiguity choices");
  assert.equal(api.citationWithStatuteInterpretation("Ina 101(a)15oiii", ambiguous.ambiguity, option), "Ina 101(a)15oiiI");
  expect("Ina 101(a)15oiiI", "INA 101(a)(15)(O)(ii)(I)");
  const separated = expect("INA101(a)15(o)iii", "INA 101(a)(15)(O)(iii)");
  const separatedOption = separated.ambiguity.options.find(item => item.path.join("/") === "a/15/O/ii/I");
  assert.equal(api.citationWithStatuteInterpretation("INA101(a)15(o)iii", separated.ambiguity, separatedOption), "INA101(a)15(o)iiI");
  for (const input of ['8 USC1101(a)27ciii', '8 USC1101a27(c)iii', '8 USC1101a27ciii']) {
    const result = api.parseCitation(input);
    const chosen = result.ambiguity.options.find(item => item.path.join('/') === 'a/27/C/ii/I');
    const edited = api.citationWithStatuteInterpretation(input, result.ambiguity, chosen);
    assert.deepEqual(plain(api.parseCitation(edited).path), ['a','27','C','ii','I'], `${input} ambiguity choice must round-trip to its advertised unit`);
    if (input.includes('(c)')) assert(edited.includes('(c)'), 'An explicit ancestor must retain its spelling');
  }

  const relative = api.parseSearchScope("274(a)2(A)–(B)");
  const absolute = api.parseSearchScope("274(a)2(A)–274(a)2b");
  assert(relative.valid && absolute.valid);
  assert.equal(relative.label, absolute.label);
  const mixedRelative = api.parseSearchScope("INA274(a)2(A)–(a)2b");
  const canonicalRange = api.parseSearchScope("INA274(a)(2)(A)–INA274(a)(2)(B)");
  assert(mixedRelative.valid && canonicalRange.valid);
  assert.equal(mixedRelative.label, canonicalRange.label);
  assert(!api.parseSearchScope("101(a)15(o)ii–101(a)15oiii").valid, "An unresolved ambiguous endpoint must not broaden a range");
  assert(!api.parseSearchScope("101(a)15oiii–101(a)15oiiI").valid, "An unresolved ambiguous starting citation must not broaden a range");

  let statuteForms = 0, cfrForms = 0, ambiguityChoices = 0;
  const variants = parts => {
    // Every possible single explicit boundary and alternating boundaries exercise
    // compact stretches on both sides, including aliases with different lengths.
    const forms = parts.map((_, index) => parts.map((part, i) => i === index ? `(${part})` : part).join(""));
    forms.push(parts.map((part, i) => i % 2 ? part : `(${part})`).join(""));
    return new Set(forms);
  };
  const audit = (resolve, candidates, count) => {
    for (const candidate of candidates) for (const input of variants(candidate.inputParts)) {
      const result = resolve(input);
      const paths = [result?.path, ...(result?.ambiguity?.options || []).map(item => item.path)].filter(Boolean);
      assert(paths.some(parts => parts.join("/") === candidate.path.join("/")), `${count} mixed ${input} lost ${candidate.path.join("/")}`);
      for (const parts of paths) {
        const aliases = candidates.filter(item => item.path.join("/") === parts.join("/"));
        assert(aliases.some(item => command.matchCitationPath(command.scanCitationPath(input), item)), `${input} crossed an explicit boundary`);
      }
      for (const option of result?.ambiguity?.options || []) {
        const edited = api.citationWithStatuteInterpretation(input, result.ambiguity, option);
        assert.equal(resolve(edited)?.path.join('/'), option.path.join('/'), `${input} choice ${option.path.join('/')} navigated to another unit after editing to ${edited}`);
        ambiguityChoices++;
      }
      if (count === "statute") statuteForms++; else cfrForms++;
    }
  };
  for (const section of corpus.title8.sections) {
    const index = api.compactStatutePathIndex("usc", section.section, section);
    for (const candidates of index.values()) audit(input => api.resolveIndexedCompactStatutePath("usc", section.section, section, input), candidates, "statute");
  }
  for (const section of corpus.cfr.sections) for (const candidates of cfrHierarchy.index(section).byCompact.values()) audit(input => api.resolveIndexedCfrPath(section, input), candidates, "cfr");
  assert(statuteForms > 30000 && cfrForms > 30000);
  console.log(`PASS mixed citations: examples, invalid/partial input, structural fallback, ambiguity edits, ranges; ${statuteForms} statutory and ${cfrForms} CFR mixed forms, ${ambiguityChoices} ambiguity choice round trips`);
}

if (require.main === module) run();
module.exports = { createParser, run };
