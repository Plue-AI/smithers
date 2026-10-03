# T-APP-14a File card client against the TS fake relay

Stage S3 · Size M · Depends on T-COL-10, T-APP-15, T-UI-19, T-APP-19 · Unblocks T-APP-14, T-COL-08, T-COL-09, T-REL-02 · Issue: [#3628](https://github.com/smithersai/smithers/issues/3628)
Spec: spec.md §7.1, §7.1.1, §7.4, §7.6, §9.2, §14.3 (File [S3]), §14.7, §18 · Delta: delta.md §9 (Add [S3] File live co-edit … + Yjs binding with gutter flags) · Product: mvp.md J3.2, J3.5, §6.8 Live co-editing, Not in MVP (carets), M-02, M-24

## Goal
Two members with the same file open on a branch see each other's characters arrive in under 1 s in the author's colour, with a name flag on the line each is editing. The file saves to the machine continuously with no Save button, and an outside save that collides with typing shows "Changed outside Smithers · Compare" instead of disappearing.

## Ownership (Will, 2026-10-02)

Design (smithers-06) builds the co-editing visuals (author colours, gutter name flags, the saved state and the "Changed outside Smithers · Compare" flag), with the CSS, in T-UI-19. This ticket builds no View, CSS or editor presentation. It owns the topic decoder and golden fixture loader, the adapter, the Container and the commands in Changes ([card-kinds.md §1](../card-kinds.md)), plus the Yjs provider and the editor binding. The seam is the view model from T-APP-19 (spec §14.2.1).

## Scope
In:
- Build the client in Wave A against T-COL-10’s TS fake relay. T-COL-08 uses the completed client for real-stack p95; T-APP-14 owns final integration.
- Bind `y-codemirror.next`'s sync extension to the File card's CodeMirror 6 `EditorView` from T-APP-15 (same surface as T-APP-11) on the reserved topic `doc:code:<branch>:<path>`, using binary kinds 1 (sync) and 2 (awareness) of the live channel (§7.4.1, §7.6). The document is `Y.Text("content")` (§9.2.1).
- One client Yjs provider over the live channel: sync step 1 and 2, updates, awareness, and a restart from step 1 when the server signals backpressure (§7.1.1). T-COL-09 reuses it for the wiki (§7.4.1 "one client provider").
- Per-character authors from `Y.Map("authors")` (client id → actor, §7.4.4): the Container passes the map through `toActor`, and T-UI-19 colours each author (lane colour; the coding agent's brand colour). Outside writes from SSH, terminals and the agent merge in as attributed edits when they don't overlap unsaved typing (§9.2.3).
- The outside-change flag (§9.2.3): when `branch:<id>:files` carries `outside_change` for the path, the header shows "Changed outside Smithers · Compare". **Compare** (`file.compare`, in-card, `agent: run`) opens the kept outside snapshot beside the live document in T-APP-11's Compare view.
- Awareness carries `{actor, line}` only, and the Container passes `editors[] {actor, line}`; T-UI-19 draws one gutter name flag per remote editor's line and no carets or selections (§7.4.5, mvp.md §6.8 Cut). The editor's line also feeds presence `{path, line}` (§7.6).
- The saved state comes only from `saved{sv}` (§7.4.6): `saving` while this client has updates the vector does not cover, `saved` once it covers their client-id clocks. `saved_digest` and `saved_at` are file metadata, not update acknowledgements. The client never infers saved state from a timer. T-UI-19 renders "Saving…" and "Saved to the machine".
- Editor undo (⌘Z) reverts only the member's own edits (a Yjs `UndoManager` tracking the local client id); CodeMirror's own history is off, so one member never undoes another's typing.
- Files over 1 MiB or not UTF-8 stay read-only with "too large to co-edit" and keep T-APP-11's reload path (§9.2.1).
- Gone states move to the document semantics (§9.2.6): a delete pauses editing and **Restore** (`file.restore-deleted`) rewrites the last document text; a rename shows **Follow** (`file.follow-rename`), which reopens the document at the new path.
- No browser file write exists: every disk write goes through `smithers-machined`'s document host with the actor and `base_digest` (§7.6, §9.2.2).

Out:
- The document host, disk reconcile and flush in the daemon (T-COL-08); the wiki's move to this transport (T-COL-09).
- "Ben's save replaced Alice's edit · Restore" flags ([D] §9.3.7); line comments ([D] §12.5.3); carets and selections (cut).
- Vim editing in the File card: §14.7 keeps input modes as built, and none of today's editors has a Vim mode; mvp.md §6.4 says input modes don't gate acceptance.

## Changes
- `packages/smithers/ui/package.json`: add `y-codemirror.next` and `y-protocols`; `yjs` is pinned at 13.6.32 in `apps/app/package.json:62` and moves to one shared pin.
- `apps/app/src/mainview/runtime/LiveDocProvider.ts` (new) and test, over `runtime/LiveChannel.ts`.
- `apps/app/src/mainview/cards/containers/liveDoc.ts` (new): the `EditorBinding` the File Container hands `CodeEditorView` (the seam module `packages/smithers/ui/src/adapters/code-editor/seam.ts`, ui-components.md § T-UI-19): the `y-codemirror.next` sync extension without remote selections, a Yjs `UndoManager` that tracks only the local client id, and the `authorRanges` facet built from each `Y.Text` item's client id; plus the model's `authors[]` (through `toActor`), `editors[]` from awareness, `saved` and `unsaved`. CodeMirror's own history is off.
- `apps/app/src/mainview/cards/containers/FileContainer.tsx` (T-APP-11): live when the document is live; the S3 gone states through document semantics; the outside-change flag from `branch:<id>:files`; read-only with `too_large` for files over 1 MiB or not UTF-8.
- `LiveDocProvider` keeps the client's recovery buffer (§9.2.5a, §7.4.6): every local update no `saved` covers. On reconnect it resends them; when they can't merge, an epoch change included, the model carries `unsaved {count, text}` and a Reapply action that re-adds them as new edits attributed to the member; Copy uses `copyText`. The buffer stays until Reapply is acknowledged or Copy succeeds.
- Delete the T-APP-11 text reload for live-editable files and its S2 Restore path (`snapshot_before` read); keep the reload only for read-only files (zero tech debt).

## Tests
- Unit (`LiveDocProvider.test.ts`, fake socket): a reconnect to the same epoch resends the unacknowledged updates once; a new epoch keeps them, sets `unsaved` with their count, and Reapply submits them as new attributed edits; the buffer clears only on Reapply's acknowledgment or a successful Copy.
- Unit (`liveDoc.test.ts`): two client ids in one `Y.Text` yield two author entries; a remote awareness line yields one editor entry; the extension list has no remote-selection plugin; ⌘Z after a remote edit reverts only the local edit.
- Unit (`FileContainer.test.tsx`): a 1.2 MiB file and a binary file give a read-only model with `too_large`.
- Unit, same file: saved is true only when a received `saved{sv}` covers every local client-id clock; a delayed vector keeps saving past 1 s. A matching file digest alone never acknowledges an update.
- Unit, same file: an `outside_change` delta sets `outside`; Compare's action opens the snapshot beside the document; `outside` clears when the files topic drops it.
- Integration (`apps/app/e2e/contracts/co-edit.spec.ts`, new, TS fake relay): two providers make 1,000 interleaved edits and converge byte for byte with the file on disk; a socket drop and reconnect resyncs without loss; an SSH user's `sed -i` on another line appears as one attributed edit; the same on the line being typed raises the flag and keeps the typed text.
- Contract: the TS fake relay loads and replays T-COL-10 golden frames byte for byte for sync, actor, awareness, saved, epoch and backpressure. Real C-J3-04 and C-PERF-03 evidence belongs to T-COL-08 and T-APP-14.
- Author colours, gutter flags and the saved text are T-UI-19's.

## Acceptance

- Provider, binding and Container component tests pass against the TS fake relay. C-J3-04 and C-UI-13 complete on the real stack in T-APP-14; fake results are component evidence.

## Risks and notes
- Risk: `y-codemirror.next`'s `yCollab` bundles remote selections. Falsified if the DOM of C-J3-04 contains a `.cm-ySelection` element; compose the sync extension alone.
- Risk: per-character authorship reads each `Y.Text` item's client id, which Yjs does not expose as public API. Pin `yjs` and test it; if it breaks on upgrade, record authors as text attributes instead (T-COL-10 decides).
- Risk: code intelligence answers against the file on disk, which trails the document by up to 1 s (§9.2.2). Falsified if a hover on a symbol typed 200 ms earlier returns the previous symbol.
