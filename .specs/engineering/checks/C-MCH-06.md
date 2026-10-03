# C-MCH-06 No sudo or setuid; homes 0700; `agent` and other members can't read a home

Proves: mvp.md M-18, M-29, J6.5, §6.8 Terminals, §9 Isolation · spec.md §5.5.1–§5.5.4, §8.7, §8.10.3, §8.11.1, §5.3.2 · Layer: integration · Stage: S2 · Tickets: T-MCH-11
Automation: `packages/backend/microsandbox/real_users_test.go` (new) · Runs in: reference host (real microVM, `SMITHERS_MICROSANDBOX_BIN` set)

## Setup

- The reference host with `main` at the commit under test and `msb` 0.6.16. Layers rebuilt with the T-MCH-11 base layer.
- Members Ben (uid 20001) and Alice (uid 20002), both with a terminal open on branch A through the product path (T-TRM-01), and the coding agent running a step on A as `agent`.
- Ben has `~/.config/gh/hosts.yml` and `/run/smithers/20001/token` in place.
- Branch B exists for TODO T3, asleep.

## Steps

1. As root through the guest helper: `command -v sudo su`, `find / -xdev -perm /6000 -type f`, `getcap -r / 2>/dev/null`, and `getent group sudo wheel adm docker disk`.
2. `id ben`, `id alice`, `id agent`. `stat -c '%U:%G %a' /home/ben /home/alice /workspace`.
3. As `alice` and as `agent`: `ls /home/ben`, `cat /home/ben/.config/gh/hosts.yml`, `cat /run/smithers/20001/token`.
4. As `ben`: read the same three paths.
5. As `ben`: `touch /workspace/b.txt`. As `alice`: append to it. As `agent`: append to it. `stat` it.
6. As `ben` and `alice`: run `jj st` and `git status` in `/workspace`, alternately, 10 times each.
7. Ask the daemon's session primitive (`open_session`, §9.1.2) for a session as `root`. Connect through the SSH gateway with a key that belongs to no member. In Ben's SSH session, run `id -u`.
8. Ben writes `~/.marker` and a fixture `~/.config/gh/hosts.yml` on A. Ben opens a terminal on B (wakes it), inspects the home, and checks that both files are absent before logging in on B.

## Pass when

- Step 1: `sudo` and `su` are absent; `find` and `getcap` print nothing; no member or `agent` belongs to any listed group.
- Step 2: groups are exactly `{own, team}` for members and `{agent, team}` for `agent`; `agent` is uid 19999; homes are `<owner>:<owner> 700`; `/workspace` is `root:team` with setgid on directories.
- Step 3: every read fails with `EACCES` (permission denied) for both.
- Step 4: all three reads succeed.
- Step 5: all three appends succeed, and the file's group is `team` with mode `664`.
- Step 6: 0 permission or `safe.directory` errors.
- Step 7: the root session and the unknown key are refused; Ben's session reports 20001. No `sshd` process runs in the guest (§8.10.3).
- Step 8: B has its own `/home/ben`, owned by Ben, mode 0700. Neither A's marker nor A's login file exists on B. Shared homes or copied tokens fail (C-MCH-10).

## Fail when

- Any setuid, setgid or file-capability binary remains (for example `/bin/su`, `newuidmap`).
- A member can read another member's token file or home, or `agent` can.
- A member file in `/workspace` is created `0644` or with the member's own group, which breaks the next writer.
- jj or git refuses with "dubious ownership" for the second user.

## Evidence

`.artifacts/checks/C-MCH-06/<UTC timestamp>/`: `go test -json` output, the transcript of each command with uid, exit code and output, the `stat` table, the layer key, the commit and the `msb` version.
