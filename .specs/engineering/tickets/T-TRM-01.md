# T-TRM-01 Terminals run as their owner; only the owner types

Stage S2 · Size S · Depends on T-MCH-11, T-COL-03, T-TRM-07, T-MCH-06, T-ACC-03, T-ACC-02, T-COL-02, T-INS-02 · Unblocks T-AGT-02, T-APP-12, T-REL-01, T-TRM-02, T-TRM-05 · Issue: [#3574](https://github.com/smithersai/smithers/issues/3574)
Spec: spec.md §2 (Terminal), §3 (`terminals`), §7.1, §7.5, §8.11, §8.4.1, §9.1.2 (`open_session`), §5.6 · Delta: delta.md §3 (per-member users row), §5 (terminal sessions row) · Product: mvp.md J3.3, J6.5, §6.8 Terminals, M-18
Ready: 2026-10-03 smithers-8a sha256:beaabacec93c

## Goal

A member's terminal runs as that member's unix user in the working copy and streams on the live channel, any member on the branch can watch it, and keystrokes from anyone but the owner never reach the shell.

## Scope

In:
- `POST /api/terminals open{branch}` makes a `person` admission request (T-MCH-06). Once the machine is awake, the host's terminal manager calls `smithers-machined` `open_session(member, pty)` (§9.1.2, §9.6, built by T-TRM-07). The broker starts the PTY as the owner's uid, in a new session cgroup, in `/workspace`, with `umask 002` and the T-TRM-02 sign-in (§8.11.1). Machines run no sshd.
- Reuse the existing terminal WebSocket (§7.5), binary stdin/stdout and text control frames. Keep terminal streams off `/api/live`; use T-COL-02 only for Branch card projections. Check: C-J3-02.
- Owner-only input: binary input from any attachment whose authenticated member is not the owner is dropped and counted (`smithers_terminal_input_dropped_total`, §7.5). Ignore watcher resize and close requests. Resolve owner and viewer from server state, never client fields. Check: C-J3-02.
- Watchers: any member allowed `branch.join` (T-ACC-03) attaches read-only and gets the existing 512 KiB ring replay (§8.11.3). Keep per-sink eviction and reconnect replay. Check: C-J3-02.
- Reuse the in-process terminal manager (§3) for branch, owner, title and lifecycle facts. Open and close publish to `branch:<id>` `terminals[]`. An open terminal blocks safe-idle (§8.4.1). Check: C-J3-02.
- Removal or suspension of the owner closes their terminals within 5 s, and a watcher's removal detaches them (§5.6, `TerminalSessionManager.RevokeMatching`).
- Reshape T-TRM-02's S1 sign-in integration for the owner uid: delegated files live at `/run/smithers/<uid>/token/sessions/<session id>/token`, with a 0700 member directory and 0600 files. Preserve exact session/credential binding and host-only person bearers (§5.3.2, adopted T-TRM-02 owner ruling). T-TRM-02 owns CLI resolution and S2 catalog/confirmation integration; this ticket does not depend on its S2 phase. Check: C-SEC-05.
- Land dark against every unavailable dependency above: refuse open, attach and input without T-INS-02 isolation, T-MCH-06 admission, T-MCH-11 identities, T-COL-03 authenticated machine connection, T-TRM-07 sessions, T-ACC-03 authorization, T-ACC-02 revocation or T-TRM-02 S1 sign-in. Suppress terminal projection until T-COL-02 is available. No host execution, shared-user or SSH fallback remains at S2 cutover. Test each absent provider through the production routes before enabling S2. Checks: C-J3-02, C-COL-04, C-SEC-05.

- Lands dark until T-TRM-02 (rule 3; automatic cycle cut 2026-10-03): build against its spec'd contract; the dependent path refuses with a typed error until T-TRM-02 lands.
Out:
- [D] **Ask to type**, Allow and revoke (spec §0, §8.11.2). No `ask`, `allow` or `revoke` frame and no `canType` grant for non-owners. The mock's `Terminal.asks` (`.specs/design/mock/src/world.ts`) is not built.
- [D] The command name on activity entries (§9.3.6).
- The Terminal card UI (T-APP-12). The SSH gateway (T-TRM-03). The coding agent's terminal (T-TRM-05).
- A new terminal table, replay buffer, process broker or terminal protocol; `/api/live` terminal multiplexing; toolchain/image changes; secret delivery (T-MCH-12); credential syncing; external-agent transcript import; public CLI/library API changes. Consume the existing contracts only.

## Changes

- Reuse `packages/backend/internal/routes/terminal_session_manager.go:93` startup, viewer fanout, 512 KiB ring and eviction. At `:755` bind each `terminalSink` to its authenticated principal; at `:570` pass the sink to `writeStdin`. Apply the same owner gate to resize and close. Extend `RevokeMatching` (`:836`) to detach revoked watchers without killing another member's session.
- Reshape `packages/backend/internal/routes/workspace_terminal.go:174` `TerminalWebSocket` and `:689` `pipeWSToTerminalSession` to authorize owner/watch attachments through T-ACC-03. Replace only the runtime dialer at `:402` with T-TRM-07's `packages/backend/internal/machined/sessions.go` contract. Delete unused `pipeWSToSSH` (`:640`) and the runtime PTY adapter `packages/backend/internal/routes/workspace_runtime_terminal.go:28` at cutover.
- Replace the S2 terminal call from `packages/backend/internal/services/workspace_runtime.go:1094` `OpenWorkspaceTerminal` to `packages/backend/microsandbox/exec.go:599` with the daemon session as the owner. Remove the old terminal backend once its callers move. Keep one guest process broker, owned by T-TRM-07.
- Keep the terminal WebSocket registration at `packages/backend/internal/compose/router.go:825`. Reuse `apps/app/src/mainview/state/CloudTerminalClient.ts:1` and its tests for per-session sockets, binary data, text resize, queued input and reconnect. Keep the terminal bridge in `apps/app/src/bun/server.ts:1090`, `server.test.ts:139` and `CloudWsTunnel.test.ts`; do not rewrite it over `LiveChannel`.
- Reuse the terminal manager as the Branch projection source. Add no migration or `terminals` table. Stop writing terminal-kind `workspace_sessions` rows for branch machines at S2 cutover.
- Reshape the terminal path in `docs/api/openapi/repositories.yaml:7713` and the existing OpenAPI composition for `POST /api/terminals`; preserve the WebSocket path. `branches.yaml` does not exist today. Rebundle and regenerate clients with the existing tools; smithers-b8 approves the route contract.

## Tests

- unit (`terminal_session_manager_test.go`): owner and watcher sinks; 1,000 watcher input frames produce zero stdin bytes and 1,000 drops; owner frames arrive in order; watcher resize/close does nothing. Detach one revoked watcher while owner output continues. Keep existing replay and eviction tests.
- unit (`CloudTerminalClient.test.ts`): preserve binary data/text resize, input queued before attach and reconnect behavior. No new framing protocol.
- integration (`packages/backend/internal/compose/terminal_owner_integration_test.go`, new): use the composed production `POST /api/terminals`, retained terminal WebSocket route and member removal/suspension routes, real PostgreSQL and reference-host microVMs. Existing manager unit tests cannot prove routing or guest identity; this test supplies that boundary. Ben/Alice fixtures pin `ben`, `/home/ben`, `/workspace`, `0002`, zero watcher-created files, 512 KiB replay and 5 s revocation as literals. Inject raw binary input on the retained socket, including forged owner fields, and prove watcher resize/close cannot affect Ben. Repeat removal during open and while input is pending. Open terminals prevent safe-idle; exit releases that hold; reload reattaches; daemon/install restart ends the terminal.
- integration (`TestTerminalUnavailableProvidersFailClosed` in the same suite): independently withhold each Scope provider; production open/attach/input refuses without starting a PTY, minting credentials or falling back. Missing T-COL-02 yields no terminal projection.
- security (`TestTerminalRootInputsValidatedBeforeUse` in the same suite, C-COL-04 and C-SEC-05): exercise the production routes and real broker with root/wrong uid, malformed login/session id, foreign-session credentials, invalid dimensions, forged lifecycle targets, hostile environment and symlink-swapped working copy/token paths. Assert no root execution of branch content, no foreign token access and no effects before validation/uid drop. Inspect child uid/gids and descriptors before the shell loads branch rc files; person bearers never reach it. Concurrent A/B sessions retain separate delegated files when A closes.
- e2e: C-J3-02's two-browser journey through the Branch/Terminal cards. Its raw-input probe uses the retained terminal WebSocket per normative §7.5, not `/api/live`; the retained socket must work. T-APP-12 owns the card integration. All expected identities, bytes, statuses and limits are independent fixture constants, never read from spec files or production code/catalogs.

## Acceptance

- [C-J3-02](../checks/C-J3-02.md): own terminal as own user; others watch read-only; their keystrokes are dropped. Use the retained WebSocket required by normative §7.5 for raw-input and transport assertions.
- [C-COL-04](../checks/C-COL-04.md): authenticated session identity and guest privilege/confinement, including `TestTerminalRootInputsValidatedBeforeUse`.
- [C-SEC-05](../checks/C-SEC-05.md): session-bound delegated files and host-only person credentials at the S2 integration boundary.

## Risks and notes

- Risk: the daemon hop adds keystroke echo latency. Falsified if p95 echo through `open_session` exceeds today's `msb exec -t` path by more than 50 ms on the reference host.
- Session lifecycle is T-TRM-07's protocol (§9.6). Map existing WebSocket text resize to `resize`, shell exit to the existing socket close, owner Close to `close_session`, and removal to `kill_sessions`. smithers-3f accepts the adapter and latency evidence; a protocol deviation needs smithers-8a approval. Check: C-J3-02.
- No `terminals.shared` decision remains: current §3 uses the existing manager. smithers-8a decides spec/check conflicts; smithers-3f decides backend/session seams; smithers-b8 approves app transport and public route changes. Keep the adopted T-TRM-02 credential ruling. Owner review is post hoc under Will's parallel-build directive, not a start gate.
- Root-input inventory for this adapter: privileged startup consumes only the main-built, packaged broker, trusted image shell/executables, fixed session cgroup parent and root-owned uid/login database (T-COL-03, T-TRM-07, T-MCH-11). Broker operations consume host-authenticated branch/member/session identity, PTY dimensions, close/kill targets and host-minted delegated bytes (runtime data, not branch files); validate identity, bounds and session ownership before side effects. Credential writes use fixed `/run` paths and an owner-uid child. The branch working copy, home rc files, requested shell input and any branch-derived environment are untrusted branch inputs: only the dropped owner-uid process may read/execute them. Root must not source rc files, search branch PATH, follow branch symlinks or execute branch hooks. Environment from `/run/smithers/env`, when present, is host-provided data loaded after uid drop; T-MCH-12 owns its delivery. Root creates/kills only broker-owned cgroups using validated session identifiers, never a branch-supplied path. No other root consumer is authorized. smithers-3f reviews this complete input inventory and `TestTerminalRootInputsValidatedBeforeUse`; any branch-sourced root consumption blocks enablement until that test proves validation. Checks: C-COL-04, C-SEC-05.

## Ready checklist

1. Dependencies: identities, daemon/session lifecycle, admission, authorization, revocation, Branch projections, isolation and S1 sign-in are listed; Scope gates each unavailable provider and lands dark. T-TRM-02 S2 remains downstream.
2. Exclusions: Scope names UI, SSH, agent terminals, grants, transcript import, credential syncing, image/secrets work and parallel tables/buffers/brokers/protocols.
3. Boundary tests: composed open, retained terminal WebSocket and revocation routes use real PostgreSQL/microVMs; C-J3-02 uses the cards. Expected results are literal fixtures independent of code and spec files.
4. Decisions: smithers-3f accepts backend/root seams and latency evidence; smithers-b8 approves app transport/public routes; smithers-8a resolves spec/check conflicts and protocol deviations. Adopted credential answers stand.
5. Owner pre-review, recorded for post hoc review under the directive: smithers-3f: Does the adapter retain one broker/ring and detach only revoked watchers? Does every root input satisfy the inventory and validation test? smithers-b8: Does the retained socket/client preserve authentication, reconnect and the public route contract? No UI View or TypeScript library export changes are in scope; expanding scope requires smithers-06 or smithers-38 review respectively.
6. Security: repository shells execute only inside isolated machines as the owner, without sudo or host/shared-user fallback. The root inventory names main, host-runtime and branch inputs; C-COL-04/C-SEC-05 and the named root-input test gate enablement. smithers-3f owns security review.

