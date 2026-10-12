"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { notify, propose, validateConfig, allowedPath, candidateBranch } = require("./title8-update-github");
const report = { status: "detected", changed: true, release: "119-103", previousRelease: "119-102", xmlSha256: "a".repeat(64) };
const config = { repository: "example/INASearch", login: "example", runUrl: "https://github.com/example/INASearch/actions/runs/123" };
async function run() {
  const calls = [], issues = [];
  async function api(method, route, body) {
    calls.push({ method, route, body });
    if (method === "GET") return issues;
    if (method === "POST" && route.endsWith("/issues")) {
      const issue = { number: 1, html_url: "https://github.com/example/INASearch/issues/1", ...body };
      issues.push(issue); return issue;
    }
    if (method === "PATCH") { Object.assign(issues[0], body); return issues[0]; }
    return {};
  }
  assert.equal((await notify(report, config, api)).buildNeeded, true);
  assert.equal(calls.filter(c => c.method === "POST").length, 1);
  assert.deepEqual(issues[0].assignees, ["example"]);
  assert(!calls.some(call => /\/user(?:s)?\b|\/emails\b/.test(call.route)), "Never request account profile or email endpoints");
  assert.equal((await notify(report, config, api)).buildNeeded, true, "A cancelled detected run should be retried");
  await notify({ ...report, status: "ready", pullRequest: "https://github.com/example/INASearch/pull/2" }, config, api);
  const completedCalls = calls.filter(c => c.method !== "GET").length;
  assert.equal((await notify(report, config, api)).buildNeeded, false);
  assert.equal(calls.filter(c => c.method !== "GET").length, completedCalls, "Repeated daily detection must not edit or renotify");
  issues[0].body = "<!-- inasearch-title8:source-unavailable -->\n<!-- title8-state:unavailable -->";
  issues[0].state = "closed";
  await notify({ status: "unavailable" }, config, api);
  assert.equal(issues[0].state, "open", "A recurring publisher outage must reopen the alert");
  assert.throws(() => validateConfig({ ...config, login: "private@example.com" }), /login/);
  assert.throws(() => validateConfig({ ...config, repository: "../private" }), /repository/);
  assert(allowedPath("src/INASearch-Corpus.js", report.release));
  for (const file of ["../../.git/config", ".env", "src/INASearch-Profile.js", "sources/legal/raw/other.xml"]) assert(!allowedPath(file, report.release));
  assert.equal(candidateBranch(report), "codex/title8-119-103-aaaaaaaaaaaa");
  await publicationRetry();
  console.log("PASS GitHub updater: deduplication, public-login notifications, safe output paths, no account email access");
}
async function publicationRetry() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "title8-github-test-"));
  const cwd = process.cwd(), oldActions = process.env.GITHUB_ACTIONS, oldBase = process.env.TITLE8_BASE_BRANCH;
  const oldAuthorDate = process.env.GIT_AUTHOR_DATE, oldCommitterDate = process.env.GIT_COMMITTER_DATE;
  const git = (directory, args) => execFileSync("git", args, { cwd: directory, stdio: "pipe", encoding: "utf8" }).trim();
  try {
    const remote = path.join(temporary, "remote.git"), repo = path.join(temporary, "repo"), candidate = path.join(temporary, "output");
    fs.mkdirSync(repo);
    git(temporary, ["init", "--bare", remote]);
    git(repo, ["init", "-b", "main"]);
    fs.writeFileSync(path.join(repo, "README"), "fixture\n");
    git(repo, ["add", "README"]);
    git(repo, ["-c", "user.name=Test", "-c", "user.email=test@users.noreply.github.com", "commit", "-m", "Fixture"]);
    git(repo, ["remote", "add", "origin", remote]);
    git(repo, ["push", "origin", "main"]);
    fs.mkdirSync(path.join(candidate, "candidate/src"), { recursive: true });
    const data = Buffer.from("fixture corpus\n");
    fs.writeFileSync(path.join(candidate, "candidate/src/INASearch-Corpus.js"), data);
    fs.writeFileSync(path.join(candidate, "files.json"), JSON.stringify([{ path: "src/INASearch-Corpus.js", bytes: data.length, sha256: crypto.createHash("sha256").update(data).digest("hex") }]));
    fs.writeFileSync(path.join(candidate, "report.json"), JSON.stringify({ ...report, status: "ready", offlineReplay: false, changedOperativeSections: ["1101"], gates: [] }));
    process.chdir(repo); process.env.GITHUB_ACTIONS = "true"; process.env.TITLE8_BASE_BRANCH = "main";
    let postAttempts = 0;
    const api = async method => {
      if (method === "GET") return [];
      if (++postAttempts === 1) throw new Error("Simulated PR API outage after push");
      return { html_url: "https://github.com/example/INASearch/pull/2" };
    };
    process.env.GIT_AUTHOR_DATE = process.env.GIT_COMMITTER_DATE = "2026-10-12T00:00:00Z";
    await assert.rejects(propose(candidate, config, api), /Simulated/);
    // Reproduce a new Actions checkout after the first branch push succeeded.
    git(repo, ["checkout", "main"]);
    for (const branch of git(repo, ["branch", "--format=%(refname:short)"]).split("\n")) if (branch !== "main") git(repo, ["branch", "-D", branch]);
    process.env.GIT_AUTHOR_DATE = process.env.GIT_COMMITTER_DATE = "2026-10-13T00:00:00Z";
    const result = await propose(candidate, config, api);
    assert.equal(postAttempts, 2, "Retry must reach PR creation without a divergent push");
    assert.equal(result.pullRequest, "https://github.com/example/INASearch/pull/2");
  } finally {
    process.chdir(cwd);
    if (oldActions === undefined) delete process.env.GITHUB_ACTIONS; else process.env.GITHUB_ACTIONS = oldActions;
    if (oldBase === undefined) delete process.env.TITLE8_BASE_BRANCH; else process.env.TITLE8_BASE_BRANCH = oldBase;
    if (oldAuthorDate === undefined) delete process.env.GIT_AUTHOR_DATE; else process.env.GIT_AUTHOR_DATE = oldAuthorDate;
    if (oldCommitterDate === undefined) delete process.env.GIT_COMMITTER_DATE; else process.env.GIT_COMMITTER_DATE = oldCommitterDate;
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
