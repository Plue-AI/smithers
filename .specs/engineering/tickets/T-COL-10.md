# T-COL-10 Every file write carries `base_digest`; a stale write is refused

Stage S1, S2 · Size M · Depends on S1: T-INS-02, T-FLW-01 · S2: T-COL-03, T-TRM-07 · Unblocks T-COL-02, T-COL-11, T-COL-12, T-REL-02 · Issue: [#3508](https://github.com/smithersai/smithers/issues/3508)
Spec: spec.md §7.6 (row 1), §9.1.2 (`write_file`), §9.2.2, §9.3.9 · Delta: delta.md §4 · Product: mvp.md §6.8 No silent overwrite and External changes, J3.4, M-02, M-27

Rescoped by the minimal-code synthesis, 2026-10-03 (v1 §3). Absorbs T-COL-07 ([#3507](https://github.com/smithersai/smithers/issues/3507)).

## Goal
Every write to a branch's files through Smithers, from the app or the coding agent, carries `base_digest`. A stale write is refused and changes nothing. The wiki keeps its Yjs text.

## Scope
In:
- The written rule in `docs/architecture/0003-live-code-co-editing.md`: one section, "every write carries `base_digest`; stale is refused". Its topology section says "decided by T-COL-11".
- S1: the app write route and the coding agent's std tools enforce the rule in the guest.
- S2: the agent's writes go through the daemon's `write_file` (T-COL-03) and the interim guest path is deleted.

Out, moved to the ticket that first uses them:
- ADR 0004 wire contract, golden frames and the Go and Rust codecs: T-COL-03r (S2).
- Reserved `doc:*` topics and document stream frames: T-COL-08b (S3).
- The TS `LiveDoc.ts` contract and fake relay: T-COL-08b, built with T-APP-14a.
- `moved_off` refusal (T-COL-05), outside-change notes (T-COL-12), live documents (T-COL-08).

## Changes
Reshape:
- `packages/backend/internal/services/workspace_facets.go:244` `WriteWorkspaceFile` → takes `baseDigest` (SHA-256 or `"absent"`) and compares inside the guest write, one helper call (`packages/backend/microsandbox/guest/smithers-guest.py`). Add `digest` to `WorkspaceFileContent` (`:56`) on read and write responses.
- `PUT /workspaces/{id}/files/content` handler (route at `packages/backend/internal/compose/router.go:1442`) → require `base_digest`; return `409 {code: "stale", current_digest}` on mismatch; actor from the authenticated principal plus `via`, as `workspaceFacetRouteContext` does; a body naming actor, branch, machine or uid is 400.
- `docs/api/openapi/*.yaml` → the same request, response and 409 shapes (`openapi_conformance_test.go`).
- Every caller of `files/content` in `apps/app` and `packages/smithers` → sends `base_digest`, reloads on 409. No blind write remains.
- `packages/smithers/agent/std/src/Read.ts`, `Write.ts`, `Edit.ts`, `ApplyPatch.ts`, `src/internal/ApplyPatch.ts`, `src/internal/FileMutation.ts` → record each read digest in the one ledger owned by `flows/coding/filesystem.ts`; refuse a write whose base no longer matches, or an existing file never read. `apply_patch` validates every source and destination under the per-branch lock and rolls back the whole patch on a stale path.
- `packages/smithers/agent/std/src/StdError.ts:15` → add `stale_read` to the existing `Code` with path and both digests. No new error class.
- `packages/smithers/agent/std/docs/` → document `stale_read`; run the docs gates.

New: none. A second ledger, error class or file-write protocol was rejected; the existing write route and std tools carry the rule.

## Tests
- Integration (real PostgreSQL, real machine): correct base succeeds; a second actor's write makes the first actor's next write 409 and leaves bytes unchanged; missing base is 400; `"absent"` creates only a missing file; forbidden body fields are 400.
- `packages/smithers/agent/std/test/StaleRead.integration.test.ts`: real `coding/edit-atom` dispatcher; stale, unread, absent, own-write, reread and crash/resume cases; a two-file patch with a stale later hunk leaves the earlier hunk byte-identical. S2 repeats against the daemon socket.
- Fixed bytes and independently computed SHA-256 values; no expectation from production helpers.
- Per-file 100% coverage gates in `packages/smithers/agent/std/vitest.config.ts` for the edited std files.

## Acceptance
- [C-COL-01](../checks/C-COL-01.md), S1 and S2: stale app and agent writes are refused and the file is unchanged.
- [C-UI-05](../checks/C-UI-05.md): a refused stale write shows as refused, never saved.
- [C-J1-04](../checks/C-J1-04.md): S1 part at its named layer.

## Risks and notes
- Compare-and-write must be atomic in the guest. If concurrent-write tests show a lost update, the compare moves into `smithers-machined` (T-COL-03) and the stage-1 window is documented.
- The guest compare runs through the root helper: it lands only after T-SEC-01's R1–R3 tests and `TestWorkspaceCompareWriteDropsPrivilegeAndConfinesPaths` pass.
- Resume loses the in-memory ledger, so the agent re-reads before its first write. If that costs more than one extra turn per file, journal the ledger with the run (smithers-8a decides).
