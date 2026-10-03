# C-GH-08 Budget: at most 1,000 charged and 1,500 raw requests/h with ten pending TODO PRs and 100 issues

Proves: mvp.md §6.3 "No public address", M-03 · spec.md §3.0, §10.2.1a, §12.2, §12.2.1, §12.2.1a, §12.2.2, §12.2.4, E-08 (overview) · Layer: integration · Stage: S1 · Tickets: T-GH-02
Automation: `packages/backend/internal/services/github_sync_integration_test.go` (new) · Runs in: CI

## Setup
- Real PostgreSQL. `githubfake` serving one repository: 11 open TODO PRs in stack order T1 to T11 (each linked to a TODO In review), 100 open issues, 2,000 closed issues and PRs, 500 comments, and 10 members. It returns ETags, honors `If-None-Match` with 304, reports `X-RateLimit-Limit: 5000` and a falling `X-RateLimit-Remaining`, and counts every request by stream, status, token mint, raw and charged. It serves the `pr-state` GraphQL query and the repository issue-events list. Check-runs payloads change while checks progress.
- The scheduler under an injected clock; the test advances it in 1 s ticks.
- A scripted activity tape for hour 1:
  - minute 0: T1 merges, so `main` moves and the 10 remaining PRs are force-updated with all their checks pending for 15 min;
  - 10 more PR head pushes, 30 review or conversation comments on TODO PRs, and 3 later windows of 10 min with the first item's checks pending;
  - 20 issue edits; 5 `todo` labels (3 by members, 2 by a non-member); and on a sixth issue, a member removes and reapplies `todo` within one 120 s window;
  - one further `main` move every 10 min.

## Steps
- Adopted T-GH-02 boundary cases: Crash before fetch commit, after commit before dispatch and after consumer effects before acknowledgement; restart and assert no lost delivery or duplicate effective state change. Consumer failures retry the stable identity. Independently count direct repository reads and token mint requests in the shared budget. Start both install and hosted compositions and assert replacement only in install and retained hosted workers

1. Hour 1: play the tape and advance 3,600 s.
2. Hour 2: advance 3,600 s with no changes.
3. Hour 3: at minute 10 set `X-RateLimit-Remaining` to 900; at minute 20 answer the pulls stream once with 429 and `Retry-After: 300`; reset the limit at minute 40.
4. Hour 4, stress: every list and query response changes on every request (each list gains a row, each check context changes), and the install has a public URL with webhooks configured, while every signed delivery is dropped before it reaches the host.
5. Stop the scheduler, start a new one against the same database and fake server, and advance 120 s.

## Pass when
- Commit fetched github_synced_* cache rows, cursor/ETag and pending consumer-delivery records in one transaction. Persist a stable identity per stream/object version or issue event id and consumer. Consumers commit their receipt and effects atomically, then acknowledge delivery; failures and restart retry the same identity. Route every install GitHub request through shared budget admission and accounting, including direct user-repository transports, repository-list reads and installation-token minting. Install startup alone replaces old workers; hosted Plue startup retains its existing workers

- Hour 1: charged ≤ 1,000 and raw ≤ 1,500, token mints, admission reads and writes included and git excluded. Per stream, raw requests stay within the §12.2 worst case: pulls, `pr-state`, review comments and conversation comments 80 each; issues 30; issue events 30; members' permission 10.
- During the 15 min after the merge, every check change on all ten pending heads lands in the store within 45 s + 1 s of simulated time, through `pr-state` alone: no per-PR or per-head REST request appears.
- Each `labeled` event lands in the synced store once, in event-id order, with its actor and event id, including both events of the remove-and-reapply; no per-issue events request appears.
- Every request after a stream's first carries `If-None-Match` equal to the last ETag it received.
- Every scripted change lands in the `github_synced_*` store (§3.0) within its stream's cadence + 1 s of simulated time.
- Hour 2: ≥ 90 % of REST responses are 304; no token is minted more than once per permission set except within 5 min of expiry.
- Hour 3: from minute 10 to 40 the issues, issue-events and permission cadences are doubled, and refs, pulls, `pr-state` and the comment streams keep theirs; the 429 pauses only the pulls stream, for 300 s; `github_sync.last_error` for pulls has class `rate_limited` and `retry_at` 300 s out.
- Hour 4: polling requests total at most 400, each charged (§12.2.2: 392 with ten PRs and ten members); every required stream still lands each change within its cadence + 1 s; no cadence stretches.
- Step 5: the first REST request of every stream is conditional and gets 304; no stream lists from its beginning.

## Fail when
- Any per-PR or per-head poll appears (`GET /pulls/{n}`, `/pulls/{n}/comments`, `/pulls/{n}/reviews`, `/commits/{sha}/check-runs` or `/commits/{sha}/status`).
- A pending head's check change lands later than 46 s after it, or an hour passes either budget.
- A `since` cursor of "now" makes every URL new, so no 304 arrives.
- A scoped token is minted per call.
- A stack write or merge read bypasses the budget, or a rate limit on one stream pauses all streams.
- A cadence stretches because webhooks are configured, or a label removed and reapplied between polls is missed.

## Evidence
`.artifacts/checks/C-GH-08/<UTC timestamp>/`: `requests.jsonl` from the fake server, `counts.json` (raw and charged) per stream and hour, `intervals.json` per stream and per PR head for the post-merge window, `github_sync` rows after each hour, the test log and the commit.
