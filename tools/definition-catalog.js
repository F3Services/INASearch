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

function sourceTextFragmentUrl(url, text) {
  const base = String(url || "").split("#", 1)[0];
  return `${base}#:~:text=${encodeURIComponent(String(text || ""))}`;
}

const definitionVerbPattern = /\b(?:shall\s+be\s+deemed\s+to\s+mean|shall\s+be\s+defined\s+by\s+reference|shall\s+not\s+include|shall\s+mean|does?\s+not\s+include|do\s+not\s+include|has\s+reference\s+to|has\s+the\s+same\s+meaning|have\s+the\s+same\s+meaning|has\s+the\s+meaning|have\s+the\s+meanings?|is\s+defined\s+as|means?|includes?|refers?\s+to)\b/gi;
const scopeLeadPattern = /\b(?:[Ff]or (?:the )?purposes of|[Aa]s used in|In this (?=chapter|subchapter|section|subsection|paragraph|subparagraph|clause|subclause)|In (?=subsections?|paragraphs?|subparagraphs?|clauses?|subclauses?\s*\())/g;

function cleanedDefinitionTerm(value) {
  return String(value || "").trim().replace(/[,:;.]$/, "");
}

function latestScopeLeadStart(value, end = String(value || "").length) {
  const prefix = String(value || "").slice(0, end);
  const pattern = new RegExp(scopeLeadPattern.source, "g");
  let match;
  let start = -1;
  while ((match = pattern.exec(prefix))) start = match.index;
  return start;
}

function definitionStatementGroups(text, hasChildren = false) {
  const value = String(text || "");
  const leads = [...value.matchAll(/\bthe terms?\b/gi)];
  const boundaryGroups = new Map();
  for (const lead of leads) {
    const quotePattern = /[“"]([^”"]+)[”"]/g;
    quotePattern.lastIndex = lead.index + lead[0].length;
    const firstQuote = quotePattern.exec(value);
    if (!firstQuote || firstQuote.index - lead.index > 80) continue;

    const verbPattern = new RegExp(definitionVerbPattern.source, "gi");
    verbPattern.lastIndex = firstQuote.index + firstQuote[0].length;
    let verb = verbPattern.exec(value);
    if (verb && /[.!?]\s/.test(value.slice(firstQuote.index + firstQuote[0].length, verb.index))) verb = null;
    const definitionStart = verb ? verb.index + verb[0].length : firstQuote.index + firstQuote[0].length;
    const separatorMatch = hasChildren ? value.slice(definitionStart).match(/[—:]/) : null;
    const separatorIndex = separatorMatch ? definitionStart + separatorMatch.index : -1;
    const structural = separatorIndex >= 0;
    if (!verb && !structural) continue;

    const boundaryStart = verb ? verb.index : separatorIndex;
    const boundaryKey = `${verb ? "verb" : "separator"}:${boundaryStart}`;
    const terms = [];
    quotePattern.lastIndex = lead.index + lead[0].length;
    let quote;
    while ((quote = quotePattern.exec(value)) && quote.index < boundaryStart) {
      const term = cleanedDefinitionTerm(quote[1]);
      if (term && !terms.some(candidate => candidate.toLowerCase() === term.toLowerCase())) terms.push(term);
    }
    if (!terms.length) continue;
    const existing = boundaryGroups.get(boundaryKey) || { start: lead.index, boundaryStart, structural, separatorIndex, terms: [] };
    existing.start = Math.min(existing.start, lead.index);
    if (structural) existing.separatorIndex = separatorIndex;
    for (const term of terms) if (!existing.terms.some(candidate => candidate.toLowerCase() === term.toLowerCase())) existing.terms.push(term);
    boundaryGroups.set(boundaryKey, existing);
  }

  const byTerms = new Map();
  for (const group of boundaryGroups.values()) {
    const signature = [...group.terms].map(term => term.toLowerCase()).sort().join("\u0000");
    const existing = byTerms.get(signature);
    if (!existing) byTerms.set(signature, { ...group });
    else {
      existing.start = Math.min(existing.start, group.start);
      existing.boundaryStart = Math.max(existing.boundaryStart, group.boundaryStart);
      existing.structural ||= group.structural;
      if (group.structural) existing.separatorIndex = group.separatorIndex;
    }
  }

  const groups = [...byTerms.values()].sort((left, right) => left.start - right.start);
  for (const group of groups) {
    const scopeStart = latestScopeLeadStart(value, group.start);
    const prefix = value.slice(0, group.start).trimStart();
    const sentenceBoundary = Math.max(
      value.lastIndexOf(". ", group.start - 1),
      value.lastIndexOf("! ", group.start - 1),
      value.lastIndexOf("? ", group.start - 1)
    );
    const sentenceStart = sentenceBoundary >= 0 ? sentenceBoundary + 2 : 0;
    if (/^except as provided\b/i.test(prefix)) group.statementStart = 0;
    else group.statementStart = scopeStart >= sentenceStart ? scopeStart : group.start;
  }
  for (let index = 0; index < groups.length; index++) {
    const group = groups[index];
    group.statementEnd = index + 1 < groups.length ? groups[index + 1].statementStart : value.length;
    const raw = value.slice(group.statementStart, group.statementEnd);
    const leading = raw.match(/^\s*/)?.[0].length || 0;
    const trailing = raw.match(/\s*$/)?.[0].length || 0;
    group.textStart = group.statementStart + leading;
    group.textEnd = group.statementEnd - trailing;
    group.text = value.slice(group.textStart, group.textEnd);
    group.childInsertionOffset = group.structural ? group.separatorIndex + 1 - group.textStart : null;
  }
  return groups;
}

function quotedTermsFromDefinition(text) {
  return definitionStatementGroups(text).flatMap(group => group.terms)
    .filter((term, index, terms) => terms.findIndex(candidate => candidate.toLowerCase() === term.toLowerCase()) === index);
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

function pathKey(path) {
  return path.map(part => slug(part)).join("-");
}

function inaCitation(inaSection, path = []) {
  return `INA ${inaSection}${citationSuffix(path)}`;
}

function sliceOffsetRecords(records, start, end) {
  return clone((records || []).filter(record => record.start >= start && record.end <= end).map(record => ({
    ...record,
    start: record.start - start,
    end: record.end - start
  })));
}

function sourceFilterForIna(inaSection, path) {
  if (String(inaSection) === "101" && ["a", "b", "c", "h"].includes(path[0])) return `ina-101-${path[0]}`;
  return `ina-${slug(inaSection)}`;
}

function explicitSectionTargets(scopeText, crosswalkByUsc) {
  const targets = [];
  const pattern = /\bsections?\s+(\d+[a-z]?)(\s*(?:\([^)]+\)\s*)*)\s+of this title/gi;
  let match;
  while ((match = pattern.exec(scopeText))) {
    const mapping = crosswalkByUsc.get(String(match[1]));
    if (!mapping) continue;
    const path = [...String(match[2] || "").matchAll(/\(([^)]+)\)/g)].map(item => item[1].trim());
    targets.push({ kind: "ina", inaSection: mapping.inaSection, path });
  }
  return targets;
}

function relativeUnitTargets(scopeText, currentPath) {
  const depths = { subsection: 0, paragraph: 1, subparagraph: 2, clause: 3, subclause: 4 };
  const targets = [];
  const pattern = /\b(subsections?|paragraphs?|subparagraphs?|clauses?|subclauses?)\s+((?:\s*\([A-Za-z0-9]+\)\s*(?:(?:,|and|or)\s*)?)+)/gi;
  let match;
  while ((match = pattern.exec(scopeText))) {
    const unit = match[1].toLowerCase().replace(/s$/, "");
    const depth = depths[unit];
    if (!Number.isInteger(depth)) continue;
    const tokens = [...match[2].matchAll(/\(([^)]+)\)/g)].map(item => item[1].trim());
    const listed = /\b(?:and|or)\b|,/.test(match[2]);
    const paths = listed ? tokens.map(token => [token]) : [tokens];
    for (const suffix of paths) targets.push({ kind: "relative", path: [...currentPath.slice(0, depth), ...suffix] });
  }
  return targets;
}

function dedupeScopeTargets(targets) {
  const seen = new Set();
  return targets.filter(target => {
    const key = target.kind === "ina"
      ? `ina:${target.inaSection}:${target.path.join(".")}`
      : `${target.kind}:${target.number || ""}:${(target.path || []).join(".")}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function resolveScopeTargets(scopeText, mapping, section, definitionPath, crosswalkByUsc) {
  const value = String(scopeText || "");
  const leadStart = latestScopeLeadStart(value);
  let targetText = leadStart >= 0 ? value.slice(leadStart) : value;
  const qualifierStart = targetText.search(/\b(?:except as|in the case|with respect to|including)\b/i);
  if (qualifierStart > 0) targetText = targetText.slice(0, qualifierStart);
  if (/\bthis chapter\b/i.test(targetText)) return [{ kind: "chapter" }];
  if (/\bthis subchapter\b/i.test(targetText)) {
    const number = (section.breadcrumb || []).find(item => item.kind === "subchapter")?.number || "";
    return [{ kind: "subchapter", number }];
  }
  const targets = [];
  if (/\bthis section\b/i.test(targetText)) targets.push({ kind: "ina", inaSection: mapping.inaSection, path: [] });
  if (/\bthis subsection\b/i.test(targetText)) targets.push({ kind: "ina", inaSection: mapping.inaSection, path: definitionPath.slice(0, 1) });
  if (/\bthis paragraph\b/i.test(targetText)) targets.push({ kind: "ina", inaSection: mapping.inaSection, path: definitionPath.slice(0, 2) });
  if (/\bthis subparagraph\b/i.test(targetText)) targets.push({ kind: "ina", inaSection: mapping.inaSection, path: definitionPath.slice(0, 3) });
  if (/\bthis clause\b/i.test(targetText)) targets.push({ kind: "ina", inaSection: mapping.inaSection, path: definitionPath.slice(0, 4) });
  if (/\bthis subclause\b/i.test(targetText)) targets.push({ kind: "ina", inaSection: mapping.inaSection, path: definitionPath.slice(0, 5) });
  targets.push(...explicitSectionTargets(targetText, crosswalkByUsc));
  for (const target of relativeUnitTargets(targetText, definitionPath)) targets.push({ kind: "ina", inaSection: mapping.inaSection, path: target.path });
  return dedupeScopeTargets(targets);
}

function scopeTargetKey(target) {
  if (target.kind === "chapter") return "chapter";
  if (target.kind === "subchapter") return `subchapter-${slug(target.number)}`;
  return `${slug(target.inaSection)}${target.path.length ? `-${pathKey(target.path)}` : ""}`;
}

function scopeTargetCitation(target) {
  if (target.kind === "chapter") return "Entire INA";
  if (target.kind === "subchapter") return `INA subchapter ${target.number}`;
  return inaCitation(target.inaSection, target.path);
}

function scopeRecordForTargets(targets, scopeContext) {
  if (targets.length === 1 && targets[0].kind === "chapter") return {
    id: "ina-chapter",
    label: "Entire INA",
    sourceLabel: scopeContext.sourceCitation,
    text: scopeContext.text,
    targets: clone(targets)
  };
  if (targets.length === 1 && targets[0].kind === "subchapter") return {
    id: `ina-subchapter-${slug(targets[0].number)}`,
    label: `INA subchapter ${targets[0].number}`,
    sourceLabel: scopeContext.sourceCitation,
    text: scopeContext.text,
    targets: clone(targets)
  };
  const citations = targets.map(scopeTargetCitation);
  const id = targets.length === 1 ? `ina-${scopeTargetKey(targets[0])}` : `ina-scope-${targets.map(scopeTargetKey).join("--")}`;
  return {
    id,
    label: `${citations.join(" and ")} only`,
    sourceLabel: scopeContext.sourceCitation,
    text: scopeContext.text,
    targets: clone(targets)
  };
}

function directScopeContext(nodeText, group, citation) {
  const value = String(nodeText || "");
  if (group.statementStart < group.start) return {
    text: value.slice(group.statementStart, group.start).trim().replace(/[,:;—\s]+$/, ""),
    sourceCitation: citation
  };
  const header = value.slice(group.start, group.boundaryStart);
  const embedded = header.match(/\bas used in\s+(?:this\s+)?(?:chapter|subchapter|section|subsection|paragraph|subparagraph|clause|subclause)\b[\s\S]*$/i);
  return embedded ? { text: embedded[0].trim().replace(/[,:;—\s]+$/, ""), sourceCitation: citation } : null;
}

function inheritedScopeContext(section, mapping, ancestors) {
  for (let index = ancestors.length - 1; index >= 0; index--) {
    const ancestor = ancestors[index];
    const start = latestScopeLeadStart(ancestor.node.text || "");
    if (start < 0) continue;
    return {
      text: String(ancestor.node.text).slice(start).trim().replace(/[,:;—\s]+$/, ""),
      sourceCitation: inaCitation(mapping.inaSection, ancestor.path)
    };
  }
  const preambleStart = latestScopeLeadStart(section.preamble || "");
  if (preambleStart >= 0) return {
    text: String(section.preamble).slice(preambleStart).trim().replace(/[,:;—\s]+$/, ""),
    sourceCitation: inaCitation(mapping.inaSection)
  };
  return null;
}

function deriveInaCatalog(corpus, definitionSource) {
  const mappings = (corpus.inaCrosswalk || []).filter(item => item.hasEquivalent && !item.isNote && item.inaSection && item.uscSection);
  const crosswalkByUsc = new Map(mappings.map(item => [String(item.uscSection), item]));
  const sectionsByUsc = new Map((corpus.title8?.sections || []).map(section => [String(section.section), section]));
  if (!sectionsByUsc.has("1101")) throw new Error("Cannot build INA definitions without 8 U.S.C. 1101.");
  const candidates = [];
  const excludedMentions = [];
  const specificScopes = definitionSource.inaSpecificScope || {};
  const annotationTargets = definitionSource.inaAnnotationTargets || {};

  function walk(section, mapping, nodes, ancestors = []) {
    for (const node of nodes || []) {
      const path = [...(ancestors.at(-1)?.path || []), String(node.label || "")];
      const lexical = /\bthe terms?\s+[“"]/i.test(node.text || "");
      const groups = definitionStatementGroups(node.text, Boolean(node.children?.length));
      if (lexical && !groups.length) excludedMentions.push({
        citation: inaCitation(mapping.inaSection, path),
        uscCitation: `8 U.S.C. ${mapping.uscSection}${citationSuffix(path)}`,
        text: node.text
      });
      for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
        const group = groups[groupIndex];
        const citation = inaCitation(mapping.inaSection, path);
        const directScope = directScopeContext(node.text, group, citation);
        candidates.push({
          section,
          mapping,
          node,
          path,
          group,
          groupIndex,
          groupCount: groups.length,
          scopeContext: directScope || inheritedScopeContext(section, mapping, ancestors),
          scopeIsDirect: Boolean(directScope)
        });
      }
      walk(section, mapping, node.children, [...ancestors, { node, path }]);
    }
  }

  for (const mapping of mappings) {
    const section = sectionsByUsc.get(String(mapping.uscSection));
    if (section) walk(section, mapping, section.body);
  }

  for (const candidate of candidates.filter(item => !item.scopeContext)) {
    const sibling = candidates.find(other => other !== candidate
      && other.scopeContext
      && other.mapping.inaSection === candidate.mapping.inaSection
      && other.path.slice(0, -1).join(".") === candidate.path.slice(0, -1).join(".")
      && other.group.terms.some(term => candidate.group.terms.some(candidateTerm => candidateTerm.toLowerCase() === term.toLowerCase())));
    if (sibling) candidate.scopeContext = sibling.scopeContext;
  }

  const entries = [];
  const scopes = new Map((definitionSource.scopes || []).filter(scope => scope.id.startsWith("ina-")).map(scope => [scope.id, { ...scope }]));
  const sourceFilters = new Map();
  const unresolvedScopes = [];
  for (const candidate of candidates) {
    const { section, mapping, node, path, group, groupIndex, groupCount } = candidate;
    let scopeId = String(mapping.inaSection) === "101" && !candidate.scopeIsDirect ? inaScopeForPath(path) : null;
    let scopeRecord = scopeId ? scopes.get(scopeId) : null;
    if (!scopeRecord) {
      const targets = candidate.scopeContext ? resolveScopeTargets(candidate.scopeContext.text, mapping, section, path, crosswalkByUsc) : [];
      if (!targets.length) {
        unresolvedScopes.push({ citation: inaCitation(mapping.inaSection, path), terms: group.terms, text: group.text });
        continue;
      }
      scopeRecord = scopeRecordForTargets(targets, candidate.scopeContext);
      scopeId = scopeRecord.id;
      if (!scopes.has(scopeId)) scopes.set(scopeId, scopeRecord);
    }
    const sourceFilter = sourceFilterForIna(mapping.inaSection, path);
    if (!sourceFilters.has(sourceFilter)) sourceFilters.set(sourceFilter, {
      id: sourceFilter,
      label: String(mapping.inaSection) === "101" ? `INA 101(${path[0]})` : `INA ${mapping.inaSection}`,
      parentId: "ina-statute"
    });
    const citeSuffix = citationSuffix(path);
    for (const term of group.terms) {
      const statementSuffix = groupCount > 1 ? `-${groupIndex + 1}` : "";
      const termSuffix = group.terms.length > 1 ? `-${slug(term)}` : "";
      entries.push({
        id: `ina-${slug(mapping.inaSection)}-${pathKey(path)}${statementSuffix}${termSuffix}`,
        term,
        aliases: [term],
        text: group.text,
        textStart: group.textStart,
        textEnd: group.textEnd,
        children: [],
        childInsertionOffset: group.childInsertionOffset,
        references: sliceOffsetRecords(node.references, group.textStart, group.textEnd),
        sourceFamily: "ina",
        sourceCategory: "law",
        sourceFilter,
        scopeId,
        scopeCategory: "law",
        sourcePriority: 1,
        citation: inaCitation(mapping.inaSection, path),
        uscCitation: `8 U.S.C. ${mapping.uscSection}${citeSuffix}`,
        path: clone(path),
        sectionId: section.id,
        locator: `${inaCitation(mapping.inaSection, path)} / 8 U.S.C. ${mapping.uscSection}${citeSuffix}`,
        url: section.url || section.source?.url,
        captureDate: section.source?.captureDate || definitionSource.capturedAt,
        resource: section.source?.resource || "United States Code, Title 8",
        sourceScope: candidate.scopeContext?.text || scopeRecord.text,
        scopeLocator: candidate.scopeContext?.sourceCitation || scopeRecord.sourceLabel,
        specificScope: String(mapping.inaSection) === "101" ? (specificScopes[path.join(".")] || "") : "",
        ...(String(mapping.inaSection) === "101" && annotationTargets[path.join(".")] ? { annotationTargets: clone(annotationTargets[path.join(".")]) } : {})
      });
    }
  }
  return {
    entries,
    scopes: [...scopes.values()],
    sourceFilters: [...sourceFilters.values()],
    audit: {
      mappedSections: mappings.length,
      lexicalFields: new Set([
        ...candidates.map(candidate => `${candidate.section.id}:${candidate.path.join(".")}`),
        ...excludedMentions.map(item => item.uscCitation)
      ]).size,
      definitionFields: new Set(candidates.map(candidate => `${candidate.section.id}:${candidate.path.join(".")}`)).size,
      definitionStatements: candidates.length,
      definitionEntries: entries.length,
      indexedTerms: entries.reduce((total, entry) => total + entry.aliases.length, 0),
      excludedMentions,
      unresolvedScopes
    }
  };
}

function deriveInaEntries(corpus, definitionSource) {
  const catalog = deriveInaCatalog(corpus, definitionSource);
  if (catalog.audit.unresolvedScopes.length) throw new Error(`Unresolved INA definition scopes: ${catalog.audit.unresolvedScopes.map(item => item.citation).join(", ")}`);
  return catalog.entries;
}

function buildDefinitionCatalog(corpus, definitionSource, glossarySource = null) {
  const definitions = clone(definitionSource);
  const inaCatalog = deriveInaCatalog(corpus, definitionSource);
  if (inaCatalog.audit.unresolvedScopes.length) throw new Error(`Unresolved INA definition scopes: ${inaCatalog.audit.unresolvedScopes.map(item => item.citation).join(", ")}`);
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
    url: sourceTextFragmentUrl(glossary.source.url, entry.term),
    captureDate: glossary.source.capturedAt,
    resource: glossary.source.name,
    children: []
  }));
  delete definitions.cfrEntries;
  delete definitions.inaSpecificScope;
  delete definitions.inaAnnotationTargets;
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
    ...inaCatalog.scopes.map(scope => ({ ...scope, category: "law" })),
    ...definitions.scopes.filter(scope => !scope.id.startsWith("ina-")).map(scope => ({ ...scope, category: "law" }))
  ];
  definitions.entries = [...glossaryEntries, ...inaCatalog.entries, ...cfrEntries];
  definitions.inaVerification = clone(inaCatalog.audit);
  definitions.sourceFilters = [
    { id: "all", label: "All sources" },
    ...(glossary ? [{ id: "uscis-glossary", label: "USCIS Glossary" }] : []),
    { id: "law", label: "Law" },
    { id: "ina-statute", label: "Statute", parentId: "law" },
    ...inaCatalog.sourceFilters,
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

module.exports = { buildDefinitionCatalog, deriveInaCatalog, deriveInaEntries, definitionStatementGroups, quotedTermsFromDefinition, resolveScopeTargets };
