# Automatic Title 8 update candidates

The `Update Title 8 corpus` GitHub Action checks OLRC daily at 11:23 UTC. It also
supports **Actions → Update Title 8 corpus → Run workflow**. Checking the
publisher does not change the adopted corpus.

When OLRC publishes a different Title 8 release or replaces the XML bytes at
the same release, the workflow:

1. Opens one tracking issue for that XML digest and assigns/mentions the public
   notification login. This reports a detected change even if its build fails.
2. Builds a candidate in an isolated directory using the existing INASearch
   corpus pipeline and correction rules.
3. Verifies source hashes, crosswalk consistency, unchanged-section citation
   behavior, reviewed historical corrections, and citation regression tests.
4. Opens a bot-authored pull request containing the captured XML/ZIP, generated
   corpus layers, and both usable standalone HTML editions. The tracking issue
   links the PR and workflow evidence.

Review and merge the PR to adopt it. There is no automatic merge or deployment.
The resulting `INASearch.html` contains the updated Title 8 corpus. Previously
downloaded copies of the app need to be replaced/reloaded from the updated
distribution; the browser's existing automatic updater remains CFR-only.

## Activation

The workflow, tools, and the current corpus/build dependencies must be committed
and pushed to the default branch before scheduled checks exist on GitHub.

In **Settings → Actions → General → Workflow permissions**, enable **Allow
GitHub Actions to create and approve pull requests**. The workflow requests
`contents: write`, `issues: write`, and `pull-requests: write` explicitly, so the
repository-wide default can remain read-only. The bot never approves a PR.
GitHub documents this setting in [Actions repository settings](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository).

The default recipient is the repository owner's **public GitHub username**.
To choose another account,
set the Actions repository variable `TITLE8_NOTIFY_LOGIN` to a public username
that can be assigned issues in the repository. An organization-owned fork must
set it to an individual account. Do not put an email address in this variable.

In your private [GitHub notification settings](https://github.com/settings/notifications):

- Enable **Email** for participating conversations/mentions, including issue
  assignments. Choose the verified email account to receive them there.
- Optionally enable **Actions → Email → Only notify for failed workflows**
  for infrastructure failures that prevent the issue notification itself.
- Keep this repository unmuted and do not unsubscribe from its update issues.

The workflow cannot enable personal email preferences or guarantee mail
delivery. GitHub routes these messages privately; see [notification configuration](https://docs.github.com/en/subscriptions-and-notifications/get-started/configuring-notifications)
and [Actions notification settings](https://docs.github.com/en/subscriptions-and-notifications/how-tos/managing-github-actions-notifications).
An unchanged source sends no update issue/comment. Ready/blocked transitions
send one status comment. A failed or dismissed candidate is not rebuilt every
day: use the manual **rebuild** option after addressing its failure. An
interrupted check that only reached initial detection is retried automatically.

Public repository schedules may be disabled after **60 days without repository
activity**, and scheduled jobs may be delayed. Check that the workflow remains
enabled if the repository is dormant; see [scheduled workflow behavior](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule).

## Cost and privacy

The workflow uses a standard Ubuntu runner. GitHub's standard hosted runner
minutes are free for public repositories. For private GitHub Free repositories,
the included allowance is 2,000 minutes/month and 500 MB artifact storage,
shared with other usage. Artifacts expire after seven days and are uploaded
only for changed sources, explicit replay, or failures. Check usage if other
workflows share the account. See [GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions).

Only the built-in, short-lived `GITHUB_TOKEN` is used. No personal access token,
SMTP password, email address, account profile lookup, or local Git identity is
needed. Bot commits explicitly use GitHub's public bot noreply identity. The
candidate file allowlist excludes profile data, settings, credentials, arbitrary
files, and workflow changes. Publication validates each exported file hash.
Neither command uploads files when run locally; the publication helper requires
the GitHub Actions environment.

## What happens to our correction rules

`tools/title8_update/uslm.py` reads explicit USLM structure. It does not turn
parenthesized citations into child nodes. The existing `tools/statute-run-ins.js`
then reconstructs real inline subdivisions, and `tools/legal-references.js`
applies the existing reference resolver, source-authored links, and editorial
correction patterns. The updater does not maintain a separate parser.

Most nested-child and citation fixes are general parsing/context rules. Some
exceptions are intentionally specific: reviewed historical references match
exact source text hashes/spans, and historical/status supplements encode
reviewed dispositions. The build rejects stale reviewed historical locators.
The updater also checks that all 72 currently reviewed locators reapply and
that unchanged source sections retain their corrected addresses and targets.
The count is measured from the manifest, not hardcoded in the gate.

House footnote counts are measured per release and checked for consistent
reconstruction/application. A later release may add or remove footnotes. The
importer rejects unidentified or mismatched numbered units so their footnotes
cannot be silently left inside the operative text.

New structural tags, operative tables/images requiring new rendering support,
changed section dispositions, missing crosswalk evidence, new uncaptured
external U.S. Code targets, changed reviewed historical passages, or failed
regressions block the candidate. The tracking issue reports that review is
needed. The last adopted app stays intact. A publisher maintenance page is an
unavailable-source error, never a successful “no change” check.

Only **Title 8** is refreshed. The INA crosswalk/compilation and the other-title
2024 U.S. Code excerpts retain their independent capture dates and are
revalidated. The updater does not claim to refresh those sources or to discover
new INA crosswalk pairings automatically. OLRC publication also follows its
own release schedule; detecting its latest XML is not an immediate enacted-law
alert.

## Local commands

Install the locked Node dependencies once with `npm ci --ignore-scripts`.
No Python packages are required.

```sh
python3 tools/update-title8.py check --output tmp/title8-check
python3 tools/update-title8.py build --check-dir tmp/title8-check --output tmp/title8-candidate
```

Use a fresh output directory for every build. The commands preserve the working
corpus. A successful output contains `report.json`, `build.log`, `files.json`
with hashes, and `candidate/` with only the files needed for the proposed update.
A failed output has no adoptable `files.json`.

Offline commissioning with the original captured release:

```sh
python3 tools/update-title8.py check --zip sources/legal/raw/xml_usc08@119-102.zip --release 119-102 --output tmp/title8-offline-check
python3 tools/update-title8.py build --check-dir tmp/title8-offline-check --output tmp/title8-offline-candidate
```

Offline candidates are marked as replays and the GitHub publisher refuses to
open PRs for them. After adopting a newer release, use that release's captured
ZIP for an offline replay; older sources are rejected as downgrades.

```sh
python3 tools/test-title8-update.py
node tools/test-title8-update.js
node tools/test-title8-update-github.js
```

The GitHub test uses a temporary local bare Git repository and mocked REST
calls. It covers a successful branch push followed by a failed PR request and
retry, without sending notifications or writing to GitHub.

The candidate gate runs the citation/preview regressions listed in
`tools/title8_update/pipeline.py` and compares corrected fields against a build
from the currently adopted source. Run `npm test` for the main application suite.
