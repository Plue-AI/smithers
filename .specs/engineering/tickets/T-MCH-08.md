# T-MCH-08 Fork from a revision; Add to stack as a new TODO; scratch becomes the item branch (M-32); fork after capture (S2)

Stage S1, S2 · Size M · Depends on S1: T-STK-02, T-UI-23, T-APP-19 · S2: T-COL-03, T-MCH-04 · Unblocks T-APP-10, T-REL-02 · Issue: [#3525](https://github.com/smithersai/smithers/issues/3525)
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
- Forking an awake branch runs an on-demand `capture()` first, so uncommitted work is included, and the fork starts from the captured revision without stopping the source machine.
- Forking a scratch branch, which stage 1 refuses.

Out:
- [D] **Replace Tn** (§0, §8.5.3). The `add-to-stack` schema has no mode; `replace` is absent from the OpenAPI document and the catalog.
- **Rebase now** on a scratch branch (§8.5.2a, T-STK-08). Dropping the source item (T-STK-05). The Branch card (T-APP-10).

## Changes

- `packages/backend/internal/services/branch_fork.go` (new): resolve the source revision, create the `branches` row, record `forked_from`, write the activity entry.
- `packages/backend/internal/services/workspace_runtime.go:502-675` `forkRuntimeWorkspace` and `forkRuntimeWorkspaceAuthorized`: delete the wake, stop, cold snapshot, resume and boot-from-snapshot path (from `:550`). The scratch workspace is created at the fork's commit through `CreateWorkspace`'s `SourceRef` path (`workspace_provisioning.go:658`, `:780`).
- `packages/backend/internal/services/branch_add_to_stack.go` (new): make the change from `forked_from.base`, diff it into a blob, T-STK-02's create-and-place with `seed_patch_blob`, then the rename. `FoldIntoForks(item)` for the drop path. The workspace's target bookmark follows the new branch name.
- `packages/backend/internal/routes/branches.go` (new); `docs/api/openapi/branches.yaml` gains `POST /api/branches` and `POST /api/branches/{b}` with `add-to-stack`; rebundle and regenerate clients.
- `packages/rpc/src/catalog/` (T-CAT-01): descriptors for `/branch.fork` and `/branch.add-to-stack`.
- `docs/api/openapi/repositories.yaml` `POST …/workspaces/{id}/fork`: deleted with its route if no hosted consumer remains (see notes).

## Tests

- integration (real PostgreSQL, real jj): fork from `main` starts at the mirror tip; fork from T2 starts at T2's last verified head with 0 runtime operations on T2's workspace; `from` naming a scratch branch gets a typed `user`-class refusal until S2.
- integration: Add to stack creates Tk after the forked-from item with a seed patch equal to `jj diff` from `forked_from.base` to the scratch head, which holds T2's paths. The same branch id is now `smithers/<slug>`, kind `item`, with the same workspace id. No second workspace exists.
- integration: dropping T2 after Add to stack leaves Tk's tree byte-identical, and Tk's item diff from T1's candidate holds T2's change and the scratch edits. With T2 steered after the fork, Tk still holds T2's latest change after the drop. With Tk moved before T2, the drop leaves Tk's tree unchanged.
- integration: each operation writes exactly one activity entry, actor Smithers, requester Ben, rendered "Smithers, for Ben". The app agent's fork runs at once; its Add to stack runs only after Ben presses the Confirm card.
- integration: a scratch branch's commits never appear in a push to GitHub (the fake GitHub records zero ref updates for `scratch/*`).
- e2e, S1: C-J7-02.
- integration, S2 (reference host, real microVM): C-MCH-08.

## Acceptance



- [C-J1-04](../checks/C-J1-04.md): S1 part at its named layer.


- [C-J7-02](../checks/C-J7-02.md), S1: fork T2 to scratch, Add to stack as a new TODO after T2, drop T2.
- [C-MCH-08](../checks/C-MCH-08.md), S2: fork never stops the source machine and starts from the captured revision.
- [C-UI-13](../checks/C-UI-13.md): A Container's model from a real topic parses with its schema and its actions come from `cardActions`; at each stage exit every §14.3 row of the stage is wired and no View is orphaned

## Risks and notes

- In S1 a fork of an item doesn't include its uncommitted work, only the last verified head. That is spec behavior (§8.5.0); C-J7-02 forks a working T2 and must not expect its live edits.
- In S1 workspaces are still per member (T-MCH-04 is S2), so "keeps the people on it" means the requester's workspace becomes the item's. Falsified if Add to stack creates a second workspace for the new item.
- Hosted Cloud may still call `ForkWorkspace` (`workspace_provisioning.go:855`) and `POST …/workspaces/{id}/fork`. Escalate to the tech lead before deleting them. This ticket deletes only the runtime stop-snapshot path.
