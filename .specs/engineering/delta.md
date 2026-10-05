# From main to the MVP spec

Status: draft v0.5, 2026-10-03, against `main` at `383f82f40e`, for mvp.md v2.6. It applies minimal-code synthesis v1 and v2 (`~/Smithers-Ops/Areas/minimal-spec-20261003/SYNTHESIS-v1.md`, `SYNTHESIS-v2.md`) and starts from the Astra classification of the 51 old Add rows (4 exist, 29 small, 1 restore, 17 new). This is the build plan for [spec.md](spec.md); the spec states behavior. Rows tagged [S1]/[S2]/[S3]/[R] follow the stages in spec.md §0. Deferred behavior has no rows. Existing code is not release evidence: tickets still owe their named checks. Product decisions that wait for Will are listed in §12 and change no row here.

Paths: `B/` = `packages/backend/internal/`, `P/` = `packages/backend/microsandbox/`, `MV/` = `apps/app/src/mainview/`, `F/` = `flows/`, `UI/` = `packages/smithers/ui/src/`. Restore sources: `5b77095672` is the parent of `39e43c0fe` (MVP cut #3385); `a73a77de36` is the parent of `2753d2e3d` (second cut #3404); `06a13ab4ee` is the parent of `35ec608f6`.

## 0. Summary

Build rule (Will): use as is, then re-enable, then restore deleted code, then reshape existing code, then write new code. Restored code is not new code. One implementation per behavior. No abstraction with fewer than two real users.

| Class | Meaning |
| --- | --- |
| Reuse | Existing code serves as is. The ticket wires or qualifies it. |
| Enable | Existing code that is unwired, unused or off is turned on. |
| Restore | Code recovered from a named commit, then adapted. |
| Reshape | Existing code changes; the row names what the change deletes. |
| Net new | New code; the row names the existing or deleted code considered and why it cannot serve. |
| Delete | A revert or removal with no replacement behavior, citing the commit. |

Rows per class: Reuse 13, Enable 6, Restore 6, Reshape 66, Net new 3, Delete 8 (102 rows).

```
 Subsystem                     Today (383f82f40e)                         Distance  Tickets
 ───────────────────────────── ────────────────────────────────────────── ───────── ─────────
 Install / package / HTTPS     host profile, toolchains, App manifest      M         T-INS-*
                               landed; no bundle, no launchd, loopback
 Identity / roles / creds      single password owner, PAT = person         M         T-ACC-*
 Machines / admission          per-user workspaces, cap 3, untyped refusal M         T-MCH-*
 machined / live layer         bash head loop, LiveChannel.ts unwired      L (new)   T-COL-*
 Terminals / SSH               multi-viewer, one guest user, SSH unwired   M         T-TRM-*
 Stack / TODO                  mythical_items keyed by issue, PR to main   M         T-STK-*
 GitHub sync                   manifest + sealed App, 7 token minters      M         T-GH-*
 Flows / versions / learning   run pinning exists, no activation, no learn M         T-FLW-*
 App shell / cards / catalog   Views landed unmounted beside old cards     M         T-APP-*, T-CAT-*
 Cuts / docs / landed reworks  five-job UI cut; harnesses and twins landed S         T-CUT-*, T-DOC-*
```

Load-bearing code carried over unchanged: the durable flow engine (`@smthrs/flow`, journal, replay, fault suite); the Go and TS runtime bridge (`flowdispatch`, `smithers.flow-runtime/v1`); the Mythical stack worker and its git machinery (`B/services/mythical*.go`); microVMs via `msb` with layers, fork and cold snapshots; terminal multi-viewer with ring replay; the sealed secrets store; the D-23 revision-bound approval gate; webhook verification and the job queue; the wiki (pages, revisions, Yrs merge, folder sync); the app card registry, flow registry, toasts and Jev selection.

First merge: T-INS-01, T-INS-02, T-INS-08, T-INS-06, T-ACC-01, T-STK-01, T-STK-04, T-APP-02, T-APP-03. Dependencies are phased in tickets/README.md; C-J1-04 qualifies the path.

## 1. Install, runtime, HTTPS

| Class | Change | Tickets; spec |
| --- | --- | --- |
| Restore [S1] | Recover `apps/app/scripts/build-native.ts` and `build-native.test.ts` from `5b77095672`: Node, Git, jj, smithers-ffi, hosts and packaged smoke stages. Drop Electrobun, CEF, `NativeRendererServer.ts` and `DeepLink.ts` stages. PostgreSQL comes from `brew --prefix` (E-01), so the bundled-PostgreSQL stage stays out. Also recover the setup and build steps of the `native-mode-matrix` job in `.github/workflows/release.yml` from the same parent (about 35 lines). Emit the bottle layout plus `msb`/libkrun and the guest rootfs. Layout: bin/msb, lib/libkrunfw.5.dylib, share/microsandbox/{smithers-guest.py,base-image.oci.tar,base-image.json}, manifest.json; digest-matched and relocatable. Launcher readiness is T-INS-02. | T-INS-01; §16.1 |
| Restore [S1] | Recover the launchd service code `F/organization/setup/service.ts` (297 lines, plist writer and launchctl adapter) from `06a13ab4ee`, deleted in `35ec608f6`. Adapt it to `smthrs host start`, `stop` and `status` and the setup handoff. `apps/app/src/bun/NativeBackendProcess.ts` stays the backend and PostgreSQL supervisor; no second supervisor. T-INS-08 and T-INS-08 merge here. | T-INS-08; §16 |
| Reshape [S1] | `NativeBackendProcess.ts`: pass `SMITHERS_WORKSPACE_ISOLATION=microvm` and bind/public-origin settings from owner config (the backend runs only its own bundle's `bin/msb`). Delete the loopback-only rejection in `localOrigin()` (`:74`) once configured serving replaces it. GitHub App credentials stay sealed in PostgreSQL. Update the `backend-child-env` entry in `apps/app/PACKAGE.ts` and its tests in the same change. | T-INS-02, T-INS-04; §1.3, §16.3 |
| Reshape [S1] | Origin-agnostic serving: loopback by default; the owner sets bind address and public origins in Settings, feeding `SMITHERS_SERVER_ADDR`, `SMITHERS_PUBLIC_URL` and `SMITHERS_SERVER_ALLOWED_ORIGINS` (`B/config/config.go`). One effective origin per request sets cookies, Origin checks and the OAuth callback. No TLS or Tailscale code. A bind change restarts the service (E-13). | T-INS-04; §1.4, §16.3, M-28 |
| Reshape [S1] | Insecure-context support: one `getRandomValues` UUID helper replaces direct `crypto.randomUUID()` calls, with a lint ban; replace the one `crypto.subtle` use; one clipboard helper with an `execCommand` fallback. Delete the direct call sites. | T-INS-04; §16.3.2 |
| Reshape [S1] | `apps/backend/isolation.go`: microvm is the only mode on the Mac install; `process` stays for tests. Refuse to start without msb. | T-INS-02; §1.3 |
| Reuse [S1] | Host profile and sizing: `P/hostprofile.go:66` probes memory, performance cores and free disk; `:126` sizes; `apps/backend/isolation.go` applies it; `B/services/install_capacity.go:60` clamps owner overrides (landed `56c3fb2f4`). T-MCH-01 is qualification only. | T-MCH-01; §8.2 |
| Reshape [S1] | Host-profile readers 3 → 1: consumers read the Go profile through install health. Delete the hardware receipt probe in `apps/app/e2e/playwright/view-stories.spec.ts:623`; the duplicate runner’s ops-health-line parser is removed (§11). Keep `packages/testing/src/HostSuite.ts`, a runtime-capability contract, not a hardware reader. | T-MCH-01, T-INS-08; §8.2 |
| Reuse [S1] | Pinned toolchains: `P/toolchains.go` embeds and verifies the manifest (version, URL, SHA-256). No separate shipped `toolchains.json` loader. | T-MCH-10; §8.6.2a |
| Reshape [S1] | Reshape `B/services/repository_setup.go` into steps address, app_manifest, sign_in, repository, models, source and machine. External effects use one `product_job_requests` operation per step with `BeginExternal`, `Checkpoint` and `Park`; state keeps `setup.step.<id>` keys. Wire `install_machine_ready.go`. Delete only the old five-job interface. | T-INS-06; §16.2 |
| Reshape [S1] | Model keys 3 stores → 1: the API writes keys into sealed owner secrets (`packages/backend/modelhost/owner_secrets.go:26`). Delete the keys-file store (`SMITHERS_PLATFORM_MODEL_KEYS_FILE`, `packages/backend/modelproxy/keys.go`) and the keychain reader `apps/app/src/bun/ModelCredentials.ts`. | T-INS-06; §11.5a, §16.2 |
| Enable [S1] | The ChatGPT subscription pool on the Mac install, behind the owner setting (`SubscriptionConnections`, `B/config/config.go:172`). | T-INS-06; §11.5a |
| Reshape [R] | `smthrs host upgrade`, `backup`, `restore`: port the manifest, PG-major and schema guards, the incomplete-upgrade marker and `version.env` from `distribution/upgrade.sh:10`, `backup.sh`, `restore.sh` and `lib.sh:79` into the Mac lifecycle; add quiesce, capture, `pg_dump` plus `cp -c` clone, brew upgrade, migrate, health and restore hint. Then delete `distribution/Dockerfile`, `entrypoint.sh`, the Docker lifecycle scripts, `apps/app/scripts/mode-matrix/docker-web-selfhost.ts` and the CI image build (never published, #2481). One upgrade implementation. | T-INS-07, T-INS-05; §16.1, §16.4 |

## 2. Identity, roles, credentials

| Class | Change | Tickets; spec |
| --- | --- | --- |
| Reuse [S1] | `RejectTenantProvisioning` in `B/middleware/single_owner.go:20` keeps `/api/orgs*` and `/api/admin/orgs*` at 404 on self-host (`:23`). The install is not a tenant service. | T-ACC-01; §5.1 |
| Reshape [S1] | First GitHub sign-in creates the provisional owner; server-side repository permission verifies it. Reshape the bootstrap token to single-use and reuse install_setup_session plus the launcher handling. Keep self_host_owners; reshape SingleOwnerBoundary for members. Delete local-password routes and local_credentials only. | T-ACC-01; §5.1.0 |
| Reshape [S1] | Members are the existing `collaborators` table (`db/product/migrations/0001_product_baseline.sql:2605`) plus three columns: GitHub id, unix uid, `suspended_at`. Use the uncalled `AddCollaborator` query (`B/db/repos.sql.go:27`). Copy only the last-owner `FOR UPDATE` lock from `B/services/org.go`. Sign-in and hourly checks reuse the collaborator-permission call at `B/services/github_issue_text_writer.go:161`. No `members` table; no `org_members`. | T-ACC-02 (+ T-ACC-02, T-ACC-02); §5.1 |
| Reshape [S1] | `B/services/repo_permissions.go` becomes one `Authorize(credential, action, subject)` over the §5.2 matrix: Owner = installer, Maintainer = admin, Member = write. Delete parallel role checks. | T-ACC-03; §5.2 |
| Reshape [S1] | Delegated credentials (E-09): a non-system PAT in install mode plus `via`, on `access_tokens`; classify in `B/middleware/run_credential.go:66`; `RequirePerson` refuses it. `/api/auth/github/cli` mints `via=cli`. No `credentials` table. Delete person-PAT issuance for delegated callers. | T-ACC-04; §5.3 |
| Reshape [S1] | Actor and `via` on audit events (`B/services/audit.go:24`), activity and item events, derived from the credential. Actor, via and role enums 3 → 1 each in `packages/rpc/src/CardPrimitives.ts`; `MembersCard.ts` imports the role enum. | T-ACC-04; §2 |
| Reshape [S1] | Person confirmations use the existing `approvals` table with kinds `one_click` and `review_merge`, a private requester audience and a catalog action plus revision binding. Reuse the pending-row CAS (`db/product/queries/approvals.sql:42`). No `person_confirmations` table. The Confirm card reuses `ConfirmView`. T-APP-04 merges here. | T-APP-04; §5.4 |
| Reshape [S1] | Removal or suspension publishes on the revocation bus (`B/revocation/event.go`) and deletes sessions, PATs, SSH grants and branch access in one transaction. Delete partial removal paths. | T-ACC-02; §5.6 |
| Restore [S2] | Shared-access revocation race tests from `a73a77de36`: `pair_desktop_revocation_transaction_test.go:109`, `pair_mutation_authority_test.go`, `pair_queue_revocation_test.go`, plus `workspace_desktop_share_revocation_integration_test.go:19` from `5b77095672`. Keep only the race and authority assertions, adapted to branch access. The closed-alpha roster (`88d42515d`) is not restored. | T-ACC-02; §5.6 |

## 3. Machines, admission, images

| Class | Change | Tickets; spec |
| --- | --- | --- |
| Reshape [S2] | E-03: members join a lane's workspace through write grants in the existing `workspace_shares`, read by `requireWorkspaceAccess` (`B/services/workspace_access.go:42-110`). No `branches` or `machines` table in S1. In S2 the workspace row is the branch machine's runtime record: drop `user_id` from active identity (`uq_workspaces_active`), move agent-session uniqueness to a join relation, stop per-user quota counting. Workspace creation services 2 → 1: delete the agent-only `kind=agent` path in `B/services/workspace_agent.go:111-190`. | T-MCH-04; §8.1 |
| Restore [S2] | The workspace-share producer from `a73a77de36`: `ensureWorkspaceShare`, `revokeWorkspaceShare`, `publishWorkspaceShareRevocation` and `pairShareLevelForRole` (`B/services/pair_session.go:150-165`, `:1880-1966`, about 90 lines). Nothing else from Pair. | T-MCH-04; §8.1, M-17 |
| Reshape [S2] | Delete branch locks: `B/services/branch_lock.go`, its 6 routes, `branch_locks` and `branch_lock_join_requests`, sqlc queries, `AuthorizeBranchLockJoin`, the notification kind, error code, `ProductApi.ts` types, OpenAPI paths and tests. | T-CUT-02; M-17 |
| Reshape [S1] | Drop the 10 orphan tables in one forward migration: `pair_prompt_queue`, `pair_session_draft`, `pair_session_invites`, `pair_session_links`, `pair_session_members`, `pair_sessions`, `pair_share_links`, `pair_state`, `share_listing_event_cooldowns`, `share_listings`. | T-STK-01; §3 |
| Reshape [S1] | Admission (E-11): extend `admitRunningLocked` and `MaxRunningVMs` (`P/runtime.go:86-87`, `:533-541`) with the typed `CapacityError` (`P/hostprofile.go:158`) and a people-first FIFO. Delete the untyped `fmt.Errorf("microVM capacity reached")`. Sandbox-start guards 2 → 1: fold billing `AuthorizeSandboxStart` into capacity `ValidateStart`. Admission remains in memory. | T-MCH-06; §8.3 |
| Reshape [S1, S2] | Fork, Add to stack and Rebase now as system flows over existing workspace creation (`B/services/workspace_agent.go:122`). S1 forks `main` or an item's last verified head. S2 forks from a captured revision; delete stop-snapshot-resume in `B/services/workspace_runtime.go:547-560`. One fork-to-TODO insertion. | T-MCH-08, T-STK-02, T-STK-08; §8.5 |
| Reshape [S2] | Reads of sleeping branches serve from `refs/smithers/branches/<id>/head`; delete wake-on-read (`B/services/workspace_facets.go:459-466`). Stop only after final capture. Reclaim only settled, captured TODO machines quiet for 24 h; delete the unguarded `kind=agent` reclaim (`B/services/workspace_disk_reclaim.go:84`) and the proposed-lane release (`B/services/mythical_items.go:1124`). The 5-minute agent idle stop (`B/services/agent_dispatch.go:1125-1128`) never fires on a waiting TODO. Wake before delivering a signal. T-MCH-09 and T-MCH-14 are one policy. | T-MCH-07, T-MCH-09, T-MCH-14; §8.4, §8.12 |
| Reuse [S1] | Toolchain detection: `P/toolchain_detect.go:63` and the target-index fallback in `P/layers.go:285` (landed `7a5ab6140`). Share signatures with `packages/smithers/src/suggest/Checklist.ts:183` rather than add a third list. Delete the duplicate recipe builder in `P/layers.go` (§11). R4 reads the target index only from main; TestRootLayerInputsValidatedBeforeUse qualifies it. | T-MCH-10; §8.6 |
| Reshape [S2] | Per-member unix users: extend trusted provisioning (`P/runtime.go:585`, `P/guest/smithers-guest.py` `setup USER UID`, `EnsureUser`) for member uids, a `team` group and per-machine homes on the machine disk. No sudo, no virtiofs homes, no token copying. Delete member `developer`/`root` grant variants (`B/services/workspace_ssh.go:29`). | T-MCH-11; §5.5, §8.7 |
| Reshape [S2] | All-branches secrets reach machines through `/run/smithers/env`, rewritten on change (`B/services/workspace_provisioning.go:389-480`). Main-only secrets stay out. | T-MCH-12; §8.8 |

## 4. smithers-machined and the live layer

| Class | Change | Tickets; spec |
| --- | --- | --- |
| Reshape [S1] | Stage 1 co-editing contract is one rule: every write through Smithers carries `base_digest`, compared under the write lock in `B/services/workspace_facets.go:244`; a stale write is refused. Delete the unconditional write path. T-COL-10's `stale_read` is this compare and merges into T-COL-10. Reserved topics, document frames, golden frames and Go/Rust codecs move to the stage that first uses them. The wiki keeps its Yjs text. | T-COL-10; §7.6 |
| Reshape [S1] | `/api/live` (E-05, E-06) is a WebSocket adapter over the existing `sse.Broker` (`B/sse/broker.go:296`) and durable-stream cursors (`B/sse/durable.go`). The client is the landed `MV/runtime/LiveChannel.ts` minus its unread TanStack collection (`:28-30`, from `efde4289f`). Card state is one pure function of facts committed in one transaction; no projection event table. Terminals keep their WebSocket. Delete each per-resource SSE route (`/mythical/events`, `/workspaces/{id}/stream`, the wiki stream) when its last consumer moves. | T-COL-02, T-COL-02; §7 |
| Enable [S2] | Presence: connect `packages/smithers/flows/sync/src/BranchPresence.ts` (442 lines, 30 s lease, unused) through the runtime bridge; add a person-or-agent kind and a location. Resumable follow reuses `BranchProtocol.ts` and `SyncClient.ts`. No new presence frames; Pair presence does not return. | T-COL-06; §7.3 |
| Restore [S2] | Heartbeat and lease SQL shape from `a73a77de36` (`db/product/queries/pair_sessions.sql:152-176`, `UpdatePairSessionMemberPresence`, `TouchPairSessionMemberSeen`), adapted to surviving records, only where admission or presence needs it. Not sessions, invites, links, queue or draft. | T-COL-06, T-MCH-06; §7.3 |
| Enable [S2] | Host relay: one authenticated connection per machine over the existing guest byte stream (`P/transport.go:92`, `:102`). No socket tunnel or sidecar. | T-COL-03; §9.1 |
| Net new [S2] | `crates/smithers-machined`: boot lifecycle, inotify watcher with session attribution, bursts with per-file before/after versions and one versions commit each, mutation lock, durable outbox, capture and moved-off detection. Considered `B/services/workspace_head.go:52-171` (2 s/30 s bash head poll; no per-file versions or acknowledgment) and `P/guest/smithers-guest.py` (one-shot helper per `msb exec`; no long-lived process). Neither owns a durable watched-file outbox. Delete `workspace_head.go`'s loop and install path at cutover. | T-COL-03a, T-COL-03, T-COL-04; §9 |
| Reshape [S3] | Live documents: extract the Yrs core from `crates/smithers-ffi/src/wiki_document.rs:53` and use it for wiki and code documents; Yrs cores 2 → 1. The host-owned doc speaks the Yjs sync protocol over `/api/live`. Delete `POST .../updates`, the per-page SSE refetch and the client POST queue (`MV/wiki/CloudWiki.ts:288`). Restore the CodeMirror adapter from `4a36b0cfb` at this stage. | T-COL-08, T-COL-09; §7.4, §9.2 |

Each per-resource SSE route is deleted only when its last consumer moves, S2 at the earliest.

## 5. Terminals and SSH

| Class | Change | Tickets; spec |
| --- | --- | --- |
| Reuse [S2] | `B/routes/terminal_session_manager.go:93` keeps session startup, viewers and the 512 KiB ring. One host replay buffer. | T-TRM-01; §8.11 |
| Reshape [S2] | Owner-only input: drop binary frames from other sinks (`B/routes/workspace_terminal.go:659`); others read only. Mint `delegated(via=terminal)` at session start, write `/run/smithers/<uid>/token`, revoke at end. `packages/smithers/src/internal/backend/Session.ts:151` gains a `SMITHERS_TOKEN_FILE` reader beside `SMITHERS_TOKEN`. | T-TRM-01, T-TRM-02; §5.3.2, §8.11 |
| Enable [S2] | SSH: construct the existing server (`packages/backend/ssh/ssh.go:63`, `B/ssh/server.go:183`) in `apps/backend` on the install bind, port 2222. Supply branch-name usernames, member resolution and the `WorkspaceBridge` (`B/ssh/server.go:600`) for microVMs; add `direct-tcpip`. Keep its auth, revocation and session limits. | T-TRM-03; §8.10 |
| Net new [S2] | Guest session supervisor in the machined broker: PTY, exec, sftp and tcp sessions with exit status, signals, resize, half-close, flow control and cgroup kill, as each member's uid. Terminal brokers 3 → 1. Considered `P/exec.go:599` (host PTY around `msb exec -t`, single guest user) and `terminal_session_manager.go:39-49` (host viewer manager): neither owns guest process lifetime. Port `cgroup_kill` and `drop_to` from `P/guest/smithers-guest.py:56-124`. Delete msb-per-terminal process ownership at cutover. | T-TRM-06, T-TRM-07; §9.5, §9.6 |
| Reshape [S2] | GitHub key import at sign-in and hourly: reuse parsing, fingerprints and dedupe in `B/services/ssh_key.go:98`; add `source=github` and reconcile withdrawn keys. Runs inside the member revalidation job. | T-ACC-02 (in T-ACC-02); §8.10.2 |

## 6. Stack and TODOs

| Class | Change | Tickets; spec |
| --- | --- | --- |
| Reshape [S1] | The stack item is the TODO (E-07). Extend `mythical_items` in place: title, owner, public number, dense position, `paused_at`, `flow_digest`, needs-you, failure, merged/dropped, and revisions as jsonb. The issue link is optional (relax `mythical_items_issue_idx`). One Go function projects the nine product states, with a table test. No parallel TODO, revision, attempt, approval or projection tables; no backfill or sync. One TODO schema in `packages/rpc`; REST and card shapes project it. T-STK-01 and T-STK-01 merge here; T-STK-01 keeps only the composition-safety check. | T-STK-01; §3, §4.1 |
| Reuse [S1] | Item and branch facts use `product_job_events` on the item’s operation streams; append in the mutation transaction and read through `jobs.Replay`. The item and attempt in the request key identify the facts. No second event log. | T-STK-01; §3, §7.2 |
| Reshape [S1] | GitHub admission: `ObserveIssue` (`B/services/mythical_items.go:165`) freezes revision 1 at the first read after the label; the trust gate (`approvesIssueText`, `github_issue_trust.go:158`) stays. Chat TODOs have no issue. Placement: append, before, amend, move, drop over `position`, through existing lane admission (`:443`). Delete mandatory issue creation in `FileTodo` and the chat-first, then issue-number comparator (`:1107-1116`). | T-STK-02, T-STK-09, T-STK-06; §10.2 |
| Reshape [S1] | Merge only the first unmerged item, `POST /api/todos/{n}/merge`, sha-bound squash (`mythical_github.go:324`). Approvals reuse `checks.Land`; pre-approval reuses `checks.Automerge` (`mythical_items.go:215`) with no `checks.Automerge`. Setup refuses repositories without squash merge. Delete `change.land` and Plue landing requests as product merge doors. The D-23 gate stays. | T-STK-04, T-STK-04; §10.6 |
| Reuse [S1] | Candidate equality: today's separate verify lane gives equal trees on the current prefix (`mythical_items.go:1895-1905`, `:1954`, `:2029`), and `version` plus `generation` order captures. Spec §10.4.4 to §10.4.5a (generation receipts) is deleted. | T-STK-12; §10.4 |
| Reshape [S1] | One pinned flow digest per attempt across its launches (E-19). Extend `F/coding/todo.ts` into the overridable composition covering route to deliver; verify and review stay engine launches (M-30). Delete the registered `coding/Request` and `coding/Vibe` entry points once the composition runs them. | T-FLW-11; §10.4.1 |
| Reshape [S1] | PRs stay based on `main` as verified candidates. Head `smithers/<slug>` replaces `smithers/issue-N` (`mythicalBranch`, `:2115`); the body carries prompt, evidence, included items and "Requested by" (`proposal()`, `:2126`). Later items open as drafts and become ready when first; out-of-order merges mark earlier items merged. One PR lifecycle owner (T-GH-03, T-GH-03). | T-GH-03, T-GH-03; §12.5 |
| Reshape [S1] | Control: extend the CAS retry (`mythical_items.go:2708-2765`) to Stop/Resume (`paused_at`), Retry with a new attempt on the current flow, and Drop with PR close. Delete the issue-only retry gate (`:2750`) and the planner `declined` settlement (`:1382`). | T-STK-05; §10.7 |
| Reshape [S1] | Steers: generalize `F/coding/steering.ts:156` from `coding/request` roots to the pinned TODO run and call it at implement, vibe and verify boundaries. Amend appends a revision and delivers through it. Delete request-root-only steering. T-STK-06 merges here. | T-STK-06; §10.7.3 |
| Reshape [S1] | Needs you: the item's needs-you column plus a CAS on `mythical_items.version`; first answer wins, a late answer gets 409 with `answered_by`. Delivery reuses deferred completion in `packages/smithers/flows/flow/src/HumanTask.ts:929`. Machine release requeues a capacity wait. No `todo_waits`. | T-STK-01; §10.8 |
| Reshape [S1, S2] | Rebase now, then presence-aware scheduling: conflicts get one agent attempt, then Needs you with Resolve. Delete the three-attempt `retrying` to `blocked` loop (`mythical_items.go:1840-1847`). The presence gate extends the existing rebase path. | T-STK-08; §10.5 |
| Reshape [S1] | Catalog visibility: hide `history.bootstrap` and `history.backfill`; `history.parallel` becomes the owner setting. | T-CAT-01; mvp.md §8 |

| Reuse [S1] | Existing launch/outage/replan bounds and checks counters in `mythical_items.go`; only the daily allowance adds an install setting. | T-STK-05; §10.4.1b |

## 7. GitHub sync

| Class | Change | Tickets; spec |
| --- | --- | --- |
| Reuse [S1] | App manifest and sealed credentials: `B/services/github_app_manifest.go:142`, `:259`; `B/services/github_app_credentials.go:76`, `:165`; dynamic slug in `repo_connection_github_app.go:178` and `github_access_diagnosis.go:171`. T-GH-01 keeps only its remaining phase; T-GH-01 to T-GH-01 merge into it. | T-GH-01; §12.1 |
| Reshape [S1] | Installation-token minters 7 → 1: keep `CreateGitHubInstallationToken` in `B/services/repo_connection_github_app.go`; delete minting in `github_app_manifest.go`, `github_proxy.go`, `github_check_runs.go`, `mythical_github.go`, `stack.go` and `scripts/github-app-auth.mjs`. | T-GH-01, T-GH-02; §12.1 |
| Reshape [S1] | Pollers (E-08): existing loops at M-03 cadences with ETags, cached scoped tokens and one charged budget (`github_budget.go`) for every call. Label events from the repository issue-events list, not per-issue `labelHistory` (`mythical_github.go:398`). No GraphQL `pr-state` query, no `github_sync` table, no request-per-hour arithmetic. | T-GH-02; §12.2 |
| Reshape [S1] | Extend the proposal `PendingOp` and recovery for push, open PR, body, merge and close PR, one in flight per item. Labels, unlabels, comments and issue-close keep best-effort retries and the existing marker. No per-target queue or supersession. | T-GH-09; §12.4 |
| Reshape [S1] | Inbound reviews and comments: `ObserveGitHubEvent` (`mythical_items.go:2827`) stops ignoring review events (`:2831`); one normalizer shared with the poll fallback feeds steers and item events. | T-GH-04; §12.3 |
| Reshape [S1] | Foreign push to `smithers/<slug>`: the freeze (`mythical_items.go:2197-2206`) becomes Needs you with Bring in and Discard bound to the shown sha; Discard leases the next push against it. PR closed becomes `dropped`, reopen restores (`mythicalSettledStates`, `:85`). Failing checks name the required check (`HeadChecks`, `mythical_github.go:611`). Keep GitHub's refusal text: `landingGitHubStatusError` (`landing_github_pull.go:446-465`) drops it today. | T-GH-03, T-GH-06; §12.3, §12.5.2 |
| Reshape [S1] | Main sync: force-push to `main` becomes owner Needs you, confirm, mirror reset and rebase (detection at `github_main_pull.go:585-590`). Health and retry aggregate on `:193-261` behind `GET/POST /api/github/sync`; delete per-route statuses when Home reads it. `mirror: pull` is the install default (`:578-581`). T-GH-07 and T-GH-07 are one state machine. | T-GH-07, T-GH-07; §12.3, §12.6 |
| Reshape [S1] | "Is commit A an ancestor of B" 3 → 1: delete the copies in `B/services/mythical_git.go`, `github_main_pull.go` and `git_mirror_sync.go` once callers share one. | T-GH-07; §12.3 |

## 8. Flows, versions, learning

| Class | Change | Tickets; spec |
| --- | --- | --- |
| Enable [S1] | Repository flows run only in machines; the host never loads them (E-02, implemented by `c4e325b2d`). Each machine's coding host loads the pinned closure by digest, never the branch's `flows/`. #3377 is not needed. | T-FLW-01, T-FLW-04; §1.3, §11.1 |
| Reuse [S1] | Run pinning: `packages/smithers/agent/registry/src/ExecutionSnapshot.ts:61` stores modules and lock digests; restore validates them (`:143`). No closure archive. | T-FLW-04; §11.4 |
| Reshape [S1] | Add source_commit, digest, status and load_error to `workflow_definitions`, retaining versions per name; `is_active` selects the newest loaded row. `workflow_sync.PersistDefinitions` writes activation; `SetMainMoved` triggers a coalesced load in an ephemeral machine. Failed loads retain Active. No closure archives. | T-FLW-03; §11.3, §11.4 |
| Reuse [S1] | `/flow.edit <name> <request>` is `/todo.new` with prompt “Change flows/<name>/flow.ts: <request>; start from the built-in composition when no override exists” and the proposed diff quoted in revision-1 context. No seed_patch column, blob or validator. | T-FLW-05; §11.5 |
| Reshape [S1] | Config: `F/coding/project-config.ts:55` takes install defaults from `install_settings` with field-wise repository precedence. No `install_settings` table. Delete the mandatory private-config default. | T-FLW-02; §11.2 |
| Restore [S1] | Owner model assignment: the assignment slice of `MV/cards/ModelCards.tsx` and `MV/flows/entries/model.ts` from `5b77095672` (`39e43c0fe^`), mapped to `fast`, `coding` and `jev`. Not the laboratory (`ModelCallCard.tsx`, `controller/modelCall.ts`). Delete `MV/cards/views/SettingsModels.tsx` (`786f9ac54`) as its duplicate. Instructions load as repository Markdown through `MV/state/controller/turns.ts:389`. | T-FLW-08; §11.5a, mvp.md §11 item 3 |
| Net new [S3] | Compose the learning flow body from `F/coding/learnings.ts` and memory mining. Proposals reuse memory notes’ pending/accepted/rejected lifecycle; the note key is the signature. Make TODO accepts and files the note; Dismiss rejects it for 90 days. No proposal table. | T-FLW-06; §11.8 |
| Reshape [S1] | Monitor: `/monitor` door over the RunTrace fold (`packages/smithers/gateway/src/RunTrace.ts:1352`, waits at `:1450`) and `packages/backend/modelprice/prices.go:271`; emit only the missing cost and wait-since fields. Delete the `forks` trace filter (`MV/flows/entries/runs.ts:167`). T-FLW-07 merges here. | T-FLW-07; §11.6 |
| Reshape [S1] | Hide deferred triggers (`triggers.*`) from the MVP catalog; registrar and engine untouched. Two `Flow.make` shapes → `@smthrs/flow` only: delete the second construction shape, with a CHANGELOG “Removed” entry and migration to `@smthrs/flow`, in `packages/smithers/flows/core/src/Flow.ts`. | T-FLW-01, T-CAT-01; §11.7 |

## 9. App shell, cards, catalog

| Class | Change | Tickets; spec |
| --- | --- | --- |
| Reshape [S1] | One catalog (E-14): the descriptor is the `Operation` in `UI/app-operations/index.ts`; `catalog.mvp.json`, the CLI mount (`packages/smithers/src/internal/backend/Commands.ts`) and skills are generated from it. Delete the temporary rpc catalog (`packages/rpc/src/catalog/index.ts`) and hand-kept copies beside `Definitions.ts` and `MV/flows/registry.ts` as each command moves. Hide or delete every command not in Appendix A. The allowlist test extends `F/test/system-flow-catalog.test.ts` and `MV/flows/parity.test.ts`. T-CAT-01, -02, -03 are one migration. | T-CAT-01; §6.1 |
| Reshape [S1] | T-APP-15 app15: `MV/cards/FileCards.tsx` maps journal fields to a props-only `CodeSurface` over existing `CodeFileView`, deleting the Markdown-editor body, language/server prose and direct command gestures. `CodeSurface.test.tsx` replaces tests of those removed renderings with literal size/link, keyboard dispatch and stable-view checks. `CodeIntelSeam.ts` adds a host-owned validation prerequisite because `cloud.terminal` proves transport availability, not T-INS-02 isolation or T-SEC-01 validation; production supplies no receipt and refuses before reads or LSP effects. The registry unmounts the retained `entries/code.ts` until those receipts land; tests assert no slash or agent exposure even with a tunnel. Existing recovery tests explicitly model validated execution. Shared adapter deletion and branch HTTP/client wiring remain owner work. | T-APP-15; §7.6, §14.3 |
| Reshape [S1] | The card file is the container (E-21): it maps data to its View's props and mounts only in `MV/cards/CardRenderers.tsx`. A View lands in the commit that mounts it and deletes the card it replaces: Home replaces `StackCard.tsx` and `RepositoryHomeCard.tsx`; Confirm replaces `ApprovalCard.tsx` and `ApprovalAnswer.tsx`; Flow replaces `WorkflowCards.tsx`; File and Diff replace the duplicate rendering in `FileCards.tsx`/`CodeSurface.tsx` and `ChangeCards.tsx`/`DiffSurface.tsx`; Run replaces `RunTraceCard.tsx` and `RunsCards.tsx`. Fold `HomeContainer`, `FlowContainer`, `CommandsContainer`, `SettingsContainer`, `SetupContainer`, `TodoContainer` and `DraftContainer` into their card files at cutover. View props are TS types; zod only where data crosses HTTP or storage. | T-APP-01..07, T-APP-11, T-APP-15; §14.2 |
| Reshape [S1] | T-APP-05 dark landing: `MV/cards/FlowCard.tsx` replaces `WorkflowCards.tsx` and folds in `FlowContainer.tsx`; run body/failure tests move to `RunTraceCard`. Retain list/chooser/plan/form until the legacy decoder lands. Unregistered `flowVersionFlows` reuses `entries/flow.ts` declarations for `/flow`, Edit and Source: existing create/run doors cannot serve version reads or TODO edits, and missing production providers refuse before effects. | T-APP-05; §11.5, §14.2 |
| Reshape [S1] | Card actions 3 → 1: `MV/flows/cardActions.ts`; delete `MV/cards/CardActions.ts` and `InstallCardActions.ts`. Delete duplicated live kinds in `packages/rpc/src/Cards.ts`; keep a read-only decoder for old conversations. | card tickets; §14.2 |
| Reshape [S1] | Design layers: fold `HomeRowView`, `HomeActionView`, `TodoActionView`, `CommandActionView`, `MembersActionView`, `EdgeGroupView` and `ToastNoticeView` into their parents; merge `MV/styles/views/*.css` into `MV/styles/cards.css`. T-UI-04 merges into T-UI-04. | T-UI-04; §14.2 |
| Reuse [S1] | Actor labels: `MV/cards/views/actorName.ts:4`, re-exported by `MV/state/ProductActor.ts:18` and ActorChip. Delete any second label module (`TodoActors.ts`) that remains. | T-APP-09 (in T-APP-02); §2 |
| Reshape [S1] | `StackCard.tsx` data moves to `HomeView` on the `home` topic: `main` row with sync health, state counts as filters, machines and capacity, background runs. | T-APP-01; §14.3 |
| Reshape [S1] | Dark client foundation reuses `MV/state/useTopic.ts` and the sole `MV/runtime/LiveChannel.ts` collection; no existing binding pairs shared conversation and member view topics or suppresses disabled subscriptions. Replace cached data on subscription refusal with an empty error snapshot. Added tests cover dark IO, branch changes, separate member views and revocation recovery; existing tests do not cover those boundaries. No second conversation store. Shell cutover and backend/host work remain pending. | T-APP-16; §7.2, §14.1 |
| Reshape [S1] | Promote request_payload.conversationId to indexed `chat_turns.conversation_id`; history filters by conversation and membership. Existing conversation/replay routes serve turns, batches, cards and events. Confirm cards stay in `approvals` on member topics; uncommitted Drafts stay in the browser. Delete `app_timelines*`; preserve private history as archives. | T-APP-16; §14.1, §14.5 |
| Reshape [S1] | Context preflight: move the selector step in `MV/state/controller/turns.ts:408` into the host turn as its first recorded step, add context selection, and store `context[]` on the answer; `MV/ContextLine.tsx` renders it. Delete the browser preflight at cutover. | T-APP-17; §15.1.2 |
| Reshape [S1] | App-agent tool calls run in the host turn runner through the CLI command-to-API mapping with a host-minted delegated credential. Delete browser-side execution of non-UI commands. | T-APP-16; §15.1.4 |
| Reshape [S1] | Toasts and timeline: feed `ToastStackView`, `EdgeMap` and `Timeline` (`406436c02`) from conversation entries with per-member hiding. Delete `MV/ToastStack.tsx`'s renderer and `MV/ChatRunTimeline.tsx` in the same change, or revert the new Views. | T-APP-07; §14.4, §14.5 |
| Reshape [S1] | `TodoSeam` (`MV/state/seams/TodoSeam.ts:127`) calls `/api/todos`, which no route serves; point it at the T-STK-01 routes and delete StackSeam's TODO paths in the same change. | T-APP-02; §10.2 |
| Enable [S2] | Browser notifications: existing notices (`MV/state/RepositoryNotifications.ts`) reach the Notification API on secure origins behind `notifications.allow`. | T-APP-18; §14.6 |
| Reshape [S2] | Obsidian sync: `B/services/wiki_sync_obsidian.go:27` reads its folder from `install_settings`; delete the config-file-only source (`B/config/wiki_sync.go:10`). | T-FLW-12; §13.3 |
| Reshape [S1] | Actor rendering with `via` badges ("Ben via Smithers"). | T-APP-09; §2 |

## 10. Cuts and docs

| Class | Change | Tickets; spec |
| --- | --- | --- |
| Reshape [S1, S2] | Finish the composition cut: delete remaining SetupChecklist, RepositorySetupCard, setup/chores/ci/feature flows, SignupCards, onboarding, Registration*, AdminCards and admin flows, BurndownCard and issue-sweep entry, SubagentGrid, agent sessions, CommitCards and `change.split`; backend `/api/repository-setup/*`, `/api/admin/*` except owner health, `changes/{id}/split` and registration review, each with its OpenAPI row (`openapi_conformance_test.go:220`). Keep event admission, dispatch and history decoders. | T-CUT-01, T-CUT-02; §6.2.4, mvp.md §8 |
| Reshape [S1] | Billing, Cloud, balance, plans, checkout and multi-repository `repo.*` stay as code behind the T-CUT-03 composition gate; delete their MVP catalog and renderer exposure. Hide `box.facet`, `box.services`, `box.egress` and `box.images`; the backend facets stay for Plue. TUI keeps building and leaves launch docs and the release gate. | T-CUT-03; mvp.md §8 |
| Reuse [S1] | `AGENTS.md` already states MVP scope and points background work at `MV/state/controller/backgroundWork.ts` (`AGENTS.md:190`); `docs/architecture/0002-mac-install.md` exists. `apps/review` and `packages/smithers/create-app` are already gone. | T-DOC-02; §1 |
| Reshape [R] | Re-point the remaining `repositorySetup.ts` references (`docs/mvp/implementation/recovery-contract.md`, `.specs/engineering/card-kinds.md`). Replace `docs/mvp/ENGINEERING.md` and `DESIGN.md` with links to `.specs/*`; `PRODUCT.md` keeps only its decision index (M-12). Supersede ADR 0001's single-owner and `trusted_process` statements. | T-DOC-02; M-12 |
| Reshape [R] | Public docs: replace onboarding in `packages/smithers/docs/quickstart.md` with install, setup, first TODO, teammates; keep flow reference. Reuse `pnpm docs:sync`, `pnpm docs:check` and `smthrs docs //<pkg>:docs`. Delete duplicate quickstarts. | T-DOC-01; mvp.md §12.4 |

## 11. Landed code to revert or rework

Each row is a step in its owning ticket. Line counts are from the reviews in `~/Smithers-Ops/Areas/minimal-spec-20261003/`.

| Class | Change | Tickets; source |
| --- | --- | --- |
| Delete | Journey harness `d7134d536` + `bd2862abd` (−4,508): delete `scripts/journeys/`. J1 becomes one Playwright spec in `apps/app/e2e/real` when J1 exists. | T-REL-02; opus §4, fable §4 |
| Delete | C-UI-13 inventory `8903feed4` + `94adaa285`: delete `apps/app/checks/Inventory.test.ts`, `MV/inventory/inventory.json` and the spec-digest gate it reads (`scripts/repo-contract/spec-transcriptions.mjs`). Replace C-UI-13 part B with one test: every `*View.tsx` is reachable from `CardRenderers` and no replaced legacy card remains. | T-UI-04; SYNTHESIS-v2 ruling 4 |
| Delete | Check runners 2 → 1: `scripts/check-run.mjs` survives; the duplicate executor, qualifier, obligation manifest, binding module and their tests are removed. Proposed bindings remain unapproved in `scripts/check-commands.json`. A receipt may cite CI's check run at the landed SHA or a `smthrs test` run on the reference host. #3663 is re-scoped to this. | T-PRC-03, #3663; SYNTHESIS-v2 ruling 3 |
| Delete | Card contracts `a292b7328` / `e3a521ad6`: delete `packages/rpc/test/cards/RetainedCards.test.ts` and its 5,046-line snapshot; delete the S2/S3 schemas and fixtures (Proposal, Terminal, Secrets, Branch, Docs, DebugApi) until their stage. Keep Todo, Draft, Setup, Settings, Confirm, Home, Members, `CardAction` and `CardPrimitives`. View-only zod becomes TS types. Preserve `packages/rpc/test/Cards.test.ts:3031–3108` and `MV/state/RetiredCardUpdates.test.ts:37,114` as old-record evidence. T-APP-19 and T-APP-19b close as landed history. | card tickets; opus §4 |
| Delete | CodeMirror `4a36b0cfb`: delete `UI/adapters/code-editor/index.tsx`, `MV/cards/views/CodeEditorView.tsx` and the `@codemirror/*` and `y-codemirror.next` pins. The File card renders through the existing `UI/adapters/code-view/CodeFileView.tsx`. Keep `DiffView`, folded into `MV/cards/DiffSurface.tsx`. Restore the adapter at S3 (§4). | T-APP-15, T-APP-15; SYNTHESIS-v1 §3 |
| Delete | `MV/cards/views/CommandsCases.ts` (421) and `CommandsExpectations.ts` (231) from `dc908a381`: a third copy of the catalog in product source. | T-UI-14; opus §4 |
| Delete | Merge duplicate recipe builders in `P/layers.go`; retain and wire `B/services/install_machine_ready.go` and its tests. | T-MCH-10, T-INS-06; §8.6 |
| Reshape [S1] | Fold `B/routes/host_status.go`, `/api/host`, its OpenAPI row, generated client and CLI `host status` handler into `GET/PUT /api/install` (`56c3fb2f4`). Keep the sizing code; `MV/state/seams/InstallModel.ts:25-32` already reads `/api/install`. | T-INS-08; opus §4 |
| Delete | Design twins: `HomeView` (`ab2ab5e0b`), `FlowView` (`214c4feff`) and `ConfirmView` (`c90e3383a`) are mounted with the old card deleted in the same commit (§9), or reverted. Toast Views (`406436c02`) follow the §9 toast row. | T-APP-01, -04, -05, -07; SYNTHESIS-v2 |

## 12. Standing rules and open items

| Rule or item | Resolution |
| --- | --- |
| #3377 do-not-implement (concurrent pinned versions) | Not needed: one coding host per machine. |
| #3401 do-not-implement (Pair) | M-17 restores shared access and presence only: the share producer, lease SQL shape and revocation tests above. Pair had no live push channel or co-editing. |
| #3382 do-not-implement (shared workspace bases) | Layer caching stays the recipe-digest mechanism in `P/layers.go`. |
| #2931 do-not-implement (DevTools) | Monitor uses trace, steps and graph views; the DevTools button stays. |
| ADR 0001 single-owner, `trusted_process` | Superseded for the Mac install by `docs/architecture/0002-mac-install.md`. |
| Public library packages | Kept, including those with no in-repo consumer (AGENTS.md "Still in force"). |
| Will decides (product, unchanged) | Live code co-editing timing (M-02), API playground (M-36), in-app docs (M-35), transcript adapters (M-38), model-written summaries, admission-queue positions, the members roster. Rows keep current mvp.md scope until he rules. |

### T-APP-22 app wiring (smithers-b8 lane app22)

| Existing path | Delta and added-line justification |
| --- | --- |
| `MV/ChatCards.tsx`, `MV/state/useCardRows.ts` | Replace blanket tombstone hiding with the existing title-only EntryRow; keep empty titles hidden. No new renderer or decoder. |
| `MV/cards/AgentCards.tsx`, its test, `MV/state/CardAvailability.ts` | Delete Explain rendering, failure copy and removed-behavior tests; add Explain to the existing unavailable set pending 38L's single-set decoder migration. |
| `MV/ChatCards.test.tsx`, `MV/state/AppController.test.ts` | Existing tests do not restore titled tombstones through the transcript query or capture model requests; add those boundary assertions and a live-card control. |
| `MV/cards/CardRenderers.test.tsx` | Existing registration coverage omits an explicit assertion that every unavailable kind has no renderer; add that assertion. |

The rpc decoder, shared `LEGACY_CARD_KINDS` export and immutable historical fixtures remain a request to 38L under the lane's library ownership rule. App availability retains its existing fail-closed set until that migration lands.

### T-APP-03 first-merge wiring delta (#3497)

| Existing path | First-merge change / reason for added lines |
| --- | --- |
| `cards/SetupContainer.tsx` | Rename to `cards/SetupCard.tsx`; reuse its mapper and catalog bindings. Supply missing row scope and input fields to the existing SetupView; no duplicate renderer. |
| `cards/CardRenderers.tsx`, `App.tsx`, `state/AppController.ts` | Add the absent browser-private Setup mount and local-host launch using the existing InstallSeam; no setup wire card or shared persistence is available in this phase. Keep question/File paths. |
| `state/seams/InstallModel.ts`, `InstallSeam.ts` | Delete duplicate step enum, top-level progress overrides and Bearer token path; use RPC IDs, step receipts, setup cookie and four Ready-ticket POST bodies. |
| `InstallContainers.test.tsx`, `InstallSeam.test.ts` | Replace obsolete progress/Bearer fixtures; add real View mount and literal request-body regression assertions where existing tests had no coverage. |
| `cards/SettingsContainer.tsx` | Omit the S2 parallel action when the S1 response omits parallel; Settings remains unmounted. |
