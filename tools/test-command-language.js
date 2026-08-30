#!/usr/bin/env node
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.resolve(__dirname, "..");
const command = require(path.join(root, "src", "INASearch-Command"));
const plain = value => JSON.parse(JSON.stringify(value));
const codes = result => (result.errors || []).map(error => error.code);

function testBrowserAndNodeExports() {
  const source = fs.readFileSync(path.join(root, "src", "INASearch-Command.js"), "utf8");
  const context = { window: {} };
  vm.createContext(context);
  vm.runInContext(source, context);
  assert(context.window.INA_SEARCH_COMMAND, "The browser build did not publish window.INA_SEARCH_COMMAND.");
  assert.strictEqual(typeof context.window.INA_SEARCH_COMMAND.parseCommand, "function");
  assert.strictEqual(typeof command.parseCommand, "function", "The CommonJS build did not export the command API.");
  assert(Object.isFrozen(command), "The public command API should not be mutable.");
}

function testTopLevelSplitting() {
  const split = command.splitTopLevelCommands('INA 203(a,b), in:CFR "entry, departure", CFR 8\\, legacy');
  assert.strictEqual(split.status, "valid");
  assert.deepStrictEqual(split.segments.map(segment => segment.text), ["INA 203(a,b)", 'in:CFR "entry, departure"', "CFR 8\\, legacy"]);
  assert.strictEqual(command.splitTopLevelCommands("INA 203(a,b)").hasTopLevelComma, false, "A comma inside parentheses created a pane.");
  assert.strictEqual(command.splitTopLevelCommands('"a,b"').hasTopLevelComma, false, "A comma inside a phrase created a pane.");
  assert.strictEqual(command.splitTopLevelCommands("a\\,b").hasTopLevelComma, false, "An escaped comma created a pane.");
  assert.strictEqual(command.splitTopLevelCommands("INA 203,").status, "incomplete", "A trailing workspace separator should remain an incomplete edit.");
  assert(codes(command.splitTopLevelCommands("INA 203, CFR", { allowMultiple: false })).includes("child-multiple-commands"), "A child bar accepted a pane-spawning comma.");
  assert(codes(command.parseCommand("INA 203, CFR")).includes("multiple-commands"), "The singleton parser did not direct comma-separated input to the workspace parser.");
}

function testBooleanGrammar() {
  const phrase = command.parseCommand('"INA 212"');
  assert.strictEqual(phrase.ok, true);
  assert.strictEqual(phrase.forcedSearch, true, "Quoted citation-like text did not force search mode.");
  assert.deepStrictEqual(plain(phrase.clauses[0].alternatives), [{ type: "atom", kind: "phrase", value: "INA 212", raw: '"INA 212"' }]);

  const implicitOr = command.parseCommand('(term1 term2 "phrase3") term4');
  assert.deepStrictEqual(implicitOr.clauses.map(clause => [clause.operator, clause.alternatives.map(atom => atom.value)]), [
    ["OR", ["term1", "term2", "phrase3"]],
    ["ATOM", ["term4"]]
  ]);
  const explicitOr = command.parseCommand("term1 OR term2 term3");
  assert.deepStrictEqual(explicitOr.clauses.map(clause => [clause.operator, clause.alternatives.map(atom => atom.value)]), [
    ["OR", ["term1", "term2"]],
    ["ATOM", ["term3"]]
  ], "Explicit OR precedence changed.");
  assert.strictEqual(command.serializeCommand(explicitOr), "(term1 term2) term3", "Explicit OR did not canonicalize to a flat alternative group.");

  const escapedOperators = command.parseCommand("\\OR \\NOT");
  assert.strictEqual(escapedOperators.ok, true, "Escaped operator words should remain literal terms.");
  assert.deepStrictEqual(escapedOperators.clauses.map(clause => clause.alternatives[0].value), ["OR", "NOT"]);
  assert(codes(command.parseCommand("term1 NOT term2")).includes("not-unsupported"), "NOT was silently accepted.");
  assert(codes(command.parseCommand("term1 (term2 (term3 term4))")).includes("nested-group"), "Nested groups were silently accepted.");
  assert(codes(command.parseCommand("OR term1")).includes("misplaced-or"), "A leading OR was silently accepted.");
  assert(codes(command.parseCommand("term1 OR")).includes("misplaced-or"), "A trailing OR was silently accepted.");
  assert.strictEqual(command.parseCommand('"unfinished').status, "incomplete");
  assert.strictEqual(command.parseCommand("(unfinished").status, "incomplete");
  assert(codes(command.parseCommand('(in:INA waiver)')).includes("modifier-inside-group"), "A modifier inside an OR group was accepted.");
  assert.strictEqual(command.parseCommand('"in:CFR"').scope, null, "A tag inside quotes became a modifier.");
}

function testScopesAndCommonParsing() {
  const ina = command.parseCommand("in:INA common:subsection waiver");
  assert.strictEqual(ina.ok, true);
  assert.deepStrictEqual(plain(ina.scope), { values: ["ina"], rawValues: ["INA"], contentScopes: ["ina"], authorities: ["statute"], authority: "statute", citationSystem: "ina", rawValue: "INA" });
  assert.deepStrictEqual(plain(ina.common.levels), { statute: "subsection" });
  assert.strictEqual(command.serializeCommand(ina), "in:INA common:subsection waiver");

  const spacedCfr = command.parseCommand("in: CFR common: paragraph-3 admission");
  assert.strictEqual(spacedCfr.ok, true, "Spaced modifier editing did not parse.");
  assert.deepStrictEqual(plain(spacedCfr.common.levels), { cfr: "paragraph-3" });
  assert.strictEqual(command.serializeCommand(spacedCfr), "in:CFR common:P3 admission");

  const dual = command.parseCommand("common:USC=subsection common:CFR=paragraph-3 good moral character");
  assert.strictEqual(dual.ok, true);
  assert.deepStrictEqual(plain(dual.common.levels), { statute: "subsection", cfr: "paragraph-3" }, "Explicit dual Common values were synchronized over one another.");
  assert.strictEqual(command.serializeCommand(dual), "common:subsection,P3 good moral character");
  const dualRoundTrip = command.parseCommand(command.serializeCommand(dual));
  assert.deepStrictEqual(plain(dualRoundTrip.common.levels), plain(dual.common.levels));

  const commonSection = command.parseCommand("common:section waiver");
  assert.deepStrictEqual(plain(commonSection.common.levels), { statute: "section", cfr: "section" });
  const inferredStatute = command.parseCommand("common:subparagraph waiver");
  assert.deepStrictEqual(plain(inferredStatute.common.levels), { statute: "subparagraph", cfr: "paragraph-3" }, "A statutory dual-scope Common level did not initialize its analogous CFR level.");
  const inferredCfr = command.parseCommand("common:paragraph-5 waiver");
  assert.deepStrictEqual(plain(inferredCfr.common.levels), { statute: "subclause", cfr: "paragraph-5" }, "A CFR dual-scope Common level did not initialize its analogous statutory level.");
  const pAlias = command.parseCommand("common:P4 waiver");
  assert.deepStrictEqual(plain(pAlias.common.levels), { statute: "clause", cfr: "paragraph-4" }, "A CFR P-number did not infer the analogous statutory level.");
  const separateDepths = command.parseCommand("common:subsection,P4 waiver");
  assert.deepStrictEqual(plain(separateDepths.common.levels), { statute: "subsection", cfr: "paragraph-4" }, "A comma-separated Common pair did not preserve independent authority depths.");
  assert.strictEqual(command.scanCommandSegments("common:subsection,P4 waiver").hasTopLevelComma, false, "A Common depth pair was mistaken for a second workspace pane.");

  assert(codes(command.parseCommand("in:INA in:CFR waiver")).includes("duplicate-in-modifier"), "Duplicate in: modifiers were silently accepted.");
  assert(codes(command.parseCommand("in:INA common:CFR=section waiver")).includes("common-authority-out-of-scope"), "An out-of-scope CFR Common modifier was accepted in an INA-only search.");
  assert(codes(command.parseCommand("common:INA=section common:USC=subsection waiver")).includes("duplicate-common-authority"), "INA and USC aliases bypassed duplicate detection.");
  assert(codes(command.parseCommand("in:TITLE waiver")).includes("invalid-in-modifier"));
  assert(codes(command.parseCommand("common:CFR=subsection waiver")).includes("invalid-common-level"));
  assert.strictEqual(command.canonicalizeCommon({ statute: "deepest", cfr: "deepest" }), "");
  assert.strictEqual(command.canonicalizeCommon({ statute: "section", cfr: "paragraph-2" }), "common:section,P2");
  assert.strictEqual(command.canonicalizeCommon({ statute: "subsection" }), "common:subsection", "A single-authority Common state serialized as a dual state.");

  const contentUnion = command.parseCommand("in:INA,notes,highlights president");
  assert.strictEqual(contentUnion.ok, true);
  assert.deepStrictEqual(plain(contentUnion.scope.contentScopes), ["ina", "notes", "highlights"]);
  assert.deepStrictEqual(plain(contentUnion.scope.authorities), ["statute"]);
  assert.strictEqual(command.scanCommandSegments("in:INA,notes,highlights president").hasTopLevelComma, false, "A content-scope list became a workspace.");
  assert.strictEqual(command.splitTopLevelCommands("is:notes, INA 212").hasTopLevelComma, true, "A comma followed by a new command was swallowed by is:.");

  const listing = command.parseCommand("is:notes,highlights");
  assert.deepStrictEqual(plain(listing.listing.kinds), ["notes", "highlights"]);
  assert(codes(command.parseCommand("president is:notes")).includes("is-exclusive"), "is: accepted an ordinary term.");
  assert(codes(command.parseCommand("is:notes has:highlights")).includes("is-exclusive"), "is: accepted another modifier.");

  const hasOr = command.parseCommand("president has:notes,highlights");
  assert.deepStrictEqual(plain(hasOr.has.map(item => item.kinds)), [["notes", "highlights"]]);
  const hasAnd = command.parseCommand("has:notes has:highlights");
  assert.deepStrictEqual(plain(hasAnd.has.map(item => item.kinds)), [["notes"], ["highlights"]]);
  assert(codes(command.parseCommand("in:notes president has:notes")).includes("has-artifact-scope"), "has: accepted an artifact-returning in: scope.");
}

function testCommonDepthState() {
  assert.strictEqual(command.commonDepth("statute", "section"), 0);
  assert.strictEqual(command.commonDepth("statute", "subsubitem"), 8);
  assert.strictEqual(command.commonDepth("cfr", "paragraph-6"), 6);
  assert.strictEqual(command.commonDepth("cfr", "deepest"), Infinity);

  assert.deepStrictEqual(plain(command.mapCommonLevel("subparagraph", "statute", "cfr")), {
    ok: true, level: "paragraph-3", depth: 3, requestedDepth: 3, clamped: false, fromAuthority: "statute", toAuthority: "cfr"
  });
  const clamped = command.mapCommonLevel("subsubitem", "statute", "cfr");
  assert.deepStrictEqual(plain({ level: clamped.level, requestedDepth: clamped.requestedDepth, depth: clamped.depth, clamped: clamped.clamped }), {
    level: "paragraph-6", requestedDepth: 8, depth: 6, clamped: true
  });
  assert.strictEqual(command.mapCommonLevel("deepest", "cfr", "statute").level, "deepest");

  const statuteExpanded = command.initializeCommonLevels({ statute: "clause" }, ["statute", "cfr"]);
  assert.deepStrictEqual(plain(statuteExpanded.levels), { statute: "clause", cfr: "paragraph-4" });
  const cfrExpanded = command.initializeCommonLevels({ cfr: "paragraph-3" }, ["statute", "cfr"]);
  assert.deepStrictEqual(plain(cfrExpanded.levels), { statute: "subparagraph", cfr: "paragraph-3" });

  const statuteSelection = command.applyCommonSelection(
    { statute: "section", cfr: "paragraph-5" }, "INA", "paragraph",
    { authorities: ["statute", "cfr"], syncAcrossAuthorities: true }
  );
  assert.deepStrictEqual(plain(statuteSelection.levels), { statute: "paragraph", cfr: "paragraph-2" });
  assert.strictEqual(statuteSelection.synchronized, true);

  const cfrSelection = command.applyCommonSelection(
    statuteSelection.levels, "CFR", "paragraph-6",
    { authorities: ["statute", "cfr"], syncAcrossAuthorities: true }
  );
  assert.deepStrictEqual(plain(cfrSelection.levels), { statute: "item", cfr: "paragraph-6" }, "CFR selection did not drive the INA selector to its analogous unit.");
  assert.strictEqual(cfrSelection.synchronized, true);

  const syncDisabled = command.applyCommonSelection(
    { statute: "section", cfr: "paragraph-5" }, "statute", "subsection",
    { authorities: ["statute", "cfr"], syncAcrossAuthorities: false }
  );
  assert.deepStrictEqual(plain(syncDisabled.levels), { statute: "subsection", cfr: "paragraph-5" });
}

function testClassificationAndChildRules() {
  const classifierCalls = [];
  const citationClassifier = value => {
    classifierCalls.push(value);
    if (["I", "IN", "INA", "INA 2", "INA 203("].includes(value)) return "prefix";
    if (value === "INA 203(a)") return { valid: true };
    return "invalid";
  };
  for (const prefix of ["I", "IN", "INA", "INA 2", "INA 203("]) {
    const classified = command.classifyInput(prefix, { citationClassifier });
    assert.strictEqual(classified.mode, "navigation-prefix", `${prefix} stopped being a citation prefix.`);
  }
  assert.strictEqual(command.classifyInput("INA 203(a)", { citationClassifier }).mode, "navigation", "A complete citation was classified as text.");
  assert.strictEqual(command.classifyInput("ordinary words", { citationClassifier }).mode, "search", "Clearly noncitation text did not become a standard search.");

  const callsBeforeQuote = classifierCalls.length;
  assert.strictEqual(command.classifyInput('"INA 203(a)"', { citationClassifier }).mode, "search");
  assert.strictEqual(classifierCalls.length, callsBeforeQuote, "Quoted input unnecessarily invoked citation classification.");
  assert.strictEqual(command.classifyInput("term1 OR term2", { citationClassifier: () => "valid" }).mode, "search", "Explicit Boolean syntax was overridden by a citation classifier.");

  const childPhrase = command.parseChildCommand('"entry, departure"', { citationClassifier });
  assert.strictEqual(childPhrase.mode, "search", "A quoted comma was rejected in a child bar.");
  const childIncompletePhrase = command.parseChildCommand('"entry', { citationClassifier });
  assert.strictEqual(childIncompletePhrase.mode, "search");
  assert.strictEqual(childIncompletePhrase.status, "incomplete", "An unfinished child phrase was treated as a hard error rather than an in-progress search.");
  const childMultiple = command.parseChildCommand("INA 203(a), CFR", { citationClassifier });
  assert.strictEqual(childMultiple.mode, "invalid");
  assert(codes(childMultiple).includes("child-multiple-commands"));

  const workspace = command.classifyInput('INA 203(a), in:CFR "entry, departure"', { citationClassifier });
  assert.strictEqual(workspace.type, "workspace");
  assert.strictEqual(workspace.status, "valid");
  assert.deepStrictEqual(workspace.commands.map(item => item.classification.mode), ["navigation", "search"]);
  assert.strictEqual(command.classifyInput("", { citationClassifier }).mode, "empty");
}

function main() {
  testBrowserAndNodeExports();
  testTopLevelSplitting();
  testBooleanGrammar();
  testScopesAndCommonParsing();
  testCommonDepthState();
  testClassificationAndChildRules();
  console.log("PASS command language: splitting, Boolean AST, scopes, Common mapping/sync, classification, and child-pane rules");
}

main();
