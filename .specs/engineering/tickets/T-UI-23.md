# T-UI-23 TODO view: conflict, moved-off and outside-push forms; Fork and Add to stack

Stage S1 · Size M · Depends on T-UI-04, T-APP-19, T-APP-19b · Unblocks T-APP-02, T-GH-06, T-MCH-08, T-REL-02, T-STK-08 · Issue: [#3552](https://github.com/smithersai/smithers/issues/3552)
Spec: spec.md §14.2.1, §4.1.0a, §8.5, §9.3.8, §10.5.4, §12.3, §14.3 (TODO) · Delta: delta.md §9 · Product: mvp.md J7, J10.3, M-32, M-33 · Props: [ui-components.md § T-UI-23](../ui-components.md)

## Goal

The TODO card's branch-repair forms and stack controls exist in `TodoView` as props-only parts matching the design mock and ui-components.md, so T-STK-08, T-MCH-08 and T-GH-06 only bind data and actions.

## Ownership (Will, 2026-10-02)

Design (smithers-06) owns this ticket. Engineering wires it in T-STK-08, T-MCH-08 and T-GH-06 and reviews nothing visual. Design reviews engineering's wiring when idle. Split from T-UI-04 (product-approved, 2026-10-02): stage S1, off the J1/J2 path.

## Scope

- Start only after T-APP-19b (#3601) supplies TodoCard waits[], optional ssh_line: z.string(), and fixtures for conflict with ssh_line and two simultaneous waits. Keep conflictTerminal: ReactNode in app props; the Container supplies it. Check: C-UI-12.

In:
- The `conflict` wait: conflicted paths, Resolve, the S1 conflict view with a Container-supplied terminal slot and SSH line, and Done; from S2, Resolve opens the Branch card (§10.5.4). The View never connects a terminal. T-APP-19b (#3601) must deliver waits[], optional ssh_line and conflict/two-wait fixtures before this ticket starts.
- The `moved_off` wait with Resolve (§9.3.8). Return to Tn and Keep for now are on the Branch card (T-UI-15).
- The `foreign_push` wait: the pusher, the commit, **Bring in** and **Discard** (§12.3, M-33).
- Fork and Add to stack on the TODO card (§8.5, M-32).
- Props exactly as `ui-components.md` § T-UI-04 (TodoModel `waits[]` and the card's actions) until T-APP-19b (#3601) lands, then its zod type from `packages/rpc/src/TodoCard.ts`.
- Fixture stories for each of these states, light and dark, desktop and 390 px.

Out:
- ReactNode wire data and RPC schema/fixture implementation outside T-APP-19b (#3601) are excluded.
- The TODO states, the question and approval forms, failure, evidence, the PR line and the merge control (T-UI-04).
- Topic subscriptions, commands, permissions and copy decisions owned by spec §14.6b (engineering and product).
- Conflict-marker validation, wait settlement, primary-wait precedence, stale-sha checks, kept commits, history mutation and fork/placement execution (T-STK-08, T-GH-06, T-MCH-08); terminal/SSH connection and command execution; Return to Tn and Keep for now (T-UI-15); replacing Tn with scratch work (deferred).

## Changes

- Start only after T-APP-19b (#3601) supplies TodoCard waits[], optional ssh_line: z.string(), and fixtures for conflict with ssh_line and two simultaneous waits. Keep conflictTerminal: ReactNode in app props; the Container supplies it. Check: C-UI-12.

- Add a story with two simultaneous waits, each with its own row and controls, the same as T-UI-04. The conflict form uses native buttons and inputs that stack vertically at 390 px, with keyboard order following reading order. Check: C-UI-12.

- `apps/app/src/mainview/cards/views/TodoView.tsx` parts and CSS. Every handler is one of the three kinds ui-components.md Rules allows: `onAction` with `data-flow`, `onView`, or local state.
- Fixtures from `@smthrs/rpc` (`packages/rpc/test/fixtures/Todo.ts`, written via T-APP-19b (#3601)): conflict, moved off, outside push, and two open waits at once.

## Tests

- Decode the prerequisite conflict fixture with ssh_line and the two-wait fixture. Render independent controls for both waits and assert the Container supplies the terminal slot without a View terminal connection. Check: C-UI-12.

- unit (C-UI-12): every conflict, moved-off and outside-push fixture renders with its actions and shows its `expect` strings, in light and dark at 1280 and 390 px; each press calls `onAction` or `onView` once. The View-seam rule passes on the View's file (C-UI-08).
- copy: use committed literal expected strings for these forms under C-UI-12. C-UI-02 is a downstream T-CAT-01 audit, not a prerequisite for landing this View. No test reads `.specs/` or derives expected strings, tags, payloads or tone tokens from production code at runtime.

## Acceptance

- Copy review: the design reviewer reads every fixture screenshot at 1,440 px and 390 px, light and dark, against spec §14.6b, and records approve or fix per screen in this ticket’s issue. Check: C-UI-12.


- [C-UI-12](../checks/C-UI-12.md): every View fixture passes visual and copy review.

## Risks and notes

- smithers-06 approves visual and copy conformance and records the screenshot decision. Will decides product changes. Tech lead smithers-8a accepts the S1 conflict terminal/SSH seam with smithers-b8 and smithers-38 before implementation; update §14.3 and ui-components.md, then have T-APP-19 deliver matching props and fixtures. Do not invent those fields in TodoView. Other schema changes follow the same decision path.

## Ready checklist

1. Dependencies: T-UI-04 supplies the landed TodoView base; T-APP-19 supplies TodoCard and committed Todo fixtures, including the approved S1 conflict terminal slot and SSH-line contract. Backend repair and fork services are downstream wiring, not requirements for props-only landing.
2. Exclusions: Scope excludes core TODO forms, wait/marker validation and settlement, precedence computation, sha guards, commit retention, history/fork/placement execution, terminal/SSH connections, Branch-only moved-off controls and Replace Tn.
3. Tests: C-UI-12 mounts the production TodoView export in `apps/app/src/mainview/cards/views/Views.test.tsx` and `apps/app/e2e/playwright/view-stories.spec.ts` (both new). Committed literal cases cover conflict paths and supplied S1 terminal/SSH content, Resolve and Done, moved-off actor, foreign-push actor/commit, Bring in and Discard, Fork and Add to stack; each action emits its literal tag and exact supplied wait/sha/subject payload once. Two open waits retain separate actions and supplied order; missing Discard renders no control, and S2 Branch navigation uses the supplied action. Both themes, widths and keyboard operation pass; no expectations come from spec files or production code. T-STK-08, T-GH-06 and T-MCH-08 own real repair/fork dispatch and C-UI-13.
4. Decisions: smithers-06 signs visual/copy conformance, Will decides product changes, and smithers-8a accepts the terminal/SSH and schema seams with smithers-b8 and smithers-38.
5. Pre-review before start: smithers-06: Do both simultaneous waits remain visible with separate controls? Does the conflict form work by keyboard at 390 px? smithers-b8: Does the agreed terminal slot leave connections and execution in engineering wiring? Do repair actions preserve supplied wait ids and sha without deciding authorization? smithers-38: Can TodoCard carry the SSH line while React terminal props stay outside the rpc package? Are conflict fixtures available with the approved contract? smithers-06: answered 18:3x, ok. Design condition: "<change> Add a story with two simultaneous waits, each with its own row and controls, the same as T-UI-04. The conflict form is native buttons and inputs that stack vertically at 390 px, with keyboard order following reading order." smithers-38: answered, changes applied (tech lead adopts).
6. Security: TodoView never runs repository code or terminal commands. It displays supplied paths, actors and commits as inert data, places only the Container-supplied terminal slot, and emits supplied actions. M-29 confines repository execution to machines. smithers-b8 reviews the View boundary under C-UI-08; smithers-3f reviews machine-only terminal and repair execution with smithers-b8 before downstream wiring. C-UI-12 checks hostile text, absent actions and unchanged supplied sha payloads.

