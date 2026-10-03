# T-MCH-04 One machine per branch: drop `user_id` from the 0084 key; the agent attaches

Stage S2 · Size L · Depends on T-ACC-03, T-STK-01 · Unblocks T-COL-03, T-COL-05, T-MCH-06, T-MCH-07, T-MCH-08, T-REL-02, T-STK-08 · Issue: [#3565](https://github.com/smithersai/smithers/issues/3565)
Spec: spec.md §2 (Branch, Machine), §3 (`branches`, `machines`), §4.2, §7.6 (one machine per branch), §8.1, §17.2 · Delta: delta.md §3 (identity row), §6 (`branches` in S1) · Product: mvp.md J3, §6.7 One live branch, §11 item 9, M-17

## Goal

Every member and the coding agent who join a branch use the same single VM and working copy, whichever path provisioned it, and removing any one member never deletes it.

## Scope

In:
- The `machines` table (§3) as the product model: `branch_id` is its key, and `machines.workspace_id` points at the one `workspaces` row that stays the runtime record. T-STK-01 no longer creates `branches` in S1 (minimal-code synthesis v1 §1; S1 uses `mythical_lanes`), so this ticket creates it or keys machines on the existing lane record; smithers-3f picks one before restamp.
- Option (b), accepted by the tech lead: branch machines are owned by the install's system user, not by the member who first opened them, and no share rows are written (delta.md §3).
- The active-identity key `uq_workspaces_active (repository_id, user_id, kind, target_bookmark, name)`, last re-created in `0095_workspace_source_commit.sql:10-12` (first added in 0084), is re-created without `user_id`, keeping the 0095 predicate.
- Every provisioning path resolves a branch to its one machine. The 0095 predicate exempts agent sessions, forks, snapshot restores and pushed-ref (`source_commit`) rows, so the index alone can't enforce M-17. `machines.branch_id` (primary key) and `machines.workspace_id` (unique) do, and each path below goes through one `UpsertMachineForBranch`.
- `agent_session_id` uniqueness (`uq_workspaces_agent_session`, `0001_product_baseline.sql:11625`) moves to a join table, since one row now serves many sessions.
- `enforce_workspace_user_quota` (`0001_product_baseline.sql:264`) stops counting branch machines.
- The agent attaches its run's session to the branch's machine instead of inserting a `kind=agent` row.
- Branch access comes from `Authorize(credential, "branch.join", branch)` (§5.2, T-ACC-03), not from the owner-or-share check.
- Machine states of §4.2 are stored in `machines.state` and published on `branch:<id>` (§7.2). `releasing` lasts until the runtime confirms the VM stopped, because the VM holds its slot until then (§8.3.2, T-MCH-06).

Out:
- Admission, positions, release and sleep timers (T-MCH-06). Final capture and sleep reads (T-MCH-07). Keeping S1 TODO workspaces until settled (T-MCH-14).
- Branch locks (T-CUT-02). Presence (T-COL-06). Member unix users (T-MCH-11).
- [D] The Machine view (§0). `box.facet`, `box.services`, `box.egress` and `box.images` stay hidden.

## Changes

- `packages/backend/db/product/migrations/<next>_branch_machines.sql` (new): create `machines` (§3) with a foreign key to `branches` and `workspace_id UNIQUE`. Drop `uq_workspaces_active` and re-create it on `(repository_id, kind, target_bookmark, name)` with the 0095 predicate. Add `workspace_agent_sessions(workspace_id, agent_session_id UNIQUE)`, backfill it from `workspaces.agent_session_id`, and drop `uq_workspaces_agent_session`. The quota trigger skips rows owned by the system user. Add the `migrate.go` ledger row.
- `packages/backend/db/product/queries/workspace.sql`: `GetActiveWorkspaceForIdentity` (`:174`) without `user_id`; new `GetMachineForBranch`, `UpsertMachineForBranch` (`ON CONFLICT (branch_id)`, one row under concurrency) and `AttachAgentSession`. Run `scripts/check-sqlc-drift.sh` after `sqlc generate`.
- Provisioning paths in `packages/backend/internal/services/workspace_provisioning.go`, each keyed by branch with the system user as owner (the acting member is passed for audit only):
  - named: `findOrCreateWorkspaceByIdentity` (`:1130`) and its callers `findOrCreatePrimaryWorkspace` (`:1066`) and `findOrCreateDerivedWorkspaceForBookmark` (`:1119`);
  - explicit create: `CreateWorkspace` (`:631`) and `CreateWorkspaceAsync` (`:753`), including the pushed-ref `SourceRef` branch (`:658`, `:780`);
  - fork and restore: `ForkWorkspace` (`:855`), `tryForkDerivedFromPrimary` (`:1870`) and `provisionSnapshotWorkspaceAsync` (`:1839`) refuse to create a second runtime row for a branch that has a machine.
- `packages/backend/internal/services/workspace_agent.go:111` `CreateAgentWorkspace` becomes `AttachAgentToBranchMachine`. Delete the `kind=agent` insert, `agentWorkspaceName` (`:67`) and `agentForkSource` (`:223`) in the same change.
- Two workspace-creation services → one (minimal-code synthesis v2): the agent's own provisioning (`provisionAgentWorkspace`, `forkAgentWorkspace`, `provisionFreshAgentWorkspace`, `workspace_agent.go:183-302`) duplicates `CreateWorkspace` (`workspace_provisioning.go:631`, `:753`). Delete it; the attach path provisions through `CreateWorkspace` keyed by branch.
- Restore `a73a77de36` (Pair's revocation race tests, v1 §4): port `TestPairQueueRechecksAuthorityAfterQueueLock`, `TestPairSessionEndAndRevokeWaitForMutationLock` (`pair_queue_revocation_test.go`), `TestPairMutationsRecheckAuthorityAtWriteTime`, `TestPairHeartbeatAfterRemovalOrEndWritesNothing` (`pair_mutation_authority_test.go`) and the publish-after-commit cases of `pair_desktop_revocation_transaction_test.go` to branch access: a member removed mid-join writes nothing, and revocation publishes only after commit. Not Pair's sessions, invites, links, queue or draft.
- `packages/backend/internal/services/workspace_access.go:42` `requireWorkspaceAccess`: branch machines go through the authorizer. `workspace_shares` rows are never written for them.
- `packages/backend/internal/services/account_erasure.go`: erasing a member never deletes a machine owned by the system user.
- System user: one `users` row created by the migration, flagged as a service account so `TokenCredentialKind` treats it as non-person (`packages/backend/internal/middleware/run_credential.go`).
- `docs/api/openapi/branches.yaml` (new): `GET /api/branches` and `GET /api/branches/{b}`; run `node scripts/openapi-bundle.mjs` and `node scripts/openapi-clients.mjs`.

## Tests

C-MCH-01 (folded steps and assertions):
1. Ben, Alice and the TODO run each request the branch's machine at the same moment, 20 times in parallel (60 requests).
2. Count `workspaces` rows for the branch, active `workspaces` rows for it, and (reference host) `msb list` machines carrying its label.
3. Reference host: Ben's terminal runs `echo ben > /workspace/shared.txt`. Alice reads `shared.txt` through the file API. The agent's tool reads it through its own step.
4. A second agent session attaches to the same branch (a retry). Count `workspace_agent_sessions` rows.
5. Erase Ben's account (`account_erasure.go`), then read the branch's machine.
6. Read `workspaces.user_id` of the branch machine.
- Step 2: exactly 1 `workspaces` row, 1 active `workspaces` row and (reference host) 1 VM.

Pass when:
- Step 3: Alice and the agent both read `ben`.
- Step 4: 2 rows in `workspace_agent_sessions` and still 1 `workspaces` row, with no unique-violation error.
- Step 5: the machine row, its VM and its disk still exist.
- Step 6: the value is the install system user's id, not Ben's or Alice's.

Fail when:
- Any request creates a second `workspaces` row (a `kind=agent` row, or one per member).
- The agent forks a separate machine (`agentForkSource` path still live).
- Erasing the first joiner deletes the machine.
- The test passes only with requests serialized: the race in step 1 must run concurrently.


- integration (real PostgreSQL, `packages/backend/internal/services/branch_machine_integration_test.go`, new): 20 concurrent joins by 2 members and the agent produce one `machines` row and one active `workspaces` row. The agent's session appears in `workspace_agent_sessions`, and two agent sessions on one branch don't violate a unique index.
- integration: one table-driven case per provisioning path above (named, explicit create, pushed ref, fork, snapshot restore, agent attach) on a branch that already has a machine yields that machine, never a second runtime row.
- integration: erasing the member who first joined leaves the machine and its disk.
- integration: the quota trigger doesn't count 101 branch machines against any member.
- integration (reference host, real microVM): Ben's terminal write is readable by Alice's file read and by the agent's tool read on the same branch. This is C-MCH-01.
- unit: `workspace_named_test.go` and `workspace_named_integration_test.go` are rewritten for the branch key, not deleted.
- integration (restored from `a73a77de36`): removing a member while their join, heartbeat or write holds the branch lock leaves no write after removal; a rolled-back removal publishes no revocation; a canceled request still publishes after commit.

## Acceptance

- [C-MCH-01](../checks/C-MCH-01.md): two members and the agent on one branch share exactly one VM and one working copy, under concurrent joins and after a member's erasure.

## Risks and notes

Decided (tech lead, 2026-10-02): **option (b)** from research/workspaces-machines.md gap 1. The evidence that settled it:
1. `account_erasure.go` deletes every workspace whose `UserID` is the erased user. With the creating member as owner, removing that member deletes the branch machine for everyone.
2. 104 non-test reads of a workspace's `UserID` sit in 30 service files (`rg 'ws\.UserID|workspace\.UserID|w\.UserID|Workspace\.UserID|row\.UserID'`): quota, the usage meter, runtime context, refs. A constant system owner keeps them correct.
3. Option (a)'s per-member share rows duplicate the roster and need a second revocation event kind (`workspace_share_removed`, `packages/backend/internal/revocation/event.go:52`) for §5.6.

- Risk: a provisioning path missed by this ticket creates a second runtime row for a branch. Falsified by the table-driven test above, which enumerates `rg "func \(s \*WorkspaceService\) (Create|Fork|findOrCreate|provision)"` at landing.
- Open for smithers-3f before restamp (minimal-code synthesis): opus and fable propose restoring the `workspace_shares` producer from `a73a77de36` (`UpsertWorkspaceShare`/`DeleteWorkspaceShare` and `pairShareLevelForRole`, `pair_session.go:150-165`; the consumer `workspace_access.go:42-110` and `queries/workspace.sql:725-765` are still on main) in place of most of this ticket. That conflicts with option (b) above, which rejected share rows on the erasure and `UserID` evidence. Decide one; do not build both.
- Hosted Cloud (Plue) composes the same services. Whether hosted keeps per-user workspaces and `workspace_shares` is composition-specific and outside the MVP. Escalate if `rg` finds a Plue consumer; otherwise delete shares with this change.
