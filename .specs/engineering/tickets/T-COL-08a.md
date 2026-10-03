# T-COL-08a Daemon Yrs documents and durable disk reconciliation

Stage S3 · Size L · Depends on T-COL-03r, T-COL-08b · Unblocks T-COL-08 · Issue: [#3629](https://github.com/smithersai/smithers/issues/3629)
Spec: spec.md §7.1, §7.4.1–7.4.6, §7.6, §8.4.1, §8.4.3–8.4.4, §9.1.2 (`open_doc`, `close_doc`, `rebase`), §9.2.1–9.2.6, §9.3.4, §9.4.1–9.4.2, §18 · Delta: delta.md §4 (`smithers-machined` S3, live channel S3) · Product: mvp.md J3.5, §6.8 Live co-editing, §9 Live updates, M-02

## Goal

Build daemon documents against the Rust fake host without waiting for backend change events.

## Scope

The behavioral requirements below describe the complete protocol. This ticket implements only the daemon side. T-COL-08b implements subscriber authorization, Go envelopes and the optional mirror; T-APP-14a implements wake requests, the provider and editor actions. Fixtures supply those peers here. Consume only T-COL-03r hook traits and T-COL-08b document schemas; production core, watcher, broker, scheduler and editor wiring belongs to T-COL-08.

Lands dark until T-COL-03r: missing codec or dispatcher hooks refuse `unsupported` before opening a document. Lands dark until T-COL-08b: missing authenticated document envelopes or saved/epoch schemas refuse `unsupported`; never accept a caller-supplied actor or use a local wire format. Build against both specified contracts while they are unavailable.

Lands dark until T-COL-03a/T-COL-03 and T-COL-04a/T-COL-04 are integrated by T-COL-08: refuse production document opens without the authenticated machine connection, branch mutation lock, capture/rewrite hooks, attribution and recorded-version provider. Do not substitute fixtures in production. Lands dark until T-COL-11: missing ADR 0003 topology decision or passing openat2/renameat2/cgroup probes keeps production co-editing disabled; no host filesystem or privileged fallback. T-COL-08 verifies these activation gates.

In:
- ADR 0004 `open_doc(path)` returns a stream id; `close_doc(stream)` closes it. T-COL-08b may add a path for logs without changing the stream selector. Check: C-COL-01.
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
- Rebase (§9.4.2): the document part of `rebase(onto)` and `return_to_item()`. Edits keep applying in memory while the lock holds saves; afterwards each open document reconciles from disk as one transaction attributed "Rebased onto Tk", keeping unsaved typing. T-STK-08 schedules it.
- The first keystroke in a File card on a sleeping branch requests a `person` wake (§8.4.4). Until the machine is awake the card stays read-only.

Out:
- Wiki pages (T-COL-09) and the File card client (T-APP-14a).
- Carets and selections (cut, mvp.md §6.8).
- Per-entry Undo, command names and replaced-edit flags (§9.3.5–9.3.7 [D]).
- Rebase scheduling (T-STK-08), production capture/rewrite/broker implementation (T-COL-03a), machine provisioning and root startup/session/freeze operations. This ticket supplies document hooks only; T-COL-08 integrates them.
- Host mirror, Go authorization and relay (T-COL-08b), browser provider, wake requests, recovery UI and Restore/Follow/Compare command wiring (T-APP-14a); no new UI Views, CLI or public TypeScript exports.
- A second Yrs core, new presence protocol, per-write kernel attribution, language servers, and kernel fallbacks.
- Component boundary: inject watcher/session events and recorded versions using Linux fixtures; T-COL-08 integrates T-COL-04a’s production watcher. Consume T-COL-08b's document envelopes and saved/epoch schemas.

## Changes

- `crates/smithers-machined/Cargo.toml`: pin `yrs = "=0.27.4"`, matching `crates/smithers-ffi/Cargo.toml:35`. Reshape the existing FFI update encode/decode and UTF-16 document setup into the shared core; add Yjs sync-message framing only where that core lacks it. Preserve the wiki FFI entry point and its interop tests. T-COL-11 owns the topology decision in `docs/architecture/0003-live-code-co-editing.md`; this ticket does not create a competing ADR.
- One Yrs core (minimal-code synthesis, 2026-10-03, v2 layers): reshape the document setup and update integration in `crates/smithers-ffi/src/wiki_document.rs:53` (`execute`, UTF-16 offsets, `apply`) into a module both crates import, parameterized by the text name (`markdown` for wiki, `content` for code). `smithers-machined` writes no second Yrs document core.

- Extend T-COL-03r’s crate and hook traits with `crates/smithers-machined/src/doc/` (planned, absent on inspected main): `host.rs` (documents, sync, close timer), `disk.rs` (flush with file and directory fsync), `merge.rs` (three-way merge, overlap detection, outside snapshot), `reconcile.rs` (minimal edit), `state.rs` (Yrs state under `/var/lib/smithers/docs/`), `authors.rs`, `gone.rs`. New persistence, merge, attribution and lifecycle adapters are needed because `wiki_document.rs` returns serialized wiki state and has no machine filesystem, save cadence, author map or document lifetime. They use the extracted core rather than reimplementing it. Extraction must parameterize allowed roots as well as the text name: keep the wiki’s existing single-root validation and permit the code document’s `content` and `authors` roots.

- All provider and editor code belongs to T-APP-14a. All Go relay and mirror code belongs to T-COL-08b.

## Tests

Component acceptance enters T-COL-03r’s production RPC dispatcher with `open_doc`, `close_doc`, `write_file`, `capture`, `rebase` and `return_to_item`, and the production document-stream decoder with T-COL-08b actor envelopes. Inject only the peer, watcher/version and core-operation hook implementations. Direct calls to merge/reconcile helpers are unit evidence only. Pin golden bytes, actor ids, texts, digests, epochs, limits and timing thresholds in independent test fixtures; no test reads spec files or derives expected outcomes from production encoders/constants at runtime.

- unit (`reconcile.rs`): a property test over 10,000 random (old, new) pairs, including multi-byte and astral characters, shows that applying the edit to doc(old) gives exactly new. The edit touches only changed lines.
- unit (`merge.rs`): a property test over random (base, ours, theirs) triples: without overlap the result contains both sides' changes; with overlap the result equals ours plus theirs' non-overlapping hunks, and theirs is returned for the snapshot.
- unit (`authors.rs`): an actor's client id is stable across reopen. A forged client id is rejected.
- interop (`crates/smithers-machined/tests/yjs-interop.ts`, new, modelled on `crates/smithers-ffi/tests/wiki-yjs-interop.ts`): two `yjs 13.6.32` clients and the daemon converge under 1,000 interleaved concurrent edits.
- component integration, real Linux filesystem with injected completed-write events and attribution/version hooks (`crates/smithers-machined/tests/documents.rs`, planned):
  - flush cadence: 200 ms debounce and at most 1 s under continuous typing;
  - mode and group are preserved, and the owner is `machined`;
  - an outside write with a fixture-supplied member session actor that does not overlap unsaved typing lands as one transaction attributed to that member; real SSH attribution is T-COL-08;
  - an outside save over a line with unsaved typing leaves the disk equal to the document, the outside version as its burst's `after`, and the "Changed outside Smithers" flag;
  - after `saved` is acknowledged, killing and restarting the daemon leaves the acknowledged text on real disk; VM/host kills are T-COL-08’s K7b;
  - close, reopen: per-character authors are unchanged; an outside rewrite while closed reconciles as an outside edit, and unchanged text keeps its authors;
  - ordering (test hook delaying the watcher by 2 s, 200 runs): an outside save landing before the debounce fires, during the swap, and after it each ends with the outside version merged or kept as its burst's `after`, never lost; an in-place writer mid-write at the swap is read after it goes quiet;
  - `saved{sv}` arrives only after the record and the file are durable, and a client counts an update saved only when `sv` covers it;
  - a client holding an old document reconnects after a daemon restart and converges with no duplicated character; an old-epoch fixture receives the changed epoch without its updates being applied to the recovered document; recovery UI, Reapply and Copy are T-APP-14a/T-COL-08’s C-DUR-04 K7e;
  - a no-op write with an identical digest produces no transaction;
  - the daemon's own flushes produce no watcher burst, and typing gives one activity entry per editor per 2 s idle period;
  - delete and rename give the gone states; fixture Restore enters `write_file`, and fixture Follow enters `close_doc`/`open_doc`; app commands remain T-APP-14a;
  - a 2 MiB file opens read-only;
  - close happens at 60 s.

- Contract: Rust fake host replays golden sync, actor, saved, epoch, gone and backpressure frames; run the same vectors against the real daemon document codec.
- Component faults: K7a, K7c and K7d through production document dispatch with real disk and fake host; full daemon/VM/host and client-recovery matrix is T-COL-08.
- `DocumentDispatchFailsClosed`: exercise every missing contract/provider/ADR/kernel gate through production dispatch; no document opens, write, saved acknowledgment or host fallback occurs.
- `DocumentDispatchConfinement`: through production `open_doc`, stream update, save and `write_file` dispatch, reject escaping paths, swapped symlinks, non-regular files, unauthenticated envelopes and forged client ids. Assert no bytes outside `/workspace` or the daemon-controlled document store change. Record effective uid and machine identity; repository test code and document operations run inside a preprovisioned machine as non-root. No root broker is started by this component harness.

## Acceptance

- C-COL-03: document lock and rewrite component cases.
- C-DUR-04: durable-record and same-epoch component evidence. C-J3-04 and C-PERF-03 stay with real integration.

## Risks and notes

- Keep UTF-16 interop, displacement reconciliation and persistent author-map tests.
- No backend or watcher-completion dependency. Fixtures must supply the same attribution and versions interfaces as T-COL-04a.
- smithers-3f accepts daemon hook, disk, wire and security seams; smithers-38 accepts the shared FFI/core extraction and preservation of wiki behavior. smithers-8a accepts ADR 0003 after the T-COL-11 owner reviews, and decides kernel or performance remedies after smithers-3f review. Will approves changes to product budgets or disk authority. No remedy enables a fallback before its checks pass.

## Security preconditions and root inputs

Repository code executes only inside machines as non-root (M-29); members and agents have no sudo. Document decoding, state records, working-copy reads/writes, merge and capture/rewrite document hooks run as `machined`, never root (§9.5). Use descriptor-relative `openat2` confinement, regular-file checks and a daemon-controlled state-store directory; branch paths or symlinks cannot select state-store destinations. Accept actors only from the authenticated host envelope. smithers-3f reviews these preconditions; `DocumentDispatchConfinement` and `DocumentDispatchFailsClosed` prove the component behavior.

This ticket adds and runs no root step. Its component harness uses an already provisioned machine and injected broker/core hooks; it does not install, bootstrap, start a root broker, launch privileged sessions or freeze cgroups. Root input inventory here is empty. Production startup, session and freeze/thaw inputs, their main/branch provenance, and validation tests are owned by T-COL-03a/T-COL-03 and T-COL-08’s Security preconditions and root inputs section. Activation stays off until T-COL-08’s `TestLiveDocumentTrustedStartup` and `TestLiveDocumentBrokerInputs` pass. Branch-built binaries, interpreters, helpers and scripts never run as root.

## Ready checklist

1. Dependencies: T-COL-03r supplies consumed dispatcher/hooks/codecs and T-COL-08b supplies consumed document schemas; both are S2/S3. Scope defines fail-closed dark landing for unavailable contracts and production activation providers without adding switch-on edges.
2. Exclusions: wiki/client work, mirror/relay, wake and recovery UI, production broker/core/watcher integration, scheduling, cut/deferred editor features and second cores/protocols are explicit. Changes reshape the existing FFI core; each new adapter states the missing capability.
3. Boundary tests: component tests enter production RPC/document dispatch with independent literal fixtures; DocumentDispatchFailsClosed and DocumentDispatchConfinement cover negative paths. C-COL-03’s folded component matrix and C-DUR-04 K7a/c/d supply component evidence; full-stack C-J3-04/C-PERF-03 and K7b/e remain T-COL-08.
4. Decisions: smithers-3f accepts daemon/disk/wire/security seams; smithers-38 accepts FFI extraction; smithers-8a accepts ADR and kernel/performance remedies after owner review; Will approves product-contract changes.
5. Owner pre-review (recorded answers stand; owners review post hoc under Will’s directive): smithers-3f: Do dispatcher hooks preserve one mutation lock and durable acknowledgment ordering? Do confinement and dark gates refuse before side effects? Does this component harness avoid all root operations? smithers-38: Does extraction preserve wiki root validation, UTF-16 offsets and pending updates? Do wiki and code import one core without a second implementation? No apps/ or UI View changes are owned here.
6. Security: smithers-3f reviews machine-only non-root execution, authenticated actors and descriptor confinement. This component owns no root step or root inputs; production privileged activation requires the named T-COL-08 provenance/validation tests.


