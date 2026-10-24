#!/usr/bin/env node
"use strict";
// Minimum security releases for CVE-2026-111497. Admit only supported lines;
// review this table when adopting another Node major.
const minimum = new Map([[22, [23, 4]], [24, [22, 1]], [26, [12, 1]]]);
function isSupportedNode(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) return false;
  const [major, minor, patch] = version.split(".").map(Number);
  const floor = minimum.get(major);
  return Boolean(floor && (minor > floor[0] || minor === floor[0] && patch >= floor[1]));
}
function assertSupportedNode() {
  if (!isSupportedNode(process.versions.node)) throw new Error("Use a patched supported Node.js release: 22.23.4+, 24.22.1+, or 26.12.1+ (within those major versions).");
}
assertSupportedNode();
if (require.main === module) console.log("PASS patched Node.js preflight");
module.exports = { isSupportedNode, assertSupportedNode };
