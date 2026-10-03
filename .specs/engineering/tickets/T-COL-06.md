# T-COL-06 Presence on the existing `BranchPresence` lease roster

Stage S2 · Size M · Depends on T-COL-02, T-COL-04, T-COL-03r · Unblocks T-AGT-02, T-APP-10, T-REL-02, T-REL-03, T-STK-08, T-TRM-02 · Issue: [#3563](https://github.com/smithersai/smithers/issues/3563)
Spec: spec.md §2 (Presence, actor notation), §5.6, §7.3.0–7.3.2, §7.6 (row 4), §8.4.1, §14.3 (Branch) · Delta: delta.md §4 (presence row) · Product: mvp.md J3.2–J3.3, §6.8 Presence, M-17, M-34

Rescoped by the minimal-code synthesis, 2026-10-03 (v1 §4): reuse the existing lease roster; no new presence system and no Pair presence beside it.

## Goal
The `branch:<id>` topic lists everyone on a branch with where each one is: people in the app, members over SSH or in terminals, and agents. Entries vanish 30 s after their last heartbeat, and nothing treats a branch as empty during the 30 s after a host start.

## Scope
In:
- One roster: `packages/smithers/flows/sync/src/BranchPresence.ts` (`makeMemory`, `defaultLeaseMs = 30_000` at `:84`), run in the TS Flow/Control host and reached from Go through `packages/backend/runtimebridge/client.go`. Leases keyed `(branch, actor, session)`; the roster stays in memory.
- Add a person-or-agent kind and a location `where`: `{file: {path, line?}}`, `{terminal: id}`, `{step: id}` or `{branch}`; optional `watching`. `{path, line}` uses document line coordinates (§7.6 row 4).
- Identity and branch scope come from the host's authorizer, never from the heartbeat body. M-34 participants carry id, agent kind, run or session and optional `for_member`; participant ids grant no rights.
- Heartbeat sources (§7.3.1): browsers every 10 s and on every move; `smithers-machined` for SSH and terminal sessions with the last file that session wrote (an outside burst moves nobody); the runtime for agents.
- `PresenceOn(branch)` for safe-idle (T-MCH-06) and presence-aware rebase (T-STK-08) returns `unknown` for 30 s after host start; callers treat `unknown` as present.
- Revocation (§5.6) and a closed socket or SSH session remove entries at once; the lease covers silent loss.
- One coarse `audit_log` row per person per branch visit of at least 2 min, for the scorecard (T-REL-03).

Out:
- Branch card rendering (T-APP-10), terminal watch/type control (T-TRM-01), Yjs awareness (T-COL-08), admission leases (T-MCH-06).
- Pair sessions, invites, links, queue and draft (#3401 stays do-not-implement).

## Changes
Reuse:
- `packages/smithers/flows/sync/src/BranchPresence.ts`: the lease table, expiry sweep, participant cap and `changes` stream. Extend its participant with kind and `where`; its share-capability check gives way to the host-resolved member or run.
- `packages/backend/runtimebridge/client.go`: carries heartbeats and roster reads; it already authenticates to the TS host.
- `packages/backend/internal/revocation/`: the existing bus drives removal.

Reshape:
- `packages/backend/internal/live/protocol.go` (T-COL-02): accept the `presence` frame; refuse a `where` outside the subscribed branch.
- `apps/app/src/mainview/runtime/LiveChannel.ts`: 10 s heartbeat timer and move events.
- `packages/rpc/src/Live.ts`: `Where` and `PresenceRow` types.

Reuse the in-memory BranchPresence lease transitions; append only the coarse scorecard fact to audit_log.

New:
- Record presence lasting at least 2 min as an `audit_log` event with branch, member, via, start and end metadata; no presence migration. Check: C-REL-04.
- Coalescer to ≤ 4 deltas per second per branch on `branch:<id>`. Rejected reuse: `BranchPresence.changes` signals a branch changed but does not rate-limit fan-out.

## Tests
- Unit (fake clock): expiry at 30 s, not 29.9 s; two sessions of one person stay two rows; 100 moves per second emit ≤ 4 deltas and keep the last state; `PresenceOn` is `unknown` at 29.9 s after start.
- Unit: 1 min 59 s writes no `audit_log` row; 2 min writes one; two tabs plus SSH write one.
- Integration (real PostgreSQL, WebSocket, real runtime bridge): a heartbeat for an unreadable branch is refused; a spoofed actor in the body is ignored; revocation removes rows in ≤ 5 s; a closed socket removes the browser row at once; `PresenceOn` ignores watchers of a finished run.
- `crates/smithers-machined/tests/presence.rs`: an SSH session's write sets its `where`; the same write during an outside burst does not.
- Contract: the §7.6 row-4 assertion in `packages/backend/internal/compose/cocontracts_test.go` (T-COL-03r).

## Acceptance
- [C-J3-01](../checks/C-J3-01.md): the Branch card shows the people, the coding agent and "Maya via SSH", each with where, and a person watching a terminal.
- [C-J3-06](../checks/C-J3-06.md): an SSH session from another machine shows as "Maya via SSH" with where she last wrote.
- [C-COL-01](../checks/C-COL-01.md): row-4 contract; does not block S2 completion.

## Risks and notes
- The bridge adds one hop per heartbeat. If integration shows delta latency over 1 s, port the roster into Go once and delete the TS use; never keep both.
- A host restart empties the roster; browsers and the daemon re-send within 10 s and the 30 s `unknown` window covers the gap. Broken if an SSH session is missing 15 s after restart or a machine is released before 30 s.
