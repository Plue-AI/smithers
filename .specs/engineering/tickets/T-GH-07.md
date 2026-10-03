# T-GH-07 Follow `main`: always pull, sync health and Retry; a force-push becomes Needs you for the owner

Stage S1 · Size M · Depends on T-GH-02, T-STK-01, T-ACC-03, T-FLW-03, T-COL-02, T-UI-06 · Unblocks T-APP-01, T-APP-03, T-REL-02 · Issue: [#3519](https://github.com/smithersai/smithers/issues/3519)
Spec: spec.md §4.4, §4.1.2a, §6.1.2, §6.3 (`/api/github/sync`), §7.2 (`home`), §10.1, §10.5.1, §11.3.1, §12.2.3, §12.3 (`main` rows), §12.6, §14.3 (Home `main`) · Delta: delta.md §7 · Product: mvp.md J10.4, J10.6, J10.7, §6.3 "`main` moves", "`main` rewritten on GitHub", "Sync status", Appendix A `/github`, M-22

Rescoped by the minimal-code synthesis, 2026-10-03 (v2 ticket merges, GH-07+08; v1 §6 ancestor check 3 → 1). Absorbs T-GH-07 ([#3453](https://github.com/smithersai/smithers/issues/3453)).

## Goal
The install follows GitHub's `main` with no declaration. The Home card's `main` row reads "synced 40 s ago", turns gold past 120 s with Retry, and names the cause when GitHub refuses. When `main` is rewritten, the owner sees it as Needs you, and nothing moves until the owner presses **Reset to GitHub main**.

## Scope
In: always-pull following; health `fresh`, `stale`, `refused`, `limited` (precedence `refused` > `limited` > `stale` > `fresh`); `GET` and `POST /api/github/sync`; `github.retry` (Member, `agent: run`); force-push detection, the owner-only bound reset `{id, old, new}` and its crash recovery; one ancestor check.
Out: streams and budget (T-GH-02); Home and Settings rendering (T-APP-01, T-APP-03); rebases after a move (T-STK-08); GitHub App setup; any write to GitHub's `main`.

## Changes
- Reshape `services/github_main_pull.go:782` (`readGitHubMirrorPolicy`): the install's repository is always `pull`, never `skipped`.
- Reshape `github_main_pull.go:585-591`: a non-ancestor tip returns a typed `force_push{old, new}` and opens the owner's Needs you on the stack; delete the backoff retry for that case (`:51-52`).
- Reshape, ancestor check 3 → 1 (#3490): keep the `merge-base --is-ancestor` in `repohostserver/ancestry.go:14` as one helper; `repohostserver/git.go:519` and `cliGitHubMainPullGit.IsAncestor` (`github_main_pull.go:720`) call it and lose their copies.
- Reshape `github_main_pull.go`: add `ResetToGitHub(repositoryID, old, new)`, the only non-fast-forward write to the mirror's `main`, with an expected-old check under the repo-host write lock. It records the reset intent first; boot recovery keeps attention open at `old`, finishes once at `new`, and leaves a third tip alone with attention open.
- Reuse the waits on the TODO record (T-STK-01) for the attention row; no `stack_attention` table. Reset and order OK (T-GH-03) share `POST /api/stack/attention/{id}`.
- Reshape `compose/router.go:1122-1123`: in the install composition only, delete `GET/POST /api/repos/{owner}/{repo}/github/main-pull`; Plue keeps them.
- Reshape `apps/app/src/mainview/flows/entries/github.ts`: `/github` reads status only; Retry is the `in-card` `github.retry` through `cardActions`.
- New: `routes/github_sync.go` and a health evaluator with a stale-boundary timer (about 150 lines). Rejected reuse: the main-pull status route reports one stream and no health, and a poll-driven stale flag would miss the 120 s boundary when polling stops.

## Tests
- Unit: `fresh` at 119 s and 120 s, `stale` at 121 s; `refused` for `permission` and `not_installed`; `limited` carries `retry_at`; precedence holds.
- Unit: non-ancestor gives `force_push{old, new}`; fast-forward unchanged; all three former ancestor callers return the same answer on a fixed commit graph.
- Integration, real PostgreSQL, real git, `githubfake`, production router: no factory file and `github.mirror: none` both follow; Retry from a member session and a member-delegated credential fetches within 1 s unless `retry_at` or the budget forbids, and sends nothing during a 429 pause; a restart before 120 s still publishes one stale delta without a poll.
- Integration: reset from a maintainer, member or delegated credential returns 403; a stale `(old, new)` returns 409 `stale_attention`; a merge while the row is open returns `conflict`.
- Fault: kill inside `ResetToGitHub` before the ref write, after it, and after settlement; recovery yields one stack update and one machine-only flow load.

## Acceptance
- [C-J10-06](../checks/C-J10-06.md): the `main` row shows the age from `last_success_at`, turns gold past 120 s, and Retry recovers it.
- [C-J10-07](../checks/C-J10-07.md): a force-push gives the owner a confirmation; nothing changes before it.
- [C-SEC-02](../checks/C-SEC-02.md): main-moved flow loads run only in machines.

## Risks and notes
- Risk: a Smithers merge races the rewrite. The TODO turns Merged only once `main` contains its commit.
- A merged TODO whose commit a rewrite dropped stays Merged with the note "commit no longer on main after a force push" (smithers-8a default).
- Risk: client clock skew misstates the age; then the snapshot carries server time.
