/* Shared disposition rules for the build-time index and hydrated reader. */
(() => {
  "use strict";
  const LABELS = Object.freeze({ current: "Current", repealed: "Repealed", transferred: "Transferred", omitted: "Omitted" });

  function normalize(section) {
    const value = typeof section === "string" ? section : section?.status || String(section?.title || "").match(/^(repealed|transferred|omitted)\b/i)?.[1] || "current";
    const key = String(value).toLowerCase();
    return Object.hasOwn(LABELS, key) ? key : "current";
  }

  function label(value) { return LABELS[normalize(value)]; }

  function dispositionBadge(value) {
    const label = String(value || "").trim();
    const statuses = new Set(label.toLowerCase().match(/\b(?:repealed|omitted|transferred)\b/g) || []);
    const status = ["repealed", "omitted", "transferred"].find(key => statuses.has(key));
    return status ? { label, status } : null;
  }

  function aggregateSections(sections) {
    if (!sections?.length) return "";
    const first = normalize(sections[0]);
    return first !== "current" && sections.every(section => normalize(section) === first) ? first : "";
  }

  function aggregateTree(node, getChildren) {
    const children = getChildren(node) || [];
    if (!children.length) return normalize(node);
    const first = aggregateTree(children[0], getChildren);
    return first && first !== "current" && children.every(child => aggregateTree(child, getChildren) === first) ? first : "";
  }

  const api = Object.freeze({ normalize, label, dispositionBadge, aggregateSections, aggregateTree });
  globalThis.INASearchStatuteStatus = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
