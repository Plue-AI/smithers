# T-GH-06 Outside push to a TODO branch: hold the agent's push; Needs you with Bring in or Discard (M-33)

Stage S1 · Size M · Depends on T-GH-02, T-STK-01, T-UI-04, T-GH-03, T-GH-09, T-STK-08 (S1), T-ACC-03, T-APP-04 (confirmations), T-CAT-01, T-SEC-01 · Unblocks T-APP-02, T-FLW-09 · Issue: [#3518](https://github.com/smithersai/smithers/issues/3518)
Spec: spec.md §4.1 (`in_review → needs_you`, `needs_you → working` on Bring in, `needs_you → in_review` on Discard), §6.1.2 (in-card), §9.4, §10.5.4, §10.8.1, §10.8.2, §12.3 (push row), §12.4.1, §12.5.2, §14.5.2 · Delta: delta.md §7 "Foreign push…" · Product: mvp.md J10.3, §6.3 "Someone pushes to a TODO's branch from a laptop", M-33
Ready: 2026-10-03 smithers-8a sha256:b94a29e95513

## Goal
Smithers never overwrites a person's commit (M-33). When anyone other than Smithers pushes to a TODO's `smithers/<slug>` branch on GitHub, in any unmerged state with an open PR, Smithers holds the agent's next push and shows Needs you, "Alice pushed to `smithers/retry-webhooks` on GitHub", linking the commit, until a person chooses **Bring in** or **Discard**.

## Scope

- Land dark against every unlanded dependency contract. Until T-GH-02/03 supply current facts and the shared decision seam, or T-GH-09 supplies reconciled own-push intents and leases, refuse TODO-branch publication rather than classify an unknown head as safe. Until T-STK-01 supplies bound independent waits, refuse both answers and publication. Until T-STK-08 (S1) and its machine/run providers are available, retain Bring in as pending without settling the hold or running on the host. Until T-ACC-03, T-APP-04 and T-CAT-01 supply authorization, confirmation and descriptor dispatch, refuse answers without effects. Until T-SEC-01 validates guest root inputs, refuse machine execution. Until T-UI-04 supplies the adopted Actions contract, expose no active answer controls. Enable each integration only after its production-boundary tests pass. Check: C-J10-03; folded C-GH-13 and C-STK-08 tests; C-SEC-02.

- Bind Bring in and Discard to TodoCard waits[] {id, ..., sha} via the existing RPC schema. Use sha on the card and revision on the command input: revision equals the displayed wait sha. Carry the displayed wait id with both inputs and validate id plus revision before settlement. Preserve by attribution and first-answer rules. Check: C-J10-03.
In:
- Detection from T-GH-02: the refs stream's `refs/heads/<github_branch>` or the pulls stream's head sha differs from the head Smithers recorded. A sha that equals a pending outbound push's intended head (T-GH-09) is Smithers' own and raises nothing.
- Effect: `waits[] {id, kind: foreign_push, by, sha}` on that TODO (§10.8.1, §12.3), in any unmerged state with an open PR, without clearing other waits or `paused_at` (§12.3.0a), with the commit link `https://github.com/<o>/<r>/commit/<sha>`. `by` = the pusher from `GET /repos/{o}/{r}/activity?ref=refs/heads/<branch>`, else the commit author's login. Its action is Review → `/todo Tn` (§14.5.2). The commit is fetched into the host repository store at once.
- The hold: while the Needs you is open, the stack engine makes no push to that branch, whatever the run produces.
- Answers, as `in-card` commands (Appendix B.4), first answer wins (§10.8.2). Both are `agent: confirm`: an agent's choice posts a one-click confirmation the member presses (§15.1.5). Each answer carries the sha the card showed (command input `{id, revision}`, with revision equal to the displayed sha, §6.3). A sha that isn't the Needs you's current one is refused with class `conflict`, and the card shows the newer push (§12.3). For a Discard requested by an agent, the requesting member must be a maintainer before the confirmation is posted (§6.1.2b).
  - **Bring in** (`branch.bring-in`, any member; `needs_you → working`): the run rebases the item onto the pushed commit at its next checkpoint (§9.4); the coding agent resolves conflicts, with T-STK-08's one attempt then Needs you; the pushed change becomes part of the item's change, attributed to the pusher in activity.
  - **Discard** (`branch.discard-foreign`, maintainers only): explicit. The commit is kept at `refs/smithers/kept/<sha>` in the host repository store and linked from activity. The next verified push proceeds with `--force-with-lease` against the observed foreign sha; if the branch moved again, the push is refused and the Needs you is raised again for the newer sha. Settling this wait restores the state given by §4.1.0a; other waits, pause and failure facts remain. In queued or starting with no PR, record the push and lease the next proposal against it (§12.3.0a).
- A second outside push while the Needs you is open updates it to name the newer sha; both commits are kept. Nothing Smithers didn't see is overwritten.

Out: automatic Bring in or Discard; a slash, CLI or skill door for these in-card controls; UI Views and Containers; agent confirmation-policy changes; host execution of repository code; new wait tables, private fact mappers, new pollers and root helpers; merging laptop pushes into the live working copy outside a checkpoint ([D] §12.3); **Open on a machine** for teammates' own branches ([D]); pushes to `main` (T-GH-07); pushes to branches that belong to no TODO (ignored); conflict resolution itself (T-STK-08). Bring in never calls the host-side integrate/rebaseCandidate path; it uses T-STK-08’s checkpoint rebase and machine-only conflict resolution. Check:
- Alternate commit-field names and RPC implementation outside the existing RPC schema are excluded. C-J10-03.

## Changes

- Bind Bring in and Discard to TodoCard waits[] {id, ..., sha} via the existing RPC schema. Use sha on the card and revision on the command input: revision equals the displayed wait sha. Carry the displayed wait id with both inputs and validate id plus revision before settlement. Preserve by attribution and first-answer rules. Check: C-J10-03.

- Reuse T-GH-03’s `decideGitHubFact` seam reshaped from `packages/backend/internal/services/mythical_items.go:2163` (`follow`) and `:2827` (`ObserveGitHubEvent`); no private mapping or required new `github_inbound.go` module. Unit fixtures cover fact/state/duplicate/reordered cells; DB integration proves this consumer calls the seam. Check: C-GH-13 (folded into T-GH-04’s tests).

- Reshape `packages/backend/internal/services/mythical_items.go:2163` (`follow`) as the T-GH-02 foreign-push consumer: compare, resolve `by`, fetch the commit, raise the Needs you through T-STK-01’s API. Reuse the existing freeze and GitHub transport; no new consumer module or poller.
- `packages/backend/internal/services/mythical_items.go:2066-2079` (`pushProposal`) → refuse to push while a `foreign_push` Needs you is open; after Discard the lease target is the observed foreign sha, after Bring in the brought-in head, else the recorded head.
- Bring in → signal the TODO's `todo` run with `bring_in{sha}`; the run's next checkpoint rebases onto it through the engine's rebase path (T-STK-08), and one `activity` row records the brought-in commit with the pusher as actor.
- Discard → write `refs/smithers/kept/<sha>` in the host repository store, one `activity` row linking it, settle the wait.
- Reshape `packages/backend/internal/services/mythical_items.go:2201-2208` (`follow`, the `moved:` hold) into the bound foreign-push wait. Retain `checks.ForeignHead` (`:3345-3347`) as its durable sha source under §10.8.0; reshape its readers at `:2241` (`gate`), `:2794`, and `packages/backend/internal/services/mythical_land_todo.go:117` to use independent-wait settlement and the publication hold. Remove the obsolete `moved:` behavior and unconditional clearing at `:2213` in the same change.
- `mythical_items.go:1999` and `:2057` (`propose`: `blocked`, "moved outside Smithers") → raise `needs_you{foreign_push}` instead.
- Catalog: `branch.bring-in` and `branch.discard-foreign` as `in-card` commands with `agent: confirm`; Use `POST /api/branches/{b}` for both answers, with the wait id, displayed sha and `Idempotency-Key`; Reshape the existing route implementation in `packages/backend/internal/routes/mythical.go` and document the branch answer contract in existing `docs/api/openapi/repositories.yaml`; no new OpenAPI module. The branch route is the spec’d target, not a route present in main today.
- Extend existing `packages/backend/docs/github-app.md` with "Pushes from outside"; use T-GH-02’s sync documentation if it has landed. No standalone document is required.
- New production modules and tables: none. Reuse `packages/rpc/src/TodoCard.ts:28` (`TodoWaitSchema`) for id/by/sha, existing item checks and activity, and existing GitHub transport.

## Tests

- Decode two simultaneous waits and dispatch Bring in/Discard with the foreign_push id and revision equal to its displayed sha. Wrong ids and newer shas refuse without settling either wait, signaling a run or overwriting a branch. Check: C-J10-03.
- Unit, extend `packages/backend/internal/services/mythical_items_test.go`: no Needs you when the observed sha equals the recorded head or a pending push's head; Needs you otherwise, from `working` and from `in_review`; `pushProposal` refuses while it is open; the lease target follows the answer.
- Integration, extend `packages/backend/internal/services/mythical_items_test.go`, `packages/backend/internal/compose/github_sync_webhook_test.go` and the existing route suite: start the production install polling/stack worker composition with real PostgreSQL, real git and `githubfake` smart HTTP over a bare repository; inject only the clock and GitHub. Invoke answers through the composed `POST /api/branches/{b}` route and agent requests through the catalog/confirmation path: a second clone pushes to the TODO branch of an `in_review` TODO. One refs cycle later the TODO has `needs_you{foreign_push, by, sha}`, the commit is in the host store, and the item's change and the stack are byte-identical. A verified candidate produced meanwhile isn't pushed.
- Integration: fixed fixtures for working, paused, failed and a question wait with an open PR all raise the foreign-push wait and hold proposals; settling it preserves remaining waits, pause and failure. A queued/starting fixture with no PR records the observed sha for the next proposal lease. Check: C-GH-13, C-STK-08.
- Integration, Bring in: the run rebases onto the commit at its next checkpoint; the next verified push descends from it; the activity names the pusher.
- Integration, Discard: a member's Discard is refused with class `permission`; a maintainer's writes `refs/smithers/kept/<sha>`, and the next verified push replaces the branch head with Smithers' candidate, leased against that sha.
- Integration: a push that lands between Discard and Smithers' push makes the lease fail and re-raises the Needs you for the newer sha.
- Integration: with the Needs you naming `A3`, a Discard carrying `{id: foreignWaitId, revision: A2}` is refused with class `conflict` and changes nothing; one carrying `{id: foreignWaitId, revision: A3}` keeps `A3` and leases against it.
- Integration: the app agent's Discard for a Member is refused with class `permission`, and no `person_confirmations` row exists; for a maintainer it posts one, and acts only after the press.
- Integration: an app-agent Bring in creates a one-click confirmation and acts only after the member presses it.
- Fault, shared with T-GH-09: the host dies after its own push lands but before it records the head → no `foreign_push` after restart.
- Integration, `TestForeignPushUnavailableProvidersFailClosed`: drive production poll, branch answer, catalog confirmation and stack publication dispatch with each Scope provider unavailable. Assert no push, answer settlement, confirmation execution or host repository execution; recover providers and prove the retained wait completes once. Use literal fixture heads, roles, states and request logs, never spec files or production-derived expectations. Check: C-J10-03.
- e2e: [C-J10-03](../checks/C-J10-03.md). Its stale-answer request uses `{id, revision: A2}` through the production branch route. The check’s legacy `{sha}` example does not define a second payload contract.

## Acceptance

- [C-GH-13](../checks/C-GH-13.md): pure fact matrix and production consumers use one decision seam.

- [C-J10-03](../checks/C-J10-03.md): a push from a laptop to a TODO branch, in review or working, holds the agent's push and shows Needs you; Bring in rebases onto it; Discard keeps it in history.
- [C-STK-08](../checks/C-STK-08.md): Independent waits: question + foreign push, pause + conflict, Stop with open waits, resume after step 1, and merges on GitHub during a steer, a question or a pause each give the §4.1.0a state

## Risks and notes
- Risk: the repository activity API may not list App-token pushes, or may lag. Confirmed when C-J10-03's `by` falls back to the commit author for a push made by Alice's own account.
- Risk: a crash between push and record raises Needs you for Smithers' own commit. Confirmed by the fault test above.

## Security preconditions

No new root step is in scope. Bring in uses the existing machine launcher and unprivileged checkpoint path; host fetch/ref writes consume commits as data with hooks, helpers, external diff, textconv and config-selected drivers disabled. Repository flows, checks and conflict resolution never execute on the host. smithers-3f reviews the shared R1–R3 root inputs below, copied from T-SEC-01. Branch/member inputs block privileged use until `TestGuestHelperInstallPinsInterpreterAndEnv` (R1), `TestRootSetupNeverFollowsMemberSymlinks` (R2), and `TestRootPreflightParsesOnlyEnvelope` (R3) prove validation through production fresh/retained-machine paths in C-SEC-02. Branch-built root code is forbidden regardless of digest or test results. Missing validation leaves Bring in pending and publication held.

### R1

Inputs:

- Helper bytes and expected digest, fixed `/opt/smithers/guest` destination and install script — **main**, embedded into the **install-controlled** backend.
- `msb` executable/path, host child environment/PATH/HOME, machine identifier, deadlines — **install-controlled** runtime configuration/state; executable provenance must remain bundle-controlled.
- Guest image or layer/snapshot, `/bin/sh`, `python3`, `sha256sum`, `cut`, `mkdir`, `cat`, `mv`, executable search paths, Python startup/import paths and existing helper/temporary-file/parent entries — **install-controlled** base; snapshots/cache/environment can contain **branch-derived** and **member-controlled** entries. Digest comparison alone does not validate parent ownership, symlinks, interpreter provenance or startup imports.
- OCI image pull/metadata/blob responses — **install-controlled** pinned image selection, upstream registry responses; retained snapshot data — **install-controlled** state with **branch/member-derived** contents where applicable.

### R2

Inputs:

- Setup argv (login, UID, directories), fixed HOME_LINKS/GO_SETTINGS, helper source — **main** constants today; future member login/UID bindings — **install-controlled** DB allocations derived from **GitHub/member** identities, not arbitrary user argv.
- `/etc/passwd`/group account entries, `useradd`, shell, existing home path and account UID/GID — **install-controlled** image/account state.
- `/opt/smithers/env.json`: all keys/values, including PATH, PYTHONPATH, Go settings, tool-cache targets — generated from **main** code and **branch-derived** toolchain selection; file ownership and immutability are separate inputs.
- `/var/cache/smithers/home` names/entries, cache directories, existing `.cache`, `.config`, `.config/go`, `.config/go/env`, all ancestor/leaf symlinks and directory metadata — **branch-derived** dependency output and **member-controlled** retained home state.
- Kernel/filesystem responses to mkdir/stat/open/chown/chmod and symlink operations — **install-controlled** guest OS; which object they address can be **member-controlled**.

### R3

Inputs:

- JSON request id, argv, env, cwd, root, user and stdin mode; operation/path/content/mode/read limit for fs — **main/install-controlled** envelope and fixed identity fields, with **branch/member-controlled** argv, environment values, relative paths, file bytes and existing symlink graph. Capture metadata and command results are **branch/member-controlled** outputs.
- `/opt/smithers/env.json`, helper/interpreter startup environment, passwd/group records and guest directory state — sources as R1/R2.
- Terminal request ID, `/run/smithers/requests` directory/ancestors, request `.json` bytes, ownership/mode, stdin/file descriptors, terminal size and signal inputs — **main/install-controlled** IDs and transport settings; request payload and retained filesystem entries can be **branch/member-controlled**. Protected no-follow request creation/read/removal and bounded parsing are proved by TestRootPreflightParsesOnlyEnvelope.
- Host-generated exec IDs; kill/kill-all names, child directories, cgroup.procs/kill/events and their observed state — **main/install-controlled** IDs and kernel cgroup state; a guest command influences process population. Any selectable path/name must be validated against the fixed subtree.
- Relay/probe port, fixed host.microsandbox.internal bridge destination, ws relay-port metadata — **main/install-controlled**; bytes flowing over relay/TCP and associated peer responses — **member/branch-controlled** or authenticated host data, depending on channel.
- Fork/wait/signal/exit observations, filesystem resolution and network responses — **install-controlled** kernel responses influenced by member processes/network traffic.

## Ready checklist

1. Depends on supplies current refs/PR facts (T-GH-02), the shared decision seam and inherited retained generations/run delivery (T-GH-03), own-push reconciliation/leases (T-GH-09), independent waits (T-STK-01), checkpoint rebase and inherited machine/run providers (T-STK-08 S1), role checks (T-ACC-03), confirmations (T-APP-04), descriptor dispatch (T-CAT-01), root validation (T-SEC-01) and the View contract (T-UI-04). Scope defines dark landing for each unavailable provider; TestForeignPushUnavailableProvidersFailClosed proves refusal and recovery.
2. Out explicitly excludes automatic answers, extra slash/CLI/skill doors, Views/Containers, confirmation-policy changes, host repository execution, main pushes and unmanaged branches.
3. C-GH-13 and the integration test use production poll dispatch, branch answer routes and catalog confirmation dispatch. C-J10-03 uses the installed machine run. Commit literal sha/state/role fixtures; expected ancestry comes from fixture commits and expected effects from fixed request logs, never spec files or production-derived runtime values.
4. smithers-3f approves own-push detection, preserved refs, checkpoint signaling and lease semantics; smithers-b8 signs off command/answer contracts; smithers-38 approves wire changes; smithers-8a decides mapping and conflict-policy changes. Checks: C-GH-13, C-J10-03, C-STK-08.
5. Before start, smithers-3f: can pending own pushes survive a crash without raising a foreign wait; do answers preserve other waits and prevent stale leases; does Bring in call the single machine-safe rebase path? smithers-b8: do answer routes bind wait/sha and recheck the maintainer role at both confirmation boundaries? smithers-38: are wait/sha fields compatible with TODO models? smithers-06: can T-UI-04 render both answers and a newer-sha refusal through onAction/data-flow? smithers-3f: answered 18:2x, ok. smithers-b8: answered 18:23, ok. smithers-06: answered 18:3x, ok. Design condition: "ok. Bring in and Discard come as Actions with data-flow, and a newer-sha refusal shows as the action's disabled reason text." smithers-38: answered, changes applied (tech lead adopts).
6. M-29 and §1.3 confine repository execution to unprivileged machine users without host fallback. Security preconditions list all shared R1–R3 root inputs and sources and their named C-SEC-02 validation tests; branch-built root code remains forbidden. smithers-3f reviews these boundaries. C-J10-03 proves preserved commits, checkpoint execution and leases; TestForeignPushUnavailableProvidersFailClosed proves missing validation holds execution/publication.
