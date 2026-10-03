# T-GH-07 Force-push to `main` becomes Needs you for the owner

Stage S1 · Size S · Depends on T-GH-02, T-STK-07 · Unblocks T-REL-02 · Issue: [#3519](https://github.com/smithersai/smithers/issues/3519)
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

Out: rebase execution and its conflicts (T-STK-08, T-STK-11); the Home card row (T-APP-01); health (T-GH-08); recovering work that existed only in the rewritten commits (none exists in Smithers, since `main` is read-only).

## Changes
- `packages/backend/internal/services/github_main_pull.go:589-591` → the non-ancestor case returns `force_push{old, new}` and opens the attention row through T-STK-07's `stack_attention` API; delete the retry with backoff (`gitHubMainPullBaseBackoff`/`MaxBackoff`, `:51-52`) for this case.
- `github_main_pull.go` → add `ResetToGitHub(ctx, repositoryID, old, new)`, the only non-fast-forward write to the mirror's `main`. It re-reads GitHub's tip, refuses when it isn't `new`, and moves the bookmark with an expected-old check.
- `packages/backend/internal/services/mythical.go:125` (`MainMoved`) → called after a confirmed reset exactly as after a fast-forward.
- The `in-card` command `main.reset-to-github` (**Reset to GitHub main**, Owner only) → `POST /api/stack/attention/{id} {action: reset}`, the route T-GH-05's **OK** (`order.ok`) shares; OpenAPI row in `docs/api/openapi/` plus re-bundle. Check: C-J10-07.
- `packages/backend/docs/github-sync.md` → "`main` rewritten on GitHub" section; docs gates as in T-GH-02.

## Tests
- Unit, `github_main_pull_test.go` (existing): non-ancestor gives `force_push{old, new}`; fast-forward is unchanged.
- Integration, real PostgreSQL + real git + `githubfake`: [C-J10-07](../checks/C-J10-07.md).
- Integration: a maintainer, a member and a delegated credential are refused **Reset to GitHub main**; the owner's session settles it.
- Integration: a merge request while the attention row is open is refused with class `conflict`.
- Integration: a second rewrite before confirm makes the first confirm stale; the attention row names the second tip.
- Fault, `github_main_pull_db_test.go` (existing): the host dies inside `ResetToGitHub`. After restart the mirror's `main` is either `old` with the attention row still open, or `new` with it settled; never a third value.

## Acceptance


- [C-J10-07](../checks/C-J10-07.md): a force-push to `main` gives the owner a confirmation on the Home card, and nothing changes before the confirm.

## Risks and notes
- Risk: a merge from Smithers can race the rewrite, merging a PR into the old `main` as someone force-pushes. Confirmed when the merge API returns a commit that isn't on the new tip. The TODO turns Merged only once `main` contains its commit (§4.1 guard), so it stays In review in that case.
- Resolved (tech lead default, product informed): a merged TODO whose commit a `main` rewrite dropped stays Merged, with the note "commit no longer on main after a force push" and a line in the force_push attention summary. Nothing reopens automatically.
