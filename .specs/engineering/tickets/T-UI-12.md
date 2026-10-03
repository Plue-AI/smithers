# T-UI-12 Run monitor and Inspect views

Stage S1 · Size M · Depends on T-UI-01, T-APP-19 · Unblocks T-APP-17, T-FLW-07, T-REL-02 · Issue: [#3549](https://github.com/smithersai/smithers/issues/3549)
Spec: spec.md §14.2.1, §11.6, Appendix C labels · Delta: delta.md §9 · Product: mvp.md J11.1 · Props: [ui-components.md § T-UI-12](../ui-components.md)

## Goal

`RunView`, with its Inspect layout, exists as a props-only View matching the design mock and ui-components.md, so the wiring ticket only binds data and actions.

## Ownership (Will, 2026-10-02)

Design (smithers-06) owns this ticket. Engineering wires it in T-FLW-07 and reviews nothing visual. Design reviews engineering's wiring when idle.

## Scope

In:
- `RunView`: every attempt's graph, earlier ones dimmed; per attempt, steps with input, output, agent and time, plus tokens and cost for steps with model calls; phases and cells by stable id, with the selected cell's detail (`onView({selected})`); waits with since and, once settled, who settled them and when; tokens, time and cost totals; the collapsed Engine row; the journal tab; the read-only replay scrubber (`onView({at})`); the flow's custom view slot. Inspect is the maximized Run card. Phases show their deterministic title and cells their deterministic label. A phase summary or a cell explanation renders marked as a model summary; when it is absent, the title or label stands alone with no placeholder, spinner or error.
- Props exactly as `ui-components.md` § T-UI-12 until T-APP-19 lands, then the zod type from `packages/rpc/src/<Card>Card.ts`.
- Fixture stories for every state the props allow, light and dark, desktop and 390 px.

Out:
- Topic subscriptions, commands, permissions and copy decisions owned by spec §14.6b (engineering and product).
- Runtime event projection, phase boundaries and labels, thrashing detection, model summaries, journal loading and replay projection (T-FLW-07); context selection (T-APP-17); custom presentation loading or execution. Fork, rewind and manual signal sending are excluded.

## Changes

- Render the supplied Inspect preflight cell first; T-APP-17 supplies it during wiring and is not a landing prerequisite for this props-only View. Check: C-UI-12.


- New `apps/app/src/mainview/cards/views/RunView.tsx` and CSS; shared primitives stay in `packages/smithers/ui/src/`. Every handler is one of the three kinds ui-components.md Rules allows: `onAction` with `data-flow`, `onView`, or local state.
- Fixtures from `@smthrs/rpc` (`packages/rpc/test/fixtures/`, written with T-APP-19).

## Tests

- unit (C-UI-12): every fixture of the card renders with its actions and shows its `expect` strings, in light and dark at 1280 and 390 px; each press calls `onAction` or `onView` once. The View-seam rule passes on the View's file (C-UI-08).
- copy: use committed literal expected strings for this View under C-UI-12. C-UI-02 is a downstream T-CAT-01 audit, not a prerequisite for landing this View. No test reads `.specs/` or derives expected strings, tags, payloads or tone tokens from production code at runtime.

## Acceptance

- Copy review: the design reviewer reads every fixture screenshot at 1,440 px and 390 px, light and dark, against spec §14.6b, and records approve or fix per screen in this ticket’s issue. Check: C-UI-12.


- [C-UI-12](../checks/C-UI-12.md) for this ticket's Views, with T-APP-19's fixtures. It needs no Container: the wiring ticket's own checks prove the card end to end.

## Risks and notes

- smithers-06 approves visual and copy conformance and records the screenshot decision. Will decides product changes. Tech lead smithers-8a accepts schema or seam changes with smithers-b8 and smithers-38 before implementation; update §14.3, ui-components.md and T-APP-19 together. The View uses supplied deterministic labels and does not choose a summary or thrashing policy.

## Ready checklist

1. Dependencies: T-UI-01 supplies primitives and T-APP-19 supplies the landed RunCard schema, per-module import and committed Run fixtures, including preflight and optional summaries. Event services and T-APP-17 are downstream wiring, not runtime requirements for this View.
2. Exclusions: Scope excludes event projection, label generation, thrashing detection, model calls, journal loading, replay projection, context selection, custom presentation execution, fork, rewind and manual signals.
3. Tests: C-UI-12 mounts the production RunView export in `apps/app/src/mainview/cards/views/Views.test.tsx` and `apps/app/e2e/playwright/view-stories.spec.ts` (both new). Committed literal cases cover multiple attempts and graphs, preflight first, held waits with since, settled actor/time, usage absent on non-model steps, all phase tones, optional summaries marked as summaries, labels alone when summaries are absent, Engine collapsed, supplied custom slot, selected-cell and replay onView patches, and Inspect/Steer/Stop/Retry callbacks. Replay emits no onAction. Both themes, widths and keyboard navigation pass; no expectations come from spec files or production code. T-FLW-07 and T-APP-17 own production monitor/context dispatch and C-UI-13.
4. Decisions: smithers-06 signs visual/copy conformance, Will decides product policy, and smithers-8a accepts schema/seam changes with smithers-b8 and smithers-38.
5. Pre-review before start: smithers-06: answered 18:10, ok (mock 21b445a6) smithers-b8: Do selection and replay emit only view patches? Does RunView only place the Container-supplied custom slot? smithers-38: Do RunCard fields and fixtures cover stable phase/cell ids and optional summaries without app dependencies? Shared primitive changes also need smithers-38 review.
6. Security: Journal, code, output and summaries render as data and cannot invoke commands; C-UI-12 tests hostile text and read-only replay. RunView neither loads repository modules nor evaluates a custom presentation. Only a Container-supplied rendered slot is accepted. M-29 requires repository execution in machines; smithers-b8 reviews the View seam under C-UI-08, and smithers-3f reviews custom-presentation execution preconditions with smithers-b8 in T-FLW-07 before wiring it.

