# T-TRM-07 Session supervisor: broker sessions, the §9.6 protocol, lingering processes, kill and restart rules

Stage S2 · Size M · Depends on T-COL-03, T-TRM-06, T-MCH-11 · Unblocks T-AGT-02, T-APP-11, T-COL-04, T-COL-05, T-INS-07, T-MCH-09, T-MCH-12, T-STK-08, T-TRM-01, T-TRM-03, T-TRM-05 · Issue: [#3578](https://github.com/smithersai/smithers/issues/3578)
Spec: spec.md §5.6, §8.4.1, §8.10.3, §8.11, §9.1.2 (`open_session`, `tcp_connect`, `close_session`, `kill_sessions`, `register_run`), §9.4.2, §9.5.1, §9.5.3, §9.6 · Delta: delta.md §5 (session supervisor row) · Product: mvp.md §6.8 Terminals, §6.15 SSH into a branch, J3.2, J3.3, M-18, M-24, M-29
Edited by the minimal-code synthesis, 2026-10-03: three terminal brokers become this one guest session broker.

## Goal

Every terminal, SSH channel, port connection and coding-host process on a machine is a session the `smithers-machined` broker starts as its user, with the §9.6 lifecycle: exit status, signals, resize, half-close and flow control end to end, and `kill_sessions` leaves no process of a revoked member within 5 s.

## Scope

In:
- Session kinds in the broker (§9.6.1): `pty`, `exec`, `sftp` (`sftp-server` as the user) and `tcp` (guest loopback only), each in its own cgroup under `/sys/fs/cgroup/smithers/sessions/`, as the user with groups `[team]`, `umask 002`, in `/workspace`, with the session environment (T-TRM-02 sign-in, `/run/smithers/env`).
- Identity checks (§9.5.3): only `agent` (19999) or a member uid of 20000 or more with a valid login; never root; a login whose uid differs from the one created on this machine is refused.
- The stream protocol (§9.6.2): `data`, `eof`, `resize`, `signal`, `exit`, `window` (256 KiB initial credit per direction) and `close`, carried on the daemon's host connection.
- Ending (§9.6.3): `close_session` (HUP to a pty's process group, or stdin closed); lingering processes stay in the session's cgroup, count for attribution, not for safe-idle; `kill_sessions(user | run)` with `cgroup.kill`, replying only after `populated 0`.
- Disconnects and restarts (§9.6.4): 30 s grace with re-attach by session id; the broker kills every session cgroup before restarting a daemon that exited.
- The agent-only local socket's `open_session(pty)` (§9.5.3): placed under the caller's registered run. `register_run(run_id, session)` from the host maps a session's cgroup to a run.
- The session registry the watcher reads (T-COL-04): session id, user, cgroup, run, kind.

Out:
- The terminal manager and live-channel terminals (T-TRM-01); the SSH gateway's channel mapping (T-TRM-03); the agent's `bash` terminal (T-TRM-05).
- [D] Ask to type.

## Changes

- `crates/smithers-machined/src/broker/sessions.rs` (new): spawn as user, cgroup placement, pty allocation, signals, kill and confirm. Port `cgroup_kill` (`packages/backend/microsandbox/guest/smithers-guest.py:56-85`) and `drop_to` (`:93`), with supplementary groups `[team]` instead of `[]`.
- `crates/smithers-machined/src/stream.rs` (new): the §9.6.2 frames and credit accounting on the host connection.
- `packages/backend/internal/machined/sessions.go` (new): the Go client for open, stream, close and kill, used by T-TRM-01's terminal manager and T-TRM-03's gateway bridge, and by revocation (§5.6).
- One guest session broker (minimal-code synthesis, 2026-10-03, v2 "layers with one user"): the terminal card (T-TRM-01), the SSH gateway (T-TRM-03) and the agent's `bash` (T-TRM-05) each planned their own process broker; all three open sessions only through this broker, and none spawns, signals or kills guest processes itself. Reuse the host `TerminalSessionManager` (`internal/routes/terminal_session_manager.go`: multi-attach, ring replay, per-sink eviction) unchanged as the fanout layer; its dialer moves from the runtime PTY adapter (`internal/routes/workspace_runtime_terminal.go`) to `machined/sessions.go`. Before writing Rust, compare a long-lived mode of `packages/backend/microsandbox/guest/smithers-guest.py` (exec, relay, `setup`, cgroup kill) against the new daemon and record the choice (design-twice, E-04).
- `packages/backend/docs/machined.md`: the session protocol; `docs:sync`, `docs:check`, `smthrs docs //packages/backend:docs`.

## Tests

- unit (`stream.rs`): frame codec round trips; a sender with zero credit reads nothing from its source; `eof` in each direction; `exit{code}` and `exit{signal, core}` encoding.
- integration, real cgroup v2 and users (`crates/smithers-machined/tests/sessions.rs`, new, Linux runner or microVM): `exit 7` gives `exit{7}`; `kill -TERM $$` gives `exit{signal: TERM}`; `wc -c` with 1 MiB of input and `eof` prints 1048576; 1 GiB of output to a stalled reader arrives complete with bounded broker memory; `resize` changes `stty size`; `signal{INT}` ends `sleep`; a `nohup` child lingers after `close_session` and dies at `kill_sessions` with `populated 0` before the reply; a daemon exit kills every session before the restart; a 10 s disconnect re-attaches with no lost byte.
- integration: C-COL-04's identity rows (root, wrong uid for a login, bad login) are refused.
- integration (reference host): removing a member with an open SSH session and a background process leaves `pgrep -u <login>` empty within 5 s.
- e2e: C-J3-06 (via T-TRM-03).

## Acceptance

- [C-J3-06](../checks/C-J3-06.md): exit status, half-close, VS Code Remote and removal within 5 s, through the gateway.
- [C-COL-04](../checks/C-COL-04.md): session identity rows.

## Risks and notes

- The protocol comes from T-TRM-06's measured result. A frame or rule the spike added goes into §9.6 before this ticket lands; one it dropped needs the tech lead.
- Lingering processes keep running until a sleep or revocation. A forgotten dev server keeps using memory but never blocks safe-idle (§8.4.1). Confirmed by a `nohup` server surviving `close_session` and dying at sleep.
