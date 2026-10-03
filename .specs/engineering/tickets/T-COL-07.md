# T-COL-07 Agent write tool checks `base_digest`

Stage S1, S2 · Size S · Depends on S1: T-COL-10, T-INS-02, T-FLW-01 · S2: T-COL-03, T-TRM-07 · Unblocks T-COL-12, T-REL-02 · Issue: [#3507](https://github.com/smithersai/smithers/issues/3507)
Spec: spec.md §2 (actor notation), §7.6 (row 1), §9.3.4, §9.3.9, §10.7.3 (signal delivery), §15.2 · Delta: delta.md §4 · Product: mvp.md §6.8 No silent overwrite and External changes ("The coding agent re-reads changed files before writing"), J3.4, M-02, M-27

## Goal

Every coding-agent write carries `base_digest`. A stale read refuses the write; the agent re-reads and retries. T-COL-12 owns outside-change notes in S2.

## Scope

- flows/coding/filesystem.ts is the sole in-memory read-ledger owner for one coding/edit-atom run. Inject that ledger into std Read/Write/Edit/ApplyPatch; std creates no second ledger. Add stale_read to existing StdError.Code with path and base_digest/current_digest on the existing StdError payload; create no error class. Add per-file branches/functions/lines/statements 100% gates for src/Read.ts, src/Write.ts, src/Edit.ts, src/ApplyPatch.ts, src/internal/ApplyPatch.ts, src/internal/FileMutation.ts and src/StdError.ts in packages/smithers/agent/std/vitest.config.ts. Check: C-COL-01.

- Guard every apply_patch mutation: add, delete, update and move. Add validates an absent destination with NOREPLACE; delete validates the read source digest under the mutation lock and removes it through the guarded helper. Move validates both source and destination against the read ledger, including absent destinations, before replacing the destination or removing the source. An unread existing source or destination refuses stale_read. Checks: C-COL-01, C-UI-05.
- A multi-file stale refusal changes no file. Prepare all hunks and validate every affected source and destination under the same per-branch mutation lock before publishing changes. Validate displaced digests through the guarded exchange protocol; if any path is stale, roll back this patch’s staged mutations without overwriting outside writers and leave every earlier hunk unchanged. Update the read ledger and diagnostics only for a successful patch. Checks: C-COL-01, C-UI-05.

In, S1 (§7.6 row 1, §9.3.9):
- The std `read` tool records the SHA-256 of each file it returns, per agent session. That record is the write's `base_digest`. A path that doesn't exist yet has the base `absent`.
- `write`, `edit` and `apply_patch` carry the coding participant actor and `base_digest`. In S2 they call the daemon’s `write_file` under its per-branch mutation lock (§9.4.1), using the §9.2.2 exchange and displaced-digest validation, or NOREPLACE for `absent`. Map `409 stale` to `stale_read`. S1 FileMutation provides the same per-branch serialized exchange protocol in the guest until the daemon lands. No direct check-then-rename path remains. Check: the StaleRead integration suite below.
- On mismatch they refuse with `stale_read` and name the path, and nothing is written. An existing file the agent never read is refused the same way, so no write is blind. The agent's own successful writes update the record. The agent then re-reads and retries.


Out:
- A new error class, a second ledger and weakening confinement, authorization or rollback requirements are excluded.
- Partial application on stale_read. No apply_patch add, delete or move bypasses the guarded mutation boundary. Check: C-COL-01.
- The `moved_off` write refusal (T-COL-05), which shares `FileMutation.ts` but is its own condition.
- The app's file writes (T-COL-10) and the daemon's `write_file` (T-COL-03).
- Live documents, where the agent's writes enter as attributed edits (T-COL-08, S3).
- Notes for runs on other branches, and notes to the app agent.
- Persisting the read ledger, auto-merging stale edits, disabling confinement, portable std-tool redesign, UI Views and a second file-write protocol.

## Changes

- flows/coding/filesystem.ts is the sole in-memory read-ledger owner for one coding/edit-atom run. Inject that ledger into std Read/Write/Edit/ApplyPatch; std creates no second ledger. Add stale_read to existing StdError.Code with path and base_digest/current_digest on the existing StdError payload; create no error class. Add per-file branches/functions/lines/statements 100% gates for src/Read.ts, src/Write.ts, src/Edit.ts, src/ApplyPatch.ts, src/internal/ApplyPatch.ts, src/internal/FileMutation.ts and src/StdError.ts in packages/smithers/agent/std/vitest.config.ts. Check: C-COL-01.

- `packages/smithers/agent/std/src/ApplyPatch.ts`: route add, delete, update and move through the guarded coding filesystem and FileMutation helper. Remove direct add writes, delete removals and move-source removals from the coding-host binding. Provide patch-wide staging, digest validation and rollback under the branch lock in S1 and through the authenticated daemon mutation boundary in S2; retain confinement and displaced-digest validation. Check: C-COL-01.

- S1 `packages/smithers/agent/std/src/Read.ts`: record each returned digest through the sole ledger owned by `flows/coding/filesystem.ts`. Check: C-COL-01.
- S1 `packages/smithers/agent/std/src/internal/FileMutation.ts`: serialize guest mutations per branch and use a guest helper for `renameat2` exchange, displaced-digest validation and rollback (§9.2.2). S2 routes writes through daemon `write_file` (§9.4.1) and deletes the interim guest mutation implementation.
- S1 `packages/smithers/agent/std/src/StdError.ts`: extend existing Code and StdError with stale_read, path and both digests; add no error class. Check: C-COL-01.
- S1 `flows/coding/filesystem.ts`: the guarded coding filesystem keeps the ledger across one `coding/edit-atom` run (`flows/coding/atoms.ts:49`).
- `packages/smithers/agent/std/docs/` (tool reference): document `stale_read`. Run `docs:sync`, `docs:check` and `smthrs docs //packages/smithers/agent/std:docs`.

## Tests

- Assert stale_read uses existing StdError with literal path and both digests. Verify all tools share the injected ledger and refusal updates no ledger or diagnostics. Run all seven per-file 100% coverage gates. Preserve confinement, patch-wide rollback and outside-writer tests. Check: C-COL-01.

- StaleRead.integration (C-COL-01, S1 and S2): exercise add, delete, update and move through the production apply_patch dispatcher. Race each source and destination with an outside writer; test unread destination, absent destination created by another writer and stale move source. Refuse with the literal path and preserve outside bytes. In a two-file patch, make the later hunk stale and assert the earlier hunk remains byte-identical, no source disappears, no destination is created and the read ledger/diagnostics report no successful patch. Repeat the stale race at exchange to prove guarded rollback, not only preflight validation.

- Coverage gate (library, ledger #3480): every `@smthrs/std` src file this ticket edits gets a per-file 100/100/100/100 gate in `packages/smithers/agent/std/vitest.config.ts`, as `src/Container.ts` already has.
- Boundary integration, S1 and S2 (`packages/smithers/agent/std/test/StaleRead.integration.test.ts`, new): run the production coding-host tool dispatcher for `coding/edit-atom` in a real machine, including `flows/coding/filesystem.ts` and std Read/Write/Edit/ApplyPatch handlers. A fake model may choose fixed tool calls; do not replace the ledger, guarded filesystem, mutation helper or daemon with a fake. Prove stale, unread, absent, own-write, reread, crash/resume and simultaneous-writer cases. Test fixed byte strings and independently calculated SHA-256 values; no expectation comes from spec files, production digest helpers or implementation constants at runtime.
- Library seam: smithers-38 signs the §21.1 public-API diff before landing. Name `flows/coding/filesystem.ts` and `coding/edit-atom` as the real callers; show why the current per-file mkdir lock in FileMutation cannot validate a displaced outside write. Preserve portable std consumers; guest-only operations belong to the guarded coding-host binding. New exports require the documented caller sketch and review, not an extra abstraction.
- unit, S1 (`packages/smithers/agent/std/test/StaleRead.test.ts`, new):
  - read, outside write, write → `stale_read`, file unchanged;
  - read, outside write, read, write → succeeds;
  - read, own write, write → succeeds;
  - `edit` and `apply_patch` behave the same;
  - an existing file never read → `stale_read`, while a new path is created;
  - a path created by someone else after the agent saw it absent → `stale_read`.

## Acceptance

- [C-J1-04](../checks/C-J1-04.md): S1 part at its named layer.


- [C-UI-05](../checks/C-UI-05.md) agent-write extension (S1): stale coding-agent writes report refused, never saved; the existing app-write step 8 alone does not prove this tool boundary.


- [C-COL-01](../checks/C-COL-01.md), S1 and S2: dispatch real std `read`, `write`, `edit` and `apply_patch` through the coding host's `coding/edit-atom` tool bindings. A coding-agent write after an outside write since its read is refused with `stale_read`, and the file is unchanged. S2 repeats against the authenticated daemon socket, not a direct `write_file` shim.

## Risks and notes

- The simultaneous-writer integration test (`packages/smithers/agent/std/test/StaleRead.integration.test.ts`, real Linux guest) pauses the first write while it holds the branch lock and queues a second write with the same base. Release the first: it succeeds, the second gets `stale_read`, and final bytes equal the first write. Reverse arrival order and require the reverse winner. Also inject an outside replacement before exchange: displaced-digest mismatch restores the outside bytes and refuses the stale write (§9.2.2). Run for write, edit and apply_patch in S1 and against daemon `write_file` in S2; attach syscall and ordering traces.
- Resume after a crash loses the in-memory read ledger, so the agent must re-read every file before its first write. That is safe but costs turns. Measured by a resume test that counts `stale_read` refusals. If the cost exceeds one extra turn per file, journal the ledger with the run (tech lead decides).

## Ready checklist

1. Dependencies: S1 lists the write contract, microVM launcher and machine-only flow dispatch; S2 separately lists daemon transport and registered session supervision. Interim guest writes are removed only when the authenticated daemon path lands.
2. Exclusions: moved_off, app writes, daemon implementation, live documents, outside-change notes, persistent ledger, automatic merge, portable std redesign and Views are explicit.
3. Boundary tests: C-COL-01 and StaleRead.integration dispatch real std tools through coding/edit-atom in a machine, with fixed bytes and independent digests. C-UI-05's agent extension proves refused state. Neither helpers alone nor runtime spec/code-derived expectations count.
4. Decisions: smithers-38 accepts the std public API and compatibility diff under §21.1; smithers-3f accepts helper/socket confinement; smithers-b8 accepts user-facing refusal behavior. smithers-8a decides whether measured resume cost justifies a separate persistent-ledger change; this ticket keeps the ledger in memory.
5. Owner pre-review: smithers-38, smithers-3f and smithers-b8 before each phase starts. Does the guarded coding binding validate the displaced digest without weakening portable std consumers? Do branch locking, absent-path creation and rollback preserve an outside writer's bytes under races and resume? Does S2 derive the actor from the registered agent session and remove the interim guest path? smithers-3f: answered, BLOCKING edits applied (tech lead adopts). smithers-b8: answered 18:23, ok. smithers-38: answered, changes applied (tech lead adopts).
6. Security: smithers-3f reviews machine-only coding-host/helper execution and confinement before start. No repository tool or flow runs on the host; paths stay beneath the working-copy descriptor, last-component symlinks and non-regular files are refused. S2 authenticates agent uid/cgroup via §9.5.3, never caller-supplied identity. Integration includes traversal, symlink-swap, unregistered-caller and stale rollback refusals; no member/agent sudo or guest provider keys.
