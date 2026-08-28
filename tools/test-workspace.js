#!/usr/bin/env node
"use strict";

const assert = require("assert");
const workspace = require("../src/INASearch-Workspace");

assert.deepStrictEqual(workspace.blankWorkspaceSpec("ina").panes.map(item => item.command), ["INA"]);
assert.deepStrictEqual(workspace.blankWorkspaceSpec("cfr").panes.map(item => item.command), ["CFR"]);
const both = workspace.blankWorkspaceSpec("both");
assert.deepStrictEqual(both.panes.map(item => item.command), ["INA", "CFR"]);
assert.strictEqual(workspace.composeWorkspaceExpression(both), "");

const retained = workspace.openBlankHierarchyDestination(both, "ina", "INA 101", { closeBlankCompanion: false });
assert.strictEqual(retained.main, "INA 101, CFR");
assert.strictEqual(retained.panes.length, 2);
const closed = workspace.openBlankHierarchyDestination(both, "ina", "INA 101", { closeBlankCompanion: true });
assert.strictEqual(closed.main, "INA 101");
assert.strictEqual(closed.panes.length, 1);
assert.strictEqual(workspace.shouldCloseBlankCompanion(workspace.dualSearchWorkspace("the term"), "ina", "reader", true), false);

const dual = workspace.dualSearchWorkspace('"the term"');
assert.strictEqual(dual.main, '"the term"');
assert.deepStrictEqual(dual.panes.map(item => item.command), ['in:INA "the term"', 'in:CFR "the term"']);
assert.strictEqual(workspace.composeWorkspaceExpression(dual), '"the term"');
const diverged = workspace.updatePaneCommand(dual, "ina", "INA 101", { mode: "reader" });
assert.strictEqual(diverged.main, 'INA 101, in:CFR "the term"');

const source = { ...workspace.pane("ina", "INA 101", "statute", "manual", "reader"), history: [{ command: "INA" }], historyIndex: 0, scroll: 40, focus: "search" };
const promoted = workspace.promoteLastPane({ main: "INA 101", origin: "manual", panes: [source] });
assert.strictEqual(promoted.promoted, true);
assert.strictEqual(promoted.workspace.promotedState.history, source.history);
assert.strictEqual(promoted.workspace.promotedState.scroll, 40);

console.log("Workspace compositor tests passed.");
