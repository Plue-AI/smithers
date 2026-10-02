# C-GH-07 Freshness: PR, checks and `main` within 60 s, issues within 5 min

Proves: mvp.md §6.3 "No public address", §9 "GitHub freshness", J10.6, M-03 · spec.md §12.2, §12.2.3, §18 · Layer: e2e · Stage: S1 · Tickets: T-GH-02
Automation: `scripts/perf/github-freshness.ts` (new) · Runs in: reference host

## Setup
- Reference host, install at the commit under test, App installed on `smithers-mvp-canary/<date>`. The App's webhook is inactive and `github_webhook_jobs` is empty.
- Stack with three TODOs In review, PRs open. One TODO PR head carries a commit status `freshness/hold` = `pending`, so its checks stay pending and polled.
- 100 open issues in the repository.
- A second GitHub account (a member) with a token for the harness. The harness runs on the reference host; both timestamps come from its wall clock (NTP-synced).
- No other load on the host.

## Steps
1. Start the harness. It subscribes to `/api/live` topics `home` and `todo:<n>` for the three TODOs.
2. Every 20 s, for sample i, it makes four changes as the second account and records t0 when GitHub returns 2xx:
   - main: push a fast-forward commit to `main` adding `freshness/<i>.txt`;
   - PR: submit an "approved" review on TODO PR (i mod 3);
   - checks: post commit status `freshness/<i>` = `success` on the pending head;
   - issue: edit issue (i mod 100)'s body to include `freshness-<i>`.
3. For each change it records t1, the time of the first delta or API read that shows it: the `home` `main.sha`; the `todo:<n>` PR `reviews`; the `todo:<n>` PR `checks`; the issue read that returns the new body.
4. Continue until n = 100 samples per kind, then stop and wait 10 min for stragglers.

## Pass when
- n = 100 per kind, and every change is observed.
- p95 of t1 − t0 ≤ 60 s for main, PR and checks; ≤ 300 s for issues.
- No webhook delivery is received during the run, and no Retry is pressed.
- The host's GitHub REST count for the run, scaled to one hour, is under 1,000.

## Fail when
- A sample is never observed, or is observed only after a Retry.
- t0 or t1 is taken from GitHub's timestamps (clock skew hides latency).
- The checks sample is seen only because a new head arrived (the pending head isn't polled).
- Freshness depends on webhooks or a public address.

## Evidence
`.artifacts/checks/C-GH-07/<UTC timestamp>/`: `samples.csv` (kind, i, t0, t1, delta), `summary.json` (n, p50, p95, max per kind), the host's REST call counters, the App's hook config, host logs, the commit and install version.
