# T-COL-08 Live code document integration, fault recovery and reference-host p95

Stage S3 · Size M · Depends on T-COL-04, T-COL-08a, T-COL-08b, T-APP-14a, T-COL-10, T-COL-11 · Unblocks T-APP-14, T-COL-09, T-REL-01, T-REL-02 · Issue: [#3586](https://github.com/smithersai/smithers/issues/3586)
Spec: spec.md §7.1, §7.4.1–7.4.6, §7.6, §8.4.1, §8.4.3–8.4.4, §9.1.2 (`open_doc`, `close_doc`, `rebase`), §9.2.1–9.2.6, §9.3.4, §9.4.1–9.4.2, §18 · Delta: delta.md §4 (`smithers-machined` S3, live channel S3) · Product: mvp.md J3.5, §6.8 Live co-editing, §9 Live updates, M-02

## Goal

Two members with the same code file open see each other's characters within 1 s, each in the author's colour, with a name flag on each editor's line. Every keystroke is on disk, fsync'd, within 1 s and survives a restart. Agent, terminal and SSH writes merge into the document as attributed edits, and an outside save that overlaps unsaved typing never wins silently.

## Scope

In:
- Integrate T-COL-08a daemon documents, T-COL-08b relay or mirror, T-COL-04 production events and T-APP-14a’s built client. Preserve every behavior and test in the original document scope (§7.4, §9.2).
- Wire actual watcher attribution, versions, outside-change flags, capture flush and rewrite reconciliation.
- Run C-DUR-04 K7a–K7e, C-COL-03 S3, C-J3-04 and C-PERF-03 on the real stack.
Out:
- Rust document implementation (T-COL-08a), Go relay/mirror (T-COL-08b), provider and binding implementation (T-APP-14a).

## Changes

- The File card stops writing through `PUT …/workspaces/{id}/files/content` (`compose/router.go:1430`, `WriteWorkspaceFile` at `services/workspace_facets.go:244`). T-COL-10 gave that route its `base_digest` precondition (§7.6 row 1). Then:
  - if no Appendix A door still writes through it (`rg "files/content"`, today `apps/app/src/mainview/state/seams/WorkspaceSeam.ts` and `packages/smithers/src/internal/backend/ProductApi.ts`), delete the route, its consumers and its OpenAPI row (zero tech debt);
  - otherwise it stays as the one non-document write path, through the daemon's `write_file` (T-COL-03). A `write_file` to an open document applies as one document transaction (§9.4.1).
- `packages/backend/docs/machined.md`: a documents section. Run `docs:sync`, `docs:check` and `smthrs docs //packages/backend:docs`.
- Wire the T-COL-08a document hooks to T-COL-04 watcher, capture and production session attribution. T-COL-08b owns docrelay.go and conditional codedoc.go. T-APP-14a owns LiveDocProvider.ts.

## Tests

- Re-run T-COL-08a’s `documents.rs` and `yjs-interop.ts` cases on the real stack with the production watcher, host, session attribution and selected ADR topology.
- integration, real PostgreSQL (`packages/backend/internal/live/docrelay_integration_test.go`, new): a member without access to the branch can't subscribe, and a revoked member's subscription ends in ≤ 5 s.
- fault: C-DUR-04's stage-3 kill points K7a–K7e (daemon, VM or host killed before and after `saved`, between record and swap, an outside rewrite while down, and new-epoch recovery with retained edits).
- e2e: C-J3-04. perf: C-PERF-03.
- All interop and filesystem cases run with real watcher, real host and selected ADR topology. Fakes cannot satisfy full-check acceptance.
- C-PERF-03 uses T-APP-14a’s built provider and binding plus T-UI-19 visuals, real File cards on a second Mac and the reference Mac mini. This ticket gates final T-APP-14 integration; it does not wait for that final integration.

## Acceptance

- [C-J3-04](../checks/C-J3-04.md): two people co-edit one file in < 1 s, with author colours, name flags and saved within 1 s; an outside save merges in, or on overlap shows "Changed outside Smithers · Compare" with the outside version kept.
- [C-PERF-03](../checks/C-PERF-03.md): a keystroke reaches a remote File card in < 1 s p95 on the reference host.
- [C-DUR-04](../checks/C-DUR-04.md) K7a–K7d: no acknowledged keystroke is lost and none is duplicated across daemon, VM and host kills; K7e: new-epoch recovery retains unacknowledged edits and offers Reapply and Copy.
- [C-COL-03](../checks/C-COL-03.md): The mutation lock: rebase and Return to Tn with every writer active lose no write and let none land mid-rewrite; queued writes revalidate; a stale write never applies

## Risks and notes

- Character offsets: Yjs in the browser indexes UTF-16, and the wiki FFI chooses an `OffsetKind`. A mismatch corrupts text with emoji. Confirmed if the interop test diverges on astral characters.
- An outside save made from an older copy can remove document text that was already flushed: against the base, that removal doesn't overlap unsaved typing, so it applies. That is the replaced-edit case, whose flag is [D] (§9.3.7). The removed text stays recoverable as the burst's `before` version (M-27).
- The merge base survives a daemon restart in the state record (§9.2.5). Confirmed broken if C-DUR-04's K7d shows an outside rewrite while down misclassified as overlap, or authors of unchanged text lost.
- `renameat2(RENAME_EXCHANGE)` must work on the guest's working-copy filesystem. T-COL-01 probes it in W0. Confirmed broken if it returns `EINVAL`; then the tech lead decides before this ticket starts.
- Topology comes from ADR 0003 (T-COL-10's decision rule), recorded before this ticket starts. With the host mirror, this ticket also builds `packages/backend/internal/live/codedoc.go`: one mirror per open document that syncs with the daemon as a §7.4.6 client, relays `saved` unchanged, and rebuilds from the daemon after a host restart. The daemon stays the disk authority (§9.2). C-PERF-03 above 800 ms p95 after that choice goes to the tech lead.
