# T-APP-14 File card live co-editing

Stage S3 · Size L · Depends on T-COL-08, T-APP-15, T-UI-19, T-APP-19 · Unblocks T-REL-01 · Issue: to file
Spec: spec.md §7.1, §7.1.1, §7.4, §7.6, §9.2, §14.3 (File [S3]), §14.7, §18 · Delta: delta.md §9 (Add [S3] File live co-edit … + Yjs binding with gutter flags) · Product: mvp.md J3.2, J3.5, §6.8 Live co-editing, Not in MVP (carets), M-02, M-24

## Goal
Two members with the same file open on a branch see each other's characters arrive in under 1 s in the author's colour, with a name flag on the line each is editing. The file saves to the machine continuously with no Save button, and an outside save that collides with typing shows "Changed outside Smithers · Compare" instead of disappearing.

## Ownership (Will, 2026-10-02)

Design (smithers-06) builds every visual component and its styles: co-editing visuals: author colours, gutter name flags, the Saved state, the "Changed outside Smithers · Compare" flag. Engineering wires them: the `y-codemirror.next` binding, the live document provider, awareness, save acknowledgements. The seam is the card's view-model schema (spec §14.2.1, T-APP-19). Design builds against it with fixture stories, and engineering doesn't edit components or CSS.

## Scope
In:
- Bind `y-codemirror.next`'s sync extension to the File card's CodeMirror 6 `EditorView` from T-APP-15 (same surface as T-APP-11) on the reserved topic `doc:code:<branch>:<path>`, using binary kinds 1 (sync) and 2 (awareness) of the live channel (§7.4.1, §7.6). The document is `Y.Text("content")` (§9.2.1).
- One client Yjs provider over the live channel: sync step 1 and 2, updates, awareness, and a restart from step 1 when the server signals backpressure (§7.1.1). T-COL-09 reuses it for the wiki (§7.4.1 "one client provider").
- Per-character author colours from `Y.Map("authors")` (client id → actor, §7.4.4): each member's lane colour, the coding agent's brand colour. Outside writes from SSH, terminals and the agent merge in as attributed edits when they don't overlap unsaved typing (§9.2.3).
- The outside-change flag (§9.2.3): when `branch:<id>:files` carries `outside_change` for the path, the header shows "Changed outside Smithers · Compare". **Compare** (`file.compare`, in-card, `agent: run`) opens the kept outside snapshot beside the live document in T-APP-11's Compare view.
- Awareness `{actor, colour, line}` only. A gutter name flag per remote editor's line; no remote carets or selections (§7.4.5, mvp.md §6.8 Cut). The editor's line also feeds presence `{path, line}` (§7.6).
- Header: editors' avatars and the saved state, driven only by the daemon's `{saved_digest, saved_at}` (§9.2.2): "Saving…" while this client has updates the last `saved_digest` doesn't include, "Saved to the machine" once it does. The daemon sends it only after `fsync`, so "Saved" means on disk and surviving a restart (§9.2.3a). The client never infers it from a timer.
- Editor undo (⌘Z) reverts only the member's own edits (a Yjs `UndoManager` tracking the local client id); CodeMirror's own history is off, so one member never undoes another's typing.
- Files over 1 MiB or not UTF-8 stay read-only with "too large to co-edit" and keep T-APP-11's reload path (§9.2.1).
- Gone states move to the document semantics (§9.2.6): a delete pauses editing and **Restore** (`file.restore-deleted`) rewrites the last document text; a rename shows **Follow** (`file.follow-rename`), which reopens the document at the new path.
- No browser file write exists: every disk write goes through `smithers-machined`'s document host with the actor and `base_digest` (§7.6, §9.2.2).

Out:
- The document host, disk reconcile and flush in the daemon (T-COL-08); the wiki's move to this transport (T-COL-09).
- "Ben's save replaced Alice's edit · Restore" flags ([D] §9.3.7); line comments ([D] §12.5.3); carets and selections (cut).
- Vim editing in the File card: §14.7 keeps input modes as built, and none of today's editors has a Vim mode; mvp.md §6.4 says input modes don't gate acceptance.

## Changes
- `packages/smithers/ui/package.json`: add `y-codemirror.next` and `y-protocols`; `yjs` is already pinned at 13.6.32 in `apps/app/package.json:62` and moves to one shared pin.
- `packages/smithers/ui/src/adapters/code-editor/` (T-APP-15): a `collab` option that installs the sync extension without remote selections, author decorations, gutter flags and the own-edits undo.
- `apps/app/src/mainview/runtime/LiveDocProvider.ts` (new) and test, over `runtime/LiveChannel.ts`.
- `apps/app/src/mainview/cards/FileCards.tsx`, `CodeSurface.tsx`: editable when the document is live; header editors and saved state; S3 gone states.
- Delete the T-APP-11 reload transaction for live-editable files and its S2 Restore path (`snapshot_before` read); keep the reload only for read-only files (zero tech debt).

## Tests
- Unit (`code-editor` adapter): two client ids in one `Y.Text` render two author colours; awareness for a remote line renders one flag and no selection element; ⌘Z after a remote edit reverts only the local one.
- Unit: a 1.2 MiB file and a binary file open read-only with "too large to co-edit".
- Unit: the header shows "Saved to the machine" only when a received `saved_digest` covers every local update; a delayed `saved_digest` keeps "Saving…" past 1 s rather than guessing.
- Unit: an `outside_change` delta renders the flag; Compare opens the snapshot and the document side by side; the flag clears when the files topic drops it.
- Integration (`apps/app/e2e/contracts/co-edit.spec.ts`, new, real host and machine): two providers make 1,000 interleaved edits and converge byte for byte with the file on disk; a socket drop and reconnect resyncs without loss; an SSH user's `sed -i` on another line appears as one attributed edit; the same on the line being typed raises the flag and leaves the typed text.
- e2e: the C-J3-04 script. Perf: C-PERF-03 (run by T-COL-08).

## Acceptance
- [C-J3-04](../checks/C-J3-04.md): two people co-edit one file in under 1 s with author colours and name flags, saved within 1 s; an outside save merges in, or on overlap shows "Changed outside Smithers · Compare" with the outside version kept.
- [C-UI-13](../checks/C-UI-13.md): A Container's model from a real topic parses with its schema and its actions come from `cardActions`; at each stage exit every §14.3 row of the stage is wired and no View is orphaned

## Risks and notes
- Risk: `y-codemirror.next`'s `yCollab` bundles remote selections. Falsified if the DOM of C-J3-04 contains a `.cm-ySelection` element; compose the sync extension alone.
- Risk: per-character authorship reads each `Y.Text` item's client id, which Yjs does not expose as public API. Pin `yjs` and test it; if it breaks on upgrade, record authors as text attributes instead (T-COL-10 decides).
- Risk: code intelligence answers against the file on disk, which trails the document by up to 1 s (§9.2.2). Falsified if a hover on a symbol typed 200 ms earlier returns the previous symbol.
