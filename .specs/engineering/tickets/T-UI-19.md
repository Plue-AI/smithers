# T-UI-19 Co-editing visuals

Stage S3 · Size M · Depends on T-UI-01, T-APP-14a, T-COL-06, T-CAT-01 · Unblocks T-APP-14, T-COL-08, T-MNT-02, T-MNT-04 · Issue: [#3589](https://github.com/smithersai/smithers/issues/3589)
Spec: spec.md §14.2.1, §7.3, §7.6, §14.3 (File S3) · Delta: delta.md §9 · Product: mvp.md J3.2, J8, §6.8 · Props: written by this ticket when S3 starts
Ready: 2026-10-03 smithers-8a sha256:ee8f3976b0ea

## Goal

The co-editing visuals exist on `CodeEditorView`, which T-APP-14a restores from `4a36b0cfb`, as props-only visual extensions matching the design mock, so the wiring ticket only binds data and actions.

## Ownership (Will, 2026-10-02)

Design (smithers-06) owns visuals and copy approval. smithers-b8 owns the app binding seam; smithers-38 approves any public TypeScript API diff under spec §21.1. smithers-8a accepts spec or props changes; Will decides product scope. Engineering wires it in T-APP-14 and reviews nothing visual. Design reviews engineering's wiring when idle. The Ready checklist records owner pre-review questions; under Will's 2026-10-03 directive, recorded owner answers stand and owners review post hoc.

## Scope

In:
- On `CodeEditorView` in live mode: install the `EditorBinding` extensions; author colours from the `authorRanges` facet and `authors`; gutter name flags from `editors`, agents included; the Saved state; and "N edits weren't saved" with Reapply and Copy. Design writes every visual extension, and engineering's binding (T-APP-14) adds none.
- Props: reuse `packages/rpc/src/FileCard.ts`'s existing `authors`, `editors`, `saved` and `unsaved` fields. Extend the app-local `CodeEditorView` props with T-APP-14a's `EditorBinding`; keep this nonserializable extension outside the RPC schema. Update the existing File props section in ui-components.md; add no second File model.
- Name flags draw awareness `{actor, line}` and presence from T-COL-06's reuse of `packages/smithers/flows/sync/src/BranchPresence.ts` (a person-or-agent kind and a location); no new presence system (v1 §4). Before writing presence rendering, check `2753d2e3` for deleted client presence code.
- Stories for every state the props allow, light and dark, desktop and 390 px.
- Land dark against the specified contracts while any unlabeled dependency is unlanded: T-UI-01 primitives, T-APP-14a binding, T-COL-06 presence or T-CAT-01 actions/copy gate. Keep live extensions unmounted in production until their required props and action descriptors exist; retain the read-only surface, show no inferred presence or Saved state, and dispatch no unavailable action. Stories exercise the production View with fixed inputs; they do not enable production co-editing. C-UI-12 tests each missing prerequisite.

Out:
- Topic subscriptions, command implementations, permission checks, Yjs provider, save acknowledgments, recovery-buffer lifecycle and disk writes (T-APP-14a and T-APP-14).
- New presence rosters, Pair sessions/invites, remote carets and selections, line comments, Vim mode, a Save button and new editor surfaces.
- Product copy changes beyond spec §14.6b; Will decides them. Render the supplied outside-change state and reuse its Compare action; do not implement snapshot retrieval or reconciliation.

## Changes

- Author colours, gutter flags, saved text, outside flag and too large to co-edit; no `.cm-ySelection`.
- Reshape the existing `apps/app/src/mainview/cards/views/CodeEditorView.tsx`, its `CodeEditorView.stories.tsx` and the File card's existing CSS after T-APP-14a restores the editor adapter. Reuse actor rendering and the supplied binding; do not restore the editor again or add a parallel renderer. Add only the missing author-colour decorations and gutter flags: the restored sync extension supplies editing, not these visuals. Every handler is one of the three kinds ui-components.md Rules allows: `onAction` with `data-flow`, `onView`, or local state.

## Tests

- Unit (`apps/app/src/mainview/cards/views/Views.test.tsx`, C-UI-12): mount the production `CodeEditorView` with fixed author ranges and person/agent props. Assert each author decoration and remote editor line flag, distinct agent identity, no `.cm-ySelection` or remote caret, Saving and Saved text, the unsaved count, and absence of live extensions and actions for each missing prerequisite. Exercise Reapply through the View's `onAction` callback and assert a literal supplied tag/args; exercise Copy through the real clipboard handler with literal retained text. This props-only ticket owns no dispatcher; T-APP-14 checks command dispatch and recovery on the real stack.
- Playwright (`apps/app/e2e/playwright/view-stories.spec.ts`, C-UI-12): render the same production View at 1,440 px and 390 px in both themes; assert no overflow, no serious or critical axe-core violation, and keyboard access to Reapply and Copy.
- Copy: T-CAT-01's term-list test renders this ticket's stories. Keep expected labels, ranges, payloads and clipboard text as hand-written literals independent of story expectation arrays, runtime implementation values and `.specs/` files.

## Acceptance
- [C-UI-12](../checks/C-UI-12.md): passes for this ticket’s phase at its stated layer.

- Copy review: smithers-06 reads every story screenshot at 1,440 px and 390 px, light and dark, against spec §14.6b, and records approve or fix per screen in this ticket’s issue. The wiring ticket's own checks prove the card end to end.

## Risks and notes

- A prop the mock needs but spec §14.3 lacks is a spec change: smithers-8a accepts it before implementation; Will decides any product change.
- Security: this ticket renders repository text as data using install-shipped components. It executes no repository code, imports no repository modules into the browser or host, and adds no root step. Root inputs: none. Repository-code execution remains machine-only (M-29). smithers-b8 reviews the rendering boundary; C-UI-12 uses hostile file text, actor labels and retained Copy text to prove inert rendering and no execution.

## Ready checklist

1. Dependencies: T-UI-01 supplies primitives, T-APP-14a supplies the restored editor/binding, T-COL-06 supplies the presence contract, and T-CAT-01 supplies action descriptors and the copy gate. Scope defines dark landing for each unlanded edge; C-UI-12 covers unavailable inputs.
2. Exclusions: Scope excludes transport, authority, disk writes, recovery lifecycle, new presence, Pair, carets/selections, comments, Vim, Save and parallel editor surfaces.
3. Tests: C-UI-12 exercises the production CodeEditorView and clipboard boundary with literal expectations; Playwright uses the real View. T-APP-14 owns real dispatcher/stack evidence; no expectation reads the spec or runtime code.
4. Decisions: smithers-06 approves visuals/copy, smithers-b8 accepts the app seam, smithers-38 signs public API changes, smithers-8a accepts spec changes, and Will decides product scope.
5. Owner pre-review: smithers-06: do author colours and person/agent flags match the mock, and do recovery states fit both widths/themes? smithers-b8: does the app-local binding keep the View props-only, and does dark landing prevent unavailable actions? smithers-38: does reuse preserve the File RPC contract, and does any public export change satisfy §21.1? Recorded answers stand; owners review post hoc under Will's parallel-build directive.
6. Security: install-shipped rendering treats branch text as inert data; repository code runs only in machines. No root step or root input exists. smithers-b8 reviews this boundary; hostile-input cases in C-UI-12 prove it.
