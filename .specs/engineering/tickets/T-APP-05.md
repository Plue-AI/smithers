# T-APP-05 Flow card with versions

Stage S1 · Size M · Depends on T-FLW-03, T-APP-16, T-UI-10, T-APP-19 · Unblocks — · Issue: to file
Spec: spec.md §4.3, §7.2 (`flows`), §10.4.1a, §11.1, §11.3, §11.4.3, §11.5, §11.5a, §14.2, §14.3 (Flow), §15.1.5 · Delta: delta.md §8 (Add `flow-load`, versions projection), §9 (Add cards [S1] Flow versions) · Product: mvp.md J5.2–J5.4, J11.2–J11.4, §6.12 Flow card, §6.14 Write flows, M-04, M-30, Appendix A `/flow`, `/flow.edit`, `/flow.source`, `/flow.plan`

## Goal
`/flow todo` shows the TODO flow's steps and tells its versions apart (Active, Proposed with its TODO, "Merged · active after sync", "Merged · not active" with the load error), so a lead sees which version new TODOs use and asks for a change from the card.

## Ownership (Will, 2026-10-02)

Design (smithers-06) builds every visual component and its styles: `FlowCard` view: source label, versions with states, steps, Source/Plan/Run/Edit, step agents. Engineering wires them: the `flows` topic container and the flow commands. The seam is the card's view-model schema (spec §14.2.1, T-APP-19). Design builds against it with fixture stories, and engineering doesn't edit components or CSS.

## Scope
In:
- `flow` card on the `flows` topic, embedded and maximized from one component:
  - version chips for `active`, `proposed` (with the proposing TODO, `todo?`, §14.3), `merged-syncing` ("Merged · active after sync") and `merged-failed` ("Merged · not active"); `previous` is in the model but has no chip;
  - the selected version's steps; steps added relative to Active are marked;
  - for `merged-failed`, "Load failed" with the error from `flow_versions.load_error` (§11.3.2);
  - the §14.3 actions: **Edit** on the Active version runs `/flow.edit <name>` without a request, so the form law asks for the request (§11.5); Source (`/flow.source <name>`, the read-only File card in S1), Plan (`/flow.plan <name>`, today's `FlowPlanCard`; on a scratch branch it shows the working-copy version, loaded in that branch's machine, §11.4.3) and Run (`/flow.run <name>`; on a scratch branch a "draft version" run, §11.4.3);
  - the agent of each step as a chip that opens its Agent card (`/agent <name>`, T-FLW-08). Its model is an owner setting (`flow_config` `agent:<role>`, §11.5a), never a TODO.
- Source, Plan, Run and the agent chips are one click away, never on the first screen (mvp.md §6.14). When the app agent runs Edit (A✓ in mvp.md Appendix B.2), it posts a one-click Confirm card instead (§15.1.5, T-APP-04). Run is `agent: run`.
- The selected version is the member's own card view state (`member_conversation_state`, T-APP-16), changed through a hidden `flow.version` control.
- System flows (§11.1.1, M-30) render read-only with no Edit, Source or Run.
- `/flow <name>` (new, Appendix A).

Out:
- Loading, activation and pinning (T-FLW-03, T-FLW-04); the patch and TODO behind `/flow.edit`, including the composition copy (§10.4.1a, T-FLW-05).
- Triggers ([D] §11.7).
- The monitor (T-FLW-07); the Agent card (T-FLW-08); editing source in the File card (T-APP-14, S3).

## Changes
- `apps/app/src/mainview/cards/FlowCard.tsx` (new) and test; spread into `cards/CardRenderers.tsx`. Reuse `cards/FlowPlanCard.tsx` (158 lines) for Plan rather than a second graph.
- `packages/rpc/src/Cards.ts`: kind `flow {name}` (the selected version is per-member view state). `packages/rpc/src/FlowVersions.ts` (new): the `flows` model, with a golden fixture shared with T-FLW-03's projection test.
- `apps/app/src/mainview/flows/entries/flow.ts`: add `/flow <name>`, the hidden `flow.version` control, and the `/flow.edit` and `/flow.source` doors.
- `apps/app/src/mainview/styles/cards.css`: port the mock's `mvp-version*` and `mvp-flow-steps` rules onto Paper tokens.

## Tests
- Unit (`FlowCard.test.tsx`): one chip per non-previous version with the right word; the default selection is Active; a member's selection survives a re-render from a new snapshot and does not change another member's card.
- Unit: a `merged-failed` version shows its error and Active stays selected by default (§11.3.2).
- Unit: added steps are marked against Active and only against Active.
- Unit: a system flow has no Edit, Source or Run.
- Unit (`flows/agent-parity.test.ts`, existing): `/flow`, `/flow.edit` and `/flow.source` have three doors; `/flow.edit` without a request renders a form.
- Unit: the card passes the C-UI-02 product-word and minimal-text lint.
- e2e: the C-J5-01 script; the Flow card moves from Proposed to "Merged · active after sync" to Active without a reload.

## Acceptance
- [C-J5-01](../checks/C-J5-01.md): flow edit from chat becomes a TODO, merges, and the Flow card shows the new version Active after sync while running TODOs keep theirs.
- [C-J11-02](../checks/C-J11-02.md): Source opens on the proposing TODO's branch; Plan and a "draft version" Run on a scratch branch show the edited graph; a repository flow runs from its slash command with a form.

## Risks and notes
- Spec gap: §14.3 Flow versions carry no source label (built-in or `flows/<name>/flow.ts`), per-step detail or system flag, which the mock shows (`cards/Flow.tsx`, `world.ts:239-248`). The card omits them until the tech lead adds them to the model.
- Risk: `FlowGraphSurface.tsx` uses `useEffect` (research/app-shell.md). Reusing the plan view must not spread it; confirmed by `rg "useEffect" cards/FlowCard.tsx` returning nothing.
