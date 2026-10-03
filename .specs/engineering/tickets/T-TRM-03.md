# T-TRM-03 SSH gateway: branch usernames, member users, sftp, port forwarding

Stage S2 · Size L · Depends on T-MCH-06, T-MCH-11, T-INS-04, T-COL-03, T-TRM-07 · Unblocks T-APP-10, T-APP-11, T-COL-08, T-REL-02 · Issue: [#3575](https://github.com/smithersai/smithers/issues/3575)
Spec: spec.md §1.4, §8.10, §8.3 (person class), §8.4.1, §9.1.2 (`open_session`, `tcp_connect`), §9.6, §5.6, §16.3 · Delta: delta.md §5 (SSH server row) · Product: mvp.md J3.2, J3.4, J10.3, §6.15 SSH into a branch, Appendix A `/ssh`, M-24, M-28, M-29

## Goal

`ssh -p 2222 retry-webhooks@<install host>` lands a member as their own unix user in the branch's working copy, waking it under admission, and VS Code, Cursor and Zed remote editing and `-L` port forwarding work.

## Scope

In:
- Construct the SSH server (`packages/backend/ssh/ssh.go:61` `New`) in `apps/backend`. It listens on `127.0.0.1:2222` always, plus `<bind>:2222` when the owner sets a bind address in Settings or with `smthrs host start --bind <addr>`, the same rule the HTTP listener follows (§1.4, T-INS-04). The product runs no network tool of its own; reaching port 2222 from another machine is the owner's network setup, described in the docs.
- Username = branch name or slug (§8.10.1): `retry-webhooks` resolves `smithers/retry-webhooks`, then `scratch/*/retry-webhooks`. Ambiguity fails with the candidate list on stderr.
- Composition-specific logins (§8.10.1): the install composition accepts branch-name usernames only. Plue's composition keeps its `<sandbox>+<user>` grant login and doesn't accept branch names. One server, two parsers, chosen at composition.
- Authentication: the public key must belong to a member (keys from T-ACC-02 and `smthrs ssh-key`). Deploy keys are refused for shells (`packages/backend/internal/ssh/server.go:387-395`). Suspended or removed members are refused.
- The gateway makes a `person` admission request (T-MCH-06). While waiting, it writes "waiting for a machine #n" to stderr and keeps the connection alive.
- Channels map onto `smithers-machined` session primitives (§8.10.3, §9.1.2); machines run no sshd:
  - shell and exec become `open_session(member, pty|exec)` as the member's uid in a new session cgroup, in `/workspace`;
  - `subsystem sftp` becomes `open_session(member, sftp)`, running `sftp-server` as the member;
  - `direct-tcpip` becomes `tcp_connect(port)` to guest loopback;
  - channel requests and messages map one to one onto the session protocol (§9.6.2): `exit-status` and `exit-signal` from `exit`, `window-change` to `resize`, `signal` to `signal`, channel EOF to and from `eof`, and window adjust to `window` credit. Closing the channel sends `close_session`; processes left running keep running (§9.6.3).
- SSH agent forwarding is refused (§8.10.3: not supported in the MVP).
- An open SSH session blocks safe-idle (§8.4.1). Member removal closes their sessions within 5 s (§5.6; `packages/backend/internal/ssh/revocation.go`).
- Each session reports `{actor: {person, via: "ssh", session}}` and its session cgroup so presence and attribution can use it (§8.10.4).
- `/ssh <branch>` returns `ssh -p 2222 <branch>@<host>`, where `<host>` is the host name of the install's first public origin, or `localhost` when none is set; `smthrs ssh <branch>` runs it (§8.10.5).
- A stable host key at `$STATE/ssh/` (`ssh.host_key_dir`).

Out:
- Presence rendering and attribution of saves (T-COL-06, T-COL-04). The Branch card SSH line (T-APP-10).
- GitHub key import (T-ACC-02).
- [D] mDNS names, a LAN CA and `smthrs connect`: never built.
- Remote port forwarding (`tcpip-forward`), which §8.10.3 doesn't list.

## Changes

- `apps/backend/main.go`: compose `ssh.New` with the product database, a repository transport and admission, and start it beside the HTTP server with clean shutdown (`apps/backend/shutdown_test.go`).
- `packages/backend/internal/config/config.go:506`: the default `ssh.addr` changes from `:2222` (all interfaces) to `127.0.0.1:2222`. The launcher passes the owner's bind address (T-INS-02 env allowlist), and the server adds a second listener on `<bind>:2222`, so SSH and HTTP always listen on the same addresses.
- `packages/backend/internal/ssh/workspace_access.go:34-62`: split login parsing behind one interface. The install composition (`apps/backend`) registers the branch-username parser; Plue keeps the `<sandbox>+<user>` parser (`:49-62`, `services/workspace_ssh.go:18-75`) unchanged.
- `packages/backend/internal/ssh/server.go:183-191`: add a `direct-tcpip` channel handler that forwards to guest `127.0.0.1:<port>` only, and refuse `auth-agent-req@openssh.com`.
- The `exec`, `sftp` and `tcp` session kinds come from T-TRM-07; this ticket only maps SSH channels onto them.
- `packages/backend/internal/services/branch_ssh_bridge.go` (new): a `WorkspaceBridge` (`workspace_access.go:29`) for the microVM runtime that maps each channel onto `open_session` or `tcp_connect` over the machine's host connection (§9.1.1). No member key enters the machine.
- `packages/rpc/src/catalog/` (T-CAT-01): the `/ssh` descriptor; `packages/smithers/src/cli/` `ssh` command.
- Docs: SSH section of the quickstart source (T-DOC-01 consumes it) in `packages/backend/docs/`; `pnpm docs:sync`, `pnpm docs:check`.

## Tests

- unit (`packages/backend/internal/ssh/workspace_access_test.go`): branch-name parsing and resolution order; an ambiguous slug lists its candidates; unsafe names are refused; the install parser refuses `<sandbox>+<user>`, and the Plue parser refuses a bare branch name.
- integration (`packages/backend/internal/ssh/workspace_session_test.go`, fake bridge): an unknown key, a deploy key, a suspended member and a removed member are refused; `direct-tcpip` to a non-loopback guest address is refused; an agent-forwarding request is refused; with no owner setting the only listener is `127.0.0.1:2222`, and with a bind address set the listeners are `127.0.0.1:2222` and `<bind>:2222`; changing the bind address applies without a restart (§16.3.1).
- integration (reference host, real microVM): `ssh … 'id -un; pwd'` prints the member's login and `/workspace`; sftp put and get round-trip; `-L 3000:localhost:3000` reaches a server in the machine; `pgrep sshd` in the guest finds nothing; SSH to an asleep branch wakes it through admission.
- integration: removing the member closes the session, and `kill_sessions` leaves no process of that member (`pgrep -u <login>` empty), within 5 s.
- integration (gateway with a real machine): `ssh … 'exit 7'` exits 7; `kill -TERM $$` arrives as `exit-signal TERM`; `ssh … 'wc -c' < 1 MiB` prints 1048576 (half-close); a 1 GiB download to a slow reader arrives complete.
- e2e: C-J3-06.

## Acceptance

- [C-J3-06](../checks/C-J3-06.md): SSH from another machine to the install host with GitHub keys; a VS Code Remote edit lands attributed; port forwarding works.

## Risks and notes

- VS Code Remote-SSH runs its server under `~/.vscode-server` and needs `direct-tcpip` to a guest loopback port. Confirmed by a recorded VS Code connect in C-J3-06. A missing piece shows as "Could not establish connection".
- An SSH client may time out while the request waits for a machine. Confirmed by C-J3-06 with capacity full. The stderr position line and keepalives (`StartKeepalive`, `packages/backend/ssh/ssh.go:122`) must keep it open.
- Binding a non-loopback address exposes the gateway to everyone on that network. Key authentication and the member check still apply, and `AuthLimiter` (20 attempts a minute) limits guessing. Confirmed by an unknown key from another host on the LAN being refused and audited.
