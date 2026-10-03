# T-COL-10 Every file write carries `base_digest`; a stale write is refused

Stage S1, S2 · Size M · Depends on S1: T-INS-02, T-FLW-01 · S2: T-COL-03, T-TRM-07 · Unblocks T-COL-11, T-COL-12, T-REL-02 · Issue: [#3508](https://github.com/smithersai/smithers/issues/3508)
Spec: spec.md §7.6 (row 1), §9.1.2 (`write_file`), §9.2.2, §9.3.9 · Delta: delta.md §4 · Product: mvp.md §6.8 No silent overwrite and External changes, J3.4, M-02, M-27

Rescoped by the minimal-code synthesis, 2026-10-03 (v1 §3). Absorbs T-COL-10 ([#3507](https://github.com/smithersai/smithers/issues/3507)).

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

C-COL-01 (folded steps and assertions):
1. A reads `src/a.ts` and gets digest d0.
2. B writes `src/a.ts` with `base_digest = d0`; the response carries d1.
3. A writes `src/a.ts` with `base_digest = d0`.
4. A writes without `base_digest`.
4a. Through the production coding/edit-atom tool bindings in a real machine, dispatch std read on fixed src/a.ts fixture bytes; B then writes fixed replacement bytes; dispatch write, edit and apply_patch with the stale read. Repeat against the authenticated daemon path in S2. Do not call FileMutation or write_file directly or fake the guarded filesystem. Expected bytes and independently calculated digests are test fixtures, never derived from spec files or production code at runtime.
4b. Through the real coding/edit-atom apply_patch binding, exercise add, delete, update and move in S1 and through the authenticated daemon in S2. Change each read source or destination externally, create a formerly absent destination, and try an unread existing destination. Submit a two-file patch whose later hunk is stale; repeat with an outside replacement at exchange.
5. Open `/api/live` as A and subscribe to `doc:code:<branch>:src/a.ts` and `doc:wiki:<page>`.
6. Render the File card through CodeFileView; S3 editing is qualified by T-APP-14a.
7. (S2 re-run) Exercise the real daemon framing, capture flush phase, change event and presence heartbeat. T-COL-03a and T-COL-03 prove the connection and flush; T-COL-04a and T-COL-04 prove post_digest; T-COL-06 proves coordinates.

Pass when:
- Step 4b: every stale or unread affected path returns stale_read. Both move paths are validated; source removal is guarded. The later stale hunk leaves all earlier hunks byte-identical, no new destination and no removed source. Displaced-digest rollback preserves the outside writer’s bytes. No read-ledger or diagnostic update reports a successful refused patch.
- T-APP-15 branch identity: two File cards for the same repository path on different branches receive only their own branch machine’s literal hover, diagnostics and definition answers, including when the shell selects the other branch.
- Step 2 returns 200 and the file holds B's content.
- Step 3 returns `409 {code: "stale", current_digest: d1}`, and the file still holds B's content byte for byte.
- Step 4 returns 400.
- Step 4a: each agent write returns `stale_read` naming the path, and the file holds B's content byte for byte.
- Step 5 returns `{"t":"err","code":"unsupported"}` (§7.1) for both topics, and the socket stays open.
- Step 5's frames name the document only by its topic: no frame or error carries a machine, VM or relay address, so the browser never learns where the Yrs authority lives (§7.6).
- The ADR `docs/architecture/0003-live-code-co-editing.md` exists on `main` with the §7.6 contracts. Its topology decision (§7.4.2) is filled in from the T-COL-01 re-run before T-COL-08 starts.
- (S2) The daemon framing reserves a document stream kind, `capture()` reports a flush phase, `file_written` and burst events carry per-file `post_digest`, and presence `where` carries `{path, line}`.

Fail when:
- Any write succeeds without a digest, or a stale write changes the file. That is a silent overwrite.
- A reserved topic closes the socket.

- Integration (real PostgreSQL, real machine): correct base succeeds; a second actor's write makes the first actor's next write 409 and leaves bytes unchanged; missing base is 400; `"absent"` creates only a missing file; forbidden body fields are 400.
- `packages/smithers/agent/std/test/StaleRead.integration.test.ts`: real `coding/edit-atom` dispatcher; stale, unread, absent, own-write, reread and crash/resume cases; a two-file patch with a stale later hunk leaves the earlier hunk byte-identical. S2 repeats against the daemon socket.
- Fixed bytes and independently computed SHA-256 values; no expectation from production helpers.
- Per-file 100% coverage gates in `packages/smithers/agent/std/vitest.config.ts` for the edited std files.

## Acceptance
- [C-COL-01](../checks/C-COL-01.md), S1 and S2: stale app and agent writes are refused and the file is unchanged.
- [C-J1-04](../checks/C-J1-04.md): S1 part at its named layer.

## Risks and notes
- Compare-and-write must be atomic in the guest. If concurrent-write tests show a lost update, the compare moves into `smithers-machined` (T-COL-03) and the stage-1 window is documented.
- The guest compare runs through the root helper: it lands only after T-SEC-01's R1–R3 tests and `TestWorkspaceCompareWriteDropsPrivilegeAndConfinesPaths` pass.
- Resume loses the in-memory ledger, so the agent re-reads before its first write. If that costs more than one extra turn per file, journal the ledger with the run (smithers-8a decides).
