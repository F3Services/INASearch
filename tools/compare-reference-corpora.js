'use strict';

const { createHash } = require('node:crypto');

const REFERENCE_FIELDS = Object.freeze({ references: 'text', continuationReferences: 'continuation', headingReferences: 'heading', preambleReferences: 'preamble', sourceCreditReferences: 'sourceCredit', xReferences: 'x', authorityReferences: 'authority', sourceReferences: 'source' });
const INTERNAL_REFERENCE_KEYS = new Set(['id', 'evidenceId']);
const DERIVED_ROOT_KEYS = new Set(['legalReferenceMetadata', 'legalReferenceEvidence', 'legalReferencePacking', 'embeddedReferenceAudit', 'historicalReferenceTargets']);
const CONFIGURATION_KEYS = ['legalReferenceExceptions', 'legalReferencePolicy'];
const isReferenceArray = (key, value) => /references$/i.test(key) && Array.isArray(value);
const pointer = parts => '/' + parts.map(part => String(part).replace(/~/g, '~0').replace(/\//g, '~1')).join('/');
const location = parts => 'corpus' + parts.map(part => typeof part === 'number' ? `[${part}]` : /^[A-Za-z_$][\w$]*$/.test(part) ? `.${part}` : `[${JSON.stringify(part)}]`).join('');
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
function historicalTargetBinding(reference, corpus) {
  if (!reference.historicalTargetId) return null;
  const id = reference.historicalTargetId, registry = corpus.historicalReferenceTargets;
  const target = registry && Object.hasOwn(registry, id) ? registry[id] : null;
  return { id, status: target && typeof target === 'object' && !Array.isArray(target) ? 'resolved' : 'missing', target: target ?? null };
}
function referenceIdentity(reference, includeRule = false, corpus) {
  const value = Object.fromEntries(Object.entries(reference).filter(([key]) => (!reference.family || !INTERNAL_REFERENCE_KEYS.has(key)) && (includeRule || key !== 'ruleId')));
  const binding = corpus && historicalTargetBinding(reference, corpus);
  if (binding) delete value.historicalTargetId;
  // The separate tuple member cannot collide with future reference properties.
  // A registry index is an encoding detail; every property of its target is not.
  return JSON.stringify(canonical([value, binding ? binding.status === 'resolved' ? { target: binding.target } : { missingId: binding.id, invalidTarget: binding.target } : null]));
}
function historicalTargetBindings(references, corpus) {
  return references.map((reference, referenceIndex) => ({ referenceIndex, binding: historicalTargetBinding(reference, corpus) })).filter(entry => entry.binding).map(({ referenceIndex, binding }) => ({ referenceIndex, ...binding }));
}
function compareHistoricalTargets(before, after, old, now) {
  const groups = new Map(), diagnostics = [];
  for (const [side, corpus, inventory] of [['before', before, old], ['after', after, now]]) {
    for (const [id, target] of Object.entries(corpus.historicalReferenceTargets || {})) {
      if (id === '0' && target === null) continue; // Reserved empty registry slot.
      const key = JSON.stringify(canonical(target));
      if (!groups.has(key)) groups.set(key, { identity: createHash('sha256').update(key).digest('hex'), target, beforeIds: [], afterIds: [], beforeReferences: [], afterReferences: [] });
      groups.get(key)[side + 'Ids'].push(id);
    }
    for (const field of inventory.fields.values()) for (const binding of historicalTargetBindings(field.references, corpus)) {
      const usage = { referenceArrayPointer: field.referenceArrayPointer, referenceIndex: binding.referenceIndex, historicalTargetId: binding.id };
      if (binding.status === 'missing') diagnostics.push({ side, ...usage, status: 'missing-historical-target', invalidTarget: binding.target, reference: field.references[binding.referenceIndex] });
      else groups.get(JSON.stringify(canonical(binding.target)))[side + 'References'].push(usage);
    }
  }
  const registry = [...groups.values()].map(entry => ({ ...entry, status: !entry.beforeIds.length ? 'added' : !entry.afterIds.length ? 'removed' : entry.beforeIds.length !== entry.afterIds.length ? 'count-changed' : JSON.stringify(entry.beforeIds) !== JSON.stringify(entry.afterIds) ? 'reindexed' : 'unchanged' }));
  return { registry, changes: registry.filter(entry => !['unchanged', 'reindexed'].includes(entry.status)), reindexings: registry.filter(entry => entry.status === 'reindexed'), diagnostics };
}
function sourceOnly(value) {
  if (Array.isArray(value)) return value.map(sourceOnly);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key, child]) => !isReferenceArray(key, child)).map(([key, child]) => [key, sourceOnly(child)]));
}
function contextMetadata(value) {
  return Object.fromEntries(Object.entries(value || {}).filter(([key, child]) => !isReferenceArray(key, child) && (!child || typeof child !== 'object' || ['source', 'historical', 'hierarchy', 'breadcrumb', 'runInPaths'].includes(key))));
}
function collect(corpus) {
  const fields = new Map(), strings = new Map();
  function visit(value, parts = [], ancestors = [], sourceId = '') {
    if (typeof value === 'string') { strings.set(pointer(parts), value); return; }
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach((child, index) => visit(child, [...parts, index], [...ancestors, { pointer: pointer(parts), array: value, index }], sourceId)); return; }
    sourceId = value.id || sourceId;
    for (const [key, child] of Object.entries(value)) {
      if (isReferenceArray(key, child)) {
        const field = REFERENCE_FIELDS[key] || key;
        fields.set(pointer([...parts, key]), { sourceId, sourcePath: location(parts), ownerPointer: pointer(parts), fieldPointer: pointer([...parts, field]), referenceArrayPointer: pointer([...parts, key]), referenceProperty: key, field, text: typeof value[field] === 'string' ? value[field] : null, references: child, owner: value, ancestors });
      } else if (!(parts.length === 0 && (DERIVED_ROOT_KEYS.has(key) || CONFIGURATION_KEYS.includes(key)))) visit(child, [...parts, key], [...ancestors, { pointer: pointer(parts), value }], sourceId);
    }
  }
  visit(corpus);
  return { fields, strings };
}
// Cancel exact multiset members first, then pair equal semantic members whose
// internal rule labels differ. Unlike per-span pairing this works for raw
// source-evidence records, duplicate references, and unknown future metadata.
function difference(before, after, beforeCorpus, afterCorpus) {
  const remaining = after.map((reference, index) => ({ reference, index, used: false }));
  const unmatchedBefore = [], ruleOnly = [];
  const buckets = new Map();
  for (const entry of remaining) {
    const key = referenceIdentity(entry.reference, true, afterCorpus);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(entry);
  }
  for (const reference of before) {
    const entry = buckets.get(referenceIdentity(reference, true, beforeCorpus))?.shift();
    if (entry) entry.used = true; else unmatchedBefore.push(reference);
  }
  const semanticBuckets = new Map();
  for (const entry of remaining.filter(entry => !entry.used)) {
    const key = referenceIdentity(entry.reference, false, afterCorpus);
    if (!semanticBuckets.has(key)) semanticBuckets.set(key, []);
    semanticBuckets.get(key).push(entry);
  }
  const removed = [];
  for (const reference of unmatchedBefore) {
    const entry = semanticBuckets.get(referenceIdentity(reference, false, beforeCorpus))?.shift();
    if (entry) { entry.used = true; ruleOnly.push({ before: reference, after: entry.reference }); }
    else removed.push(reference);
  }
  return { removed, added: remaining.filter(entry => !entry.used).map(entry => entry.reference), ruleOnly };
}
function compareCorpora(before, after) {
  const old = collect(before), now = collect(after), rows = [], ruleOnlyChanges = [], sourceChanges = [], fieldContexts = new Map();
  const historical = compareHistoricalTargets(before, after, old, now);
  for (const key of new Set([...old.strings.keys(), ...now.strings.keys()])) if (old.strings.get(key) !== now.strings.get(key)) sourceChanges.push({ pointer: key, before: old.strings.get(key) ?? null, after: now.strings.get(key) ?? null });
  for (const key of new Set([...old.fields.keys(), ...now.fields.keys()])) {
    const a = old.fields.get(key), b = now.fields.get(key), f = b || a;
    const delta = difference(a?.references || [], b?.references || [], before, after);
    const common = { sourceId: f.sourceId, sourcePath: f.sourcePath, field: f.field, fieldPointer: f.fieldPointer, referenceArrayPointer: key, referenceProperty: f.referenceProperty };
    ruleOnlyChanges.push(...delta.ruleOnly.map(change => ({ ...common, ...change, beforeHistoricalTarget: historicalTargetBinding(change.before, before), afterHistoricalTarget: historicalTargetBinding(change.after, after) })));
    if (!delta.removed.length && !delta.added.length) continue;
    fieldContexts.set(key, { ...common, completeSource: f.text, beforeSource: a?.text ?? null, afterSource: b?.text ?? null, beforeFieldReferences: a?.references || [], afterFieldReferences: b?.references || [], ownerContext: sourceOnly(f.owner), ancestorContext: f.ancestors.filter(ancestor => ancestor.value).map(ancestor => ({ pointer: ancestor.pointer, ...contextMetadata(ancestor.value) })), siblingContext: f.ancestors.filter(ancestor => ancestor.array).flatMap(ancestor => [-1, 1].filter(offset => ancestor.array[ancestor.index + offset]).map(offset => ({ relation: offset < 0 ? 'preceding' : 'following', pointer: ancestor.pointer + '/' + (ancestor.index + offset), source: sourceOnly(ancestor.array[ancestor.index + offset]) }))) });
    Object.assign(fieldContexts.get(key), { beforeHistoricalTargets: historicalTargetBindings(a?.references || [], before), afterHistoricalTargets: historicalTargetBindings(b?.references || [], after) });
    const changed = [...delta.removed.map(reference => ({ side: 'before', reference })), ...delta.added.map(reference => ({ side: 'after', reference }))];
    const spanned = changed.filter(entry => Number.isInteger(entry.reference.start) && Number.isInteger(entry.reference.end) && entry.reference.end > entry.reference.start).sort((x, y) => x.reference.start - y.reference.start);
    const unspanned = changed.filter(entry => !spanned.includes(entry));
    const groups = [];
    while (spanned.length) {
      const entries = [spanned.shift()]; let end = entries[0].reference.end;
      while (spanned.length && spanned[0].reference.start < end) { const entry = spanned.shift(); entries.push(entry); end = Math.max(end, entry.reference.end); }
      groups.push({ entries, start: entries[0].reference.start, end });
    }
    if (unspanned.length) groups.push({ entries: unspanned, start: null, end: null });
    for (const group of groups) {
      const beforeReferences = group.entries.filter(entry => entry.side === 'before').map(entry => entry.reference), afterReferences = group.entries.filter(entry => entry.side === 'after').map(entry => entry.reference);
      rows.push({ id: `delta-${String(rows.length + 1).padStart(5, '0')}`, ...common, start: group.start, end: group.end, context: group.start === null ? f.text : f.text?.slice(Math.max(0, group.start - 300), group.end + 300) ?? null, before: beforeReferences, after: afterReferences, beforeHistoricalTargets: historicalTargetBindings(beforeReferences, before), afterHistoricalTargets: historicalTargetBindings(afterReferences, after) });
    }
  }
  const total = inventory => [...inventory.fields.values()].reduce((sum, field) => sum + field.references.length, 0);
  const configurationChanges = CONFIGURATION_KEYS.filter(key => JSON.stringify(canonical(before[key])) !== JSON.stringify(canonical(after[key]))).map(key => ({ key, before: before[key] ?? null, after: after[key] ?? null }));
  return { rows, ruleOnlyChanges, sourceChanges, configurationChanges, fieldContexts, historicalTargetRegistry: historical.registry, historicalTargetChanges: historical.changes, historicalTargetReindexings: historical.reindexings, historicalTargetDiagnostics: historical.diagnostics, summary: { before: total(old), after: total(now), sourceStringFieldsBefore: old.strings.size, sourceStringFieldsAfter: now.strings.size, sourceChanges: sourceChanges.length, configurationChanges: configurationChanges.length, historicalTargetIdentities: historical.registry.length, historicalTargetChanges: historical.changes.length, historicalTargetReindexings: historical.reindexings.length, historicalTargetDiagnostics: historical.diagnostics.length, changes: rows.length, changedFields: fieldContexts.size, ruleIdOnlyChanges: ruleOnlyChanges.length, removed: rows.reduce((n, row) => n + row.before.length, 0), added: rows.reduce((n, row) => n + row.after.length, 0) } };
}
module.exports = { compareCorpora, referenceIdentity, historicalTargetBinding, historicalTargetBindings };
