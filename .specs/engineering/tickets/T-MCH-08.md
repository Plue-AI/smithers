# T-MCH-08 Fork from a revision; Add to stack as a new TODO; scratch becomes the item branch (M-32); fork after capture (S2)

Stage S1, S2 · Size M · Depends on S1: T-STK-02, T-UI-23, T-APP-19, T-INS-02, T-CAT-01, T-ACC-05, T-STK-12, T-COL-02, T-APP-09 · S2: T-COL-03, T-MCH-04 · Unblocks T-APP-10, T-REL-02, T-STK-05, T-STK-08 · Issue: [#3525](https://github.com/smithersai/smithers/issues/3525)
Spec: spec.md §8.1.1, §8.5, §10.2, §6.3 (`/api/branches`) · Delta: delta.md §3 (fork row) · Product: mvp.md J7.2, J7.3, §6.7 Fork, Appendix A (`/branch.fork`, `/branch.add-to-stack`), M-22

## Goal

A member forks `main` or an item into a scratch branch that starts from a revision without stopping any machine, and **Add to stack** turns that scratch branch into a new TODO's item branch, placed after the item it came from. The stack service performs both, and branch activity shows them as "Smithers, for Ben" (M-32).

## Scope

In:
- Fork and Add to stack are system flows run by the stack service, the only writer of branch history (§8.5.0, M-32). People, the app agent and external agents request them; nobody else writes the branch's history. Each writes one activity entry attributed to Smithers with the requester recorded, rendered "Smithers, for Ben".
- Stage 1 runs over today's workspaces (§8.5.0). `POST /api/branches fork{from: main|Tn, name?}` creates `scratch/<member>/<name>` (§8.1.1) as a `branches` row with `kind = scratch` and `forked_from {kind, ref, commit, base, item?}` (§8.5.3). For a fork of Tn, `base` is the revision Tn's own change is measured from in its last verified head (the previous item's verified candidate, or `main`), and `item` is Tn.
- Source revision in S1: `main` → the mirror's tip; an item → its last verified head (§10.3.2). Neither touches the source machine, so a fork never stops it (§8.5.2).
- The scratch branch's workspace is created at that commit through the existing `SourceRef` create path, not by a disk copy.
- `POST /api/branches/{b} add-to-stack` (§8.5.3) in one stack-service transaction:
  - creates a TODO whose change is one jj change with parent `forked_from.base` and the scratch head's tree, and whose revision 1 carries `seed_patch_blob` = the diff from `forked_from.base` to the scratch head, so a fork of T2 seeds T2's change plus the scratch edits (J7.3);
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
- [D] **Replace Tn** (§0, §8.5.3). The `add-to-stack` schema has no mode; `replace` is absent from the OpenAPI document and the catalog.
- **Rebase now** on a scratch branch (§8.5.2a, T-STK-08). Dropping the source item (T-STK-05), except wiring its existing drop path to `FoldIntoForks`. The Branch card (T-APP-10).
- Disk-copy forks, source-machine stop/snapshot/resume, scratch pushes to GitHub, shared homes, credential copying, free-form history commands and edits to design-owned Views.

## Changes
- `apps/app/src/mainview/flows/entries/` → add `branch.fork` and `branch.add-to-stack` flow entries. `TodoContainer` wires Fork and Add to stack through `cardActions` → `flowAction`; Fork sends `{from: Tn}`. Delegated Add to stack consumes `202 {confirmation: id, state: "pending"}` and renders T-APP-04’s private Confirm card; only the requesting person’s session press executes it. Checks: C-J7-02, C-UI-13.

- Include the surviving `ForkWorkspace` caller at `packages/backend/internal/services/workspace_provisioning.go:855` and its served route at `packages/backend/internal/compose/router.go:541` in the hosted compatibility decision. Any retained caller must use revision-based creation and preserve the no-stop guarantee. Check: C-J7-02.


- `packages/backend/internal/services/branch_fork.go` (new): resolve the source revision, create the `branches` row, record `forked_from`, write the activity entry.
- `packages/backend/internal/services/workspace_runtime.go:502-675` `forkRuntimeWorkspace` and `forkRuntimeWorkspaceAuthorized`: delete the wake, stop, cold snapshot, resume and boot-from-snapshot path (from `:550`). The scratch workspace is created at the fork's commit through `CreateWorkspace`'s `SourceRef` path (`workspace_provisioning.go:658`, `:780`).
- `packages/backend/internal/services/branch_add_to_stack.go` (new): make the change from `forked_from.base`, diff it into a blob, T-STK-02's create-and-place with `seed_patch_blob`, then the rename. `FoldIntoForks(item)` for the drop path. The workspace's target bookmark follows the new branch name.
- `packages/backend/internal/routes/branches.go` (new); `docs/api/openapi/branches.yaml` (new) gains `POST /api/branches` and `POST /api/branches/{b}` with `add-to-stack`; rebundle and regenerate clients.
- `packages/rpc/src/catalog/` (T-CAT-01): descriptors for `/branch.fork` and `/branch.add-to-stack`.
- `docs/api/openapi/repositories.yaml` `POST …/workspaces/{id}/fork`: deleted with its route if no hosted consumer remains (see notes).

## Tests
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



- [C-J1-04](../checks/C-J1-04.md): S1 part at its named layer.


- [C-J7-02](../checks/C-J7-02.md), S1: landing qualifies fork T2 to scratch and Add to stack as a new TODO after T2 through the production stack-operation boundary, including FoldIntoForks. The real Drop portion completes after T-STK-05 lands and remains pending until then.
- [C-MCH-08](../checks/C-MCH-08.md), S2: fork never stops the source machine and starts from the captured revision.
- [C-UI-13](../checks/C-UI-13.md): A Container's model from a real topic parses with its schema and its actions come from `cardActions`; at each stage exit every §14.3 row of the stage is wired and no View is orphaned

## Risks and notes

- In S1 a fork of an item doesn't include its uncommitted work, only the last verified head. That is spec behavior (§8.5.0); C-J7-02 forks a working T2 and must not expect its live edits.
- In S1 workspaces are still per member (T-MCH-04 is S2), so "keeps the people on it" means the requester's workspace becomes the item's. Falsified if Add to stack creates a second workspace for the new item.
- Hosted Cloud may still call `ForkWorkspace` (`workspace_provisioning.go:855`) and `POST …/workspaces/{id}/fork`. smithers-3f and smithers-b8 verify hosted consumers; smithers-8a approves deletion or composition-specific retention before implementation. This ticket deletes only the runtime stop-snapshot path.

## Ready checklist

1. Dependencies: S1 names placement, Views/schema, microVM launcher, catalog, person confirmations, verified candidates/fence, live delivery and actor rendering. Land the fork/add/fold primitive through the production stack-operation boundary before T-STK-05 consumes FoldIntoForks. S2 requires daemon capture and one machine per branch. The real Drop portion of C-J7-02 remains pending until T-STK-05 lands and is not counted as passed before then.
2. Exclusions: Replace, scratch Rebase now, Drop implementation beyond its hook, Branch card, disk-copy forks, scratch pushes, credential copying and design-owned Views are explicit.
3. Boundary tests: C-J7-02 drives app/catalog/Confirm/Drop; C-MCH-08 enters the routed fork endpoint and additionally proves awake Add to stack capture. Integration uses real PostgreSQL/jj and the production dispatcher/router with fixed repository fixtures and literal results, never runtime spec or code-derived expectations.
4. Decisions: smithers-8a accepts the stack-service and hosted-route compatibility decision; smithers-3f approves history/capture seams, smithers-b8 command and Container seams, smithers-38 catalog/schema public API under §21.1, and smithers-06 View props. Will decides product changes such as Replace or source interruption.
5. Owner pre-review: smithers-3f, smithers-b8, smithers-38 and smithers-06 before start. Do source resolution and capture preserve the sole history writer and never stop the source machine? Do Confirm, Add to stack and the Drop hook preserve the same branch/workspace and the fixed seed under routed retries? Do catalog schemas and action tags fit design's existing Views and preserve hosted consumers? smithers-3f: answered 18:2x, ok. smithers-b8: answered, BLOCKING edits applied (tech lead adopts). smithers-06: answered 18:3x, ok. Design condition: "ok for design. Fork, Add to stack and Drop arrive as Actions; Confirm shows the exact command text and who asked; no new View. The engineering semantics are yours."
6. Security: smithers-3f reviews launch, capture and credential boundaries before start. Repository code and scratch terminal commands run only in machines; host system flows call fixed stack-service operations and never load repository flows. SourceRef transfers a revision, not a disk, home or credentials; no member/agent sudo or provider keys in guests. C-J7-02/C-MCH-08 prove the actual runtime path.
