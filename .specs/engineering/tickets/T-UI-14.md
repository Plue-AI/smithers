# T-UI-14 Commands view (/help)

Stage S1 · Size S · Depends on none · Unblocks T-CAT-01 · Issue: [#3551](https://github.com/smithersai/smithers/issues/3551)
Spec: spec.md §14.2.1, §6.1 · Delta: delta.md §9 · Product: mvp.md Appendix B · Props: [ui-components.md § T-UI-14](../ui-components.md)
Ready: 2026-10-03 smithers-8a sha256:d3bc859cb95b

Landed (dc908a381).

## Goal

`/help` shows the live command catalog in `CommandsView`, fed from the same registry the slash menu uses, with no hand copy of the catalog.

## Ownership (Will, 2026-10-02)

smithers-06 decides visuals, copy placement and keyboard disclosure. smithers-b8 decides the app registry-to-card seam and its fail-closed activation. smithers-38 signs off changes to the public `packages/rpc/src/CommandsCard.ts` types. T-CAT-01 owns catalog policy and names; this ticket consumes that contract and does not decide it. These owners pre-review their seams before implementation; recorded owner answers stand, with post-hoc review under Will’s parallel-build directive.

## Scope

In:
- Landed: groups, the Advanced group collapsed and keyboard-operable, and each command's synopsis, description and a muted policy mark (confirm: "Asks first"; never: "Only you"; run: none).
- Remaining:
  - Delete `apps/app/src/mainview/cards/views/CommandsCases.ts` (421 lines) and `CommandsExpectations.ts` (231): test data in `src/` and a third hand copy of the catalog (minimal-code synthesis v2).
  - Reshape the existing `CommandsContainer.tsx` and registry-to-card path; feed `CommandsView` from the live registry (`apps/app/src/mainview/state/AppController.ts:1271-1283`), using the shared viewer-admitted projection, not a second permission table.
  - Keep the already-inline `CommandActionView` in `CommandsView.tsx`; no separate file remains.
  - Rename the Commands `mvp-` classes in `CommandsView.tsx` and `styles/cards.css:2695-2706`; the CSS move is already complete.
  - Land dark against T-CAT-01’s contract: omit entries without authoritative visibility, viewer admission or agent policy; refuse catalog display if the projection is unavailable. Never fall back to unfiltered `commands.all()` or the Markdown catalog. Enable the `/help` door only when T-CAT-01 supplies its descriptor and the dispatcher tests below pass. T-CAT-01 is a later provider, not a landing prerequisite: it already depends on T-UI-14. No unlanded first-merge or unlabeled dependency is required. Checks: this ticket’s dispatcher tests and C-UI-13.

Out:
- Catalog generation, descriptor registration, permission decisions, slash renames and slash/palette/CLI/skill parity (T-CAT-01). Consume shared role filtering; no second permission table.
- Command execution buttons, confirmation handling, new CLI or skill doors, repository-flow discovery or evaluation, host or machine execution, root steps, and new catalog, fixture or container layers.

## Changes

- Reshape `cards/CommandsContainer.tsx` as the card family file, using the existing card append and decoding machinery and mounting only through `cards/CardRenderers.tsx`. Map admitted `core` and `advanced` entries and repository-flow metadata to rows; omit `hidden` and `in-card` entries and empty groups. Use registry name/arguments as synopsis, summary as description and supplied agent policy as the mark. Props are TypeScript types; remove View-only `CommandsCardSchema.parse` calls and runtime RPC imports from the View. Retain parsing at storage or HTTP boundaries and readable old records. No new container or catalog layer.
- Reshape the `chat.commands` handler (`flows/entries/chat.ts:148-153`) to append a Commands card through the existing app actions and card machinery instead of a Markdown message. Delete `showCommandCatalog` (`AppController.ts:1271-1283`), its `AppActions` field (`:417-418`) and action-object reference (`:1552`) in the same change. T-CAT-01 supplies the `/help` rename.
- Delete `CommandsCases.ts` and `CommandsExpectations.ts` and their imports in `CommandsView.stories.tsx` and `Views.test.tsx`.
- Reuse the inline `CommandActionView` and existing Commands rules in `styles/cards.css`; rename only their `mvp-` classes. `views/CommandActionView.tsx`, `styles/views/commands.css` and `styles/views.css` are already absent; do not recreate them.

## Tests

- Extend `flows/Commands.test.ts` using `createAppController` and the production dispatcher: invoke `controller.commands.run("chat.commands")` and submit `/chat.commands` through `controller.commands.submit({ name: "chat.send", payload: { text: "/chat.commands" }, actor: "user" })`. Await the persisted command’s settlement, then assert exactly one Commands card and no Markdown catalog message. Mount that actual card through `CardRenderers.renderCardBody`, not a substituted View or direct handler call.
- In the same dispatcher tests, use small literal provider inputs for confirm, never and run policies, hidden and in-card entries, member/maintainer admission and missing authority. Assert literal rows, "Asks first", "Only you", no run mark, no excluded rows and refusal with no card or Markdown fallback when the projection is unavailable. Restore the provider and assert a subsequent invocation succeeds without enabling excluded rows.
- When T-CAT-01 activates the rename, submit `/help` through the same `chat.send` boundary and assert the same single-card result. Until then the `/help` door stays unavailable; this ticket does not add an alias.
- Reshape `cards/CommandsContainer.test.tsx` to test the actual View and literal projection inputs; remove the injected View and generated fixture oracle. In `cards/views/Views.test.tsx`, test Advanced initially collapsed and Tab then Enter/Space disclosure with visible focus and zero command dispatch. Keep the hostile synopsis/description test: markup renders as text, with no executable element or callback.
- Inputs and expected rows, policy marks, omissions and counts are literals committed in test files. No test parses spec Markdown or computes its expectations from production descriptors, schemas, fixtures or registry output. Production registries remain the system under test.

## Acceptance
- [C-UI-12](../checks/C-UI-12.md): passes for this ticket’s phase at its stated layer.

- The tests above pass in CI at the landed SHA.
- [C-UI-13](../checks/C-UI-13.md): `CommandsView` is reachable from `CardRenderers`; `showCommandCatalog`, `CommandsCases.ts` and `CommandsExpectations.ts` are deleted; the already-absent `CommandActionView.tsx` stays absent. Remove Commands from the check’s literal pending list in this change.

## Risks and notes

- Description copy is the registry's `summary`. Matching Appendix A wording is T-CAT-01's catalog check, not this View's.
- Security pre-review: smithers-b8 reviews the metadata trust boundary and refusal behavior. Catalog listing and disclosure never execute repository code, import repository modules or start a machine; repository-flow names and descriptions are inert supplied metadata. Repository execution remains machine-only (M-29). This ticket adds no root step and consumes no root-step inputs from main or a branch. Dispatcher and hostile-text tests above prove listing causes no execution.

## Ready checklist

1. Dependencies: none for safe landing; reuse the landed registry, app store and renderer machinery. Missing T-CAT-01 authority fails closed and its `/help` activation waits for dispatcher tests; adding its reverse dependency would create a cycle.
2. Exclusions: Scope explicitly excludes catalog policy, renames, parity, execution buttons, confirmations, CLI/skill doors, repository evaluation, root steps and duplicate layers.
3. Boundary tests: production `createAppController` dispatcher, `chat.send` slash submission and `CardRenderers.renderCardBody` prove card output and refusals; DOM tests prove disclosure and inert text. All expectations are committed literals (C-UI-12, C-UI-13 and the named dispatcher tests).
4. Decisions: smithers-06 decides visuals and keyboard behavior; smithers-b8 decides app wiring and activation; smithers-38 signs off public RPC type changes. Catalog policy stays with T-CAT-01.
5. Owner pre-review: smithers-06: Does disclosure preserve keyboard access and focus? Do class renames preserve Paper light/dark styling? smithers-b8: Does the shared viewer-admitted projection omit unknown authority without a second policy table? Does dispatch produce one mounted card and remove the Markdown fallback? smithers-38: Do the Commands props changes preserve the public type contract and storage decoding? Recorded answers stand; owners review post hoc under the directive.
6. Security: smithers-b8 reviews inert metadata and fail-closed admission; listing runs no repository code, repository execution remains machine-only, and no root step or root input exists. Dispatcher refusal and hostile-text tests enforce the boundary.

