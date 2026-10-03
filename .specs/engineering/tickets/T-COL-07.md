# T-COL-07 Agent write tool checks `base_digest`

Stage S1 · Size S · Depends on T-COL-10 · Unblocks T-COL-12, T-REL-02 · Issue: [#3507](https://github.com/smithersai/smithers/issues/3507)
Spec: spec.md §2 (actor notation), §7.6 (row 1), §9.3.4, §9.3.9, §10.7.3 (signal delivery), §15.2 · Delta: delta.md §4 · Product: mvp.md §6.8 No silent overwrite and External changes ("The coding agent re-reads changed files before writing"), J3.4, M-02, M-27

## Goal

Every coding-agent write carries `base_digest`. A stale read refuses the write; the agent re-reads and retries. T-COL-12 owns outside-change notes in S2.

## Scope

In, S1 (§7.6 row 1, §9.3.9):
- The std `read` tool records the SHA-256 of each file it returns, per agent session. That record is the write's `base_digest`. A path that doesn't exist yet has the base `absent`.
- `write`, `edit` and `apply_patch` carry the coding participant actor and `base_digest`. In S2 they call the daemon’s `write_file` under its per-branch mutation lock (§9.4.1), using the §9.2.2 exchange and displaced-digest validation, or NOREPLACE for `absent`. Map `409 stale` to `stale_read`. S1 FileMutation provides the same per-branch serialized exchange protocol in the guest until the daemon lands. No direct check-then-rename path remains. Check: the StaleRead integration suite below.
- On mismatch they refuse with `stale_read` and name the path, and nothing is written. An existing file the agent never read is refused the same way, so no write is blind. The agent's own successful writes update the record. The agent then re-reads and retries.


Out:
- The `moved_off` write refusal (T-COL-05), which shares `FileMutation.ts` but is its own condition.
- The app's file writes (T-COL-10) and the daemon's `write_file` (T-COL-03).
- Live documents, where the agent's writes enter as attributed edits (T-COL-08, S3).
- Notes for runs on other branches, and notes to the app agent.

## Changes

- S1 `packages/smithers/agent/std/src/Read.ts`: record the digest of each returned file in the session's read ledger.
- S1 `packages/smithers/agent/std/src/internal/FileMutation.ts`: serialize guest mutations per branch and use a guest helper for `renameat2` exchange, displaced-digest validation and rollback (§9.2.2). S2 routes writes through daemon `write_file` (§9.4.1) and deletes the interim guest mutation implementation.
- S1 `packages/smithers/agent/std/src/StdError.ts`: a `stale_read` error with the path and both digests.
- S1 `flows/coding/filesystem.ts`: the guarded coding filesystem keeps the ledger across one `coding/edit-atom` run (`flows/coding/atoms.ts:49`).
- `packages/smithers/agent/std/docs/` (tool reference): document `stale_read`. Run `docs:sync`, `docs:check` and `smthrs docs //packages/smithers/agent/std:docs`.

## Tests

- Coverage gate (library, ledger #3480): every `@smthrs/std` src file this ticket edits gets a per-file 100/100/100/100 gate in `packages/smithers/agent/std/vitest.config.ts`, as `src/Container.ts` already has.
- unit, S1 (`packages/smithers/agent/std/test/StaleRead.test.ts`, new):
  - read, outside write, write → `stale_read`, file unchanged;
  - read, outside write, read, write → succeeds;
  - read, own write, write → succeeds;
  - `edit` and `apply_patch` behave the same;
  - an existing file never read → `stale_read`, while a new path is created;
  - a path created by someone else after the agent saw it absent → `stale_read`.

## Acceptance

- [C-J1-04](../checks/C-J1-04.md): S1 part at its named layer.


- [C-UI-05](../checks/C-UI-05.md) step 8 (S1): stale reads never overwrite newer bytes.


- [C-COL-01](../checks/C-COL-01.md), S1: a coding-agent write after an outside write since its read is refused with `stale_read`, and the file is unchanged.

## Risks and notes

- The simultaneous-writer integration test (`packages/smithers/agent/std/test/StaleRead.integration.test.ts`, real Linux guest) pauses the first write while it holds the branch lock and queues a second write with the same base. Release the first: it succeeds, the second gets `stale_read`, and final bytes equal the first write. Reverse arrival order and require the reverse winner. Also inject an outside replacement before exchange: displaced-digest mismatch restores the outside bytes and refuses the stale write (§9.2.2). Run for write, edit and apply_patch in S1 and against daemon `write_file` in S2; attach syscall and ordering traces.
- Resume after a crash loses the in-memory read ledger, so the agent must re-read every file before its first write. That is safe but costs turns. Measured by a resume test that counts `stale_read` refusals. If the cost exceeds one extra turn per file, journal the ledger with the run (tech lead decides).
