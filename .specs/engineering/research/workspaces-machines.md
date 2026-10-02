# Workspaces and machines — current state (main, 2026-10-02)

Paths are under `packages/backend/` unless noted. "inferred" marks conclusions not confirmed by a test or run.

## Summary
- A workspace is a `workspaces` row keyed by user, not branch: unique active identity is `(repository_id, user_id, kind, target_bookmark, name)` (`db/product/migrations/0084_named_workspaces.sql:57-63`). Each member gets their own machine per branch; spec §6.7 row 1 is confirmed missing.
- Sharing exists as grants (`workspace_shares`, read/write) on one owner's workspace (`internal/services/workspace_access.go:12-60`). One shared machine per repo+branch can be built on it with a system owner, or by dropping `user_id` from the identity.
- Fork is built and API-reachable (`ForkWorkspace`, `workspace_provisioning.go:855`). It copies the source's current disk (stop, cold snapshot, resume, boot child), not a jj revision. The process runtime (single-owner default) reports `ColdSnapshots: false`, so fork is unavailable there. Only microVM isolation can fork.
- Sleep is built for idle (default 1800 s, 5-min sweep) with the disk kept. A reader without write access never wakes a machine (#3212, closed) and gets 409 "workspace is stopped". The owner and write-grantees do wake it on `files.read`/`box.file`. Nothing reads from retained snapshots.
- The "2 s / 30 s" numbers are one bash loop in the guest (`workspace_head.go:66-67`): poll jj op-heads every 2 s, run a jj snapshot every 30 s, push the head to `refs/smithers/workspaces/<id>/head`. There is no per-file watcher.
- Capacity: local microVM cap is `MaxRunningVMs`, default 3, 8192 MiB, 4 CPUs, 32 GiB disk, no host-memory detection. At the cap it returns a plain error that surfaces as a 500 (inferred). There is no queue or priority. Per-user cap is 100 rows (DB trigger).
- Cleanup: only agent workspaces suspended 24 h get their disk reclaimed, with no capture step; delete drops the head ref. Human workspaces keep disks until deleted or lease-abandoned.
- Layers need `.smithers/target-index.json` and refuse without it. No `.node-version`/`packageManager`/`go.mod` detection exists in the backend or microsandbox runtime.
- Branch locks are a self-contained service: 6 routes, 2 tables, one billing hook, one notification kind. The app has no consumer; removal (M-17) is a delete.

## Inventory
| Component | Path:line | What it does today | Spec row it serves |
|---|---|---|---|
| workspaces table | `db/product/migrations/0001_product_baseline.sql` (CREATE TABLE workspaces) | Columns: repository_id, user_id, name, is_fork, parent_workspace_id, target_bookmark, source_snapshot_id, kind (container/vm/desktop/agent), status (pending/starting/running/suspended/stopped/failed), vm_id, head_change_id/head_commit_id/ahead/behind, idle_timeout_secs=1800, last_activity_at, suspended_at | §3 Branch/Machine, §6.7 |
| Identity index | `migrations/0084_named_workspaces.sql:57-63` (replaces baseline `uq_workspaces_active` at :11618) | Unique on (repo, user, kind, bookmark, name) where not fork, no snapshot, no agent session, live, status pending/starting/running/suspended | §6.7 "One live branch" (gap) |
| Per-user quota | baseline `enforce_workspace_user_quota` (:264-278); `internal/services/workspace.go:162` `MaxActiveWorkspacesPerUser = 100`; `workspace_provisioning.go:1291` | Trigger and pre-check refuse the 101st active row with QuotaExceeded | §6.7 Capacity |
| Find-or-create | `internal/services/workspace_provisioning.go:1066-1150` | Reuses the caller's own row by identity; `createBookmarkWorkspace` inserts; primary vs derived differ only by `is_fork` | §6.7 |
| Agent path | `internal/services/workspace_agent.go:111-190`, `:223` | Always inserts a separate `kind=agent` row named `agent-<session>`, `is_fork=true`. Sandbox provider: tries `agentForkSource` (user's running non-agent workspace on same bookmark, else primary) and falls back to fresh. Runtime provider: `ensureWorkspaceRunning` on the new row, no fork | §6.7 "agent path can fork a separate one" confirmed |
| Sharing | `workspace_access.go:12-60`; table `workspace_shares` (baseline :6563) | Owner or grantee (read/write); write required for suspend/resume/fork/snapshot/sessions/SSH | §6.8 shared access |
| Branch locks | `internal/services/branch_lock.go` (503 lines); `db/product/queries/branch_locks.sql`; routes `internal/compose/router.go:1387-1399`; `internal/routes/branch_lock.go`; tables `branch_locks` (PK repository_id, branch), `branch_lock_join_requests` | Acquire/heartbeat/release/join-request/decide. Stale after 5 min (`BranchLockStaleAfter`, :17). Join approval is per lock generation (migration 0010) | M-17 removal |
| Lock dependents | `internal/services/billing.go:1110` `AuthorizeBranchLockJoin`; `billing_composition.go:145`; `admission/admission.go:29`; `notification_facts.go`; `compose/main.go:1092-1100`; error code in `internal/pkg/errors/errors.go`, `packages/rpc/src/PlueFailureCodes.ts`; client types `packages/smithers/src/internal/backend/ProductApi.ts:6024+`; OpenAPI `docs/api/openapi/repositories.yaml` | Nothing in `apps/app/src` references locks (rg, 0 hits) | M-17 |
| Fork (sandbox provider) | `workspace_provisioning.go:855-915` | Quota check on source owner; resume source if suspended; new row `is_fork=true`, `parent_workspace_id`=source, same bookmark/kind/env/size; `forkWorkspaceVM` | §6.7 Fork |
| Fork (runtime provider) | `internal/services/workspace_runtime.go:502-675` | Takes mutation authority, stops the source, `CreateColdSnapshot`, resumes source, boots child from snapshot, deletes temp snapshot. Source is down during the snapshot | §6.7 Fork |
| Cold snapshot | `microsandbox/snapshots.go:36-` ("clones the disk (APFS reflink)") ; process runtime `ColdSnapshots: false` at `process/runtime.go:166` | Disk clone of a stopped workspace | §6.7 Fork, Cleanup |
| Named snapshots | `workspace_provisioning.go:921-1000`; table `workspace_snapshots` | User-created snapshot restored as new fork row | none (not in spec) |
| Suspend / resume / stop / delete | `internal/services/workspace_lifecycle.go:22-140`, `:985-1120`, `:219-250` | Suspend revokes head token, stops VM, keeps row and disk. Delete soft-deletes row and deletes refs (`deleteWorkspaceRefs`) | §6.7 Sleep, Cleanup |
| Idle sweep | `internal/cleanup/workspace_cleaner.go:35-60` (5 min); `workspace_lifecycle.go:287` `CleanupIdleWorkspaces`; query `ListIdleWorkspaces` at `db/product/queries/workspace.sql:862-880` | Suspends `running` rows with `last_activity_at + idle_timeout_secs` past and no live session. Default 1800 s (`workspace.go:815`; per-repo `repositories.workspace_idle_timeout_secs`) | §6.7 Sleep |
| Abandon reaper | `workspace_abandon_reaper.go:20-30,105` | Client lease lapse suspends; deleted after 24 h (`defaultWorkspaceLeaseDeleteAfter`) | §6.7 Cleanup |
| Disk reclaim | `workspace_disk_reclaim.go:19`, `:45-95`; `db/workspace_disk_reclaim_ext.go:11-19`; `microsandbox/runtime.go:745-775` | Agent-kind, suspended >= 24 h: remove machine and disk, keep row; next start boots a fresh machine and re-checks out | §6.7 Cleanup (gap) |
| Head reporter | `workspace_head.go:55-190` (script), install at `:609` | Guest loop: 2 s poll of `.jj/repo/op_heads`, jj snapshot every 30 s, `git push --force` to `refs/smithers/workspaces/<id>/head`, `POST /api/repos/<slug>/workspaces/<id>/head` with change/commit/ahead/behind | §6.14 "head updates 2 s / snapshots 30 s" |
| File facets | `workspace_facets.go:90` ListWorkspaceFiles, `:187` ReadWorkspaceFile, `:244` Write, `:445-500` target resolution | Writer path calls `ensureRuntimeWorkspaceRunning` (wakes); reader path calls `runningRuntimeWorkspace` and returns `errWorkspaceStopped` (409) | §6.7 Sleep (gap) |
| Services / ports | `workspace_facets.go:309` ListWorkspaceServices, `:355` ManageWorkspaceService, `:691` `publishWorkspaceServicePreviews`; domain `preview.jjhub.tech` (:32); migration `0071_workspace_service_previews.sql` | Lists systemd units declared by init, start/stop/restart, publishes preview ingress per port | §6.14 Machine |
| Egress | `internal/services/sandbox_egress_audit.go:49`; `microsandbox/egress_secrets.go`; `egressrelay/` | Cursor-paginated audit; relay swaps bound secrets for placeholders toward bound hosts | §6.14 Machine |
| Environment images (hosted) | `internal/services/sandbox_environment_image.go:114-243`; `workspace_nix.go`; `workspace.go:165,167` | Register/List/Retire/Resolve/Pinned NixOS closure images; default container packages `ca-certificates git nodejs npm util-linux`; env source `.smithers/environment.nix` | §6.1 image |
| Environment layers (local microVM) | `microsandbox/layers.go:55-115` config, `:565-577` `readTargetIndex`, `:914` `dependencyRecipe`; README `microsandbox/README.md:60-95` | Toolchain layer keyed by pinned image + index toolchain row; dependency layer keyed by index install nodes + inputs. Refuses with "environment layers need a committed .smithers/target-index.json" | §6.1 row 3 |
| Local runtime composition | `apps/backend/isolation.go:100-180` | `SMITHERS_WORKSPACE_ISOLATION` = process (default) or microvm; env `SMITHERS_MICROVM_CPUS/MEMORY_MIB/DISK_MIB/MAX_RUNNING/LAYER_BUDGET_GIB/MIN_FREE_GIB` | M-06, M-10 |
| microVM admission | `microsandbox/runtime.go:215-245` (defaults), `:529-541` `admitRunningLocked`, called at `:485` (create) and `:679` (start) | Counts workspaces in running/starting; refuses at cap with `fmt.Errorf("microVM capacity reached: ...")` | §6.7 Capacity, M-06 |
| Hosted capacity | `internal/services/workspace_lifecycle.go:1216-1233`; `workspace_provisioning.go:1427-1443` | Maps controller `no_capacity` to `NoCapacity` ("The workspace pool is full right now...") and parks the row suspended with its disk | §6.7 Capacity (hosted only) |
| Agent concurrency cap | `compose/main.go:725-735`; `agent_dispatch.go:357-405` | Fleet-wide DB count of agent VMs vs `SMITHERS_SANDBOX_AGENT_MAX_CONCURRENT`; over cap returns QuotaExceeded; fails open on counter error | §6.7 Capacity |
| Child workspaces | `workspace_children.go:28-45` | Up to 128 children per user, profiles small (2 GiB, 1 vCPU) and build (8 GiB, 2 vCPU), idle after 10 min, TTL 4 h | #2802, not in mvp.md |
| SSH | `internal/ssh/`; `workspace_ssh.go` | Workspace sessions over SSH in hosted; self-host binary does not start it (mvp.md §6.14) | M-24 |
| App flows | `apps/app/src/mainview/flows/entries/box.ts:152-215` (`box.facet`, `box.files`, `box.file`, `box.services`, `box.egress`, `box.images`); `files.ts:38` (`files.read`, `runtimeAny: ["cloud"]`) | Facet tabs terminal/files/services/egress; all `runtime: ["cloud"]` | §6.14 |

## Gaps vs mvp.md
1. §6.7 "One live branch" (one workspace per repo+branch, shared) -> identity includes `user_id` and `name`; agent path inserts its own `kind=agent` row -> Two options, both in `workspace_provisioning.go` find-or-create (`findOrCreateWorkspaceByIdentity`, :1119): (a) install-owned system user is the single owner, members get write rows in `workspace_shares` at join, agent path attaches its `agent_session_id` to that row instead of a new row; (b) new migration drops `user_id` from the `0084` index and adds a `workspace_members`/presence table. Option (a) needs no migration but `uq_workspaces_agent_session` (baseline :11625) and `agent_session_id` per row must move to a join table because one row now serves many sessions; per-user quota (`enforce_workspace_user_quota`) must stop counting these rows. Terminals running as each person (per-person homes, `defaultWorkspaceUser="developer"`, `workspace.go:41`) are a separate change. -> L
2. §6.7 Branch card -> no single read model; the data is split across workspace row, sessions, head fields -> new projection over `workspaces` + `workspace_sessions` + stack item; app card in `apps/app` -> M
3. §6.7 Fork "no member-facing flow" -> API exists, no flow; `/branch.fork` is `new` in §14 -> add flow wrapping `ForkWorkspace`. Semantics gap: spec says fork "starts from #2's current revision" (J7), the code forks the source's disk and head, including uncommitted state, and stops the source during the snapshot. Requires `ColdSnapshots` on the process runtime or microVM isolation as a hard requirement. Fork of `main` (no machine) needs a create-from-ref path, which `createUserRefWorkspace` (`workspace_provisioning.go`, `SourceRef`) partly provides -> M
4. §6.7 Sleep "reading never wakes" -> readers get 409 `workspace is stopped` (`workspace_access.go:151`); writers (owner included) wake on read (`workspace_facets.go:459-466`) -> add a read path for suspended branches from `refs/smithers/workspaces/<id>/head` on repo-host (the head reporter already pushes it) or from the retained disk; make `ListWorkspaceFiles`/`ReadWorkspaceFile` choose it when status is suspended, regardless of write access. Wake only from terminal/TODO/steer/edit -> M
5. §6.7 Capacity and queue -> no queue, no reason/position, no people-first ordering; local cap error is untyped -> new admission queue service in front of `admitRunningLocked` (`microsandbox/runtime.go:529`) and `CreateAgentWorkspace`; typed `no_capacity` with queue position; release of idle/waiting/in-review machines is the existing suspend path called from the queue. Priority rule (M-13) needs a person-vs-agent flag on the request -> L
6. M-06 host-memory reserve (2 machines on 24 GB, 3 on 32 GB+) -> only static `MaxRunningVMs=3`, `MemoryMiB=8192`; no `hw.memsize` read (rg found none) -> compute default in `apps/backend/isolation.go:microVMConfig` -> S
7. §6.7 Cleanup "capture everything first" -> `reclaimAgentWorkspaceDisk` (`workspace_disk_reclaim.go:67`) and `destroyWorkspace` (`workspace_lifecycle.go:219`) do not check for uncommitted work, active terminals, or settled TODO; head push lags up to 30 s plus 2 s (inferred: no final snapshot on stop) -> add pre-delete step: run a jj snapshot in the guest, push head ref, verify ref equals guest head, refuse if sessions/services are active; scope reclaim to settled TODOs -> M
8. §6.1 row 3 toolchain detection -> not implemented anywhere in backend/microsandbox. `readTargetIndex` hard-fails without the index. Detection exists only in `packages/smithers/src/suggest/Checklist.ts:174-226` for the suggest feature (reads `go.mod`, `packageManager`) -> new detector emitting an index-equivalent toolchain/install recipe (read `.node-version`, `package.json packageManager`, `go.mod`, lockfiles), fed to `dependencyRecipe` (`layers.go:914`); the pinned tool set (`requiredTools`, `layers.go:590`) already has node, pnpm, bun, go -> M
9. M-17 delete branch locks -> remove 6 routes (`router.go:1387-1399`), `BranchLockService`, handler, 2 tables (new drop migration), sqlc queries, `AuthorizeBranchLockJoin` on billing/admission interfaces, notification kind, error code, ProductApi.ts types, OpenAPI paths, and tests (11 files). Per AGENTS.md "zero tech debt" all in one change -> M
10. §6.7 / M-18 / §6.14 terminals per person, watch/type control -> out of this area's code; sessions are per workspace (`workspace_sessions`) with `user_id` -> depends on gap 1 -> M
11. §6.14 "Partial (built as workspace facets)" -> all `box.*` flows are `runtime: ["cloud"]` (`box.ts:152-215`), so the self-host app does not show them; hosted-only vs local needs a decision per facet (`box.images` is NixOS/hosted; layers are the local equivalent) -> S to M
12. Self-host wakes on SSH (M-24) -> SSH server not started by the self-host binary -> compose `internal/ssh` in `apps/backend` -> M

## Existing tests
- `internal/services/workspace_fork_pair_test.go`, `workspace_fork_open_test.go`, `workspace_fork_kind_test.go`, `workspace_fork_quota_test.go`, `workspace_fork_size_test.go`: fork parentage, kinds that fork cleanly, quota on source owner, size inheritance.
- `workspace_named_test.go`, `workspace_named_integration_test.go`, `db/product/named_workspaces_migration_integration_test.go`: the (repo,user,kind,bookmark,name) identity and its migration.
- `workspace_lifecycle_test.go`, `_cover_test.go`, `_races_test.go`, `_z_test.go`, `workspace_lost_worker_test.go`, `workspace_dead_primary_test.go`: suspend/resume/stop/delete and races.
- `workspace_capacity_test.go`, `workspace_capacity_create_test.go`: hosted `no_capacity` mapping to the user-facing refusal and parked-row behavior. No test covers the local microVM cap error mapping.
- `microsandbox/parameters_unit_test.go:169-183`: defaults (3 VMs, 8192 MiB); `real_vm_test.go` (needs `SMITHERS_MICROSANDBOX_BIN`), `reclaim_test.go`, `layers_test.go`, `real_layers_test.go`, `layer_admission_unit_test.go`.
- `workspace_disk_reclaim_test.go`, `workspace_abandon_reaper_test.go`: reclaim and lease reaper.
- `workspace_head_test.go`, `workspace_runtime_head_test.go`, `workspace_runtime_head_publication_test.go`: head reporter script and publication.
- `workspace_facets_test.go`, `workspace_mutation_authority_test.go:242-452`: file facet and reader-vs-writer authority (#3212: reader does not start the VM).
- `branch_lock_test.go`, `branch_lock_repo_scope_test.go`, `branch_lock_product_integration_test.go`, `compose/branch_lock_repo_scope_integration_test.go`: all go with M-17.
- `workspaceconformance/`: contract conformance for runtimes (process and microsandbox).
- No test asserts "a read never wakes" for the owner, no test of two members sharing one workspace, none for queue ordering.

## Configured/measured numbers
| Number | Value | Where |
|---|---|---|
| microVM memory / CPU / disk default | 8192 MiB / 4 / 32768 MiB | `microsandbox/runtime.go:222-233` |
| Max running VMs default | 3 (env `SMITHERS_MICROVM_MAX_RUNNING`) | `runtime.go:235`, `apps/backend/isolation.go:173` |
| Max concurrent one-shot commands | 32 | `runtime.go:238` |
| Layer prepare VM | 6 CPU, 12288 MiB, 49152 MiB disk, 60 min | `layers.go:77-90` |
| Layer budget / free-disk floor / keep per family | 48 GiB / 40 GiB / 2 | `layers.go:92-100` |
| Hosted guest default | 4096 MiB, 2 vCPU | `workspace.go:36-37` |
| Idle timeout | 1800 s; sweep every 5 min | `workspace.go:815`; `workspace_cleaner.go:33` |
| Head poll / snapshot tick | 2 s / 30 s | `workspace_head.go:66-67` |
| Head token TTL | 7 days | `workspace_head.go:35` |
| Branch lock stale | 5 min | `branch_lock.go:17` |
| Agent disk reclaim | 24 h after suspend | `workspace_disk_reclaim.go:19` |
| Lease abandon delete | 24 h after lapse; lease 60 s to 24 h | `workspace_abandon_reaper.go:20-26` |
| Active workspaces per user | 100 | `workspace.go:162` |
| Children per user | 128; small 2 GiB/1 vCPU; build 8 GiB/2 vCPU | `workspace_children.go:30,41-44` |
| Fork timeout | 150 s; export about 140 MB snapshot (hosted figure from comment) | `workspace.go:60-80` |
| Provision timeout | 15 min; resume 30 s | `workspace.go:98,45` |
| mvp.md "warm wake under 5 s" | no measurement found in tests or docs | mvp.md:488 |
| M-06 "3 x 8 GiB fills 24 GB" | spec says 2 on 24 GB; code says 3 regardless of host | mvp.md:428 |

## Related GitHub issues
- #2802 open: main sandbox plus up to 128 child sandboxes (children code exists).
- #3382 open, do-not-implement: shared workspace bases (prepare once); relevant to layers, must not be started.
- #1667 open: one-machine distribution with backup and recovery; M-17 supersedes its single-owner model.
- #3354 open: overflow local VM capacity onto Smithers Cloud for issue sweep (capacity policy).
- #3365 open: configurable concurrent agents in one local microVM.
- #3356 open: measure Cloud workspace concurrency.
- #3425 open: preview a branch's running app as a card (ports/preview).
- #3243, #1801 open: fork a run with an edited step or input (run fork, not machine fork; do not confuse with branch fork).
- #3111 open: stale workspace helper loops on provision instead of refreshing.
- #3252 open: microsandbox runtime follows guest links in `/.msb` share.
- #3379 open: Cloud workspace create returns 500 after admission.
- #2784 open: S8 run factory work on the right machine.
- #2133 open: move CI sandbox plane onto WorkspaceRuntime.
- #2990 open: workspace artifact cleanup, digest reuse, bootstrap failure reporting.
- #3212 closed: reader no longer starts the VM or publishes a preview (basis of the read-never-wakes rule for non-writers).
- No open issue found for: shared one-workspace-per-branch, admission queue, branch-lock removal, toolchain auto-detection, member-facing fork. These need issues before work (AGENTS.md: reuse or create an issue per actionable item).

## Risks and unknowns
1. Claim: local microVM at capacity surfaces as HTTP 500, not a typed refusal (inferred from `runtimeOperationError` -> `pkgerrors.Internal` and the untyped `fmt.Errorf` at `runtime.go:539`). Confirm: start 4 workspaces with `SMITHERS_MICROVM_MAX_RUNNING=3` and read the response body.
2. Claim: the owner's file read wakes a suspended machine in the runtime provider. Evidence is code (`workspace_facets.go:459-466`), not a run. Confirm: suspend a workspace, call `box.file` as owner, observe status running.
3. Claim: stop/suspend loses up to about 32 s of unsnapshotted edits from the repo-host ref (inferred; the guest dies without a final snapshot and the head token is revoked first, `workspace_lifecycle.go:1000`). The disk still holds the files, so loss applies only if the disk is then reclaimed or deleted. Confirm: write a file, suspend within 2 s, reclaim the disk, restart, check the file.
4. Fork stops the source machine during the cold snapshot (`workspace_runtime.go:547-560`). With a shared branch machine, that interrupts everyone on the branch. Confirm: time the stop-snapshot-resume cycle on a real microVM with a populated repo; mvp.md J7 implies no interruption.
5. Process runtime reports `ColdSnapshots: false` (`process/runtime.go:166`). If the default self-host mode is `process`, member-facing fork cannot work there. Confirm: call `ForkWorkspace` against the process runtime (expect `runtimeSnapshots()` error).
6. Option (a) of gap 1 (system owner plus shares) assumes billing, quota and `user_id`-keyed refs (`refs/smithers/users/<id>/...`, #1968) tolerate a non-person owner. Confirm by grepping consumers of `workspaces.user_id` (billing metering `meterWorkspaceUsage`, `ListRunningWorkspacesForUserRepoBookmark`, SSH session user) before choosing.
7. The 24 h reclaim applies only to `kind='agent'` (`workspace_disk_reclaim_ext.go:15`). Spec says a machine is deleted after its TODO is settled; there is no code linking workspace deletion to TODO state. Confirm: rg for any `workspaces` join to factory issue/TODO state in cleanup (none found).
8. Layers have never been shown to build for a repository lacking a target index; the refusal is explicit. Whether auto-generating an index (reuse `smthrs init`/`Generate.ts`) or a separate detector is smaller is unmeasured. Confirm: time a spike that emits an index for a pnpm and a go.mod repo and runs `layers_test.go` flow.
9. Branch-lock removal blast radius is estimated from rg (about 30 files incl. generated); generated clients (`apiclient/client.gen.go`, `ProductApi.ts`, openapi) must be regenerated, and `db/ownership.csv` and `test_adopt.py` list the tables. Confirm: `rg -l branch_lock` after the change returns only the drop migration.
