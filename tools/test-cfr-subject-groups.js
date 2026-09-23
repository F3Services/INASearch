#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const acorn = require("acorn");
const commands = require("../src/INASearch-Command");
const source = fs.readFileSync("src/INASearch.template.html", "utf8");
const box = { window: {} };
vm.runInNewContext(fs.readFileSync("src/INASearch-CFR.js", "utf8"), box);
const nodes = new Map();
const context = {
  corpus: { cfr: box.window.INA_SEARCH_CFR }, authorityHierarchyNodes: nodes,
  hierarchyLeafByReader: new Map(), cfrPartHierarchyNode: new Map(), inaMap: new Map(),
  INA_SOURCE_URL: "https://www.uscis.gov", statuteStatus: () => "current",
  state: { hierarchyExpanded: new Set() }
};
const names = ["normalize", "normCitationPart", "escapeHtml", "titleCaseTopic", "navigationTitleCase", "hierarchyUnitKind", "hierarchyNodeId", "createHierarchyNode", "hierarchySourceHeading", "buildAuthorityHierarchies", "hierarchyNodeAncestors", "hierarchyOfficialUrl", "hierarchyNodeCitation", "hierarchyBrowseResult", "hierarchyDescendants", "hierarchyUnitMatches", "hierarchyResultForUnits", "namedHierarchyUnits", "parseCfrHierarchy", "hierarchyRowCitation", "hierarchyRowHeading", "hierarchyStatusBadge", "hierarchyStatusReplacesHeading", "renderHierarchyRows", "paneHierarchyRows", "hierarchyNavigationSegments", "hierarchyChildNavigationSegment"];
const declarations = names.map(name => {
  const start = source.indexOf(`function ${name}(`);
  assert(start >= 0, name);
  return source.slice(start, acorn.parseExpressionAt(source, start, { ecmaVersion: "latest" }).end);
});
const api = vm.runInNewContext(`${declarations.join("\n")}\nbuildAuthorityHierarchies(); ({${names.join(",")}})`, context);
const groups = [...nodes.values()].filter(node => node.kind === "subject-group");
assert.equal(groups.length, 177);
const counts = {};
for (const group of groups) {
  const title = api.hierarchyNodeAncestors(group).find(node => node.kind === "title").number;
  counts[title] = (counts[title] || 0) + 1;
  assert(group.heading && !/ECFR[\da-f]+/i.test(group.heading));
  const query = api.hierarchyNodeCitation(group);
  assert.equal(api.parseCfrHierarchy(title, query.replace(/^\d+ CFR\s*/, "")).hierarchyNodeId, group.id, query);
  assert.equal(commands.scanCommandSegments(query).segments.length, 1, query);
  assert.equal(commands.scanCommandSegments(`${query}, 8 CFR`).segments.length, 2, query);
  const parent = nodes.get(group.parentId);
  const legacy = `${api.hierarchyNodeCitation(parent)} Subject-Group ${group.number}`;
  assert.equal(api.parseCfrHierarchy(title, legacy.replace(/^\d+ CFR\s*/, "")).hierarchyNodeId, group.id);
  assert(api.hierarchyOfficialUrl(group).endsWith(`/subject-group-${group.number}`));
  const label = api.hierarchyRowCitation(group);
  assert.equal(label, api.navigationTitleCase(group.heading));
  for (const html of [api.renderHierarchyRows([group.id]), api.paneHierarchyRows([group.id])]) {
    const text = html.replace(/<[^>]*>/g, "");
    assert(!text.includes(group.number), text);
    assert(!/aria-label="[^"]*ECFR/i.test(html));
    const buttonText = html.match(/<button[^>]*data-(?:pane-)?hierarchy-open=[^>]*>([\s\S]*?)<\/button>/)[1].replace(/<[^>]*>/g, "");
    assert.equal(buttonText, api.escapeHtml(label), "Show each topic heading once");
  }
  const segment = api.hierarchyNavigationSegments(group).at(-1);
  assert.equal(segment.label, "Topic");
  assert.equal(segment.value, label);
  assert(!JSON.stringify(segment.options.map(({ value, description }) => ({ value, description }))).includes(group.number));
  const childMenu = api.hierarchyChildNavigationSegment(parent);
  if (childMenu) assert(childMenu.options.some(option => option.nodeId === group.id && option.value === label));
}
assert.equal(api.parseCfrHierarchy(20, "655.B (Not a real topic)").valid, false);
assert.equal(api.parseCfrHierarchy(20, "655.B").valid, true);
console.log("PASS CFR subject headings: 177 query round trips, legacy links, main/split lists, navigation labels, comma-safe commands, and official group URLs", counts);
