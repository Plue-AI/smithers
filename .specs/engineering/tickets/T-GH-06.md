# T-GH-06 Outside push to a TODO branch: hold the agent's push; Needs you with Bring in or Discard (M-33)

Stage S1 · Size M · Depends on T-GH-02, T-STK-07 · Unblocks — · Issue: to file
Spec: spec.md §4.1 (`in_review → needs_you`, `needs_you → working` on Bring in, `needs_you → in_review` on Discard), §6.1.2 (in-card), §9.4, §10.5.4, §10.8.1, §10.8.2, §12.3 (push row), §12.4.1, §12.5.2, §14.5.2 · Delta: delta.md §7 "Foreign push…" · Product: mvp.md J10.3, §6.3 "Someone pushes to a TODO's branch from a laptop", M-33

## Goal
Smithers never overwrites a person's commit (M-33). When anyone other than Smithers pushes to a TODO's `smithers/<slug>` branch on GitHub, whether the TODO is working or in review, Smithers holds the agent's next push and shows Needs you, "Alice pushed to `smithers/retry-webhooks` on GitHub", linking the commit, until a person chooses **Bring in** or **Discard**.

## Scope
In:
- Detection from T-GH-02: the refs stream's `refs/heads/<github_branch>` or the pulls stream's head sha differs from the head Smithers recorded. A sha that equals a pending outbound push's intended head (T-GH-09) is Smithers' own and raises nothing.
- Effect: `needs_you{kind: foreign_push, by, sha}` on that TODO (§10.8.1, §12.3), from `working` or `in_review`, with the commit link `https://github.com/<o>/<r>/commit/<sha>`. `by` = the pusher from `GET /repos/{o}/{r}/activity?ref=refs/heads/<branch>`, else the commit author's login. Its action is Review → `/todo Tn` (§14.5.2). The commit is fetched into the host repository store at once.
- The hold: while the Needs you is open, the stack engine makes no push to that branch, whatever the run produces.
- Answers, as `in-card` commands (Appendix B.4), first answer wins (§10.8.2). Both are `agent: confirm`: an agent's choice posts a one-click confirmation the member presses (§15.1.5).
  - **Bring in** (`branch.bring-in`, any member; `needs_you → working`): the run rebases the item onto the pushed commit at its next checkpoint (§9.4); the coding agent resolves conflicts, with T-STK-08's one attempt then Needs you; the pushed change becomes part of the item's change, attributed to the pusher in activity.
  - **Discard** (`branch.discard-foreign`, maintainers only): explicit. The commit is kept at `refs/smithers/kept/<sha>` in the host repository store and linked from activity. The next verified push proceeds with `--force-with-lease` against the observed foreign sha; if the branch moved again, the push is refused and the Needs you is raised again for the newer sha. The TODO returns to `in_review`, or to `working` when its run still has work (§4.1).
- A second outside push while the Needs you is open updates it to name the newer sha; both commits are kept. Nothing Smithers didn't see is overwritten.

Out: merging laptop pushes into the live working copy outside a checkpoint ([D] §12.3); **Open on a machine** for teammates' own branches ([D]); pushes to `main` (T-GH-07); pushes to branches that belong to no TODO (ignored); conflict resolution itself (T-STK-08).

## Changes
- `packages/backend/internal/services/github_inbound_pushes.go` (new) → the T-GH-02 consumer: compare, resolve `by`, fetch the commit, raise the Needs you through T-STK-07's API.
- `packages/backend/internal/services/mythical_items.go:2066-2079` (`pushProposal`) → refuse to push while a `foreign_push` Needs you is open; after Discard the lease target is the observed foreign sha, after Bring in the brought-in head, else the recorded head.
- Bring in → signal the TODO's `todo` run with `bring_in{sha}`; the run's next checkpoint rebases onto it through the engine's rebase path (T-STK-08), and one `activity` row records the brought-in commit with the pusher as actor.
- Discard → write `refs/smithers/kept/<sha>` in the host repository store, one `activity` row linking it, settle the wait.
- `packages/backend/internal/services/mythical_items.go:2201-2208` (`follow`, the `moved:` hold and `ForeignHead`) → delete. `ForeignHead` and its readers go too: `:2241` (`gate`), `:2794`, the struct field `:3345-3347`, and `mythical_land_todo.go:117`.
- `mythical_items.go:1999` and `:2057` (`propose`: `blocked`, "moved outside Smithers") → raise `needs_you{foreign_push}` instead.
- Catalog: `branch.bring-in` and `branch.discard-foreign` as `in-card` commands with `agent: confirm`; OpenAPI rows for their answer payloads in `docs/api/openapi/todos.yaml`.
- `packages/backend/docs/github-sync.md` → "Pushes from outside" section; docs gates as in T-GH-02.

## Tests
- Unit, `github_inbound_pushes_test.go` (new): no Needs you when the observed sha equals the recorded head or a pending push's head; Needs you otherwise, from `working` and from `in_review`; `pushProposal` refuses while it is open; the lease target follows the answer.
- Integration, real PostgreSQL + real git + `githubfake` smart HTTP over a bare repository: a second clone pushes to the TODO branch of an `in_review` TODO. One refs cycle later the TODO has `needs_you{foreign_push, by, sha}`, the commit is in the host store, and the item's change and the stack are byte-identical. A verified candidate produced meanwhile isn't pushed.
- Integration: the same push while the TODO is `working` after a steer raises the same Needs you, and the run's next proposal is held.
- Integration, Bring in: the run rebases onto the commit at its next checkpoint; the next verified push descends from it; the activity names the pusher.
- Integration, Discard: a member's Discard is refused with class `permission`; a maintainer's writes `refs/smithers/kept/<sha>`, and the next verified push replaces the branch head with Smithers' candidate, leased against that sha.
- Integration: a push that lands between Discard and Smithers' push makes the lease fail and re-raises the Needs you for the newer sha.
- Integration: an app-agent Bring in creates a one-click confirmation and acts only after the member presses it.
- Fault, shared with T-GH-09: the host dies after its own push lands but before it records the head → no `foreign_push` after restart.
- e2e: [C-J10-03](../checks/C-J10-03.md).

## Acceptance
- [C-J10-03](../checks/C-J10-03.md): a push from a laptop to a TODO branch, in review or working, holds the agent's push and shows Needs you; Bring in rebases onto it; Discard keeps it in history.

## Risks and notes
- Risk: the repository activity API may not list App-token pushes, or may lag. Confirmed when C-J10-03's `by` falls back to the commit author for a push made by Alice's own account.
- Risk: a crash between push and record raises Needs you for Smithers' own commit. Confirmed by the fault test above.
