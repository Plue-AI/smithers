# C-GH-08 Budget: under 1,000 REST calls/h with 10 open TODO PRs and 100 issues

Proves: mvp.md §6.3 "No public address", M-03 · spec.md §3.0, §12.2, §12.2.1, §12.2.2, E-08 (overview) · Layer: integration · Stage: S1 · Tickets: T-GH-02
Automation: `packages/backend/internal/services/github_sync_integration_test.go` (new) · Runs in: CI

## Setup
- Real PostgreSQL. `githubfake` serving one repository: 11 open TODO PRs in stack order T1 to T11 (each linked to a TODO In review), 100 open issues, 2,000 closed issues and PRs, 500 comments. It returns ETags, honors `If-None-Match` with 304, reports `X-RateLimit-Limit: 5000` and a falling `X-RateLimit-Remaining`, and counts every request by stream, status and token mint. Check-runs payloads change while checks progress.
- The scheduler under an injected clock; the test advances it in 1 s ticks.
- A scripted activity tape for hour 1:
  - minute 0: T1 merges, so `main` moves and the 10 remaining PRs are force-updated with all their checks pending for 15 min (§12.2.1a);
  - 10 more PR head pushes, 30 review or conversation comments on TODO PRs, and 3 later windows of 10 min with the first item's checks pending;
  - 20 issue edits, 5 of which add the `todo` label (3 by members, 2 by a non-member);
  - one further `main` move every 10 min.

## Steps
1. Hour 1: play the tape and advance 3,600 s.
2. Hour 2: advance 3,600 s with no changes.
3. Hour 3: at minute 10 set `X-RateLimit-Remaining` to 900; at minute 20 answer the pulls stream once with 429 and `Retry-After: 300`; reset the limit at minute 40.
4. Stop the scheduler, start a new one against the same database and fake server, and advance 120 s.

## Pass when
- Hour 1: total REST requests, token mints included and git excluded, < 1,000. Per stream, at most the §12.2 caps: pulls 60, review comments 60, conversation comments 60, reviews 60, checks 240, issues 30, issue events 5 (one per labeled issue), members' permission 8.
- During the 15 min after the merge, check-runs for T2 (now first) are requested every 60 s and for each of T3 to T11 every 120 s (§12.2.1a); a head drops out of the rotation once its checks settle.
- Each of the 5 label events lands in the synced store with its actor and event id; no issue without a new `todo` label gets an events request.
- Every request after a stream's first carries `If-None-Match` equal to the last ETag it received.
- Every scripted change lands in the `github_synced_*` store (§3.0) within its stream's cadence + 1 s of simulated time, and each pending check within its post-merge cadence + 1 s.
- Hour 2: ≥ 90 % of REST responses are 304; no token is minted more than once per permission set except within 5 min of expiry.
- Hour 3: from minute 10 to 40 every cadence is doubled; the 429 pauses only the pulls stream, for 300 s; `github_sync.last_error` for pulls has class `rate_limited` and `retry_at` 300 s out.
- Step 4: the first request of every stream is conditional and gets 304; no stream lists from its beginning.

## Fail when
- Any per-PR poll appears (`GET /pulls/{n}` or `/pulls/{n}/comments` per item per minute).
- All 10 pending heads are polled at 60 s after the merge, or the hour passes 1,000 because of them.
- A `since` cursor of "now" makes every URL new, so no 304 arrives.
- A scoped token is minted per call.
- A stack write or merge read bypasses the budget, or a rate limit on one stream pauses all streams.

## Evidence
`.artifacts/checks/C-GH-08/<UTC timestamp>/`: `requests.jsonl` from the fake server, `counts.json` per stream and hour, `intervals.json` per stream and per PR head for the post-merge window, `github_sync` rows after each hour, the test log and the commit.
