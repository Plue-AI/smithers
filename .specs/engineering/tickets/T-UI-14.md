# T-UI-14 Commands view (/help)

Stage S1 · Size S · Depends on T-UI-01, T-APP-19 · Unblocks T-CAT-01, T-REL-02 · Issue: [#3551](https://github.com/smithersai/smithers/issues/3551)
Spec: spec.md §14.2.1, §6.1 · Delta: delta.md §9 · Product: mvp.md Appendix B · Props: [ui-components.md § T-UI-14](../ui-components.md)

## Goal

`CommandsView` exists as a props-only View matching the design mock and ui-components.md, so the wiring ticket only binds data and actions.

## Ownership (Will, 2026-10-02)

Design (smithers-06) owns this ticket. Engineering wires it in T-CAT-01 and reviews nothing visual. Design reviews engineering's wiring when idle.

## Scope

In:
- Keep Advanced collapsed initially and keyboard-operable. Copy descriptions row for row from product Appendix A, covering all 57 rows. Render agent policy as a muted trailing mark: confirm → "Asks first", never → "Only you"; run has no mark. Check: C-UI-12.
- `CommandsView`: groups, the collapsed Advanced group, and each command's synopsis, description and policy mark (confirm: "Asks first"; never: "Only you"; run: none).
- Props exactly as `ui-components.md` § T-UI-14 until T-APP-19 lands, then the zod type from `packages/rpc/src/<Card>Card.ts`.
- Fixture stories for every state the props allow, light and dark, desktop and 390 px.

Out:
- Topic subscriptions, commands, permissions and copy decisions owned by spec §14.6b (engineering and product).
- Catalog generation, descriptor registration, role filtering, slash/palette/CLI/skill parity and command execution (T-CAT-01, T-CAT-02). Do not add hidden or in-card command rows, sign-in/sign-out agent doors, or a second permission table.

## Changes

- Keep Advanced collapsed initially and keyboard-operable. Copy descriptions row for row from product Appendix A, covering all 57 rows. Render agent policy as a muted trailing mark: confirm → "Asks first", never → "Only you"; run has no mark. Check: C-UI-12.

- New `apps/app/src/mainview/cards/views/CommandsView.tsx` and CSS; shared primitives stay in `packages/smithers/ui/src/`. Every handler is one of the three kinds ui-components.md Rules allows: `onAction` with `data-flow`, `onView`, or local state.
- Fixtures from `@smthrs/rpc` (`packages/rpc/test/fixtures/`, written with T-APP-19).

## Tests

- Compare all 57 descriptions with independently committed literal Appendix A expectations. Expand Advanced from the keyboard without command dispatch. Assert muted trailing "Asks first" and "Only you" marks for confirm and never, and no mark for run. Check: C-UI-12.

- unit (C-UI-12): every fixture of the card renders with its actions and shows its `expect` strings, in light and dark at 1280 and 390 px; each press calls `onAction` or `onView` once. The View-seam rule passes on the View's file (C-UI-08).
- copy: use committed literal expected strings for this View under C-UI-12. C-UI-02 is a downstream T-CAT-01 audit, not a prerequisite for landing this View. No test reads `.specs/` or derives expected strings, tags, payloads or tone tokens from production code at runtime.

## Acceptance

- Copy review: the design reviewer reads every fixture screenshot at 1,440 px and 390 px, light and dark, against spec §14.6b, and records approve or fix per screen in this ticket’s issue. Check: C-UI-12.


- [C-UI-12](../checks/C-UI-12.md) for this ticket's Views, with T-APP-19's fixtures. It needs no Container: the wiring ticket's own checks prove the card end to end.

## Risks and notes

- smithers-06 approves visual and copy conformance and records the screenshot decision. Will decides catalog/product or copy changes. Tech lead smithers-8a accepts schema or seam changes with smithers-b8 and smithers-38 before implementation; update §14.3, ui-components.md and T-APP-19 together. The View renders supplied groups and policy marks and does not infer eligibility.

## Ready checklist

1. Dependencies: T-UI-01 supplies primitives and T-APP-19 supplies the landed CommandsCard schema, opaque tag type and committed Commands fixtures. T-CAT-01 already depends on this View; live catalog generation is downstream and cannot be a View prerequisite.
2. Exclusions: Scope excludes catalog generation/registration, role filtering, other command doors, execution, hidden/in-card rows and separate permission policy.
3. Tests: C-UI-12 mounts the production CommandsView export in `apps/app/src/mainview/cards/views/Views.test.tsx` and `apps/app/e2e/playwright/view-stories.spec.ts` (both new). Committed literal cases cover supplied group order, synopsis and description, confirm/never trailing marks and no run mark, Advanced collapsed initially and expanded by keyboard, and empty groups. Tags remain opaque; any supplied action calls onAction once and local disclosure dispatches no command. Both themes and widths pass. Expected values come from neither spec files nor the runtime catalog or registry. T-CAT-01 owns production `/help` dispatch and catalog parity under C-CAT-01/C-UI-13.
4. Decisions: smithers-06 signs visual/copy conformance, Will decides catalog/product changes, and smithers-8a accepts seam changes with smithers-b8 and smithers-38.
5. Pre-review before start: smithers-06: answered 18:10 with these changes (mock 21b445a6) smithers-b8: Does CommandsView display supplied rows without filtering or inferring authorization? Is any command action emitted through the supplied callback only? smithers-38: Can CommandsCard fixtures use opaque tags without depending on the generated catalog or app registry? Shared primitive changes also need smithers-38 review.
6. Security: Listing a command never loads or executes repository code. Policy marks are presentation; the production dispatcher remains the authorization boundary. C-UI-12 checks disclosure without dispatch and inert synopsis/description text; C-UI-08 enforces the seam. smithers-b8 reviews this boundary. M-29 confines downstream repository execution to machines, reviewed by smithers-3f in the execution tickets.

