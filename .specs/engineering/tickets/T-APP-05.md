# T-APP-05 Flow card with versions

Stage S1 · Size M · Depends on T-FLW-03, T-APP-16, T-UI-10, T-APP-19, T-APP-08, T-FLW-04, T-FLW-08, T-APP-15, T-APP-02, T-APP-04 · Unblocks T-AGT-04, T-FLW-05, T-REL-02 · Issue: [#3499](https://github.com/smithersai/smithers/issues/3499)
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
- Loading, activation and pinning (T-FLW-03, T-FLW-04). This ticket owns the shared Edit/Source command handlers required by its controls; T-FLW-05, which already depends on this card, owns subsequent seed-edit journey qualification and re-derivation coverage. smithers-8a accepts this split before start.
- Triggers ([D] §11.7), a graph editor, new flow-runtime/public library abstractions, loading repository modules in the app/host, changes to system-flow mutability, model-choice controls and new Views/CSS.
- Scratch-branch S2/S3 editing/qualification belongs to C-J11-02 after the branch/capture/editor dependencies land; it does not block this ticket's S1 version/Active-plan/Run wiring.
- The monitor (T-FLW-07); the Agent card (T-FLW-08); editing source in the File card (T-APP-14, S3).

## Changes
- `packages/rpc/src/topics/Flows.ts` (new): the `flows` decoder. `packages/rpc/test/fixtures/topics/flows.json` (new): the golden, which `flows_topic_golden_test.go` (new) compares with T-FLW-03's builder.
- `apps/app/src/mainview/cards/containers/flowModel.ts` (new): `toFlowModel(flows, name, view)`: one chip per non-`previous` version, Active selected by default, steps marked `added` relative to Active only, and the actions Edit (`/flow.edit <name>` with no request, so the form asks for it), Source, Plan, Run and each step's agent (`/agent <name>`). System flows (M-30), told apart by the catalog's system flag (T-FLW-01), get no Edit, Source or Run.
- `apps/app/src/mainview/cards/containers/FlowContainer.tsx` (new): subscribes `flows`; the selection is an `onView` patch; renders `FlowView` (T-UI-10). Plan opens the retained `flow-plan` card (`cards/FlowPlanCard.tsx`) rather than a second graph.
- `packages/rpc/src/Cards.ts`: kind `flow {name}`.
- `apps/app/src/mainview/flows/entries/flow.ts`: add `/flow <name>` and the `/flow.edit` and `/flow.source` doors.
- Move T-FLW-05's shared command implementation here: `packages/backend/internal/services/flow_edit.go` (new), mounted `POST /api/flows edit{name, request}`, its OpenAPI/typed errors/Idempotency-Key and the Make TODO seed handoff. Resolve repository or packaged composition as text; validate that the diff touches only `flows/<name>/**`. Source uses the proposing TODO branch or the empty-seed path of §11.5b. Ensure the TODO create path stores `todo_revisions.seed_patch_blob` and T-FLW-11's implement step applies it on the machine with attributed evidence. T-FLW-05 retains end-to-end re-derivation qualification; neither ticket creates a second handler. Register `flow.edit` in `packages/rpc/src/catalog/` with slash `/flow.edit`, CLI path `smthrs flow edit`, group Flows and visibility `core`; register Make TODO as an `in-card` row. On failed seed application, pass the request and failed hunks to the machine agent and record "seed patch re-derived" in attempt evidence. Check: C-J5-01.

## Tests

- C-J5-01: the adapter marks `steps[].added` relative to Active; fixtures cover added and unchanged steps.

- Unit (`flowModel.test.ts`): from `topics/flows.json`, one chip per non-`previous` version with its state; Active is the default; a `merged-failed` version carries its error and Active stays the default (§11.3.2); `added` marks steps only against Active; a system flow has no Edit, Source or Run.
- Unit (`FlowContainer.test.tsx`): a member's selection survives a new snapshot and doesn't change another member's view state.
- Unit (`flows/agent-parity.test.ts`, existing): `/flow`, `/flow.edit` and `/flow.source` have three doors; `/flow.edit` without a request renders a form; the app agent's `/flow.edit` is `confirm`.
- Unit: every `Action.label` and `disabled.reason` the adapter emits passes C-UI-02's `lintText` (engineering's copy; the View's copy is its T-UI ticket's).
- Integration: `flows_topic_golden_test.go` compares T-FLW-03's real builder with the pinned golden on real PostgreSQL. Invoke `/flow`, Edit, Source, Plan and Run through the production dispatcher and composed flow routes, using the real `/api/live` flows/view subscriptions. Source opens the proposing TODO's file, Active Plan reads the stored graph, and Run admits machine work through T-FLW-04. Unknown/system names get literal refusal fixtures without admission. A requested run never displays completed on HTTP 202.
- e2e (`apps/app/e2e/real/flow-versions.spec.ts`, new): C-J5-01 uses CardRenderers/FlowContainer/FlowView, the form/Confirm/Draft destinations and the real merged-source loader. Pin the seed diff, version labels, step ids/added marks and D1/D2 run bindings in fixtures; assert Proposed → Merged · active after sync → Active without reload, and keep the old Active on a failed load. No test reads spec files or computes expected graphs/digests/actions from the loader or adapter under test.

## Acceptance



- [C-J11-02](../checks/C-J11-02.md): S2, S3 qualification; does not block S1 completion.


- [C-J1-04](../checks/C-J1-04.md): S1 part at its named layer.

- [C-J5-01](../checks/C-J5-01.md): flow edit from chat becomes a TODO, merges, and the Flow card shows the new version Active after sync while running TODOs keep theirs.
- [C-J11-02](../checks/C-J11-02.md): S2/S3 qualification of Source on the proposing branch, scratch Plan/Run and repository-flow forms; it does not block S1 completion. S1 production command/route coverage is in `flow-versions.spec.ts` and the integration cases above.
- [C-UI-13](../checks/C-UI-13.md): A Container's model from a real topic parses with its schema and its actions come from `cardActions`; at each stage exit every §14.3 row of the stage is wired and no View is orphaned

## Risks and notes
- §14.3 already carries source, step detail/agent and `added`; T-APP-19's FlowCard must expose them before this ticket starts. smithers-8a decides any missing field or system-flow policy change; smithers-06 accepts FlowView; smithers-b8 accepts command/destination behavior; smithers-38 signs off topic/retained-card compatibility under §21.1; smithers-3f accepts machine dispatch and pinning.
- This ticket owns the retained `flow-plan` and `workflow-list` schema snapshots under §14.3.0. Preserve their existing renderers and pinned old CardSchema rows; add no second plan graph or new card model without smithers-8a's spec decision.

## Ready checklist

1. Depends on covers flow loading and pinned machine execution, TODO/seed storage and implementation through the Draft backend's prerequisite closure, Agent/File/Draft/Confirm destinations, live client, per-member selection, schemas and FlowView. This ticket supplies Edit/Source handlers before T-FLW-05's downstream qualification, avoiding the current reverse dependency. Later scratch/editor qualification has its own S2/S3 gate.
2. Out names activation/pinning and downstream edit qualification, triggers, graph editors, new runtime APIs, host repository imports, system policy, model settings, monitor, S3 source editing and visual work.
3. C-J5-01 and flow-versions.spec.ts use production catalog dispatch, CardRenderers/Container/View, real flow/live/view routes and machine admission. Literal seed/graph/version/action fixtures define expectations; loader/adapter output is actual data only.
4. smithers-8a decides the Edit/Source ownership split, fields and system policy; smithers-06 accepts the View; smithers-b8 accepts app commands; smithers-38 accepts RPC and retained-card compatibility; smithers-3f accepts execution/pinning.
5. Before start, smithers-06: do versions, added steps and selection callbacks fit FlowView? smithers-b8: do Source/Plan/Run/Edit and Agent destinations all have real handlers; does missing input reach the right form/Confirm path? smithers-38: do topic/FlowCard and retained plan/list rows remain compatible? smithers-3f: do repository Plan/Run and flow-load stay machine-only and preserve pinned digests? Record pre-review in #3499.
6. Active Plan reads stored graph data; a repository/draft Plan load, Run or flow-load executes only inside a machine under T-FLW-01/04 and T-INS-02 (§1.3, §17.3, M-29). No browser or host import evaluates repository flow modules for Plan or Run. smithers-3f reviews that boundary; integration and C-J11-02 record zero host-side repository execution and refusal before TODO proposal from a draft run.

