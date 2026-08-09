"use strict";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function slug(value) {
  return String(value || "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "term";
}

function quotedTermsFromDefinition(text) {
  const value = String(text || "");
  const lead = value.match(/\bthe terms?\s+([\s\S]+?)\s+(?:means?|has reference to|includes?|shall(?:\s+not)?\s+include|do(?:es)?\s+not\s+include)\b/i);
  if (!lead) return [];
  return [...lead[1].matchAll(/[“"]([^”"]+)[”"]/g)]
    .map(match => match[1].trim().replace(/[,:;.]$/, ""))
    .filter(Boolean);
}

function inaScopeForPath(path) {
  if (path[0] === "a") return "ina-chapter";
  if (path[0] === "b") return "ina-subchapters-i-ii";
  if (path[0] === "c") return "ina-subchapter-iii";
  if (path[0] === "h") return "ina-212-a-2-e";
  return null;
}

function citationSuffix(path) {
  return path.map(part => `(${part})`).join("");
}

function deriveInaEntries(corpus, definitionSource) {
  const section = (corpus.title8?.sections || []).find(item => String(item.section) === "1101");
  if (!section) throw new Error("Cannot build INA 101 definitions without 8 U.S.C. 1101.");
  const entries = [];
  const source = definitionSource.sources.ina101;
  const specificScopes = definitionSource.inaSpecificScope || {};

  function addEntry(node, path, terms, text = node.text, children = node.children || [], suffix = "") {
    const scopeId = inaScopeForPath(path);
    if (!scopeId || !terms.length) return;
    const pathKey = path.join(".");
    const citeSuffix = citationSuffix(path);
    entries.push({
      id: `ina-101-${path.map(slug).join("-")}${suffix}`,
      term: terms.join(" / "),
      aliases: terms,
      text,
      children: clone(children),
      references: clone(node.references || []),
      sourceFamily: "ina",
      sourceCategory: "law",
      sourceFilter: scopeId === "ina-chapter" ? "ina-101-a" : scopeId === "ina-subchapters-i-ii" ? "ina-101-b" : scopeId === "ina-subchapter-iii" ? "ina-101-c" : "ina-101-h",
      scopeId,
      scopeCategory: "law",
      sourcePriority: 1,
      citation: `INA 101${citeSuffix}`,
      uscCitation: `8 U.S.C. 1101${citeSuffix}`,
      path: clone(path),
      locator: `INA 101${citeSuffix} / 8 U.S.C. 1101${citeSuffix}`,
      url: source.url,
      captureDate: source.capturedAt,
      resource: source.name,
      specificScope: specificScopes[pathKey] || ""
    });
  }

  function walk(nodes, parentPath = []) {
    for (const node of nodes || []) {
      const path = [...parentPath, String(node.label || "")];
      if (/\bthe terms?\s+[“"]/i.test(node.text || "")) {
        if (path.join(".") === "a.37") {
          const sentences = String(node.text).match(/[^.]+\.(?:\s+|$)/g) || [node.text];
          addEntry(node, path, ["totalitarian party"], sentences[0].trim(), [], "-party");
          addEntry(node, path, ["totalitarian dictatorship", "totalitarianism"], sentences.slice(1).join(" ").trim(), [], "-systems");
        } else {
          addEntry(node, path, quotedTermsFromDefinition(node.text));
        }
      }
      walk(node.children, path);
    }
  }
  walk(section.body);
  return entries;
}

function buildDefinitionCatalog(corpus, definitionSource, glossarySource = null) {
  const definitions = clone(definitionSource);
  const cfrSource = definitions.sources.cfr1_2;
  const cfrEntries = definitions.cfrEntries.map((entry, index) => ({
    ...entry,
    id: `8-cfr-1-2-${String(index + 1).padStart(2, "0")}-${slug(entry.term)}`,
    sourceFamily: "cfr",
    sourceCategory: "law",
    sourceFilter: "8-cfr-1-2",
    scopeId: "cfr-chapter-i",
    scopeCategory: "law",
    sourcePriority: 1,
    citation: "8 CFR 1.2",
    locator: `8 CFR 1.2 — ${entry.term}`,
    url: cfrSource.url,
    captureDate: cfrSource.capturedAt,
    resource: cfrSource.name,
    children: []
  }));
  const glossary = glossarySource && Array.isArray(glossarySource.entries) ? glossarySource : null;
  const glossaryEntries = (glossary?.entries || []).map((entry, index) => ({
    ...entry,
    id: `uscis-glossary-${String(index + 1).padStart(3, "0")}-${slug(entry.term)}`,
    sourceFamily: "uscis-glossary",
    sourceCategory: "policy",
    sourceFilter: "uscis-glossary",
    scopeId: "uscis-policy",
    scopeCategory: "policy",
    sourcePriority: 0,
    citation: "USCIS Glossary",
    locator: `USCIS Glossary — ${entry.term}`,
    url: glossary.source.url,
    captureDate: glossary.source.capturedAt,
    resource: glossary.source.name,
    children: []
  }));
  delete definitions.cfrEntries;
  delete definitions.inaSpecificScope;
  if (glossary) {
    definitions.sources.uscisGlossary = clone(glossary.source);
    definitions.glossaryVerification = clone(glossary.verification);
  }
  definitions.scopes = [
    ...(glossary ? [{
      id: "uscis-policy",
      sourceFilter: "uscis-glossary",
      category: "policy",
      label: "USCIS Policy",
      sourceLabel: "USCIS Glossary",
      text: "You can use this dictionary to quickly look up a definition or explanation for a topic.",
      context: "USCIS presents the glossary as an online dictionary that is separate from its A-Z Index."
    }] : []),
    ...definitions.scopes.map(scope => ({ ...scope, category: "law" }))
  ];
  definitions.entries = [...glossaryEntries, ...deriveInaEntries(corpus, definitionSource), ...cfrEntries];
  definitions.sourceFilters = [
    { id: "all", label: "All sources" },
    ...(glossary ? [{ id: "uscis-glossary", label: "USCIS Glossary" }] : []),
    { id: "law", label: "Law" },
    { id: "ina-statute", label: "Statute", parentId: "law" },
    { id: "ina-101-a", label: "INA 101(a)", parentId: "ina-statute" },
    { id: "ina-101-b", label: "INA 101(b)", parentId: "ina-statute" },
    { id: "ina-101-c", label: "INA 101(c)", parentId: "ina-statute" },
    { id: "ina-101-h", label: "INA 101(h)", parentId: "ina-statute" },
    { id: "8-cfr-1-2", label: "Regulation (8 CFR 1.2)", parentId: "law" }
  ];
  definitions.scopeFilters = [
    { id: "all", label: "All applicability scopes" },
    ...(glossary ? [{ id: "uscis-policy", label: "USCIS Policy" }] : []),
    { id: "law", label: "Law" },
    { id: "ina-any", label: "Statute (Any part of INA)", parentId: "law" },
    ...definitions.scopes.filter(scope => scope.category === "law").map(scope => ({
      id: scope.id,
      label: scope.label,
      parentId: scope.id.startsWith("ina-") ? "ina-any" : "law"
    }))
  ];
  return definitions;
}

module.exports = { buildDefinitionCatalog, deriveInaEntries, quotedTermsFromDefinition };
