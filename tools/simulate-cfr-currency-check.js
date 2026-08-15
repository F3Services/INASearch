#!/usr/bin/env node
/*
 * Benchmark privacy-preserving eCFR currency checks for INASearch.
 *
 * This tool deliberately derives every request from the fixed embedded corpus,
 * never from a citation viewed by a user. It does not modify the corpus or the
 * standalone editions. The default strategy is the proposed production shape:
 *
 *   1. Fetch title metadata once.
 *   2. Query version deltas only for corpus titles whose latest issue is newer
 *      than the embedded title snapshot.
 *   3. Fetch the eCFR correction feed for each distinct embedded snapshot date
 *      and filter it locally to the exact title/part coverage.
 *   4. Build an in-memory part-status map used for all later local lookups.
 *
 * Usage:
 *   node tools/simulate-cfr-currency-check.js
 *   node tools/simulate-cfr-currency-check.js --strategy fixed-title --concurrency 6
 *   node tools/simulate-cfr-currency-check.js --strategy per-part --concurrency 6
 *   node tools/simulate-cfr-currency-check.js --snapshot-date 2026-05-13
 *   node tools/simulate-cfr-currency-check.js --suite
 *   node tools/simulate-cfr-currency-check.js --suite --json
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { performance } = require("perf_hooks");

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_CORPUS = path.join(ROOT, "src", "INASearch-CFR.js");
const ECFR_BASE = "https://www.ecfr.gov";
const USER_AGENT = "INASearch-Currency-Benchmark/1.0 (+fixed-corpus freshness check)";
const STRATEGIES = new Set(["gated-title", "fixed-title", "per-part"]);

function usage() {
  return `Usage: node tools/simulate-cfr-currency-check.js [options]

Options:
  --strategy NAME       gated-title (default), fixed-title, or per-part
  --concurrency N       Maximum simultaneous delta/correction requests (default: 6)
  --runs N              Repeat one configuration N times (default: 1)
  --suite               Benchmark representative strategies and concurrency levels
  --json                Emit machine-readable JSON
  --corpus PATH         Generated INASearch CFR JavaScript payload
  --snapshot-date DATE  Treat every title as current through this date (staleness test)
  --timeout-ms N        Per-request timeout (default: 30000)
  --max-retries N       Retries for 429 and transient 5xx responses (default: 4)
  --help                Show this help
`;
}

function parseArgs(argv) {
  const options = {
    strategy: "gated-title",
    concurrency: 6,
    runs: 1,
    suite: false,
    json: false,
    corpus: DEFAULT_CORPUS,
    snapshotDate: null,
    timeoutMs: 30_000,
    maxRetries: 4,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = () => {
      if (index + 1 >= argv.length) throw new Error(`${argument} requires a value.`);
      index += 1;
      return argv[index];
    };
    if (argument === "--strategy") options.strategy = next();
    else if (argument === "--concurrency") options.concurrency = Number(next());
    else if (argument === "--runs") options.runs = Number(next());
    else if (argument === "--suite") options.suite = true;
    else if (argument === "--json") options.json = true;
    else if (argument === "--corpus") options.corpus = path.resolve(next());
    else if (argument === "--snapshot-date") options.snapshotDate = next();
    else if (argument === "--timeout-ms") options.timeoutMs = Number(next());
    else if (argument === "--max-retries") options.maxRetries = Number(next());
    else if (argument === "--help" || argument === "-h") options.help = true;
    else throw new Error(`Unknown option: ${argument}`);
  }
  if (!STRATEGIES.has(options.strategy)) {
    throw new Error(`Unknown strategy ${JSON.stringify(options.strategy)}.`);
  }
  if (options.snapshotDate && !/^\d{4}-\d{2}-\d{2}$/.test(options.snapshotDate)) {
    throw new Error("snapshot-date must use YYYY-MM-DD format.");
  }
  for (const [name, value, minimum] of [
    ["concurrency", options.concurrency, 1],
    ["runs", options.runs, 1],
    ["timeout-ms", options.timeoutMs, 250],
    ["max-retries", options.maxRetries, 0],
  ]) {
    if (!Number.isInteger(value) || value < minimum) {
      throw new Error(`${name} must be an integer of at least ${minimum}.`);
    }
  }
  return options;
}

function loadCorpus(file) {
  const source = fs.readFileSync(file, "utf8");
  const assignment = source.indexOf("=");
  const terminator = source.lastIndexOf(";");
  if (assignment < 0 || terminator <= assignment) {
    throw new Error(`Could not locate the generated CFR payload in ${file}.`);
  }
  const corpus = JSON.parse(source.slice(assignment + 1, terminator));
  if (!corpus.currentThrough || !Array.isArray(corpus.parts)) {
    throw new Error(`The CFR payload in ${file} lacks currentThrough or parts metadata.`);
  }
  return corpus;
}

function coverageFromCorpus(corpus) {
  const byTitle = new Map();
  for (const part of corpus.parts) {
    const title = String(part.title);
    const partNumber = String(part.part || String(part.id || "").split(":").at(-1));
    if (!partNumber) throw new Error(`CFR part ${JSON.stringify(part.id)} has no part number.`);
    if (!byTitle.has(title)) byTitle.set(title, new Set());
    byTitle.get(title).add(partNumber);
  }
  const titles = [...byTitle.keys()].sort((left, right) => Number(left) - Number(right));
  const snapshotByTitle = new Map(titles.map(title => [title, corpus.currentThrough[title]]));
  for (const [title, date] of snapshotByTitle) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "")) {
      throw new Error(`Title ${title} has an invalid embedded current-through date: ${date}`);
    }
  }
  const partKeys = [];
  for (const title of titles) {
    for (const part of [...byTitle.get(title)].sort(naturalPartOrder)) {
      partKeys.push(`${title}:${part}`);
    }
  }
  return { byTitle, titles, snapshotByTitle, partKeys };
}

function naturalPartOrder(left, right) {
  const numeric = Number.parseInt(left, 10) - Number.parseInt(right, 10);
  return numeric || left.localeCompare(right, "en", { numeric: true });
}

function dayAfter(date) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + 1);
  return value.toISOString().slice(0, 10);
}

function byteLength(value) {
  return Buffer.byteLength(value, "utf8");
}

function percentile(values, proportion) {
  if (!values.length) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  const index = Math.min(ordered.length - 1, Math.ceil(proportion * ordered.length) - 1);
  return ordered[Math.max(0, index)];
}

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

class MeteredClient {
  constructor({ timeoutMs, maxRetries }) {
    this.timeoutMs = timeoutMs;
    this.maxRetries = maxRetries;
    this.logicalRequests = 0;
    this.httpAttempts = 0;
    this.responseBytes = 0;
    this.rateLimits = 0;
    this.transientFailures = 0;
    this.retryDelayMs = 0;
    this.requestDurationsMs = [];
    this.requestsByKind = {};
    this.metricsByKind = {};
  }

  async json(url, kind) {
    this.logicalRequests += 1;
    this.requestsByKind[kind] = (this.requestsByKind[kind] || 0) + 1;
    const kindMetrics = this.metricsByKind[kind] || {
      logicalRequests: 0,
      httpAttempts: 0,
      responseBytes: 0,
      rateLimits: 0,
      transientFailures: 0,
      requestDurationsMs: [],
    };
    this.metricsByKind[kind] = kindMetrics;
    kindMetrics.logicalRequests += 1;
    const logicalStart = performance.now();
    let lastError;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      this.httpAttempts += 1;
      kindMetrics.httpAttempts += 1;
      try {
        const response = await fetch(url, {
          headers: { Accept: "application/json", "User-Agent": USER_AGENT },
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        const body = await response.text();
        const bodyBytes = byteLength(body);
        this.responseBytes += bodyBytes;
        kindMetrics.responseBytes += bodyBytes;
        let parsed;
        try {
          parsed = JSON.parse(body);
        } catch (error) {
          throw new Error(`eCFR returned non-JSON content for ${url}: ${body.slice(0, 160)}`);
        }
        if (response.ok) {
          const duration = performance.now() - logicalStart;
          this.requestDurationsMs.push(duration);
          kindMetrics.requestDurationsMs.push(duration);
          return parsed;
        }
        const retryable = response.status === 429 || response.status >= 500;
        if (!retryable || attempt === this.maxRetries) {
          throw new Error(`eCFR ${response.status} for ${url}: ${parsed.error || body.slice(0, 240)}`);
        }
        if (response.status === 429) {
          this.rateLimits += 1;
          kindMetrics.rateLimits += 1;
        } else {
          this.transientFailures += 1;
          kindMetrics.transientFailures += 1;
        }
        const retryAfter = Number(response.headers.get("retry-after"));
        const delay = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : Math.min(500 * (2 ** attempt), 8_000);
        this.retryDelayMs += delay;
        await sleep(delay);
      } catch (error) {
        lastError = error;
        const retryable = error.name === "TimeoutError" || error.name === "AbortError" || error instanceof TypeError;
        if (!retryable || attempt === this.maxRetries) throw error;
        this.transientFailures += 1;
        kindMetrics.transientFailures += 1;
        const delay = Math.min(500 * (2 ** attempt), 8_000);
        this.retryDelayMs += delay;
        await sleep(delay);
      }
    }
    throw lastError || new Error(`Could not fetch ${url}.`);
  }

  summary() {
    return {
      logicalRequests: this.logicalRequests,
      httpAttempts: this.httpAttempts,
      responseBytes: this.responseBytes,
      rateLimits: this.rateLimits,
      transientFailures: this.transientFailures,
      retryDelayMs: this.retryDelayMs,
      medianRequestMs: percentile(this.requestDurationsMs, 0.5),
      p95RequestMs: percentile(this.requestDurationsMs, 0.95),
      maximumRequestMs: Math.max(0, ...this.requestDurationsMs),
      requestsByKind: this.requestsByKind,
      metricsByKind: Object.fromEntries(Object.entries(this.metricsByKind).map(([kind, metrics]) => [kind, {
        logicalRequests: metrics.logicalRequests,
        httpAttempts: metrics.httpAttempts,
        responseBytes: metrics.responseBytes,
        rateLimits: metrics.rateLimits,
        transientFailures: metrics.transientFailures,
        medianRequestMs: percentile(metrics.requestDurationsMs, 0.5),
        p95RequestMs: percentile(metrics.requestDurationsMs, 0.95),
        maximumRequestMs: Math.max(0, ...metrics.requestDurationsMs),
      }])),
    };
  }
}

async function mapConcurrent(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function take() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, take));
  return results;
}

function versionsUrl(title, snapshot, part) {
  const parameters = new URLSearchParams();
  if (part) parameters.set("part", part);
  parameters.set("date[gte]", dayAfter(snapshot));
  return `${ECFR_BASE}/api/versioner/v1/versions/title-${encodeURIComponent(title)}.json?${parameters}`;
}

function metadataCouldContainChanges(titleRecord, snapshot) {
  const latest = [titleRecord?.latest_issue_date, titleRecord?.latest_amended_on]
    .filter(Boolean)
    .sort()
    .at(-1);
  return !latest || latest > snapshot;
}

function relevantVersionRecords(data, title, allowedParts) {
  const records = data.content_versions || data.versions || [];
  return records.filter(record => {
    if (String(record.title) !== title) return false;
    if (!record.part) return true;
    return allowedParts.has(String(record.part));
  });
}

function correctionAppliesToSnapshot(correction, snapshot) {
  const occurred = correction.error_occurred;
  const corrected = correction.error_corrected;
  if (!occurred || !corrected) return false;
  return occurred <= snapshot && corrected > snapshot;
}

function relevantCorrections(data, coverage) {
  const matches = [];
  const seen = new Set();
  for (const correction of data.ecfr_corrections || []) {
    for (const reference of correction.cfr_references || []) {
      const hierarchy = reference.hierarchy || {};
      const title = String(hierarchy.title || correction.title || "");
      const snapshot = coverage.snapshotByTitle.get(title);
      const allowedParts = coverage.byTitle.get(title);
      if (!snapshot || !allowedParts || !correctionAppliesToSnapshot(correction, snapshot)) continue;
      const part = hierarchy.part ? String(hierarchy.part) : "";
      if (part && !allowedParts.has(part)) continue;
      const identity = [correction.id, title, part, hierarchy.section || "", reference.cfr_reference || ""].join(":");
      if (seen.has(identity)) continue;
      seen.add(identity);
      matches.push({
        id: correction.id,
        title,
        part,
        section: hierarchy.section ? String(hierarchy.section) : "",
        reference: reference.cfr_reference,
        errorOccurred: correction.error_occurred,
        errorCorrected: correction.error_corrected,
        correctiveAction: correction.corrective_action,
      });
    }
  }
  return matches;
}

function addChange(changesByPart, title, part, change) {
  const key = `${title}:${part}`;
  if (!changesByPart.has(key)) changesByPart.set(key, []);
  changesByPart.get(key).push(change);
}

function buildStatusIndex({ coverage, titleMetadata, versionResults, corrections, provisionalTitles }) {
  const changesByPart = new Map();
  const titleWideChanges = new Map();
  for (const result of versionResults) {
    for (const record of result.records) {
      const title = String(record.title || result.title);
      const part = record.part ? String(record.part) : "";
      const change = {
        source: "version",
        date: record.date,
        amendmentDate: record.amendment_date,
        issueDate: record.issue_date,
        identifier: record.identifier,
        name: record.name,
        substantive: record.substantive,
        removed: record.removed,
        type: record.type,
      };
      if (part) addChange(changesByPart, title, part, change);
      else {
        if (!titleWideChanges.has(title)) titleWideChanges.set(title, []);
        titleWideChanges.get(title).push(change);
      }
    }
  }
  for (const correction of corrections) {
    const change = { source: "correction", ...correction };
    if (correction.part) addChange(changesByPart, correction.title, correction.part, change);
    else {
      if (!titleWideChanges.has(correction.title)) titleWideChanges.set(correction.title, []);
      titleWideChanges.get(correction.title).push(change);
    }
  }

  const statuses = new Map();
  for (const key of coverage.partKeys) {
    const [title, part] = key.split(":");
    const changes = [...(changesByPart.get(key) || []), ...(titleWideChanges.get(title) || [])];
    const metadata = titleMetadata.get(title);
    const provisional = provisionalTitles.has(title);
    statuses.set(key, {
      title,
      part,
      status: provisional ? "unknown" : changes.length ? "outdated" : "current",
      embeddedCurrentThrough: coverage.snapshotByTitle.get(title),
      checkedThrough: metadata?.up_to_date_as_of || null,
      latestTitleIssueDate: metadata?.latest_issue_date || null,
      changes,
      reason: provisional ? "eCFR reports that this title is still being processed" : undefined,
    });
  }
  return statuses;
}

function benchmarkLocalLookups(statuses, iterations = 100_000) {
  const keys = [...statuses.keys()];
  let outdated = 0;
  const started = performance.now();
  for (let index = 0; index < iterations; index += 1) {
    if (statuses.get(keys[index % keys.length]).status === "outdated") outdated += 1;
  }
  return { iterations, milliseconds: performance.now() - started, outdatedObservations: outdated };
}

async function scanCorpus(corpus, options) {
  const coverage = coverageFromCorpus(corpus);
  if (options.snapshotDate) {
    for (const title of coverage.titles) coverage.snapshotByTitle.set(title, options.snapshotDate);
  }
  const client = new MeteredClient(options);
  const started = performance.now();
  const titlesResponse = await client.json(`${ECFR_BASE}/api/versioner/v1/titles.json`, "title-metadata");
  const titleMetadata = new Map((titlesResponse.titles || []).map(item => [String(item.number), item]));
  const missingTitles = coverage.titles.filter(title => !titleMetadata.has(title));
  if (missingTitles.length) throw new Error(`eCFR title metadata omitted: ${missingTitles.join(", ")}`);

  const provisionalTitles = new Set();
  for (const title of coverage.titles) {
    const item = titleMetadata.get(title);
    const snapshot = coverage.snapshotByTitle.get(title);
    if (
      item.processing_in_progress ||
      !item.up_to_date_as_of ||
      item.up_to_date_as_of < snapshot
    ) provisionalTitles.add(title);
  }

  let deltaTasks;
  if (options.strategy === "per-part") {
    deltaTasks = coverage.partKeys.map(key => {
      const [title, part] = key.split(":");
      return { kind: "part-delta", title, part };
    });
  } else {
    const titles = options.strategy === "gated-title"
      ? coverage.titles.filter(title => metadataCouldContainChanges(titleMetadata.get(title), coverage.snapshotByTitle.get(title)))
      : coverage.titles;
    deltaTasks = titles.map(title => ({ kind: "title-delta", title }));
  }

  const correctionDates = [...new Set(coverage.snapshotByTitle.values())].sort();
  const tasks = [
    ...deltaTasks,
    ...correctionDates.map(date => ({
      kind: "corrections",
      date,
      url: `${ECFR_BASE}/api/admin/v1/corrections.json?${new URLSearchParams({ date })}`,
    })),
  ];
  const taskResults = await mapConcurrent(tasks, options.concurrency, async task => {
    if (task.kind === "corrections") {
      return { kind: task.kind, data: await client.json(task.url, task.kind) };
    }
    const snapshot = coverage.snapshotByTitle.get(task.title);
    const data = await client.json(versionsUrl(task.title, snapshot, task.part), task.kind);
    return {
      kind: task.kind,
      title: task.title,
      part: task.part || null,
      data,
      records: relevantVersionRecords(data, task.title, coverage.byTitle.get(task.title)),
    };
  });

  const correctionData = {
    ecfr_corrections: taskResults
      .filter(result => result.kind === "corrections")
      .flatMap(result => result.data.ecfr_corrections || []),
  };
  const corrections = relevantCorrections(correctionData, coverage);
  const versionResults = taskResults.filter(result => result.kind !== "corrections");
  const statuses = buildStatusIndex({ coverage, titleMetadata, versionResults, corrections, provisionalTitles });
  const localLookup = benchmarkLocalLookups(statuses);
  const elapsedMs = performance.now() - started;
  const counts = { current: 0, outdated: 0, unknown: 0 };
  for (const status of statuses.values()) counts[status.status] += 1;
  const changedUnits = [...statuses.values()].reduce((total, status) => total + status.changes.length, 0);
  const outdatedParts = [...statuses.values()]
    .filter(status => status.status === "outdated")
    .map(status => ({
      title: status.title,
      part: status.part,
      embeddedCurrentThrough: status.embeddedCurrentThrough,
      checkedThrough: status.checkedThrough,
      changes: status.changes,
    }));

  return {
    strategy: options.strategy,
    concurrency: options.concurrency,
    coverage: {
      titles: coverage.titles.length,
      parts: coverage.partKeys.length,
      snapshotDates: Object.fromEntries(coverage.snapshotByTitle),
    },
    gate: {
      titleDeltaQueries: deltaTasks.filter(task => task.kind === "title-delta").map(task => task.title),
      partDeltaQueries: deltaTasks.filter(task => task.kind === "part-delta").length,
      correctionQueries: correctionDates,
    },
    result: {
      ...counts,
      changedUnits,
      correctionMatches: corrections.length,
      provisionalTitles: [...provisionalTitles],
      outdatedParts,
    },
    timing: {
      elapsedMs,
      localLookup,
    },
    network: client.summary(),
  };
}

function round(value, digits = 1) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function compactResult(result) {
  return {
    strategy: result.strategy,
    concurrency: result.concurrency,
    requests: result.network.logicalRequests,
    attempts: result.network.httpAttempts,
    bytes: result.network.responseBytes,
    elapsedMs: round(result.timing.elapsedMs),
    medianRequestMs: round(result.network.medianRequestMs),
    p95RequestMs: round(result.network.p95RequestMs),
    rateLimits: result.network.rateLimits,
    currentParts: result.result.current,
    outdatedParts: result.result.outdated,
    unknownParts: result.result.unknown,
    changedUnits: result.result.changedUnits,
    correctionMatches: result.result.correctionMatches,
    titleDeltaQueries: result.gate.titleDeltaQueries.length,
    partDeltaQueries: result.gate.partDeltaQueries,
    local100kLookupsMs: round(result.timing.localLookup.milliseconds, 3),
  };
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${round(bytes / 1024)} KiB`;
  return `${round(bytes / (1024 * 1024), 2)} MiB`;
}

function printHuman(results) {
  const rows = results.map(compactResult);
  const headings = ["Strategy", "C", "Requests", "Bytes", "Elapsed", "P95 req", "429s", "Stale", "Unknown"];
  const table = rows.map(row => [
    row.strategy,
    String(row.concurrency),
    `${row.requests}/${row.attempts}`,
    formatBytes(row.bytes),
    `${row.elapsedMs} ms`,
    `${row.p95RequestMs} ms`,
    String(row.rateLimits),
    String(row.outdatedParts),
    String(row.unknownParts),
  ]);
  const widths = headings.map((heading, index) => Math.max(heading.length, ...table.map(row => row[index].length)));
  const render = row => row.map((cell, index) => cell.padEnd(widths[index])).join("  ");
  console.log(render(headings));
  console.log(render(widths.map(width => "-".repeat(width))));
  for (const row of table) console.log(render(row));

  const last = results.at(-1);
  console.log(`\nCoverage: ${last.coverage.titles} titles, ${last.coverage.parts} parts.`);
  console.log("Requests are based only on that fixed coverage and its embedded snapshot dates.");
  console.log(`Local cache benchmark: 100,000 part lookups in ${round(last.timing.localLookup.milliseconds, 3)} ms.`);
  if (last.result.outdatedParts.length) {
    console.log("\nParts with post-snapshot changes in the final run:");
    for (const part of last.result.outdatedParts) {
      const units = [...new Set(part.changes.map(change => change.identifier || change.section || change.reference).filter(Boolean))];
      console.log(`  ${part.title} CFR part ${part.part}: ${units.join(", ") || "title/part-level change"}`);
    }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  const corpus = loadCorpus(options.corpus);
  const configurations = options.suite
    ? [
        { strategy: "gated-title", concurrency: 1 },
        { strategy: "gated-title", concurrency: 3 },
        { strategy: "gated-title", concurrency: 6 },
        { strategy: "fixed-title", concurrency: 1 },
        { strategy: "fixed-title", concurrency: 3 },
        { strategy: "fixed-title", concurrency: 6 },
        { strategy: "per-part", concurrency: 6 },
      ]
    : Array.from({ length: options.runs }, () => ({ strategy: options.strategy, concurrency: options.concurrency }));
  const results = [];
  for (const configuration of configurations) {
    results.push(await scanCorpus(corpus, { ...options, ...configuration }));
    if (configurations.length > 1) await sleep(250);
  }
  if (options.json) console.log(JSON.stringify({ measuredAt: new Date().toISOString(), results }, null, 2));
  else printHuman(results);
}

main().catch(error => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
