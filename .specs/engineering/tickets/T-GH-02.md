# T-GH-02 Poll scheduler: streams, ETags, token cache, budget, 30–120 s cadences

Stage S1 · Size M · Depends on T-GH-01, T-STK-01, T-ACC-02 · Unblocks T-FLW-03, T-GH-04, T-GH-05, T-GH-06, T-GH-07, T-GH-08, T-MNT-01, T-REL-02, T-STK-04, T-STK-09 · Issue: [#3515](https://github.com/smithersai/smithers/issues/3515)
Spec: spec.md §3 (`github_sync`), §3.0, §4.4, §6.2.3, §12.2, §19.4 · Delta: delta.md §7 · Product: mvp.md J10.6, §6.3 "No public address", §9 "GitHub freshness", M-03

## Goal
With webhooks off or dropped, PRs, checks and `main` reach PostgreSQL within 60 s of the change on GitHub and issues within 5 min. With ten pending TODO PRs the install spends at most 1,000 charged and 1,500 raw GitHub requests per hour (§12.2.2), including the hour after a merge when every open PR's checks are pending.

## Scope
In:
- One scheduler with one `github_sync` row per stream. Streams, requests and cadences are exactly the §12.2 table: refs 30 s (`git ls-remote` of `main` and `refs/heads/smithers/*`); pulls, `pr-state`, review comments and conversation comments 45 s; issues and issue events 120 s; members' permission hourly.
- `pr-state` (§12.2, §12.2.1a): one GraphQL query per 50 open TODO PRs returns each PR's state, draft flag, head sha, mergeable state, last 20 reviews, and its head's `statusCheckRollup` contexts (name, status, conclusion, `isRequired(pullRequestNumber:)`). It replaces per-PR `GET /pulls/{n}`, per-PR `GET /pulls/{n}/reviews` and per-head check-runs and status reads, so ten pending PRs cost what one does.
- Issue events (§10.2.1a, §12.2): `GET /repos/{o}/{r}/issues/events?per_page=100`, conditional, paged back to a durable cursor (the largest event id consumed). Every `labeled`, `unlabeled` and `renamed` event is handed to T-STK-09 once, in id order, so a label removed and reapplied between polls is two events, not a no-op. A `labeled` event carries the applier and the event id, which T-STK-09 needs for the §10.2.1 table, the revert and the idempotency key `(issue, label event id)`.
- Every REST read is conditional (`If-None-Match` with the stored ETag). The `since` and event-id cursors stay at the newest value seen, so an unchanged repository repeats the same URL and gets 304. A page beyond the first is fetched only when every row of the first page is newer than the cursor.
- Installation tokens, scoped ones included, are cached per (installation, permission set) until 5 min before expiry (§12.2.1).
- Budget (§12.2.2): `BudgetTracker` counts every GitHub request per rolling hour as raw (every REST and GraphQL request) and charged (REST responses other than 304, every GraphQL query, every write), for the scorecard and C-GH-08. Below 20 % of a resource's `X-RateLimit-Limit` remaining, the issues, issue-events and members' permission cadences double until `X-RateLimit-Reset`; refs, pulls, `pr-state` and the comment streams keep theirs. A 403 or 429 with `Retry-After` pauses that stream until `retry_at` and records the `limited` input for health.
- One typed GitHub error, `{permission | not_installed | rate_limited(retry_at) | unreachable}`, carried as the §6.2.3 envelope class `github`.
- Changed objects are written to the existing `github_synced_*` store, the one GitHub cache (§3.0), and handed to their consumers through one dispatch interface. Consumers: `main` moved → main pull (T-GH-07, T-GH-08) and the flow load (T-FLW-03); `pr-state` PR state and head → T-GH-05, T-GH-06; `pr-state` reviews and the comment streams → T-GH-04; `pr-state` checks → T-GH-05; issues and issue events → the issue card and the `todo` label path (T-STK-09); permissions → T-ACC-02.
- Webhooks (§12.2.4): a signed delivery triggers an immediate fetch of its stream. No cadence ever stretches, so a dropped delivery costs no freshness. Payloads never become state.
- A Retry hook that forces every stream now (T-GH-08 exposes it).

Out: health states and `/api/github/sync` (T-GH-08); inbound effects (T-GH-04..07, T-STK-09); outbound writes (T-GH-09); webhook delivery setup (optional, §12.2.4); per-PR polling of reviews or comments (rejected in E-08); executing fetched repository code or its hooks/credential helpers; card Views; replacing Plue workers outside the install composition.

## Changes
- `packages/backend/db/product/migrations/<next>_github_sync.sql` (new) → `github_sync` (§3) with per-stream cursors, ETags and health. The `github_synced_*` tables gain the object kinds the streams fetch that they lack today (review, review comment, check, label event). No second cache table. `packages/backend/db/product/queries/github_sync.sql` (new); regenerate sqlc.
- `packages/backend/internal/services/github_sync.go` (new) → the scheduler, an injectable clock, streams, cursors, ETags, the raw and charged budget and the consumer interface.
- `packages/backend/internal/services/github_pr_state.go` (new) → the `pr-state` GraphQL query, 50 PRs per query, and its decoder. `HeadChecks` (`mythical_github.go:611`) stops issuing per-head REST reads; T-GH-05 reads checks from this stream.
- Issue events: the repository endpoint, with its event-id cursor in `github_sync.cursor`. Delete the per-issue fetches in `github_issue_text_writer.go:251-262` and `labelHistory` (`mythical_github.go:398`).
- `packages/backend/internal/services/landing_github_pull.go:421-453` (`landingGitHubAPI.request`) → send `If-None-Match`; return 304 and the rate-limit headers; map failures to the typed error instead of `CodeBadGateway "GitHub did not answer"` (`:443`). Every call passes through `BudgetTracker` (`github_budget.go`), fed by response headers.
- `packages/backend/internal/services/github_repo_metadata.go:492-543` and `github_import.go:2426-2445` → call the one rate-limit parser; delete their copies.
- `packages/backend/internal/services/repo_connection_github_app.go:466-467` → cache scoped tokens; keep `installationTokenEarlyExpiry` (`:557`) at 5 min.
- Delete the old cadences and their loops in the same change: `gitHubMainPullPollInterval` (`github_main_pull.go:40`, sweep `:285-312`) becomes the refs stream; the per-item `GET /pulls/{n}` every `mythicalPullPollEvery` (`mythical_items.go:52`, `follow` `:2179`) reads the synced store; the `Backfill` sweep every `mythicalBackfillEvery` (`:51`, `:300`) becomes the issues stream; the synced-store loops `StartReconciler` and `StartSyncWebhookReconciler` (`internal/compose/main.go:1650-1651`) are replaced by the streams for the install's repository.
- `packages/backend/internal/services/github_webhook.go:343-352` → a delivery requests a stream fetch; `ApplyIssueEvent` no longer applies payloads.
- `packages/backend/internal/githubfake/` → extend (from T-GH-01): the §12.2 read endpoints including the repository issue-events list and the `pr-state` GraphQL query, ETags and 304, rate-limit headers per resource, `Retry-After` injection, git smart HTTP over a bare repo, and a request counter by stream, status, raw and charged.
- `packages/backend/docs/github-sync.md` (new): streams, cadences and budget; `pnpm docs:sync`, `pnpm docs:check`, `smthrs docs //packages/backend:docs`.

## Tests
- Unit, `github_sync_test.go` (new): assert literal cadences of 30 s for refs, 45 s for pulls, pr-state and both comment streams, 120 s for issues and issue-events, and 3,600 s for permissions; below 20 % remaining the issues, issue-events and permission due times double and the other streams' don't, and both return to normal after the reset; `Retry-After` pauses only its stream; a cursor advances only when a newer `updated_at` or event id arrives; a token due within 5 min of expiry is re-minted.
- Unit, same file: with 10 pending heads, and again with 60 open TODO PRs, `pr-state` sends one query per 50 PRs every 45 s and no per-PR or per-head REST request.
- Unit, same file: a label removed and reapplied between two polls yields `unlabeled` then `labeled`, each handed over once in id order; a replayed page hands nothing over twice.
- Integration, real PostgreSQL + `githubfake` (`github_sync_integration_test.go`, new): [C-GH-08](../checks/C-GH-08.md) counts.
- Integration: after a restart, the first poll of every stream is conditional and gets 304. No full refetch.
- Integration: a signed webhook triggers its stream's fetch within 1 s and leaves every cadence unchanged; an unsigned delivery changes nothing.
- Integration: a PR updated while more than 50 newer PRs changed is still seen (paging until `updated_at` < cursor).
- e2e: [C-GH-07](../checks/C-GH-07.md).

## Acceptance

- [C-J1-04](../checks/C-J1-04.md): S1 part at its named layer.

- [C-GH-07](../checks/C-GH-07.md): p95 freshness of PR, checks and `main` ≤ 60 s and issues ≤ 5 min on a real repository with ten pending TODO PRs, with webhooks off and then dropped.
- [C-GH-08](../checks/C-GH-08.md): at most 1,000 charged and 1,500 raw requests in each simulated hour with 10 pending TODO PRs and 100 issues, including a stress hour in which every response changes; every repeat REST read conditional.

## Risks and notes
- Risk: a cursor set to "now − cadence" changes the URL on every poll, so no request ever gets a 304. Confirmed in C-GH-08 when the 304 ratio of an idle hour is below 90 %.
- Risk: GitHub may count 304s for installation tokens. Confirmed when `X-RateLimit-Remaining` drops across 304 responses in the C-GH-07 run. The §12.2 caps hold either way.
- Risk: with a 45 s cadence a change waits at most 45 s for the next poll, which leaves 15 s for the fetch and the projection. A `pr-state` query over 50 PRs that takes longer fails C-GH-07. Confirmed by the query's p95 duration in the C-GH-07 run. A cadence change is a spec change to §12.2: escalate, don't tune locally.
- Risk: `statusCheckRollup` returns at most 100 contexts per page. Confirmed when a head with more than 100 checks shows fewer in evidence. Page the contexts connection for that PR only.
- Risk: GraphQL has its own rate limit, counted in points. Confirmed when `X-RateLimit-Remaining` for resource `graphql` drops by more than one point per query in the C-GH-07 run. Split the query below 50 PRs.
- Risk: `git ls-remote` every 30 s may meet git-side throttling. Confirmed by HTTP 429 from `github.com` git endpoints during C-GH-07.
- Ownership: §12.2 lists the members' permission poll as a stream, and §5.1.3's hourly re-check belongs to T-ACC-02. This ticket schedules it under the shared budget; T-ACC-02 owns the handler.

## Ready checklist

1. Dependencies cover sealed App credentials, TODO/branch/projection storage and member roster/permission handling. Downstream consumers register through the dispatch interface; fetched objects remain in the synced store before those handlers land. Full C-GH-07 evidence additionally needs T-COL-02 and its inbound consumer tickets.
2. Out explicitly names inbound effects, outbound writes, webhook setup, per-PR polling, repository execution/hooks/helpers, Views and Plue worker replacement.
3. C-GH-08 and `github_sync_integration_test.go` start the scheduler through the production install worker composition in `compose/main.go`; only the clock and external GitHub server are injected. Signed/unsigned webhook tests use the production webhook route; C-GH-07 observes production API/live reads. Expected statuses, graphs, timings and outputs are literal test fixtures or independent input logs. No test reads spec files or computes expectations from production code at runtime.
4. smithers-8a decides changes to §12.2 cadences, paging and budgets; smithers-3f approves scheduler/store and permission-handler seams. Splitting a GraphQL batch must retain freshness and request caps, proved by C-GH-07/08.
5. Before start, smithers-3f: does install startup replace every old loop without affecting Plue; do all GitHub callers use one budget/token cache; do cursor commit and consumer retry avoid lost or duplicate events? Apps, Views and TypeScript export changes are excluded.
6. Fetched issue, PR and webhook content remains data, never evaluated code. Packaged refs polling uses a controlled git environment with repository hooks and credential helpers disabled; repository evaluation dispatches only to machines (§1.3). smithers-3f reviews the boundary; C-GH-08 verifies polling and C-SEC-02 verifies machine-only dispatch.
