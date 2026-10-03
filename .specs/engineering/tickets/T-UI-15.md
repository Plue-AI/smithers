# T-UI-15 Branch view with moved-off controls

Stage S2 · Size L · Depends on T-UI-01 · Unblocks T-APP-10 · Issue: [#3579](https://github.com/smithersai/smithers/issues/3579)
Spec: spec.md §14.2.1, §8.10, §9.3, §14.3 (Branch) · Delta: delta.md §9 · Product: mvp.md J3, J7 · Props: written by this ticket when S2 starts
Ready: 2026-10-03 smithers-8a sha256:36f03107def7

## Goal

`BranchView`, with the moved-off controls, exists as a props-only View matching the design mock, so the wiring ticket only binds data and actions.

## Ownership (Will, 2026-10-02)

Design (smithers-06) owns visual and copy acceptance. smithers-b8 decides the app handler seam; smithers-38 decides the private rpc type seam; smithers-8a accepts changes to the specified props. Engineering wires the View in T-APP-10 and T-COL-05. Owner pre-review questions are in the Ready checklist. Recorded owner answers stand; owners review the implementation post hoc under Will's 2026-10-03 parallel-build directive.

## Scope

In:
- `BranchView`: the machine in each §4.2 state (awake, asleep, waking, waiting #n, closed, failed with Retry) with Sleep and Wake; the item with its state, title and place, or scratch with Add to stack after its fork source; the rebase states (Rebase pending with Rebase now and, for the member who pressed it, what it waits for; Rebasing…; a scratch conflict's paths with Resolve and Done); presence for people and agents with where (file and line, terminal, step, branch) and watching; activity, each change entry opening its burst's diff; terminals with owner, agents, watchers and the frozen state; changed files with their authors; the SSH line; and the moved-off Needs you with Return to Tn and Keep for now.
- Presence rows are supplied props shaped for T-COL-06's reuse of `packages/smithers/flows/sync/src/BranchPresence.ts` (person-or-agent kind and location). This ticket imports no roster or runtime bridge and keeps no presence state (v1 §4). T-COL-06 is a wiring prerequisite for T-APP-10, not a runtime prerequisite for this props-only View.
- Props: reshape the existing `packages/rpc/src/BranchCard.ts` into a TypeScript View contract, or restore it if delta.md §11's pre-S2 deletion has landed. Reuse `CardAction.ts` and `CardPrimitives.ts`; keep zod only at HTTP or storage boundaries owned by T-APP-10. Update the Branch props section in ui-components.md with this change; do not add a second schema or fixture layer.
- Stories for every state the props allow, light and dark, desktop and 390 px.
- Land dark: until T-UI-01 is available, keep this slice unexposed and do not substitute new primitives. Until T-APP-10 and T-COL-05 wire the specified contracts, expose the View only in the existing story page, with no production card registration, subscriptions or executable action bindings. Missing actions render no controls. No unavailable authority or execution provider gets a fallback. The dark-state and missing-action tests below prove this boundary.

Out:
- Topic subscriptions, command dispatch, authorization, machine lifecycle, SSH connections, terminal sessions, moved-off detection and recovery, and rebase/conflict execution. T-APP-10 and T-COL-05 own wiring; this View only renders supplied facts and actions.
- Presence leases, heartbeat timers and a second roster; Pair sessions, invites and branch locks; S3 co-editing and cursor transport; per-entry Undo and command-name attribution; replacing an existing TODO with scratch work.
- New catalog tags, public library APIs and independent containers. Copy rules come from §14.6b; smithers-06 accepts copy against them.

## Changes

- Reuse `packages/rpc/src/BranchCard.ts`, the T-UI-01 actor/state primitives, `apps/app/src/mainview/styles/cards.css` Paper rules and the existing story/test harness. Reshape the Branch type and render the supplied rebase and terminal frozen states.
- Add `apps/app/src/mainview/cards/views/BranchView.tsx` and its stories. Rejected reuse: `apps/app/src/mainview/cards/BranchesCard.tsx` renders a bookmark list, not one branch's machine, presence and recovery controls; keep that list. No existing BranchView exists. Use existing shared primitives before adding CSS to `styles/cards.css`.
- Every handler follows ui-components.md Rules: `onAction` with `data-flow`, `onView`, or local state, focus or clipboard. Copy the supplied SSH line through the existing plain-HTTP-compatible clipboard helper; never execute it.

## Tests

- C-UI-12 View-phase cases in `apps/app/src/mainview/cards/views/Views.test.tsx` mount the production BranchView through its stories. Hand-written literal expectations cover all six visible machine states, item and scratch placement, all rebase states, conflict paths, frozen terminals, each presence location and watching, activity burst actions, changed-file authors and the supplied SSH line. No expectation is generated from `.specs/`, schemas, catalog descriptors or implementation code at runtime.
- Extend `apps/app/e2e/playwright/view-stories.spec.ts` at `/view-stories.html?story=BranchView/<case>`: light/dark at 1,440 px and 390 px, no overflow or serious/critical axe violation. Keyboard activation of Sleep, Wake, Retry, Add to stack, Rebase now, Resolve, Done, Return to Tn, Keep for now and a burst diff emits exactly the supplied tag and bound arguments once, with matching `data-flow`. Missing actions produce no button or callback; disabled actions produce no callback. View-state changes use only `onView`; Copy writes only the supplied SSH text. Callback spies observe the View seam because dispatch is out of scope; T-APP-10 and T-COL-05 prove the real dispatcher and route.
- C-UI-12 security/dark-state cases: hostile branch names, paths and activity text render as text without script execution; the View opens no fetch, WebSocket, SSH or terminal connection and invokes no callback on mount. The app entry through `CardRenderers.tsx` does not expose this dark View before wiring. Extend the existing parity scan for forbidden View imports.
- Extend the existing View tests with a hand-written banned-term list and body-block assertions for §14.6b; do not depend on a runtime read of the spec or T-CAT-01's implementation.

## Acceptance
- [C-UI-12](../checks/C-UI-12.md): passes for this ticket’s phase at its stated layer.

- Copy review: the design reviewer reads every story screenshot at 1,440 px and 390 px, light and dark, against spec §14.6b, and records approve or fix per screen in this ticket’s issue. The wiring ticket's own checks prove the card end to end.

## Risks and notes

- A prop the mock needs but spec §14.3 lacks is a spec change: smithers-8a accepts it before building around it. Private rpc types need no public-API sign-off (ui-components.md Rules).
- Security review owner: smithers-b8. This ticket executes no repository code, starts no machine or process, and performs no root step. Root inputs and main/branch provenance are therefore none. Repository-controlled names, paths and text are display data, never HTML or executable input. M-29 execution and no-sudo enforcement stay in the machine/runtime tickets; wiring cannot execute repository code on the host. The security/dark-state cases above prove the View boundary.

## Ready checklist

1. Dependencies: T-UI-01 supplies shared primitives. The props-only View needs no live provider; Scope states dark landing and fail-closed actions. T-APP-10 and T-COL-05 own runtime integration.
2. Exclusions: Scope names dispatch, authorization, machine/SSH/terminal execution, presence infrastructure, Pair, locks, S3 co-editing, deferred attribution/Undo and scratch replacement.
3. Tests: C-UI-12 cases exercise the production View and browser story entry with literal assertions, keyboard actions, missing/disabled actions, hostile text and dark exposure. Dispatcher/route checks stay with wiring; no expectations come from spec or code at runtime.
4. Decisions: smithers-06 accepts visuals and copy; smithers-b8 accepts the app seam; smithers-38 accepts private rpc types; smithers-8a accepts spec/prop changes. No public API is added.
5. Owner pre-review: smithers-06: Do all specified states and controls match the design in both themes and widths? Does copy meet §14.6b? smithers-b8: Do handlers preserve supplied tags/arguments and missing-action refusal? Does dark landing avoid production exposure and execution? smithers-38: Can BranchCard reuse CardAction/CardPrimitives as TS props without another schema or fixture layer? Recorded answers stand; owners review post hoc under the parallel-build directive.
6. Security: smithers-b8 reviews text-only rendering and the no-execution View boundary, proved by C-UI-12 security/dark-state cases. No repository-code execution or root step is in scope; root inputs and their sources are none.
