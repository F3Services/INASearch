"use strict";
const assert = require("node:assert/strict");
const { parseExpressionAt } = require("acorn");

// Source-level unit checks should not depend on the next function's name.
module.exports = function functionSource(source, name) {
  const match = new RegExp(`(?:async )?function ${name}\\(`).exec(source);
  assert(match, `Could not find ${name} in the application source.`);
  const node = parseExpressionAt(source, match.index, { ecmaVersion: "latest" });
  return source.slice(node.start, node.end);
};
