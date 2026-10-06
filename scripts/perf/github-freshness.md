# GitHub freshness runner (C-GH-07)

Run only on the reference host against an authorized canary repository. This
operator runner writes GitHub as the second member account; it is never a
product action. It creates fast-forward main commits, approves PRs, posts
statuses on existing heads, and appends markers to issue bodies. It does not
merge PRs, press Retry, or configure webhooks.

Set `SMITHERS_FRESHNESS_GITHUB_TOKEN` to the second member's GitHub token and
`SMITHERS_FRESHNESS_INSTALL_TOKEN` to an install API token. Run
`bun scripts/perf/github-freshness.ts <config.json> <new-evidence-directory>`.
The parent directory must already exist. Repeat with a fresh directory and
`phase: "dropped"` after configuring the App webhook to an external 503 sink.
Keep the sink logs, App hook configuration and host logs with the evidence;
the runner cannot authenticate these conditions itself.

Configuration includes `repository` (`owner/canary`), `origin` (install URL),
`run` (unique alphanumeric marker), `phase` (`inactive` or `dropped`), ten
`pulls` entries (`number`, `todo`, `head`), and 100 distinct issue numbers in
`issues`. All ten PRs must be open at the listed heads with `freshness/hold`
pending. `observe` has `main`, `pr`, `checks`, and `issue` entries, each with
an install `/api/` path and JSON pointer. Paths may contain `{todo}` or
`{issue}`. Select the main SHA, review objects including GitHub review IDs,
named check contexts, and issue body respectively. These must be production
projections; direct GitHub reads are not observations. Missing projections
refuse before any write. Current TODO PR cards do not expose aggregate review
IDs or check contexts, so the real run still waits on T-GH-03/T-GH-04.

For example, the issue observation is
`{"path":"/api/issues/{issue}","pointer":"/body"}` where the install's
issue response provides that field. Use the actual response's pointer if the
owner endpoint wraps its payload. Do not substitute seeded app cards.

Each phase launches 100 samples per kind, targeting a 20-second sample interval,
polls production reads each second, and allows ten minutes for stragglers.
Network calls have a 15-second timeout; actual work can delay the target
interval. Both timestamps use the runner's local wall clock. Retain the host's
NTP qualification separately. `events.jsonl` journals each successful mutation
before the next mutation and each observation, including samples if a later
request fails. `results/samples.csv` and `results/summary.json` contain local
timestamps, missing counts, nearest-rank p50/p95/max and per-kind thresholds.
An ambiguous write fails the run without retrying; inspect the canary before
starting a new run. No credentials are copied to artifacts.

Use `bun scripts/perf/github-freshness.ts --compare <inactive-summary.json>
<dropped-summary.json>` to require
100 observations of every kind in both phases and dropped p95 no more than
five seconds worse. Runner success measures timing only, not an approved
C-GH-07 receipt. Add the tested commit/install version, raw and charged host
counters per stream, PR-state query durations, webhook and reference-host
receipts. The ticket supersedes C-GH-07's legacy hourly caps and prohibition
on per-head REST reads; neither is enforced here. No check mapping is activated.

Validation: `node --test scripts/perf/github-freshness.test.mjs` uses an HTTP
fixture only, with no real GitHub writes. It does not qualify macOS, the native
engine, real GitHub timings, or the missing aggregate projections.
