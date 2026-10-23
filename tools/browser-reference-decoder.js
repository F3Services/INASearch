"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { parseExpressionAt } = require("acorn");

// Build-time delivery checks must use the reader's actual decoder, including
// its URL spelling and fallback notices. Do not maintain another decoder here.
function createBrowserReferenceDecoder(template = fs.readFileSync(path.join(__dirname, "../src/INASearch.template.html"), "utf8")) {
  const context = vm.createContext({ hydratedLegalReferenceRoots: new WeakSet() });
  for (const name of ["canonicalPath", "componentTokens", "houseSectionUrl", "expandPackedHouseHref", "hydrateLegalReferences"]) {
    const match = new RegExp(`\\bfunction ${name}\\(`).exec(template);
    if (!match) throw new Error(`The delivery check cannot find the browser ${name} function.`);
    const declaration = parseExpressionAt(template, match.index, { ecmaVersion: "latest" });
    vm.runInContext(template.slice(declaration.start, declaration.end), context);
  }
  return (target, text) => {
    const source = { text, _lr: { t: [[1, 0, text.length, 0]] } };
    context.hydrateLegalReferences(source, { legalReferencePacking: { legalTargets: [target] } });
    return structuredClone(source.references[0]);
  };
}

module.exports = { createBrowserReferenceDecoder };
