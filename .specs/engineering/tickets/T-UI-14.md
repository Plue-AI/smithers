# T-UI-14 Commands view (/help)

Stage S1 · Size S · Depends on none · Unblocks T-CAT-01, T-REL-02 · Issue: [#3551](https://github.com/smithersai/smithers/issues/3551)
Spec: spec.md §14.2.1, §6.1 · Delta: delta.md §9 · Product: mvp.md Appendix B · Props: [ui-components.md § T-UI-14](../ui-components.md)

Landed (dc908a381).

## Goal

`/help` shows the live command catalog in `CommandsView`, fed from the same registry the slash menu uses, with no hand copy of the catalog.

## Ownership (Will, 2026-10-02)

Design (smithers-06) owns the visuals. T-CAT-01 owns the catalog itself.

## Scope

In:
- Landed: groups, the Advanced group collapsed and keyboard-operable, and each command's synopsis, description and a muted policy mark (confirm: "Asks first"; never: "Only you"; run: none).
- Remaining:
  - Delete `apps/app/src/mainview/cards/views/CommandsCases.ts` (421 lines) and `CommandsExpectations.ts` (231): test data in `src/` and a third hand copy of the catalog (minimal-code synthesis v2).
  - Feed `CommandsView` from the live registry, the way `chat.commands` reads it today (`commands.all()` without hidden entries, `apps/app/src/mainview/state/AppController.ts:1271-1283`).
  - Fold `views/CommandActionView.tsx` (one caller) into `CommandsView.tsx` (v1 §6).
  - Merge `apps/app/src/mainview/styles/views/commands.css` into `styles/cards.css` and drop the `mvp-` prefix.

Out:
- Catalog generation, descriptor registration, role filtering, slash/palette/CLI/skill parity and execution (T-CAT-01). No second permission table.

## Changes

- `cards/CommandsContainer.tsx` (landed) is the card file: it maps each visible registry entry to a row (name and arguments as synopsis, summary as description, agent policy as the mark) and renders `CommandsView`. Props are TypeScript types; `CommandsCardSchema.parse` goes.
- The `chat.commands` flow (`flows/entries/chat.ts:148-153`) appends a Commands card rendered through `cards/CardRenderers.tsx` instead of a Markdown message. Delete the old `/help` renderer `showCommandCatalog` (`AppController.ts:1271-1283`) and its `AppActions` field (`AppController.ts:417-418`).
- Delete `CommandsCases.ts` and `CommandsExpectations.ts` and their imports in `CommandsView.stories.tsx` and `Views.test.tsx`.
- Inline `CommandActionView` in `CommandsView.tsx`; delete the file.
- Move `styles/views/commands.css` into `styles/cards.css`, renaming `mvp-` classes; delete it and its import in `styles/views.css`.

## Tests

`cards/CommandsContainer.test.tsx` and the Commands case in `Views.test.tsx` cover:
- a registry with a confirm, a user-only and a run entry renders "Asks first", "Only you" and no mark;
- a hidden entry renders no row;
- Advanced starts collapsed and expands from the keyboard with no command sent;
- `chat.commands` adds one Commands card and no Markdown catalog message.
Test inputs are small literal registries in the test files.

## Acceptance
- [C-UI-12](../checks/C-UI-12.md): passes for this ticket’s phase at its stated layer.

- The tests above pass in CI at the landed SHA.
- [C-UI-13](../checks/C-UI-13.md): `CommandsView` is reachable from `CardRenderers`; `showCommandCatalog`, `CommandsCases.ts`, `CommandsExpectations.ts` and `CommandActionView.tsx` are deleted.

## Risks and notes

- Description copy is the registry's `summary`. Matching Appendix A wording is T-CAT-01's catalog check, not this View's.
