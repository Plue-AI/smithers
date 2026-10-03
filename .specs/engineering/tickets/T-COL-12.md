# T-COL-12 The coding agent sees outside changes

Stage S2 · Size S · Depends on T-COL-04, T-COL-10, T-STK-06 · Unblocks T-REL-02 · Issue: [#3632](https://github.com/smithersai/smithers/issues/3632)
Spec: spec.md §9.3.9, §10.7.3 · Delta: delta.md §4 · Product: mvp.md §6.8 External changes, J3.4

## Goal

Before its next tool call, the coding agent sees who changed which files and re-reads them.

## Scope

In:
- Outside-change notes for the active coding run on the changed branch, coalesced within one turn by actor and file. Preserve participant attribution (M-34).

Out:
- Digest checks (T-COL-10), watcher attribution (T-COL-04) and app-agent notes.

## Changes

- `packages/backend/internal/machined/events.go`: after commit, signal `outside_change{actor, files[]}` through T-STK-06's production delivery seam. The run’s own coding participant sends no note.
- The harness `Steering` source delivers the note before the next tool call, never mid-turn. The note is not a Steer activity entry; the burst records the change.
- Update the tool reference and its docs gates.

## Tests

- Unit: two signals in one turn coalesce into one insertion with both actors and all files.
- Integration: `packages/backend/internal/machined/notes_integration_test.go`, real PostgreSQL, production delivery seam. SSH change signals once; own-agent change signals nothing; no active run queues nothing.

## Acceptance

- [C-J3-03](../checks/C-J3-03.md): S2 part at its named layer.


- [C-J3-03](../checks/C-J3-03.md): the note precedes the next tool call; the agent re-reads before writing.

## Risks and notes

- Attribute notes from committed watcher facts, not terminal-command heuristics.
