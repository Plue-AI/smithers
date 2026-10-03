# T-COL-08a Daemon Yrs documents and durable disk reconciliation

Stage S3 · Size L · Depends on T-COL-10, T-COL-03r · Unblocks T-COL-08, T-REL-02 · Issue: [#3629](https://github.com/smithersai/smithers/issues/3629)
Spec: spec.md §7.1, §7.4.1–7.4.6, §7.6, §8.4.1, §8.4.3–8.4.4, §9.1.2 (`open_doc`, `close_doc`, `rebase`), §9.2.1–9.2.6, §9.3.4, §9.4.1–9.4.2, §18 · Delta: delta.md §4 (`smithers-machined` S3, live channel S3) · Product: mvp.md J3.5, §6.8 Live co-editing, §9 Live updates, M-02

## Goal

Build daemon documents against the Rust fake host without waiting for backend change events.

## Scope

The behavioral requirements below describe the complete protocol. This ticket implements only the daemon side. T-COL-08b implements subscriber authorization, Go envelopes and the optional mirror; T-APP-14a implements wake requests, the provider and editor actions. Fixtures supply those peers here.

In:
- Document host in `smithers-machined` (§9.2), one Yrs document per `(branch, path)` with one `Y.Text("content")`, opened and closed through `open_doc`/`close_doc` (§9.1.2):
  - It opens on the first subscriber. UTF-8 files up to 1 MiB are editable; larger or binary files open read-only as "too large to co-edit".
  - It closes 60 s after the last subscriber, after a final save (§9.2.5). Its state record, with per-character authors, stays on the machine disk outside the working copy at `/var/lib/smithers/docs/<path digest>`, so authors survive reopening. On open, including after a daemon restart, the record is reconciled with the file: as saved, an interrupted save finished from the record, or an outside write merged against the record's text (§9.2.5). Only a missing or unreadable record reseeds from the file, with a new epoch (§7.4.6). The disk stays the truth for what is saved.
- **Document → disk** (§9.2.2, §9.2.3a): save 200 ms after the last update, at least once a second while updates continue, in §9.2.2's order: state record (temp, `fsync`, `rename`, directory `fsync`), then the text to `.smithers-doc-<path digest>-<random>` with `fsync`, then `renameat2(RENAME_EXCHANGE)` (`RENAME_NOREPLACE` if absent) and a directory `fsync`. A displaced file whose digest isn't `last_disk_digest` is an outside write: keep it open, re-read it after 200 ms without writes (2 s at most), and reconcile it (§9.2.3). The mode is kept; the owner becomes `machined`. Record `last_disk_digest` and keep that text as the merge base.
  - Only then does the daemon send `saved{sv}` (§7.4.6), the saved state's state vector, which drives "Saved to the machine" for each client's own updates. An acknowledged save survives a restart of the machine or the install. Clients keep updates no `saved` covers and resend them in sync step 2 after a reconnect. On reconnect to a recovered document with a different epoch, retain those updates and show "N edits weren't saved" with Reapply and Copy. Reapply adds them as new attributed edits to the recovered document; Copy copies their text (§9.2.5, C-DUR-04 K7e).
  - The daemon's own writes are excluded from watcher bursts by path and post-write digest, the matching T-COL-04a uses for writes through Smithers. inotify carries no pid, so this is how §9.2.2's "tagged by pid" is met. Document edits get their own activity entries instead: one per editor per 2 s idle period, for example "Alice edited `retry.ts`".
- **Disk → document** (§9.2.3–9.2.4). Trigger: an outside write completing on an open path (`IN_CLOSE_WRITE` or `IN_MOVED_TO`, never `IN_MODIFY`), or a displaced file from a save. Under the mutation lock the daemon reads the path's current bytes; equal to `last_disk_digest` means nothing to do. Otherwise it merges three ways: base = the text of its last save, ours = the live document, theirs = the bytes read, and the outside burst records those bytes as the path's version (§9.3.4).
  - No overlap: the outside changes apply as one transaction attributed to the outside actor (T-COL-04a's exact, session or `{outside: true}` actor), built in a scratch document with that actor's stable client id from `Y.Map("authors")`. Readers see it within 1 s.
  - Overlap: the live document wins on disk. The outside version is its burst's `after` version (§9.3.4). The daemon applies the non-overlapping outside hunks, saves the document, and flags the file "Changed outside Smithers · Compare". The flag and that version go on `branch:<id>:files`; `file.compare` (T-APP-14a) opens it beside the document.
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
- Wiki pages (T-COL-09) and the File card client (T-APP-14a).
- Carets and selections (cut, mvp.md §6.8).
- Per-entry Undo, command names and replaced-edit flags (§9.3.5–9.3.7 [D]).
- Rebase scheduling (T-STK-11).
- Component boundary: inject watcher/session events and recorded versions using Linux fixtures; T-COL-08 integrates T-COL-04a’s production watcher. Consume T-COL-10 document envelopes and saved/epoch schemas.

## Changes

- `crates/smithers-machined/Cargo.toml`: pin `yrs = "=0.27.4"`, matching `crates/smithers-ffi/Cargo.toml:35`. Share the Rust Yjs sync-protocol codec with `smithers-ffi`; T-COL-09 is its second user. ADR `docs/architecture/0003-live-code-co-editing.md` records this choice.

- `crates/smithers-machined/src/doc/` (new): `host.rs` (documents, sync, close timer), `disk.rs` (flush with file and directory fsync), `merge.rs` (three-way merge, overlap detection, outside snapshot), `reconcile.rs` (minimal edit), `state.rs` (Yrs state under `/var/lib/smithers/docs/`), `authors.rs`, `gone.rs`.

- All provider and editor code belongs to T-APP-14a. All Go relay and mirror code belongs to T-COL-08b.

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

- Contract: Rust fake host replays golden sync, actor, saved, epoch, gone and backpressure frames; run the same vectors against the real daemon document codec.
- Component faults: K7a, K7c and K7d with real disk and fake host; full daemon/VM/host and client-recovery matrix is T-COL-08.

## Acceptance

- C-COL-03: document lock and rewrite component cases.
- C-DUR-04: durable-record and same-epoch component evidence. C-J3-04 and C-PERF-03 stay with real integration.

## Risks and notes

- Keep UTF-16 interop, displacement reconciliation and persistent author-map tests.
- No backend or watcher-completion dependency. Fixtures must supply the same attribution and versions interfaces as T-COL-04a.

