# T-GH-07 Force-push to `main` becomes Needs you for the owner

Stage S1 · Size S · Depends on T-GH-02, T-STK-07, T-GH-05, T-ACC-03, T-FLW-03 · Unblocks T-APP-01, T-APP-08, T-GH-08, T-REL-02 · Issue: [#3519](https://github.com/smithersai/smithers/issues/3519)
Spec: spec.md §4.1.2a, §6.1.2 (in-card), §10.1, §10.5.1, §10.8.1, §11.3.1, §12.3 (`main` rewritten row), §14.5.2 · Delta: delta.md §7 "Force-push to `main`…" · Product: mvp.md §6.3 "`main` rewritten on GitHub", M-22

## Goal
When `main` on GitHub is rewritten (not a fast-forward), the owner sees it on the Needs you card for `main`, and nothing in Smithers changes until the owner confirms. Then the mirror resets to the new `main` and the stack rebases onto it. Check: C-J10-07.

## Scope
In:
- Detection by the refs stream (T-GH-02): GitHub's `main` tip doesn't descend from the mirror's `main`. The result is a typed `force_push{old, new}` outcome, not a failure with backoff.
- Effect: `stack_attention{kind: force_push, old, new}` for the owner only (§4.1.2a, §12.3). It is stack-level, not a TODO state, and it holds the stack's merges until settled.
- Before confirm, nothing moves: the mirror's `main`, the stack order, `mythical` history, TODO states, PR branches and flow versions stay as they were. The other streams keep polling.
- **Reset to GitHub main** is an `in-card` command (§6.1.2), owner session only; other roles and agent credentials get 403. It is bound to `(old, new)`: if GitHub's `main` moved again since, it is refused as stale and the attention row names the newer tip.
- On confirm: reset the mirror's `main` to `new` through one guarded path, then publish "main moved" as for a fast-forward. Later items get `rebase_pending` (§10.5.1), and a flow load runs (§11.3.1).
- Smithers never writes GitHub's `main` (§10.1).

Out: accepting resets from agents or posting delegated confirmations; a slash, CLI or skill reset door; automatic reset or GitHub main writes; UI Views and Containers; rebase execution and its conflicts (T-STK-08, T-STK-11); the Home card row (T-APP-01); health (T-GH-08); recovering work that existed only in the rewritten commits (none exists in Smithers, since `main` is read-only).

## Changes
- `packages/backend/internal/services/github_main_pull.go:589-591` → the non-ancestor case returns `force_push{old, new}` and opens the attention row through T-STK-07's `stack_attention` API; delete the retry with backoff (`gitHubMainPullBaseBackoff`/`MaxBackoff`, `:51-52`) for this case.
- `github_main_pull.go` → add `ResetToGitHub(ctx, repositoryID, old, new)`, the only non-fast-forward write to the mirror's `main`. It re-reads GitHub's tip, refuses when it isn't `new`, and moves the bookmark with an expected-old check. Record the owner's bound reset intent in the attention payload before moving the ref. Boot recovery compares the mirror with `old`/`new`: keep the attention open at `old`; at `new`, finish the same main-moved effects and settle once; any other tip keeps attention open without overwriting it. Check: C-J10-07.
- `packages/backend/internal/services/mythical.go:125` (`MainMoved`) → called after a confirmed reset exactly as after a fast-forward; queue T-FLW-03's background machine-only flow load after the reset, never before confirmation. Check: C-J10-07.
- The `in-card` command `main.reset-to-github` (**Reset to GitHub main**, Owner only) → `POST /api/stack/attention/{id} {action: reset}`, the route T-GH-05's **OK** (`order.ok`) shares. Reset carries the attention id, displayed `(old, new)` and `Idempotency-Key`; server authorization uses `main.reset-to-github`, never OK's maintainer policy. OpenAPI row in `docs/api/openapi/` plus re-bundle. Check: C-J10-07.
- `packages/backend/docs/github-sync.md` → "`main` rewritten on GitHub" section; docs gates as in T-GH-02.

## Tests
- Unit, `github_main_pull_test.go` (existing): non-ancestor gives `force_push{old, new}`; fast-forward is unchanged.
- Integration, real PostgreSQL + real git + `githubfake`: start the production install refs worker and route composition, inject only clock/GitHub, and invoke `POST /api/stack/attention/{id} {action: reset}` through the catalog authorizer. [C-J10-07](../checks/C-J10-07.md).
- Integration: a maintainer, a member and a delegated credential are refused **Reset to GitHub main**; the owner's session settles it.
- Integration: a merge request while the attention row is open is refused with class `conflict`.
- Integration: a second rewrite before confirm makes the first confirm stale; the attention row names the second tip.
- Fault, `github_main_pull_db_test.go` (existing): the host dies inside `ResetToGitHub`. After restart the mirror's `main` is either `old` with the attention row still open, or `new` with it settled; never a third value.

## Acceptance


- [C-J10-07](../checks/C-J10-07.md): a force-push to `main` gives the owner a confirmation on the Home card, and nothing changes before the confirm.

## Risks and notes
- Risk: a merge from Smithers can race the rewrite, merging a PR into the old `main` as someone force-pushes. Confirmed when the merge API returns a commit that isn't on the new tip. The TODO turns Merged only once `main` contains its commit (§4.1 guard), so it stays In review in that case.
- Resolved (smithers-8a accepts this default; Will decides a product exception): a merged TODO whose commit a `main` rewrite dropped stays Merged, with the note "commit no longer on main after a force push" and a line in the force_push attention summary. Nothing reopens automatically.

## Ready checklist

1. T-GH-02 supplies refs dispatch; T-STK-07 supplies attention storage; T-GH-05 supplies the shared attention route; T-ACC-03 supplies owner-session authorization and inherits the catalog; T-FLW-03 supplies the machine-only main-moved flow loader. Rebase execution and Home rendering remain downstream acceptance dependencies.
2. Out excludes agent resets/confirmations, extra command doors, automatic reset, GitHub main writes, Views/Containers, rebase execution and recovery of discarded GitHub-only work.
3. C-J10-07 starts the production refs worker and calls the composed attention route. Fault tests restart the real install composition around the durable reset intent. Commit literal role, ref and unchanged-table fixtures; no test reads spec files or derives expected results from production code at runtime. Assert no machine flow-load admission before confirmation and one bound load after it.
4. smithers-3f approves guarded mirror writes and reset recovery; smithers-b8 signs off the public route/catalog contract; smithers-8a accepts the note for already-merged commits removed from main and the shared-route policy split; Will decides changes to that product behavior. Check: C-J10-07.
5. Before start, smithers-3f: does the expected-old write serialize with main pulls and merges; can reset recover without a third-value overwrite or duplicate effects; does flow loading remain machine-only? smithers-b8: does reset use owner-session eligibility independently of maintainer OK? smithers-38: do attention old/new fields fit the topic schema? smithers-06: can the existing Home attention View show the bound reset and a stale-tip refusal without a new component?
6. GitHub commits remain untrusted data; host mirror operations disable repository hooks/helpers. Reset cannot evaluate repository flows: T-FLW-03 admits their load in a machine (§1.3, M-29), and no host fallback exists. smithers-3f reviews this boundary. C-J10-07 proves owner-only effects and admission ordering; C-SEC-02 proves machine-only execution.
