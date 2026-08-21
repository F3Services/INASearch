"use strict";

const markerPattern = /\((\d{1,3}|[A-Za-z]{1,4})\)/g;
const romanPattern = /^(?:i|ii|iii|iv|v|vi|vii|viii|ix|x|xi|xii|xiii|xiv|xv|xvi|xvii|xviii|xix|xx)$/i;
const referenceWords = new Set(["section", "sections", "subsection", "subsections", "paragraph", "paragraphs", "subparagraph", "subparagraphs", "clause", "clauses", "subclause", "subclauses", "item", "items", "subdivision", "subdivisions", "part", "parts", "chapter", "chapters", "title", "titles", "under"]);
const referenceConnector = /^[\s,()[\]]*(?:(?:and|or|through|to)[\s,()[\]]*)*$/i;

function isAddressToken(token) {
  return /^\d{1,3}$/.test(token) || /^[A-Za-z]$/.test(token) || romanPattern.test(token) || /^([a-z])\1{1,2}$/.test(token) || /^([A-Z])\1$/.test(token);
}

function addressTokens(address) {
  return [...String(address || "").matchAll(/\(([^)]+)\)/g)].map(match => match[1]);
}

function statuteRunInMarkers(value, currentLabel = "") {
  const input = String(value || "");
  const candidates = [];
  let referenceChainEnd = -1;
  let match;
  markerPattern.lastIndex = 0;
  while ((match = markerPattern.exec(input))) {
    const token = match[1];
    if (!isAddressToken(token)) continue;
    const start = match.index;
    const end = markerPattern.lastIndex;
    const prefix = input.slice(0, start);
    const precedingWord = prefix.match(/([A-Za-z]+)[\s“”'".:]*$/)?.[1]?.toLowerCase() || "";
    const previousChar = input[start - 1] || "";
    const referenceContinuation = referenceChainEnd >= 0 && referenceConnector.test(input.slice(referenceChainEnd, start));
    const referenceNumberPrefix = /\b(?:section|sections|subsection|subsections|paragraph|paragraphs|subparagraph|subparagraphs|clause|clauses|subclause|subclauses|item|items)\s+\d+[A-Za-z-]*\s*$/i.test(prefix) || /\b\d{3,}[A-Za-z-]*\s*$/.test(prefix);
    const isReference = referenceContinuation || referenceWords.has(precedingWord) || referenceNumberPrefix || /[\p{L}\p{M}\p{N}§]/u.test(previousChar);
    if (isReference) {
      referenceChainEnd = end;
      continue;
    }
    candidates.push({ start, end, address: match[0], token, prefixText: "", nestedAfterPrevious: false });
    referenceChainEnd = -1;
  }

  let markers = candidates;
  if (markers.length === 1) {
    const tail = input.slice(0, markers[0].start).slice(-80);
    const followsStructuralSeparator = /(?:^|[;:,\]])\s*(?:and|or)?\s*$/i.test(tail) || /\b(?:and|or)\s*$/i.test(tail);
    const siblingPair = String(currentLabel) && ((/^\d+$/.test(currentLabel) && /^\d+$/.test(markers[0].token) && Number(markers[0].token) === Number(currentLabel) + 1) || (/^[A-Za-z]$/.test(currentLabel) && /^[A-Za-z]$/.test(markers[0].token) && markers[0].token.charCodeAt(0) === currentLabel.charCodeAt(0) + 1));
    if (!followsStructuralSeparator && !siblingPair) markers = [];
  }
  if (markers.length > 1) {
    const onlyReferenceConnectors = markers.slice(1).every((marker, index) => referenceConnector.test(input.slice(markers[index].end, marker.start)));
    const afterLastMarker = input.slice(markers.at(-1).end);
    const referenceListEnding = /^\s*[)\],.”"']*\s*(?:in|of|under|above|below|thereof|if)\b/i.test(afterLastMarker) || /^\s*[)\]”"']/.test(afterLastMarker) || /^\s*[,.”"']{2,}/.test(afterLastMarker);
    if (onlyReferenceConnectors && referenceListEnding) markers = [];
  }
  if (!markers.length) return [];

  const separated = [];
  for (const marker of markers) {
    const previous = separated.at(-1);
    const between = previous ? input.slice(previous.end, marker.start) : "";
    // Adjacent addresses are separate hierarchy levels, not one compound label.
    // Keep both so the parent and its first child remain independently citable.
    if (previous && /^\s*\[?\s*$/.test(between)) {
      marker.nestedAfterPrevious = true;
      marker.prefixText = between.includes("[") ? "[" : "";
    }
    separated.push({ ...marker });
  }
  const enriched = separated.map(marker => ({ ...marker, tokens: addressTokens(marker.address) }));
  let previousRelativePath = null;
  for (const marker of enriched) {
    const relativePath = marker.nestedAfterPrevious && previousRelativePath?.length
      ? [...previousRelativePath, ...marker.tokens]
      : inferredSiblingPath([], marker.tokens, previousRelativePath) || [...marker.tokens];
    marker.relativeDepth = relativePath.length;
    previousRelativePath = relativePath;
  }
  return enriched;
}

function pathIdentity(path) {
  return (path || []).map(token => `${String(token).length}:${String(token)}`).join("|");
}

function runInPathCandidates(currentPath, inlineTokens, previousInlinePath) {
  const candidates = [];
  const identities = new Set();
  const add = path => {
    const identity = pathIdentity(path);
    if (!identities.has(identity)) {
      identities.add(identity);
      candidates.push(path);
    }
  };
  add([...(currentPath || []), ...inlineTokens]);
  if (previousInlinePath?.length) {
    const replaceable = Math.max(1, previousInlinePath.length - (currentPath || []).length);
    for (let count = 1; count <= replaceable; count++) add([...previousInlinePath.slice(0, -count), ...inlineTokens]);
    add([...previousInlinePath, ...inlineTokens]);
  }
  return candidates;
}

function romanNumber(token) {
  const values = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10, xi: 11, xii: 12, xiii: 13, xiv: 14, xv: 15, xvi: 16, xvii: 17, xviii: 18, xix: 19, xx: 20 };
  return values[String(token || "").toLowerCase()] || 0;
}

function isImmediateSibling(previous, next) {
  const left = String(previous || "");
  const right = String(next || "");
  if (/^\d+$/.test(left) && /^\d+$/.test(right)) return Number(right) === Number(left) + 1;
  const leftRoman = romanNumber(left);
  const rightRoman = romanNumber(right);
  const sameCase = (left === left.toUpperCase() && right === right.toUpperCase()) || (left === left.toLowerCase() && right === right.toLowerCase());
  if (leftRoman && rightRoman && sameCase && rightRoman === leftRoman + 1) return true;
  const leftLetters = left.match(/^([A-Za-z])\1*$/)?.[0] || "";
  const rightLetters = right.match(/^([A-Za-z])\1*$/)?.[0] || "";
  const sameLetterCase = (leftLetters === leftLetters.toUpperCase() && rightLetters === rightLetters.toUpperCase()) || (leftLetters === leftLetters.toLowerCase() && rightLetters === rightLetters.toLowerCase());
  return Boolean(leftLetters && rightLetters && leftLetters.length === rightLetters.length && sameLetterCase && rightLetters.charCodeAt(0) === leftLetters.charCodeAt(0) + 1);
}

function inferredSiblingPath(currentPath, inlineTokens, previousInlinePath) {
  if (!previousInlinePath?.length || !inlineTokens?.length) return null;
  const replaceable = Math.max(1, previousInlinePath.length - (currentPath || []).length);
  for (let count = 1; count <= replaceable; count++) {
    if (isImmediateSibling(previousInlinePath.at(-count), inlineTokens[0])) return [...previousInlinePath.slice(0, -count), ...inlineTokens];
  }
  return null;
}

function fallbackRunInPath(currentPath, parentPath, inlineTokens) {
  const currentDepth = Math.max(0, (currentPath?.length || 1) - 1);
  const firstInlineToken = String(inlineTokens[0] || "");
  const sameLevel = currentDepth === 0 ? /^[a-z]+$/.test(firstInlineToken)
    : currentDepth === 1 ? /^\d+$/.test(firstInlineToken)
    : currentDepth === 2 ? /^[A-Z]+$/.test(firstInlineToken)
    : currentDepth === 3 ? /^[ivxlcdm]+$/.test(firstInlineToken)
    : currentDepth === 4 ? /^[IVXLCDM]+$/.test(firstInlineToken)
    : currentDepth % 2 === 1 ? /^[a-z]+$/.test(firstInlineToken) : /^[A-Z]+$/.test(firstInlineToken);
  return [...(sameLevel ? parentPath || [] : currentPath || []), ...inlineTokens];
}

function collectStructuralPaths(nodes, path, identities) {
  for (const node of nodes || []) {
    const current = [...path, String(node.label)];
    identities.add(pathIdentity(current));
    collectStructuralPaths(node.children, current, identities);
  }
}

function indexStatuteRunIns(corpus) {
  const stats = { sections: 0, sourceNodes: 0, markers: 0, paths: 0 };
  for (const section of corpus?.title8?.sections || []) {
    const structuralIdentities = new Set();
    collectStructuralPaths(section.body, [], structuralIdentities);
    const indexedIdentities = new Set(structuralIdentities);
    const runInPaths = new Map();

    const walk = (nodes, parentPath = []) => {
      for (const node of nodes || []) {
        const currentPath = [...parentPath, String(node.label)];
        const markers = statuteRunInMarkers(node.text, node.label);
        if (markers.length) stats.sourceNodes += 1;
        let previousInlinePath = null;
        for (const marker of markers) {
          const candidates = runInPathCandidates(currentPath, marker.tokens, previousInlinePath);
          const directPath = candidates[0];
          let inlinePath = marker.nestedAfterPrevious && previousInlinePath?.length
            ? [...previousInlinePath, ...marker.tokens]
            : candidates.find(path => indexedIdentities.has(pathIdentity(path)) && !structuralIdentities.has(pathIdentity(path)))
              || inferredSiblingPath(currentPath, marker.tokens, previousInlinePath)
              || fallbackRunInPath(currentPath, parentPath, marker.tokens);
          if (structuralIdentities.has(pathIdentity(inlinePath)) && !structuralIdentities.has(pathIdentity(directPath))) inlinePath = directPath;
          const identity = pathIdentity(inlinePath);
          previousInlinePath = inlinePath;
          stats.markers += 1;
          if (!structuralIdentities.has(identity) && !runInPaths.has(identity)) {
            runInPaths.set(identity, inlinePath);
            indexedIdentities.add(identity);
          }
        }
        walk(node.children, currentPath);
      }
    };
    walk(section.body);
    if (runInPaths.size) {
      section.runInPaths = [...runInPaths.values()];
      stats.sections += 1;
      stats.paths += runInPaths.size;
    } else {
      delete section.runInPaths;
    }
  }
  return stats;
}

module.exports = { addressTokens, indexStatuteRunIns, statuteRunInMarkers };
