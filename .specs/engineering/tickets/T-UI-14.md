# T-UI-14 Commands view (/help)

Stage S1 · Size S · Depends on T-APP-19b · Unblocks T-CAT-01, T-REL-02 · Issue: [#3551](https://github.com/smithersai/smithers/issues/3551)
Spec: spec.md §14.2.1, §6.1 · Delta: delta.md §9 · Product: mvp.md Appendix B · Props: [ui-components.md § T-UI-14](../ui-components.md)

## Goal

`CommandsView` exists as a props-only View matching the design mock and ui-components.md, so the wiring ticket only binds data and actions.

## Ownership (Will, 2026-10-02)

Design (smithers-06) owns this ticket. Engineering wires it in T-CAT-01 and reviews nothing visual. Design reviews engineering's wiring when idle.

## Scope

In:
- Lands before T-UI-01 (tech lead 2026-10-02, edge cut): CommandsView uses existing Paper styling and its reconciled CommandsCard contract. No replacement actor/state implementation. Keep T-APP-19b and the design review; mount the real View with its committed fixtures and keyboard-disclosure tests. If design actually introduces a shared primitive call, restore that concrete prerequisite rather than copying it.; its integration test with T-UI-01 runs after T-UI-01 lands and gates C-UI-12 and C-UI-13 (S1 schema, View and wiring exit).
- Commands entries include synopsis, description and agent: run|confirm|never from T-APP-19b. Catalog tags remain an opaque placeholder enum until T-CAT-01 replaces it. Check: C-UI-12.
- Keep Advanced collapsed initially and keyboard-operable. Copy descriptions row for row from product Appendix A, covering all 57 rows. Render agent policy as a muted trailing mark: confirm → "Asks first", never → "Only you"; run has no mark. Check: C-UI-12.
- `CommandsView`: groups, the collapsed Advanced group, and each command's synopsis, description and policy mark (confirm: "Asks first"; never: "Only you"; run: none).
- Props exactly as `ui-components.md` § T-UI-14 with the zod type reconciled by T-APP-19b from `packages/rpc/src/<Card>Card.ts`.
- Fixture stories for every state the props allow, light and dark, desktop and 390 px.

Out:
- No catalog generation, tag interpretation or permission decision. T-APP-19b owns fields; T-CAT-01 owns the catalog. Check: C-UI-08.
- Topic subscriptions, commands, permissions and copy decisions owned by spec §14.6b (engineering and product).
- Catalog generation, descriptor registration, role filtering, slash/palette/CLI/skill parity and command execution (T-CAT-01, T-CAT-02). Do not add hidden or in-card command rows, sign-in/sign-out agent doors, or a second permission table.

## Changes

- Render supplied synopsis/description and agent policy marks without interpreting tags or inferring permission. Check: C-UI-12.

- Keep Advanced collapsed initially and keyboard-operable. Copy descriptions row for row from product Appendix A, covering all 57 rows. Render agent policy as a muted trailing mark: confirm → "Asks first", never → "Only you"; run has no mark. Check: C-UI-12.

- New `apps/app/src/mainview/cards/views/CommandsView.tsx` and CSS; shared primitives stay in `packages/smithers/ui/src/`. Every handler is one of the three kinds ui-components.md Rules allows: `onAction` with `data-flow`, `onView`, or local state.
- Fixtures from `@smthrs/rpc/fixtures/Commands` (`packages/rpc/test/fixtures/`, reconciled with T-APP-19b).

## Tests

- Assert literal synopsis and description, Asks first for confirm, Only you for never and no mark for run; retain advanced disclosure and role-filtered fixtures. Check: C-UI-12.

- Compare all 57 descriptions with independently committed literal Appendix A expectations. Expand Advanced from the keyboard without command dispatch. Assert muted trailing "Asks first" and "Only you" marks for confirm and never, and no mark for run. Check: C-UI-12.

- unit (C-UI-12): every fixture of the card renders with its actions and shows its `expect` strings, in light and dark at 1280 and 390 px; each press calls `onAction` or `onView` once. The View-seam rule passes on the View's file (C-UI-08).
- copy: use committed literal expected strings for this View under C-UI-12. C-UI-02 is a downstream T-CAT-01 audit, not a prerequisite for landing this View. No test reads `.specs/` or derives expected strings, tags, payloads or tone tokens from production code at runtime.

## Acceptance

- Copy review: the design reviewer reads every fixture screenshot at 1,440 px and 390 px, light and dark, against spec §14.6b, and records approve or fix per screen in this ticket’s issue. Check: C-UI-12.


- [C-UI-12](../checks/C-UI-12.md) for this ticket's Views, with T-APP-19b's fixtures. It needs no Container: the wiring ticket's own checks prove the card end to end.

## Risks and notes

- smithers-06 approves visual and copy conformance and records the screenshot decision. Will decides catalog/product or copy changes. Tech lead smithers-8a accepts schema or seam changes with smithers-b8 and smithers-38 before implementation; raise §14.3 and ui-components.md gaps through T-APP-19b; UI lanes never raise piecemeal schema changes. The View renders supplied groups and policy marks and does not infer eligibility.

## Ready checklist

T-UI-02 through T-UI-14 go Ready together after T-APP-19b lands with smithers-38's §21.1 review. Local props permit drafting only. This UI lane makes no piecemeal schema change. Check: C-UI-08.

1. Dependencies: T-APP-19b supplies the landed CommandsCard schema, opaque tag type and committed Commands fixtures. T-CAT-01 already depends on this View; live catalog generation is downstream and cannot be a View prerequisite. Landing condition for the T-UI-01 edge cut: CommandsView uses existing Paper styling and its reconciled CommandsCard contract. No replacement actor/state implementation. Keep T-APP-19b and the design review; mount the real View with its committed fixtures and keyboard-disclosure tests. If design actually introduces a shared primitive call, restore that concrete prerequisite rather than copying it.; its integration test with T-UI-01 runs after T-UI-01 lands and gates C-UI-12 and C-UI-13 (S1 schema, View and wiring exit).
2. Exclusions: Scope excludes catalog generation/registration, role filtering, other command doors, execution, hidden/in-card rows and separate permission policy.
3. Tests: C-UI-12 mounts the production CommandsView export in `apps/app/src/mainview/cards/views/Views.test.tsx` and `apps/app/e2e/playwright/view-stories.spec.ts` (both new). Committed literal cases cover supplied group order, synopsis and description, confirm/never trailing marks and no run mark, Advanced collapsed initially and expanded by keyboard, and empty groups. Tags remain opaque; any supplied action calls onAction once and local disclosure dispatches no command. Both themes and widths pass. Expected values come from neither spec files nor the runtime catalog or registry. T-CAT-01 owns production `/help` dispatch and catalog parity under C-CAT-01/C-UI-13.
4. Decisions: smithers-06 signs visual/copy conformance, Will decides catalog/product changes, and smithers-8a accepts seam changes with smithers-b8 and smithers-38.
5. Pre-review before start: smithers-06: answered 18:10 with these changes (mock 21b445a6) smithers-b8: answered 18:2x, ok; smithers-38: answered, BLOCKING edits applied (tech lead adopts).
6. Security: Listing a command never loads or executes repository code. Policy marks are presentation; the production dispatcher remains the authorization boundary. C-UI-12 checks disclosure without dispatch and inert synopsis/description text; C-UI-08 enforces the seam. smithers-b8 reviews this boundary. M-29 confines downstream repository execution to machines, reviewed by smithers-3f in the execution tickets.

