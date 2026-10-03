# T-MCH-11 Member unix users, `team` group, no-sudo image, per-machine homes

Stage S2 · Size L · Depends on T-MCH-02, T-ACC-02 · Unblocks T-COL-04, T-MCH-12, T-MNT-01, T-MNT-02, T-MNT-05, T-REL-02, T-TRM-01, T-TRM-02, T-TRM-03, T-TRM-07 · Issue: [#3570](https://github.com/smithersai/smithers/issues/3570)
Spec: spec.md §5.5, §8.7, §8.10.3, §8.11.1, §9.1.2 (`open_session`), §17.1, §17.2 · Delta: delta.md §3 (per-member users row), §5 (`developer`/`root` delete row) · Product: mvp.md J6.1, J6.5, §6.8 Terminals, §6.15 SSH, M-18, M-29

## Goal

On every machine, each member is their own unix user with a private home on that machine, created at their first session, never shared with another machine. Tool logins persist in each machine’s home across sleep and wake; nothing copies tokens between machines (C-MCH-10). The coding agent is `agent`, everyone shares the working copy through the `team` group, and nobody can become root.

## Scope

In:
- Users (§5.5.1): each member gets `members.unix_uid` (from 20000, never reused) and login = GitHub login sanitized to `[a-z0-9_-]{1,32}`. A sanitized login that collides gets a numeric suffix (`ben`, `ben2`), fixed at first assignment (§5.5.2). `agent` is uid 19999. The `smithers-machined` broker is the only root process; the base image creates `machined` (uid 19998, groups `{team}`) for its daemon (§9.5.1, C-COL-04).
- Users exist on every machine: active members are created at boot, and a member added later is created at their first session start.
- `team` group, gid 20000 (§5.5.3). The working copy `/workspace` is owned `root:team`, directories are setgid, mode is `g+rwX`, and every session runs with `umask 002`. Members and `agent` are in `team` and in no other supplementary group.
- No privilege (§5.5.2): the image has no `sudo`, no `su`, no setuid or setgid file, and no file with capabilities. The `root` SSH user that `packages/backend/internal/services/workspace_ssh.go:24-38` offers is deleted, and so is the `developer` default for members (`packages/backend/internal/services/workspace.go:33-37`).
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

## Changes

- `packages/backend/microsandbox/runtime.go:46-51` and `:585` `prepareGuest`: the coding host's user becomes `agent` 19999 (today's single guest user is uid 1500); create `team`; set `/workspace` ownership and setgid; create active member users through the guest helper.
- `packages/backend/microsandbox/guest/smithers-guest.py:369` `setup`: accept `USER UID GROUP`, add the user to `team` only, and set mode 0700 on the home. `drop_to` (`:93`) sets supplementary groups to `[team]` instead of `[]`, and `run_exec` applies `umask 002`.
- `packages/backend/microsandbox/layers.go`: the base layer has no `openssh-server`, removes `sudo` and `login`'s `su`, strips setuid and setgid bits with `find / -xdev -perm /6000 -type f -exec chmod ug-s {} +`, and strips file capabilities with `setcap -r` on every file `getcap -r /` lists. The guest user and uid go into the layer key so layers rebuild once.
- Homes: the guest helper's `setup` (below) creates `/home/<login>` at first session; `runtime.go` `machineFlags` (`:544`) adds no home mount. The machine record keeps no boot set of members.
- `packages/backend/internal/services/workspace_ssh.go:24-38` `workspaceRootSSHUser` and `resolveWorkspaceSSHUser`: delete the `root` option. Members resolve to their own login only.
- Uid and login allocation: the `members.unix_uid` sequence starting at 20000, and the sanitized login with its collision suffix, both written once in T-ACC-02's table.

## Tests
- Integration: C-MCH-10 uses independently created fixture tool logins on two real machines to prove persistence across sleep, wake and host restart, and no token copying.
- Acceptance: C-MCH-10 gates this ticket’s S2 phase; C-REL-05 is T-REL-02’s live release soak.

- integration (reference host, real microVM, `packages/backend/microsandbox/real_users_test.go`, new): `command -v sudo su` finds nothing; `find / -xdev -perm /6000 -type f` and `getcap -r /` are empty; `id agent` shows groups `agent team`; as `agent` and as another member, reading `/home/<login>` returns `EACCES`; Ben creates a file in `/workspace`, and Alice and `agent` can modify it. This is C-MCH-06.
- integration (reference host, real microVM): Ben and Alice each have `/home/<login>` with their own uid, gid and 0700. As Alice and as `agent`, reading any file in Ben's home returns `EACCES`. `mount` lists no virtiofs mount under `/home`. (C-MCH-09)
- integration: Ben writes `~/.marker` on branch A. Branch B never sees it. After A sleeps and wakes, it is still there with Ben's uid and 0700. (C-MCH-09)
- integration: Carol is added while branch A is awake. Her first terminal on A opens in `/home/carol` with her uid and 0700, with no restart. (C-MCH-09)
- unit: logins `Ben-Smith` and `ben_smith` sanitize to `ben-smith` and `ben_smith`; two logins that share their first 32 characters get `…` and `…2`, and the suffix never changes after assignment.
- unit (`packages/backend/microsandbox/parameters_unit_test.go`): uid 19999, gid 20000, and no `--mount-dir` for homes.
- unit (`packages/backend/internal/services/workspace_ssh_test.go`): `root` is refused with `CodeWorkspaceSSHUserInvalid`.

## Acceptance
- [C-COL-04](../checks/C-COL-04.md): the daemon runs unprivileged beside the root broker.


- [C-MCH-06](../checks/C-MCH-06.md): no sudo or setuid; homes are 0700; `agent` and other members can't read a home.
- [C-MCH-09](../checks/C-MCH-09.md): homes are per machine, created at first session, never shared, kept across sleep.
- [C-MCH-10](../checks/C-MCH-10.md): Tool logins persist per machine across sleep and wake; Smithers never stores or copies tokens between machines

## Risks and notes

- jj and git in a working copy shared by several uids fail on lock files or `safe.directory`. Confirmed by alternating `jj st`, `git status` and `pnpm install` as Ben, Alice and `agent` (research/collab-terminals-wiki.md risks). Fix with `safe.directory=/workspace` in the system gitconfig and setgid directories. Measure before claiming.
- Login sanitization can collide: GitHub logins run to 39 characters, so two that share their first 32 truncate to the same login. The suffix rule (§5.5.2) keeps the result within 32 characters by truncating before the suffix.
- Homes and their caches use the machine's root disk. A team that fills it with npm or cargo caches makes the next write fail with `ENOSPC`. Confirmed by `df /` in a machine after a full dependency install by two members. Escalate before raising the root-disk size, which §8.2.1 derives from the host.
- Layer caches built for uid 1500 hold files owned by 1500. Confirmed by `find / -uid 1500` in a new VM. The layer-key change forces a rebuild of every layer once, which costs one prepare run per recipe on upgrade.
