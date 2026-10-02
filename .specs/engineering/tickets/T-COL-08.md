# T-COL-08 Live code documents: state record and durable acknowledgment; disk reconcile in either order; gone states

Stage S3 · Size L · Depends on T-COL-02, T-COL-04, T-COL-10 (ADR 0003's topology decision recorded first) · Unblocks T-COL-09, T-APP-14, T-REL-01 · Issue: to file
Spec: spec.md §7.1, §7.4.1–7.4.6, §7.6, §8.4.1, §8.4.3–8.4.4, §9.1.2 (`open_doc`, `close_doc`, `rebase`), §9.2.1–9.2.6, §9.3.4, §9.4.1–9.4.2, §18 · Delta: delta.md §4 (`smithers-machined` S3, live channel S3) · Product: mvp.md J3.5, §6.8 Live co-editing, §9 Live updates, M-02

## Goal

Two members with the same code file open see each other's characters within 1 s, each in the author's colour, with a name flag on each editor's line. Every keystroke is on disk, fsync'd, within 1 s and survives a restart. Agent, terminal and SSH writes merge into the document as attributed edits, and an outside save that overlaps unsaved typing never wins silently.

## Scope

In:
- Document host in `smithers-machined` (§9.2), one Yrs document per `(branch, path)` with one `Y.Text("content")`, opened and closed through `open_doc`/`close_doc` (§9.1.2):
  - It opens on the first subscriber. UTF-8 files up to 1 MiB are editable; larger or binary files open read-only as "too large to co-edit".
  - It closes 60 s after the last subscriber, after a final save (§9.2.5). Its state record, with per-character authors, stays on the machine disk outside the working copy at `/var/lib/smithers/docs/<path digest>`, so authors survive reopening. On open, including after a daemon restart, the record is reconciled with the file: as saved, an interrupted save finished from the record, or an outside write merged against the record's text (§9.2.5). Only a missing or unreadable record reseeds from the file, with a new epoch (§7.4.6). The disk stays the truth for what is saved.
- **Document → disk** (§9.2.2, §9.2.3a): save 200 ms after the last update, at least once a second while updates continue, in §9.2.2's order: state record (temp, `fsync`, `rename`, directory `fsync`), then the text to `.smithers-doc-<path digest>-<random>` with `fsync`, then `renameat2(RENAME_EXCHANGE)` (`RENAME_NOREPLACE` if absent) and a directory `fsync`. A displaced file whose digest isn't `last_disk_digest` is an outside write: keep it open, re-read it after 200 ms without writes (2 s at most), and reconcile it (§9.2.3). The mode is kept; the owner becomes `machined`. Record `last_disk_digest` and keep that text as the merge base.
  - Only then does the daemon send `saved{sv}` (§7.4.6), the saved state's state vector, which drives "Saved to the machine" for each client's own updates. An acknowledged save survives a restart of the machine or the install. Clients keep updates no `saved` covers and resend them in sync step 2 after a reconnect. On reconnect to a recovered document with a different epoch, retain those updates and show "N edits weren't saved" with Reapply and Copy. Reapply adds them as new attributed edits to the recovered document; Copy copies their text (§9.2.5, C-DUR-04 K7e).
  - The daemon's own writes are excluded from watcher bursts by path and post-write digest, the matching T-COL-04 uses for writes through Smithers. inotify carries no pid, so this is how §9.2.2's "tagged by pid" is met. Document edits get their own activity entries instead: one per editor per 2 s idle period, for example "Alice edited `retry.ts`".
- **Disk → document** (§9.2.3–9.2.4). Trigger: an outside write completing on an open path (`IN_CLOSE_WRITE` or `IN_MOVED_TO`, never `IN_MODIFY`), or a displaced file from a save. Under the mutation lock the daemon reads the path's current bytes; equal to `last_disk_digest` means nothing to do. Otherwise it merges three ways: base = the text of its last save, ours = the live document, theirs = the bytes read, and the outside burst records those bytes as the path's version (§9.3.4).
  - No overlap: the outside changes apply as one transaction attributed to the outside actor (T-COL-04's exact, session or `{outside: true}` actor), built in a scratch document with that actor's stable client id from `Y.Map("authors")`. Readers see it within 1 s.
  - Overlap: the live document wins on disk. The outside version is its burst's `after` version (§9.3.4). The daemon applies the non-overlapping outside hunks, saves the document, and flags the file "Changed outside Smithers · Compare". The flag and that version go on `branch:<id>:files`; `file.compare` (T-APP-14) opens it beside the document.
  - Terminal and SSH writes arrive this way. A `write_file` (the agent's write tool, `file.restore`) to an open path compares `base_digest` with the document's text and applies as one document transaction attributed to its actor (§9.4.1).
- Protocol (§7.4.1): Yjs sync step 1/2, updates and awareness in binary kinds 1/2 on topic `doc:code:<branch>:<path>`, the names T-COL-02 reserved.
  - The host authenticates each subscriber (co-edit permission, §5.2) and tags its updates with the subscriber's actor. With documents in the daemon (ADR 0003), the host forwards frames unparsed on the daemon's document stream (the kind T-COL-03 reserved) inside an envelope that names the actor. With the host mirror, the mirror syncs with the daemon over that stream as a §7.4.6 client and relays `saved` unchanged; browsers see the same frames either way (§7.6).
  - The side browsers sync with rejects an update that carries structs for a client id not allocated to that subscriber's actor, so author colours can't be forged (§7.4.4).
- Awareness carries `{actor, colour, line}` only (§7.4.5). The `line` uses T-COL-06's `{path, line}` coordinates.
- `branch:<id>:files` carries per open document `{path, saved_digest, saved_at, editors[{actor, line}], outside_change?: {version, by}}` (§7.2, §14.3 File [S3]).
- Gone states (§9.2.6):
  - a delete sets `gone{deleted, by}` and pauses editing; **Restore** (`file.restore-deleted`) rewrites the last document text;
  - a rename inside the working copy sets `gone{renamed, to, by}`; **Follow** (`file.follow-rename`) reopens the document at `to`.
- `capture()` flush phase and safe-idle: every document flushed (§8.4.1, §8.4.3).
- Rebase (§9.4.2): the document part of `rebase(onto)` and `return_to_item()`. Edits keep applying in memory while the lock holds saves; afterwards each open document reconciles from disk as one transaction attributed "Rebased onto Tk", keeping unsaved typing. T-STK-11 schedules it.
- The first keystroke in a File card on a sleeping branch requests a `person` wake (§8.4.4). Until the machine is awake the card stays read-only.

Out:
- Wiki pages (T-COL-09) and the File card UI (T-APP-14).
- Carets and selections (cut, mvp.md §6.8).
- Per-entry Undo, command names and replaced-edit flags (§9.3.5–9.3.7 [D]).
- Rebase scheduling (T-STK-11).

## Changes

- `crates/smithers-machined/src/doc/` (new): `host.rs` (documents, sync, close timer), `disk.rs` (flush with file and directory fsync), `merge.rs` (three-way merge, overlap detection, outside snapshot), `reconcile.rs` (minimal edit), `state.rs` (Yrs state under `/var/lib/smithers/docs/`), `authors.rs`, `gone.rs`.
- `crates/smithers-machined/Cargo.toml`: `yrs = "=0.27.4"`, the same pin as `crates/smithers-ffi/Cargo.toml:35`. ADR 0003 (T-COL-10) records one Rust Yjs sync-protocol codec shared with `crates/smithers-ffi`; T-COL-09 is its second user.
- `packages/backend/internal/live/docrelay.go` (new): subscribe, authorize and envelope. On overflow of the 2 MiB budget, the document restarts sync step 1 (§7.1.1).
- `apps/app/src/mainview/runtime/LiveDocProvider.ts` (new): the one Yjs provider over `LiveChannel` for both document kinds (§7.4.1), with `yjs 13.6.32`. T-APP-14 binds it to the CodeMirror 6 File card (T-APP-15) through `y-codemirror.next` (§7.6 row 3).
- The File card stops writing through `PUT …/workspaces/{id}/files/content` (`compose/router.go:1430`, `WriteWorkspaceFile` at `services/workspace_facets.go:244`). T-COL-10 gave that route its `base_digest` precondition (§7.6 row 1). Then:
  - if no Appendix A door still writes through it (`rg "files/content"`, today `apps/app/src/mainview/state/seams/WorkspaceSeam.ts` and `packages/smithers/src/internal/backend/ProductApi.ts`), delete the route, its consumers and its OpenAPI row (zero tech debt);
  - otherwise it stays as the one non-document write path, through the daemon's `write_file` (T-COL-03). A `write_file` to an open document applies as one document transaction (§9.4.1).
- `packages/backend/docs/machined.md`: a documents section. Run `docs:sync`, `docs:check` and `smthrs docs //packages/backend:docs`.

## Tests

- unit (`reconcile.rs`): a property test over 10,000 random (old, new) pairs, including multi-byte and astral characters, shows that applying the edit to doc(old) gives exactly new. The edit touches only changed lines.
- unit (`merge.rs`): a property test over random (base, ours, theirs) triples: without overlap the result contains both sides' changes; with overlap the result equals ours plus theirs' non-overlapping hunks, and theirs is returned for the snapshot.
- unit (`authors.rs`): an actor's client id is stable across reopen. A forged client id is rejected.
- interop (`crates/smithers-machined/tests/yjs-interop.ts`, new, modelled on `crates/smithers-ffi/tests/wiki-yjs-interop.ts`): two `yjs 13.6.32` clients and the daemon converge under 1,000 interleaved concurrent edits.
- integration, real filesystem and inotify (`crates/smithers-machined/tests/documents.rs`, new):
  - flush cadence: 200 ms debounce and at most 1 s under continuous typing;
  - mode and group are preserved, and the owner is `machined`;
  - an SSH-uid write that doesn't overlap unsaved typing lands as one transaction attributed to that member;
  - an outside save over a line with unsaved typing leaves the disk equal to the document, the outside version as its burst's `after`, and the "Changed outside Smithers" flag;
  - after "saved" is acknowledged, killing the VM and the host and restarting both leaves the acknowledged text on disk;
  - close, reopen: per-character authors are unchanged; an outside rewrite while closed reconciles as an outside edit, and unchanged text keeps its authors;
  - ordering (test hook delaying the watcher by 2 s, 200 runs): an outside save landing before the debounce fires, during the swap, and after it each ends with the outside version merged or kept as its burst's `after`, never lost; an in-place writer mid-write at the swap is read after it goes quiet;
  - `saved{sv}` arrives only after the record and the file are durable, and a client counts an update saved only when `sv` covers it;
  - a client holding an old document reconnects after a daemon restart and converges with no duplicated character; a client on an old epoch retains unacknowledged edits, shows "N edits weren't saved", reapplies them as new attributed edits or copies them (C-DUR-04 K7e);
  - a no-op write with an identical digest produces no transaction;
  - the daemon's own flushes produce no watcher burst, and typing gives one activity entry per editor per 2 s idle period;
  - delete and rename give the gone states, and Restore and Follow work;
  - a 2 MiB file opens read-only;
  - close happens at 60 s.
- integration, real PostgreSQL (`packages/backend/internal/live/docrelay_integration_test.go`, new): a member without access to the branch can't subscribe, and a revoked member's subscription ends in ≤ 5 s.
- fault: C-DUR-04's stage-3 kill points K7a–K7e (daemon, VM or host killed before and after `saved`, between record and swap, an outside rewrite while down, and new-epoch recovery with retained edits).
- e2e: C-J3-04. perf: C-PERF-03.

## Acceptance

- [C-J3-04](../checks/C-J3-04.md): two people co-edit one file in < 1 s, with author colours, name flags and saved within 1 s; an outside save merges in, or on overlap shows "Changed outside Smithers · Compare" with the outside version kept.
- [C-PERF-03](../checks/C-PERF-03.md): a keystroke reaches a remote File card in < 1 s p95 on the reference host.
- [C-DUR-04](../checks/C-DUR-04.md) K7a–K7d: no acknowledged keystroke is lost and none is duplicated across daemon, VM and host kills; K7e: new-epoch recovery retains unacknowledged edits and offers Reapply and Copy.

## Risks and notes

- Character offsets: Yjs in the browser indexes UTF-16, and the wiki FFI chooses an `OffsetKind`. A mismatch corrupts text with emoji. Confirmed if the interop test diverges on astral characters.
- An outside save made from an older copy can remove document text that was already flushed: against the base, that removal doesn't overlap unsaved typing, so it applies. That is the replaced-edit case, whose flag is [D] (§9.3.7). The removed text stays recoverable as the burst's `before` version (M-27).
- The merge base survives a daemon restart in the state record (§9.2.5). Confirmed broken if C-DUR-04's K7d shows an outside rewrite while down misclassified as overlap, or authors of unchanged text lost.
- `renameat2(RENAME_EXCHANGE)` must work on the guest's working-copy filesystem. T-COL-01 probes it in W0. Confirmed broken if it returns `EINVAL`; then the tech lead decides before this ticket starts.
- Topology comes from ADR 0003 (T-COL-10's decision rule), recorded before this ticket starts. With the host mirror, this ticket also builds `packages/backend/internal/live/codedoc.go`: one mirror per open document that syncs with the daemon as a §7.4.6 client, relays `saved` unchanged, and rebuilds from the daemon after a host restart. The daemon stays the disk authority (§9.2). C-PERF-03 above 800 ms p95 after that choice goes to the tech lead.
