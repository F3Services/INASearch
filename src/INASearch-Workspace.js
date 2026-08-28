(function (root, factory) {
  "use strict";
  const api = factory(root?.INA_SEARCH_COMMAND || (typeof require === "function" ? require("./INASearch-Command") : null));
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.INA_SEARCH_WORKSPACE = api;
})(typeof window !== "undefined" ? window : globalThis, function (commandApi) {
  "use strict";

  function normalizeEmptyView(value) {
    return ["ina", "cfr", "both"].includes(String(value || "").toLowerCase()) ? String(value).toLowerCase() : "ina";
  }

  function pane(id, command, authority, origin, mode = "hierarchy") {
    return {
      id,
      command,
      raw: command,
      authority,
      mode,
      origin,
      blankCompanion: origin === "blank-both",
      history: [],
      historyIndex: -1
    };
  }

  function blankWorkspaceSpec(value) {
    const preference = normalizeEmptyView(value);
    if (preference === "ina") return { preference, main: "", symmetricQuery: "", origin: "blank-single", panes: [pane("ina", "INA", "statute", "blank-single")] };
    if (preference === "cfr") return { preference, main: "", symmetricQuery: "", origin: "blank-single", panes: [pane("cfr", "CFR", "cfr", "blank-single")] };
    return {
      preference,
      main: "",
      symmetricQuery: "",
      origin: "blank-both",
      panes: [pane("ina", "INA", "statute", "blank-both"), pane("cfr", "CFR", "cfr", "blank-both")]
    };
  }

  function authorityScopedExpression(query, authority) {
    const input = String(query || "").trim();
    if (!input) return authority === "cfr" ? "CFR" : "INA";
    if (/\bin:(?:ina|usc|statute|cfr)\b/i.test(input)) return input;
    return `${authority === "cfr" ? "in:CFR" : "in:INA"} ${input}`;
  }

  function dualSearchWorkspace(query, options = {}) {
    const raw = String(query || "");
    const common = options.common || null;
    const panes = [
      pane("ina", authorityScopedExpression(raw, "statute"), "statute", "dual-search", "search-tree"),
      pane("cfr", authorityScopedExpression(raw, "cfr"), "cfr", "dual-search", "search-tree")
    ];
    panes.forEach(item => { item.sharedQuery = raw; item.common = common; item.blankCompanion = false; });
    return { main: raw, symmetricQuery: raw, origin: "dual-search", panes };
  }

  function standalonePaneExpression(paneState) {
    return String(paneState?.command ?? paneState?.raw ?? "").trim();
  }

  function panesRemainSymmetricDualSearch(workspace) {
    if (workspace?.origin !== "dual-search" || workspace.panes?.length !== 2) return false;
    const [left, right] = workspace.panes;
    if (left.authority !== "statute" || right.authority !== "cfr" || left.mode !== "search-tree" || right.mode !== "search-tree") return false;
    return left.sharedQuery === workspace.symmetricQuery && right.sharedQuery === workspace.symmetricQuery;
  }

  function composeWorkspaceExpression(workspace) {
    const panes = workspace?.panes || [];
    if (!panes.length) return "";
    if (workspace.origin === "blank-both" && panes.every(item => item.mode === "hierarchy" && ["INA", "CFR"].includes(standalonePaneExpression(item)))) return "";
    if (panesRemainSymmetricDualSearch(workspace)) return String(workspace.symmetricQuery || workspace.main || "");
    return panes.map(standalonePaneExpression).filter(Boolean).join(", ");
  }

  function updatePaneCommand(workspace, paneId, command, patch = {}) {
    const next = {
      ...workspace,
      panes: (workspace?.panes || []).map(item => item.id === paneId
        ? { ...item, ...patch, command: String(command || ""), raw: String(patch.raw ?? command ?? ""), sharedQuery: null, blankCompanion: item.blankCompanion && patch.preserveBlankCompanion === true }
        : item)
    };
    next.main = composeWorkspaceExpression(next);
    return next;
  }

  function shouldCloseBlankCompanion(workspace, paneId, destinationMode, preference) {
    if (preference !== true || workspace?.origin !== "blank-both" || destinationMode !== "reader") return false;
    const active = (workspace.panes || []).find(item => item.id === paneId);
    const companions = (workspace.panes || []).filter(item => item.id !== paneId);
    return Boolean(active?.blankCompanion && companions.length === 1 && companions[0].blankCompanion && companions[0].mode === "hierarchy");
  }

  function openBlankHierarchyDestination(workspace, paneId, command, options = {}) {
    let next = updatePaneCommand(workspace, paneId, command, { mode: "reader", preserveBlankCompanion: true });
    if (shouldCloseBlankCompanion(workspace, paneId, "reader", options.closeBlankCompanion === true)) {
      next = { ...next, panes: next.panes.filter(item => item.id === paneId), origin: "promoted-blank-reader" };
      next.main = standalonePaneExpression(next.panes[0]);
    }
    return next;
  }

  function promoteLastPane(workspace) {
    const panes = workspace?.panes || [];
    if (panes.length !== 1) return { promoted: false, workspace };
    const source = panes[0];
    return {
      promoted: true,
      workspace: {
        ...workspace,
        origin: "single",
        main: standalonePaneExpression(source),
        panes: [{ ...source, promoted: true }],
        promotedState: {
          command: source.command,
          raw: source.raw,
          history: source.history,
          historyIndex: source.historyIndex,
          readerState: source.readerState,
          searchState: source.searchState,
          scroll: source.scroll,
          focus: source.focus
        }
      }
    };
  }

  function parseWorkspace(value, options = {}) {
    if (!commandApi?.parseWorkspaceCommands) return { ok: false, status: "invalid", errors: [{ code: "command-runtime-missing", message: "The command runtime is unavailable." }] };
    return commandApi.parseWorkspaceCommands(value, options);
  }

  return {
    authorityScopedExpression,
    blankWorkspaceSpec,
    composeWorkspaceExpression,
    dualSearchWorkspace,
    normalizeEmptyView,
    openBlankHierarchyDestination,
    pane,
    panesRemainSymmetricDualSearch,
    parseWorkspace,
    promoteLastPane,
    shouldCloseBlankCompanion,
    standalonePaneExpression,
    updatePaneCommand
  };
});
