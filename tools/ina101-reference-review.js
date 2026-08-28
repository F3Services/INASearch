"use strict";

const crypto = require("crypto");
const { statuteRunInPathMarkers } = require("./statute-run-ins");

const SEQUENCE_PATTERN = /(?:\([A-Za-z0-9-]+\))+/g;

function pathIdentity(path) {
  return (path || []).map(token => `${String(token).length}:${String(token)}`).join("|");
}

function structuralPathExists(section, targetPath) {
  let nodes = section?.body || [];
  for (const token of targetPath || []) {
    const node = nodes.find(item => String(item.label).toLowerCase() === String(token).toLowerCase());
    if (!node) return false;
    nodes = node.children || [];
  }
  return true;
}

function localUscTargetExists(corpus, reference) {
  if (reference.family !== "usc" || reference.resolution !== "local" || String(reference.targetTitle) !== "8") return false;
  const section = (corpus?.title8?.sections || []).find(item => String(item.section) === String(reference.targetSection));
  if (!section) return false;
  if (!(reference.targetPath || []).length || structuralPathExists(section, reference.targetPath)) return true;
  const runIns = new Set((section.runInPaths || []).map(pathIdentity));
  return runIns.has(pathIdentity(reference.targetPath));
}

function targetLabel(reference) {
  const path = (reference.targetPath || []).length ? `/${reference.targetPath.join("/")}` : "";
  if (reference.family === "usc") return `USC ${reference.targetTitle}:${reference.targetSection}${path}`;
  if (reference.family === "statutes-at-large") return `STAT ${reference.targetVolume}:${reference.targetPage}${path}`;
  if (reference.family === "public-law") return `PL ${reference.targetCongress}-${reference.targetLaw}${path}`;
  return `${String(reference.family || "unknown").toUpperCase()} ${reference.targetTitle || ""}:${reference.targetSection || ""}${path}`;
}

function ina101ParentheticalReferenceReview(corpus) {
  const section = (corpus?.title8?.sections || []).find(item => String(item.section) === "1101");
  if (!section) throw new Error("The INA 101 review cannot find 8 U.S.C. 1101.");
  const rows = [];
  const operativeSource = [];
  const counts = { reference: 0, "run-in": 0, annotation: 0 };
  const runInIdentities = new Set((section.runInPaths || []).map(pathIdentity));

  const walk = (nodes, parentPath = []) => {
    for (const node of nodes || []) {
      const sourcePath = [...parentPath, String(node.label)];
      const text = String(node.text || "");
      const references = node.references || [];
      const runInMarkers = statuteRunInPathMarkers(section, node, sourcePath);
      operativeSource.push(`${sourcePath.join("/")}\0${text}`);
      for (const match of text.matchAll(SEQUENCE_PATTERN)) {
        const start = match.index;
        const end = start + match[0].length;
        const overlappingReferences = references.filter(reference => reference.start < end && reference.end > start);
        const containedRunIns = runInMarkers.filter(marker => marker.start >= start && marker.end <= end);
        if (overlappingReferences.length && containedRunIns.length) throw new Error(`INA 101 ${sourcePath.join("/")} ${match[0]} is both a reference and a run-in marker.`);
        let disposition;
        let links;
        if (overlappingReferences.length) {
          disposition = "reference";
          links = overlappingReferences.map(reference => {
            if (text.slice(reference.start, reference.end) !== reference.text) throw new Error(`INA 101 ${sourcePath.join("/")} has a reference with a stale source span.`);
            if (reference.resolution === "local" && !localUscTargetExists(corpus, reference)) throw new Error(`INA 101 ${sourcePath.join("/")} ${reference.text} has a missing local target.`);
            if (reference.resolution !== "local" && !reference.officialUrl) throw new Error(`INA 101 ${sourcePath.join("/")} ${reference.text} has no official-source target.`);
            return `${reference.start}:${reference.end} ${JSON.stringify(reference.text)} -> ${targetLabel(reference)} [${reference.resolution};${reference.ruleId}]`;
          }).join(" || ");
        } else if (containedRunIns.length) {
          disposition = "run-in";
          links = containedRunIns.map(marker => {
            if (!runInIdentities.has(pathIdentity(marker.path)) && !structuralPathExists(section, marker.path)) throw new Error(`INA 101 ${sourcePath.join("/")} ${marker.address} has a missing run-in target.`);
            return `${marker.start}:${marker.end} ${marker.address} -> RUN-IN ${marker.path.join("/")}`;
          }).join(" || ");
        } else if (match[0] === "(NATO)") {
          disposition = "annotation";
          links = "Parenthetical abbreviation; intentionally not linked.";
        } else {
          throw new Error(`INA 101 ${sourcePath.join("/")} ${match[0]} is not classified as a working reference, a run-in marker, or a reviewed noncitation.`);
        }
        counts[disposition] += 1;
        rows.push([sourcePath.join("/"), start, match[0], disposition, links].join("\t"));
      }
      walk(node.children, sourcePath);
    }
  };
  walk(section.body);

  const operativeTextSha256 = crypto.createHash("sha256").update(operativeSource.join("\n")).digest("hex");
  return [
    "# INA 101 parenthetical-reference review manifest",
    "# Manually target-reviewed 2026-08-23. Scope: every parenthetical sequence in the operative body of 8 U.S.C. 1101.",
    "# The annotation row is deliberately non-navigable; every other row identifies one or more working legal-reference or run-in links.",
    `# operative-text-sha256: ${operativeTextSha256}`,
    `# counts: reference=${counts.reference} run-in=${counts["run-in"]} annotation=${counts.annotation} total=${rows.length}`,
    "source_path\tstart\tsequence\tdisposition\tlinks",
    ...rows
  ].join("\n") + "\n";
}

module.exports = { ina101ParentheticalReferenceReview };
