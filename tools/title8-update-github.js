#!/usr/bin/env node
"use strict";
// No account/profile/email API is used. GitHub privately routes notifications.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const RELEASE = /^\d+-\d+(?:not\d+-\d+)*$/;
const FIXED_FILES = new Set([
  "src/INASearch-Corpus.js", "src/INASearch-Statute-Footnotes.js", "src/INASearch-Statute-References.js",
  "src/INASearch-INA-Hierarchy.js", "sources/legal/source-manifest.json", "sources/legal/ina-crosswalk-audit.json",
  "sources/legal/referenced-usc/corpus.json", "sources/legal/referenced-usc/selection.json",
  "INASearch.html", "INASearch-Uncompressed.html"
]);
function validateConfig(config) {
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(config.repository)) throw new Error("Invalid repository");
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(config.login)) throw new Error("Notification recipient must be a public GitHub login");
  if (!config.runUrl.startsWith(`https://github.com/${config.repository}/actions/runs/`) || !/\/\d+$/.test(config.runUrl)) throw new Error("Invalid workflow run URL");
  return config;
}
function validateReport(report) {
  if (!RELEASE.test(report.release) || !/^[a-f0-9]{64}$/.test(report.xmlSha256)) throw new Error("Invalid source report");
}
function allowedPath(file, release) {
  return RELEASE.test(release) && (FIXED_FILES.has(file) || file === `sources/legal/raw/usc08@${release}.xml` || file === `sources/legal/raw/xml_usc08@${release}.zip`);
}
function candidateBranch(report) {
  validateReport(report);
  return `codex/title8-${report.release}-${report.xmlSha256.slice(0, 12)}`;
}
function client(token) {
  if (!token) throw new Error("GITHUB_TOKEN is required");
  return async (method, route, body) => {
    const response = await fetch(`https://api.github.com${route}`, {
      method, headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000)
    });
    if (!response.ok) throw new Error(`GitHub ${method} failed (${response.status}); check workflow permissions`);
    return response.status === 204 ? null : response.json();
  };
}
async function findIssue(marker, config, api) {
  for (let page = 1; ; page++) {
    const issues = await api("GET", `/repos/${config.repository}/issues?state=all&creator=github-actions%5Bbot%5D&per_page=100&page=${page}`);
    const found = issues.find(issue => !issue.pull_request && issue.body?.includes(marker));
    if (found || issues.length < 100) return found;
  }
}
async function notify(report, config, api) {
  validateConfig(config);
  const unavailable = report.status === "unavailable";
  if (!unavailable) validateReport(report);
  const marker = `<!-- inasearch-title8:${unavailable ? "source-unavailable" : report.xmlSha256} -->`;
  const existing = await findIssue(marker, config, api);
  const previousState = existing?.body?.match(/<!-- title8-state:(\w+) -->/)?.[1];
  // A detected digest already attempted stays quiet until explicit manual retry.
  const sameResult = previousState === report.status && (report.status !== "ready" || !report.pullRequest || existing?.body?.includes(report.pullRequest));
  if (existing && (!unavailable || existing.state !== "closed") && (report.status === "detected" || sameResult)) {
    return { buildNeeded: report.status === "detected" && previousState === "detected", issue: existing.number };
  }
  const state = `<!-- title8-state:${report.status} -->`;
  const summary = unavailable
    ? "The OLRC Title 8 source could not be checked. The adopted corpus has not changed."
    : `OLRC Title 8 release **${report.release}**, XML SHA-256 \`${report.xmlSha256}\`.\n\n` + ({
      detected: "A changed official source was detected. A corrected candidate will now be generated and tested.",
      ready: "The corrected candidate passed the update gates and is ready for review.",
      blocked: "The source changed, but candidate generation or publication failed. Review is required; the adopted corpus has not changed."
    }[report.status] || "The source check completed.");
  const body = `${marker}\n${state}\n${existing ? "" : `@${config.login}\n\n`}${summary}\n\n[Workflow run](${config.runUrl})` +
    (report.pullRequest ? `\n\n[Review candidate](${report.pullRequest})` : "") +
    "\n\nGitHub delivers email according to your private notification settings. No email address is stored by this updater.";
  if (!existing) {
    const issue = await api("POST", `/repos/${config.repository}/issues`, {
      title: unavailable ? "Title 8 source check needs attention" : `Title 8 update: ${report.release} (${report.xmlSha256.slice(0, 12)})`,
      body, assignees: [config.login]
    });
    return { buildNeeded: !unavailable, issue: issue.number };
  }
  await api("PATCH", `/repos/${config.repository}/issues/${existing.number}`, { body, ...(unavailable ? { state: "open" } : {}) });
  // Body edits alone need not generate email. A single status-change comment
  // notifies subscribers when the candidate is ready or blocked.
  await api("POST", `/repos/${config.repository}/issues/${existing.number}/comments`, {
    body: `${summary}\n\n[Workflow run](${config.runUrl})` + (report.pullRequest ? `\n[Review candidate](${report.pullRequest})` : "")
  });
  return { buildNeeded: false, issue: existing.number };
}
async function recover(config, api) {
  const issue = await findIssue("<!-- inasearch-title8:source-unavailable -->", config, api);
  if (issue?.state === "open") {
    await api("POST", `/repos/${config.repository}/issues/${issue.number}/comments`, { body: `OLRC checks are working again. [Workflow run](${config.runUrl})` });
    await api("PATCH", `/repos/${config.repository}/issues/${issue.number}`, { state: "closed" });
  }
}
async function propose(directory, config, api) {
  if (process.env.GITHUB_ACTIONS !== "true") throw new Error("Automatic publication runs only inside GitHub Actions");
  const reportFile = path.join(directory, "report.json");
  const report = JSON.parse(fs.readFileSync(reportFile, "utf8"));
  validateReport(report);
  if (report.status !== "ready" || report.offlineReplay) throw new Error("Only a tested live-source candidate may be proposed");
  const files = JSON.parse(fs.readFileSync(path.join(directory, "files.json"), "utf8"));
  if (!files.length || new Set(files.map(file => file.path)).size !== files.length) throw new Error("Empty/duplicate candidate files");
  const loaded = files.map(file => {
    if (!allowedPath(file.path, report.release)) throw new Error("Unexpected candidate path");
    const source = path.join(directory, "candidate", file.path);
    if (!fs.lstatSync(source).isFile()) throw new Error("Candidate must contain regular files");
    const data = fs.readFileSync(source);
    if (data.length !== file.bytes || crypto.createHash("sha256").update(data).digest("hex") !== file.sha256) throw new Error("Candidate file checksum mismatch");
    return { path: file.path, data };
  });
  const git = args => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const bundleHash = crypto.createHash("sha256").update(JSON.stringify(files.map(file => [file.path, file.sha256]).sort())).digest("hex");
  const branch = `${candidateBranch(report)}-${bundleHash.slice(0, 12)}-${git(["rev-parse", "--short=7", "HEAD"])}`;
  const base = process.env.TITLE8_BASE_BRANCH;
  if (!base || !/^[A-Za-z0-9_./-]+$/.test(base) || base.startsWith("-")) throw new Error("Missing/invalid default branch");
  if (git(["status", "--porcelain", "--untracked-files=no"])) throw new Error("Publication checkout must be clean");
  const prs = await api("GET", `/repos/${config.repository}/pulls?state=all&head=${encodeURIComponent(config.repository.split("/")[0] + ":" + branch)}&per_page=100`);
  if (prs.length) {
    report.pullRequest = prs[0].html_url;
    fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + "\n");
    return report;
  }
  const remoteBranch = git(["ls-remote", "--heads", "origin", `refs/heads/${branch}`]);
  git(["checkout", "-b", branch]);
  for (const file of loaded) {
    fs.mkdirSync(path.dirname(file.path), { recursive: true });
    fs.writeFileSync(file.path, file.data);
  }
  git(["add", "--", ...loaded.map(file => file.path)]);
  if (remoteBranch) {
    // Resume after a successful push followed by a failed PR API request.
    // Verify the complete tree, not just a claimed release in the commit text.
    git(["fetch", "--no-tags", "origin", `refs/heads/${branch}`]);
    if (git(["write-tree"]) !== git(["rev-parse", "FETCH_HEAD^{tree}"])) throw new Error("Existing candidate branch differs; manual review required");
  } else {
    // Always override both identities; never inherit an operator's local email.
    const identity = { ...process.env, GIT_AUTHOR_NAME: "github-actions[bot]", GIT_COMMITTER_NAME: "github-actions[bot]",
      GIT_AUTHOR_EMAIL: "41898282+github-actions[bot]@users.noreply.github.com", GIT_COMMITTER_EMAIL: "41898282+github-actions[bot]@users.noreply.github.com" };
    execFileSync("git", ["commit", "-m", `Update Title 8 to OLRC ${report.release}`], { env: identity, stdio: "pipe" });
    // No force push: an existing branch is evidence to review, never overwrite it.
    git(["push", "origin", `HEAD:refs/heads/${branch}`]);
  }
  const pr = await api("POST", `/repos/${config.repository}/pulls`, {
    title: `Update Title 8 to OLRC ${report.release}`, head: branch, base,
    body: `Updates the captured official Title 8 USLM and regenerates the corpus through the existing footnote, hierarchy, run-in and reference correction pipeline.\n\nXML SHA-256: \`${report.xmlSha256}\`.\n\nOperative sections changed: ${report.changedOperativeSections.join(", ") || "none"}.\n\nValidation: source integrity, crosswalk audit, unchanged-section citation comparison, and ${report.gates.length} recorded gates. [Build and checks](${config.runUrl}).\n\nIndependent review is required before merging. Other source editions remain unchanged.`
  });
  report.pullRequest = pr.html_url;
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + "\n");
  return report;
}
async function main() {
  const config = validateConfig({ repository: process.env.GITHUB_REPOSITORY, login: process.env.TITLE8_NOTIFY_LOGIN || process.env.GITHUB_REPOSITORY_OWNER,
    runUrl: `https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` });
  const api = client(process.env.GITHUB_TOKEN);
  const [command, file] = process.argv.slice(2);
  if (command === "propose") { await propose(file, config, api); return; }
  const report = JSON.parse(fs.readFileSync(file, "utf8"));
  if (command === "blocked") report.status = "blocked";
  if (report.status === "current") { await recover(config, api); return; }
  if (report.status === "detected") await recover(config, api);
  const result = await notify(report, config, api);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `build_needed=${result.buildNeeded}\n`);
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { notify, recover, propose, validateConfig, allowedPath, candidateBranch };
