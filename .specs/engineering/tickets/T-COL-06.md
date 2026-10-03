# T-COL-06 Presence on the existing `BranchPresence` lease roster

Stage S2 · Size M · Depends on T-COL-02, T-COL-04, T-COL-03r, T-COL-03, T-ACC-02, T-ACC-03 · Unblocks T-AGT-02, T-APP-10, T-REL-02, T-REL-03, T-STK-08, T-TRM-02 · Issue: [#3563](https://github.com/smithersai/smithers/issues/3563)
Spec: spec.md §2 (Presence, actor notation), §5.6, §7.3.0–7.3.2, §7.6 (row 4), §8.4.1, §14.3 (Branch) · Delta: delta.md §4 (presence row) · Product: mvp.md J3.2–J3.3, §6.8 Presence, M-17, M-34

Rescoped by the minimal-code synthesis, 2026-10-03 (v1 §4): reuse the existing lease roster; no new presence system and no Pair presence beside it.

## Goal
The `branch:<id>` topic lists everyone on a branch with where each one is: people in the app, members over SSH or in terminals, and agents. Entries vanish 30 s after their last heartbeat, and nothing treats a branch as empty during the 30 s after a host start.

## Scope
In:
- One roster: `packages/smithers/flows/sync/src/BranchPresence.ts` (`makeMemory`, `defaultLeaseMs = 30_000` at `:84`), run in the TS Flow/Control host and reached from Go through `packages/backend/runtimebridge/client.go`. Leases keyed `(branch, actor, session)`; the roster stays in memory.
- Add a person-or-agent kind and a location `where`: `{file: {path, line?}}`, `{terminal: id}`, `{step: id}` or `{branch}`; optional `watching`. `{path, line}` uses document line coordinates (§7.6 row 4).
- Identity and branch scope come from the host's authorizer, never from the heartbeat body. M-34 participants carry id, agent kind, run or session and optional `for_member`; participant ids grant no rights.
- Heartbeat sources (§7.3.1), through the existing `@smthrs/sync` branch protocol: browsers every 10 s and on every move; `smithers-machined` for SSH, terminal and editor sessions with the last file that session wrote (an outside burst moves nobody); coding and reviewer runtimes and the Smithers host turn runner every 10 s while working. External-agent skill calls bind a participant to its broker session; agent-session end removes that participant even if the terminal stays open. Check: C-J3-01.
- `PresenceOn(branch)` for safe-idle (T-MCH-06) and presence-aware rebase (T-STK-08) returns `unknown` for 30 s after host start; callers treat `unknown` as present.
- Revocation (§5.6) and a closed socket or SSH session remove entries at once; the lease covers silent loss.
- One coarse `audit_log` row per person per branch visit of at least 2 min, for the scorecard (T-REL-03).
- Lands dark until T-COL-02: unavailable live transport refuses presence operations with `unsupported`; no alternate endpoint or roster. Lands dark until T-ACC-03 and T-ACC-02: missing branch authorization or revocation wiring refuses announce and roster reads; participant ids never authorize access.
- Lands dark until T-COL-03r, T-COL-03 and T-COL-04: missing codecs, authenticated machine registry or session-write attribution disables daemon presence. Build against their specified contracts. `PresenceOn` returns `unknown`, never empty, while a required source or bridge is unavailable.
- Lands dark until T-TRM-01 and T-TRM-03: terminal and SSH presence remain disabled until their authenticated session sources exist; `PresenceOn` remains `unknown` for branches whose session sources are unavailable. These are enablement conditions, not calls to those tickets' code. Checks: TestPresenceUnavailableFailsClosed, C-J3-01, C-J3-06.

Out:
- Branch card rendering and avatar/session-hover grouping (T-APP-10), terminal creation and watch/type control (T-TRM-01), SSH gateway and key sync (T-TRM-03), Yjs awareness and gutter flags (T-COL-08), admission leases and machine release policy (T-MCH-06), presence-aware rebase policy (T-STK-08).
- Transcript adapters/ingestion (T-AGT-01/02), participant rendering (T-APP-09), new presence frames or a second roster, durable presence tables, root broker changes, repository execution on the host, and guest installation or image changes.
- Pair sessions, invites, links, queue and draft (#3401 stays do-not-implement).

## Changes
Reuse:
- `packages/smithers/flows/sync/src/BranchPresence.ts`: the lease table, expiry sweep, participant cap and `changes` stream. Extend its participant with kind and `where`; its share-capability check gives way to the host-resolved member or run.
- `packages/backend/runtimebridge/client.go`: reuse authenticated `CallRPC` (`:66`) to carry branch-protocol announcements, leaves and roster reads. Extend the host adapter; the existing client does not yet wire presence.
- `packages/smithers/flows/sync/src/BranchProtocol.ts`: reshape `Participant` (`:216`), `Announcement` (`:265`) and the existing roster/leave requests for host-resolved actor/session binding and location. Reuse `SyncClient.ts` for resumable follow; retain bounded, detached state and prevent one session from overwriting or leaving another. Check: TestPresenceSessionBinding.
- `packages/backend/internal/revocation/`: the existing bus drives removal.

Reshape:
- `packages/backend/internal/live/protocol.go` (planned by T-COL-02; absent in the current clone): adapt the existing branch-protocol presence operations to the authenticated `/api/live` subscription; refuse a location outside the authorized branch. Add no separate presence frame.
- `apps/app/src/mainview/runtime/LiveChannel.ts`: reuse the tab singleton and subscription lifecycle; connect the branch-protocol client to a 10 s heartbeat timer and move events.
- Reuse the presence schema in `packages/rpc/src/BranchCard.ts:46`; map lease rows to that contract. `packages/rpc/src/Live.ts` does not exist; do not create a parallel location model.

Reuse the in-memory BranchPresence lease transitions; append only the coarse scorecard fact to audit_log.

Reshape:
- Reuse `packages/backend/internal/services/audit.go` and `packages/backend/db/product/queries/audit_log.sql` for an `audit_log` presence event with branch, member, via, start and end metadata. Adapt only the historical heartbeat/lease SQL shape where surviving records need it (delta.md §4); keep the roster in memory and add no presence migration. Check: TestPresenceVisitAudit, C-REL-04 (folded into T-REL-03's tests).

New:
- Coalescer to ≤ 4 deltas per second per branch on `branch:<id>`. Rejected reuse: `BranchPresence.changes` signals a branch changed but does not rate-limit fan-out.

## Tests
- Extend `packages/smithers/flows/sync/test/BranchPresence.test.ts` and `BranchRosterLeaseWatch.test.ts` with fake-clock cases: expiry at 30 s, not 29.9 s; two sessions stay two leases; startup is `unknown` at 29.9 s. Re-list on expiry even without a `changes` notification; a silent last departure must reach subscribers within 1 s of lease expiry.
- `TestPresenceSessionBinding` and `TestPresenceUnavailableFailsClosed` in `packages/backend/internal/live/presence_integration_test.go` (planned): real PostgreSQL, the production `/api/live` dispatcher and real TS runtime bridge. Refuse unreadable branches and foreign terminal/step locations; ignore spoofed actor fields; refuse cross-session overwrite/leave. Revocation removes leases within 5 s, including revocation racing announce; clean close removes them within 1 s. Missing authorizer, revocation watcher, bridge, codec, registry or session source refuses the affected operation and makes `PresenceOn` return `unknown`. A finished-run watcher does not count as working presence.
- `TestPresenceDeltaCoalescing` in the same integration suite: 100 moves per second through `/api/live` produce at most 4 branch deltas per second, retain the last location and reach subscribers within 1 s. Observe subscriber frames, not direct roster calls.
- `TestPresenceVisitAudit` in the same suite: production heartbeats and session close write no audit row for 1 min 59 s, one row for 2 min, and one row for two tabs plus SSH in the same visit. Query real PostgreSQL for literal event metadata.
- `crates/smithers-machined/tests/presence.rs` (planned; crate supplied by T-COL-03r): exercise the production daemon presence stream with authenticated host/session fixtures. An SSH session's attributed write sets its location; an outside burst does not. This is a component test; C-J3-06 proves the real SSH boundary.
- Row-4 golden-frame assertion in `packages/backend/internal/compose/cocontracts_test.go` (planned by T-COL-03r): use committed literal frames, including file and line coordinates, never production encoders as the oracle.
- C-J3-01 uses `/branch T2`, `/file retry.ts`, `/terminal` and actual agent sessions through the production app. C-J3-06 uses the public SSH gateway and Branch card. All test expectations are literal fixture values and fixed limits; no test reads spec files or derives its oracle from production code at runtime.

## Acceptance
- [C-J3-01](../checks/C-J3-01.md): the Branch card shows the people, the coding agent and "Maya via SSH", each with where, and a person watching a terminal.
- [C-J3-06](../checks/C-J3-06.md): an SSH session from another machine shows as "Maya via SSH" with where she last wrote.
- Row-4 golden-frame test owned with T-COL-03r must pass. [C-COL-01](../checks/C-COL-01.md) is a folded reference, not a separate executable check.
- `TestPresenceSessionBinding`, `TestPresenceUnavailableFailsClosed`, `TestPresenceDeltaCoalescing` and `TestPresenceVisitAudit` pass at the boundaries above; later journey dependencies do not block the first dark merge.

## Risks and notes
- smithers-38 approves the branch-protocol API and lease reshaping; smithers-3f approves authorization, revocation, machine-stream and audit seams; smithers-b8 approves the browser adapter. smithers-8a decides any deviation from delta.md, including a Go port if integration shows delta latency over 1 s. A port needs smithers-38 and smithers-3f acceptance and deletes the TS use; never keep both.
- A host restart empties the roster; browsers and the daemon re-send within 10 s and the 30 s `unknown` window covers the gap. Broken if an SSH session is missing 15 s after restart or a machine is released before 30 s.

## Security preconditions
- Repository code executes only as an unprivileged user inside a branch machine (M-29); no member or agent has sudo. The host handles bounded presence metadata only; location paths are display data, never paths the host opens or executes. smithers-3f reviews this boundary and the authenticated session binding.
- This ticket adds no root step and changes no input consumed by the existing root broker. Heartbeats and attributed-write hints are handled by the unprivileged `machined` daemon using already established session metadata. Root setup, session creation, UID allocation, cgroups and binary planting remain owned by T-COL-03a, T-COL-03 and T-MCH-11. A root change is out of scope and requires a separate input/source inventory and named validation test before use. Check: TestPresenceSessionBinding and the production-daemon presence component test.

## Ready checklist
1. Direct calls/contracts: T-COL-02 live dispatch, T-COL-04 attribution, T-COL-03r codecs, T-COL-03 machine binding, T-ACC-02 revocation and T-ACC-03 authorization; Scope names fail-closed dark behavior for every dependency and terminal/SSH enablement condition. Unavailable sources keep `PresenceOn` unknown.
2. Out names card/avatar rendering, terminal control, SSH/key sync, Yjs flags, admission/rebase policies, transcripts, Pair, new frames/rosters/tables and privileged setup. Changes enable and reshape existing sync, bridge and audit code; only the bounded fan-out coalescer is new with rejected reuse stated.
3. Named integration tests use production `/api/live`, the real runtime bridge and PostgreSQL; C-J3-01/06 use app commands and real SSH. Golden frames and literal fixtures supply independent oracles; planned paths are marked.
4. smithers-38 accepts the library/public protocol, smithers-3f the backend/security/audit seams, smithers-b8 the app adapter; smithers-8a accepts architecture deviations with both library and backend owners for a Go port.
5. Owner pre-review, recorded answers stand and review is post hoc under Will's directive: smithers-38: Does branch-protocol reuse preserve session binding and lease-expiry follow? Does the public schema reuse BranchCard without a second location model? smithers-3f: Are authorization/revocation races and missing sources fail-closed? Does daemon presence use only unprivileged established-session metadata? Is one coarse visit audit row emitted across sessions? smithers-b8: Does the browser adapter reuse the tab singleton and clean up move/timer handlers? Does it preserve agent lifetime separately from terminal lifetime? No UI View changes; smithers-06 pre-review is not required.
6. Security preconditions name smithers-3f, unprivileged machine-only repository execution, metadata-only host handling and no root step/input changes; session-binding and production-daemon tests prove the scoped boundary. Root broker changes remain explicitly excluded.

