# T-MCH-11 Member unix users, `team` group, no-sudo image, per-machine homes

Stage S2 · Size L · Depends on T-ACC-02, T-SEC-01 · Unblocks T-APP-11, T-MCH-12, T-MNT-01, T-MNT-02, T-MNT-05, T-REL-02, T-TRM-01, T-TRM-02, T-TRM-03, T-TRM-07 · Issue: [#3570](https://github.com/smithersai/smithers/issues/3570)
Spec: spec.md §5.5, §8.7, §8.10.3, §8.11.1, §9.1.2 (`open_session`), §17.1, §17.2 · Delta: delta.md §3 (per-member users row), §5 (`developer`/`root` delete row) · Product: mvp.md J6.1, J6.5, §6.8 Terminals, §6.15 SSH, M-18, M-29
Ready: 2026-10-03 smithers-8a sha256:dc47b21a389b

## Goal

On every machine, each member is their own unix user with a private home on that machine, created at their first session, never shared with another machine. Tool logins persist in each machine’s home across sleep and wake; nothing copies tokens between machines (C-MCH-10). The coding agent is `agent`, everyone shares the working copy through the `team` group, and nobody can become root.

## Scope

In:
- Reshape existing trusted provisioning, not a second service/runtime. T-MCH-02 is accepted research, not a called code/schema dependency. T-ACC-02 supplies the roster schema; T-SEC-01 supplies hardened helper installation, setup and preflight code reshaped here.
- Lands dark until T-ACC-02: boot and first-session provisioning refuse missing, suspended or unallocated member identities; never infer a uid or fall back to developer/root.
- Lands dark until T-SEC-01: refuse privileged provisioning and retained wake without approved helper/image provenance and passing C-SEC-02 receipts.
- Lands dark until T-COL-03 and T-TRM-07: expose the specified identity contract but refuse S2 member sessions until the production daemon/broker consumes it and C-COL-04 passes. T-TRM-01 and T-TRM-03 enable terminal/SSH consumers; no legacy single-user or root SSH fallback enables S2 isolation. C-MCH-06/09/10 remain pending until real consumers pass. These activation gates add no reverse dependency edges.
- Users (§5.5.1): each member gets `collaborators.unix_uid` (from 20000, never reused) and login = GitHub login sanitized to `[a-z0-9_-]{1,32}`. A sanitized login that collides gets a numeric suffix (`ben`, `ben2`), fixed at first assignment (§5.5.2). `agent` is uid 19999. The `smithers-machined` broker is the only root process; the base image creates `machined` (uid 19998, groups `{team}`) for its daemon (§9.5.1, C-COL-04).
- Users exist on every machine: active members are created at boot, and a member added later is created at their first session start.
- `team` group, gid 20000 (§5.5.3). The working copy `/workspace` is owned `root:team`, directories are setgid, mode is `g+rwX`, and every session runs with `umask 002`. Members and `agent` are in `team` and in no other supplementary group.
- No privilege (§5.5.2): the image has no `sudo`, no `su`, no setuid or setgid file, and no file with capabilities. The `root` SSH user that `packages/backend/internal/services/workspace_ssh.go:24-38` offers is deleted, and so is the `developer` default for members (`packages/backend/internal/services/workspace.go:33-36`).
- No sshd in the guest (§8.10.3). Terminals and SSH sessions are daemon-owned PTYs and processes that `open_session` starts as the member's uid in a per-session cgroup (§8.11.1, §9.1.2). This ticket supplies the identities they run as: the member's uid, supplementary groups `[team]`, `umask 002` and the session environment. No path starts a session as root.
- Homes (§5.5.4, §8.7.1), per machine (product, 2026-10-02, after spike T-MCH-02's data loss):
  - `/home/<login>` on the machine's own disk, created by the guest helper at the member's first session on that machine (also for a member added while it is awake), owned by their uid with mode 0700;
  - kept across sleep with the disk (§8.4.3); no virtiofs mount for homes, and nothing in a home is shared with another machine;
  - `agent`'s own home stays on the machine's disk, and `agent` has no access to member homes.

Out:
- Starting sessions and their cgroups (the daemon's `open_session`, T-COL-03). Owner-only terminal input, terminal routing and deleting the stage-1 `msb exec -t` terminal path (T-TRM-01). The SSH gateway (T-TRM-03). Terminal sign-in tokens (T-TRM-02).
- Secrets in `/run/smithers/env` (T-MCH-12).
- Write attribution by session (T-COL-04).
- Any way to add system packages at run time; that path is `.smithers/machine.json` (T-MCH-10, M-29).
- Shared/virtiofs homes, synced credentials (deferred T-MCH-15), token seeding/copying, transcript import (T-AGT-02), new toolchains or package-selection logic.
- Implementing the Rust broker/daemon, wire protocol or session supervisor; a new provisioning service/runtime, UI Views, CLI/skill commands, host-root execution and LaunchAgent/plist loading (T-INS-03).

## Changes

- Reshape `packages/backend/microsandbox/runtime.go:50-51` and `:587` `prepareGuest`: keep the existing agent login, change uid 1500 to 19999, create team and machined 19998, set workspace ownership/setgid, and provision active member accounts through the trusted helper. Do not recursively chown retained homes or execute repository files as root.
- Reshape `packages/backend/microsandbox/guest/smithers-guest.py:475` `setup(user, uid, directories)` for trusted member login/uid/group bindings and 0700 homes. Preserve bounded identity and descriptor-based no-follow validation. `drop_to` (`:124`) validates the assigned primary gid and supplementary `[team]`; `run_exec` (`:140`) applies umask 002 after the drop. Replace the single-user 1500 checks with root/reserved-login/account-mismatch refusals (C-MCH-06, C-COL-04).
- Reshape existing base-image preparation and `packages/backend/microsandbox/layers.go:351` `recipeKey` / `:517` `buildLayer`: the approved base image has no sshd/sudo/su; strip setuid/setgid file bits and capabilities before branch inputs enter a layer. Preserve setgid directories. Include uid/gid and identity-policy version in the existing layer key to reject uid-1500 layers. Keep branch dependency installation unprivileged; add no branch-selected root recipe (C-MCH-06).
- Homes: reuse the helper's safe-directory setup at first session and preserve retained contents. `runtime.go:550` `machineFlags` keeps no home mount. Boot reads the current roster; persist no boot set of members (C-MCH-09/10).
- Reshape `packages/backend/internal/services/workspace_ssh.go:25-37` `workspaceRootSSHUser` / `resolveWorkspaceSSHUser`: delete root/default-developer member grants and resolve only the authenticated member's allocated login. Preserve the public refusal code (C-MCH-06).
- Reshape T-ACC-02's existing collaborators storage, not a new members table: reuse `collaborators.unix_uid` from 20000, never reused, and persist the sanitized login/suffix once. Reserve root, agent and machined; truncate before the suffix to stay within 32 characters (C-MCH-06).

## Tests
- C-MCH-06/09/10 acceptance drives production `Runtime.CreateWorkspace` and retained `Runtime.StartWorkspace`, the authenticated terminal WebSocket and daemon `open_session`, plus the composed router's `GET /api/repos/{owner}/{repo}/workspaces/{id}/ssh?user=root` (`packages/backend/internal/routes/workspace.go:582`) and production SSH gateway. Helper/resolver/fake-session tests are supplemental. Root image diagnostics run only approved main-pinned commands, never branch-built fixture scripts.
- Literal fixture identities (Ben 20001, Alice 20002, agent 19999, machined 19998, team 20000), groups, modes, sentinel bytes and refusal codes define expectations. No test reads spec files or derives expected policy from production constants/functions at runtime.
- Extend existing `root_boundary_test.go` / `root_boundary_real_vm_test.go`: `TestRootSetupNeverFollowsMemberSymlinks` adds member collision, reserved-login, account-mismatch and retained-home replacement cases through production provisioning; `TestRootPreflightParsesOnlyEnvelope` adds member identity drop and observes primary gid, `[team]`, uid and umask before repository payload execution; `TestGuestHelperInstallPinsInterpreterAndEnv` retains startup/wake provenance checks. Real-machine acceptance uses the existing approved-bundle gate (C-SEC-02, C-MCH-06).
- `TestMemberImageRootInputs` (extend existing `real_layers_test.go`, C-MCH-06) drives production layer preparation/workspace creation: refuse branch-selected root commands/executables and unapproved parent images; prove sanitization precedes branch input planting and observe dependency installers execute as agent. No second layer/security harness is introduced.
- Integration: C-MCH-10 uses independently created fixture tool logins on two real machines to prove persistence across sleep, wake and host restart, and no token copying.
- Acceptance: C-MCH-10 gates this ticket’s S2 phase; C-REL-05 is T-REL-02’s live release soak.

- integration (reference host, real microVM, `packages/backend/microsandbox/real_users_test.go`, new): `command -v sudo su` finds nothing; `find / -xdev -perm /6000 -type f` and `getcap -r /` are empty; `id agent` shows groups `agent team`; as `agent` and as another member, reading `/home/<login>` returns `EACCES`; Ben creates a file in `/workspace`, and Alice and `agent` can modify it. This is C-MCH-06.
- integration (reference host, real microVM): Ben and Alice each have `/home/<login>` with their own uid, gid and 0700. As Alice and as `agent`, reading any file in Ben's home returns `EACCES`. `mount` lists no virtiofs mount under `/home`. (C-MCH-09)
- integration: Ben writes `~/.marker` on branch A. Branch B never sees it. After A sleeps and wakes, the marker retains Ben's uid, mode 0664 and literal fixture bytes; the home directory remains 0700. (C-MCH-09)
- integration: Carol is added while branch A is awake. Her first terminal on A opens in `/home/carol` with her uid and 0700, with no restart. (C-MCH-09)
- unit: logins `Ben-Smith` and `ben_smith` sanitize to `ben-smith` and `ben_smith`; two logins that share their first 32 characters get `…` and `…2`, and the suffix never changes after assignment.
- unit (`packages/backend/microsandbox/parameters_unit_test.go`): uid 19999, gid 20000, and no `--mount-dir` for homes.
- unit (`packages/backend/internal/services/workspace_ssh_test.go`): `root` is refused with `CodeWorkspaceSSHUserInvalid`.

## Acceptance
- [C-SEC-02](../checks/C-SEC-02.md): approved-bundle fresh/retained startup, member setup and identity-drop validation gates privileged provisioning.
- [C-COL-04](../checks/C-COL-04.md): the daemon runs unprivileged beside the root broker.


- [C-MCH-06](../checks/C-MCH-06.md): no sudo or setuid; homes are 0700; `agent` and other members can't read a home.
- [C-MCH-09](../checks/C-MCH-09.md): homes are per machine, created at first session, never shared, kept across sleep.
- [C-MCH-10](../checks/C-MCH-10.md): Tool logins persist per machine across sleep and wake; Smithers never stores or copies tokens between machines

## Risks and notes

- jj and git in a working copy shared by several uids fail on lock files or `safe.directory`. Confirmed by alternating `jj st`, `git status` and `pnpm install` as Ben, Alice and `agent` (research/collab-terminals-wiki.md risks). Fix with `safe.directory=/workspace` in the system gitconfig and setgid directories. Measure before claiming.
- Login sanitization can collide: GitHub logins run to 39 characters, so two that share their first 32 truncate to the same login. The suffix rule (§5.5.2) keeps the result within 32 characters by truncating before the suffix.
- Homes and their caches use the machine's root disk. A team that fills it with npm or cargo caches makes the next write fail with `ENOSPC`. Confirmed by `df /` in a machine after a full dependency install by two members. Escalate before raising the root-disk size, which §8.2.1 derives from the host.
- Layer caches built for uid 1500 hold files owned by 1500. Confirmed by `find / -uid 1500` in a new VM. The layer-key change forces a rebuild of every layer once, which costs one prepare run per recipe on upgrade.

## Decisions and owner review

smithers-3f approves allocation, reserved-login/collision handling, image stripping/cache invalidation, guest provisioning, identity drop and security validation. smithers-b8 signs off the public SSH selection/refusal contract. smithers-8a accepts the provisioning/broker seam and any ADR change. Will alone changes per-machine homes or no-sudo product behavior. smithers-3f measures shared-copy permissions and disk pressure and escalates sizing to smithers-8a; this ticket does not change §8.2.1. Recorded owner answers stand; review is post hoc under the parallel-build directive.

## Security preconditions and root inputs

Repository code executes only inside machines as an unprivileged member or agent (M-29). smithers-3f reviews this boundary. Root installs, loads and executes only reviewed main-pinned or installed-bundle bytes, never a branch-built helper, binary, script, interpreter, import or toolchain. Tests cannot waive README hard rule 1. No host-root/plist-loading action is in scope; hard rule 2 remains with T-INS-03.

- Root startup/install and retained cleanup consume main-pinned helper bytes/digest/bootstrap, fixed destination/environment; bundled msb/libkrun and pinned base shell/Python/utilities/libraries/configuration; install-generated machine ids, configuration, deadlines and transport descriptors. Registry responses follow the pinned image digest. Retained snapshots, helper ancestors and environment/cache entries can contain branch/member data. T-SEC-01 R1–R3 inventories apply in full: `TestGuestHelperInstallPinsInterpreterAndEnv` proves provenance and protected startup; `TestRootSetupNeverFollowsMemberSymlinks` proves bounded retained data and no-follow setup before use (C-SEC-02).
- Root account/home/workspace setup consumes main-pinned reserved ids/logins, team gid, destination/mode policy, fixed utility argv and system gitconfig; trusted image account utilities and passwd/group/NSS state; install DB roster/login/uid bindings derived from GitHub identities, never user-selected identities. Existing workspace/home/cache directory entries, symlinks, ownership/modes and defaults can be branch/member data. Kernel descriptors/filesystem responses are trusted OS results influenced by those entries. `TestRootSetupNeverFollowsMemberSymlinks` proves bounded identity/path validation, reserved-login/collision/account-mismatch refusal, descriptor-based no-follow operations and replacement resistance before root use on fresh/retained machines (C-SEC-02, C-MCH-06). Root does not read home payloads or recursively rewrite member contents.
- Root base-image sanitization consumes only main-pinned image/digest, stripping commands, utility executables/libraries/configuration, fixed paths and uid/gid/mode policy, and image filesystem metadata. Perform it before repository inputs enter the layer. Existing layer lifecycle also consumes install-generated machine ids, resource/network settings, approved parent snapshots and fixed sync command; retained snapshots/cache/filesystem metadata can contain branch data. `TestMemberImageRootInputs` validates provenance and refuses branch-selected privileged commands, unapproved parents and unsafe paths before use (C-MCH-06). Dependency manifests, lockfiles, declared package selections, scripts and installer output are branch data; consume them only under the existing unprivileged preparation path. Missing trusted inputs or validation refuses preparation.
- Root identity preflight consumes main-pinned helper policy, host-authenticated allocated member/session bindings, fixed cgroup subtree, trusted account records and kernel cgroup/process state, descriptors and fork/wait/signal results. Envelope/request-file bytes, argv/env/cwd/stdin, paths and retained symlink graphs are branch/member data; processes influence cleanup population. `TestRootPreflightParsesOnlyEnvelope` proves bounded pre-drop parsing, fixed non-root identity binding, protected request parents and cgroup confinement. Payload parsing/execution follows primary gid, supplementary `[team]` and uid drop (C-SEC-02, C-MCH-06). C-COL-04 reruns identity refusal at real broker `open_session`; T-TRM-07 implements that consumer.

Any branch-sourced data consumed by root without the named validation is a blocker. Data validation never permits branch-built root code.

## Ready checklist
1. Depends on names called contracts: T-ACC-02 roster/schema and T-SEC-01 shared helper validation. T-MCH-02 is accepted research. Scope names fail-closed dark gates for unavailable identities, root validation and later daemon/terminal/SSH consumers without reverse edges.
2. Out explicitly excludes sessions/cgroups, terminal/SSH/token implementation, secrets, attribution, runtime packages/new toolchains, shared homes, credential sync/copying, transcripts, new runtime/provisioning service, UI/CLI/skills and host-root/plist work.
3. C-MCH-06/09/10 and C-SEC-02 use real lifecycle, authenticated terminal, composed SSH route and gateway; C-COL-04 uses the real broker. Literal fixtures define policy; helper/unit bypasses are supplemental.
4. smithers-3f decides Go/infra/allocation/image/security; smithers-b8 approves public SSH behavior; smithers-8a accepts the broker seam/ADR and disk-sizing escalation; Will decides product changes.
5. Owner pre-review: smithers-3f: Does persisted allocation reserve system logins and reject uid/account mismatches? Do fresh/retained root steps validate every listed input without branch code or symlink traversal? Does image/cache reshaping preserve private homes and team writes? smithers-b8: Does the SSH route refuse root/developer without minting a grant? Is its member login selected only from authenticated allocated identity? Recorded answers stand; review is post hoc under the parallel-build directive.
6. M-29 and both README hard rules are explicit; root steps list main/bundle/install and branch/member inputs with named production validation tests and smithers-3f review. Unvalidated branch data blocks activation; branch-built root code remains forbidden.
