# T-APP-05 Flow card with versions

Stage S1 · Size M · Depends on T-FLW-03, T-FLW-04, T-FLW-08, T-APP-16, T-APP-15, T-APP-02, T-APP-04, T-UI-10 · Unblocks T-AGT-04, T-FLW-05, T-REL-02 · Issue: [#3499](https://github.com/smithersai/smithers/issues/3499)
Spec: spec.md §4.3, §7.2 (`flows`), §10.4.1a, §11.1, §11.3, §11.4.3, §11.5, §11.5a, §14.2, §14.3 (Flow), §15.1.5 · Product: mvp.md J5.2–J5.4, J11.2–J11.4, §6.12 Flow card, §6.14 Write flows, M-04, M-30, Appendix A `/flow`, `/flow.edit`, `/flow.source`, `/flow.plan`

## Goal
`/flow todo` shows the TODO flow's steps and tells its versions apart (Active, Proposed with its TODO, "Merged · active after sync", "Merged · not active" with the load error), so a lead sees which version new TODOs use and asks for a change from the card.

## Scope
In:
- `flow` card, embedded and maximized from one component:
  - version chips for `active`, `proposed` (with its TODO), `merged-syncing` ("Merged · active after sync") and `merged-failed` ("Merged · not active"); `previous` has no chip;
  - the selected version's steps, with steps added relative to Active marked;
  - for `merged-failed`, "Load failed" with `load_error` (§11.3.2); Active stays the default;
  - actions: **Edit** on Active runs `/flow.edit <name>` with no request, so the form law asks for it (§11.5); Source (`/flow.source <name>`, the read-only File card); Plan (`/flow.plan <name>`, the retained `FlowPlanCard`); Run (`/flow.run <name>`, `agent: run`);
  - each step's agent as a chip that opens its Agent card (`/agent <name>`, T-FLW-08).
- Source, Plan, Run and agent chips are one click away, never on the first screen (mvp.md §6.14). The app agent's Edit posts a one-click Confirm card (T-APP-04).
- The selected version is the member's own view state (T-APP-16), changed through `onView`.
- System flows (§11.1.1, M-30) render read-only with no Edit, Source or Run.
- `/flow <name>` (new, Appendix A).

Out: loading, activation and pinning (T-FLW-03, T-FLW-04); seed-edit qualification and re-derivation (T-FLW-05); triggers, a graph editor, model-choice controls; the monitor (T-FLW-07); the Agent card (T-FLW-08); editing source (T-APP-14, S3); S2/S3 scratch-branch editing (C-J11-02).

## Changes
- `cards/FlowContainer.tsx` (landed, 214c4feff) is the card file. It maps the flow list to `FlowView` props: one chip per non-`previous` version, Active selected by default, `added` marked against Active only, and the actions above, bound with `flows/cardActions.ts`. Map kind `flow` to it in `cards/CardRenderers.tsx`.
- Versions read through the existing `flow.list` seam (`flows/entries/flow.ts:92`, `listWorkspaceWorkflows`), extended with each version's state, proposing TODO and `load_error` from T-FLW-03. Plan opens the retained `cards/FlowPlanCard.tsx`; no second graph.
- Deletes `cards/WorkflowCards.tsx`, `WorkflowCards.test.tsx` and `WorkflowCards.failures.test.tsx` (pair: FlowView ↔ WorkflowCards; minimal-code synthesis v1 §2). Its `workflow-list` rendering becomes the `flow` card. `WorkflowRunCardBody` and the launch, facet and observation failure copy move into `cards/RunTraceCard.tsx`, which already renders runs; update `RunTraceCard.test.tsx`, `RunsCards.test.tsx` and `RunDeadline.test.tsx` imports. The `workflow-repo` chooser moves to the legacy decoder (T-APP-22); an install wraps one repository.
- `packages/rpc/src/Cards.ts`: kind `flow {name}`.
- `flows/entries/flow.ts`: add `/flow <name>` and the `/flow.edit` and `/flow.source` doors.
- `packages/backend/internal/services/flow_edit.go` (new, moved from T-FLW-05; no flow-edit handler exists): `POST /api/flows edit{name, request}` with `Idempotency-Key`. It resolves the repository or packaged composition as text, refuses a diff outside `flows/<name>/**`, and hands the seed to Make TODO; the TODO's implement step applies it on the machine (T-FLW-11). Register `flow.edit` in the catalog (slash `/flow.edit`, CLI `smthrs flow edit`). T-FLW-05 consumes this handler and adds no second one.

## Tests
- Unit (`FlowContainer.test.tsx`, landed): one chip per non-`previous` version with its literal label; Active is the default; a `merged-failed` version carries its error and Active stays selected; `added` marks steps only against Active; a system flow has no Edit, Source or Run; a member's selection survives a new list and doesn't change another member's view state.
- Unit (`flows/agent-parity.test.ts`): `/flow`, `/flow.edit` and `/flow.source` have three doors; `/flow.edit` without a request renders a form; the app agent's `/flow.edit` is `confirm`.
- Unit (`RunTraceCard.test.tsx`): the moved run body and failure copy render the same literal text as before the move.
- Integration (real PostgreSQL, production dispatcher, composed flow routes): Source opens the proposing TODO's file; Active Plan reads the stored graph; Run admits machine work through T-FLW-04 and never shows completed on HTTP 202; unknown and system names get literal refusals without admission; an edit diff outside `flows/<name>/**` is refused.
- e2e (`e2e/real/flow-versions.spec.ts`): C-J5-01 through `CardRenderers`, `FlowContainer` and `FlowView`. Pin the seed diff, version labels and step ids; assert Proposed → Merged · active after sync → Active without reload, and the old Active kept on a failed load.

## Acceptance
- [C-J1-04](../checks/C-J1-04.md): S1 part at its named layer.
- [C-J5-01](../checks/C-J5-01.md): a flow edit from chat becomes a TODO, merges, and the Flow card shows the new version Active after sync while running TODOs keep theirs.
- [C-J11-02](../checks/C-J11-02.md): S2/S3 qualification of Source on the proposing branch, scratch Plan and Run; it does not block S1.
- [C-UI-13](../checks/C-UI-13.md): `FlowView` is reachable from `CardRenderers`; `WorkflowCards.tsx` is deleted.

## Risks and notes
- A repository or draft Plan load, Run or flow load executes only inside a machine (T-FLW-01, T-FLW-04, T-INS-02; §1.3, §17.3, M-29). No browser or host import evaluates repository flow modules. smithers-3f reviews that boundary.

## Ready checklist
1. Before start, smithers-8a accepts the Edit handler move from T-FLW-05 and the `workflow-repo` retirement. Record pre-review in #3499.
