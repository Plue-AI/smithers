# T-APP-11 File and Diff cards reload on change; deleted/renamed states; Restore this file; language server on the daemon

Stage S2 · Size M · Depends on T-COL-04, T-APP-15, T-UI-16, T-APP-19, T-APP-22 · Unblocks T-APP-10, T-REL-02 · Issue: [#3556](https://github.com/smithersai/smithers/issues/3556)
Spec: spec.md §7.2 (`branch:<id>:files`), §7.6, §8.4.4, §9.1.2 (`read_file`, `write_file`), §9.2 (stage-2 paragraph), §9.2.6, §9.3.4, §12.5.1, §14.3 (File, Diff), §18 · Delta: delta.md §4 (Add [S2] File and Diff cards reload on change events; Add [S1] §7.6 contracts) · Product: mvp.md J3.2, J3.4, §6.8 External changes, Live updates, M-02, M-27, Appendix A `/file`, `/files`, `/diff`

## Goal
An open File or Diff card on a branch shows each outside write (SSH editor, terminal tool, coding agent) within 1 s and names its writer. It says so when the file is deleted ("Deleted by Maya via SSH · Restore") or renamed ("Renamed to `deliver.ts` · Follow"), and an outside-change diff offers **Restore this file**, all on the same CodeMirror surface stage 3 co-edits.

## Ownership (Will, 2026-10-02)

Design (smithers-06) builds the File and Diff states: reload, deleted and renamed, Restore this file, Compare, with the CSS, in T-UI-16 (on T-UI-11's `CodeEditorView` and `DiffView`). This ticket builds no View, CSS or editor presentation. It owns the topic decoder and golden fixture, the adapter, the Container and the commands in Changes ([card-kinds.md §1](../card-kinds.md)), plus the language server's move onto the daemon. The seam is the view model from T-APP-19 (spec §14.2.1).

## Scope
In:
- File card on `branch:<id>:files`, rendered by T-UI-11's read-only `CodeEditorView` (CodeMirror 6). In stage 2 the card is read-only for everyone (§9.2).
- Reload: a `file_written{path, actor, post_digest}` event for the card's path (§9.3.4) loads the content at that digest (§7.6) and hands the View the new `text` and `digest` once, within 1 s of the write. The View applies it as one minimal transaction with no remount, so scroll position and the viewer's line survive (T-UI-16). Events for other paths do nothing.
- Header: the file's last writer (T-APP-09 actor), including "changed outside Smithers" (§9.3.1).
- In-card controls (mvp.md Appendix B.4), each a catalog row with a stable id and `agent: run` (§6.1.2):
  - **Restore this file** (`file.restore`, §9.3.5) on an outside-change diff: puts one file back to its content at the burst's `snapshot_before`, attributed to the person who pressed it, through T-COL-04's service. If the file changed again since that burst, it writes nothing and opens Compare instead.
  - **Compare** (`file.compare`): a read-only side-by-side of a snapshot version and the current file. In S2, Restore opens it; in S3 the "Changed outside Smithers" flag opens it against the live document (T-APP-14).
  - **Restore** (`file.restore-deleted`, §9.2.6) on "Deleted by <actor>": rewrites the content from the last snapshot before the delete, `read_file(path, at = snapshot_before)` then `write_file(path, "absent", content, actor)`. A `409 stale` (someone re-created the file) shows the current file and writes nothing.
  - **Follow** (`file.follow-rename`) on "Renamed to <path> by <actor>": moves the same card to the new path.
- Diff card on `branch:<id>:files` (`@pierre/diffs`): an item branch's hunks against the previous item's candidate (§12.5.1); a scratch branch's against its fork revision (§8.5.3). It reloads on change events and shows per-file last writers (§7.2). The mock's per-hunk authors (`Code.tsx:106-110`) aren't in the model and aren't built.
- A sleeping branch's File and Diff read the captured snapshot and never wake it (§8.4.4).
- Code intelligence survives stage 2: the File card's language server runs on the branch machine as a daemon `exec` session owned by the member who asked (§9.1.2), replacing the `workspace/sessions` kind `lsp` path in `state/CloudLspClient.ts`. A sleeping branch starts none, and the gestures bind nothing there (§8.4.4).
- Commands: `/file <path>` (`files.read`), `/files` (`files.list`), `/diff` (`change.diff`), branch-scoped.

Out:
- Editing, Yjs, name flags, per-character authors, "Saved to the machine" and the S3 flag (T-APP-14).
- The CodeMirror surface and code intelligence (T-APP-15); the watcher, bursts, change events and the restore service (T-COL-04).
- [D] Line comments on the diff (§12.5.3); "save replaced an edit" flags and per-entry Undo (§9.3.5–9.3.7).

## Changes
- `packages/rpc/src/topics/Files.ts` (new): the `branch:<id>:files` decoder, also used by T-APP-10. `packages/rpc/test/fixtures/topics/branch-files.json` (new): the golden, compared by a Go golden test with T-COL-04's builder.
- `apps/app/src/mainview/cards/containers/fileModel.ts` (new): `toFileModel(files, content, path)` gives text, digest, the last writer through `toActor`, `gone`, `renamed_to` and `outside`, with the actions Restore this file (on an outside-change diff), Compare, Restore (deleted) and Follow (renamed); `toDiffModel(...)` gives the hunks against the previous item's candidate, or a scratch branch's fork revision, with per-file last writers.
- `apps/app/src/mainview/cards/containers/FileContainer.tsx` (T-APP-15) and `DiffContainer.tsx` (new): subscribe the topic and load content at a digest through `/api/branches/{b}/files` and `/diff` (§6.3), once per `file_written` for this path; render `CodeEditorView` with the T-UI-16 states and `DiffView`.
- `apps/app/src/mainview/state/seams/FilesSeam.ts` and `DiffFilesSeam.ts`: read at a digest through those routes, replacing `GET /workspaces/{id}/files/content` (`WorkspaceSeam.ts:1495`).
- `packages/rpc/src/FileCard.ts` (T-APP-19) carries `branch`, `digest`, `gone` and `outside`. Keep `file` live; pinned rows decode through card-kinds.md L4. Check: C-CUT-02.
- `apps/app/src/mainview/flows/entries/files.ts`: `/file <path>`, `/files` (opens the retained `file-list` card, branch-scoped), `/diff`, and the four in-card rows (T-CAT-01 registry).
- `apps/app/src/mainview/state/CloudLspClient.ts`: the language server runs as a daemon `exec` session owned by the member who asked (§9.1.2), replacing the `workspace/sessions` kind `lsp` path.

## Tests
- Unit (`fileModel.test.ts`): a change for this path yields one new text; one for another path yields none; the deleted and renamed states name the actor; Follow's action carries the new path.
- Unit, same file: `file.restore-deleted` sends the actor and `base_digest = "absent"`; a 409 yields the current file and no second write.
- Unit, same file: `file.restore` on a file unchanged since the burst sends one write; on a file changed since, it sends none and opens Compare.
- Unit (`FileContainer.test.tsx`, fake topic): after 50 writes 20 ms apart, the model's digest equals the file's.
- Unit: every `Action.label` and `disabled.reason` the adapter emits passes C-UI-02's `lintText` (engineering's copy; the View's copy is its T-UI ticket's).
- Integration (`apps/app/e2e/contracts/file-reload.spec.ts`, new, real backend and a machine): an SSH user's `rm` and `git mv` produce the two gone states; Restore puts the bytes back byte for byte; Restore this file after a formatter run restores one file and adds one activity entry by the presser; the Go golden test equals the golden.
- e2e: the C-J3-08 script and the Restore step of C-J3-03 through the T-UI-16 Views. Perf: C-PERF-04 (n ≥ 100 outside writes, browser clock against the change event's commit time).
- Scroll and line survival across a reload, the banners and the Compare layout are T-UI-16's.

## Acceptance


- [C-J3-08](../checks/C-J3-08.md): a file deleted or renamed while open says so, and Restore and Follow work.
- [C-PERF-04](../checks/C-PERF-04.md): an outside disk write reaches an open File card in under 1 s p95.
- [C-UI-11](../checks/C-UI-11.md) (release run): hover, definition and diagnostics still work on an awake branch, and a sleeping branch stays asleep.
- [C-UI-13](../checks/C-UI-13.md): A Container's model from a real topic parses with its schema and its actions come from `cardActions`; at each stage exit every §14.3 row of the stage is wired and no View is orphaned

## Risks and notes
- The stage-2 surface is T-UI-11's `CodeEditorView`; stage 3 adds `y-codemirror.next`'s sync extension to the same view (T-APP-14, §7.6). Reloads here are new `text` props; in S3 they arrive as Yjs updates, and text reloads stay only for read-only files over 1 MiB (§9.2.1).
- Risk: the reload races a second write and shows stale bytes. The `FileContainer` test with 50 writes 20 ms apart falsifies it.
