"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const { indexStatuteRunIns } = require("./statute-run-ins");
const { createParser } = require("./test-mixed-citations");

const source = JSON.parse(fs.readFileSync("sources/legal/historical-usc.json", "utf8"));
const member = source.groups.flatMap(group => group.members).find(section => section.section === "206");
assert(member?.body?.[0]?.text, "officially sourced former §206 must be available");
const section = {
  id: "8-206", title: 8, section: "206", heading: member.heading,
  status: member.status, historical: member.historical, body: structuredClone(member.body)
};
indexStatuteRunIns({ title8: { sections: [section] } });
const paths = section.runInPaths.map(path => path.join("/"));
for (const path of ["a", "a/1", "a/1/A", "a/1/B", "a/2", "a/3", "b"]) {
  assert(paths.includes(path), `former §206 should index printed subdivision ${path}: ${paths}`);
}
assert(!paths.includes("A"), "former §206(A) must not be invented from a printed (A) under (a)(1)");

const { api } = createParser({ title8: { sections: [section], runInRevision: 2 } });
const root = api.parseCitation("8 USC206(a)");
assert(root?.valid && root.path.join("/") === "a" && !root.ambiguity,
  "former §206(a) should identify the printed (a) alone, without a spurious (A) choice");
const nested = api.parseCitation("8 USC206(a)1A");
assert(nested?.valid && nested.path.join("/") === "a/1/A", "former §206(a)(1)(A) should navigate to its nested unit");

const member212 = source.groups.flatMap(group => group.members).find(section => section.section === "212");
const section212 = {
  id: "8-212", title: 8, section: "212", status: member212.status,
  historical: member212.historical, body: structuredClone(member212.body)
};
indexStatuteRunIns({ title8: { sections: [section212] } });
const paths212 = section212.runInPaths.map(path => path.join("/"));
assert(paths212.includes("c/2/A") && !paths212.includes("2/A"),
  `reused paragraph numbers in former §212 must retain their printed (c) parent: ${paths212}`);

// When distinct units differ only by case, choosing the other explicit unit
// must edit its parenthesized letter as well as compact suffixes.
const collision = { id: "8-9998", title: 8, section: "9998", body: [], runInPaths: [["a"], ["A"]] };
const collisionParser = createParser({ title8: { sections: [collision], runInRevision: 2 } }).api;
const ambiguous = collisionParser.resolveIndexedCompactStatutePath("usc", "9998", collision, "(a)");
const upper = ambiguous?.ambiguity?.options.find(option => option.path.join("/") === "A");
assert(upper, "case-distinct valid units must be offered as interpretations");
const edited = collisionParser.citationWithStatuteInterpretation("(a)", ambiguous.ambiguity, upper);
assert.equal(edited, "(A)", "choosing uppercase (A) must edit an explicit lowercase (a)");
assert.equal(collisionParser.resolveIndexedCompactStatutePath("usc", "9998", collision, edited)?.path.join("/"), "A");

console.log("PASS historical run-in paths: printed former §206 hierarchy and unambiguous (a) navigation.");
