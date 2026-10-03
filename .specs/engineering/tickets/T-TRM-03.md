# T-TRM-03 SSH gateway: branch usernames, member users, sftp, port forwarding

Stage S2 · Size L · Depends on T-MCH-06, T-MCH-11, T-INS-04, T-COL-03, T-TRM-07, T-INS-02, T-ACC-02 (S1 roster/revocation and S2 keys), T-ACC-03, T-CAT-01 · Unblocks T-APP-10, T-APP-11, T-COL-08, T-REL-01, T-REL-02 · Issue: [#3575](https://github.com/smithersai/smithers/issues/3575)
Spec: spec.md §1.4, §8.10, §8.3 (person class), §8.4.1, §9.1.2 (`open_session`, `tcp_connect`), §9.5.1–§9.5.3, §9.6, §5.6, §16.3 · Delta: delta.md §5 (SSH server row) · Product: mvp.md J3.2, J3.4, J10.3, §6.15 SSH into a branch, Appendix A `/ssh`, M-24, M-28, M-29
Ready: 2026-10-03 smithers-8a sha256:aa6abdf74d9d

## Goal

`ssh -p 2222 retry-webhooks@<install host>` lands a member as their own unix user in the branch's working copy, waking it under admission, and VS Code, Cursor and Zed remote editing and `-L` port forwarding work.

## Scope

In:
- Land dark against the specified contracts of T-MCH-06, T-MCH-11, T-INS-04, T-COL-03, T-TRM-07, T-INS-02, T-ACC-02, T-ACC-03 and T-CAT-01. Until each required provider and its joint checks pass, refuse the affected SSH session or command before admission or execution. Missing roster, authorization, revocation, member identity, admission or authenticated daemon transport never falls back to a host process, guest sshd, root/developer login or Plue grant. Unavailable address configuration permits loopback only; unavailable catalog handlers refuse dispatch. T-COL-04 and T-COL-06 consume session attribution later; their absence blocks C-J3-06 step 5, not dark landing. Test: TestSSHUnavailableProvidersFailClosed under C-J3-06.
- Construct the SSH server (`packages/backend/ssh/ssh.go:63` `New`) in `apps/backend`. It listens on `127.0.0.1:2222` always, plus `<bind>:2222` when the owner sets a bind address in Settings or with `smthrs host start --bind <addr>`, the same rule the HTTP listener follows (§1.4, T-INS-04). The product runs no network tool of its own; reaching port 2222 from another machine is the owner's network setup, described in the docs.
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
- Remote port forwarding (`tcpip-forward`), SSH agent forwarding, X11 forwarding, guest sshd, root/developer member logins, sudo, host execution of repository commands, a second SSH server or session supervisor, new database tables, key-sync implementation, and network/TLS provisioning. Preserve existing Git/LFS transport and Plue grant authentication.

## Changes

- `apps/backend/main.go`: compose `ssh.New` with the product database, a repository transport and admission, and start it beside the HTTP server with clean shutdown (`apps/backend/shutdown_test.go`).
- `packages/backend/internal/config/config.go:503`: the default `ssh.addr` changes from `:2222` (all interfaces) to `127.0.0.1:2222`. The launcher passes the owner's bind address (T-INS-02 env allowlist), and the server adds a second listener on `<bind>:2222`, so SSH and HTTP always listen on the same addresses.
- `packages/backend/internal/ssh/workspace_access.go:34-65` and `server.go:352,451`: reshape the existing public-key and password login dispatch behind one composition-selected parser. Branch logins authenticate by member public key only; the Plue grant/password path remains composition-specific. The install composition (`apps/backend`) registers the branch-username parser; Plue keeps the `<sandbox>+<user>` parser (`workspace_access.go:49-65`). Preserve Plue grant parsing; member identity and removal of root/developer member grants belong to T-MCH-11 (`packages/backend/internal/services/workspace_ssh.go:24-38`).
- `packages/backend/internal/ssh/server.go:183-191`: add a `direct-tcpip` channel handler that forwards to guest `127.0.0.1:<port>` only, and refuse `auth-agent-req@openssh.com`.
- The `exec`, `sftp` and `tcp` session kinds come from T-TRM-07; this ticket only maps SSH channels onto them.
- Reshape the existing `WorkspaceBridge` seam (`packages/backend/internal/ssh/workspace_access.go:29-32`, `server.go:600`) with `packages/backend/internal/services/branch_ssh_bridge.go` (new adapter): map each channel onto T-TRM-07's shared `open_session` or `tcp_connect` client over the authenticated machine connection (§9.1.1). The existing seam forwards a session to a private SSH server; it has no daemon-channel adapter. Add only that adapter and the channel hook; retain auth, audit, revocation, keepalives and session limits. No member key enters the machine, and no second supervisor is added.
- `packages/rpc/src/catalog/` (T-CAT-01): the `/ssh` descriptor; `packages/smithers/src/cli/` `ssh` command.
- Docs: SSH section of the quickstart source (T-DOC-01 consumes it) in `packages/backend/docs/`; `pnpm docs:sync`, `pnpm docs:check`.

## Tests

- unit (`packages/backend/internal/ssh/workspace_access_test.go`): branch-name parsing and resolution order; an ambiguous slug lists its candidates; unsafe names are refused; the install parser refuses `<sandbox>+<user>`, and the Plue parser refuses a bare branch name.
- unit/component (`packages/backend/internal/ssh/workspace_session_test.go`, recording bridge; supplemental channel-mapping coverage only): an unknown key, a deploy key, a suspended member and a removed member are refused; `direct-tcpip` to a non-loopback guest address is refused; an agent-forwarding request is refused; with no owner setting the only listener is `127.0.0.1:2222`, and with a bind address set the listeners are `127.0.0.1:2222` and `<bind>:2222`; changing the bind address applies without a restart (§16.3.1).
- integration (reference host, real microVM): `ssh … 'id -un; pwd'` prints the member's login and `/workspace`; sftp put and get round-trip; `-L 3000:localhost:3000` reaches a server in the machine; `pgrep sshd` in the guest finds nothing; SSH to an asleep branch wakes it through admission.
- integration: removing the member closes the session, and `kill_sessions` leaves no process of that member (`pgrep -u <login>` empty), within 5 s.
- integration (gateway with a real machine): `ssh … 'exit 7'` exits 7; `kill -TERM $$` arrives as `exit-signal TERM`; `ssh … 'wc -c' < 1 MiB` prints 1048576 (half-close); a 1 GiB download to a slow reader arrives complete.
- C-J3-06 integration through `ssh.New` composed by the install, real PostgreSQL and a reference-host microVM: `TestSSHUnavailableProvidersFailClosed` omits each provider named in Scope and proves refusal before wake or process start; valid providers are the positive control. `TestSSHProductionAuthorizationAndForwarding` drives real SSH handshakes, shell/exec, sftp, direct-tcpip and global requests: unknown/deploy/withdrawn keys, suspended/removed members, legacy grant/password login, root selection, non-loopback destinations, invalid ports, agent/remote/X11 forwarding and revoked queued wakes are refused. Change bind through the production Settings address action and check actual listeners, without restart. No recording bridge supplies acceptance evidence.
- C-J3-06 `TestSSHRootInputsValidatedBeforeUse` drives the same gateway into the real broker on fresh and retained machines. Poison branch PATH, LD_PRELOAD, shell/sftp executable paths and cwd symlinks; send malformed argv/env, PTY sizes, signals, ports, flow-control credits and foreign session ids. Observe uid/gid/groups before payload use, no root canary or outside write, bounded frame handling and member-only execution with a valid positive control. Root/uid mismatch and cgroup escape refusals must retain T-TRM-07's C-COL-04 evidence.
- C-J3-06 command coverage: invoke `/ssh retry-webhooks` through the production catalog dispatcher and `makeCli().serve(argv)` for `smthrs ssh retry-webhooks`; pin the copied line and spawned executable/argv for a configured first origin and for localhost. Invalid branch/host input creates no shell execution. Reuse the T-CAT-01 command path, with argv spawning rather than shell interpolation.
- All expected logins, uids, listener addresses, argv, bytes, refusal cases and timing bounds are reviewed literal fixtures. Tests never read spec Markdown or derive expected policy from runtime implementation code.
- e2e: C-J3-06 through the served gateway, including the named integration cases above. Its VS Code manual step needs an owner-signed receipt bound to the tested commit; blocked attribution/presence is never recorded as passed.

## Acceptance

- [C-J3-06](../checks/C-J3-06.md): SSH from another machine to the install host with GitHub keys; a VS Code Remote edit lands attributed; port forwarding works.

## Risks and notes

- smithers-3f decides and accepts the Go parser, bridge, listener lifecycle, revocation and root-input validation seams; smithers-b8 accepts install composition and user-facing `/ssh` behavior; smithers-38 signs off the catalog/CLI TypeScript API. smithers-8a decides any spec or spike-contract change before implementation. This ticket introduces no ADR, UI view or new database table. Owners review the draft post hoc under Will's parallel-build directive; implementation still requires their pre-review before start.
- VS Code Remote-SSH runs its server under `~/.vscode-server` and needs `direct-tcpip` to a guest loopback port. Confirmed by a recorded VS Code connect in C-J3-06. A missing piece shows as "Could not establish connection".
- An SSH client may time out while the request waits for a machine. Confirmed by C-J3-06 with capacity full. The stderr position line and keepalives (`StartKeepalive`, `packages/backend/ssh/ssh.go:122`) must keep it open.
- Binding a non-loopback address exposes the gateway to everyone on that network. Key authentication and the member check still apply, and `AuthLimiter` (20 attempts a minute) limits guessing. Confirmed by an unknown key from another host on the LAN being refused and audited.

## Security and root inputs

- Repository commands, SSH shells, editor servers and sftp execute only inside the admitted microVM as the authenticated member, never on the host or as root (M-29; §9.5). smithers-3f reviews this boundary and C-J3-06 security receipts before activation.
- The host gateway runs without root. The only privileged consumer in this slice is T-TRM-07's existing guest broker, including session cgroup creation/signalling/kill and session startup. Trusted inputs: broker/interpreter/base shell/sftp executable bytes and their absolute paths from the installed bundle/image built from approved main; per-boot channel authority, roster-derived login/uid/team gid, session ownership and fixed cgroup root from authenticated host state, not branch fields. The broker verifies that authority and existing uid/login mapping before privileged operations. No branch-built executable, library, interpreter or helper runs as root.
- Branch/client inputs: branch username, exec command/argv, environment and terminal type, `/workspace` and home contents (including symlinks), stdin/sftp bytes, PTY dimensions, signal, destination/port, stream credit, close/session ids and disconnect events. Root consumes only a validated bounded control envelope: permitted kind, host-resolved identity, owned session id, fixed cgroup-relative target, permitted signal, numeric dimensions/credit and loopback port 1–65535. Resolve the branch to an authorized machine on the host; never treat its name as a guest login or filesystem path. Apply command/argv/env/cwd and process/sftp bytes only after dropping to the member uid/gid and team supplementary group. Use trusted absolute startup executables and discard loader/interpreter environment before the drop. Validate paths without following escaping symlinks; branch files cannot choose privileged executable or cgroup targets. Check: TestSSHRootInputsValidatedBeforeUse under C-J3-06; T-TRM-07's C-COL-04 proves broker identity confinement. Any branch-sourced root input without passing validation evidence blocks activation.

## Ready checklist

1. Dependencies: the header lists admission, member identities, launcher isolation, address configuration, roster/keys/revocation, authorization, daemon transport/session protocol and catalog contracts. Scope defines dark landing and refusal for each missing provider; downstream attribution/presence is explicitly deferred to its owners.
2. Exclusions: Out names guest sshd, privileged member logins, sudo, host repository execution, extra supervisors/tables, key sync, UI, network/TLS setup and unsupported forwarding.
3. Boundaries: C-J3-06 drives the composed SSH gateway, real machine, production Settings/catalog dispatcher and CLI parser; named integration tests use literal policy fixtures. Recording bridges are supplemental; VS Code needs a signed manual receipt.
4. Decisions: smithers-3f accepts Go/security seams, smithers-b8 install and command behavior, smithers-38 TypeScript APIs, and smithers-8a spec/spike changes. No ADR or table reservation is needed.
5. Owner pre-review before implementation: smithers-3f: Does branch auth reuse the existing key/member checks without Plue grant fallback? Does every privileged broker input validate before use and every payload execute after uid drop? Do queued revocation, forwarding and listener changes preserve existing limits? smithers-b8: Does install composition keep Chat and unrelated startup usable while SSH admission waits? Do `/ssh` and `smthrs ssh` use the shared catalog and correct first-origin host? smithers-38: Does the descriptor/CLI change preserve the public typed contract and spawn validated argv without a second command declaration? No UI view changes require smithers-06.
6. Security: the Security and root inputs inventory labels main/bundle, authenticated host state and branch/client sources; smithers-3f reviews M-29 confinement, root validation, no privileged branch execution and C-J3-06 receipts before activation.
