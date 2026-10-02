# T-APP-11 File and Diff cards reload on change; deleted/renamed states; Restore this file; language server on the daemon

Stage S2 · Size M · Depends on T-COL-04, T-APP-15, T-UI-16, T-APP-19 · Unblocks — · Issue: to file
Spec: spec.md §7.2 (`branch:<id>:files`), §7.6, §8.4.4, §9.1.2 (`read_file`, `write_file`), §9.2 (stage-2 paragraph), §9.2.6, §9.3.4, §12.5.1, §14.3 (File, Diff), §18 · Delta: delta.md §4 (Add [S2] File and Diff cards reload on change events; Add [S1] §7.6 contracts) · Product: mvp.md J3.2, J3.4, §6.8 External changes, Live updates, M-02, M-27, Appendix A `/file`, `/files`, `/diff`

## Goal
An open File or Diff card on a branch shows each outside write (SSH editor, terminal tool, coding agent) within 1 s and names its writer. It says so when the file is deleted ("Deleted by Maya via SSH · Restore") or renamed ("Renamed to `deliver.ts` · Follow"), and an outside-change diff offers **Restore this file**, all on the same CodeMirror surface stage 3 co-edits.

## Ownership (Will, 2026-10-02)

Design (smithers-06) builds every visual component and its styles: the File and Diff card states: reload on change, deleted and renamed banners, Restore this file, Compare. Engineering wires them: `file_written` and burst wiring, `file.restore`, `file.compare`, `file.restore-deleted`, `file.follow-rename` commands. The seam is the card's view-model schema (spec §14.2.1, T-APP-19). Design builds against it with fixture stories, and engineering doesn't edit components or CSS.

## Scope
In:
- File card on `branch:<id>:files`, rendered by T-APP-15's read-only CodeMirror 6 view (`@smthrs/ui/adapters/code-editor`, `CodeEditorView`). In stage 2 the card is read-only for everyone (§9.2).
- Reload: a `file_written{path, actor, post_digest}` event for the card's path (§9.3.4) loads the content at that digest (§7.6) and applies it to the same `EditorView` as one minimal transaction, within 1 s of the write. No remount, so scroll position and the viewer's line survive. Events for other paths do nothing.
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
- `apps/app/src/mainview/cards/FileCards.tsx`: subscribe the file's topic, apply reloads, render gone states and Compare.
- `packages/smithers/ui/src/adapters/code-editor/` (from T-APP-15): add `replaceContent(next)` that dispatches one minimal-diff transaction and maps selection, and a read-only merge view for Compare.
- `apps/app/src/mainview/cards/ChangeCards.tsx`, `DiffSurface.tsx`: the branch-scoped Diff card with **Restore this file** per file on an outside-change diff; remove the line-comment affordance the mock draws.
- `apps/app/src/mainview/state/seams/FilesSeam.ts`, `DiffFilesSeam.ts`: read through `/api/branches/{b}/files` and `/diff` at a digest (§6.3), replacing `GET /workspaces/{id}/files/content` (`WorkspaceSeam.ts:1495`).
- `packages/rpc/src/Cards.ts`: the `file` payload gains `branch`, `digest` and `gone?`.
- `apps/app/src/mainview/flows/entries/files.ts`: the commands and the four in-card rows (T-CAT-01 registry).

## Tests
- Unit (`FileCards.test.tsx`): a change for this path reloads once and keeps the scroll line; one for another path does not; delete and rename banners name the actor; Follow rewrites the payload path.
- Unit: `file.restore-deleted` sends the actor and `base_digest = "absent"`; a 409 shows the current file and sends no second write.
- Unit: `file.restore` on a file unchanged since the burst sends one write; on a file changed since, it sends none and opens Compare.
- Integration (`apps/app/e2e/contracts/file-reload.spec.ts`, new, real backend and a machine): an SSH user's `rm` and `git mv` produce the two gone states; Restore puts the bytes back byte for byte; Restore this file after a formatter run restores one file and adds one activity entry by the presser.
- e2e: the C-J3-08 script and the Restore step of C-J3-03. Perf: C-PERF-04 (n ≥ 100 outside writes, browser clock against the change event's commit time).

## Acceptance
- [C-J3-08](../checks/C-J3-08.md): a file deleted or renamed while open says so, and Restore and Follow work.
- [C-PERF-04](../checks/C-PERF-04.md): an outside disk write reaches an open File card in under 1 s p95.
- [C-UI-11](../checks/C-UI-11.md) (release run): hover, definition and diagnostics still work on an awake branch, and a sleeping branch stays asleep.
- [C-UI-13](../checks/C-UI-13.md): A Container's model from a real topic parses with its schema and its actions come from `cardActions`; at each stage exit every §14.3 row of the stage is wired and no View is orphaned

## Risks and notes
- The stage-2 surface is T-APP-15's CodeMirror 6 `EditorView`; stage 3 adds `y-codemirror.next`'s sync extension to that same view (§7.6). Reloads here are plain transactions; in S3 they arrive as Yjs updates, and `replaceContent` stays only for read-only files over 1 MiB (§9.2.1).
- Risk: the reload races a second write and shows stale bytes. Falsified if, after 50 writes 20 ms apart, the card's final content digest differs from the file's.
