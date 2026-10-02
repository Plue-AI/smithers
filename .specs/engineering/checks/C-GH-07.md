# C-GH-07 Freshness: PR, checks and `main` within 60 s, issues within 5 min, with ten pending PRs and webhooks off or dropped

Proves: mvp.md §6.3 "No public address", §9 "GitHub freshness", J10.6, M-03 · spec.md §12.2, §12.2.1a, §12.2.3, §12.2.4, §18 · Layer: e2e · Stage: S1 · Tickets: T-GH-02
Automation: `scripts/perf/github-freshness.ts` (new) · Runs in: reference host

## Setup
- Reference host, install at the commit under test, App installed on `smithers-mvp-canary/<date>`. The App's webhook is inactive and `github_webhook_jobs` is empty.
- Stack with ten TODOs In review, PRs open. Every TODO PR head carries a commit status `freshness/hold` = `pending`, so all ten heads have pending checks.
- 100 open issues in the repository.
- A second GitHub account (a member) with a token for the harness. The harness runs on the reference host; both timestamps come from its wall clock (NTP-synced).
- No other load on the host.

## Steps
1. Start the harness. It subscribes to `/api/live` topics `home` and `todo:<n>` for the ten TODOs.
2. Every 20 s, for sample i, it makes four changes as the second account and records t0 when GitHub returns 2xx:
   - main: push a fast-forward commit to `main` adding `freshness/<i>.txt`;
   - PR: submit an "approved" review on TODO PR (i mod 10);
   - checks: post commit status `freshness/<i>` = `success` on pending head (i mod 10);
   - issue: edit issue (i mod 100)'s body to include `freshness-<i>`.
3. For each change it records t1, the time of the first delta or API read that shows it: the `home` `main.sha`; the `todo:<n>` PR `reviews`; the `todo:<n>` PR `checks`; the issue read that returns the new body.
4. Continue until n = 100 samples per kind, then stop and wait 10 min for stragglers.
5. Phase 2, dropped webhooks: set a public URL in Settings, make the App's webhook active and point it at an address that answers 503 to every delivery. Repeat steps 2–4 with fresh sample numbers.

## Pass when
- n = 100 per kind in each phase, and every change is observed.
- In each phase, p95 of t1 − t0 ≤ 60 s for main, PR and checks; ≤ 300 s for issues. Phase 2's p95 is no worse than phase 1's by more than 5 s.
- No webhook delivery reaches the host in either phase, and no Retry is pressed.
- The host's GitHub request counts for the run, scaled to one hour, are at most 1,000 charged and 1,500 raw (§12.2.2), and the log shows no per-head check-runs or status request.

## Fail when
- A sample is never observed, or is observed only after a Retry.
- t0 or t1 is taken from GitHub's timestamps (clock skew hides latency).
- The checks sample is seen only because a new head arrived (the pending head isn't polled).
- Freshness depends on webhooks or a public address.
- A cadence stretches once webhooks are configured, so a dropped delivery slows freshness.

## Evidence
`.artifacts/checks/C-GH-07/<UTC timestamp>/`: `samples.csv` (kind, i, t0, t1, delta), `summary.json` (n, p50, p95, max per kind), the host's raw and charged counters per stream, the `pr-state` query durations, the App's hook config, host logs, the commit and install version.
