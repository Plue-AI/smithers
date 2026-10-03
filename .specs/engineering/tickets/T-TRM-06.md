# T-TRM-06 Spike: daemon sessions carry VS Code Remote; revocation in 5 s

Stage W0 · Size M · Depends on — · Unblocks T-COL-03a, T-TRM-07 · Issue: [#3554](https://github.com/smithersai/smithers/issues/3554)
Spec: spec.md §5.6, §8.10.3, §8.11, §9.5.3, §9.6 · Delta: delta.md §5 (session supervisor row) · Product: mvp.md §6.15 SSH into a branch, §6.8 Terminals, J3.2, J3.3, M-18, M-24, M-29
Ready: 2026-10-02 smithers-8a sha256:83b2d4141366

## Goal

Before the stage-2 daemon chain starts, answer with a recording and numbers: does the §9.6 session protocol, run by a root supervisor in a microVM with no sshd, carry a real VS Code Remote-SSH session (connect, edit, save, terminal, port forward, reconnect), and does revoking the member end every one of their processes within 5 s?

## Scope

In:
- A disposable, one-command prototype (`scripts/spikes/trm-06/run.sh`):
  - a Rust session supervisor in the guest: `pty`, `exec`, `sftp` and `tcp` sessions, each in its own cgroup under one parent, started as uid 20001 (`ben`) with `umask 002`; the §9.6.2 frames (`data`, `eof`, `resize`, `signal`, `exit`, `window`, `close`); `close_session` and `kill_sessions` with `cgroup.kill` confirmed by `populated 0`; on start, before accepting `open_session`, write `1` to `cgroup.kill` for every child of `/sys/fs/cgroup/smithers/sessions/` and wait for each child to report `populated 0`; refuse admission if emptiness cannot be confirmed;
  - a Go gateway prototype on the host that maps SSH channels and requests onto those frames (`exit-status`, `exit-signal`, `window-change`, `signal`, EOF, window adjust, `direct-tcpip`), over the existing relay (`packages/backend/microsandbox/transport.go:67`, `DialWorkspacePort`) or bridge (`:126`).
- The guest helper's `cgroup_kill` (`packages/backend/microsandbox/guest/smithers-guest.py:62-96`) and `drop_to` (`:99-106`) are implementation references, not test oracles. Do not shell out to the helper's cgroup_kill. Implement startup cleanup in the Rust supervisor. The helper waits up to 10 s; the prototype must independently prove the 5 s revocation bound, uid/gid dropping and no-orphan restart rule. Check: C-SPK-08.
- A one-page result in T-TRM-07: the frame set as built, every measured number, and any frame or rule §9.6 lacks.

Out:
- Product code. T-TRM-07 rebuilds only the validated decisions.
- Admission, branch-name usernames and key import (T-TRM-03, T-TRM-04); attribution (T-COL-04); the broker's privilege split (T-COL-03).
- Guest sshd, SSH agent forwarding, remote forwarding (`tcpip-forward`), Cursor/Zed certification and any weakening of revocation or isolation.

## Changes

- Implement the §9.6.4 startup barrier in the Rust supervisor: before accepting open_session, cgroup.kill every child of `/sys/fs/cgroup/smithers/sessions/` and wait for populated 0. Cleanup must work after SIGKILL, when no exit handler runs. Do not shell out to smithers-guest.py cgroup_kill. Check: C-SPK-08.

- `scripts/spikes/trm-06/` (new): `run.sh`, `supervisor/` (Rust), `gateway/` (Go), `revoke.sh`, `flow.sh`. No change to `packages/`, `apps/` or `crates/`. Delete the directory when T-TRM-07 records the result; the evidence keeps the raw samples.

## Tests

- C-SPK-08 step 8 sends SIGKILL to a supervisor with live foreground and background sessions. Init restarts it. Independently observe every old session cgroup reach populated 0 before the first accepted open_session. Preserve the existing 2 s no-orphan bound and automatic VS Code reconnect assertion. A cleanup failure refuses session admission.

- spike: C-SPK-08, every step, on the reference host with VS Code on a second Mac. Invoke `scripts/spikes/trm-06/run.sh` and the gateway's SSH listener with real OpenSSH and VS Code; session frames must traverse `DialWorkspacePort` or `startBridges`, not a direct supervisor test shim. The revocation driver calls the prototype's host revocation operation, which sends `kill_sessions(ben)`; observe disconnect and guest cgroup emptiness independently.
- Pin expected exit 7, TERM, byte counts, sequence order, fixture content, 5 s revocation and RSS bound in the test harness. No expectation reads spec files, helper timeout constants or the prototype's runtime values. Reject SSH agent forwarding and `tcpip-forward` at the gateway. C-SPK-08 retains raw samples and recording even on NO.

## Acceptance

- [C-SPK-08](../checks/C-SPK-08.md): VS Code Remote works end to end over the prototype; revocation leaves no member process within 5 s in 10 of 10 runs; flow control loses no byte and bounds memory; a supervisor restart leaves no orphan.

## Risks and notes

- VS Code starts its server in the background from an exec channel and later reaches it through `direct-tcpip`. If the server dies when that channel closes, §9.6.3's lingering rule is wrong. Confirmed by step 6 of C-SPK-08.
- A process in uninterruptible sleep delays `cgroup.kill`. Confirmed if any revocation run exceeds 5 s; then record which process and state.
- Decisions this spike must not make alone: running an sshd per member (contradicts §8.10.3 and M-29), or dropping the 5 s revocation. smithers-8a accepts the spike report and protocol amendments; Will decides any product change. Neither owner may silently treat sshd or relaxed revocation as a passing result.

## Ready checklist

1. Dependencies: standalone W0 prototype uses existing `msb` 0.6.16, `DefaultImage`, transport and guest helper plus a second Mac with OpenSSH/VS Code. It does not require the later daemon, member-user or SSH-gateway tickets; synthetic users are prototype setup.
2. Exclusions: product implementation, admission, key import, attribution, privilege-split implementation, sshd, agent/remote forwarding and other-editor certification are explicit.
3. Boundary tests: C-SPK-08 enters the prototype gateway through OpenSSH/VS Code and the real transport; its host revocation operation exercises kill_sessions. Literal fixtures and independently observed cgroups, bytes and time bounds supply the oracle, never spec files or implementation constants.
4. Decisions: smithers-8a accepts evidence and frame amendments; Will decides product changes to sshd, isolation or the 5 s rule. smithers-3f accepts the gateway/supervisor security seam before a rerun.
5. Owner pre-review: smithers-3f: answered, BLOCKING edits applied (tech lead adopts). Startup kills and drains all old session cgroups before open_session, including after SIGKILL; C-SPK-08 step 8 proves that barrier. The helper is reference only and is never invoked for cgroup cleanup.
6. Security: smithers-3f reviews machine-only execution, uid/gid dropping, cgroup ownership and fixed host routing before start. VS Code's server, shells, exec, sftp and probe payloads run only in disposable machines. The host gateway only authenticates and forwards; no member/agent sudo, provider keys or production credentials enter the prototype. C-SPK-08 proves revocation and orphan cleanup.
