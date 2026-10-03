# T-UI-06 Home view with the main sync row

Stage S1 · Size S · Depends on T-UI-01 · Unblocks T-APP-01, T-GH-07, T-UI-20 · Issue: [#3543](https://github.com/smithersai/smithers/issues/3543)
Spec: spec.md §14.2.1, §4.1.2a, §12.6, §14.3 (Home) · Delta: delta.md §9 · Product: mvp.md J4, J10.6 · Props: [ui-components.md § T-UI-06](../ui-components.md)
Ready: 2026-10-03 smithers-8a sha256:6960eedee75f

Landed (ab2ab5e0b).

## Goal

`HomeView` renders the `main` sync row, attention, the stack, machines and background runs from props, so T-APP-01 only binds data and actions.

## Ownership (Will, 2026-10-02)

Design (smithers-06) owns the View and CSS. smithers-b8 owns the app seam. Both pre-review the remaining refactor before start; existing recorded answers stand and review of the implementation is post hoc. smithers-06 accepts presentation changes; smithers-b8 approves callback compatibility; smithers-8a accepts any change to the props contract or mount-or-remove plan. Product changes require Will. Engineering wires data and commands in T-APP-01 and T-GH-07. No public library API changes are in scope.

## Scope

In:
- Landed: the `main` row in each sync health (fresh: synced ago; stale: gold with Retry; limited: when it retries; refused: the cause with Fix), attention rows, stack rows with their actions, `present` avatars, elapsed on the shared 1 s `useClock`, Rebase pending and the `merge` reason, counts as filters, merged since last look, machine slots, and background runs with Retry and Dismiss. Reset to GitHub main renders only when supplied.
- Remaining:
  - Fold `views/HomeRowView.tsx` (with `HomeFilterView`) and `views/HomeActionView.tsx` into `HomeView.tsx`; each has one caller (minimal-code synthesis v1 §6).
  - Reshape the Home rules already in `apps/app/src/mainview/styles/cards.css` and drop the `mvp-` prefix from Home selectors and their matching JSX and test selectors. `styles/views/home.css` and `styles/views.css` are already absent. Preserve shared primitive selectors owned by T-UI-01.
- Safe landing: T-UI-01 is the only runtime prerequisite for this props-only refactor. If its remaining work is unlanded, build against its specified primitives contract. Land dark: do not add a production mount, topic subscription or command binding. Missing actions stay absent; disabled actions emit no callback. T-APP-01 owns the production cutover and deletion of legacy Home rendering; T-GH-07 owns sync behavior. C-UI-12 covers absent and disabled actions.

Out:
- Polling, sync health, machine admission, background-run launch or dismissal, last-look persistence, attention authorization and the reset itself (T-APP-01, T-GH-07).
- Production mounting, catalog bindings, schema changes and deletion of legacy cards (T-APP-01); new Containers, Views, fixture layers or golden layers; S2 parallel controls and live-presence transport; S3 learning; TUI, Cloud and theme collections. Render supplied presence and background-run data only.

## Changes

- Inline `HomeRowView`, `HomeFilterView` and `HomeActionView` in `views/HomeView.tsx`; delete both files.
- Rename Home selectors already in `styles/cards.css` and matching selectors in `HomeView.tsx`, `HomeView.stories.tsx` and `Views.test.tsx`; do not recreate the deleted CSS files. Reuse the existing View, handlers and shared `useClock`; add no replacement rendering or clock.
- Mounting remains T-APP-01 work: reshape the existing card into the container, fold the landed `cards/HomeContainer.tsx` into it, mount only through `cards/CardRenderers.tsx`, and delete the duplicate `StackCard.tsx` and `RepositoryHomeCard.tsx` rendering in that cutover (§14.2.1a, delta.md §9). Do not retain a separate Container layer.

## Tests

C-UI-12 uses the Home cases in `apps/app/src/mainview/cards/views/Views.test.tsx`. Mount the production `HomeView`, activate its rendered buttons and menu, and observe `onAction` and `onView`; never invoke handlers directly. Keep expected text, tags, arguments, callback counts and Paper tokens as authored literals, independent of spec parsing, fixture-derived expectations and implementation-derived expectations. Extend the existing named tests rather than add a fixture or golden layer. The production dispatcher, `CardRenderers` cutover and backend effects are T-APP-01 acceptance (C-J4-01, C-UI-13), not claimed by these View tests. Home cases cover:
- fresh, stale, limited and refused sync rows; with a fixed clock and literal `last_success_at`, the literal synced-age text before and after one second, with no command sent;
- attention and failed background-run Retry and Dismiss dispatch their literal tags and arguments once;
- with a supplied reset action, Reset to GitHub main dispatches once; without it, there is no reset control;
- clicking a count emits its literal `onView` patch;
- agent presence, queue reasons and zero capacity;
- extend "HomeView preserves order controls, closes on Escape, and omits unsupplied reset" with absent and disabled top, attention, row and background actions: no control for absent actions, the literal reason for disabled actions, and zero callbacks on attempted activation; preserve menu focus and keyboard navigation in "HomeView menu supports keyboard navigation and outside dismissal with opaque tags";
- add "HomeView renders hostile supplied text without executing it": repository, title, cause, attention text and action labels containing HTML remain text, create no injected element and execute no script. This is the C-UI-12 rendering security case.

## Acceptance
- [C-UI-12](../checks/C-UI-12.md): passes for this ticket’s phase at its stated layer.

- The tests above pass in CI at the landed SHA. `HomeRowView.tsx`, `HomeActionView.tsx` and `styles/views/home.css` are gone.

## Risks and notes

- smithers-8a decides the mount-or-remove outcome under §14.2.1a and delta.md §9; T-APP-01 must delete duplicate Home rendering at cutover. This refactor adds no second Home stack.
- Security: smithers-b8 reviews the props-only boundary and the hostile-text and absent/disabled-action cases in C-UI-12. Supplied repository text is inert; no fetch, shell, repository import or flow execution is added. Repository-code execution remains in machines (M-29, spec.md §17.3); background Retry admission is T-APP-01 work reviewed by smithers-3f. This ticket adds no root step and consumes no root inputs from main or a branch.

## Ready checklist
1. Dependencies: T-UI-01 supplies the primitives; the remaining props-only refactor adds no runtime service prerequisite. Scope states dark landing against its specified contract. T-APP-01 and T-GH-07 own later wiring, not dependencies of this refactor.
2. Exclusions: Scope excludes production wiring and backend effects, schema changes, new rendering/Container/fixture/golden layers, S2 controls and transport, S3 learning, TUI, Cloud and extra themes. Changes reshape existing code and delete the one-caller files.
3. Tests: C-UI-12 mounts production HomeView and activates DOM controls, with literal text and callback oracles; absent/disabled controls, clock boundaries, keyboard behavior and hostile text are named. Dispatcher/backend acceptance remains C-J4-01 and C-UI-13 in T-APP-01.
4. Decisions: smithers-06 accepts presentation; smithers-b8 approves callback compatibility; smithers-8a accepts props-contract changes and the cutover plan; Will decides product changes. No public API decision is introduced.
5. Owner pre-review: smithers-06: Does folding the row, filter and action components preserve presentation and keyboard focus? Do renamed Home selectors preserve light/dark Paper tones without changing shared primitives? smithers-b8: Do onAction/onView keep their tags, arguments and patches without adding authority? Does the refactor stay dark until T-APP-01 mounts one Home renderer and removes its duplicates? Existing recorded answers stand; implementation review is post hoc.
6. Security: smithers-b8 reviews inert supplied text and absent/disabled callback behavior via C-UI-12. No repository execution or root step is introduced, so there are no root inputs; M-29/§17.3 machine-only execution remains a precondition of later Retry wiring, reviewed by smithers-3f in T-APP-01.
