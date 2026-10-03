# T-APP-14 File card live co-editing

Stage S3 · Size M · Depends on T-COL-08, T-APP-14a · Unblocks T-REL-01, T-REL-02 · Issue: [#3585](https://github.com/smithersai/smithers/issues/3585)
Spec: spec.md §7.1, §7.1.1, §7.4, §7.6, §9.2, §14.3 (File [S3]), §14.7, §18 · Delta: delta.md §9 (Add [S3] File live co-edit … + Yjs binding with gutter flags) · Product: mvp.md J3.2, J3.5, §6.8 Live co-editing, Not in MVP (carets), M-02, M-24

## Goal
Two members with the same file open on a branch see each other's characters arrive in under 1 s in the author's colour, with a name flag on the line each is editing. The file saves to the machine continuously with no Save button, and an outside save that collides with typing shows "Changed outside Smithers · Compare" instead of disappearing.

## Ownership (Will, 2026-10-02)

Design (smithers-06) builds the co-editing visuals (author colours, gutter name flags, the saved state and the "Changed outside Smithers · Compare" flag), with the CSS, in T-UI-19. This ticket builds no View, CSS or editor presentation. T-APP-14a owns the topic decoder, fixture loader, adapter, Container, commands, Yjs provider and editor binding. This ticket owns final integration. The seam is the view model from T-APP-19 (spec §14.2.1).

## Scope

- M-34 participants have id, agent kind, avatar, run/session and optional `for_member`. Smithers, Coding agent, Claude Code, Codex and Reviewer each have their own avatar and show for Ben. The broker registers agent process lifetime; ordinary terminal commands remain person-channel activity. Adapt historical `via` actors. Participant ids grant no authorization rights. Checks: C-J3-04, C-J3-10.


- `EditorBinding` contains non-visual sync and own-edits UndoManager extensions and provides `authorRanges`. On reconnect to a recovered document with a new epoch, preserve unacknowledged text and expose `unsaved {count, text}`. **Reapply** (`file.reapply`) adds new member-attributed edits; Copy uses `copyText`. Check: C-J3-04. T-APP-14a implements this client rule; T-APP-14 verifies real integration.


In:
- Integrate T-APP-14a’s provider, binding, Container and commands with the real T-COL-08 stack and T-UI-19 visuals.
- Complete File card acceptance, real-topic schema and catalog-action checks.
Out:
- Provider and binding implementation and fake-relay tests (T-APP-14a); daemon documents and relay (T-COL-08a, T-COL-08b).

## Changes

- `apps/app/src/mainview/cards/containers/FileContainer.tsx` and `runtime/LiveDocProvider.ts`: integrate T-APP-14a’s implementation with the production live channel.
- Complete removal of the T-APP-11 reload and S2 Restore paths for live-editable files; retain read-only reload.

## Tests

- Re-run T-APP-14a’s provider, binding, saved-vector, recovery-buffer, outside-change and Container cases on the real stack.
- Integration (`apps/app/e2e/contracts/co-edit.spec.ts`, real host and machine): two providers make 1,000 interleaved edits, converge with disk, reconnect without loss, and merge or flag SSH writes.
- Run C-J3-04 through T-UI-19 visuals and C-UI-13 with real topics and catalog actions. Reuse T-COL-08’s C-PERF-03 evidence.

## Acceptance


- [C-J3-04](../checks/C-J3-04.md): two people co-edit one file in under 1 s with author colours and name flags, saved within 1 s; an outside save merges in, or on overlap shows "Changed outside Smithers · Compare" with the outside version kept.
- [C-UI-13](../checks/C-UI-13.md): A Container's model from a real topic parses with its schema and its actions come from `cardActions`; at each stage exit every §14.3 row of the stage is wired and no View is orphaned

## Risks and notes
- Risk: `y-codemirror.next`'s `yCollab` bundles remote selections. Falsified if the DOM of C-J3-04 contains a `.cm-ySelection` element; compose the sync extension alone.
- Risk: per-character authorship reads each `Y.Text` item's client id, which Yjs does not expose as public API. Pin `yjs` and test it; if it breaks on upgrade, record authors as text attributes instead (T-COL-10 decides).
- Risk: code intelligence answers against the file on disk, which trails the document by up to 1 s (§9.2.2). Falsified if a hover on a symbol typed 200 ms earlier returns the previous symbol.
