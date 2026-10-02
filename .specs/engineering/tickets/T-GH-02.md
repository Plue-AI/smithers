# T-GH-02 Poll scheduler: streams, ETags, token cache, budget, 30–120 s cadences

Stage S1 · Size M · Depends on T-GH-01 · Unblocks T-STK-09, T-GH-04, T-GH-05, T-GH-06, T-GH-07, T-GH-08, T-FLW-03 · Issue: to file
Spec: spec.md §3 (`github_sync`), §3.0, §4.4, §6.2.3, §12.2, §19.4 · Delta: delta.md §7 · Product: mvp.md J10.6, §6.3 "No public address", §9 "GitHub freshness", M-03

## Goal
With no webhooks, PRs, checks and `main` reach PostgreSQL within 60 s of the change on GitHub and issues within 5 min, while the install spends under 1,000 REST calls per hour, including the hour after a merge when every open PR's checks are pending.

## Scope
In:
- One scheduler with one `github_sync` row per stream. Streams, requests and cadences are exactly the §12.2 table: refs 30 s (`git ls-remote` of `main` and `refs/heads/smithers/*`), pulls 60 s, review comments 60 s, conversation comments 60 s, reviews on change, checks 60 s while pending, issues 120 s, issue events on change, members' permission hourly.
- Issue events (§12.2): `GET /issues/{n}/events` only for issues whose `todo` label appeared since the last poll, conditional, at most one call per changed issue. It yields who applied the label and the event id, which T-STK-09 needs for "by a member", the non-member revert and the idempotency key `(issue, label event id)` (§10.2.1).
- Post-merge check cadence (§12.2.1a): after a merge every open PR is force-updated and all their checks are pending at once. Check-runs then poll every 60 s for the first item in stack order and every 120 s for the rest, until each head's checks settle.
- Every REST call is conditional (`If-None-Match` with the stored ETag). The `since` cursor is the newest `updated_at` seen, so an unchanged repository repeats the same URL and gets 304.
- Installation tokens, scoped ones included, are cached per (installation, permission set) until 5 min before expiry (§12.2.1).
- Budget (§12.2.2): below 20 % of `X-RateLimit-Limit` remaining, every cadence doubles until `X-RateLimit-Reset`. A 403 or 429 with `Retry-After` pauses that stream until `retry_at` and records the `limited` input for health.
- One typed GitHub error, `{permission | not_installed | rate_limited(retry_at) | unreachable}`, carried as the §6.2.3 envelope class `github`.
- Changed objects are written to the existing `github_synced_*` store, the one GitHub cache (§3.0), and handed to their consumers through one dispatch interface. Consumers: `main` moved → main pull (T-GH-07, T-GH-08); TODO PR state and head → T-GH-05, T-GH-06; reviews and comments → T-GH-04; checks → T-GH-05; issues and issue events → the issue card and the `todo` label path (T-STK-09); permissions → T-ACC-02.
- Webhooks (§12.2.4): a signed delivery triggers an immediate fetch of its stream, and while deliveries arrive the cadences stretch 5×. Payloads never become state.
- A Retry hook that forces every stream now (T-GH-08 exposes it).

Out: health states and `/api/github/sync` (T-GH-08); the inbound effects themselves (T-GH-04..07, T-STK-09); outbound writes (T-GH-09); webhook delivery setup (optional, §12.2.4); per-PR polling of reviews or comments (rejected in E-08).

## Changes
- `packages/backend/db/product/migrations/<next>_github_sync.sql` (new) → `github_sync` (§3) with per-stream cursors, ETags and health. The `github_synced_*` tables gain the object kinds the streams fetch that they lack today (review, review comment, check, label event). No second cache table. `packages/backend/db/product/queries/github_sync.sql` (new); regenerate sqlc.
- `packages/backend/internal/services/github_sync.go` (new) → the scheduler, an injectable clock, streams, cursors, ETags, budget, the post-merge check cadence and the consumer interface.
- Issue events: reuse the existing fetch in `github_issue_text_writer.go:251-262` as the stream's request; delete the copy.
- `packages/backend/internal/services/landing_github_pull.go:421-453` (`landingGitHubAPI.request`) → send `If-None-Match`; return 304 and the rate-limit headers; map failures to the typed error instead of `CodeBadGateway "GitHub did not answer"` (`:441`). Every call passes through `BudgetTracker` (`github_budget.go`), fed by response headers.
- `packages/backend/internal/services/github_repo_metadata.go:492-545` and `github_import.go:2426-2445` → call the one rate-limit parser; delete their copies.
- `packages/backend/internal/services/repo_connection_github_app.go:466-467` → cache scoped tokens; keep `installationTokenEarlyExpiry` (`:557`) at 5 min.
- Delete the old cadences and their loops in the same change: `gitHubMainPullPollInterval` (`github_main_pull.go:40`, sweep `:285-312`) becomes the refs stream; the per-item `GET /pulls/{n}` every `mythicalPullPollEvery` (`mythical_items.go:52`, `follow` `:2179`) reads the synced store; the `Backfill` sweep every `mythicalBackfillEvery` (`:51`, `:300`) becomes the issues stream; the synced-store loops `StartReconciler` and `StartSyncWebhookReconciler` (`internal/compose/main.go:1650-1651`) are replaced by the streams for the install's repository.
- `packages/backend/internal/services/github_webhook.go:343-352` → a delivery requests a stream fetch; `ApplyIssueEvent` no longer applies payloads.
- `packages/backend/internal/githubfake/` → extend (from T-GH-01): the §12.2 read endpoints including issue events, ETags and 304, rate-limit headers, `Retry-After` injection, git smart HTTP over a bare repo, and a request counter.
- `packages/backend/docs/github-sync.md` (new): streams, cadences and budget; `pnpm docs:sync`, `pnpm docs:check`, `smthrs docs //packages/backend:docs`.

## Tests
- Unit, `github_sync_test.go` (new): each stream's cadence equals §12.2; below 20 % remaining the next due time doubles and returns to normal after the reset; `Retry-After` pauses only its stream; the cursor advances only when a newer `updated_at` arrives; a token due within 5 min of expiry is re-minted.
- Unit, same file: after a merge with 10 pending heads, the first item's head is due every 60 s and the others every 120 s; a settled head leaves the check rotation.
- Unit, same file: issue events are requested once per issue whose `todo` label appeared, and never for an issue without that change.
- Integration, real PostgreSQL + `githubfake` (`github_sync_integration_test.go`, new): [C-GH-08](../checks/C-GH-08.md) counts.
- Integration: after a restart, the first poll of every stream is conditional and gets 304. No full refetch.
- Integration: a signed webhook triggers its stream's fetch within 1 s and the cadence stretches 5×; an unsigned delivery changes nothing.
- Integration: a PR updated while more than 50 newer PRs changed is still seen (paging until `updated_at` < cursor).
- e2e: [C-GH-07](../checks/C-GH-07.md).

## Acceptance
- [C-GH-07](../checks/C-GH-07.md): p95 freshness of PR, checks and `main` ≤ 60 s and issues ≤ 5 min on a real repository with webhooks off.
- [C-GH-08](../checks/C-GH-08.md): under 1,000 REST calls in one simulated hour with 10 open TODO PRs, all with pending checks after a `main` merge, and 100 issues, every repeat request conditional.

## Risks and notes
- Risk: a cursor set to "now − cadence" changes the URL on every poll, so no request ever gets a 304. Confirmed in C-GH-08 when the 304 ratio of an idle hour is below 90 %.
- Risk: GitHub may count 304s for installation tokens. Confirmed when `X-RateLimit-Remaining` drops across 304 responses in the C-GH-07 run. The §12.2 caps hold either way.
- Risk: with a 60 s cadence, a change waits on average 30 s and at p95 about 57 s before the next poll, plus fetch and projection time, so scheduler drift of a few seconds fails C-GH-07. Confirmed by its p95 for PR and checks. A cadence change is a spec change to §12.2: escalate, don't tune locally.
- Note: after a merge, later items' checks may be up to 2 min stale (§12.2.1a). They can't merge until they are first, and the first item keeps 60 s. C-GH-07 has no merge, so it measures the 60 s cadence; C-GH-08 measures the post-merge budget.
- Risk: `git ls-remote` every 30 s may meet git-side throttling. Confirmed by HTTP 429 from `github.com` git endpoints during C-GH-07.
- Ownership: §12.2 lists the members' permission poll as a stream, and §5.1.3's hourly re-check belongs to T-ACC-02. This ticket schedules it under the shared budget; T-ACC-02 owns the handler.
