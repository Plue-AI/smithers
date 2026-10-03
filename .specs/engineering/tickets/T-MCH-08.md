# T-MCH-08 Fork from a revision; Add to stack as a new TODO; scratch becomes the item branch (M-32); fork after capture (S2)

Stage S1, S2 · Size M · Depends on S1: T-STK-01, T-STK-02, T-UI-04, T-ACC-03, T-CAT-01, T-APP-04, T-STK-12, T-COL-02, T-APP-09 · S2: T-COL-03, T-MCH-04 · Unblocks T-APP-10, T-APP-11, T-STK-05, T-STK-08 · Issue: [#3525](https://github.com/smithersai/smithers/issues/3525)
Spec: spec.md §8.1.1, §8.5, §10.2, §6.3 (`/api/branches`) · Delta: delta.md §3 (fork row) · Product: mvp.md J7.2, J7.3, §6.7 Fork, Appendix A (`/branch.fork`, `/branch.add-to-stack`), M-22
Ready: 2026-10-03 smithers-8a sha256:37ada07f5ed5

## Goal

A member forks `main` or an item into a scratch branch that starts from a revision without stopping any machine, and **Add to stack** turns that scratch branch into a new TODO's item branch, placed after the item it came from. The stack service performs both, and branch activity shows them as "Smithers, for Ben" (M-32).

## Scope

- Build against the specified dependency contracts. Lands dark until T-STK-01 (item/revision storage), T-STK-02 (create/place), T-STK-12 (verified heads and stack fence), T-ACC-03 (Authorize), T-CAT-01 (dispatch), T-APP-04 (private confirmations) and T-COL-02 (committed delivery): affected fork/add dispatch refuses before mutation or machine admission when a required provider is unavailable. Missing confirmation consumers return `503 infra/confirmation_unavailable`; no direct service or legacy route bypass executes the request. Check: C-J7-02.
- Lands dark until T-UI-04 and T-APP-09: Fork/Add actions stay unavailable until their View and actor adapter are wired; API authorization still applies. Lands dark until T-INS-02: refuse provisioning without the bundled microVM binding, with no host-process fallback. Lands dark until T-SEC-01: refuse new machine execution until the root-boundary tests below pass. These last two are enablement preconditions, not code/schema dependencies. Checks: C-J7-02, C-UI-13, C-SEC-02.
- S2 lands dark until T-COL-03 and T-MCH-04: retain S1 main/item verified-head behavior, refuse scratch-source forks, and do not claim live edits were captured. Once S2 is enabled, unavailable capture refuses awake fork/add before mutation; never fall back to a stale head or stop/snapshot. Lands dark until T-STK-05 integrates `FoldIntoForks`: no Drop command is supplied here; its real Drop check remains pending. Checks: C-J7-02, C-MCH-08.

- Extend branch.fork through the existing RPC schema with required from: "main" | Tn and optional name. branch.add-to-stack reuses todo.new placement {after?, before?} alongside text. Route placement through T-STK-02 and retain the source-based default when neither field is supplied. Check: C-MCH-08.

In:
- Fork and Add to stack are system flows run by the stack service, the only writer of branch history (§8.5.0, M-32). People, the app agent and external agents request them; nobody else writes the branch's history. Each writes one activity entry attributed to Smithers with the requester recorded, rendered "Smithers, for Ben".
- Stage 1 runs over today's workspaces (§8.5.0). `POST /api/branches fork{from: main|Tn, name?}` creates `scratch/<member>/<name>` (§8.1.1) as a branch projection backed by the existing `workspaces` row (§3.0, §8.1.2), with scratch kind and `forked_from {kind, ref, commit, base, item?}` (§8.5.3). For a fork of Tn, `base` is the revision Tn's own change is measured from in its last verified head (the previous item's verified candidate, or `main`), and `item` is Tn.
- Source revision in S1: `main` → the mirror's tip; an item → its last verified head (§10.3.2). Neither touches the source machine, so a fork never stops it (§8.5.2).
- Reshape the existing `SourceRef` pinned-commit creation path for a stack-service-resolved revision. Today `workspace_user_ref.go:36` accepts only caller-pushed refs and refuses Mythical-stack repositories; retain those public checks and add the internal authorized revision path. Reuse immutable source retention and guest checkout; do not pass an arbitrary commit as a caller ref. Check: C-J7-02.
- `POST /api/branches/{b} add-to-stack` (§8.5.3) in one stack-service transaction:
  - creates a TODO whose change is one jj change with parent `forked_from.base` and the scratch head's tree, and whose revision 1 carries captured source head and proposed diff context from `forked_from.base` to the scratch head, so a fork of T2 seeds T2's change plus the scratch edits (J7.3);
  - places it after the forked-from item by default (or `append` for a fork of `main`), or where the member picks through T-STK-02's placement;
  - renames the branch to `smithers/<slug>`, sets `kind = item` and `todo_id`, and keeps its workspace, working copy and the people on it.
- Scratch branches never reach GitHub (M-22). After Add to stack, the branch reaches GitHub like any item, when its PR is proposed (§12.5.2).
- Catalog rows `/branch.fork` (`agent: run`) and `/branch.add-to-stack` (`agent: confirm`, a one-click Confirm card, §15.1.5) with typed payloads (T-CAT-01).
- A scratch branch's Diff compares against its fork revision (§8.5.3).
- Drop keeps forked work (§8.5.3a): `FoldIntoForks(item)` in the stack service squashes a dropped item's change into the first later unmerged TODO whose `forked_from.item` is that item, before later items rebase. T-STK-05's drop calls it.

In, S2 (§8.5.1–§8.5.2), once T-COL-03 and T-MCH-04 land:
- Fork and Add to stack on an awake branch run an on-demand `capture()` first, so uncommitted work is included. Fork starts from the captured revision without stopping the source machine; Add to stack uses the captured scratch head (§8.5.3).
- Forking a scratch branch, which stage 1 refuses.

Out:
- A second placement shape and RPC implementation outside the existing RPC schema are excluded. No parallel branch, machine, TODO, activity or approval stores; no new stack writer, root helper, image build, toolchain detection, daemon implementation or launcher. Rebase now implementation belongs to T-STK-08.
- [D] **Replace Tn** (§0, §8.5.3). The `add-to-stack` schema has no mode; `replace` is absent from the OpenAPI document and the catalog.
- **Rebase now** on a scratch branch (§8.5.2a, T-STK-08). Dropping the source item (T-STK-05), except wiring its existing drop path to `FoldIntoForks`. The Branch card (T-APP-10).
- Disk-copy forks, source-machine stop/snapshot/resume, scratch pushes to GitHub, shared homes, credential copying, free-form history commands and edits to design-owned Views.

## Changes
- Reshape existing workspace creation and the Mythical stack service (delta.md §3). Fork and Add to stack call the stack service for every mythical_items mutation; system flows never write the table directly. Rebase now stays with T-STK-08. Check: C-MCH-08.

- Extend branch.fork through the existing RPC schema with required from: "main" | Tn and optional name. branch.add-to-stack reuses todo.new placement {after?, before?} alongside text. Route placement through T-STK-02 and retain the source-based default when neither field is supplied. Check: C-MCH-08.
- `apps/app/src/mainview/flows/entries/branches.ts` → extend the existing namespace with `branch.fork` and `branch.add-to-stack` flow entries. `apps/app/src/mainview/cards/TodoContainer.tsx` wires Fork and Add to stack through `cardActions` → `flowAction`; Fork sends `{from: Tn}`. Delegated Add to stack consumes `202 {confirmation: id, state: "pending"}` and renders T-APP-04’s private Confirm card; only the requesting person’s session press executes it. Checks: C-J7-02, C-UI-13.

- Include the surviving `ForkWorkspace` caller at `packages/backend/internal/services/workspace_provisioning.go:855` and its served route at `packages/backend/internal/compose/router.go:548` in the hosted compatibility decision. Any retained caller must use revision-based creation and preserve the no-stop guarantee. Check: C-J7-02.


- Reshape `packages/backend/internal/services/workspace_provisioning.go:855` and `workspace_user_ref.go:36`: resolve and retain the authorized source revision, create the scratch workspace, record fork metadata on existing workspace storage, and append activity through `product_job_events`. Extend existing workspace queries/migrations only for missing fork metadata and item linkage; no `branches` table. Reject a separate `branch_fork.go` service because existing workspace creation and the stack writer own these operations. Checks: C-J7-02, C-PRC-02.
- `packages/backend/internal/services/workspace_runtime.go:502-675` `forkRuntimeWorkspace` and `forkRuntimeWorkspaceAuthorized`: delete the wake, stop, cold snapshot, resume and boot-from-snapshot path (from `:550`). The scratch workspace is created at the fork's commit through `CreateWorkspace`'s `SourceRef` path (`workspace_provisioning.go:658`, `:780`).
- Reshape `packages/backend/internal/services/mythical_file_todo.go:45` and `mythical_git.go`: reuse T-STK-02's create-and-place and the existing history machinery for the change from `forked_from.base`, captured head and revision-1 context, then rename the same workspace's target bookmark. Add `FoldIntoForks(item)` to this writer for T-STK-05 to call; this ticket does not implement Drop. Reject a separate `branch_add_to_stack.go` service because it would duplicate the existing admission/history owner. Check: C-J7-02.
- Reshape `packages/backend/internal/routes/workspace.go:714` and `internal/compose/router.go:548` for the authorized branch operation routes; extend existing `docs/api/openapi/repositories.yaml` with `POST /api/branches` and `POST /api/branches/{b}` with `add-to-stack`; rebundle and regenerate clients. Reuse the handler and OpenAPI source rather than adding parallel `routes/branches.go` and `openapi/branches.yaml` files. Check: C-J7-02.
- `packages/rpc/src/CardAction.ts:116-117` → extend existing fork and add payloads; `packages/rpc/src/catalog/` (T-CAT-01) supplies their descriptors. Reuse `todo.new` placement types at `CardAction.ts:102`; do not add a second payload authority. Check: C-MCH-08.
- `docs/api/openapi/repositories.yaml` `POST …/workspaces/{id}/fork`: deleted with its route if no hosted consumer remains (see notes).

## Tests

- C-J7-02/C-MCH-08: through the production dispatcher and authenticated routes, remove each required provider in turn and assert zero branch/TODO/activity mutations, zero runtime calls and the specified refusal. Restore providers as positive controls. In S1 assert scratch-source refusal; in enabled S2 assert capture failure never selects an older head. Check disabled UI actions through C-UI-13.
- C-SEC-02: run `TestGuestHelperInstallPinsInterpreterAndEnv`, `TestRootSetupNeverFollowsMemberSymlinks` and `TestRootPreflightParsesOnlyEnvelope` on the fork-created machine through production fresh/retained provisioning, terminal/exec and file APIs. Use literal hostile interpreter/import/env, identity, path, symlink/race and cgroup/relay fixtures; observe no root canary or outside write and UID/GID drop before repository commands. S2 C-MCH-08 also observes capture under unprivileged `machined`, never the root broker. Repository hooks/config-selected helpers must not execute on the host during revision retention or transfer; seed hostile config with fixed host/guest canaries. No runtime code or spec supplies expected results.

C-MCH-08 (folded steps and assertions):
1. Record the source VM's boot id (`/proc/sys/kernel/random/boot_id`) and the counter loop's pid.
2. Ben forks T2: `POST /api/branches {from: "T2", name: "try-retry"}`.
3. Record the capture's commit C, the scratch branch's `forked_from`, and the source boot id and loop pid again.
4. Compute the largest gap between consecutive `.tick` lines during steps 2–3.
5. Fork T3 (asleep) and fork `main`.
6. Open a terminal on the scratch branch. `cat src/try.ts`, `jj log -r @-`.
7. Write a fixed uncommitted fixture edit on the awake scratch branch, invoke branch.add-to-stack through the production catalog dispatcher and complete its person confirmation. Assert the seed contains those fixture bytes after capture, the branch/workspace ids are preserved and no source machine stops.
8. Exercise every retained hosted ForkWorkspace consumer and its served workspace fork route with the compatibility decision applied. Verify revision-based creation and the same source boot id, loop pid and no-stop timing assertions; a deleted route is explicitly absent rather than silently falling back to stop/snapshot.

Pass when:
- The adopted owner contract passes: Decode and dispatch forks from main and T2; reject missing from. Test Add to stack with after and before independently and reject both together under todo.new placement rules. Verify explicit and default placement through production dispatch and Confirm.
- Step 8: retained hosted callers use revision-based creation and preserve the no-stop guarantee. No caller can reach the old wake/stop/snapshot path.
- Step 3: the boot id and loop pid are unchanged, and `forked_from.commit` equals C.
- Step 4: no gap exceeds 1 s.
- Step 5: the T3 fork starts from H3 with 0 runtime starts for T3's machine; the `main` fork starts from the mirror's `main` tip.
- Step 6: `src/try.ts` is present with its content at fork time, and the scratch branch's parent revision is C's.

Fail when:
- The source VM restarts or pauses (new boot id, the loop pid gone, or a gap over 1 s): the old stop-snapshot-resume path (`packages/backend/internal/services/workspace_runtime.go:547-560`) is still live.
- The fork copies the disk instead of starting from C. That shows as files written after C appearing in the fork.
- Forking an asleep item wakes it.


- Decode and dispatch forks from main and T2; reject missing from. Test Add to stack with after and before independently and reject both together under todo.new placement rules. Verify explicit and default placement through production dispatch and Confirm. Check: C-MCH-08.
- Mount the real TODO Container and record production flow dispatch. Fork dispatches `branch.fork` with literal `{from: "T2"}` once. Add to stack dispatches `branch.add-to-stack`; a delegated request returns literal pending 202 and displays its private Confirm card through T-APP-04 without creating a TODO until the person presses it. Checks: C-J7-02, C-UI-13.


- integration (real PostgreSQL, real jj, production catalog dispatcher and authenticated HTTP router): fork from `main` starts at the mirror tip; fork from T2 starts at T2's last verified head with 0 runtime operations on T2's workspace; `from` naming a scratch branch gets a typed `user`-class refusal until S2.
- integration: Add to stack creates Tk after the forked-from item with a seed patch equal to `jj diff` from `forked_from.base` to the scratch head, which holds T2's paths. The same branch id is now `smithers/<slug>`, kind `item`, with the same workspace id. No second workspace exists.
- integration: dropping T2 after Add to stack leaves Tk's tree byte-identical, and Tk's item diff from T1's candidate holds T2's change and the scratch edits. With T2 steered after the fork, Tk still holds T2's latest change after the drop. With Tk moved before T2, the drop leaves Tk's tree unchanged.
- integration: each operation writes exactly one activity entry, actor Smithers, requester Ben, rendered "Smithers, for Ben". The app agent's fork runs at once; its Add to stack runs only after Ben presses the Confirm card.
- integration: a scratch branch's commits never appear in a push to GitHub (the fake GitHub records zero ref updates for `scratch/*`).
- e2e, S1: C-J7-02.
- integration, S2 (reference host, real microVM): C-MCH-08. Also invoke Add to stack through the production dispatcher while the scratch branch is awake with an uncommitted fixture edit; its seed includes those bytes after capture and its workspace id stays unchanged.
- boundary integration: use `/branch.fork`, `/branch.add-to-stack`, the person's Confirm action and `/todo.drop` through the catalog dispatcher and the routed HTTP surface. Service-only calls do not prove authorization, confirmation, history-writer ownership or drop integration. Repeating the same `Idempotency-Key` creates one branch/TODO/activity entry (§6.2.1).
- Independent oracle: seed fixed repository trees and file bytes, then assert literal expected stack order, ids preserved and patch paths/content. `jj diff` and capture receipts are evidence to compare, not the sole source of expected results. No expectation reads spec files or derives the seed from production code at runtime.

## Acceptance

- [C-SEC-02](../checks/C-SEC-02.md): root validation and guest-only execution cases above pass before machine-backed fork/add is enabled.

- [C-J1-04](../checks/C-J1-04.md): S1 part at its named layer.


- [C-J7-02](../checks/C-J7-02.md), S1: landing qualifies fork T2 to scratch and Add to stack as a new TODO after T2 through the production stack-operation boundary, including FoldIntoForks. The real Drop portion completes after T-STK-05 lands and remains pending until then.
- [C-MCH-08](../checks/C-MCH-08.md), S2: fork never stops the source machine and starts from the captured revision.
- [C-UI-13](../checks/C-UI-13.md): A Container's model from a real topic parses with its schema and its actions come from `cardActions`; at each stage exit every §14.3 row of the stage is wired and no View is orphaned

## Risks and notes

- In S1 a fork of an item doesn't include its uncommitted work, only the last verified head. That is spec behavior (§8.5.0); C-J7-02 forks a working T2 and must not expect its live edits.
- In S1 workspaces are still per member (T-MCH-04 is S2), so "keeps the people on it" means the requester's workspace becomes the item's. Falsified if Add to stack creates a second workspace for the new item.
- Hosted Cloud may still call `ForkWorkspace` (`workspace_provisioning.go:855`) and `POST …/workspaces/{id}/fork`. smithers-3f and smithers-b8 verify hosted consumers; smithers-8a approves deletion or composition-specific retention before implementation. This ticket deletes only the runtime stop-snapshot path.

## Root steps, inputs and sources

smithers-3f reviews this inventory and the C-SEC-02 receipts before enabling machine execution. Reuse T-SEC-01's R1–R3 boundary and input inventory; do not add a root recipe. Branch-sourced inputs block enablement until the named test proves validation before privileged use. Root never installs, imports or executes branch-built code. Repository trees, command payloads and capture run only as unprivileged code inside machines (M-29).

- Fresh provisioning/helper installation: helper/bootstrap bytes, digest, fixed destination, argv, PATH/import policy, bundled `msb`, base interpreter/utilities and image selection come from main-pinned installed code/configuration; machine id, resource limits and deadlines come from install state. Image/registry responses and existing helper, temporary file, parent-directory and retained disk metadata are inputs; disk entries can be branch/member-sourced. `TestGuestHelperInstallPinsInterpreterAndEnv` proves provenance, bounded input, trusted ancestors, no-follow installation and replacement resistance.
- Root setup: login/UID/GID, fixed directories, setup helper and allowed account commands come from main; passwd/group, image directories and kernel/filesystem results come from the installed guest. Home/cache/ancestor entries and env.json toolchain values can be branch/member-sourced. `TestRootSetupNeverFollowsMemberSymlinks` proves fixed identities/destinations and no-follow ownership/mode changes; home defaults and branch environment apply only after UID drop.
- Exec/terminal/file supervision and cleanup: fixed identity envelope, exec/request ids, protected request directory, cgroup subtree, relay destination/port and helper come from main/install state. Request argv/env/cwd/root, file path/bytes/mode/limit, stdin, request-file entries, symlinks, session size/signals, process population and network bytes can be branch/member-sourced; kernel fork/wait/signal/cgroup responses come from the guest OS. `TestRootPreflightParsesOnlyEnvelope` proves bounded fixed-field parsing, protected request parents, identity/cgroup/relay validation and group/GID/UID drop before payload interpretation.
- S2 daemon startup uses T-COL-03's main-pinned installed daemon/broker bytes, fixed uid/gids, socketpair and init configuration, plus install-minted per-boot credentials and relay endpoints. Guest executable/parent entries can be branch/member-sourced and must pass `TestGuestHelperInstallPinsInterpreterAndEnv` on this production startup path before use. Capture's revision/paths/object bytes and RPC response are branch-sourced data consumed by unprivileged `machined` and the fixed host verifier; no root capture or writer freeze is introduced by fork/add. C-MCH-08 proves that boundary. The broker's unrelated session operations retain the validated supervision inputs above.

## Ready checklist

1. Dependencies: T-STK-01 item/revision schema, T-STK-02 placement, T-ACC-03 Authorize, and the listed View/catalog/Confirm/head/live/actor contracts are called or consumed; S2 calls T-COL-03 capture and T-MCH-04 identity. Scope gives fail-closed behavior for each unavailable provider. T-INS-02/T-SEC-01 enablement and T-STK-05 Drop integration stay out of Depends; their paths land dark.
2. Exclusions: Replace, scratch Rebase now, Drop beyond FoldIntoForks, Branch card, disk copies, source interruption, scratch pushes, credential copying, parallel stores/writers, root helpers/images/toolchains/daemon/launcher and design-owned Views are explicit. Changes reshapes existing workspace, stack, route, OpenAPI and RPC files (§3.0, delta.md §3).
3. Boundary tests: C-J7-02 drives app/catalog/Confirm/Drop; C-MCH-08 drives routed fork and awake Add to stack. Production provider-refusal and C-SEC-02 cases use fixed independent fixtures; no expectation reads spec or derives from production code. Real Drop evidence stays pending until its provider lands.
4. Decisions: smithers-8a accepts the stack-service and hosted-route compatibility decision; smithers-3f approves history/capture, revision retention, storage encoding and security; smithers-b8 approves commands/Containers and public HTTP compatibility; smithers-38 approves catalog/schema public API under §21.1; smithers-06 approves View props. Will decides product changes. No new ADR or parallel schema is introduced.
5. Owner pre-review: smithers-3f, smithers-b8, smithers-38 and smithers-06 before start. Do source resolution and capture preserve the sole history writer and never stop the source machine? Do Confirm, Add to stack and the Drop hook preserve the same branch/workspace and the fixed seed under routed retries? Do catalog schemas and action tags fit design's existing Views and preserve hosted consumers? smithers-3f: answered 18:2x, ok. smithers-b8: answered, BLOCKING edits applied (tech lead adopts). smithers-06: answered 18:3x, ok. Design condition: "ok for design. Fork, Add to stack and Drop arrive as Actions; Confirm shows the exact command text and who asked; no new View. The engineering semantics are yours." smithers-38: answered, changes applied (tech lead adopts).
6. Security: smithers-3f reviews guest-only execution and every root input in the inventory above. Main-pinned installed code is the only root executable source; branch/member data blocks enablement until the named C-SEC-02 validation tests pass on production provisioning/exec/file paths. S2 capture runs unprivileged; C-MCH-08 proves it. No sudo, copied credentials or host repository execution.
