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
console.log("PASS USLM layout runtime: blocks, emphasis, clipping, empty table columns, safe styles and hanging indentation");
