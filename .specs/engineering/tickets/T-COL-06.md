# T-COL-06 Presence map and heartbeats

Stage S2 · Size M · Depends on T-COL-02, T-COL-04, T-COL-10 · Unblocks T-STK-11, T-APP-10, T-REL-03 · Issue: to file
Spec: spec.md §2 (Presence, actor notation), §5.6, §7.1 (`presence` frame), §7.3.1–7.3.2, §7.4.5, §7.6 (row 4), §8.4.1, §8.10.4, §14.3 (Branch) · Delta: delta.md §4 (presence row; `BranchPresence` reference) · Product: mvp.md J3.2–J3.3, §6.8 Presence, M-17

## Goal

The `branch:<id>` topic lists everyone on a branch with where each one is: people in the app, members over SSH or in terminals, and the coding agent. Entries vanish 30 s after their last heartbeat, and nothing treats a branch as empty during the 30 s after a host start.

## Scope

In:
- An in-memory presence map in the host service, keyed `(branch, actor, session)`, with a 30 s TTL. It uses the lease semantics of `packages/smithers/flows/sync/src/BranchPresence.ts:84` (`defaultLeaseMs = 30_000`), reimplemented in Go. Presence itself is never persisted; only the coarse rows below are.
- Heartbeat sources (§7.3.1):
  - browsers send the `presence` text frame every 10 s and on every move;
  - `smithers-machined` sends session open and close (`via: ssh` or `terminal`) and, as `where`, the last file written by that session: the last file of a burst T-COL-04 attributed to it (§7.3.1, §8.10.4). An outside burst moves nobody's `where`;
  - the runtime sends the coding agent's current step and the last file it wrote.
- `where` is one of `{file: {path, line?}}`, `{terminal: id}`, `{step: id}` or `{branch}`. `watching?` holds a terminal id (§14.3). Contract (§7.6 row 4): `{path, line}` uses the document's line coordinates, the shape Yjs awareness carries (§7.4.5), so gutter name flags work from presence before co-editing exists.
- Projection into `branch:<id>`: rows `{actor, where, watching?}` kept per session (§7.3.2). The Branch card shows one avatar per person with that person's sessions on hover (T-APP-10). Deltas are coalesced to ≤ 4 per second per branch and reach subscribers within 1 s (§7.3.2).
- Read API `PresenceOn(branch)` for safe-idle (§8.4.1, T-MCH-06) and presence-aware rebase (§10.5.2, T-STK-11). For 30 s after the host starts it returns `unknown` (§7.3.0), and callers treat `unknown` as present: no machine is released and no deferred rebase runs.
- Coarse `presence_sessions` (§3, §7.3.1a): when one person's presence on a branch lasts at least 2 min, write one row `(branch, member, via, started_at, ended_at)`, closed when that person's last session on the branch expires. It feeds the scorecard's session measure (§20.4, T-REL-03).
- Revocation (§5.6) removes a member's entries at once. A closed socket or SSH session removes its entries at once; the TTL covers silent loss.

Out:
- Branch card rendering (T-APP-10), terminal watch/type control (T-TRM-01), Yjs awareness (T-COL-08), and admission (T-MCH-06).
- Restoring Pair code (#3401 is do-not-implement; M-17 supersedes it only for the semantics).

## Changes

- `packages/backend/internal/live/presence.go` (new): map, TTL sweep, coalescer, start-up `unknown` window, `PresenceOn`, revocation hook on `packages/backend/internal/revocation/`.
- `packages/backend/db/product/migrations/<next>_presence_sessions.sql` (new) and its queries: the §3 table, written by the presence map on open (after 2 min) and close.
- `packages/backend/internal/live/protocol.go`: accept the `presence` frame that T-COL-02 reserved. Validate that `where` points inside the subscribed branch.
- `packages/backend/internal/machined/presence.go` (new): ingest the daemon's presence stream.
- Runtime events → presence: the projection that sets `todos.current_step` within 1 s (§4.1.2, T-STK-01) also refreshes the coding agent's presence.
- `packages/rpc/src/Live.ts`: `Where` and `PresenceRow` schemas, matching `.specs/design/mock/src/world.ts` `Presence`/`Where`.
- `apps/app/src/mainview/runtime/LiveChannel.ts`: the heartbeat timer (10 s) and move events from the File, Terminal and Branch cards.
- `packages/backend/docs/live-channel.md`: a presence section. Run `docs:sync`, `docs:check` and `smthrs docs //packages/backend:docs`.

## Tests

- unit (`presence_test.go`, new, fake clock): an entry expires at 30 s and not at 29.9 s. Two sessions of one person stay two rows with their own where. Coalescing emits ≤ 4 deltas per second with 100 moves per second and keeps the last state. `PresenceOn` returns `unknown` at 29.9 s after start and a real answer at 30 s.
- unit: presence of 1 min 59 s writes no `presence_sessions` row; 2 min writes one; a person with two tabs and an SSH session writes one row, not three.
- integration, real PostgreSQL and WebSocket (`presence_integration_test.go`, new):
  - a heartbeat for a branch the member can't read is refused;
  - revoking a member removes their rows in ≤ 5 s;
  - closing the socket removes the browser row at once;
  - `PresenceOn` ignores watchers of a finished run (§8.4.1).
- integration (`crates/smithers-machined/tests/presence.rs`, new): an SSH session's write, as the only active session, sets its where to that file; the same write during an outside burst leaves where unchanged.
- e2e: C-J3-01.
- contract: append the §7.6 row-4 assertion (a heartbeat's `where.file` is `{path, line}` in document line coordinates) to `packages/backend/internal/compose/cocontracts_test.go` (T-COL-10). It re-runs C-COL-01's stage-2 rows.

## Acceptance

- [C-J3-01](../checks/C-J3-01.md): the Branch card shows the people, the coding agent and "Maya via SSH", each with where, and a person watching a terminal.
- [C-J3-06](../checks/C-J3-06.md): an SSH session from another machine shows as "Maya via SSH" on the Branch card, with where she last wrote.

## Risks and notes

- The host restart empties the map. Browsers re-send within 10 s of reconnect, and the daemon re-sends open sessions on reconnect; the 30 s `unknown` window (§7.3.0) covers the gap. Confirmed broken if, 15 s after a host restart, an SSH session is missing from the card, or if any machine is released before 30 s.
- Presence affects sleep: a stale browser entry holds a machine awake for up to 30 s past a closed laptop lid. That is within §8.4.2 (30 min / 2 min sleep).
