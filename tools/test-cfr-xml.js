"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const hierarchy = require("../src/INASearch-CFR-Hierarchy");
const { createCfrXmlParagraphResolver } = require("../src/INASearch-CFR-XML");
const cleanText = value => String(value || "").replace(/\s+/g, " ").trim();
const canonicalMatchMap = value => {
  const offsets = [], characters = [];
  [...value].forEach((c, i) => { if (!/\s/.test(c) && c !== "\u00ad") { characters.push(c); offsets.push(i); } });
  return { text: characters.join(""), offsets };
};
const resolve = createCfrXmlParagraphResolver({ hierarchy, cleanText, flattened: node => cleanText(node.textContent),
  inlineRuns: node => node.runs || [], canonicalMatchMap, canonicalMatchText: text => canonicalMatchMap(text).text });
const node = (text, runs, tagName = "P") => ({ tagName, textContent: text, runs, children: [] });
const root = (...children) => ({ children });
const block = (x, a, u) => ({ t: "p", x, ...(a ? { a, u: u || [{ a, s: 0, e: x.indexOf(")") + 1 }] } : {}) });

test("exact unaddressed definition lists remain unaddressed", () => {
  const result = resolve(root(node("(1) A defined term.")), { blocks: [{ ...block("(1) A defined term."), c: "(b)", d: 4 }] });
  assert.equal(result.paragraphs[0].addressable, false);
  assert.equal(result.paragraphs[0].context, "(b)");
  assert.equal(result.unresolvedCount, 0);
});

test("XML can combine consecutive verified paragraphs without losing either marker", () => {
  const previous = { blocks: [block("(a) General.", "(a)"), block("(1) Requirement.", "(a)(1)")] };
  const result = resolve(root(node("(a) General. (1) Requirement.")), previous);
  assert.deepEqual(result.paragraphs[0].units, [{ a: "(a)", s: 0, e: 3 }, { a: "(a)(1)", s: 13, e: 16 }]);
});

test("canonical exact matches remap marker spans when source characters move", () => {
  const old = "(a) Head.\u00ad(1) Child", current = "(a) Head.(1) Child";
  const result = resolve(root(node(current)), { blocks: [block(old, "(a)(1)", [{ a: "(a)", s: 0, e: 3 }, { a: "(a)(1)", s: 10, e: 13 }])] });
  for (const unit of result.paragraphs[0].units) assert.equal(current.slice(unit.s, unit.e), "(" + hierarchy.tokens(unit.a).at(-1) + ")");
});

test("table data cannot establish ancestry for the next paragraph", () => {
  const result = resolve(root(node("(a) General."), node("(1) Table data", [], "TABLE"), node("(ii) Following paragraph.")),
    { blocks: [block("(a) General.", "(a)")] });
  assert.equal(result.paragraphs[1].addressable, false);
  assert.equal(result.paragraphs[1].context, "(a)");
  assert.equal(result.paragraphs[2].addressable, false);
  assert.equal(result.unresolvedCount, 1);
});

test("a fresh ambiguous Roman or letter marker requires context", () => {
  for (const token of ["i", "I"]) {
    const result = resolve(root(node("(" + token + ") New item.")));
    assert.equal(result.paragraphs[0].addressable, false);
    assert.equal(result.unresolvedCount, 1);
  }
  const previous = { blocks: [block("(a) Parent heading.", "(a)")] };
  const result = resolve(root(node("(a) Parent heading."), node("(i) New item."), node("(1) Its child.")), previous);
  assert.equal(result.paragraphs[1].addressable, false);
  assert.equal(result.unresolvedCount, 1);
});

test("new compound headings can contain several numbered levels", () => {
  const x = "(c) Cancellation—(1) Bonds—(i) Cancellation. Conditions follow:";
  const result = resolve(root(node(x, [{ x: "(c) " }, { x: "Cancellation", s: "i" }, { x: "—(1) " },
    { x: "Bonds", s: "i" }, { x: "—(i) " }, { x: "Cancellation.", s: "i" }, { x: " Conditions follow:" }]), node("(A) First condition.")));
  assert.deepEqual(result.paragraphs.map(p => p.path), [["c", "1", "i"], ["c", "1", "i", "A"]]);
  assert.deepEqual(result.paragraphs[0].units.map(u => u.a), ["(c)", "(c)(1)", "(c)(1)(i)"]);
  assert.equal(result.unresolvedCount, 0);
});

test("italic Roman markers remain at the sixth level", () => {
  const previous = { blocks: [block("(i) First reason.", "(f)(7)(i)(C)(2)(i)")] };
  const result = resolve(root(node("(i) First reason."), node("(ii) Second reason.", [{ x: "(" }, { x: "ii", s: "i" }, { x: ") Second reason." }])), previous);
  assert.deepEqual(result.paragraphs[1].path, ["f", "7", "i", "C", "2", "ii"]);
});

test("an inline parent marker is retained before its following children", () => {
  const previous = { blocks: [block("(L) Prior item.", "(a)(3)(i)(L)"), block("(M) Old item.", "(a)(3)(i)(M)"), block("(A) New list item.", "(a)(3)(ii)(A)")] };
  const result = resolve(root(node("(L) Prior item."), node("(M) Old item. (ii) A new list:"), node("(A) New list item.")), previous);
  assert.equal(result.paragraphs[1].units.at(-1).a, "(a)(3)(ii)");
  assert.equal(result.paragraphs[1].text.slice(result.paragraphs[1].units.at(-1).s, result.paragraphs[1].units.at(-1).e), "(ii)");
});

test("unknown substantive XML fails before producing a partial record", () => {
  assert.throws(() => resolve(root(node("New regulatory content", [], "UNKNOWN"))), /Unsupported nonempty XML/);
});

test("italic prose followed by a citation is not a compound heading", () => {
  const x = "(iii) Choose from three options (i.e., (A), (B), or (C)).";
  const result = resolve(root(node(x, [{ x: "(iii) Choose from three options (" }, { x: "i.e.,", s: "i" }, { x: " (A), (B), or (C))." }])),
    { blocks: [block(x, "(c)(3)(iii)")] });
  assert.deepEqual(result.paragraphs[0].units.map(unit => unit.a), ["(c)(3)(iii)"]);
});

test("publisher duplicates have separate occurrences and require explicit source preservation", () => {
  const record = { id: "8:1.1", section: "1.1", blocks: [block("(a) First occurrence.", "(a)"), block("(a) Second occurrence.", "(a)")] };
  assert.throws(() => hierarchy.reconcile(record), /unreviewed repeated/);
  hierarchy.reconcile(record, null, null, { preserveSourceDuplicates: true });
  assert.equal(hierarchy.index(record).byPath.get("(a)").length, 2);
  assert.equal(hierarchy.scope(record, "(a)")[0].block.x, "(a) First occurrence.");
  assert.equal(hierarchy.scope(record, "(a)", [1])[0].block.x, "(a) Second occurrence.");
});

test("changed reserved ranges retain both citation endpoints", () => {
  const previous = { blocks: [{ t: "p", x: "(c)-(e) [Reserved].", a: "(e)",
    u: [{ a: "(c)", s: 0, e: 3 }, { a: "(e)", s: 4, e: 7 }] }] };
  const result = resolve(root(node("(c)-(e) [Reserved]"), node("(f) Following provision.")), previous);
  assert.equal(result.unresolvedCount, 0);
  assert.deepEqual(result.paragraphs[0].units, [{ a: "(c)", s: 0, e: 3 }, { a: "(e)", s: 4, e: 7 }]);
  assert.deepEqual(result.paragraphs[1].path, ["f"]);
});

test("compound reserved ranges preserve their parent and endpoint scopes", () => {
  const result = resolve(root(node("(a)(3)-(5) [Reserved]"), node("(6) Following provision.")));
  assert.equal(result.unresolvedCount, 0);
  assert.deepEqual(result.paragraphs[0].units.map(unit => unit.a), ["(a)", "(a)(3)", "(a)(5)"]);
  assert.deepEqual(result.paragraphs[1].path, ["a", "6"]);
  const record = { id: "8:1.1", section: "1.1", blocks: result.paragraphs.map(paragraph => ({
    t: "p", x: paragraph.text, a: hierarchy.address(paragraph.path), u: paragraph.units
  })) };
  hierarchy.reconcile(record);
  assert.equal(hierarchy.scope(record, "(a)(5)")[0].block.x, "(a)(3)-(5) [Reserved]");
});

test("changed dotted appendix headings retain verified visible numbering", () => {
  const previous = { blocks: [{ t: "h", x: "I. Prior heading", a: "(I.)", u: [{ a: "(I.)", s: 0, e: 2 }] }] };
  const result = resolve(root(node("I. Revised heading", [], "HD1")), previous);
  assert.equal(result.unresolvedCount, 0);
  assert.deepEqual(result.paragraphs[0].path, ["I."]);
  assert.deepEqual(result.paragraphs[0].units, [{ a: "(I.)", s: 0, e: 2 }]);
});

test("unverified dotted appendix numbering rejects ambiguous hierarchy", () => {
  const result = resolve(root(node("1. A new appendix requirement.")));
  assert.equal(result.paragraphs[0].addressable, false);
  assert.equal(result.unresolvedCount, 1);
});

test("changed publisher-local list text cannot become a regulatory paragraph", () => {
  const previous = { blocks: [block("(b) Definition.", "(b)"), { ...block("(1) Old local example."), c: "(b)", d: 4 }] };
  const result = resolve(root(node("(b) Definition."), node("(1) Revised local example.")), previous);
  assert.equal(result.paragraphs[1].addressable, false);
  assert.equal(result.unresolvedCount, 1);
});

test("a local list in another parent does not block an ordinary changed paragraph", () => {
  const previous = { blocks: [block("(a) Local list.", "(a)"), { ...block("(1) Example."), c: "(a)" },
    block("(b) Requirements.", "(b)"), block("(1) Old requirement.", "(b)(1)")] };
  const result = resolve(root(node("(b) Requirements."), node("(1) Revised requirement.")), previous);
  assert.equal(result.unresolvedCount, 0);
  assert.deepEqual(result.paragraphs[1].path, ["b", "1"]);
});
