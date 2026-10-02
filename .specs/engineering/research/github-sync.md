# GitHub sync — current state (main, 2026-10-02)

Paths are under `packages/backend/internal/services/` unless stated. Method: read-only code reading; nothing was run. Inferences are marked "inferred".

## Summary
- Auth is a GitHub App (id + RSA key from env `SMITHERS_GITHUB_APP_ID` / `SMITHERS_GITHUB_APP_PRIVATE_KEY`, `repo_connection_github_app.go:102-103,1029`). OAuth (`auth.github_client_id`, `config.go:362`) is sign-in only. No PAT path for repo writes. No app-manifest flow anywhere (rg "manifest" finds only flowmanifest/export). The App slug default is hard-coded `smitherspreviewrelease` (`:96`).
- The inbound/outbound loop is real but is keyed to an issue, not to a Smithers TODO: `mythical_items.go` (item = issue; states queued..proposed..landed|rejected). It was built for the "factory" model, not mvp.md's TODO/stack model.
- Poll constants: main 5 min (`github_main_pull.go:40`), PR follow 5 min (`mythical_items.go:52`), issue backfill 15 min (`:51`), metadata reconciler 10 min base, 45 s..8 h adaptive (`github_synced_repos.go:36,53-54`). Matches the "Partial" note. Hitting the 1-min targets is mostly a constant change plus conditional requests (no ETag code exists).
- Webhooks are built and safe (HMAC-SHA256, body-hash dedupe, durable job queue), but nothing ingests `pull_request_review`, review comments, `check_run` or `pull_request` for a TODO; only `issues`, `issue_comment` (mention), `push` (main) are acted on.
- Biggest gaps: review/comment inbound as steers (Missing in code, spec says Partial), agent replies in review threads (Missing), stacked PR bases and retarget (Missing; every PR bases on default branch), push-to-branch ingestion (Missing; code holds the TODO instead), force-push Needs-you (Missing; main pull fails with backoff), sync status surface (no "synced N s ago" field to the UI), manifest setup (Missing), branch name `smithers/<slug>` (code uses `smithers/issue-N`).
- The merge method is hard-coded `squash` (`mythical_github.go:324`), not the repository's method.
- The "TODO PR closed -> Dropped, reopen restores" path is not implemented: closed-unmerged becomes terminal `rejected`; a reopen is ignored (item no longer followed).

## Row-by-row

### From GitHub into Smithers
| §6.3 row | Code today | Status | What's missing |
| --- | --- | --- | --- |
| `main` moves | Webhook `push` on default branch -> `github_workflow_event_worker.go:318 requestMainPull`; poll `github_main_pull.go:285-312` (5 min, `RequestStaleGithubMainPulls`); fast-forward only (`:575-584`); then `MainMoved` -> `mythical.go:125` wakes fold. Wiring `compose/main.go:895-903,1627-1629`. Only when repo policy `mirror: "pull"` (`:40,:477`); otherwise state `skipped`, re-checked every 6 h (`:41`) | Built (conditional on `.smithers/factory.json` declaring `mirror: pull`; undeclared repos are skipped) | Home card "main row shows the new commit": view has `landedMain` and `MainBehind` (`mythical_view.go:27,279`) but no GitHub head/time. 5 min poll vs 1 min target. Default policy for MVP installs must be `pull` (inferred) |
| Issue opened/edited/commented | Webhook `issues`/`issue_comment` -> `github_webhook.go:343-348` -> `ApplyIssueEvent` into synced store (`github_synced_repos.go`); reconciler backstop `StartReconciler` (`compose/main.go:1650`), 10 min base, 8 h if webhook heartbeat in last 24 h (`:1266-1282`) | Built | Poll target 5 min applies only without webhooks; with webhooks heartbeat the backstop is 8 h. **Make TODO** availability: `FileTodo` (`mythical_file_todo.go:41`) files a new issue, `LandTodo` is Land. No "Make TODO on an existing issue" entry (inferred: the `todo` label path covers it, see next row) |
| Issue gets `todo` label from a member | `issues` webhook -> `ObserveGitHubEvent` (`mythical_items.go:2827`) -> `ObserveIssue` (`:165`). Maintainer check `mythicalAuthorize` (`:2942`), stale-label guard `liveTodo` (`:2901`), per-application idempotency `checks.TodoEvent` (`:196-200`), text pinned by sha256 digest `mythicalIssueDigest` (`:150`) and body cut at 24 KiB. Non-maintainer `todo` is reverted `revertLabel` (`:2889`). Sweep: `Backfill` every 15 min (`:51,:1063`) | Built, with a difference | Spec: "later edits don't change the TODO". Code: a not-yet-started item (queued/skipped/cancelled) takes new approved text (`:236-262`); an outsider's edit after approval needs a new label. A started item is pinned. Edit-before-start semantic differs from J2 step 2 (which says exact revision recorded). Digest, not revision id, is recorded (no `edited_at`/revision id) |
| Review or review comment on TODO's PR | None for the stack. `pull_request_review` is queued (`github_webhook.go:90`) and only fires user workflow triggers (`repository_jobs.go:260`, `workflow_trigger_registry.go:58`). `ObserveGitHubEvent` handles only `issues`/`issue_comment` (`mythical_items.go:2828-2833`). Legacy `StackService` reads reviews at view time (`stack.go:794-870`, `aggregateStackReviewStatus`) | Missing (spec says Partial; evidence: no code path from a review/comment to a branch steer or Working transition) | Ingest `pull_request_review`, `pull_request_review_comment`, PR `issue_comment`; attribute to reviewer; steer into lane; "changes requested" -> back to Working; see Gaps G1 |
| Checks finish on TODO's PR | Webhooks `check_run`/`check_suite` only `TouchWebhook` (`github_webhook.go:350-352`). Merge gate reads live: `HeadChecks` (`mythical_github.go:611`) over check runs, suites, combined status; hold with "CI failed on the approved head" (`mythical_items.go:2258-2262,2453`). Poll cadence via `follow` 5 min | Partial (spec says Built) | "PR card and evidence update" has no event; evidence updates at the 5 min item poll only. HeadChecks is all-checks, not required-checks, and runs only on the automerge path (`gate` -> `merge`, `:2262`), so a non-automerge TODO never shows CI. Hold reason does not name the failing check (`:2455`: generic "CI failed on the approved head"). Spec says "giving the check's name" |
| TODO's PR merged on GitHub | `follow` (`:2163`): `pull.Merged` -> `mythicalLanded` (`:3118`); then `complete` (`:3168`) verifies merge commit on main (`OnMain`), posts evidence comment, closes issue. Also `LandingGitHubMergeService.Reconcile` after each synced main pull (`compose/main.go:903`, `landing_github_merge.go:73`) for legacy landings | Partial -> Built for in-order. Out of order: no "Needs you on the stack" | Out-of-order merge: all PRs base on main so any order merges; the later PRs go `behind`/`dirty` and are rebuilt (`:2193-2196`). No stack-order violation signal because there is no stacked base. Detection latency up to 5 min (no `pull_request` webhook consumer in the stack) |
| PR closed without merging | `follow`: `pull.State=="closed"` -> state `rejected`, reason "the pull request was closed without merging" (`:2192`) | Partial | No "closed on GitHub by @x" (no actor read). "Reopening restores" missing: `rejected` is in `mythicalSettledStates` (`:93`) so it is no longer followed. `openPull` would open a new PR if one closed (`:2088`) but only when re-proposed |
| Someone pushes to TODO's branch | `follow`: `pull.HeadSHA != item.PRHead` -> `mythicalHold(... "moved:"+sha, "the pull request head moved outside Smithers; a person decides")`, records `ForeignHead`; stack neither reviews nor merges it (`:2197-2206`, `gate :2241`). Propose also blocks if the branch moved (`:1986,:2017`) | Missing (spec's behavior: commits enter live working copy as attributed edits). Code does the opposite: it freezes | Fetch the pushed commits into the lane workspace (needs a git fetch into `mythical_lanes` workspace and an activity entry "Ben pushed N commit from GitHub"); belongs next to `follow` plus lane service (`mythical_items.go:1494 lane`). Webhook `push` on non-default branches is already enqueued but ignored by the stack (`gitHubDefaultBranchPush` filter `:330`) |
| Teammate pushes own branch / opens own PR | Synced store lists PRs (`github_synced_repos.go` `GitHubRepoMetadataPulls`, proxy `github_proxy.go`); `/review` works on PRs (`github_pull_diff.go`) | Missing (spec: Missing) | `/branches` "On GitHub" list; Open on a machine (new branch tracking an existing GitHub branch, pushes back to it). `mythicalBranch` (`:2115`) only knows `smithers/*` names |
| Branch protection | `landingGitHubStatusError` maps 401/403/404 (`landing_github_pull.go:455`); `merge` on refusal: hold "GitHub refused the merge" with fault tag `merge` (`mythical_items.go:2523`). Required-reviews are never read | Partial | Surface GitHub's reason text (response body `message` is discarded: `landingGitHubAPI.request` reads body only into `out` on 2xx, `:437-446`). Read `GET /branches/{b}/protection` or merge-box `mergeable_state: blocked` reasons |

### From Smithers to GitHub (through the App)
| §6.3 row | Code today | Status | What's missing |
| --- | --- | --- | --- |
| TODO reaches In review: PR on `smithers/<todo-slug>`, body prompt+evidence+link, "Requested by @owner", base = previous stack item or main | `propose` (`:1951`) -> `pushProposal` (`:2066`, `--force-with-lease`) -> `openPull` (`:2081`), `CreatePull` as App (`mythical_github.go:282`, installation token). Branch `smithers/issue-<n>[-rK]` or `smithers/change-<12hex>` (`:2115-2124`). Base = `repository.DefaultBookmark` (`:2093-2096`), commit parent = `r.mainTip` (`:2018`). Body from `proposal()` (`:2126`): agent summary + "Refs #n" + fixed sentence; closing keywords stripped (`mythicalNoClosingKeywords`) | Built for open/idempotent (pending-op crash recovery, `:1969-2012`). Base targeting: Missing, not Partial. Branch slug: differs | Slug-based branch name; body with prompt, evidence, link back, "Requested by @owner"; stacked base = previous item's branch, retarget to main after the previous merges (`PATCH /pulls/{n} base`), rebuild branch on new base. One PR whose tree is exactly the verified candidate on main tip (current design) conflicts with stacked bases: needs a decision (inferred) |
| Commit on TODO's branch pushed so PR shows work live | Push happens only at propose time after verification (`:2014`), one commit per item. Lane commits are not pushed during Working (inferred from `propose` being the only push, rg "refs/heads/" in lane paths) | Partial (spec: Built) | Live push of in-progress commits; `smithers/<slug>` branch exists only at In review |
| Make TODO on an issue: `todo` label + comment "Committed as TODO #12 ↗" | `labelAutoTodo` adds `todo` for policy-made TODOs (`:2988-3025`, `AddLabel`); `FileTodo` creates issue. rg "Committed as" finds nothing | Partial | The comment; the label on the Make-TODO path from an existing issue |
| TODO merges: repository merge method; issue closes with link | `Merge` always `merge_method: squash` (`mythical_github.go:324`); `complete` posts evidence and `CloseIssue` (`:3240`); issue closes only after merge commit is verified on main (`OnMain`, `:539`); bounded wait `mythicalCompletionWaitBound` | Built; merge method Partial | Read repo `allow_squash_merge/allow_merge_commit/allow_rebase_merge` and pick (`GET /repos`). "If the TODO fixes the issue" test: code closes every item's issue (items are issue-bound; chat-origin items have no `IssueNumber`, skipped `:3172`). Link to "the change": completion body links the commit (`completionBody :3255`) |
| Scratch branch stays in Smithers | Lanes are Smithers-side workspaces; nothing pushed before propose | Built | None. Verify no `refs/heads` push from lanes (inferred) |
| Agent replies to review comments | rg for `in_reply_to`, `/replies`, `pulls/*/comments` in non-test code: no hits. Only issue-comment writes: `Comment` with hidden marker key (`mythical_github.go:440-520`) | Missing (spec: Partial) | `POST /pulls/{n}/comments/{id}/replies` plus mapping steer->comment id; needs `pull_requests: write` (already requested for merge) |

### Freshness and health
| §6.3 row | Code today | Status | What's missing |
| --- | --- | --- | --- |
| No public address; polling covers refs, issues, PR reviews, checks, outside merges | Polls: main 5 min, PRs 5 min (per item `NextAttemptAt` +5 min, `:977,1000,2111,2184`), issues 15 min (`:51`), stack sweep 5 min (`mythical.go:31`), webhook worker 2 s (`github_workflow_event_worker.go:18`), App installation reconcile 1 h (`github_app_reconcile_loop.go:13`), webhook-registration reconcile 10 min (`compose/main.go:1651`). Reviews and checks are not polled at all for stack items (checks only at the gate, reviews never) | Partial | Constants to 1 min (PR, main) and 5 min (issues); add review + check reads to `follow`; use ETag/`If-None-Match` (absent: rg "etag|if-none-match" has no non-test hit); budget tracker exists (`github_budget.go`, 5000/h/installation, process-local) but the stack's `landingGitHubAPI.request` does not call it |
| Sync status "synced 40 s ago", gold past 2x target, Retry, names cause | Backend: `GitHubMainPullStatus` has `last_checked_at`, `last_synced_at`, `last_error`, `next_attempt_at`, `fresh`, `attempts` (`github_main_pull.go:75-92`); routes GET/POST `/api/repos/{o}/{r}/github/main-pull` (`routes/github_main_pull.go`) where POST = Retry. Typed causes: `GitHubAccessVerdict*` (`github_access_diagnosis.go:41-47`), `github-app-status` returns configured + rate-limit facts (`repo_connection_github_app.go:109-125`); synced-repo budget deferral (`github_synced_repos.go:1255`). App side: `GitHubSeam.ts` reads `github-app-status` and a 429 `github_rate_limited` (lines 11-40). `rg main-pull apps/app/src` has no consumer | Partial: data exists, no UI surface | Wire main-pull status to the home card `main` row; gold at 2x target; Retry = POST. Stack path errors collapse to `CodeBadGateway` "GitHub did not answer" (`landing_github_pull.go:441`) and `mythicalInfraOutage(... "github" ...)`; no rate-limit class there (rate-limit parsing lives in `github_repo_metadata.go:492-545` and `github_import.go:2426`, not shared). Needs one typed error {permission, rate_limit(retry_at), unreachable, not_installed} |
| GitHub App setup via app-manifest | None. Installation URL + env creds only. Install reconcile: `github_app_installations.go`, hourly loop. `webhook.github_app_secret` config (`config.go:384,559,716`) | Missing | Manifest POST to `github.com/settings/apps/new` (or org), callback exchange `POST /app-manifests/{code}/conversions` -> store id, PEM, webhook secret, client id/secret in owner-only settings; self-host needs a public callback or localhost redirect (M-03 NAT). Size L |
| `main` rewritten on GitHub | Non-ancestor: `fail("Smithers main (...) is not an ancestor of GitHub main (...); it diverged and is never overwritten...")` (`github_main_pull.go:578-581`), retried with 30 s..30 min backoff (`:51-52`). No owner prompt, no confirm-then-rebase. Stack: `RequestBootstrap(... reset)` rebuilds from main (`mythical.go:107`) | Missing | Typed `force_push` outcome -> Needs you (owner) -> on confirm: reset the Smithers `main` bookmark and rebase stack. Needs a guarded write path (current pull deliberately never rewrites) |

## Gaps vs mvp.md
| # | Spec ref | Missing | Where the change goes | Size |
| --- | --- | --- | --- | --- |
| G1 | §6.3 review row, J10.2 | Review/review-comment ingestion as attributed steer; "changes requested" -> Working | New `ObserveGitHubEvent` cases for `pull_request_review`, `pull_request_review_comment` in `mythical_items.go:2827`; add events to the App subscription list; item-state transition `proposed -> running` with feedback prompt (`prompt()` `:1723` already takes retry feedback); poll fallback in `follow` via `GET /pulls/{n}/reviews`, `/comments` | L |
| G2 | §6.3 agent replies | Reply in thread | New `mythicalGitHubAPI.Reply` (replies endpoint) + recorded comment ids on the steer | M |
| G3 | §6.3 PR row, M-22 | Stacked PR bases, retarget after merge, `smithers/<slug>` | `propose`/`openPull`/`mythicalBranch` (`:1951-2124`); conflicts with "tree exactly equals verified candidate on main tip" invariant; needs design | L |
| G4 | §6.3 PR body | Prompt, evidence, link back, "Requested by @owner" | `proposal()` (`:2126`) | S |
| G5 | §6.3 push row, J10.3 | Foreign push -> working copy as attributed edits | `follow` branch `HeadSHA != PRHead` (`:2197`) + lane fetch + activity event; today it freezes the TODO | L |
| G6 | §6.3 closed/merged rows | Dropped with actor, reopen restores, out-of-order Needs you | `follow` (`:2163`), `mythicalSettledStates` (`:93`); read `closed_by`/webhook `pull_request` sender | M |
| G7 | §6.3 checks row | Required-check blocking with name, evidence update outside automerge | `HeadChecks` (`mythical_github.go:611`) -> return failing check names; call from `follow` not only `merge`; branch-protection required contexts | M |
| G8 | §6.3 branch protection | GitHub's reason text on blocked merge | `landingGitHubAPI.request` (`landing_github_pull.go:421`) keep non-2xx body `message`; `merge` hold copy (`mythical_items.go:2523`) | S |
| G9 | §6.3 merge | Repository merge method | `mythical_github.go:324` + repo settings read | S |
| G10 | §6.3 polling | 1 min PR/checks/main, 5 min issues; ETag; shared budget | constants `github_main_pull.go:40`, `mythical_items.go:51-52`; add conditional-request layer in `landingGitHubAPI.request`; call `BudgetTracker` | M |
| G11 | §6.3 sync status | UI row, gold state, Retry, typed cause | App: home card + `GitHubSeam`; backend: expose `GitHubMainPullStatus` in stack snapshot or call existing route; unify error type | M |
| G12 | §6.3 App setup | App-manifest flow | New service + route + settings card; env-var creds replaced by DB-held secrets (secrets handling: inferred) | L |
| G13 | §6.3 force push | Needs you + confirm + rebase | `github_main_pull.go:578`; new outcome + owner action | M |
| G14 | §6.3 Make TODO | `todo` label + "Committed as TODO #n" comment | `mythical_items.go:2988` area, `Comment` (`mythical_github.go:484`) | S |
| G15 | §6.3 teammate branch/PR | "On GitHub" list, Open on a machine | New; synced store already lists PRs | L |
| G16 | J2.2 | Exact revision recorded, edits ignored | `ObserveIssue` (`:236-262`): freeze text at commit rather than "until started"; store `updated_at`/digest in item | S |
| G17 | Policy default | `mirror: "pull"` must default on for MVP installs | `github_main_pull.go:477` skips undeclared; factory.json reconcile | S |

## Existing tests
- Mythical: `mythical_github_test.go`, `mythical_items_test.go` (fake GitHub), `mythical_proposal_test.go`, `mythical_land_todo_test.go`, `mythical_file_todo_test.go`, `mythical_terminal_e2e_test.go`, `mythical_failure_test.go`, `mythical_adversarial_test.go`, `mythical_concurrency_test.go`, `mythical_git_test.go`, `mythical_db_test.go`.
- Main pull: `github_main_pull_test.go`, `_db_test.go`, `_git_test.go`; landing: `landing_github_pull_test.go`, `landing_github_merge_test.go`, `_db_test.go`.
- Webhook: `github_webhook_test.go`, `_cover_`, `_h_`, `_z_`, `_synced_test.go`; `internal/webhook/hmac_e2e_test.go`; worker `github_workflow_event_worker_test.go`.
- Checks: `github_check_runs_test.go` (this is outbound check-run posting by the App, not ingestion); budget `github_budget_z_test.go`.
- App/E2E: `apps/app/e2e/real/changes-reviews*.spec.ts`, `issues.spec.ts` (not verified to cover GitHub round trips). #1921, #1878, #1874 own the missing real E2E scenarios.
- No test covers: review ingestion, thread reply, stacked base, foreign push into working copy, force-push main, manifest flow (none exist to test).

## Configured/measured numbers
Constants (exact):
| Loop | Value | Source |
| --- | --- | --- |
| Main pull dispatch tick | 5 s | `github_main_pull.go:39` |
| Main pull stale re-request | 5 min; skipped repos 6 h | `:40-41` |
| Main pull backoff | 30 s base, 30 min max | `:51-52` |
| Mythical stack worker tick / sweep | 3 s / 5 min | `mythical.go:30-32` |
| PR follow / issue backfill | 5 min / 15 min | `mythical_items.go:51-52` |
| Webhook job worker | 2 s; retry 5 s..10 min | `github_workflow_event_worker.go:18,27-28` |
| Synced-store reconcile | base 10 min, 45 s..8 h, 14 strikes hard-fail, tick 1 min, 20 repos/tick | `github_synced_repos.go:36-57` |
| Installation reconcile | 1 h | `github_app_reconcile_loop.go:13` |
| Installation budget | 5000/h (local token bucket) | `github_budget.go:20` |
Knobs: constants only; no env/config for intervals. Env for App: `SMITHERS_GITHUB_APP_ID`, `_PRIVATE_KEY`, `_INSTALL_URL`, `_API_BASE_URL`; webhook secret `SMITHERS_WEBHOOK_GITHUB_APP_SECRET`.
Rate limit handling: Retry-After and X-RateLimit-Reset parsed in `github_repo_metadata.go:492-545` and `github_import.go:2426-2445`; not in the stack path. 304/ETag: none.

Cost of 1-minute polling, one repo (inferred from code and GitHub REST semantics; not measured). Assumptions: 10 open TODO PRs, 100 open issues (1 page), installation scoped tokens are not cached (`:466-467`, so each scoped use mints one POST).
| Poll | Calls/h |
| --- | --- |
| `git ls-remote` main (git protocol, not REST) | 60 (0 REST) |
| Scoped token mint for main pull read | 60 |
| `GET /pulls/{n}` per PR, 10 PRs | 600 |
| Reviews + comments per PR (to add), 2 calls x 10 | 1200 |
| Check runs + suites + status per PR (to add), ~4 x 10 | 2400 |
| Issues, 1 page every 5 min | 12 |
| Total with everything polled | ~4300 of 5000 (86%) |
| Total with PR + main + issues only | ~670 (13%) |
Conclusion (inferred): polling reviews and checks per PR each minute is not affordable without conditional requests (a 304 does not count toward the primary limit for authenticated requests, per GitHub docs; confirm). Prefer `GET /repos/{o}/{r}/pulls?state=open` (1 call lists all open PRs) plus `GET /repos/{o}/{r}/pulls/comments?since=` and `/issues/comments?since=` (1 call each for the whole repo), and `check-suites` only for PRs whose head changed. That is ~4 calls/min = 240/h flat.

## Related GitHub issues (open, smithersai/smithers)
- #1742 Smithers main follows GitHub main for `mirror: "pull"` repos: code landed (`github_main_pull.go`); issue still open.
- #1733 Coding vibe opens a GitHub PR for send-upstream repositories: `landing_github_pull.go` implements `smithers/landing-<n>` PRs.
- #1745 S1 Approved coding work on one mythical stack; #1727 pin/deploy coding host; #1921 real E2E for mythical stack actions.
- #1878 Real E2E for GitHub, setup and trigger actions; #1874 E2E for change, review and findings actions.
- #2780 S3 Run relevant checks for every factory change; #2783 S7 Recover and explain factory failures.
- #1886 One authorized TODO starts one claimed Cloud run (label admission).
- #3164 Github.Pr/Git.Pr build targets: do-not-implement (deferred).
- #1667 Single-owner self-host admission (also named in mvp.md §6.2).
- #3385 / #3404 MVP scope cuts (non-GitHub integrations removed; GitHub kept).
- No open issue found for: app-manifest flow, review-comment ingestion, thread replies, stacked PR bases, foreign-push ingestion, force-push handling, sync-status UI. (Search terms: "GitHub App", "review comment", "force push", "webhook". File these.)

## Risks and unknowns (falsifiable)
1. Spec's "Built" for checks and "Partial" for reviews overstate or understate: checks only reach the gate on automerge items. Confirm: run a non-automerge TODO to `proposed` with failing CI, read `GET .../mythical` item `checks` and `reason`; expect none.
2. `mirror: "pull"` default: undeclared repos are skipped, so a fresh install never follows GitHub `main`. Confirm: fresh repo without `.smithers/factory.json`, read `GET /api/repos/{o}/{r}/github/main-pull`, expect `state: skipped`, `policy: undeclared`.
3. Stacked bases conflict with the invariant that each PR's tree is the verified candidate on the current main tip (`:2016-2023`). Confirm by reading `integrate` (`:1812`): candidates are rebuilt on `TipCommit`, whose parent is main, not on a sibling TODO's branch.
4. Webhooks may never arrive for self-host behind NAT (M-03), so the 8 h backstop (`github_synced_repos.go:1272-1274`) only applies if a heartbeat exists; with no heartbeat it is 10 min. Confirm: a repo with `last_webhook_at` null reconciles every 10 min.
5. Cost model above assumes scoped tokens are uncached and 304s are free. Confirm: count outbound calls with `X-RateLimit-Remaining` deltas over 10 min for one repo with 10 PRs.
6. The `smitherspreviewrelease` App slug and settings URL are hard-coded (`repo_connection_github_app.go:96`, `github_access_diagnosis.go:59`); a manifest-created App has a different slug. Confirm: grep for the constants in any install-URL builder.
7. Idempotency of `todo` (`TodoEvent`) depends on GitHub's issue-events API (`labelHistory`, `mythical_github.go:398`); a >100-event issue or a missed page could mis-attribute the applier. Confirm: test with an issue holding more than one page of events.
