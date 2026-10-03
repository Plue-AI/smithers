# T-GH-06 Outside push to a TODO branch: hold the agent's push; Needs you with Bring in or Discard (M-33)

Stage S1 · Size M · Depends on T-GH-02, T-STK-07, T-UI-23, T-GH-05, T-GH-09, T-STK-08, T-ACC-03, T-ACC-05 · Unblocks T-APP-02, T-REL-02 · Issue: [#3518](https://github.com/smithersai/smithers/issues/3518)
Spec: spec.md §4.1 (`in_review → needs_you`, `needs_you → working` on Bring in, `needs_you → in_review` on Discard), §6.1.2 (in-card), §9.4, §10.5.4, §10.8.1, §10.8.2, §12.3 (push row), §12.4.1, §12.5.2, §14.5.2 · Delta: delta.md §7 "Foreign push…" · Product: mvp.md J10.3, §6.3 "Someone pushes to a TODO's branch from a laptop", M-33

## Goal
Smithers never overwrites a person's commit (M-33). When anyone other than Smithers pushes to a TODO's `smithers/<slug>` branch on GitHub, in any unmerged state with an open PR, Smithers holds the agent's next push and shows Needs you, "Alice pushed to `smithers/retry-webhooks` on GitHub", linking the commit, until a person chooses **Bring in** or **Discard**.

## Scope
In:
- Detection from T-GH-02: the refs stream's `refs/heads/<github_branch>` or the pulls stream's head sha differs from the head Smithers recorded. A sha that equals a pending outbound push's intended head (T-GH-09) is Smithers' own and raises nothing.
- Effect: `needs_you{kind: foreign_push, by, sha}` on that TODO (§10.8.1, §12.3), in any unmerged state with an open PR, without clearing other waits or `paused_at` (§12.3.0a), with the commit link `https://github.com/<o>/<r>/commit/<sha>`. `by` = the pusher from `GET /repos/{o}/{r}/activity?ref=refs/heads/<branch>`, else the commit author's login. Its action is Review → `/todo Tn` (§14.5.2). The commit is fetched into the host repository store at once.
- The hold: while the Needs you is open, the stack engine makes no push to that branch, whatever the run produces.
- Answers, as `in-card` commands (Appendix B.4), first answer wins (§10.8.2). Both are `agent: confirm`: an agent's choice posts a one-click confirmation the member presses (§15.1.5). Each answer carries the sha the card showed (`bring-in{sha}`, `discard-foreign{sha}`, §6.3). A sha that isn't the Needs you's current one is refused with class `conflict`, and the card shows the newer push (§12.3). For a Discard requested by an agent, the requesting member must be a maintainer before the confirmation is posted (§6.1.2b).
  - **Bring in** (`branch.bring-in`, any member; `needs_you → working`): the run rebases the item onto the pushed commit at its next checkpoint (§9.4); the coding agent resolves conflicts, with T-STK-08's one attempt then Needs you; the pushed change becomes part of the item's change, attributed to the pusher in activity.
  - **Discard** (`branch.discard-foreign`, maintainers only): explicit. The commit is kept at `refs/smithers/kept/<sha>` in the host repository store and linked from activity. The next verified push proceeds with `--force-with-lease` against the observed foreign sha; if the branch moved again, the push is refused and the Needs you is raised again for the newer sha. Settling this wait restores the state given by §4.1.0a; other waits, pause and failure facts remain. In queued or starting with no PR, record the push and lease the next proposal against it (§12.3.0a).
- A second outside push while the Needs you is open updates it to name the newer sha; both commits are kept. Nothing Smithers didn't see is overwritten.

Out: automatic Bring in or Discard; a slash, CLI or skill door for these in-card controls; UI Views and Containers; agent confirmation-policy changes; host execution of repository code; merging laptop pushes into the live working copy outside a checkpoint ([D] §12.3); **Open on a machine** for teammates' own branches ([D]); pushes to `main` (T-GH-07); pushes to branches that belong to no TODO (ignored); conflict resolution itself (T-STK-08). Bring in never calls the host-side integrate/rebaseCandidate path; it uses T-STK-08’s checkpoint rebase and machine-only conflict resolution. Check: C-J10-03.

## Changes

- Consume `decideGitHubFact` from `github_inbound.go`; no private mapping. Unit fixtures cover fact/state/duplicate/reordered cells; DB integration proves this consumer calls the seam. Check: C-GH-13.

- `packages/backend/internal/services/github_inbound_pushes.go` (new) → the T-GH-02 consumer: compare, resolve `by`, fetch the commit, raise the Needs you through T-STK-07's API.
- `packages/backend/internal/services/mythical_items.go:2066-2079` (`pushProposal`) → refuse to push while a `foreign_push` Needs you is open; after Discard the lease target is the observed foreign sha, after Bring in the brought-in head, else the recorded head.
- Bring in → signal the TODO's `todo` run with `bring_in{sha}`; the run's next checkpoint rebases onto it through the engine's rebase path (T-STK-08), and one `activity` row records the brought-in commit with the pusher as actor.
- Discard → write `refs/smithers/kept/<sha>` in the host repository store, one `activity` row linking it, settle the wait.
- `packages/backend/internal/services/mythical_items.go:2201-2208` (`follow`, the `moved:` hold and `ForeignHead`) → delete. `ForeignHead` and its readers go too: `:2241` (`gate`), `:2794`, the struct field `:3345-3347`, and `mythical_land_todo.go:117`.
- `mythical_items.go:1999` and `:2057` (`propose`: `blocked`, "moved outside Smithers") → raise `needs_you{foreign_push}` instead.
- Catalog: `branch.bring-in` and `branch.discard-foreign` as `in-card` commands with `agent: confirm`; Use `POST /api/branches/{b}` for both answers, with the wait id, displayed sha and `Idempotency-Key`; OpenAPI rows for their answer payloads in `docs/api/openapi/todos.yaml` (new).
- `packages/backend/docs/github-sync.md` → "Pushes from outside" section; docs gates as in T-GH-02.

## Tests
- Unit, `github_inbound_pushes_test.go` (new): no Needs you when the observed sha equals the recorded head or a pending push's head; Needs you otherwise, from `working` and from `in_review`; `pushProposal` refuses while it is open; the lease target follows the answer.
- Integration, `github_inbound_pushes_integration_test.go` (new): start the production install polling/stack worker composition with real PostgreSQL, real git and `githubfake` smart HTTP over a bare repository; inject only the clock and GitHub. Invoke answers through the composed `POST /api/branches/{b}` route and agent requests through the catalog/confirmation path: a second clone pushes to the TODO branch of an `in_review` TODO. One refs cycle later the TODO has `needs_you{foreign_push, by, sha}`, the commit is in the host store, and the item's change and the stack are byte-identical. A verified candidate produced meanwhile isn't pushed.
- Integration: fixed fixtures for working, paused, failed and a question wait with an open PR all raise the foreign-push wait and hold proposals; settling it preserves remaining waits, pause and failure. A queued/starting fixture with no PR records the observed sha for the next proposal lease. Check: C-GH-13, C-STK-08.
- Integration, Bring in: the run rebases onto the commit at its next checkpoint; the next verified push descends from it; the activity names the pusher.
- Integration, Discard: a member's Discard is refused with class `permission`; a maintainer's writes `refs/smithers/kept/<sha>`, and the next verified push replaces the branch head with Smithers' candidate, leased against that sha.
- Integration: a push that lands between Discard and Smithers' push makes the lease fail and re-raises the Needs you for the newer sha.
- Integration: with the Needs you naming `A3`, a Discard carrying `{sha: A2}` is refused with class `conflict` and changes nothing; one carrying `{sha: A3}` keeps `A3` and leases against it.
- Integration: the app agent's Discard for a Member is refused with class `permission`, and no `person_confirmations` row exists; for a maintainer it posts one, and acts only after the press.
- Integration: an app-agent Bring in creates a one-click confirmation and acts only after the member presses it.
- Fault, shared with T-GH-09: the host dies after its own push lands but before it records the head → no `foreign_push` after restart.
- e2e: [C-J10-03](../checks/C-J10-03.md).

## Acceptance



- [C-GH-13](../checks/C-GH-13.md): pure fact matrix and production consumers use one decision seam.

- [C-J10-03](../checks/C-J10-03.md): a push from a laptop to a TODO branch, in review or working, holds the agent's push and shows Needs you; Bring in rebases onto it; Discard keeps it in history.
- [C-STK-08](../checks/C-STK-08.md): Independent waits: question + foreign push, pause + conflict, Stop with open waits, resume after step 1, and merges on GitHub during a steer, a question or a pause each give the §4.1.0a state

## Risks and notes
- Risk: the repository activity API may not list App-token pushes, or may lag. Confirmed when C-J10-03's `by` falls back to the commit author for a push made by Alice's own account.
- Risk: a crash between push and record raises Needs you for Smithers' own commit. Confirmed by the fault test above.

## Ready checklist

1. T-GH-02 supplies refs/PR facts; T-GH-05 supplies the decision seam and inherits retained generations, state precedence and machine-safe run delivery; T-GH-09 supplies own-push intents and leases; T-STK-07 supplies independent waits; T-STK-08 supplies checkpoint rebase/conflict handling; T-ACC-03/05 supply role checks and person confirmations; T-UI-23 supplies the existing View contract.
2. Out explicitly excludes automatic answers, extra slash/CLI/skill doors, Views/Containers, confirmation-policy changes, host repository execution, main pushes and unmanaged branches.
3. C-GH-13 and the integration test use production poll dispatch, branch answer routes and catalog confirmation dispatch. C-J10-03 uses the installed machine run. Commit literal sha/state/role fixtures; expected ancestry comes from fixture commits and expected effects from fixed request logs, never spec files or production-derived runtime values.
4. smithers-3f approves own-push detection, preserved refs, checkpoint signaling and lease semantics; smithers-b8 signs off command/answer contracts; smithers-38 approves wire changes; smithers-8a decides mapping and conflict-policy changes. Checks: C-GH-13, C-J10-03, C-STK-08.
5. Before start, smithers-3f: can pending own pushes survive a crash without raising a foreign wait; do answers preserve other waits and prevent stale leases; does Bring in call the single machine-safe rebase path? smithers-b8: do answer routes bind wait/sha and recheck the maintainer role at both confirmation boundaries? smithers-38: are wait/sha fields compatible with TODO models? smithers-06: can T-UI-23 render both answers and a newer-sha refusal through onAction/data-flow? smithers-3f: answered 18:2x, ok. smithers-b8: answered 18:23, ok. smithers-06: answered 18:3x, ok. Design condition: "ok. Bring in and Discard come as Actions with data-flow, and a newer-sha refusal shows as the action's disabled reason text."
6. Fetch and preserve commits as data with repository hooks/helpers disabled on the host. Repository flows, coding agents, checks and working-copy conflict resolution run only in machines (§1.3, M-29), without host fallback. smithers-3f reviews these preconditions. C-J10-03 proves preservation/leases; C-SEC-02 proves machine-only execution.
