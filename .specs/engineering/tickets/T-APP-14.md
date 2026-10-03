# T-APP-14 File card live co-editing

Stage S3 · Size M · Depends on T-COL-08, T-APP-14a, T-UI-19, T-APP-11 · Unblocks T-REL-01, T-REL-02 · Issue: [#3585](https://github.com/smithersai/smithers/issues/3585)
Spec: spec.md §7.1, §7.1.1, §7.4, §7.6, §9.2, §14.3 (File [S3]), §14.7, §18 · Delta: delta.md §9 (Add [S3] File live co-edit … + Yjs binding with gutter flags) · Product: mvp.md J3.2, J3.5, §6.8 Live co-editing, Not in MVP (carets), M-02, M-24
Ready: 2026-10-03 smithers-8a sha256:9bd54fd7e3ef

## Goal
Two members with the same file open on a branch see each other's characters arrive in under 1 s in the author's colour, with a name flag on the line each is editing. The file saves to the machine continuously with no Save button, and an outside save that collides with typing shows "Changed outside Smithers · Compare" instead of disappearing.

## Ownership (Will, 2026-10-02)

Design (smithers-06) builds the co-editing visuals (author colours, gutter name flags, the saved state and the "Changed outside Smithers · Compare" flag), with the CSS, in T-UI-19. This ticket builds no View, CSS or editor presentation. T-APP-14a restores CodeMirror from `4a36b0cfb` and owns the File card file's live mode, the commands, the Yjs provider and the editor binding. This ticket owns final integration.

## Scope
- Build against the specified contracts; unlanded dependencies do not block Ready. Lands dark until T-COL-08: refuse live editing without an authorized document subscription and daemon save acknowledgments. Lands dark until T-APP-14a: keep the File card read-only without its provider, binding and command handlers. Lands dark until T-UI-19: keep live editing disabled without its visual extensions. Lands dark until T-APP-11: refuse Compare when the retained outside-version reader is unavailable. Never fall back to browser disk writes or report an unavailable operation as successful. Check: FileCards.test.tsx unavailable-contract cases below.
- Security preconditions: repository code, language servers, agent commands and SSH test writes execute only inside the branch machine, as non-root users without sudo (M-29). File contents are data, never host or browser executable code. Reuse the production branch authorizer and authenticated `/api/live` relay; actor and participant ids confer no rights. smithers-3f reviews this boundary. This ticket adds and invokes no root step; root input inventory is empty. Changes to privileged provisioning belong to its implementing ticket and require an inventory of every input and its main or branch source; a branch input blocks that step unless a named validation test passes. Check: real File-card access cases below.
- M-34 participants have id, agent kind, avatar, run/session and optional `for_member`. Smithers, Coding agent, Claude Code, Codex and Reviewer each have their own avatar and show for Ben. The broker registers agent process lifetime; ordinary terminal commands remain person-channel activity. Adapt historical `via` actors. Participant ids grant no authorization rights. Checks: C-J3-04, C-J3-10.
- `EditorBinding` contains non-visual sync and own-edits UndoManager extensions and provides `authorRanges`. On reconnect to a recovered document with a new epoch, preserve unacknowledged text and expose `unsaved {count, text}`. **Reapply** (`file.reapply`) adds new member-attributed edits; Copy uses `copyText`. Check: C-J3-04. T-APP-14a implements this client rule; T-APP-14 verifies real integration.

In:
- Integrate T-APP-14a’s provider, binding, File card file and commands with the real T-COL-08 stack and T-UI-19 visuals.
- Complete File card acceptance on the real stack.
Out:
- Provider and binding implementation and fake-relay tests (T-APP-14a); daemon documents and relay (T-COL-08a, T-COL-08b).
- New Views, CSS, visual extensions or copy (T-UI-19); a second provider, editor, presence roster or actor adapter; broker participant registration and process-lifetime tracking.
- Remote carets and selections, character-level SSH collaboration, project-wide refactoring, browser extensions or debugger, per-entry Undo and replaced-edit warnings (§16); host execution of repository code and root provisioning.

## Changes

- Reshape `apps/app/src/mainview/cards/FileCards.tsx` and its existing registration in `apps/app/src/mainview/cards/CardRenderers.tsx`: wire T-APP-14a's restored editor and provider to the production live channel and T-UI-19 props. Reuse `apps/app/src/mainview/runtime/LiveChannel.ts`; `apps/app/src/mainview/runtime/LiveDocProvider.ts` is a planned T-APP-14a file, absent today. Add no second client implementation.
- Reuse T-APP-11's Compare version reader for `file.compare`. Verify T-APP-14a's deletion of the S2 reload and Restore paths for live-editable files; retain read-only reload and the S3 document Restore action. Delete any remaining duplicate `CodeFileView` rendering in `apps/app/src/mainview/cards/CodeSurface.tsx` at cutover.

## Tests

- Re-run T-APP-14a’s provider, binding, saved-vector, recovery-buffer, outside-change and File card cases on the real stack.
- Extend `apps/app/src/mainview/cards/FileCards.test.tsx` through the production `CardRenderers` file registration and command dispatcher: each unavailable dependency leaves live editing disabled; unavailable Compare refuses without opening a fabricated version; neither case sends a file write or reports Saved. Expected modes and outcomes are test literals.
- E2E (`apps/app/e2e/real/file-coedit.spec.ts`, planned by C-J3-04, real host and machine): two signed-in members open `/file retry.ts` through the production dispatcher, type 1,000 interleaved edits into the mounted editor, converge with disk, reconnect without loss, and merge or flag SSH writes. Reuse the C-J3-04 journey rather than a second provider-only suite; the existing contracts directory has no co-edit test, and a fake relay cannot prove real-stack acceptance.
- In that real journey, exercise Compare, Reapply, Copy, own-edits Undo, deleted-file Restore and rename Follow through their mounted controls and registered commands; an epoch change retains unsaved edits until acknowledgment or successful Copy. Run the C-J3-04 timing, restart, attribution and read-only cases through T-UI-19 visuals. Reuse T-COL-08's C-PERF-03 evidence.
- Real File-card access cases in the same suite: a member without branch access cannot read, subscribe or edit; revocation ends the live subscription within 5 s; forged actor/client ids cannot write as another member. Use the production session, dispatcher and `/api/live`, not injected authorized providers.
- Expected text, authors, modes, refusals and timing limits are committed test literals or independently constructed input sequences. No test reads `.specs/` or derives expected values from production code.

## Acceptance
- [C-J3-04](../checks/C-J3-04.md): two people co-edit one file in under 1 s with author colours and name flags, saved within 1 s; an outside save merges in, or on overlap shows "Changed outside Smithers · Compare" with the outside version kept.
- [C-UI-13](../checks/C-UI-13.md): `CodeEditorView` is reachable from `CardRenderers` through `FileCards.tsx`; `CodeSurface.tsx`'s `CodeFileView` rendering is deleted.

## Risks and notes
- Will confirmed M-02 for S3 (spec §0, product M-02). Will decides product scope and copy; smithers-8a accepts integration contract changes and escalated timing failures. smithers-38 approves public TypeScript seams and the pinned Yjs authorship approach; smithers-3f approves authorization and daemon/relay seams. T-COL-11 owns ADR 0003; this ticket does not choose another topology.
- Risk: `y-codemirror.next`'s `yCollab` bundles remote selections. Falsified if the DOM of C-J3-04 contains a `.cm-ySelection` element; compose the sync extension alone.
- Risk: per-character authorship reads each `Y.Text` item's client id, which Yjs does not expose as public API. Pin `yjs` and test it; if it breaks on upgrade, smithers-38 and smithers-3f approve T-COL-08b's text-attribute fallback before changing the shared contract.
- Risk: code intelligence answers against the file on disk, which trails the document by up to 1 s (§9.2.2). Falsified if a hover on a symbol typed 200 ms earlier returns the previous symbol.

## Ready checklist
1. Dependencies: T-COL-08 supplies real document integration, T-APP-14a the client and commands, T-UI-19 the visual extensions, and T-APP-11 the Compare reader. All are S2 or S3; Scope states fail-closed dark landing for each unavailable contract, tested through FileCards.test.tsx.
2. Exclusions: Scope names implementation owners, visual work, duplicate clients and rosters, deferred editor features, SSH keystrokes, host execution and root provisioning.
3. Tests: C-J3-04 enters through `/file`, the production dispatcher, mounted File card and authenticated `/api/live`; action and access cases use the same boundaries. C-UI-13 uses its literal reachability table. Expectations never come from spec Markdown or production code.
4. Decisions: Will owns product scope/copy; smithers-8a accepts integration changes and timing escalations; smithers-38 approves public TS and authorship seams; smithers-3f approves security/backend seams; T-COL-11 owns the existing ADR topology.
5. Owner review: smithers-b8: Does FileCards use the existing dispatcher and one provider, including disabled contracts? Do Compare and recovery actions reach the registered commands? smithers-06: Does wiring pass the agreed props without adding presentation or remote selections? smithers-38: Are EditorBinding and File props compatible with the restored editor and pinned Yjs authorship contract? smithers-3f: Does the real relay enforce branch rights, revocation and actor binding? Do disk acknowledgments remain daemon-authoritative with repository execution confined to non-root machine users? Recorded owner answers stand; under Will's 2026-10-03 directive, owners review post hoc and unlanded contracts do not block Ready.
6. Security: Scope confines repository execution to non-root machine users, names smithers-3f, and forbids treating file text as executable host/browser code. Real access cases prove authorization, revocation and actor binding. This integration invokes no root step and consumes no root inputs; privileged provisioning changes require their own source inventory and validation test.

