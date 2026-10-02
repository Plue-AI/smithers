# T-MCH-11 Member unix users, `team` group, no-sudo image, homes mount

Stage S2 · Size L · Depends on T-MCH-02, T-ACC-02 · Unblocks T-MCH-12, T-COL-04, T-TRM-01, T-TRM-03 · Issue: to file
Spec: spec.md §5.5, §8.7, §8.10.3, §8.11.1, §9.1.2 (`open_session`), §17.1, §17.2 · Delta: delta.md §3 (per-member users row), §5 (`developer`/`root` delete row) · Product: mvp.md J6.1, J6.5, §6.8 Terminals, §6.15 SSH, M-18, M-29

## Goal

On every machine, each member is their own unix user with a private home mounted from the host, so a tool login happens once per install. The coding agent is `agent`, everyone shares the working copy through the `team` group, and nobody can become root.

## Scope

In:
- Users (§5.5.1): each member gets `members.unix_uid` (from 20000, never reused) and login = GitHub login sanitized to `[a-z0-9_-]{1,32}`. A sanitized login that collides gets a numeric suffix (`ben`, `ben2`), fixed at first assignment (§5.5.2). `agent` is uid 19999. `smithers-machined` is the only root process.
- Users exist on every machine: active members are created at boot, and a member added later is created at their first session start.
- `team` group, gid 20000 (§5.5.3). The working copy `/workspace` is owned `root:team`, directories are setgid, mode is `g+rwX`, and every session runs with `umask 002`. Members and `agent` are in `team` and in no other supplementary group.
- No privilege (§5.5.2): the image has no `sudo`, no `su`, no setuid or setgid file, and no file with capabilities. The `root` SSH user that `packages/backend/internal/services/workspace_ssh.go:24-38` offers is deleted, and so is the `developer` default for members (`packages/backend/internal/services/workspace.go:33-37`).
- No sshd in the guest (§8.10.3). Terminals and SSH sessions are daemon-owned PTYs and processes that `open_session` starts as the member's uid in a per-session cgroup (§8.11.1, §9.1.2). This ticket supplies the identities they run as: the member's uid, supplementary groups `[team]`, `umask 002` and the session environment. No path starts a session as root.
- Homes (§5.5.4, §8.7.1), layout B from spike T-MCH-02 (#3437), decided by the tech lead:
  - each active member's home is its own virtiofs mount at boot, `--mount-dir $STATE/homes/<login>:/home/<login>:uid=<uid>,gid=<uid>`, mode 0700, persisted on the host under `$STATE/homes/<login>/`;
  - `msb` can't add a mount to a running VM. A member added while a branch's machine is awake gets a machine-local `/home/<login>` (root disk, their uid, 0700) until that machine's next wake. Logins made there don't carry over, and the next boot removes it and mounts the real home;
  - while a member's home is machine-local, each of their terminals carries `temporary_home: true` in the terminal model (`branch:<id>` terminals and the Terminal card, §14.3), which the header renders as "temporary home until next wake" (T-APP-12);
  - in every case the home is owned by that member's uid with mode 0700, and `agent` has no access to it. `agent`'s own home stays on the machine's disk.

Out:
- Starting sessions and their cgroups (the daemon's `open_session`, T-COL-03). Owner-only terminal input, terminal routing and deleting the stage-1 `msb exec -t` terminal path (T-TRM-01). The SSH gateway (T-TRM-03). Terminal sign-in tokens (T-TRM-02).
- Secrets in `/run/smithers/env` (T-MCH-12).
- Write attribution by session (T-COL-04).
- Any way to add system packages at run time; that path is `.smithers/machine.json` (T-MCH-10, M-29).

## Changes

- `packages/backend/microsandbox/runtime.go:46-51` and `:585` `prepareGuest`: the coding host's user becomes `agent` 19999 (today's single guest user is uid 1500); create `team`; set `/workspace` ownership and setgid; create active member users through the guest helper.
- `packages/backend/microsandbox/guest/smithers-guest.py:369` `setup`: accept `USER UID GROUP`, add the user to `team` only, and set mode 0700 on the home. `drop_to` (`:93`) sets supplementary groups to `[team]` instead of `[]`, and `run_exec` applies `umask 002`.
- `packages/backend/microsandbox/layers.go`: the base layer has no `openssh-server`, removes `sudo` and `login`'s `su`, strips setuid and setgid bits with `find / -xdev -perm /6000 -type f -exec chmod ug-s {} +`, and strips file capabilities with `setcap -r` on every file `getcap -r /` lists. The guest user and uid go into the layer key so layers rebuild once.
- Homes mount: `runtime.go` `machineFlags` (`:544`) adds one `--mount-dir` per active member at boot, with that member's uid as `uid` and `gid`. `$STATE/homes/` and each `$STATE/homes/<login>/` are created with mode 0700 on the host. The machine record keeps the set of members mounted at this boot.
- Temporary homes: the guest helper creates the machine-local home for a member outside the boot set at their first session. The terminal manager sets `temporary_home` on that member's terminal rows from the boot set (the `branch:<id>` terminal row and the Terminal card model in `packages/rpc/src/Branch.ts` gain the field; T-APP-12 renders it), and the flag clears at the next wake.
- `packages/backend/internal/services/workspace_ssh.go:24-38` `workspaceRootSSHUser` and `resolveWorkspaceSSHUser`: delete the `root` option. Members resolve to their own login only.
- `packages/backend/sandbox/guest/handler.go:390` `handleEnsureUser`: unused by the microVM path. Delete it if no hosted caller remains.
- Uid and login allocation: the `members.unix_uid` sequence starting at 20000, and the sanitized login with its collision suffix, both written once in T-ACC-02's table.

## Tests

- integration (reference host, real microVM, `packages/backend/microsandbox/real_users_test.go`, new): `command -v sudo su` finds nothing; `find / -xdev -perm /6000 -type f` and `getcap -r /` are empty; `id agent` shows groups `agent team`; as `agent` and as another member, reading `/home/<login>` returns `EACCES`; Ben creates a file in `/workspace`, and Alice and `agent` can modify it. This is C-MCH-06.
- integration (reference host, real microVM): Ben and Alice each have one mount at `/home/<login>`, and `stat` shows their own uid, gid and 0700. As Alice and as `agent`, reading any file in Ben's home returns `EACCES`.
- integration: Ben writes `~/.marker` on branch A; with both machines awake, branch B sees it within the spike's bound (p95 < 1 s); after both sleep and wake, it is still there with Ben's uid and 0700.
- integration: Carol is added while branch A is awake. Her terminal opens with a machine-local home, uid and 0700, and its terminal row carries `temporary_home: true`. A file she writes there is absent from `$STATE/homes/carol/`. After A sleeps and wakes, her home is the mount and `temporary_home` is false.
- unit: logins `Ben-Smith` and `ben_smith` sanitize to `ben-smith` and `ben_smith`; two logins that share their first 32 characters get `…` and `…2`, and the suffix never changes after assignment.
- unit (`packages/backend/microsandbox/parameters_unit_test.go`): uid 19999, gid 20000, and exactly one `--mount-dir` per active member with that member's uid and gid; a removed member gets no mount.
- unit (`packages/backend/internal/services/workspace_ssh_test.go`): `root` is refused with `CodeWorkspaceSSHUserInvalid`.
- unit (terminal manager): a terminal row for a member outside the machine's boot set has `temporary_home: true`, one inside it has `false`, and the field is present in the `branch:<id>` snapshot and its deltas.

## Acceptance

- [C-MCH-06](../checks/C-MCH-06.md): no sudo or setuid; homes are 0700; `agent` and other members can't read a home.

## Risks and notes

- jj and git in a working copy shared by several uids fail on lock files or `safe.directory`. Confirmed by alternating `jj st`, `git status` and `pnpm install` as Ben, Alice and `agent` (research/collab-terminals-wiki.md risks). Fix with `safe.directory=/workspace` in the system gitconfig and setgid directories. Measure before claiming.
- Login sanitization can collide: GitHub logins run to 39 characters, so two that share their first 32 truncate to the same login. The suffix rule (§5.5.2) keeps the result within 32 characters by truncating before the suffix.
- Two awake machines writing one home (Ben on two branches) can corrupt tool state such as a login cache. C-SPK-02 records interleaved writes from two VMs; a tool that keeps a SQLite cache in the home is the likely failure. Confirmed if a Claude Code login refreshed in one VM is lost in the other within 10 s.
- Cross-VM visibility is p95 645 ms, max 4.7 s (§8.7.1). A login made on branch A and used on branch B within 5 s may not be there yet.
- One mount per member grows the VM's device list with the team. Confirmed if boot time or warm wake (C-PERF-05) rises by more than 10 % at 20 member mounts; escalate before capping mounts.
- The host flow runtime runs as the same macOS user that owns `$STATE/homes`, so §8.7.2 ("not readable by the host service's flows") is enforced by code paths, not by the OS. Confirmed by `rg 'homes'` over host flow code. Keep the path out of every host API.
- Layer caches built for uid 1500 hold files owned by 1500. Confirmed by `find / -uid 1500` in a new VM. The layer-key change forces a rebuild of every layer once, which costs one prepare run per recipe on upgrade.
