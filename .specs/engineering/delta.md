# From main to the MVP spec

Status: draft v0.4 by the engineering agent (smithers-8a), 2026-10-02, against `main` at `c04637a6f7`, for mvp.md v2.6. Rows tagged [S1]/[S2]/[S3] follow the build stages in spec.md §0. Deferred behavior (spec.md §0 [D]) has no rows here. For each subsystem: what exists, what the [spec](spec.md) requires, and the change list (Keep, Modify, Add, Delete, Restore). The evidence behind every path is in [research/](research/). Tickets in [tickets/](tickets/) implement these deltas.

Paths: `B/` = `packages/backend/internal/`, `MV/` = `apps/app/src/mainview/`, `F/` = `flows/`.

## 0. Summary

```
 Subsystem                     Today                                     Distance   Tickets
 ───────────────────────────── ───────────────────────────────────────── ────────── ─────────
 Install / package / HTTPS     dev launcher, loopback only, no package   M-L        T-INS-*
 Identity / roles / creds      single owner, password, PAT = person      L          T-ACC-*
 Machines / admission          per-user workspaces, cap 3, no queue      L          T-MCH-*
 machined / live docs          bash head loop, no watcher, wiki POST+SSE L (new)    T-COL-*
 Terminals / SSH               multi-viewer, single user, SSH unwired    M          T-TRM-*
 Stack / TODO                  issue-keyed items, 15 states, PR→main     L          T-STK-*
 GitHub sync                   App via env, 5/15 min polls, no ETag      M          T-GH-*
 Flows / versions / learning   pinning exists, no activation, no learn   M          T-FLW-*
 App shell / cards / catalog   ~267 commands, two catalogs, no TODO card L          T-APP-*, T-CAT-*
 Cuts / docs                   five-job UI, admin, billing still served  M          T-CUT-*, T-DOC-*
```

What carries over unchanged and is load-bearing:
- the durable flow engine (`@smthrs/flow`, journal, replay, fault suite);
- the Go↔TS runtime bridge (`flowdispatch`, `smithers.flow-runtime/v1`);
- the Mythical stack worker and its git machinery (`B/services/mythical*.go`);
- microVMs via `msb` 0.6.16, with layers, fork and cold snapshots;
- terminal multi-viewer with ring replay;
- the secrets store (AES-GCM, main-only, egress binding);
- the D-23 revision-bound approval gate;
- webhook verification and the job queue;
- the wiki (pages, revisions, Yrs merge, navigation index, folder sync);
- the app's card registry, flow registry, toasts and Jev selection.

## 1. Install, runtime, HTTPS

Today (`research/install-runtime.md`):
- `pnpm dev` → `apps/app/src/bun/serve.ts` → `NativeBackendProcess.ts` spawns `smithers-backend` + PG 18 on `127.0.0.1:4000`.
- `localOrigin()` (`NativeBackendProcess.ts:74`) rejects non-loopback origins.
- The env allowlist (`:62-72`) drops `SMITHERS_WORKSPACE_ISOLATION`, the platform keys, the GitHub settings and feature flags.
- No producer exists for `apps/app/bin/` or `postgres/`, since `39e43c0fe4` deleted `build-native.ts`.
- Upgrade (`distribution/upgrade.sh`) is Docker-only.

| Action | Change | Spec |
| --- | --- | --- |
| Restore→rewrite | Recover the bundling stages of `apps/app/scripts/build-native.ts` from parent `5b77095672`: node, git, jj, smithers-ffi, hosts, `bundlePostgres`, packaged smoke tests. Drop Electrobun, CEF, `NativeRendererServer.ts` and `DeepLink.ts`. Emit a Homebrew bottle layout plus `msb`/libkrun and the guest rootfs. | §16.1 |
| Add | `smthrs host start|stop|status|upgrade|backup|restore` commands (`up` and `status` already mean other things, `packages/smithers/src/Verb.ts:87`); launchd plist; formula in a `smithersai/homebrew-tap` repository. | §16 |
| Modify [S1] | `NativeBackendProcess.ts`: pass `SMITHERS_WORKSPACE_ISOLATION=microvm`, `SMITHERS_MICROSANDBOX_BIN` and the bind/public-origin settings from owner config, not the shell. GitHub App credentials are not launcher settings: they live sealed in PostgreSQL (`github_app`, spec §3) (today's allowlist at `:62-72` drops them). Loopback binding is unchanged. Extend the `backend-child-env` security entry in `apps/app/PACKAGE.ts:259-266` and its tests for the new variables. | §1.3, §16.3 |
| Modify [S1] | Origin-agnostic serving: loopback by default; owner-set bind address and public origins (Settings, applied live) feed `SMITHERS_SERVER_ADDR`, `SMITHERS_PUBLIC_URL` and `SMITHERS_SERVER_ALLOWED_ORIGINS` (`B/config/config.go:244-251`, `:470`). `localOrigin()` (`NativeBackendProcess.ts:74`) accepts the configured bind; update its `PACKAGE.ts:259-266` security entry so a non-loopback bind is allowed only from owner config. Cookies `Secure` only on https origins. No TLS code and no Tailscale code. | §1.4, §16.3, M-28 |
| Modify [S1] | Insecure-context support: one `getRandomValues` UUID helper replaces `crypto.randomUUID()` in 34 app files, with a lint ban; replace the single `crypto.subtle` use; clipboard `execCommand` fallback. | §16.3.2 |
| Add [S1] | Host profile (`hw.memsize`, performance cores, free disk) drives capacity, VM memory, vCPUs and layer budget (`apps/backend/isolation.go:microVMConfig`, `microsandbox/runtime.go:222-240`, `layers.go:92-100`). | §8.2.1 |
| Modify | `apps/backend/isolation.go`: microvm is the only mode on the Mac install; `process` remains for tests only. Refuse to start without msb. | §1.3 |
| Add [S1] | The setup card's backend: durable setup steps and an `/api/install` resource (App, repository, squash-merge check, model access, mirror, first image). Model keys are set through the API into sealed owner secrets (`modelhost/owner_secrets.go`), replacing the `SMITHERS_PLATFORM_MODEL_KEYS_FILE` path for the Mac install. | §16.2 |
| Modify [S1] | Setup order (spec §16.2): setup-link session → Address → which account owns the repository → App via manifest → owner GitHub sign-in completes the claim → repository and App install → three model roles (`fast`, `coding`, `jev`) → squash check → Source ready → Machine ready. Enable the ChatGPT subscription pool on the Mac install behind the owner setting (`config.go:172-182` flag today). | §16.2, §11.5a |
| Add [S1] | `toolchains.json`: a pinned toolchain manifest (version → URL → SHA-256) shipped in the bundle. | §8.6.2a |
| Restore [S1] | Owner-only model configuration from `5b77095672`: `model.*` entries and `ModelCards.tsx`, without the model laboratory (`ModelCallCard.tsx`, `controller/modelCall.ts` stay deleted). | §11.5a |
| Add | `smthrs host upgrade`: quiesce, capture, `pg_dump` + `cp -c` clone, brew upgrade, migrate, health, restore hint. Reuse checks from `distribution/lib.sh`. Write `version.env` at first boot. | §16.4 |
| Delete [R] | The Docker self-host image and its scripts (`distribution/Dockerfile`, `entrypoint.sh`, Docker `backup.sh`/`restore.sh`/`upgrade.sh`, `apps/app/scripts/mode-matrix/docker-web-selfhost.ts`, the CI image build). Nothing consumes it and it was never published (#2481). Decided by the tech lead 2026-10-02 (T-INS-05). | AGENTS.md, §16.1.0 |
| Modify | Docs: `docs/architecture/self-host-implementation.md` and ADR 0001 single-owner/`trusted_process` statements are superseded for the MVP edition. Write ADR 0002 "Mac install: multi-member, microVM-only" (T-DOC-02). | §1 |

## 2. Identity, roles, credentials

Today (`research/identity-access.md`):
- Self-host is one password owner (`B/services/local_identity.go:123`, `self_host_owners` singleton), enforced by `B/identity/single_owner.go:40` on HTTP, SSE and git.
- GitHub OAuth only re-links to the owner (`B/services/auth.go:599-621`).
- Permission is a local ACL (`B/services/repo_permissions.go`).
- `smthrs login` mints a person PAT with `write:approval` (`packages/smithers/src/internal/backend/Auth.ts:268`).
- `RequirePerson` refuses run credentials and agent accounts only (`B/middleware/run_credential.go`).
- The revocation bus exists (`B/revocation/event.go`).

| Action | Change | Spec |
| --- | --- | --- |
| Delete | `self_host_owners` singleton semantics, `SingleOwnerBoundary` and the `/api/orgs*` 404 middleware for self-host; the local password owner path (`/api/auth/local/*`, `local_credentials`, the bootstrap token gate) once GitHub sign-in owns first boot. The owner is created by the first GitHub sign-in that carries the one-time setup token printed by `smthrs host start` (spec §5.1.0). | §5.1, M-17 |
| Add | `members` table and service (§3); `/api/members`; sign-in check (roster ∧ GitHub push permission via `GET /collaborators/{login}/permission`, reuse the `/collaborators/{login}/permission` call at `B/services/github_issue_text_writer.go:161`); hourly re-check job; role seeding. | §5.1 |
| Modify | `repo_permissions.go` → one `Authorize(credential, action, subject)` over the §5.2 matrix. Owner = installer, Maintainer = admin, Member = write. Gate secrets, merge, triggers and settings. | §5.2 |
| Add | Credential kind `delegated` with a `via` field (migration on `access_tokens`), `TokenCredentialKind` mapping (`run_credential.go:66`), `RequirePerson` refusing it. `/api/auth/github/cli` mints `delegated(via=cli|<agent>)`. | §5.3 |
| Add | `person_confirmations` + `/api/confirmations` (session-only approve); the app's Confirm card; CLI `/merge` creates a confirmation. | §5.4 |
| Add | Actor `via` on audit events (`B/services/audit.go:49`), activity, presence, todo_events. | §2, §6.4 |
| Modify | Member removal publishes `collaborator_removed` on the revocation bus and deletes sessions, PATs and SSH grants (`B/revocation/*`). | §5.6 |
| Restore (reference) | Closed-alpha roster (`88d42515d2`): add/list/remove semantics only. Write new code; do not restore the tables. | §5.1 |

## 3. Machines, admission, images

Today (`research/workspaces-machines.md`):
- Workspace identity is `(repo, user, kind, bookmark, name)` (`0095_workspace_source_commit.sql:10-12 (re-created from 0084)`).
- The agent path inserts its own `kind=agent` row (`B/services/workspace_agent.go:111-190`).
- Cap: `MaxRunningVMs=3`, with an untyped refusal (`microsandbox/runtime.go:533-541`).
- Owners wake machines on reads (`workspace_facets.go:459-466`).
- Fork stops the source and copies its disk (`workspace_runtime.go:502-675`).
- Disk reclaim has no capture step (`workspace_disk_reclaim.go`).
- Layers refuse without `.smithers/target-index.json` (`microsandbox/layers.go:565`).
- Branch locks are a separate service with no app consumer.

| Action | Change | Spec |
| --- | --- | --- |
| Modify | Identity: add `branches` + `machines` (§3) as the product model. A workspace row becomes the machine's runtime record, owned by the install system user. Drop `user_id` from the active-identity index (`uq_workspaces_active`, last re-created in `0095_workspace_source_commit.sql:10-12`); move `agent_session_id` uniqueness to a join table; stop counting machines in `enforce_workspace_user_quota`. The agent path attaches to the branch's machine instead of inserting `kind=agent`. | §8.1 |
| Delete | Branch locks: `B/services/branch_lock.go`, 6 routes (`B/compose/router.go:1387-1399`), `branch_locks` + `branch_lock_join_requests` (drop migration), sqlc queries, `AuthorizeBranchLockJoin` on billing/admission, notification kind, error code, `ProductApi.ts` types, OpenAPI paths, 11 test files. | M-17 |
| Add | Admission scheduler (`machine_requests`, classes, positions, safe-idle release) in front of `admitRunningLocked` and `CreateAgentWorkspace`. A typed `capacity` error replaces `fmt.Errorf("microVM capacity reached")`. | §8.3 |
| Modify | Capacity from `hw.memsize` in `apps/backend/isolation.go:microVMConfig`. | §8.2 |
| Modify | Reads of asleep branches serve from `refs/smithers/branches/<id>/head` in the host repo store; `ListWorkspaceFiles`/`ReadWorkspaceFile` never wake. | §8.4.4 |
| Modify | Sleep/stop: final capture first (flush, snapshot, push head, verify). Replace the 2 s/30 s bash head loop (`B/services/workspace_head.go:52-171`) with `smithers-machined` capture. | §8.4.3, §9 |
| Modify | Fork: from a captured revision; never stop the source (`workspace_runtime.go:547-560` stop-snapshot-resume is replaced by "capture, then create from revision"). | §8.5 |
| Modify | Cleanup: delete only when the TODO is settled, captured and quiet for 24 h; replace `kind=agent` 24 h reclaim. | §8.12 |
| Add | Toolchain detector (port `packages/smithers/src/suggest/Checklist.ts:174-226` logic to Go) emitting a recipe that `dependencyRecipe` (`layers.go:914`) consumes when no target index exists; `.smithers/machine.json` `packages[]`. | §8.6 |
| Add [S1] | Fork, Add to stack and Rebase now as stage-1 system flows over today's workspaces (fork from `main` or an item's last verified head; Add to stack renames the scratch branch into the item branch). Stage 2 adds capture-first forks from any branch. | §8.5 |
| Add [S2] | Per-member unix users (`smithers-guest.py setup USER UID` and `EnsureUser` exist, unused), `team` group, no sudo in the image, per-machine homes on the machine's disk with no virtiofs (spike T-MCH-02: shared homes lost data), and a per-member credential store synced by `smithers-machined` (T-MCH-15). Terminals and SSH sessions move from `msb exec -t` as the guest's single user (uid 1500, `microsandbox/runtime.go:50-51`) to daemon-owned sessions as each member's uid; the guest runs no sshd. | §5.5, §8.7, §8.10.3, §8.11 |
| Modify [S2] | Secrets reach machines: all-branches secrets → `/run/smithers/env`, rewritten on change. Confirm today's gap: unbound repo secrets don't reach workspace machines (`workspace_provisioning.go:389-480`). | §8.8 |
| Hide | `box.facet`, `box.services`, `box.egress`, `box.images` (the Machine view is deferred, spec §0 [D]); the backend facets stay for Plue. | §0 |

## 4. smithers-machined and live documents (new)

Today (`research/collab-terminals-wiki.md`):
- No in-VM daemon exists. `microsandbox/guest/smithers-guest.py` is a one-shot helper invoked by `msb exec`.
- No file watcher and no write attribution exist.
- The wiki "Yjs" path is POST update plus an SSE "refetch" signal (`B/routes/wiki_collaboration.go`), merged by Yrs 0.27.4 through FFI (`crates/smithers-ffi/src/wiki_document.rs`).
- File writes have no precondition (`PUT /workspaces/{id}/files/content`).

| Action | Change | Spec |
| --- | --- | --- |
| Add [S2] | `crates/smithers-machined`: Rust, static linux-arm64. [S2] inotify watcher with session-based attribution (spec §9.3.1; fanotify deferred), burst grouping, jj snapshot per burst, capture, moved-off detection, the host connection. [S3] Yrs code documents (reuse `yrs =0.27.4` from `crates/smithers-ffi`). Installed into the guest rootfs and started by init before sshd. No blob cache, Undo or merge3 in the MVP. | §9 |
| Add | Host relay: one authenticated multiplexed connection per machine, carried over the existing relay (`microsandbox` `relay` to a guest loopback port, per README "relay carries a byte stream to a guest loopback port"). | §9.1 |
| Add [S1] | Live channel `/api/live` (WebSocket) in the Go host: topics on the existing broker (`Broker.Subscribe`), projection snapshot+delta with cursors (`projection_events`). [S2] presence map and terminal frames. [S3] Yjs relay. | §7 |
| Modify [S3] | Wiki co-editing moves onto §7.4 together with code co-editing: the host-owned Yrs doc speaks the Yjs sync protocol over the live channel. Delete `POST .../updates`, the per-page SSE refetch stream and the client's POST queue (the `/updates` POST queue at `MV/wiki/CloudWiki.ts:288`). | §7.4.3 |
| Add [S1] | ADR 0003 and the §7.6 contracts. The File card moves from the read-only Pierre file view (`@smthrs/ui/adapters/code-view`, `@pierre/diffs` `File`) to CodeMirror 6. Code-intelligence gestures (`code.hover`/`definition`/`diagnostics`, `MV/cards/CodeSurface.tsx`) are re-hosted as CodeMirror extensions. `PUT /workspaces/{id}/files/content` gains `base_digest` and actor. | §7.6 |
| Add [S1] | `activity` table and the `branch:<id>:activity` topic (steers, answers, agent steps and GitHub comments arrive in S1). | §3, §7.2 |
| Add [S2] | `burst_files`; the `:files` topic; `file_written` and burst events; snapshot commits pushed to the host; File and Diff cards reload on change. | §3, §9.3.4 |
| Delete | `workspace_head.go` bash loop and its install path once `smithers-machined` captures heads. | §9 |
| Reference | `packages/smithers/flows/sync/src/BranchPresence.ts` (lease-table presence, kept as a library). The product presence map lives in the Go host with the same lease semantics (30 s TTL). | §7.3 |

## 5. Terminals and SSH

Today:
- `B/routes/terminal_session_manager.go` gives one PTY per session through guest sshd, many viewers and a 512 KiB ring.
- Any viewer's input reaches stdin (`workspace_terminal.go:659`).
- The guest user is `developer` or `root` (`B/services/workspace_ssh.go:29`).
- The SSH server (`packages/backend/ssh/ssh.go`, `B/ssh/server.go`, gliderlabs, `:2222`) is never constructed by `apps/backend`. Keys come only from `ssh_keys`.

| Action | Change | Spec |
| --- | --- | --- |
| Modify [S2] | Terminal sessions run as the owner's unix user; owner-only input (drop binary frames from other sinks in `terminal_session_manager.go`); read-only for others. | §8.11 |
| Add | Terminal auto sign-in: mint `delegated(via=terminal)` at session start, write `/run/smithers/<uid>/token`, set `SMITHERS_TOKEN_FILE`/`SMITHERS_URL`; `Session.ts` gains a `SMITHERS_TOKEN_FILE` reader (none exists today; T-TRM-02). | §5.3.2 |
| Add [S2] | Construct the SSH server in `apps/backend` on the install's bind address, port 2222 (loopback by default), with a `WorkspaceBridge` for the microVM runtime. Username = branch name. Admission request class `person`; per-member guest user; sftp, exec and `direct-tcpip`. | §8.10 |
| Add | GitHub key import (`GET /users/{login}/keys`) at sign-in and hourly into `ssh_keys` with source=github. | §8.10.2 |
| Delete | `developer`/`root` grant variants for members (`root` stays for nothing: no member or agent root, M-29). | §5.5.2 |

## 6. Stack and TODOs

Today (`research/stack-todos.md`):
- `mythical_items` is keyed by issue number. Its prompt is the pinned `issue_body`.
- It has one 15-value state enum.
- Order is the issue number (`mythical_items.go:1113`).
- The PR base is `main` (`:2095`), and the branch is `smithers/issue-N`.
- Merge happens through the automerge label plus the Land record (`mythical_land_todo.go`).
- There are no Before/Amend/Move/Drop/Pause operations.
- Steering covers planning boundaries only (`F/coding/steering.ts`).
- A conflict goes to `retrying` and then `blocked`.

| Action | Change | Spec |
| --- | --- | --- |
| Add [S1] | `todos`, `todo_revisions`, `todo_events`, `todo_attempts`, `todo_approvals`, `branches` (item branches exist from S1; `machines` arrives in S2), `stack_attention` (§3). `mythical_items.todo_id` (1:1); relax `mythical_items_issue_idx` (an issue link is optional). The TODO state machine (§4.1) is computed in one Go package (`B/services/todo_state.go`) with unit tests over every transition. | §4.1, M-16 |
| Modify | Admission from GitHub: `ObserveIssue` (`mythical_items.go:165`) freezes text at the label event (revision 1), never "until started" (`:236-262`). `FileTodo` no longer creates a GitHub issue; chat TODOs have no issue. | §10.2.1 |
| Add | Placement (`stack_position` dense key) and operations append/before/amend/move/drop; routes under `/api/todos`; items advance in stack order, not today's order (chat items first, then issue number, `mythical_items.go:1110-1116`). | §10.2 |
| Modify [S1] | Merge: only the first unmerged item; `POST /api/todos/{n}/merge` (session + role + head sha) replaces the `automerge` label and Land path; GitHub merge with `sha` and squash (kept from `mythical_github.go:324`); setup refuses repositories without squash merging. Delete `LandTodo`'s label-application path and the `automerge` label semantics. | §10.6 |
| Modify [S1] | PRs stay based on `main` as verified candidates (today's design). Change: head `smithers/<slug>` instead of `smithers/issue-N` (`mythicalBranch` `:2115`); PR body with prompt, evidence, included earlier items and "Requested by" (`proposal()` `:2126`); the PR card diffs against the previous item's candidate. | §12.5 |
| Add | Stop/Resume (state `paused`), Retry with attempt rows, Drop with PR close. | §10.7 |
| Modify [S1] | One `todo` run per attempt (T-FLW-11): the worker's four launches (`mythical_items.go:1681,1775,1905` request, vibe, verify, plus review via the `mythicalReviewFlow` constant at `:2277`) become one run of the pinned `todo` flow, which ends with `stack.propose`. Integration, re-verification, PR and merge stay in the stack engine. The built-in `todo` flow becomes a composition file over step flows exported from `flows/coding/`. | §10.4.1 |
| Add [S1] | Later items' PRs open as GitHub drafts and become ready when first (GraphQL `markPullRequestReadyForReview` / `convertPullRequestToDraft`), with a "[waits for Tn]" fallback where drafts are unavailable. An out-of-order merge marks the earlier items merged and closes their PRs as "Merged via". | §12.5.1, §10.6.4 |
| Add [S1] | Retry with the current flow; Needs you → Queued after a machine release; a planner that declines with questions becomes a question wait (today's `declined` ends the item). | §4.1, §10.8.1a |
| Add [S1] | Keep TODO workspaces until the TODO settles: no 5-min agent idle stop while a run waits (`defaultAgentIdleTimeout`, `B/services/agent_dispatch.go:1128`), no 24 h disk reclaim for unmerged TODOs (`workspace_disk_reclaim.go:20`), and wake before delivering a signal to a sleeping run (T-MCH-14). | §8.4, §10.4.1 |
| Add | Steer route `/api/todos/{n}` `steer` → run signal; accept steers between implement turns (`F/coding/implementation/flow.ts` has no `ReceiveFeedback`) and in vibe/verify (`steering.ts` admits only `coding/request` roots). | §10.7.3 |
| Add | Needs-you kinds and first-answer-wins answers (409 with `answered_by`). | §10.8 |
| Modify | Rebase: presence-aware scheduling and Rebase now, via `smithers-machined` §9.4; conflicts → agent once → Needs you with Resolve, replacing the 3-attempt `retrying` → `blocked` loop (`mythical_items.go:1840-1847`). | §10.5 |
| Delete | `change.land`/plue landing requests as a TODO merge path in the product. One merge path: §10.6. Keep the D-23 SQL gate logic by moving it to `todo_approvals`. | §10.6, zero tech debt |
| Hide | `history.bootstrap`, `history.backfill`; `history.parallel` becomes the owner setting. | mvp.md §8 |

## 7. GitHub sync

Today (`research/github-sync.md`):
- The App comes from env (`SMITHERS_GITHUB_APP_*`), with the slug hard-coded to `smitherspreviewrelease`.
- Polls: main 5 min, PRs 5 min, issues 15 min. There is no ETag handling.
- Webhooks are verified but act only on issues, mentions and main pushes.
- Missing: review and comment ingestion, thread replies, stacked bases, push ingestion (the code freezes the TODO instead), force-push handling, a sync-status UI and the manifest flow.
- `mirror: pull` is required, and undeclared repos are skipped.

| Action | Change | Spec |
| --- | --- | --- |
| Add | App manifest flow and sealed App credentials in PostgreSQL; remove the hard-coded slug (`repo_connection_github_app.go:96`, `github_access_diagnosis.go:59`). | §12.1 |
| Modify | Poll scheduler: one `github_sync` row per stream; conditional requests; cached installation tokens; shared budget (`github_budget.go`) on every call including the stack's `landingGitHubAPI.request`. Constants → §12.2 cadences. | §12.2 |
| Modify | `mirror: pull` is the default for the install's repository (policy check at `github_main_pull.go:578-581`). | §12.3 |
| Add [S1] | Inbound reviews, review comments and conversation comments → activity + steer + `in_review → working` (`ObserveGitHubEvent` `mythical_items.go:2827` + poll fallback). | §12.3 |
| Modify [S1] | Foreign push to `smithers/<slug>`: today's freeze (`mythical_items.go:2197-2206`) becomes `needs_you{foreign_push}` with the commit link; the next verified push replaces it. | §12.3 |
| Modify | PR closed → `dropped` with actor; reopen restores (`mythicalSettledStates` `:85`). Checks name the failing required check (`HeadChecks` `mythical_github.go:611`) and run outside automerge. Build GitHub's refusal message: `landingGitHubStatusError` (`landing_github_pull.go:446-465`) discards the response body today, so the verbatim reason ("1 approving review required") is new work in T-GH-05. | §12.3 |
| Add | Force-push to `main` → owner Needs you → confirm → reset mirror and rebase (non-fast-forward detection at `github_main_pull.go:585-590`). | §12.3 |
| Add | Health model + `GET/POST /api/github/sync`; the home `main` row reads it. Remove the unused per-route statuses once the home card reads the new one. | §12.6 |

## 8. Flows, versions, triggers, learning

Today (`research/flows-engine.md`):
- The engine, journal, replay and fault suite are built. A run pins `executionDigest` (`ExecutionSnapshot.ts:45`).
- Repository flows beat built-ins (`F/repository/registry.ts:333-411`).
- No Active/Merged state exists, and a failed refresh drops the previous entry (`Executable.ts:2036`).
- The registrar is UTC-only (`F/repository/schema.ts:278`).
- `improve.mine` is declared only. The config needs `.smithers/coding-project.json`.
- Self-host runs flows as `trusted_process`.

| Action | Change | Spec |
| --- | --- | --- |
| Modify | Overridable flows run only in machines. The host never loads repository flows. Default self-host `trusted_process` launch of the coding host is replaced by the machine's coding host. | §1.3, §11.1 |
| Add | `flow-load` background run + `flow_versions`/`flow_activations`; Active / merged-syncing / merged-failed / proposed projection; keep the previous executable on refusal (fix `Executable.ts:2036`, test "edit breaks existing flow"). | §11.3 |
| Modify | Coding host loads the pinned closure by digest for TODO runs; never the branch's `flows/`. Because hosts are per machine, #3377 (do-not-implement) is not needed. | §11.4 |
| Add | `/flow.edit`: built-in source copy + patch → TODO with `seed_patch`. | §11.5 |
| Add | Install-stored default config (checks, wiki pages, seats) with field-wise precedence for repo `.smithers/*` (`F/coding/project-config.ts`). | §11.2 |
| Add | `F/learning/flow.ts` (`Flow.make("learning", …)`): pages + proposals + lessons count; `proposals` table and card. Replace the `improve.mine` fixture references. | §11.8 |
| Add [S1] | Agent instructions as repository Markdown loaded as data (`.smithers/instructions/app.md`, the TODO flow's prompts); three model roles as owner settings applied immediately. Monitor step labels from mvp.md Appendix C's Inspect column, with engine bookkeeping collapsed. | §11.5a, §11.6.2 |
| Hide | Triggers (deferred): `triggers.*` entries hidden from the MVP catalog; registrar and engine untouched. | §11.7 |
| Add | Monitor: `/monitor` door, per-step cost (`modelprice`), durable-waits list with since. Delete the `forks` trace filter (`MV/flows/entries/runs.ts:177`). | §11.6 |
| Add | Runtime event types needed by §11.6.1 that aren't already emitted (cost, wait since); conversation-entry summarizer job. | §11.6, §14.5 |

## 9. App shell, cards, catalog

Today (`research/app-shell.md`, `research/cli-api-cuts.md`):
- React with TanStack DB (OPFS SQLite). Cards are components (`MV/cards/CardRenderers.tsx`).
- One app flow registry of about 267 entries, while the CLI has a separate incur tree of 205 backend commands. Two catalogs.
- Missing: TODO, Draft, Confirm, Learning, Members and Setup cards, the Branch card with presence, the live File card, line comments and browser notifications.

| Action | Change | Spec |
| --- | --- | --- |
| Add | One catalog source: command descriptors (payload schema, slash, CLI path, visibility, person-only) in `packages/rpc/src/catalog/`, consumed by the app registry, the CLI mount (`packages/smithers/src/internal/backend/Commands.ts`) and the skill generator; `catalog.mvp.json`; parity tests C-CAT-01..03. | §6.1 |
| Hide/Delete | Every command not in Appendix A: hidden or deleted per mvp.md §8 (about 200 ids). | §6.1.3 |
| Modify | `StackCard.tsx` → Home card on the `home` topic: `main` row with sync health, counts as filters over TODO states, machines/capacity, background runs, shared placement. | §14.3 |
| Add | Cards: [S1] TODO, Draft, Settings/Setup, Confirm, Flow versions, Agent (model), Members, Secrets. [S2] Branch (presence, activity), File reload-on-change with gone states, Terminal ownership. [S3] File live co-edit on `@smthrs/ui` CodeSurface + Yjs binding with gutter flags; Proposal. | §14.3 |
| Add [S1] | Branch conversations: `conversations` (1:1 branch), shared `conversation_entries`, `member_conversation_state`; the branch tree; prompts run with their author's delegated credential. Today's per-member conversations (`MV/state/AppStore.ts` OPFS collections plus backend turn routes) become read-only archives visible only to their member. | §14.1 |
| Add [S1] | Context preflight as the first step of every app-agent turn; `context[]` stored on the answer entry; "Context" line; Inspect shows preflight first. | §15.1.2 |
| Modify [S1] | App-agent turns move from browser-side tool execution to a host turn runner that dispatches through the CLI's command→API mapping, with a host-minted delegated credential. The browser receives only UI-only instructions. | §15.1.4 |
| Add [S2] | Browser notifications on secure origins (`notifications.allow`); Obsidian folder sync as a Settings control reading `install_settings` (`B/config/wiki_sync.go:15`, `B/services/wiki_sync_obsidian.go`). | §14.6, §13.3 |
| Add [S1] | The allowlist test reads mvp.md Appendices A, B (B.1, B.2, B.4, B.6) and C (`.specs/product/actions.md`). | §6.1.2 |
| Add [S1] | Left-edge toast map + timeline from `conversation_entries`; event toasts with per-member hiding; retire `ChatRunTimeline`. | §14.4, §14.5 |
| Modify | Seams move from per-resource SSE (`/mythical/events`, `/workspaces/{id}/stream`, wiki stream) to live-channel topics. Delete each SSE route when its last consumer moves. | §7 |
| Modify | Actor rendering with `via` badges ("Ben via Smithers"). | §2 |
| Modify [S1] | Every card in scope splits into a design-owned `<Card>View` (props only) and an engineering-owned `<Card>Container` (topics → props, callbacks → catalog commands); `MV/cards/CardRenderers.tsx` renders Containers. View-model schemas go in `packages/rpc/src/<Card>Card.ts` (the `SubagentCard.ts` precedent) with fixtures in `MV/cards/fixtures/` (T-APP-19). An existing card file that mixes both is split in the change that ports it. | §14.2.1 |

## 10. Cuts and docs

| Action | Change | Spec |
| --- | --- | --- |
| Delete | App: SetupChecklist, RepositorySetupCard, setup/chores/ci/feature flows, SignupCards, onboarding/tutorial, Registration*, AdminCards + admin flows, BillingCards + billing flows, BurndownCard + issue-sweep entry, SubagentGrid, agent sessions, CommitCards, `change.split`. File list: `research/app-shell.md` "Cut surfaces". | mvp.md §8 |
| Delete | Backend/OpenAPI: `/api/repository-setup/*`, repository-jobs setup paths (keep event admission and dispatch), `/api/admin/*` except owner health, billing routes (Defer: hide behind build flag or delete, T-CUT-03 decides per route), branch locks, `changes/{id}/split`, registration review. Delete the route and its OpenAPI row together (`openapi_conformance_test.go:220`). | §6.2.4 |
| Delete | `apps/review` (empty), `packages/smithers/create-app`. | AGENTS.md |
| Defer | TUI: keep building; remove from launch docs, skill and release gate. | mvp.md §8 |
| Modify | AGENTS.md "MVP scope boundaries": align with mvp.md §8 (the five jobs are cut as surfaces; admission and dispatch stay). | M-12 |
| Replace | `docs/mvp/PRODUCT.md`, `ENGINEERING.md` and `DESIGN.md` → the approved `.specs/*` content (M-12), with inbound links (`AGENTS.md` D-16, `docs/design/shared-workspace-layers.md`, `apps/site/docs/UI-DOCS.md`) updated in the same change. | M-12 |
| Add | Public docs: one quickstart (install → setup → first TODO → teammates) + flows reference, colocated in the package `docs/`, `pnpm docs:sync`, `pnpm docs:check`, `smthrs docs //<pkg>:docs`. | mvp.md §12.4 |

## 11. Conflicts with standing rules

| Rule | Conflict | Resolution |
| --- | --- | --- |
| #3377 do-not-implement (concurrent pinned versions) | J5.4 needs running TODOs to keep their version | Not needed: one coding host per machine (§11.4.2). No action. |
| #3401 do-not-implement (Pair) | M-17 needs shared access and presence | M-17 supersedes only for those parts. Build new; restore nothing from Pair beyond semantics. |
| #2931 do-not-implement (DevTools) | §6.14 monitor | The monitor uses the trace/steps/graph views. The DevTools button stays as is. |
| #3382 do-not-implement (shared workspace bases) | §8.6 layer cache shared across branches | Layer cache keyed by recipe digest is today's mechanism (`layers.go`), not #3382's prepared bases. No conflict. |
| ADR 0001 self-host single-owner, `trusted_process` | M-17, §1.3 | ADR 0002 supersedes for the Mac install (T-DOC-02). |
| AGENTS.md "retain all five maintenance jobs" | mvp.md §8 cuts the five-job surfaces | AGENTS.md edit in T-CUT-01 with Will's sign-off on mvp.md. |
| AGENTS.md "Instant chat" reference implementation `repositorySetup.ts` | Cut by §8 | Re-point the reference to the TODO controller in T-CUT-01. |
