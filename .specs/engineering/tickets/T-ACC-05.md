# T-ACC-05 Person confirmations

Stage S1 · Size M · Depends on T-ACC-04, T-CAT-01 · Unblocks T-MNT-01, T-MNT-03, T-STK-04, T-TRM-02, T-APP-04 · Issue: to file
Spec: spec.md §5.4, §5.2 ("confirmation only"), §3 (`person_confirmations`), §6.3 (`/api/confirmations`), §7.2 (`confirmations` topic), §14.3 (Confirm card), §14.5.1, §15.1.3–§15.1.5 · Delta: delta.md §2 (Add `person_confirmations` + `/api/confirmations`; CLI `/merge` creates a confirmation) · Product: mvp.md §2 rule 6, §6.13 "CLI", J6.4, M-05, M-21, Appendix A closing note, Appendix B legend (A✓) and B.6

## Goal
Every delegated credential follows one rule set (§15.1.5): a command whose catalog row says `agent: run` executes at once with the member's rights; `agent: confirm` posts a confirmation the member presses from their own session, bound to the exact revision; `agent: never` is refused. Merge opens the member's **Review & merge**, maintainers only. Agents never see more than a confirmation's id and state.

## Scope
In:
- Dispatch by the catalog's `agent` field (T-CAT-01) for every delegated credential: the app agent's host turns, external agents through the CLI or skill, and terminal sessions (§15.1.5, Appendix B.6).
  - `run`: reads, UI-only flows on the prompter's own screen, steer, answer, stop, resume, retry, rebase, fork, run a flow, wiki writes. Executes with `Authorize` (T-ACC-03).
  - `confirm`: commit, amend or drop a TODO, add to stack, Bring in or Discard a foreign push, delete a wiki page, propose a flow or agent edit, and `/review`; use the descriptor’s minimum role. Create a `one_click` row and return `202 {confirmation: id, state: "requested"}` (§5.2.1).
  - Merge: `confirm` with kind `review_merge`. Created only when the member's role may merge (owner or maintainer), approved only from that member's session.
  - `never`: members, secrets, settings and merge-gating approvals. Return 403 `never` after role and scope eligibility; insufficient role or scope returns 403 `permission`. Create no row. These commands are absent from agent tools.
- The `person_confirmations` table (§3) with `kind ∈ {one_click, review_merge}` and its state machine: `pending → approved | denied | expired`. Expiry after 24 h or when the subject's revision changes (§5.4).
- Approve and deny with the same member's `session` only. On approve, run the action with that session against `revision`.
- Each confirmation is a Confirm card entry private to its member (`audience_member_id`, §14.5.1), published on that member's `confirmations:<member>` topic (§7.2.2). Shared topics never carry it.

Out:
- The Confirm card UI (T-APP-04) and the conversation entry table (T-APP-16).
- The catalog's `agent` field and its values (T-CAT-01). This ticket reads it.
- The merge mechanics: order, checks and the GitHub call (T-STK-04). This ticket calls its service.
- Browser notifications (T-APP-18).

## Changes
- `packages/backend/db/product/migrations/01NN_person_confirmations.sql` (new). Columns per §3, including `kind` (`one_click` | `review_merge`), plus the stored command payload for `one_click`; an index on `(member_id, state)`.
- `packages/backend/internal/services/confirmations.go` (new):
  - `Create(cred, kind, action, subject, revision, payload)`, `Approve(session, id)`, `Deny(session, id)`, `ListMine(cred)`, and an expiry sweep at 24 h;
  - `Approve` re-reads the subject's current revision (PR head sha for merge) in the same transaction;
  - each state change writes a projection event (§3.1) on `confirmations:<member>`.
- `packages/backend/internal/services/command_dispatch.go`: call the catalog authorizer once before dispatch; execute `run`, reject typed `never` or `permission`, or consume its internal confirmation-required decision by creating a row and returning 202 with `confirmation` and `state`. No confirmation decision is exposed as a 403 fix. C-ACC-01 covers every dispatch door.
- `packages/backend/internal/routes/confirmations.go` (new), per §6.3:
  - `GET /api/confirmations`: full rows for a session; `{id, state}` only for any other kind;
  - `POST /api/confirmations {action, subject, revision}` from any credential, for `confirm` commands only;
  - `POST /api/confirmations/{id}/approve|deny`: a session for the confirmation's member, else `permission`.
  - Every mutating route takes `Idempotency-Key` (§6.2.1).
- Action dispatch on approve: `review_merge` → T-STK-04's merge service with `reviewed_head_sha = revision`; `one_click` → the stored command, run with the member's session.
- CLI: the `merge` door (T-CAT-02) prints `{confirmation: id, state}` and exits 0 with state `requested` (§6.2.2), never "merged". Other `confirm` commands print the same shape.
- OpenAPI: `docs/api/openapi/confirmations.yaml` (new), then run `scripts/openapi-bundle.mjs`.
- Docs: the backend package docs page for confirmations. Run `pnpm docs:sync` and `pnpm docs:check`.

## Tests
- Integration, real PostgreSQL plus a GitHub fake: `compose/confirmations_integration_test.go` (new). Cases:
  - a Maintainer's delegated merge request creates a pending `review_merge` row, and the dispatch returns 202 with only `confirmation` and `state`;
  - approve is refused for a delegated, run or machine credential, and for another member's session;
  - approve with the maintainer's session calls the fake GitHub merge once, with `sha = revision`;
  - when the PR head moves before approve, the row becomes `expired` with `409 conflict`, and GitHub gets no merge call;
  - a row past 24 h is `expired`; deny settles the row, and a later approve gets `409`;
  - a Member-role delegated merge request is refused at create;
  - `/todo.new` from a host-minted `via=smithers` credential creates a `one_click` row and no TODO; the author's session press creates exactly one TODO; another member's session gets `permission`;
  - the same `/todo.new` from a `via=claude-code` CLI credential and from a `via=terminal` credential behaves the same;
  - a steer from any delegated credential runs at once with no row;
  - a members, secrets or settings write, or `approval.approve`, from any delegated credential is refused with no row.
- Integration: a confirmation reaches only its member's `confirmations:<member>` subscription; another member's subscription to it gets `err forbidden`.
- Fault: kill the host between `approved` and the GitHub call. On restart the merge reconciles through T-GH-09's key lookup, and no second merge happens (shared with C-GH-09).
- Unit: the state machine table, every allowed and refused transition, for both kinds.

## Acceptance
- [C-ACC-02](../checks/C-ACC-02.md): a confirmation can be approved only from the member's session, bound to the revision.
- [C-J6-02](../checks/C-J6-02.md): a laptop `smthrs merge` opens a confirmation.

## Risks and notes
- spec §5.4 still names "change a role" as a confirmable action; §15.1.5 makes members `never`. This ticket follows §15.1.5: no confirmation path for members, secrets or settings, so no pending row ever holds a secret value.
- `GrantConfirm` (`apps/app/src/mainview/cards/CardActions.ts`, `ChatCards.tsx`) is today's client-side confirm for consequential agent acts. The `one_click` row replaces it as the enforced path; T-APP-04 deletes the client-only path when the Confirm card reads these rows.
