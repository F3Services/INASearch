#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const presentation = require("../src/INASearch-USLM");
const text = "Opening Second";
const layout = [
  { tag: "chapeau", start: 0, end: 7 },
  { tag: "chapeau", start: 7, end: 14, children: [{ tag: "i", start: 8, end: 14 }] }
];
const render = (start, end) => text.slice(start, end);
const html = presentation.format(layout, 0, text.length, render, { mode: "field" });
assert(html.includes('data-uslm-tag="chapeau"'));
assert(html.includes("<i"));
assert.equal(presentation.format(layout, 0, text.length, render, { plainText: true }), "Opening\n\nSecond");
assert.equal(html.replace(/<[^>]*>/g, ""), text, "Formatting must retain original source characters");
assert.equal(presentation.format(layout, 9, 12, render, { mode: "inline" }).replace(/<[^>]*>/g, ""), "eco", "Clipped ranges preserve exact positions");
const emptyTable = [{ tag: "table", start: 0, end: 0, width: "50%", children: [{ tag: "colgroup", start: 0, end: 0, children: [{ tag: "col", start: 0, end: 0, style: { width: "10%" } }] }] }];
const table = presentation.format(emptyTable, 0, 0, () => "");
assert(table.includes("<colgroup"));
assert(table.includes("<col "));
assert(!table.includes("</col>"));
assert(table.includes("width:50%"));
assert(!presentation.attributes({ presentation: { italic: true }, style: { background: "url(javascript:bad)", width: '50%;color:red' } }).includes("javascript"));
assert(!presentation.attributes({ style: { width: '50%;color:red' } }).includes("color:red"));
const indent = presentation.attributes({ presentation: { indent: 4, firstIndent: -4, smallCaps: true } }, { parentIndent: 3 });
assert(indent.includes("margin-left:1.4em"));
assert(indent.includes("text-indent:-5.6em"));
const hanging = [{ tag: "p", start: 0, end: text.length, presentation: { bold: true, indent: 2, firstIndent: -2 } }];
const hangingHtml = presentation.format(hanging, 0, text.length, (start, end) => presentation.format(hanging, start, end, render, { mode: "inline" }), { structuralOnly: true });
assert.equal((hangingHtml.match(/margin-left:/g) || []).length, 1, "Inline typography must not duplicate the paragraph's hanging margin");
assert.equal((hangingHtml.match(/text-indent:/g) || []).length, 1, "Inline typography must not duplicate the paragraph's first-line indent");
const continuation = [{ tag: "continuation", start: 1, end: 14, presentation: { indent: 1, firstIndent: 0 } }];
assert.deepEqual(presentation.fieldParts(continuation, 0, 14, " continuation!"), [{ start: 0, end: 14 }], "Leading source whitespace must not create an empty paragraph");
const continuationHtml = presentation.format(continuation, 0, 14, render, { mode: "field", parentIndent: 1 });
assert(continuationHtml.includes("margin-left:0em"), "Source continuation indentation is relative to its structural parent");
assert(continuationHtml.includes("display:block"), "Continuation indentation applies to all wrapped lines");
assert(!continuationHtml.includes("uslm-field-block"), "Leading whitespace must not add a second paragraph margin");
const parentContinuation = [{ tag: "continuation", start: 0, end: 16, presentation: { indent: 2, firstIndent: 0 } }];
const parentContinuationHtml = presentation.format(parentContinuation, 0, 16, (start, end) => "is inadmissible.".slice(start, end), { mode: "field", parentIndent: 4, parentFirstIndent: -2 });
assert(parentContinuationHtml.includes("margin-left:0em"), "INA 212's continuation must align with its parent's first line instead of escaping the paragraph padding");
// INA 212(a)(3)(B)(iii) has a second hanging offset on its continuation.
// Its parent starts at 5 - 2 = 3, but the continuation starts at 4 - 2 = 2.
// Keep the hanging shape while placing its first line inside the citation.
const hangingContinuation = [{ tag: "continuation", start: 0, end: 16, presentation: { indent: 4, firstIndent: -2 } }];
const hangingContinuationHtml = presentation.format(hangingContinuation, 0, 16, render, { mode: "field", parentIndent: 5, parentFirstIndent: -2 });
assert(hangingContinuationHtml.includes("margin-left:2.8em"), "A continuation's hanging first line must not escape its citation container");
assert(hangingContinuationHtml.includes("text-indent:-2.8em"), "Containing a continuation must retain its hanging layout");
const alignedContinuation = [{ tag: "continuation", start: 0, end: 16, presentation: { indent: 3, firstIndent: -1 } }];
const alignedContinuationHtml = presentation.format(alignedContinuation, 0, 16, render, { mode: "field", parentIndent: 4, parentFirstIndent: -2 });
assert(alignedContinuationHtml.includes("margin-left:1.4em"), "Already-contained continuations retain their source indentation");
assert(alignedContinuationHtml.includes("text-indent:-1.4em"));
const noteHangingHtml = presentation.format(hangingContinuation, 0, 16, render, { mode: "note", parentIndent: 3 });
assert(noteHangingHtml.includes("margin-left:1.4em"), "Standalone notes retain their publisher coordinate system");
// INA 212(a)(1)(A)'s chapeau follows a separately rendered label and heading.
// Its publisher indent (2) is below its parent's hanging indent (4); applying
// that negative difference to an inline span pulls it over the heading.
const chapeauText = "Any alien—";
const chapeau = [{ tag: "chapeau", start: 0, end: chapeauText.length, presentation: { indent: 2, italic: true } }];
const chapeauHtml = presentation.format(chapeau, 0, chapeauText.length, (start, end) => chapeauText.slice(start, end), { mode: "field", parentIndent: 4 });
assert(!chapeauHtml.includes("margin-left:"), "An opening inline chapeau must follow the citation and heading without moving back over them");
assert(chapeauHtml.includes("font-style:italic"), "Inline chapeaux retain source typography");
assert.equal(chapeauHtml.replace(/<[^>]*>/g, ""), chapeauText, "Chapeau spacing must preserve every source character");
const separateChapeaux = presentation.format([layout[0], { ...layout[1], presentation: { indent: 3 } }], 0, text.length, render, { mode: "field", parentIndent: 2 });
assert(separateChapeaux.includes("uslm-field-block"), "Later chapeaux must keep their separate paragraph layout");
assert(separateChapeaux.includes("margin-left:1.4em"), "Separate chapeau paragraphs retain their source indentation");
console.log("PASS USLM layout runtime: blocks, emphasis, clipping, empty table columns, safe styles and hanging indentation");
