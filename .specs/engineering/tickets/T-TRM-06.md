# T-TRM-06 Spike: daemon sessions carry VS Code Remote; revocation in 5 s

Stage W0 · Size M · Depends on — · Unblocks T-COL-03a, T-TRM-07 · Issue: [#3554](https://github.com/smithersai/smithers/issues/3554)
Spec: spec.md §5.6, §8.10.3, §8.11, §9.5.3, §9.6 · Delta: delta.md §5 (session supervisor row) · Product: mvp.md §6.15 SSH into a branch, §6.8 Terminals, J3.2, J3.3, M-18, M-24, M-29

## Goal

Before the stage-2 daemon chain starts, answer with a recording and numbers: does the §9.6 session protocol, run by a root supervisor in a microVM with no sshd, carry a real VS Code Remote-SSH session (connect, edit, save, terminal, port forward, reconnect), and does revoking the member end every one of their processes within 5 s?

## Scope

In:
- A disposable, one-command prototype (`scripts/spikes/trm-06/run.sh`):
  - a Rust session supervisor in the guest: `pty`, `exec`, `sftp` and `tcp` sessions, each in its own cgroup under one parent, started as uid 20001 (`ben`) with `umask 002`; the §9.6.2 frames (`data`, `eof`, `resize`, `signal`, `exit`, `window`, `close`); `close_session` and `kill_sessions` with `cgroup.kill` confirmed by `populated 0`; a kill of every session cgroup when the supervisor exits;
  - a Go gateway prototype on the host that maps SSH channels and requests onto those frames (`exit-status`, `exit-signal`, `window-change`, `signal`, EOF, window adjust, `direct-tcpip`), over the existing relay (`packages/backend/microsandbox/transport.go:67`, `DialWorkspacePort`) or bridge (`:126`).
- The guest helper's `cgroup_kill` (`packages/backend/microsandbox/guest/smithers-guest.py:56-85`) and `drop_to` (`:93`) are the reference behavior; the prototype ports them.
- A one-page result in T-TRM-07: the frame set as built, every measured number, and any frame or rule §9.6 lacks.

Out:
- Product code. T-TRM-07 rebuilds only the validated decisions.
- Admission, branch-name usernames and key import (T-TRM-03, T-TRM-04); attribution (T-COL-04); the broker's privilege split (T-COL-03).

## Changes

- `scripts/spikes/trm-06/` (new): `run.sh`, `supervisor/` (Rust), `gateway/` (Go), `revoke.sh`, `flow.sh`. No change to `packages/`, `apps/` or `crates/`. Delete the directory when T-TRM-07 records the result; the evidence keeps the raw samples.

## Tests

- spike: C-SPK-08, every step, on the reference host with VS Code on a second Mac.

## Acceptance

- [C-SPK-08](../checks/C-SPK-08.md): VS Code Remote works end to end over the prototype; revocation leaves no member process within 5 s in 10 of 10 runs; flow control loses no byte and bounds memory; a supervisor restart leaves no orphan.

## Risks and notes

- VS Code starts its server in the background from an exec channel and later reaches it through `direct-tcpip`. If the server dies when that channel closes, §9.6.3's lingering rule is wrong. Confirmed by step 6 of C-SPK-08.
- A process in uninterruptible sleep delays `cgroup.kill`. Confirmed if any revocation run exceeds 5 s; then record which process and state.
- Decisions this spike must not make alone: running an sshd per member (contradicts §8.10.3 and M-29), or dropping the 5 s revocation. Escalate both to the tech lead with the numbers.
