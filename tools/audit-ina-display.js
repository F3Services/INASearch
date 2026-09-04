#!/usr/bin/env node
"use strict";
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const { readArtifact, collectFields } = require('./audit-inline-references');
const embedded = require('./embedded-references');
const escapeHtml = value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const plain = value => String(value).replace(/<sup\b[^>]*>[\s\S]*?<\/sup>/g, '').replace(/<[^>]*>/g, '').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
function runtime(template, corpus) {
  const scope = {
    profile: { preferences: { statutoryLinkCitationSystem: 'ina' } },
    INASearchEmbeddedReferences: embedded,
    inaMap: new Map(corpus.inaCrosswalk.map(row => [String(row.inaSection).toLowerCase(), row])),
    uscToIna: new Map(corpus.inaCrosswalk.map(row => [String(row.uscSection).toLowerCase(), row])),
    canonicalPath: tokens => (tokens || []).map(token => `(${token})`).join(''),
    normCitationPart: value => String(value || '').toLowerCase(), escapeHtml,
    definedTermHighlightingEnabled: () => false, scopedDefinitionMatches: () => [],
    renderScopedDefinitionAnnotatedText: (input, match, start, end) => scope.renderSearchHighlightedText(input, match, start, end),
    legalReferenceDisposition: () => ({ status: 'current', section: null, transferTarget: null }),
    transferTargetUrl: () => '', transferTargetLabel: () => '', legalReferenceInsertionRecord: () => null, legalReferenceSourceAttributes: () => ''
  };
  vm.createContext(scope);
  for (const name of ['renderSearchHighlightedText', 'legalReferenceCitation', 'statutoryReferenceCrosswalk', 'coordinatedStatutoryInaLists', 'statutoryLinkUsesConvertibleUscWording', 'statutoryLinkInaCitation', 'legalReferenceHtml', 'houseFootnoteReferenceHtml', 'coordinatedInaListHtml', 'linkifyStatutoryText']) {
    const start = template.indexOf(`    function ${name}(`);
    if (start < 0) throw new Error(`Missing ${name}`);
    const end = template.indexOf('\n    function ', start + 10);
    vm.runInContext(template.slice(start, end), scope);
  }
  return scope;
}
function contextFor(field, corpus) {
  if (field.scope === 'cfr') return { kind: 'cfr', title: field.sourceId.match(/cfr-(?:part-)?(\d+)/)?.[1] || '8' };
  const section = field.sourcePath.match(/title8.sections\[([^\]]+)\]/)[1];
  const mapping = corpus.inaCrosswalk.find(row => String(row.uscSection) === section);
  return { kind: mapping ? 'ina' : 'usc', uscSection: section, inaSection: mapping?.inaSection };
}
function audit(artifact, templateFile, output) {
  const corpus = readArtifact(artifact), template = fs.readFileSync(templateFile, 'utf8'), api = runtime(template, corpus);
  fs.mkdirSync(output, { recursive: true });
  const records = [], summary = { fields: 0, references: 0, renderedLinks: 0, groups: {}, changedFields: 0, artifactSha256: crypto.createHash('sha256').update(fs.readFileSync(artifact)).digest('hex'), templateSha256: crypto.createHash('sha256').update(template).digest('hex') };
  for (const field of collectFields(corpus)) {
    const context = contextFor(field, corpus);
    const html = api.linkifyStatutoryText(field.text, field.references, 0, undefined, null, [], context);
    const groups = api.coordinatedStatutoryInaLists(field.text, field.references, 0, undefined, context);
    const displayed = plain(html);
    const links = [...html.matchAll(/<a\b([^>]*data-legal-reference[^>]*)>([\s\S]*?)<\/a>/g)].map(match => {
      const attrs = Object.fromEntries([...match[1].matchAll(/([\w-]+)="([^"]*)"/g)].map(attr => [attr[1], plain(attr[2])]));
      return { text: plain(match[2]), family: attrs['data-reference-family'], section: attrs['data-reference-section'], path: attrs['data-reference-path'], sourceText: attrs['data-reference-source-text'], ina: attrs['data-reference-ina-citation'], citation: attrs['data-reference-citation'], navigation: attrs['data-show-citation'] || attrs['data-show-cfr-citation'] };
    });
    summary.fields++; summary.references += field.references.length; summary.renderedLinks += links.length;
    if (displayed !== field.text) summary.changedFields++;
    for (const group of groups) summary.groups[group.grammar] = (summary.groups[group.grammar] || 0) + 1;
    records.push({ scope: field.scope, sourceId: field.sourceId, sourcePath: field.sourcePath, field: field.field, original: field.text, displayed, references: field.references, links,
      groups: groups.map(group => ({ start: group.start, end: group.end, grammar: group.grammar, labels: group.labels, text: field.text.slice(group.start, group.end) })) });
  }
  fs.writeFileSync(path.join(output, 'display.jsonl'), records.map(row => JSON.stringify(row)).join('\n') + '\n');
  fs.writeFileSync(path.join(output, 'display-summary.json'), JSON.stringify(summary, null, 2) + '\n');
  return summary;
}
if (require.main === module) console.log(JSON.stringify(audit(process.argv[2] || 'INASearch-Uncompressed.html', process.argv[3] || 'src/INASearch.template.html', process.argv[4] || 'tmp/ina-display-current'), null, 2));
module.exports = { runtime, plain, contextFor, audit };
