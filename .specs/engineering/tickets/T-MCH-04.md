# T-MCH-04 One machine per branch: drop `user_id` from the 0084 key; the agent attaches

Stage S2 · Size L · Depends on T-ACC-02, T-ACC-03, T-STK-01 · Unblocks T-COL-03, T-COL-05, T-FLW-09, T-MCH-06, T-MCH-07, T-MCH-08, T-MCH-09, T-REL-02, T-STK-08 · Issue: [#3565](https://github.com/smithersai/smithers/issues/3565)
Spec: spec.md §2 (Branch, Machine), §3 (`workspaces`, `workspace_shares`), §4.2, §7.6 (one machine per branch), §8.1, §17.2 · Delta: delta.md §3 (identity row), §3 (restore shared-access producer) · Product: mvp.md J3, §6.7 One live branch, §11 item 9, M-17
Ready: 2026-10-03 smithers-8a sha256:b49d19a9a2b8

## Goal

Every member and the coding agent who join a branch use the same single VM and working copy, whichever path provisioned it, and removing any one member never deletes it.

## Scope

In:
- Reuse `workspaces` as the branch machine record and the existing lane binding, per §3.0 and §8.1.2. Restore the shared-access producer from `a73a77de36`; do not create `branches` or `machines` tables.
- Keep the install system user as the database owner so erasing a joiner does not delete the shared machine. Restore write grants in `workspace_shares` for authorized members. Database ownership grants no person authority and does not select the guest session uid.
- The active-identity key `uq_workspaces_active (repository_id, user_id, kind, target_bookmark, name)`, last re-created in `0095_workspace_source_commit.sql:10-12` (first added in 0084), is re-created without `user_id`, keeping the 0095 predicate.
- Every provisioning path resolves `(repository_id, branch name)` to its canonical workspace under the same PostgreSQL transaction lock before inserting a row or reserving provisioning. Reuse the existing lane binding for item branches and workspace identity for scratch branches. Lookup includes fork, snapshot, agent-session and pushed-ref rows exempted by the 0095 predicate. `kind`, `name` and requester cannot select a second workspace for that branch. A failed row with retained disk or VM is reused or refused, never replaced while its runtime can still exist. A conflicting source request is refused without changing the existing working copy. Check: C-MCH-01, TestBranchMachineProvisioningPaths.
- Move the session association out of `workspaces.agent_session_id` and reuse the existing `agent_sessions.workspace_id` relation (`0001_product_baseline.sql:1643`, `queries/agent.sql:291`); each session stays unique and many sessions share a workspace. Drop `uq_workspaces_agent_session` (`0001_product_baseline.sql:11625`) after backfill.
- `enforce_workspace_user_quota` (`0001_product_baseline.sql:264`) stops counting branch machines.
- The agent attaches its run's session to the branch's machine instead of inserting a `kind=agent` row.
- Branch admission uses `Authorize(credential, "branch.join", branch)` (§5.2, T-ACC-03). Restore member write grants through `workspace_shares`; retain the existing mutation-time grant lock in `workspace_access.go`. Current collaborator membership and suspension from T-ACC-02 govern grants and revocation; a stale share never authorizes a removed member. Run authority stays branch-scoped and never inherits system-owner authority.
- Project §4.2 machine states from the workspace and runtime facts; add no `machines.state` store. The branch-topic publisher consumes these facts when available. Release and confirmed-stop slot accounting remain T-MCH-06.
- Lands dark until T-ACC-02 and T-ACC-03: refuse shared join, grant, mutation and agent attachment before any row or VM write when current membership or branch authority is unavailable; no owner/share fallback. Lands dark until T-STK-01: refuse item-branch provisioning when its lane binding is unavailable; never invent a branch record.
- Lands dark until T-INS-02 and T-SEC-01: refuse provisioning, wake and execution without the microVM-only launcher and passing privileged-input checks; no host/process fallback. Lands dark until T-MCH-11: refuse shared member terminals, SSH and executable tools until distinct non-root session identities and no-sudo isolation pass. These are activation preconditions, not code/schema dependencies. Check: C-MCH-01, TestBranchMachineUnavailableProviders.

Out:
- Admission, positions, release and sleep timers (T-MCH-06). Final capture and sleep reads (T-MCH-07). Keeping S1 TODO workspaces until settled (T-MCH-14).
- Product branch locks (T-CUT-02); the transaction lock for canonical workspace creation remains in scope. Presence and heartbeat leases (T-COL-06). Member unix users and no-sudo image construction (T-MCH-11).
- Pair sessions, invites, links, prompt queue and draft. New branch/machine/session-join tables. Hosted Cloud identity changes, billing changes, remote machines and UI Views. Repository code, flow loading, package scripts or dependency installation on the host or as root.
- [D] The Machine view (§0). `box.facet`, `box.services`, `box.egress` and `box.images` stay hidden.

## Changes

- Reshape `packages/backend/db/product/queries/workspace.sql:174` and `workspace_provisioning.go:1130` first: remove requester ownership from branch lookup and route all creation through the canonical branch transaction. Reuse `agent_sessions.workspace_id` and `SetAgentSessionWorkspace` (`queries/agent.sql:291`); reshape agent-session activity lookup (`queries/agent.sql:298`) to follow that relation. Run `scripts/check-sqlc-drift.sh` after `sqlc generate`.
- `packages/backend/db/product/migrations/<next>_branch_machines.sql` (new forward migration over existing tables): re-create `uq_workspaces_active` on `(repository_id, kind, target_bookmark, name)` with the 0095 predicate; backfill `agent_sessions.workspace_id` from `workspaces.agent_session_id`, then clear the old association and drop `uq_workspaces_agent_session`. Reuse a service user or create one if absent; transfer canonical branch workspace ownership and associated share owner references to it. The quota trigger skips branch machines. Refuse conflicting existing branch bindings without deleting disks or merging working copies. Add the `migrate.go` ledger row; assign the migration number at landing. A forward migration is required because existing deployed keys and ownership cannot be changed by service wiring. No new table needs an ownership reservation. Check: C-MCH-01, TestBranchMachineMigration.
- Provisioning paths in `packages/backend/internal/services/workspace_provisioning.go`, each keyed by branch with the system user as owner (the acting credential remains the authority and audit subject):
  - named: `findOrCreateWorkspaceByIdentity` (`:1130`) and its callers `findOrCreatePrimaryWorkspace` (`:1066`) and `findOrCreateDerivedWorkspaceForBookmark` (`:1119`);
  - explicit create: `CreateWorkspace` (`:631`) and `CreateWorkspaceAsync` (`:753`), including the pushed-ref `SourceRef` branch (`:658`, `:780`);
  - fork and restore: `ForkWorkspace` (`:855`), `tryForkDerivedFromPrimary` (`:1870`) and `provisionSnapshotWorkspaceAsync` (`:1839`) refuse to create a second runtime row for a branch that has a machine.
- `packages/backend/internal/services/workspace_agent.go:111` `CreateAgentWorkspace` becomes branch attachment through the canonical creation service. Update the production caller `agent_dispatch.go:786`. Delete the `kind=agent` insert, `agentWorkspaceName` (`:67`) and `agentForkSource` (`:223`) in the same change.
- Two workspace-creation services → one (minimal-code synthesis v2): the agent's own provisioning (`provisionAgentWorkspace`, `forkAgentWorkspace`, `provisionFreshAgentWorkspace`, `workspace_agent.go:183` onward) duplicates `CreateWorkspace` (`workspace_provisioning.go:631`, `:753`). Delete it; the attach path provisions through `CreateWorkspace` keyed by branch.
- Adapt T-ACC-02's restored `a73a77de36` revocation race assertions (restore sources absent on current main): port `TestPairQueueRechecksAuthorityAfterQueueLock`, `TestPairSessionEndAndRevokeWaitForMutationLock` (`pair_queue_revocation_test.go`), `TestPairMutationsRecheckAuthorityAtWriteTime`, `TestPairHeartbeatAfterRemovalOrEndWritesNothing` (`pair_mutation_authority_test.go`) and the publish-after-commit cases of `pair_desktop_revocation_transaction_test.go` to branch access: a member removed mid-join writes nothing, and revocation publishes only after commit. Not Pair's sessions, invites, links, queue or draft.
- Restore only `ensureWorkspaceShare`, `revokeWorkspaceShare`, `publishWorkspaceShareRevocation` and `pairShareLevelForRole` from `a73a77de36` (`pair_session.go:150-165`, `:1880-1966`, absent on main). Adapt them to the branch/member model; reuse `queries/workspace.sql:725-765`, `workspace_access.go:42` and `withWorkspaceMutationAuthority`. Recheck current authority at the write boundary and publish revocation only after commit. Delete the replaced admission checks in the same change; restore no other Pair behavior.
- `packages/backend/internal/services/account_erasure.go`: erasing a member never deletes a machine owned by the system user.
- System user: one `users` row created by the migration, flagged as a service account so `TokenCredentialKind` treats it as non-person (`packages/backend/internal/middleware/run_credential.go`).
- Reuse existing workspace list/detail handlers for branch reads. Expose `GET /api/branches` and `GET /api/branches/{b}` as thin authorized projections, not a second branch service. `docs/api/openapi/branches.yaml` (new API description, absent on main) records these public routes; smithers-b8 signs off their shape. Run `node scripts/openapi-bundle.mjs` and `node scripts/openapi-clients.mjs`.

## Tests

C-MCH-01 (folded steps and assertions):
- Extend the existing workspace route, named-workspace and agent-dispatch integration suites. `TestBranchMachineConcurrentJoin` and `TestBranchMachineProvisioningPaths` use the production router with real authentication/permission middleware and PostgreSQL: `WorkspaceHandler.CreateWorkspace` (POST `/api/repos/{owner}/{repo}/workspaces`), `ForkWorkspace` (POST `/api/repos/{owner}/{repo}/workspaces/{id}/fork`), and the registered branch GET routes. Agent requests enter through `AgentService.DispatchAgentRun` (`agent.go:1076`), reaching `agent_dispatch.go:786`; never call the attach helper as the acceptance boundary. Synchronous service cases supplement the route cases.
- `TestBranchMachineSharedWorkingCopy` runs on the reference host through production terminal/file/tool dispatch with real microVMs. `TestBranchMachineMemberErasure` uses `AdminUserHandler.EraseUser` (POST `/api/admin/users/{username}/erase`) with its production authorization. Keep fixture Ben a member who does not own the repository.
- Expected workspace/session counts, response classes and file bytes are checked-in literals. Tests read neither spec files nor implementation-derived expectations at runtime. Source-path enumeration is a review aid, not the test oracle.
1. Ben, Alice and the TODO run each request the branch's machine at the same moment, 20 times in parallel (60 requests).
2. Count `workspaces` rows for the branch, active `workspaces` rows for it, and (reference host) `msb list` machines carrying its label.
3. Reference host: Ben's terminal runs `echo ben > /workspace/shared.txt`. Alice reads `shared.txt` through the file API. The agent's tool reads it through its own step.
4. A second agent session attaches to the same branch (a retry). Count `agent_sessions` rows whose `workspace_id` is the canonical workspace.
5. Erase Ben's account through the production admin route, then read the branch's machine as Alice.
6. Read `workspaces.user_id` of the branch machine.
- Step 2: exactly 1 `workspaces` row, 1 active `workspaces` row and (reference host) 1 VM.

Pass when:
- Step 3: Alice and the agent both read `ben`.
- Step 4: 2 session rows point to the canonical workspace and still 1 `workspaces` row, with no unique-violation error.
- Step 5: the machine row, its VM and its disk still exist.
- Step 6: the value is the install system user's id, not Ben's or Alice's.

Fail when:
- Any request creates a second `workspaces` row (a `kind=agent` row, or one per member).
- The agent forks a separate machine (`agentForkSource` path still live).
- Erasing the first joiner deletes the machine.
- The test passes only with requests serialized: the race in step 1 must run concurrently.


- integration (real PostgreSQL, existing workspace route and agent-dispatch suites): concurrent member joins and agent dispatch produce one canonical active `workspaces` row. Two distinct agent sessions point to it without violating a unique index.
- integration, TestBranchMachineProvisioningPaths: literal cases cover named, explicit sync/async create, pushed ref, fork, snapshot restore and agent dispatch. An existing compatible branch returns its canonical workspace; conflicting source, failed-but-retained runtime and missing binding cases refuse without a second row or VM. A fork to a distinct scratch branch gets its own canonical workspace.
- integration, TestBranchMachineMigration: literal legacy named/fork/snapshot/pushed-ref/agent fixtures retain disks and valid session links; conflicting branch bindings fail migration without data loss. TestBranchMachineMemberErasure proves joiner erasure leaves the canonical row, VM and disk.
- integration: the quota trigger doesn't count 101 branch machines against any member.
- integration (reference host, real microVM): Ben's terminal write is readable by Alice's file read and by the agent's tool read on the same branch. This is C-MCH-01.
- unit: `workspace_named_test.go` and `workspace_named_integration_test.go` are rewritten for the branch key, not deleted.
- integration, TestBranchMachineRevocation (adapt T-ACC-02 restore assertions): race the production member-removal path with join and workspace mutation. Once removal commits, a stale grant permits no new write; authorized mutations holding the grant finish before removal commits. Rollback publishes no revocation; request cancellation after commit does not suppress publication. Heartbeat transport remains T-COL-06.
- integration, TestBranchMachineUnavailableProviders: remove each required membership, authorizer, lane binding, microVM or session-identity provider separately. Production join/dispatch refuses with zero row/grant/VM writes and no host command. Re-enable only with its named integration/security checks passing.

## Acceptance

- [C-MCH-01](../checks/C-MCH-01.md): two members and the agent on one branch share exactly one VM and one working copy, under concurrent joins and after a member's erasure.

## Risks and notes

Current §3.0, §8.1.2 and delta.md §3 settle the reuse decision: workspaces and restored write grants, with no parallel branch or machine tables. Keep the system database owner for erasure safety (`account_erasure.go:150-161`), while preserving acting-member authorization and per-session guest identity. `workspace_share_removed` already exists (`revocation/event.go:52`); reuse it.

smithers-3f accepts the canonical identity, migration/backfill, erasure, share-revocation and root-validation seams. smithers-b8 approves the public branch route shape; smithers-38 approves any generated TypeScript API change under §21.1. smithers-8a resolves composition conflicts with Plue; Will decides any product change. Owner review is post hoc under the 2026-10-03 directive; no pending choice authorizes a second identity implementation.

- Risk: a provisioning path missed by this ticket creates a second runtime row for a branch. Falsified by the table-driven test above, which enumerates `rg "func \(s \*WorkspaceService\) (Create|Fork|findOrCreate|provision)"` at landing.
- Hosted Cloud (Plue) identity and ownership changes are out of scope. Preserve its existing composition and share consumer. smithers-8a decides any cross-composition migration conflict with smithers-3f; do not delete `workspace_shares`.

## Security preconditions

Repository programs, hooks, flows, dependency scripts and tools execute only inside a microVM as the authorized non-root session uid (M-29, §17.3). System database ownership grants no guest root access, merge/approve authority or cross-branch credential. Host provider keys and App PEM never enter the machine (§17.2). smithers-3f reviews these preconditions and the root inventory below before activation. Reuse T-INS-02's R1–R5 inventory and T-SEC-01's validation; this ticket adds no root command.

Root inputs consumed by fresh create, fork/restore, retained wake and agent binding:
- R1 helper install/startup: main/bundle helper bytes, digest, bootstrap script, fixed destination and interpreter argv; install-controlled `msb` path, environment/PATH/HOME, VM id, deadlines, pinned OCI metadata/blobs, image/snapshot, guest OS/interpreter/loader/import paths and helper/temporary-file ancestors. Retained snapshot files, symlinks, modes and executable state can be branch/member-derived. `TestGuestHelperInstallPinsInterpreterAndEnv` must prove trust before the first privileged operation, including retained cleanup.
- R2 setup: main helper/constants, login/UID/GID and allowed directories; install DB identity allocations derived from GitHub/member identities; guest passwd/group, useradd/shell and filesystem responses; every env.json key/value, HOME_LINKS/GO_SETTINGS, tool-cache paths, home/cache/config entries and ancestor/leaf metadata. Toolchain-derived values and retained home/cache/symlinks are branch/member inputs. `TestRootSetupNeverFollowsMemberSymlinks` must validate bounded values and no-follow operations across replacement races.
- R3 bridge/exec/file/cleanup preflight: main fixed identity/envelope, host-generated request/exec IDs, ports and relay endpoint; request JSON fields id/argv/env/cwd/root/user/stdin, file operation/path/content/mode/limit, terminal size/signals/fds, request-file parents/bytes/modes, cgroup names/procs/kill/events, env.json and account state; filesystem/process/network responses and relay bytes. Payloads, paths, symlink graph and process population are branch/member-derived. `TestRootPreflightParsesOnlyEnvelope` validates fixed identity, bounded requests, cgroup/relay confinement and drops groups/GID/UID before payload use.
- R4 environment preparation, if provisioning reaches it: main-pinned target index and machine.json, bundled toolchain manifest, detector/scripts/tar construction and UID/destinations; install image/layer/snapshot, labels, resources/timeouts/budgets/net allowlist, marker schema/bytes/paths and existing cache/filesystem; repository manifests/version evidence, package/lock/workspace/source/config input names/bytes and tar entries are branch-derived. Downloads, archive entries, install/version output, apt indexes/packages/scripts/keys and GitHub release responses are upstream inputs; branch-selected URLs/pins are untrusted. Root env.json/subprocess environment is also input. `TestRootLayerInputsValidatedBeforeUse` validates the production preparation path, archive/destination confinement and trusted selection; repository tool/dependency installers run as agent. No branch target index or installer runs as root.
- R5 coding helper/binding: main/bundle artifact paths/bytes/mapping/digest and script/interpreter; host-authoritative workspace/actor/repository IDs, GitHub-derived slug, API/git URLs and fixed workspace/user/socket/version; guest destination/ancestor ownership/modes/symlinks and helper-check response. Retained destination state is branch/member-derived. `TestRootManagedArtifactInstallUsesApprovedBundleOnly` validates provenance and destination confinement; branch-built helper bytes are refused.

C-MCH-01 includes TestBranchMachineRootInputsValidated through the production join/agent-dispatch paths on fresh and retained real microVMs, reaching Runtime.CreateWorkspace, StartWorkspace and InstallWorkspaceCodingBinding. Run the named R1–R5 checks for every reached substep, with hostile branch/member input fixtures and independent root/outside-write sentinels. Any consumed branch-sourced root input lacking a passing named validation test blocks activation. Checks: C-SEC-02 and C-MCH-01. No new ownership.csv row is needed because this ticket creates no table.

## Ready checklist

1. Depends on T-ACC-02 (collaborator authority/revocation), T-ACC-03 (branch authorizer), T-STK-01 (item/lane binding); Scope names dark refusal for each unavailable contract and the launcher/security/session activation gates. Dependencies may be implemented against their specified contracts before landing.
2. Out names Pair behavior, parallel tables, product locks, admission/sleep/capture, presence, unix-user construction, Cloud/billing/remote machines, Views and host/root repository execution.
3. C-MCH-01 uses production workspace/branch/admin routes and AgentService.DispatchAgentRun with real PostgreSQL and reference-host microVMs; named race, migration, provider and root cases use literal expectations independent of spec or runtime code.
4. smithers-3f decides identity/migration/erasure/revocation/security seams; smithers-b8 signs off public routes; smithers-38 signs off generated TypeScript API changes; smithers-8a decides Plue composition conflicts; Will decides product changes.
5. Owner pre-review, post hoc per directive: smithers-3f: Does the canonical transaction cover all excluded-index paths and retained failures? Does system ownership preserve erasure safety without granting caller authority? Do R1–R5 validate every reached branch-derived root input? smithers-b8: Do branch routes reuse the workspace handlers with production authority? Does their public shape preserve CLI/app consumers? smithers-38: Do generated clients reuse existing workspace types and meet §21.1? No UI View change requires smithers-06. Preserve any recorded owner answers; these questions do not require a new approval before drafting.
6. Security preconditions enforce machine-only non-root repository execution, scoped credentials and no host fallback; R1–R5 list inputs and main/install versus branch/member sources, name validation tests, and block activation for unvalidated branch inputs. smithers-3f owns security review.
