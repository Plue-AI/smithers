# T-TRM-01 Terminals run as their owner; only the owner types

Stage S2 · Size S · Depends on T-MCH-11, T-COL-03, T-TRM-07 · Unblocks T-TRM-02, T-TRM-05, T-APP-12 · Issue: to file
Spec: spec.md §2 (Terminal), §3 (`terminals`), §7.1, §7.5, §8.11, §8.4.1, §9.1.2 (`open_session`), §5.6 · Delta: delta.md §3 (per-member users row), §5 (terminal sessions row) · Product: mvp.md J3.3, J6.5, §6.8 Terminals, M-18

## Goal

A member's terminal runs as that member's unix user in the working copy and streams on the live channel, any member on the branch can watch it, and keystrokes from anyone but the owner never reach the shell.

## Scope

In:
- `POST /api/terminals open{branch}` makes a `person` admission request (T-MCH-06). Once the machine is awake, the host's terminal manager calls `smithers-machined` `open_session(member, pty)` (§9.1.2, §9.6, built by T-TRM-07). The broker starts the PTY as the owner's uid, in a new session cgroup, in `/workspace`, with `umask 002` and the T-TRM-02 sign-in (§8.11.1). Machines run no sshd.
- Live-channel transport (§7.5): a terminal subscription on `/api/live` carries binary kind 3 (output), 4 (input) and 5 (control: resize, exit). The per-session terminal WebSocket is deleted in the same change.
- Owner-only input: kind 4 frames from any subscriber who isn't the owner are dropped and counted (`smithers_terminal_input_dropped_total`, §7.5). Resize from watchers is ignored.
- Watchers: any member allowed `branch.join` (T-ACC-03) subscribes read-only and gets the 512 KiB ring replay (§8.11.3). Backpressure drops a terminal to ring replay (§7.1.1).
- `terminals` rows (§3): `branch_id`, `owner_id`, `title`, `opened_at`, `closed_at`. Open and close publish to `branch:<id>` `terminals[]`. An open terminal blocks safe-idle (§8.4.1).
- Removal or suspension of the owner closes their terminals within 5 s, and a watcher's removal detaches them (§5.6, `TerminalSessionManager.RevokeMatching`).
- The token file moves to `/run/smithers/<uid>/token` (T-TRM-02's required stage-2 move).

Out:
- [D] **Ask to type**, Allow and revoke (spec §0, §8.11.2). No `ask`, `allow` or `revoke` frame and no `canType` grant for non-owners. The mock's `Terminal.asks` (`.specs/design/mock/src/world.ts`) is not built.
- [D] The command name on activity entries (§9.3.6).
- The Terminal card UI (T-APP-12). The SSH gateway (T-TRM-03). The coding agent's terminal (T-TRM-05).

## Changes

- `packages/backend/internal/routes/terminal_session_manager.go:755` `terminalSink`: add the attaching `actor` and `owner bool`. `terminalSession.writeStdin` (`:570`) takes the sink and drops non-owner input with a counter, so the rule lives in one place.
- `packages/backend/internal/routes/live.go` (T-COL-02): route binary kinds 3–5 to the terminal manager by subscription id.
- `packages/backend/internal/services/workspace_runtime.go:1084` `OpenWorkspaceTerminal` and `packages/backend/microsandbox/exec.go:597-627` (`msb exec -t` as the guest's single user, uid 1500): replaced by the daemon session as the owner. Delete the runtime terminal backend (`workspace_terminal.go:407-427`, `newRuntimeTerminalBackend`) and the non-durable `pipeWSToSSH` path (`workspace_terminal.go:659`).
- Delete the terminal WebSocket route (`internal/compose/router.go:818`) and the terminal kind of the Bun `/api/cloud-ws/` bridge (`apps/app/src/bun/server.ts:191`, `server.test.ts:139-146`, `CloudWsTunnel.test.ts`). The language-server kind stays.
- `apps/app/src/mainview/state/CloudTerminalClient.ts`: rewrite over `runtime/LiveChannel.ts` (T-APP-08); delete the socket-per-session code.
- `packages/backend/db/product/migrations/0107_terminals.sql` (new; number at landing): the `terminals` table. Terminal-kind `workspace_sessions` rows for branch machines are no longer written.
- `docs/api/openapi/branches.yaml`: `POST /api/terminals`; remove the terminal WebSocket path; rebundle and regenerate clients.

## Tests

- unit (`terminal_session_manager_test.go`): with two sinks, owner and watcher, the watcher's 1,000 input frames produce 0 bytes on stdin and a counter of 1,000; the owner's frames all arrive in order; watcher resize is ignored.
- unit (`CloudTerminalClient.test.ts`, rewritten): kind 3/4/5 framing, queued input before subscribe, ring replay on resubscribe.
- integration (reference host, real microVM, `terminal_owner_integration_test.go`, new): `id -un` prints the owner's login, `$HOME` is `/home/<login>`, `pwd` is `/workspace`, `umask` is `0002`; a watcher's forged kind-4 frame doesn't create a file in the shell's cwd.
- integration: removing the owner closes the PTY within 5 s; removing a watcher detaches only that subscription.
- e2e: C-J3-02.

## Acceptance

- [C-J3-02](../checks/C-J3-02.md): own terminal as own user; others watch read-only; their keystrokes are dropped.

## Risks and notes

- Risk: the daemon hop adds keystroke echo latency. Falsified if p95 echo through `open_session` exceeds today's `msb exec -t` path by more than 50 ms on the reference host.
- Session lifecycle (exit, resize, close, kill, reconnect within 30 s, end on daemon restart) is T-TRM-07's protocol (§9.6). This ticket maps the terminal manager onto it: kind 5 resize → `resize`, the shell's `exit` → kind 5 exit, Close → `close_session`, removal → `kill_sessions`.
- Spec gap: `terminals.shared` (§3) has no meaning in §8.11, where any member may always watch. This ticket omits the column (owner: tech lead).
