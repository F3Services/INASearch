"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const occurrence = require("../src/INASearch-Occurrence.js");
const command = require("../src/INASearch-Command.js");
const { applyStatuteFootnotes } = require("./statute-footnotes.js");
const { indexStatuteRunIns } = require("./statute-run-ins.js");
const { applyStatuteStatusMetadata } = require("./statute-status.js");

const root = path.resolve(__dirname, "..");

function assigned(fileName, name) {
  const sandbox = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(root, "src", fileName), "utf8"), sandbox, { filename: fileName });
  return sandbox.window[name];
}

function syntheticCorpus() {
  const first = "(a) Alpha parent. (1) Beta child.";
  const childStart = first.indexOf("(1)");
  return {
    corpusVersion: "synthetic-1",
    inaHierarchy: {
      titles: [{ id: "ina:title:I", number: "I", heading: "General", chapters: [], sectionIds: ["ina:section:101"] }],
      sections: [{ id: "ina:section:101", inaSection: "101", heading: "Synthetic mapped section", titleId: "ina:title:I", chapterId: null }]
    },
    inaCrosswalk: [{ inaSection: "101", uscSection: "1101", localSection: "1101", title: "Synthetic mapped section", group: "Title I", isNote: false, hasEquivalent: true }],
    title8: {
      sections: [
        {
          id: "8-1101", section: "1101", heading: "Alpha synthetic heading", preamble: "Opening alpha material.",
          body: [
            { label: "a", text: "Chapeau alpha: (1) beta one; (2) gamma two." },
            { label: "t", text: "occupational first enacted occurrence" },
            { label: "t", text: "physically second enacted occurrence" }
          ]
        },
        { id: "8-9999", section: "9999", heading: "Unmapped section", body: [{ label: "a", text: "unmappedneedle" }] }
      ]
    },
    cfr: {
      sections: [{
        id: "8:1.1", title: 8, section: "1.1", partId: "8:1", heading: "Synthetic regulation",
        hierarchy: [
          { type: "title", number: "8", heading: "Title 8" },
          { type: "chapter", number: "I", heading: "Chapter I" },
          { type: "part", number: "1", heading: "Part 1" },
          { type: "section", number: "1.1", heading: "§ 1.1 Synthetic regulation" }
        ],
        blocks: [
          { t: "p", x: first, a: "(a)(1)", u: [{ a: "(a)", s: 0, e: 3 }, { a: "(a)(1)", s: childStart, e: childStart + 3 }] },
          { t: "p", x: "(1) Beta repeated beta.", a: "(a)(1)", u: [{ a: "(a)(1)", s: 0, e: 3 }] },
          { t: "h", x: "Class synthetic" },
          { t: "p", x: "Newburyport row", a: "(q)" },
          { t: "p", x: "Plymouth row", a: "(q)" },
          { t: "h", x: "farword context" },
          { t: "p", x: "spacer row", a: "(z)" },
          { t: "p", x: "targetword row", a: "(z)" },
          { t: "p", x: "nearword row", a: "(z)" },
          { t: "table", caption: "Table caption", rows: [[{ h: 1, x: "Header" }, { x: "tableword" }]] },
          { t: "note", noteType: "ordinary", blocks: [{ t: "h", x: "Note:" }, { t: "p", x: "ordinaryneedle", a: "(a)(1)" }] },
          { t: "note", noteType: "editorial", blocks: [{ t: "p", x: "editorialneedle" }] },
          { t: "note", noteType: "effective-date", blocks: [{ t: "p", x: "effectiveneedle" }] },
          { t: "note", blocks: [{ t: "h", x: "Editorial Note:" }, { t: "p", x: "legacyeditorialneedle" }] },
          { t: "footnote", x: "footneed" },
          { t: "p", x: "sourcecreditneedle", k: "citation" },
          { t: "p", x: "(c)-(d) [Reserved]", a: "(d)", u: [{ a: "(c)", s: 0, e: 3 }, { a: "(d)", s: 4, e: 7 }] },
          { t: "p", x: "(b) Gamma sibling.", a: "(b)", u: [{ a: "(b)", s: 0, e: 3 }] }
        ]
      }],
      appendices: [{
        id: "8:1:appendix:1", title: 8, partId: "8:1", label: "Appendix A to Part 1", heading: "Appendix heading",
        hierarchy: [{ type: "title", number: "8", heading: "Title 8" }, { type: "chapter", number: "I", heading: "Chapter I" }, { type: "part", number: "1", heading: "Part 1" }],
        blocks: [{ t: "p", x: "appendixneedle" }]
      }]
    }
  };
}

async function syntheticTests() {
  const corpus = syntheticCorpus(), projection = occurrence.buildProjection(corpus);
  const persistedIdentity = occurrence.projectionIdentity(corpus, { corpusSchemaVersion: 5, corpusSha256: "a".repeat(64) });
  const persisted = occurrence.toPersistedProjection(projection, persistedIdentity, { citationSources: [{ recordId: "fixture", targets: [] }] });
  assert(!Object.hasOwn(persisted.payload, "hierarchyById"), "The persisted projection contains its transient hierarchy Map.");
  const restored = occurrence.restorePersistedProjection(structuredClone(persisted), persistedIdentity);
  assert(restored.hierarchyById instanceof Map && restored.hierarchyById.size === projection.hierarchyById.size, "A persisted projection did not reconstruct its hierarchy Map.");
  assert.strictEqual(restored.citationSources[0].recordId, "fixture", "The persisted projection lost its reverse citation index.");
  const persistedSearchCases = [
    ["beta", { authorities: "cfr" }],
    ['"Beta repeated"', { authorities: "cfr" }],
    ["(alpha OR gamma) beta", { authorities: "cfr", common: { cfr: "section" } }],
    ["alpha", { authorities: "ina", scope: { ina: { inaSections: ["101"] } } }]
  ];
  for (const [query, options] of persistedSearchCases) {
    const fresh = occurrence.search(projection, query, options);
    const cachedResult = occurrence.search(restored, query, options);
    const shape = result => ({
      totalOccurrences: result.totalOccurrences,
      sections: result.sections,
      hierarchy: result.hierarchy,
      page: result.materializeOccurrences({ start: 0, limit: 200 })
    });
    assert.deepStrictEqual(shape(cachedResult), shape(fresh), `A restored projection changed results for ${query}.`);
  }
  assert.throws(() => occurrence.restorePersistedProjection({ ...persisted, corpusSha256: "b".repeat(64) }, persistedIdentity), /different corpus/, "A projection from a different corpus identity was accepted.");
  const cached = occurrence.getProjection(corpus);
  assert.strictEqual(occurrence.getProjection(corpus), cached, "Projection caching is not stable for one corpus version.");
  occurrence.clearProjection(corpus);
  const inaOnly = occurrence.getProjection(corpus, { authorities: "ina" });
  const fullAfterIna = occurrence.getProjection(corpus);
  const cfrOnly = occurrence.getProjection(corpus, { authorities: "cfr" });
  assert(inaOnly.fragments.every(fragment => fragment.authority === "ina"), "An INA-only projection contains CFR fragments.");
  assert(cfrOnly.fragments.every(fragment => fragment.authority === "cfr"), "A CFR-only projection contains statute fragments.");
  assert(new Set(fullAfterIna.fragments.map(fragment => fragment.authority)).size === 2, "An authority-specific projection poisoned the default projection cache.");
  assert(occurrence.buildProjection(corpus, { authorities: new Set(["ina"]) }).fragments.every(fragment => fragment.authority === "ina"), "Projection construction does not accept an iterable authority set.");
  const deferred = occurrence.getProjection(corpus, { authorities: "ina", deferNormalization: true });
  assert.notStrictEqual(deferred, inaOnly, "A deferred-normalization projection shared the normal projection cache entry.");
  assert(deferred.fragments.some(fragment => fragment.normalized === null), "The deferred-normalization cache fixture was not actually raw.");
  corpus.corpusVersion = "synthetic-2";
  assert.notStrictEqual(occurrence.getProjection(corpus), fullAfterIna, "Projection caching survived a corpus-version change.");
  assert.strictEqual(projection.stats.inaRecords, 1, "Unmapped Title 8 records entered the primary INA projection.");
  assert(!projection.fragments.some(fragment => fragment.normalized.includes("unmappedneedle")), "Unmapped U.S.C. prose entered INA search.");

  const statuteText = corpus.title8.sections[0].body[0].text;
  const statutePieces = projection.fragments
    .filter(fragment => fragment.authority === "ina" && fragment.source?.field === "body" && fragment.source?.subfield === "text" && fragment.source?.recordPath?.[0] === 0)
    .sort((left, right) => left.source.start - right.source.start);
  assert.strictEqual(statutePieces.map(fragment => fragment.text).join(""), statuteText, "Structural and run-in fragments do not form one disjoint source projection.");
  assert.deepStrictEqual(statutePieces.map(fragment => fragment.path.join("/")), ["a", "a/1", "a/2"], "Run-in units were not assigned their own legal paths.");
  for (let index = 1; index < statutePieces.length; index += 1) assert(statutePieces[index - 1].source.end <= statutePieces[index].source.start, "Statute source fragments overlap.");
  assert.strictEqual(occurrence.search(projection, "occupational physically", { authorities: "ina" }).totalOccurrences, 0, "Repeated enacted statute paths were merged at Deepest.");
  const repeatedStatutePaths = projection.fragments.filter(fragment => fragment.authority === "ina" && fragment.path.join("/") === "t" && fragment.kind === "statute-node");
  assert.strictEqual(new Set(repeatedStatutePaths.map(fragment => fragment.occurrenceKeys.at(-1))).size, 2, "Repeated statute paths lost source-order occurrence identity.");
  assert(repeatedStatutePaths.every(fragment => Number.isInteger(fragment.source.ordinal) && Array.isArray(fragment.source.recordPath)), "A repeated statute source locator is ambiguous.");

  for (const included of ["ordinaryneedle", "footneed", "tableword", "appendixneedle"]) assert(projection.fragments.some(fragment => fragment.normalized.includes(included)), `${included} was omitted from primary CFR text.`);
  for (const excluded of ["editorialneedle", "effectiveneedle", "legacyeditorialneedle", "sourcecreditneedle"]) assert(!projection.fragments.some(fragment => fragment.normalized.includes(excluded)), `${excluded} should be excluded from primary CFR text.`);
  const reservedRange = projection.fragments.filter(fragment => fragment.source?.rangePaths && fragment.text.includes("Reserved"));
  assert.strictEqual(reservedRange.length, 1, "A CFR reserved range was split into endpoint occurrences.");
  assert.strictEqual(reservedRange[0].citation, "8 CFR 1.1(c)–(d)", "A CFR range lost its citation label.");
  const reservedRow = occurrence.search(projection, "Reserved", { authorities: "cfr" }).materializeOccurrences({ limit: 1 }).rows[0];
  assert.strictEqual(reservedRow.readerCommand, "8 CFR 1.1", "A CFR range row did not retain a parseable reader command.");
  assert.strictEqual(reservedRow.recordId, "8:1.1", "A CFR range row lost its exact source-record identity.");
  const appendixRow = occurrence.search(projection, "appendixneedle", { authorities: "cfr" }).materializeOccurrences({ limit: 1 }).rows[0];
  assert.strictEqual(appendixRow.readerCommand, "8 CFR Appendix A to Part 1", "An appendix row did not retain its parseable base reader command.");
  assert.strictEqual(appendixRow.recordId, "8:1:appendix:1", "An appendix row lost its exact source-record identity.");
  const tableRow = occurrence.search(projection, "tableword", { authorities: "cfr" }).materializeOccurrences({ limit: 1 }).rows[0];
  assert.deepStrictEqual({ rowIndex: tableRow.target.rowIndex, cellIndex: tableRow.target.cellIndex }, { rowIndex: 0, cellIndex: 1 }, "A CFR table occurrence lost its exact cell coordinates.");

  const repeated = projection.fragments.filter(fragment => fragment.authority === "cfr" && fragment.kind === "cfr-paragraph" && fragment.path.join("/") === "a/1");
  assert.strictEqual(new Set(repeated.map(fragment => fragment.occurrenceKeys.at(-1))).size, 2, "Repeated CFR paths lost their source-order occurrence identity.");
  const repeatedUnsegmented = projection.fragments.filter(fragment => fragment.authority === "cfr" && fragment.kind === "cfr-paragraph" && fragment.path.join("/") === "q");
  assert.strictEqual(new Set(repeatedUnsegmented.map(fragment => fragment.occurrenceKeys.at(-1))).size, 2, "Unsegmented repeated CFR paths were merged.");
  assert(repeatedUnsegmented.every(fragment => fragment.localHeading === "Class synthetic"), "Repeated CFR occurrences lost their nearest local heading context.");
  assert.strictEqual(occurrence.search(projection, "Newburyport Plymouth", { authorities: "cfr" }).totalOccurrences, 0, "Separate repeated CFR rows satisfied one Deepest bucket.");
  assert.strictEqual(occurrence.search(projection, "Class Newburyport", { authorities: "cfr" }).totalOccurrences, 0, "An unaddressed CFR heading was attached to the following or preceding Deepest unit.");
  assert.strictEqual(occurrence.search(projection, "Header tableword", { authorities: "cfr" }).totalOccurrences, 0, "Separate CFR table cells satisfied one Deepest bucket.");
  assert(occurrence.search(projection, "Header tableword", { authorities: "cfr", common: { cfr: "section" } }).totalOccurrences > 0, "Section Common did not join separate table-cell evidence.");
  assert.strictEqual(occurrence.search(projection, "beta footneed", { authorities: "cfr" }).totalOccurrences, 0, "An explicit CFR footnote was merged into the preceding Deepest occurrence.");
  assert(occurrence.search(projection, "Note ordinaryneedle", { authorities: "cfr" }).totalOccurrences > 0, "One ordinary CFR note was not searchable as its own occurrence.");

  assert(occurrence.search(projection, "alpha", { scope: { ina: { inaSections: ["101"] } } }).totalOccurrences > 0, "An INA-number scope did not match its statute record.");
  assert.strictEqual(occurrence.search(projection, "alpha", { scope: { ina: { sections: ["1101"] } } }).totalOccurrences, 0, "A legacy INA sections selector was incorrectly interpreted as U.S.C.");
  assert(occurrence.search(projection, "alpha", { scope: { ina: { uscSections: ["1101"] } } }).totalOccurrences > 0, "A U.S.C.-number scope did not match its statute record.");
  assert(occurrence.search(projection, "alpha", { scope: { system: "usc", sections: ["1101"] } }).totalOccurrences > 0, "A direct U.S.C. scope contract did not match.");
  assert(occurrence.search(projection, "alpha", { scope: { ina: { inaRanges: [{ start: "101", end: "101" }] } } }).totalOccurrences > 0, "An INA range scope did not match.");
  const descriptorScope = occurrence.search(projection, "beta", { scope: { authority: "ina", authoritySection: "101", sectionIds: new Set(["8-1101"]), pathsBySection: new Map([["8-1101", ["a", "1"]]]) } });
  assert(descriptorScope.totalOccurrences > 0 && descriptorScope.buckets.every(bucket => bucket.path.join("/").startsWith("a/1")), "The existing resolved citation-scope descriptor was not a hard path fence.");
  assert.strictEqual(occurrence.search(projection, "appendixneedle", { scope: { cfr: { sections: ["1.1"] } } }).totalOccurrences, 0, "A CFR section scope leaked into appendices.");
  assert.strictEqual(occurrence.search(projection, "ordinaryneedle", { scope: { cfr: { appendices: ["8:1:appendix:1"] } } }).totalOccurrences, 0, "A CFR appendix scope leaked into sections.");
  assert.strictEqual(occurrence.search(projection, "appendixneedle", { scope: { cfr: { ranges: [{ start: "1.1", end: "1.2" }] } } }).totalOccurrences, 0, "A CFR section range leaked into appendices.");
  assert(occurrence.search(projection, "alpha", { authorities: new Set(["ina"]) }).totalOccurrences > 0, "Search does not accept an iterable authority set.");
  assert.strictEqual(occurrence.search(projection, "appendixneedle", { scope: { cfr: { ranges: ["1.1", "1.2"] } } }).totalOccurrences, 0, "A shorthand CFR range tuple was not a hard section fence.");

  const deepestAnd = occurrence.search(projection, "alpha beta", { authorities: "cfr" });
  assert.strictEqual(deepestAnd.totalOccurrences, 0, "Deepest Common unexpectedly joined separate CFR units.");
  assert.strictEqual(occurrence.search(projection, "synthetic alpha", { authorities: "cfr", common: { cfr: "paragraph-1" } }).totalOccurrences, 0, "A section-level heading was copied into a descendant Common bucket.");
  assert(occurrence.search(projection, "synthetic alpha", { authorities: "cfr", common: { cfr: "section" } }).totalOccurrences > 0, "Section Common did not include its own heading and descendant prose.");
  const subsectionAnd = occurrence.search(projection, "alpha beta", { authorities: "cfr", common: { cfr: "paragraph-1" } });
  assert.strictEqual(subsectionAnd.buckets.length, 1, "Paragraph-1 Common did not join its descendant evidence.");
  const sectionAnd = occurrence.search(projection, "alpha gamma", { authorities: "cfr", common: { cfr: "section" } });
  assert.strictEqual(sectionAnd.buckets.length, 1, "Section Common did not join sibling evidence.");
  const fenced = occurrence.search(projection, "alpha beta", { authorities: "cfr", common: { cfr: "section" }, scope: { cfr: { sections: ["1.1"], pathPrefixes: [["a", "1"]] } } });
  assert.strictEqual(fenced.totalOccurrences, 0, "A widened Common bucket escaped its hard path scope.");

  const beta = occurrence.search(projection, "beta", { authorities: "cfr" });
  assert.strictEqual(beta.totalOccurrences, 3, "Repeated atom occurrences were not counted exactly.");
  assert.strictEqual(beta.buckets.length, 2, "Repeated CFR source units were merged into one deepest bucket.");
  assert.strictEqual(beta.sections.length, 1, "Citable units in one CFR section were exposed as separate result-list groups.");
  assert.strictEqual(beta.sections[0].totalOccurrences, beta.totalOccurrences, "The section-level result total does not include all of its citable-unit hits.");
  const cfrRoot = beta.hierarchy.find(item => item.id === "cfr:root");
  assert.strictEqual(cfrRoot.totalOccurrences, beta.totalOccurrences, "Hierarchy aggregation does not equal its descendant occurrence total.");
  const cfrSection = beta.hierarchy.find(item => item.kind === "section");
  assert(cfrSection && cfrSection.parentId, "Hierarchy aggregates do not expose their parent identity for tree reconstruction.");

  const boolean = occurrence.compileQuery("alpha OR gamma beta");
  assert.deepStrictEqual(boolean.clauses.map(clause => clause.alternatives.length), [2, 1], "Flat OR precedence changed.");
  assert.throws(() => occurrence.compileQuery("((alpha beta))"), /Nested/, "Nested Boolean groups were accepted.");
  for (const malformed of ["(OR alpha)", "(alpha OR)", "(alpha OR OR beta)"]) assert.throws(() => occurrence.compileQuery(malformed), /OR/, `Malformed flat OR group was accepted: ${malformed}`);
  assert.throws(() => occurrence.compileQuery("alpha NOT beta"), /NOT is not supported/, "NOT was silently accepted by the occurrence compiler.");
  assert.strictEqual(occurrence.compileQuery("\\NOT").atoms[0].normalized, "not", "An escaped NOT token was treated as an operator.");
  const booleanResult = occurrence.search(projection, boolean, { authorities: "cfr", common: { cfr: "section" } });
  assert.strictEqual(booleanResult.buckets.length, 1, "Flat positive Boolean matching failed.");
  const commandAst = command.parseCommand("in:CFR common:section  alpha OR gamma beta");
  assert(commandAst.ok, "The command-language integration fixture is invalid.");
  const commandResult = occurrence.search(projection, commandAst);
  assert.strictEqual(commandResult.buckets.length, 1, "The occurrence engine did not consume the command-language AST/scope/Common contract.");
  assert(commandResult.buckets.every(bucket => bucket.authority === "cfr"), "An authority-wide command scope leaked into the other authority.");
  const statuteCommand = command.parseCommand("in:INA common:subsection alpha");
  assert(statuteCommand.ok, "The statute command integration fixture is invalid.");
  const statuteCommandResult = occurrence.search(projection, statuteCommand);
  assert(statuteCommandResult.buckets.length > 0 && statuteCommandResult.buckets.every(bucket => bucket.authority === "ina"), "The Command statute authority was not adapted to INA projection identity.");
  assert.strictEqual(statuteCommandResult.options.commonDepths.ina, 1, "The Command statute Common level was not applied.");
  const uscCommandResult = occurrence.search(projection, command.parseCommand("in:USC alpha"));
  assert(uscCommandResult.buckets.every(bucket => bucket.citation.startsWith("8 U.S.C. 1101")), "An authority-wide U.S.C. command lost its citation display system.");
  assert.throws(() => occurrence.search(projection, { type: "search", ok: false, status: "invalid", errors: [{ message: "invalid fixture" }], clauses: [{ alternatives: [{ value: "alpha" }] }] }), /invalid fixture/, "An invalid Command AST was executed.");

  const nearestResult = occurrence.search(projection, "(farword nearword) targetword", { authorities: "cfr", common: { cfr: "section" } });
  const nearestRows = nearestResult.materializeOccurrences({ limit: 20 }).rows;
  const targetRow = nearestRows.find(row => row.atom.normalized === "targetword");
  assert.strictEqual(targetRow?.evidence?.[0]?.atom?.normalized, "nearword", "Boolean materialization did not choose the nearest alternative evidence.");

  const contiguousResult = occurrence.search(projection, "beta repeated", { authorities: "cfr" });
  const contiguousRows = contiguousResult.materializeOccurrences({ sectionId: contiguousResult.sections[0].id, limit: 20 }).rows;
  assert(contiguousRows.some(row => row.snippets?.length === 1 && row.snippets[0].parts?.filter(part => part.match).length >= 2), "Nearby atomic matches were not composed into one contiguous text block.");
  const splitRows = sectionAnd.materializeOccurrences({ sectionId: sectionAnd.sections[0].id, limit: 20 }).rows;
  assert(splitRows.some(row => row.snippets?.length >= 2 && row.snippets.every(snippet => snippet.leadingEllipsis || snippet.trailingEllipsis)), "Separated atomic matches were not divided into independently elided text allowances.");

  assert.strictEqual(beta.stats.materializedOccurrences, 0, "Occurrences were eagerly materialized.");
  const page = beta.materializeOccurrences({ start: 1, limit: 2, contextCharacters: 24 });
  assert.strictEqual(page.returned, 2, "Lazy occurrence page returned the wrong number of rows.");
  assert.strictEqual(beta.stats.materializedOccurrences, 2, "Lazy materialization stats are inaccurate.");
  assert(page.rows.every(row => row.snippet.match.toLowerCase() === "beta"), "Raw snippet offsets do not map back to the matching text.");
  const sectionPage = beta.materializeOccurrences({ sectionId: beta.sections[0].id, start: 0, limit: 10 });
  assert.strictEqual(sectionPage.returned, beta.totalOccurrences, "The expanded section cannot materialize every hit row in that section.");
  const finalPage = beta.materializeOccurrences({ start: beta.totalOccurrences - 1, limit: 1 });
  assert.strictEqual(finalPage.returned, 1, "Lazy row offsets cannot reach the final occurrence.");

  const asyncBeta = await occurrence.searchAsync(projection, "beta", { authorities: "cfr", sliceMs: 0, yieldControl: () => Promise.resolve() });
  assert.strictEqual(asyncBeta.totalOccurrences, beta.totalOccurrences, "Cooperative and synchronous scans disagree.");
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(occurrence.searchAsync(projection, "beta", { signal: controller.signal }), error => error?.name === "AbortError", "An aborted scan did not stop.");
  const projectionController = new AbortController();
  let projectionYields = 0;
  await assert.rejects(occurrence.buildProjectionAsync(corpus, {
    signal: projectionController.signal,
    sliceMs: 0,
    yieldControl: () => { projectionYields += 1; projectionController.abort(); return Promise.resolve(); }
  }), error => error?.name === "AbortError", "An aborted runtime projection continued indexing.");
  assert(projectionYields > 0, "The async projection cancellation test never reached a cooperative boundary.");
  occurrence.clearProjection(corpus);
  const asyncCached = await occurrence.getProjectionAsync(corpus, { sliceMs: 0, yieldControl: () => Promise.resolve() });
  assert.strictEqual(await occurrence.getProjectionAsync(corpus), asyncCached, "The async projection did not populate the shared projection cache.");

  const browserSandbox = {};
  vm.runInNewContext(fs.readFileSync(path.join(root, "src", "INASearch-Occurrence.js"), "utf8"), browserSandbox);
  assert(browserSandbox.INA_SEARCH_OCCURRENCE?.buildProjectionAsync, "The browser UMD global was not installed with cooperative projection support.");
}

async function realCorpusTests() {
  const corpus = assigned("INASearch-Corpus.js", "INA_SEARCH_CORPUS");
  corpus.inaHierarchy = assigned("INASearch-INA-Hierarchy.js", "INA_SEARCH_INA_HIERARCHY");
  applyStatuteFootnotes(corpus, assigned("INASearch-Statute-Footnotes.js", "INA_SEARCH_STATUTE_FOOTNOTES"));
  applyStatuteStatusMetadata(corpus);
  indexStatuteRunIns(corpus);
  corpus.cfr = assigned("INASearch-CFR.js", "INA_SEARCH_CFR");
  const projection = occurrence.buildProjection(corpus);
  assert(projection.stats.buildMs < 1_000, `Runtime occurrence projection took ${projection.stats.buildMs.toFixed(1)}ms.`);
  assert(projection.stats.fragmentCount > 40_000, "The real legal projection is unexpectedly incomplete.");
  assert.strictEqual(projection.stats.inaRecords, 172, "The mapped operative INA record set changed unexpectedly.");
  assert.strictEqual(projection.stats.cfrSections, 3039, "The CFR section set changed unexpectedly.");
  assert(projection.fragments.some(fragment => fragment.kind === "statute-run-in"), "No statute run-in fragments were projected.");
  const knownCollisionFragments = projection.fragments.filter(fragment => fragment.recordId === "8-1160" && fragment.source?.runInCollision);
  assert.strictEqual(knownCollisionFragments.length, 4, "Known colliding statute run-ins were not detected.");
  assert(knownCollisionFragments.every(fragment => ["a/2/A", "a/2/B"].includes(fragment.path.join("/"))), "Colliding statute run-ins were merged at an ambiguous virtual path.");
  assert(projection.fragments.some(fragment => fragment.kind === "cfr-table-cell"), "No CFR table cells were projected.");
  assert(projection.fragments.some(fragment => fragment.kind === "cfr-footnote"), "No CFR footnotes were projected.");
  assert(!projection.fragments.some(fragment => ["editorial", "effective-date"].includes(fragment.noteType)), "Excluded CFR notes entered the projection.");
  assert(!projection.fragments.some(fragment => fragment.authority === "ina" && /\b\d{1,2}\d{1,2}\s+(?:so in original|see )/i.test(fragment.text)), "Flattened House editorial footnote prose entered primary legal search.");
  assert.strictEqual(occurrence.search(projection, "occupational physically", { authorities: "ina", scope: { ina: { inaSections: ["212"] } } }).totalOccurrences, 0, "Real duplicate INA 212(t)(1) occurrences were merged.");
  assert.strictEqual(occurrence.search(projection, "Newburyport Plymouth", { authorities: "cfr", scope: { cfr: { titles: ["8"], sections: ["100.4"] } } }).totalOccurrences, 0, "Real repeated 8 CFR 100.4(a) rows were merged.");
  const fieldOfficeRows = projection.fragments.filter(fragment => fragment.recordId === "8:100.4" && fragment.path.join("/") === "a" && ["Newburyport, MA", "Plymouth, MA"].includes(fragment.text));
  assert.strictEqual(new Set(fieldOfficeRows.map(fragment => fragment.occurrenceKeys.at(-1))).size, 2, "Real repeated CFR row identities are not source-order distinct.");
  assert(fieldOfficeRows.every(fragment => fragment.localHeading === "Class C"), "Real repeated CFR rows lost local heading labels.");
  const repealedScoped = occurrence.search(projection, "repealed", { authorities: "ina", scope: { ina: { uscSections: ["1485"] } } });
  assert(repealedScoped.totalOccurrences > 0 && repealedScoped.buckets.every(bucket => bucket.citation.startsWith("8 U.S.C. 1485")), "A combined House record cannot be scoped/labeled by its alternate U.S.C. mapping.");
  assert(repealedScoped.hierarchy.some(node => node.id === "ina:section:353") && !repealedScoped.hierarchy.some(node => node.id === "ina:section:352"), "An alternate U.S.C. scope aggregated its hit into unrelated INA hierarchy branches.");
  const inaRepealedScoped = occurrence.search(projection, "repealed", { authorities: "ina", scope: { ina: { inaSections: ["353"] } } });
  assert(inaRepealedScoped.totalOccurrences > 0 && inaRepealedScoped.buckets.every(bucket => bucket.citation.startsWith("INA 353")), "A combined House record cannot be scoped/labeled by its alternate INA mapping.");

  occurrence.search(projection, "alien");
  const warmedStarted = performance.now();
  const warmed = ["alien", '"aggravated felony"', "visa petition", "employment OR removal"].map(query => occurrence.search(projection, query));
  const warmedMs = performance.now() - warmedStarted;
  assert(warmed.every(result => result.totalOccurrences > 0), "A representative real-corpus query returned no legal occurrences.");
  assert(warmedMs < 300, `Four warmed searches took ${warmedMs.toFixed(1)}ms.`);

  const commonSection = occurrence.search(projection, "aggravated felony", { common: { ina: "section", cfr: "section" } });
  assert(commonSection.totalOccurrences > 0 && commonSection.buckets.length > 0, "Section-level Common search failed on the real corpus.");
  const frequent = occurrence.search(projection, "the");
  assert(frequent.totalOccurrences > 100_000, "High-frequency occurrence counting appears truncated.");
  assert(frequent.stats.scanMs + frequent.stats.finalizeMs < 150, `High-frequency search took ${(frequent.stats.scanMs + frequent.stats.finalizeMs).toFixed(1)}ms.`);

  const asyncProjection = await occurrence.buildProjectionAsync(corpus, { sliceMs: 8, yieldControl: () => Promise.resolve() });
  assert.strictEqual(asyncProjection.fragments.length, projection.fragments.length, "Cooperative and synchronous projections contain different fragment counts.");
  assert.deepStrictEqual(asyncProjection.fragments.map(fragment => `${fragment.recordId}:${fragment.kind}:${fragment.sourceOrder}`), projection.fragments.map(fragment => `${fragment.recordId}:${fragment.kind}:${fragment.sourceOrder}`), "Cooperative projection changed legal source order.");
  assert.deepStrictEqual(asyncProjection.hierarchyNodes.map(node => node.id), projection.hierarchyNodes.map(node => node.id), "Cooperative projection changed the legal hierarchy.");
  assert.strictEqual(occurrence.search(asyncProjection, "aggravated felony").totalOccurrences, occurrence.search(projection, "aggravated felony").totalOccurrences, "Cooperative projection changed search results.");
  assert(asyncProjection.stats.yields > 0, "Cooperative projection construction never yielded.");
  assert(asyncProjection.stats.maxSliceMs < 16, `A cooperative projection slice took ${asyncProjection.stats.maxSliceMs.toFixed(1)}ms.`);

  const asyncFrequent = await occurrence.searchAsync(projection, "the", { sliceMs: 8 });
  assert.strictEqual(asyncFrequent.totalOccurrences, frequent.totalOccurrences, "Cooperative high-frequency totals differ from synchronous totals.");
  assert(asyncFrequent.stats.yields > 0, "The high-frequency async scan never yielded.");
  assert(asyncFrequent.stats.maxSliceMs < 50, `A cooperative scan slice took ${asyncFrequent.stats.maxSliceMs.toFixed(1)}ms.`);
  const session = occurrence.createSearchSession(projection, { sliceMs: 0, yieldControl: () => Promise.resolve() });
  const superseded = session.search("the");
  const latest = session.search("alien");
  await assert.rejects(superseded, error => error?.name === "AbortError", "A superseded generation continued scanning.");
  assert((await latest).totalOccurrences > 0, "The latest generation was cancelled with its predecessor.");
  const snippetsStarted = performance.now();
  const snippets = asyncFrequent.materializeOccurrences({ limit: 200 });
  const snippetsMs = performance.now() - snippetsStarted;
  assert.strictEqual(snippets.returned, 200, "Could not lazily access 200 high-frequency rows.");
  assert(snippetsMs < 75, `Materializing 200 snippets took ${snippetsMs.toFixed(1)}ms.`);
  assert.strictEqual(asyncFrequent.materializeOccurrences({ start: asyncFrequent.totalOccurrences - 1, limit: 1 }).returned, 1, "The final high-frequency occurrence is not lazily reachable.");

  return {
    buildMs: Number(projection.stats.buildMs.toFixed(1)),
    fragments: projection.stats.fragmentCount,
    rawCharacters: projection.stats.rawCharacters,
    warmedFourMs: Number(warmedMs.toFixed(1)),
    frequentOccurrences: frequent.totalOccurrences,
    frequentMs: Number((frequent.stats.scanMs + frequent.stats.finalizeMs).toFixed(1)),
    asyncYields: asyncFrequent.stats.yields,
    maxSliceMs: Number(asyncFrequent.stats.maxSliceMs.toFixed(1)),
    snippets200Ms: Number(snippetsMs.toFixed(1)),
    asyncBuildMs: Number(asyncProjection.stats.buildMs.toFixed(1)),
    asyncBuildYields: asyncProjection.stats.yields,
    asyncBuildMaxSliceMs: Number(asyncProjection.stats.maxSliceMs.toFixed(1))
  };
}

(async () => {
  await syntheticTests();
  const performance = await realCorpusTests();
  console.log("Occurrence search tests passed.");
  console.log(JSON.stringify(performance, null, 2));
})().catch(error => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
