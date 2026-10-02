# T-COL-07 Agent write tool checks `base_digest` (S1); agent sees outside changes (S2)

Stage S1, S2 · Size S · Depends on T-COL-04, T-COL-10 · Unblocks — · Issue: to file
Spec: spec.md §2 (actor notation), §7.6 (row 1), §9.3.4, §9.3.9, §10.7.3 (signal delivery), §15.2 · Delta: delta.md §4 · Product: mvp.md §6.8 No silent overwrite and External changes ("The coding agent re-reads changed files before writing"), J3.4, M-02, M-27

## Goal

From stage 1, the coding agent can't overwrite a file that changed since it last read it: every write carries its `base_digest`, a stale one is refused, and the agent re-reads and retries. From stage 2, the agent's transcript also says who changed what before its next tool call ("Maya via SSH changed `retry.ts`, `deliver.ts`").

## Scope

In, S1 (§7.6 row 1, §9.3.9):
- The std `read` tool records the SHA-256 of each file it returns, per agent session. That record is the write's `base_digest`. A path that doesn't exist yet has the base `absent`.
- `write`, `edit` and `apply_patch` carry the actor `{agent: coding, run}` (§2) and the `base_digest`, and compare it with the file's current digest immediately before the atomic rename.
- On mismatch they refuse with `stale_read` and name the path, and nothing is written. An existing file the agent never read is refused the same way, so no write is blind. The agent's own successful writes update the record. The agent then re-reads and retries.

In, S2 (§9.3.9):
- System notes. For every change event (T-COL-04) not caused by the branch's own coding agent, the host delivers one note to the active run. It uses the run-signal path that steers use (T-STK-06) with kind `outside_change`, so it is delivered before the next tool call through the harness `Steering` source (`packages/smithers/agent/harness/src/Steering.ts`, `delivery: "steer"`).
- Notes that arrive within one turn coalesce into one note listing each actor and their files. The text follows §9.3.9's example.
- A note is not a steer. It never appears as a Steer in branch activity, and the burst's own activity entry already shows the change.

Out:
- The `moved_off` write refusal (T-COL-05), which shares `FileMutation.ts` but is its own condition.
- The app's file writes (T-COL-10) and the daemon's `write_file` (T-COL-03).
- Live documents, where the agent's writes enter as attributed edits (T-COL-08, S3).
- Notes for runs on other branches, and notes to the app agent.

## Changes

- S1 `packages/smithers/agent/std/src/Read.ts`: record the digest of each returned file in the session's read ledger.
- S1 `packages/smithers/agent/std/src/internal/FileMutation.ts`: the digest compare-and-refuse before rename. `Write.ts`, `Edit.ts` and `ApplyPatch.ts` route through it.
- S1 `packages/smithers/agent/std/src/StdError.ts`: a `stale_read` error with the path and both digests.
- S1 `flows/coding/filesystem.ts`: the guarded coding filesystem keeps the ledger across one `coding/edit-atom` run (`flows/coding/atoms.ts:49`).
- S2 `packages/backend/internal/machined/events.go`: after commit, signal the branch's active run with `outside_change{actor, files[]}`. A change event whose actor is that run's coding agent sends nothing.
- `packages/smithers/agent/std/docs/` (tool reference): document `stale_read`. Run `docs:sync`, `docs:check` and `smthrs docs //packages/smithers/agent/std:docs`.

## Tests

- unit, S1 (`packages/smithers/agent/std/test/StaleRead.test.ts`, new):
  - read, outside write, write → `stale_read`, file unchanged;
  - read, outside write, read, write → succeeds;
  - read, own write, write → succeeds;
  - `edit` and `apply_patch` behave the same;
  - an existing file never read → `stale_read`, while a new path is created;
  - a path created by someone else after the agent saw it absent → `stale_read`.
- unit, S2 (harness): two `outside_change` signals inside one turn become one transcript insertion, delivered before the next tool call and never mid-turn.
- integration, S2, real PostgreSQL (`packages/backend/internal/machined/notes_integration_test.go`, new): an SSH-attributed event signals the active run once. An agent-attributed event signals nothing. With no active run, nothing is queued.
- e2e: C-J3-03 (note, then re-read).

## Acceptance

- [C-J3-03](../checks/C-J3-03.md): after Maya changes `retry.ts`, the run trace shows the note before the agent's next tool call. No agent write to `retry.ts` is based on the pre-change content.

## Risks and notes

- A check-then-rename race remains. An outside write landing between the digest check and the `rename` is replaced. Confirmed by a fault test that writes inside the window. The burst still records the replacement, so it is recoverable from snapshots (M-27). Flags for replaced edits are [D] (§9.3.7).
- Resume after a crash loses the in-memory read ledger, so the agent must re-read every file before its first write. That is safe but costs turns. Measured by a resume test that counts `stale_read` refusals. If the cost exceeds one extra turn per file, journal the ledger with the run (tech lead decides).
- Only the S2 half depends on T-COL-04. The S1 half needs nothing beyond the std tools, so it ships with stage 1. Note delivery reuses T-STK-06's signal path (S1).
