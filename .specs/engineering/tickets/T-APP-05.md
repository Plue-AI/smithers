# T-APP-05 Flow card with versions

Stage S1 · Size M · Depends on T-FLW-03, T-APP-16, T-UI-10, T-APP-19 · Unblocks T-AGT-04, T-REL-02 · Issue: [#3499](https://github.com/smithersai/smithers/issues/3499)
Spec: spec.md §4.3, §7.2 (`flows`), §10.4.1a, §11.1, §11.3, §11.4.3, §11.5, §11.5a, §14.2, §14.3 (Flow), §15.1.5 · Delta: delta.md §8 (Add `flow-load`, versions projection), §9 (Add cards [S1] Flow versions) · Product: mvp.md J5.2–J5.4, J11.2–J11.4, §6.12 Flow card, §6.14 Write flows, M-04, M-30, Appendix A `/flow`, `/flow.edit`, `/flow.source`, `/flow.plan`

## Goal
`/flow todo` shows the TODO flow's steps and tells its versions apart (Active, Proposed with its TODO, "Merged · active after sync", "Merged · not active" with the load error), so a lead sees which version new TODOs use and asks for a change from the card.

## Ownership (Will, 2026-10-02)

Design (smithers-06) builds the `FlowView`, with the CSS, in T-UI-10. This ticket builds no View, CSS or editor presentation. It owns the topic decoder and golden fixture, the adapter, the Container and the commands in Changes ([card-kinds.md §1](../card-kinds.md)). The seam is the view model from T-APP-19 (spec §14.2.1).

## Scope
In:
- `flow` card on the `flows` topic, embedded and maximized from one component:
  - version chips for `active`, `proposed` (with the proposing TODO, `todo?`, §14.3), `merged-syncing` ("Merged · active after sync") and `merged-failed` ("Merged · not active"); `previous` is in the model but has no chip;
  - the selected version's steps; steps added relative to Active are marked;
  - for `merged-failed`, "Load failed" with the error from `flow_versions.load_error` (§11.3.2);
  - the §14.3 actions: **Edit** on the Active version runs `/flow.edit <name>` without a request, so the form law asks for the request (§11.5); Source (`/flow.source <name>`, the read-only File card in S1), Plan (`/flow.plan <name>`, today's `FlowPlanCard`; on a scratch branch it shows the working-copy version, loaded in that branch's machine, §11.4.3) and Run (`/flow.run <name>`; on a scratch branch a "draft version" run, §11.4.3);
  - the agent of each step as a chip that opens its Agent card (`/agent <name>`, T-FLW-08). Its model is an owner setting (`flow_config` `agent:<role>`, §11.5a), never a TODO.
- Source, Plan, Run and the agent chips are one click away, never on the first screen (mvp.md §6.14). When the app agent runs Edit (A✓ in mvp.md Appendix B.2), it posts a one-click Confirm card instead (§15.1.5, T-APP-04). Run is `agent: run`.
- The selected version is the member's own card view state (`member_conversation_state`, T-APP-16), changed through `onView`, not a catalog command.
- System flows (§11.1.1, M-30) render read-only with no Edit, Source or Run.
- `/flow <name>` (new, Appendix A).

Out:
- Loading, activation and pinning (T-FLW-03, T-FLW-04); the patch and TODO behind `/flow.edit`, including the composition copy (§10.4.1a, T-FLW-05).
- Triggers ([D] §11.7).
- The monitor (T-FLW-07); the Agent card (T-FLW-08); editing source in the File card (T-APP-14, S3).

## Changes
- `packages/rpc/src/topics/Flows.ts` (new): the `flows` decoder. `packages/rpc/test/fixtures/topics/flows.json` (new): the golden, which `flows_topic_golden_test.go` (new) compares with T-FLW-03's builder.
- `apps/app/src/mainview/cards/containers/flowModel.ts` (new): `toFlowModel(flows, name, view)`: one chip per non-`previous` version, Active selected by default, steps marked `added` relative to Active only, and the actions Edit (`/flow.edit <name>` with no request, so the form asks for it), Source, Plan, Run and each step's agent (`/agent <name>`). System flows (M-30), told apart by the catalog's system flag (T-FLW-01), get no Edit, Source or Run.
- `apps/app/src/mainview/cards/containers/FlowContainer.tsx` (new): subscribes `flows`; the selection is an `onView` patch; renders `FlowView` (T-UI-10). Plan opens the retained `flow-plan` card (`cards/FlowPlanCard.tsx`) rather than a second graph.
- `packages/rpc/src/Cards.ts`: kind `flow {name}`.
- `apps/app/src/mainview/flows/entries/flow.ts`: add `/flow <name>` and the `/flow.edit` and `/flow.source` doors.

## Tests

- C-J5-01: the adapter marks `steps[].added` relative to Active; fixtures cover added and unchanged steps.

- Unit (`flowModel.test.ts`): from `topics/flows.json`, one chip per non-`previous` version with its state; Active is the default; a `merged-failed` version carries its error and Active stays the default (§11.3.2); `added` marks steps only against Active; a system flow has no Edit, Source or Run.
- Unit (`FlowContainer.test.tsx`): a member's selection survives a new snapshot and doesn't change another member's view state.
- Unit (`flows/agent-parity.test.ts`, existing): `/flow`, `/flow.edit` and `/flow.source` have three doors; `/flow.edit` without a request renders a form; the app agent's `/flow.edit` is `confirm`.
- Unit: every `Action.label` and `disabled.reason` the adapter emits passes C-UI-02's `lintText` (engineering's copy; the View's copy is its T-UI ticket's).
- Integration: `flows_topic_golden_test.go` equals the golden.
- e2e: the C-J5-01 script through `FlowView`; the Flow card moves from Proposed to "Merged · active after sync" to Active without a reload.

## Acceptance



- [C-J11-02](../checks/C-J11-02.md): S2, S3 qualification; does not block S1 completion.


- [C-J1-04](../checks/C-J1-04.md): S1 part at its named layer.

- [C-J5-01](../checks/C-J5-01.md): flow edit from chat becomes a TODO, merges, and the Flow card shows the new version Active after sync while running TODOs keep theirs.
- [C-J11-02](../checks/C-J11-02.md): Source opens on the proposing TODO's branch; Plan and a "draft version" Run on a scratch branch show the edited graph; a repository flow runs from its slash command with a form.
- [C-UI-13](../checks/C-UI-13.md): A Container's model from a real topic parses with its schema and its actions come from `cardActions`; at each stage exit every §14.3 row of the stage is wired and no View is orphaned

## Risks and notes
- Resolved: §14.3 Flow carries the source label and each step's `detail` and `agent`. The `added` mark needs a field on T-APP-19's `FlowCard` steps (cross-group); until it lands the adapter test fails.
