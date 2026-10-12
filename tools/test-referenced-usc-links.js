"use strict";
const assert = require("node:assert/strict");
const { legalReferenceContext, generatedReferences } = require("./legal-references");
const corpus = { title8: { sections: [{ id: "8-16", section: "16", body: [{ label: "b", text: "Unrelated Title 8 unit" }] }] },
  referencedUsc: { titles: [{ number: 18, sections: [{ id: "18-16", title: 18, section: "16", body: [{ label: "a", text: "Force" }] }] }] }, inaCrosswalk: [], cfr: {} };
const context = { ...legalReferenceContext(corpus), kind: "usc", title: "8", section: "1101", sourceId: "fixture" };
const reference = text => generatedReferences(text, context).find(ref => ref.family === "usc");
assert.equal(reference("18 U.S.C. 16(a)").resolution, "local", "Included cross-title subunits open locally");
assert.equal(reference("18 U.S.C. 16(b)").resolution, "official-source-only", "A Title 8 path must not validate another title's section");
assert.equal(reference("18 U.S.C. 999").resolution, "official-source-only", "Unincluded sections remain external");
console.log("PASS cross-title USC link resolution and title-isolated path validation");
