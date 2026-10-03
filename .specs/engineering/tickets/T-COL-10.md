# T-COL-10 Every file write carries `base_digest`; a stale write is refused

Stage S1, S2 · Size M · Depends on S1: T-FLW-01 · S2: T-COL-03 · Unblocks T-COL-03, T-COL-04, T-COL-05, T-COL-08, T-COL-11, T-REL-02 · Issue: [#3508](https://github.com/smithersai/smithers/issues/3508)
Spec: spec.md §7.6 (row 1), §9.1.2 (`write_file`), §9.2.2, §9.3.9 · Delta: delta.md §4 · Product: mvp.md §6.8 No silent overwrite and External changes, J3.4, M-02, M-27

Rescoped by the minimal-code synthesis, 2026-10-03 (v1 §3). Absorbs T-COL-10 ([#3507](https://github.com/smithersai/smithers/issues/3507)).

## Goal
Every write to a branch's files through Smithers, from the app or the coding agent, carries `base_digest`. A stale write is refused and changes nothing. The wiki keeps its Yjs text.

## Scope
In:
- The written rule in `docs/architecture/0003-live-code-co-editing.md`: one section, "every write carries `base_digest`; stale is refused". Its topology section says "decided by T-COL-11".
- S1: the app write route and the coding agent's std tools enforce the rule in the guest.
- S2: the agent's writes go through the daemon's `write_file` (T-COL-03) and the interim guest path is deleted.
- Lands dark until T-FLW-01: build against its machine-only coding binding; refuse agent mutations when that binding is unavailable. No host filesystem fallback.
- Lands dark until T-INS-02: refuse app and agent mutations without the isolated machine launcher. T-INS-02 is an enablement prerequisite, not a called code contract.
- Lands dark until T-SEC-01: refuse the guest compare-and-write until fresh and retained-machine R1–R3 receipts and `TestWorkspaceCompareWriteDropsPrivilegeAndConfinesPaths` pass. smithers-3f signs off the security gate.
- S2 lands dark until T-COL-03: refuse daemon writes without an authenticated connection and registered run. Until T-TRM-07 supplies the coding session, refuse unregistered agent writes; keep the qualified S1 guest path only during S1. Delete it at the S2 cutover. C-COL-01 tests each unavailable-provider refusal.

Out, moved to the ticket that first uses them:
- ADR 0004 wire contract, golden frames and the Go and Rust codecs: T-COL-03r (S2).
- Reserved `doc:*` topics and document stream frames: T-COL-08b (S3).
- The TS `LiveDoc.ts` contract and fake relay: T-COL-08b, built with T-APP-14a.
- `moved_off` refusal (T-COL-05), outside-change notes (T-COL-12), live documents (T-COL-08).
- File-card code intelligence and branch-identity qualification (T-APP-15), presence coordinates (T-COL-06), watcher post-digests (T-COL-04), capture flush and topology benchmarking (T-COL-11/T-COL-08). No editable File View or wiki protocol changes.

## Changes
Reshape:
- `packages/backend/internal/services/workspace_facets.go:244` `WriteWorkspaceFile` → takes `baseDigest` (SHA-256 or `"absent"`) and compares inside the guest write, one helper call (`packages/backend/microsandbox/guest/smithers-guest.py`). Add `digest` to `WorkspaceFileContent` (`:56`) on read and write responses.
- `PUT /workspaces/{id}/files/content` handler (handler at `packages/backend/internal/routes/workspace.go:470`, route at `packages/backend/internal/compose/router.go:1444`) → require `base_digest`; return `409 {code: "stale", current_digest}` on mismatch; actor from the authenticated principal plus `via`, as `workspaceFacetRouteContext` does; a body naming actor, branch, machine or uid is 400.
- `docs/api/openapi/*.yaml` → the same request, response and 409 shapes (`openapi_conformance_test.go`).
- Every caller of `files/content` in `apps/app` and `packages/smithers` → sends `base_digest`, reloads on 409. No blind write remains.
- `packages/smithers/agent/std/src/Read.ts`, `Write.ts`, `Edit.ts`, `ApplyPatch.ts`, `src/internal/ApplyPatch.ts`, `src/internal/FileMutation.ts` → reshape the guarded filesystem in `flows/coding/filesystem.ts` to hold one run-scoped read-digest ledger (the current adapter has no digest ledger); record the full file digest even for a paginated read; refuse a write whose base no longer matches, or an existing file never read. `apply_patch` validates every source and destination under the per-branch lock and rolls back the whole patch on a stale path.
- `packages/smithers/agent/std/src/StdError.ts:15` → add `stale_read` to the existing `Code` with path and both digests. No new error class.
- `packages/smithers/agent/std/docs/` → document `stale_read`; run the docs gates.

Reuse the existing write route, guarded filesystem, mutation locks, patch transaction and StdError. Add digest state and compare operations within those paths; no parallel ledger, error class or file-write protocol. ADR 0003 is a new document at the named path, which does not exist on main today.

## Tests

C-COL-01 (folded steps and assertions):
1. A reads `src/a.ts` and gets digest d0.
2. B writes `src/a.ts` with `base_digest = d0`; the response carries d1.
3. A writes `src/a.ts` with `base_digest = d0`.
4. A writes without `base_digest`.
4a. Through the production coding/edit-atom tool bindings in a real machine, dispatch std read on fixed src/a.ts fixture bytes; B then writes fixed replacement bytes; dispatch write, edit and apply_patch with the stale read. Repeat against the authenticated daemon path in S2. Do not call FileMutation or write_file directly or fake the guarded filesystem. Expected bytes and independently calculated digests are test fixtures, never derived from spec files or production code at runtime.
4b. Through the real coding/edit-atom apply_patch binding, exercise add, delete, update and move in S1 and through the authenticated daemon in S2. Change each read source or destination externally, create a formerly absent destination, and try an unread existing destination. Submit a two-file patch whose later hunk is stale; repeat with an outside replacement at exchange.
5. Through the composed authenticated GET/PUT `/api/repos/{owner}/{repo}/workspaces/{id}/files/content` routes, repeat steps 1–4 in a real machine with PostgreSQL; do not invoke the handler or service directly.

Pass when:
- Step 4b: every stale or unread affected path returns stale_read. Both move paths are validated; source removal is guarded. The later stale hunk leaves all earlier hunks byte-identical, no new destination and no removed source. Displaced-digest rollback preserves the outside writer’s bytes. No read-ledger or diagnostic update reports a successful refused patch.
- Step 2 returns 200 and the file holds B's content.
- Step 3 returns `409 {code: "stale", current_digest: d1}`, and the file still holds B's content byte for byte.
- Step 4 returns 400.
- Step 4a: each agent write returns `stale_read` naming the path, and the file holds B's content byte for byte.
- The ADR states the §7.6 stale-write contract and leaves the topology decision to T-COL-11. smithers-8a accepts the ADR; smithers-3f approves its guest/daemon seam.

Fail when:
- Any write succeeds without a digest, or a stale write changes the file. That is a silent overwrite.
- An unavailable or unqualified mutation provider falls back to an unconditional write or host execution.

- `TestWorkspaceFileContentCompareWrite` (new integration test at the composed authenticated HTTP route, real PostgreSQL, real machine): correct base succeeds; a second actor's write makes the first actor's next write 409 and leaves bytes unchanged; missing base is 400; `"absent"` creates only a missing file; forbidden body fields are 400.
- `packages/smithers/agent/std/test/StaleRead.integration.test.ts`: real `coding/edit-atom` dispatcher; stale, unread, absent, own-write, reread and crash/resume cases; a two-file patch with a stale later hunk leaves the earlier hunk byte-identical. S2 repeats against the daemon socket.
- Fixed bytes and independently computed SHA-256 values; no expectation from production helpers.
- Per-file 100% coverage gates in `packages/smithers/agent/std/vitest.config.ts` for the edited std files.

## Acceptance
- [C-COL-01](../checks/C-COL-01.md), S1 and S2: stale app and agent writes are refused and the file is unchanged.
- [C-J1-04](../checks/C-J1-04.md): S1 part at its named layer.

## Risks and notes
- Compare-and-write must be atomic in the guest, including an outside replacement between validation and exchange. If C-COL-01 shows a lost update, S1 writes stay disabled; smithers-3f approves the repair and smithers-8a decides any stage change. Do not enable an unsafe stage-1 window.
- M-29: repository code executes only inside machines as an unprivileged user. Preserve the guest helper's credential drop before parsing file operands or reading branch bytes; S2 working-copy writes run as `machined`, never the root broker. smithers-3f reviews both boundaries.
- Root entry input inventory for S1 compare-and-write: helper source, expected SHA-256, bootstrap, fixed `/usr/bin/env` and `/usr/bin/python3`, isolated interpreter flags, fixed PATH and cleared loader/Python environment come from the main-built install bundle and trusted guest image; machine ID, `fs` operation, fixed `agent` identity, workspace root, mode and size limits come from the host's main-installed runtime and authenticated provisioning. Passwd/group records, helper/interpreter ownership and modes, startup directory/ancestor metadata and kernel credential responses come from the guest image or retained machine and require validation. Relative source/destination paths, `base_digest`/`absent`, file or patch bytes, stdin, existing file bytes, modes and symlink/ancestor state are branch/member-sourced. Root may consume only the bounded envelope and fixed identity; drop uid/gid/groups before consuming branch operands or bytes. Branch-sourced root inputs block enablement unless `TestWorkspaceCompareWriteDropsPrivilegeAndConfinesPaths` proves validation before use; branch-built executable/helper/interpreter code is forbidden regardless of tests. The existing T-SEC-01 R1–R3 tests qualify installation and startup inputs.
- `TestWorkspaceCompareWriteDropsPrivilegeAndConfinesPaths` (C-COL-01): use the production HTTP route and real coding/edit-atom binding on fresh and retained machines; attempt traversal, symlink/ancestor swaps, identity injection, malformed digests, oversized input and branch-controlled startup environment. Assert the mutation child has the unprivileged uid/gid and no supplementary groups, outside files stay byte-identical, and unqualified providers refuse. Literal fixtures define expected bytes and digests. smithers-3f accepts these receipts.
- Resume loses the in-memory ledger, so the agent re-reads before its first write. If that costs more than one extra turn per file, journal the ledger with the run (smithers-8a decides).
- smithers-b8 signs off the public HTTP request/error contract and caller migration; smithers-38 accepts the std schema, digest-ledger lifetime and patch rollback seam. Owner review is post hoc under the 2026-10-03 directive; the questions below are the pre-review record, not claimed answers.

## Ready checklist
1. Depends on lists called contracts only: S1 T-FLW-01 coding binding; S2 T-COL-03 authenticated write_file. Scope names fail-closed dark gates for these contracts and launcher, root validation and coding-session enablement.
2. Out explicitly excludes document topics/codecs, relay, live editing, wiki changes, topology benchmarking, presence, watcher digests, code intelligence, moved_off and outside-change notes.
3. C-COL-01 uses the composed authenticated HTTP route and real coding/edit-atom dispatcher in machines; fixed bytes and independent SHA-256 fixtures define expectations. Missing providers, stale races and whole-patch rollback are tested at these boundaries.
4. smithers-8a accepts ADR 0003 and decides persistence or stage changes; smithers-3f approves atomicity and security seams; smithers-b8 signs off the public API; smithers-38 accepts std schemas and ledger/rollback semantics; T-COL-11 owns topology.
5. Owner pre-review record (post hoc review per directive): smithers-3f: Does credential drop precede every branch input? Does compare/exchange preserve outside bytes under races? Do unavailable providers fail closed? smithers-b8: Does the HTTP contract reject identity fields and missing bases? Do all callers handle 409 without blind retry? smithers-38: Does one run-scoped ledger cover full-file reads and reset on resume? Does patch rollback preserve outside writes and suppress success diagnostics? No UI View change is scoped; any View change requires smithers-06 to answer whether read-only behavior remains and handlers follow the existing action seam.
6. M-29 confines repository execution to unprivileged machine processes; the root input inventory names main/install and branch/member sources, forbidden executable inputs and validation tests. smithers-3f reviews the security gates before enablement.
