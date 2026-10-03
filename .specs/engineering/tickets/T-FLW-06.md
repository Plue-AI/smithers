# T-FLW-06 Learning flow, proposals, Proposal card, lessons receipt

Stage S3 · Size L · Depends on T-STK-10, T-FLW-05, T-MCH-06, T-UI-20, T-APP-19 · Unblocks T-REL-02, T-REL-03 · Issue: [#3588](https://github.com/smithersai/smithers/issues/3588)
Spec: spec.md §1.3, §3 (`proposals`, `todos.lessons`), §4.1.3, §6.1.2 (in-card), §6.3 `/api/proposals`, §7.2 `proposals`, §8.3.1, §11.8, §14.3 Proposal · Delta: delta.md §8 (learning row) · Product: mvp.md J2.6, J5.5, J8.1, §4.1 (learning receipt), §6.12 Learning, M-04, M-15, Appendix B.4 (Learning)

## Goal
After each merge, a background learning run writes source-linked decision pages to the wiki and evidence-backed proposals, the merged TODO shows "N lessons", and a proposal becomes a TODO only when a member selects Make TODO.

## Ownership (Will, 2026-10-02)

Design (smithers-06) builds every visual component and its styles: `ProposalCard` view and the lessons receipt on a merged TODO. Engineering wires them: the learning flow, `proposals`, accept and dismiss. The seam is the card's view-model schema (spec §14.2.1, T-APP-19). Design builds against it with fixture stories, and engineering doesn't edit components or CSS.

## Scope
In:
- Built-in overridable flow `learning` (`Flow.make("learning", …)`), input `{todo}`, run in an ephemeral background machine (§1.3).
- Admission after every `merged` transition, class `background` (§8.3.1). It never becomes a TODO and shows under the Home card's background runs.
- Reads: the merged TODO's attempts, check failures, review comments and steers, plus the outcomes of the last 20 merged TODOs, through the host API with the run credential.
- Output: decision pages citing the change link and run ids; proposals with title, `signature` (§11.8.2a), evidence (counts, TODO refs, failure signatures), suggested prompt and optional seed patch to a flow.
- The host records pages, proposals and `todos.lessons` (pages + proposals, §11.8.3) in one transaction from the run's typed output.
- Proposal card with two `in-card` commands (§6.1.2): **Make TODO** (`POST /api/proposals/{id}/accept`: append, seed patch through T-FLW-05's step) and **Dismiss**. No signature that is open or was dismissed within 90 days is proposed again (§11.8.2, §11.8.2a).
- The receipt on the merged TODO opens its pages and proposals.

Out:
- Any change to the `merged` state (M-15).
- Plans citing wiki revisions (T-FLW-10); wiki co-editing (T-COL-09).
- Triggers and `improve.suggest` schedules ([D] spec §11.7).

## Changes
- `flows/learning/flow.ts` (new) → the built-in `learning`. Reuse `@smthrs/agent/MemoryMine` extraction and Jev judgment, as `flows/memory/mine/flow.ts:20` (`memory/mine`) does today for decisions with run-id citations. Reuse the failure signatures from `flows/coding/learnings.ts`, extended from changes-requested rounds to failed checks, in the `check:lint@review` form.
- Admission → on the `in_review → merged` event (T-STK-04, T-GH-05), insert a `machine_requests` row of class `background` (T-MCH-06). One run per TODO, idempotent by TODO id.
- Migration (new) → `proposals` exactly as §3, `signature` included; `todos.lessons` exists from T-STK-01.
- `packages/backend/internal/services/learning.go` (new) → on run success, upsert pages through the wiki service (`packages/backend/internal/services/wiki_collaboration.go`, one revision each, attributed `{agent: "coding", run}`), insert proposals whose signature isn't open or dismissed within 90 days, set `lessons`, and write `projection_events` for `todo:<n>`, `home` and `proposals` (§3.1). The run has no write route; the host records its typed output.
- Routes → `GET /api/proposals`, `POST /api/proposals/{id}/accept` (creates the TODO with the suggested prompt and seed patch), `POST /api/proposals/{id}/dismiss`; OpenAPI rows in `docs/api/openapi/`.
- `apps/app/src/mainview/cards/ProposalCard.tsx` (new) → title, evidence, refs, state, Make TODO, Dismiss (§14.3). The TODO and Home cards show the "N lessons" receipt (T-APP-01 and T-APP-02 render the field).
- Delete the `improve.mine` declaration and fixtures: `.smithers/factory.json:1380,1401`, `flows/pack.test.mjs:490,495`, `packages/rpc/test/FactoryProjection.test.ts:86,92`, `packages/smithers/build/targets/test/Factory.test.ts:120,198`, `apps/app/src/mainview/cards/TriggersCard.test.tsx:46,134`, `apps/app/src/mainview/state/seams/TriggersSeam.test.ts:154`.

## Tests
- Unit, `flows/test/learning.test.ts` (new): evidence counts from fixture attempts ("3 of the last 5 failed lint at review"); identical inputs yield the same signature; no proposal without at least one failure signature.
- Unit, `packages/backend/internal/services/learning_test.go` (new): the receipt count equals pages plus proposals; a repeated success payload writes nothing twice; a signature dismissed 30 days ago isn't proposed, one dismissed 91 days ago is; a TODO in `merged` never gets a state event from learning.
- Integration: [C-J8-01](../checks/C-J8-01.md), with real PostgreSQL and the wiki store.
- Journey: [C-J5-03](../checks/C-J5-03.md).

## Acceptance






- [C-J5-03](../checks/C-J5-03.md): a proposal with evidence becomes a TODO, merges, and the next TODO passes lint the first time.
- [C-J8-01](../checks/C-J8-01.md): the learning run writes a decision page linked to the change and its runs.
- [C-J2-05](../checks/C-J2-05.md) (S3 part): the merged TODO shows the learning receipt.
- [C-UI-13](../checks/C-UI-13.md): A Container's model from a real topic parses with its schema and its actions come from `cardActions`; at each stage exit every §14.3 row of the stage is wired and no View is orphaned

## Risks and notes
- Risk: the decision page restates the PR description and adds no reason. Falsified by C-J8-01's assertion that the page names a reason taken from a steer or review comment.
