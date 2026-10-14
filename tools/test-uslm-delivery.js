#!/usr/bin/env node
"use strict";

// Expectations come directly from original XML, independently of generated
// overlays, packed corpus data, and the production presentation extractor.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { execFileSync } = require("node:child_process");
const { readBuildCorpus } = require("./read-build-corpus");
const { unpackLegalReferences } = require("./pack-legal-references");
const { applyStatuteFootnotes, statuteFootnoteSourceMap } = require("./statute-footnotes");
const { runtime } = require("./audit-ina-display");
const functionSource = require("./test-function-source");
const presentation = require("../src/INASearch-USLM");
const template = fs.readFileSync("src/INASearch.template.html", "utf8");
const expected = JSON.parse(execFileSync("python3", ["-B", "tools/uslm-presentation-oracle.py", "--cases"], { maxBuffer: 100 * 1024 * 1024 }));
const escape = value => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const decode = value => value.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const flat = blocks => (blocks || []).flatMap(block => [block, ...flat(block.children)]);
const counts = values => values.reduce((out, value) => (out[value] = (out[value] || 0) + 1, out), {});
const canonical = value => JSON.parse(JSON.stringify(value));

function markup(html) {
  let text = "";
  const stack = [], tags = [], runs = [];
  for (const token of html.matchAll(/<[^>]*>|[^<]+/g)) {
    if (token[0][0] !== "<") {
      const value = decode(token[0]);
      const styles = Object.assign({}, ...stack.map(item => item.style));
      runs.push({ start: text.length, end: text.length + value.length, styles });
      text += value;
    } else if (token[0].startsWith("</")) {
      const tag = token[0].slice(2, -1).trim();
      assert.equal(stack.pop()?.tag, tag, "Renderer emits balanced presentation elements");
    } else {
      const tag = token[0].match(/^<([^\s>]+)/)[1];
      const attrs = Object.fromEntries([...token[0].matchAll(/([\w-]+)="([^"]*)"/g)].map(match => [match[1], decode(match[2])]));
      const style = Object.fromEntries((attrs.style || "").split(";").filter(Boolean).map(value => value.split(":")));
      if (attrs["data-uslm-tag"]) tags.push({ tag: attrs["data-uslm-tag"], style, attrs });
      if (!["col", "br", "hr", "img", "input", "meta", "link"].includes(tag)) stack.push({ tag, style });
    }
  }
  assert.equal(stack.length, 0, "Renderer closes all presentation elements");
  return { text, tags, runs };
}

function assertInlinePresentation(rendered, blocks, start, label) {
  const properties = { italic: ["font-style", "italic"], bold: ["font-weight", "bold"], smallCaps: ["font-variant", "small-caps"] };
  for (const block of blocks) {
    for (const [flag, [property, value]] of Object.entries(properties)) {
      if (!block.presentation?.[flag]) continue;
      const from = block.start - start, to = block.end - start;
      for (const run of rendered.runs) {
        const first = Math.max(from, run.start), last = Math.min(to, run.end);
        if (last <= first || !rendered.text.slice(first, last).trim()) continue;
        assert.equal(run.styles[property], value, `${label}: ${flag} survives actual template citation rendering at ${first}`);
      }
    }
  }
}

function verify(corpus, label) {
  // Historical expansion preserves original grouped House records separately
  // and assigns selected notes to individual members via sourceNoteId.
  const deliveredSections = [...(corpus.historicalUsc?.groupSources || []), ...corpus.title8.sections];
  const sources = statuteFootnoteSourceMap({ title8: { sections: deliveredSections } });
  const sections = new Map(deliveredSections.map(section => [String(section.section), section]));
  const deliveredNotes = new Map(deliveredSections.flatMap(section => (section.notes || []).flatMap(note => [[note.id, note], ...(note.sourceNoteId ? [[note.sourceNoteId, note]] : [])])));
  const api = runtime(template, corpus);
  api.profile.preferences.statutoryLinkCitationSystem = "usc";
  Object.assign(api, { els: { detail: { innerHTML: "" } }, statuteDefinitionContext: () => ({}), statuteStatusWarning: () => "", kindLabel: value => value, noteResultKind: value => value, titleCaseTopic: value => value, openButton: () => "" });
  for (const name of ["statuteNoteBodyStart", "formatStatuteNoteBody", "renderStatuteNoteBody", "statuteNoteBodyPlainText", "renderStatuteNote", "renderStatutoryNote", "renderSourceCredit"])
    vm.runInContext(functionSource(template, name), api);
  const totals = {};
  let cases = 0, historicalCases = 0;
  for (const item of expected) {
    const where = item.sourceKey ? `${item.sourceKey}.${item.field}` : `${item.division || item.section}.note${item.index}.${item.kind}`;
    const diagnostic = `${label}: ${where}`;
    let source, layout, display, text, references;
    if (item.kind === "field") {
      source = sources.get(item.sourceKey);
      // Historical replacements supply their operative text from a separate
      // historical authority; current publisher disposition text is empty.
      const section = sections.get(item.sourceKey.split(":")[0]);
      if (!source && (!item.text || !item.nodes.length)) continue;
      assert(source, `${diagnostic}: original source field is delivered`);
      if (section?.historical && source[item.field] !== item.text) { historicalCases++; continue; }
      text = source[item.field];
      layout = source[`${item.field}Layout`] || [];
      display = source[`${item.field}Presentation`] || {};
      references = source[item.field === "text" ? "references" : `${item.field}References`] || [];
    } else {
      const division = item.division ? corpus.title8.divisionNotes?.[item.division] : null;
      source = (division || sections.get(item.section))?.notes?.[item.index]
        || deliveredNotes.get(`8-${item.section}-note-${item.index + 1}`);
      if (!source && !item.nodes.length) continue;
      assert(source, `${diagnostic}: original publisher note is delivered`);
      const heading = item.kind === "note-heading";
      text = heading ? source.heading : source.text;
      layout = source[heading ? "headingLayout" : "layout"] || [];
      display = heading ? source.headingPresentation || {} : {};
      references = source[heading ? "headingReferences" : "references"] || [];
    }
    assert.equal(text, item.text, `${diagnostic}: clean source text`);
    assert.deepEqual(canonical(display), item.presentation, `${diagnostic}: source field presentation`);
    const blocks = flat(layout);
    assert.equal(blocks.length, item.nodes.length, `${diagnostic}: all original elements survive delivery`);
    blocks.forEach((block, index) => {
      const wanted = item.nodes[index];
      assert.equal(block.tag, wanted.tag, diagnostic);
      assert.equal(text.slice(block.start, block.end), wanted.text, `${diagnostic}: exact source range for ${wanted.tag}`);
      assert.deepEqual(canonical(block.presentation || {}), wanted.presentation, `${diagnostic}: ${wanted.tag} presentation`);
      assert.deepEqual(canonical(block.style || {}), wanted.style || {}, `${diagnostic}: ${wanted.tag} publisher CSS`);
      for (const attr of ["origin", "identifier", "status", "width", "value"])
        if (Object.hasOwn(wanted, attr)) assert.equal(block[attr], wanted[attr], `${diagnostic}: ${attr}`);
      totals[block.tag] = (totals[block.tag] || 0) + 1;
    });
    const html = presentation.format(layout, item.start, text.length, (from, to) => escape(text.slice(from, to)), { mode: item.kind === "note" ? "note" : "field" });
    const rendered = markup(html);
    assert.equal(rendered.text, text.slice(item.start), `${diagnostic}: shared formatter preserves every character`);
    assert.deepEqual(counts(rendered.tags.map(block => block.tag)), counts(item.nodes.map(block => block.tag)), `${diagnostic}: every source element produces its wrapper, including empty elements`);
    rendered.tags.forEach((tag, index) => {
      const wanted = item.nodes[index], flags = wanted.presentation;
      if (flags.centered) assert.equal(tag.style["text-align"], "center", `${diagnostic}: centered source block`);
      if (flags.fontSize === 8) assert.equal(tag.style["font-size"], "8pt", `${diagnostic}: source font size`);
      if (flags.inline) assert.equal(tag.style.display, "inline", `${diagnostic}: inline source class`);
      if (Object.hasOwn(flags, "firstIndent")) {
        const value = parseFloat(tag.style["text-indent"]);
        assert(Number.isFinite(value), `${diagnostic}: first-line indent is rendered`);
        assert.equal(Math.sign(value), Math.sign(flags.firstIndent), `${diagnostic}: hanging-indent direction`);
      }
      if (flags.leaders) assert(tag.attrs.class.split(/\s+/).includes("uslm-leaders"), `${diagnostic}: table leaders`);
      for (const [property, value] of Object.entries(wanted.style || {}))
        assert.equal(tag.style[property], value, `${diagnostic}: table CSS ${property}`);
      if (wanted.width) assert.equal(tag.style.width, wanted.width, `${diagnostic}: table width`);
    });
    assertInlinePresentation(rendered, blocks, item.start, diagnostic);
    // Unlike the direct formatter assertion, this exercises the application's
    // citation segmentation, note structural pass, and inline style pass.
    const actualHtml = item.kind === "note" ? api.renderStatuteNoteBody(source, null, { citationDisplaySystem: "usc" })
      : api.linkifyStatutoryText(text, references, 0, undefined, null, [], { sourceLayout: layout, sourcePresentation: display, citationDisplaySystem: "usc" });
    const actual = markup(actualHtml);
    assert.equal(actual.text, text.slice(item.start), `${diagnostic}: actual reader retains source text`);
    assertInlinePresentation(actual, blocks, item.start, diagnostic);
    if (item.kind === "field") for (const block of layout.filter(block => block.tag === "continuation")) {
      const tag = actual.tags.filter(tag => tag.tag === "continuation")[layout.filter(candidate => candidate.tag === "continuation").indexOf(block)];
      assert.equal(tag.style.display, "block", `${diagnostic}: continuation indentation applies to every line`);
      if (Number.isFinite(block.presentation?.indent)) assert.equal(parseFloat(tag.style["margin-left"]), Math.round((block.presentation.indent - (display.indent || 0) - (display.firstIndent || 0)) * 14) / 10, `${diagnostic}: source continuation indent is relative to its parent's first line`);
    }
    if (item.kind === "field" && item.field === "sourceCredit") {
      api.renderSourceCredit({ section: sections.get(item.sourceKey.split(":")[0]), text });
      const credit = api.els.detail.innerHTML.match(/<p style="white-space:pre-wrap">([\s\S]*?)<\/p>/)?.[1];
      assert(credit !== undefined, `${diagnostic}: dedicated source credit view`);
      assertInlinePresentation(markup(credit), blocks, 0, `${diagnostic}: dedicated source credit view`);
    }
    if (item.kind === "note-heading" && source.text.slice(source.bodyStart || 0).trim()) {
      const completeNote = api.renderStatuteNote({ houseEditorialFootnotes: [] }, source, item.index, null, { citationDisplaySystem: "usc" });
      const summary = completeNote.match(/<summary\b[^>]*>[\s\S]*?<\/summary>/)?.[0];
      assert(summary, `${diagnostic}: actual note renderer supplies its heading`);
      const heading = markup(summary);
      assert.equal(heading.text, text, `${diagnostic}: actual heading text`);
      assertInlinePresentation(heading, [{ start: 0, end: text.length, presentation: display }], 0, diagnostic);
      // Footer disclosure labels retain source typography, while the reader
      // owns alignment and the native summary marker used to expand the note.
      assert.equal(heading.runs[0].styles["text-align"], undefined, `${diagnostic}: footer heading keeps reader alignment`);
      assert.equal(heading.runs[0].styles.display, undefined, `${diagnostic}: footer heading keeps its native disclosure arrow`);
      if (display.fontSize === 8) assert.equal(heading.runs[0].styles["font-size"], "8pt", `${diagnostic}: sized note heading`);
      if (!item.division) {
        api.renderStatutoryNote({ section: sections.get(item.section), note: source });
        const detailHeading = markup(api.els.detail.innerHTML.match(/<h2\b[^>]*>[\s\S]*?<\/h2>/)[0]);
        assertInlinePresentation(detailHeading, [...blocks, { start: 0, end: text.length, presentation: display }], 0, `${diagnostic}: dedicated note heading`);
        if (display.centered) assert.equal(detailHeading.runs[0].styles["text-align"], "center", `${diagnostic}: dedicated centered heading`);
        if (display.fontSize === 8) assert.equal(detailHeading.runs[0].styles["font-size"], "8pt", `${diagnostic}: dedicated sized heading`);
      }
    }
    if (item.kind === "note") {
      const plain = api.statuteNoteBodyPlainText(source);
      assert.equal(plain.replace(/\s+/g, ""), text.slice(item.start).replace(/\s+/g, ""), `${diagnostic}: note copy retains source text`);
    }
    cases++;
  }
  for (const [tag, count] of Object.entries({ i: 409, inline: 1125, title: 5, signature: 30, name: 30, col: 2, span: 4 }))
    assert.equal(totals[tag], count, `${label}: all original ${tag} elements are covered`);
  console.log(`PASS ${label}: ${cases} original-XML presentation cases; all 409 italics, 1125 inline spans, 5 quoted titles, 30 signatures, 2 columns; ${historicalCases} historical fields use separate source coverage`);
}

const generated = { window: {} };
vm.runInNewContext(fs.readFileSync("src/INASearch-Corpus.js", "utf8"), generated);
const overlayArgument = process.argv.indexOf("--overlay");
vm.runInNewContext(fs.readFileSync(overlayArgument < 0 ? "src/INASearch-Statute-Footnotes.js" : process.argv[overlayArgument + 1], "utf8"), generated);
verify(applyStatuteFootnotes(generated.window.INA_SEARCH_CORPUS, generated.window.INA_SEARCH_STATUTE_FOOTNOTES), "generated overlay");
if (!process.argv.includes("--generated-only")) {
  for (const file of ["INASearch.html", "INASearch-Uncompressed.html"]) verify(unpackLegalReferences(readBuildCorpus(file)), file);
}
console.log("PASS USLM delivery: original source presentation preserved in all checked artifacts");
