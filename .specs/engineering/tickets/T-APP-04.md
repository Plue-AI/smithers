# T-APP-04 Confirm card: one-click confirmations and Review & merge

Stage S1 · Size M · Depends on T-ACC-02, T-ACC-04, T-CAT-01 (descriptors), T-STK-01, T-STK-05, T-COL-02, T-UI-05, T-APP-22, T-APP-09 · Unblocks T-APP-01, T-APP-02, T-APP-05, T-APP-16, T-CAT-01 (CLI phase), T-FLW-05, T-FLW-13, T-GH-06, T-MCH-08, T-MNT-01, T-MNT-03, T-REL-02, T-STK-02, T-STK-04, T-STK-06, T-STK-09, T-STK-16, T-TRM-02 · Issue: [#3498](https://github.com/smithersai/smithers/issues/3498), [#3494](https://github.com/smithersai/smithers/issues/3494)
Spec: spec.md §3 (`approvals`), §5.2, §5.4, §6.1.2 (`agent`), §6.3 (`/api/confirmations`), §6.4, §10.6.1–10.6.2, §14.3 (Confirm), §14.5.1, §15.1.3–15.1.5, §19.3 · Product: mvp.md §2 rule 6, §6.10, §6.13, J6.4, M-05, M-21, Appendix A `/merge` and closing paragraph, Appendix B legend (A✓) and B.6

## Goal
One Confirm card renders both kinds of confirmation (§15.1.5). `one_click`: when any agent asks for an `agent: confirm` command, the person it acts for presses once before it runs. `review_merge`: when any agent asks to merge, the person sees their own **Review & merge** bound to the PR head they review. Only that person's session can press either, and the agent learns only the confirmation's id and state. Confirmations are `approvals` rows (spec §3).

## Scope
In:
- The card shows kind, action, summary, subject and revision; the exact text sent (`one_click`); for `review_merge` title, place, PR, each check's name, required flag and status, and stale approval. The primary button uses the command's verb; Cancel sits beside it. It is visible only to the person who must press it, in every state (§5.4). Check: C-ACC-02.
- `review_merge` binds the reviewed head SHA and generation and uses T-STK-04's `MergeReady` decision: passed required checks with a failed optional check allow Merge; pending or failed required checks block it with the reason. A moved head re-evaluates.
- Confirm and Merge run `POST /api/confirmations/{id}/approve` with the session cookie; Cancel runs `deny`. The toast runs until the subject reports its terminal event (§19.3).
- Terminal results (`done`, `cancelled`, `expired`) render as a one-line receipt; stale revision approval shows separately.
- From T-ACC-05:
  - Dispatch reads the catalog's `agent` field (T-CAT-01) for every delegated credential. `run` executes at once through `Authorize` (T-ACC-03). `confirm` (commit, amend or drop a TODO, add to stack, Bring in or Discard, delete a wiki page, propose a flow or agent edit, `/review`) creates a pending `one_click` row and returns `202 {confirmation: id, state: "pending"}`. Merge creates `review_merge`, only when the member may merge. `never` (members, secrets, settings, merge-gating approvals) returns 403 `never` after role and scope checks; insufficient role or scope returns 403 `permission`; neither creates a row.
  - States `pending → approved | rejected | expired`; expiry after 24 h or when the subject's revision changes.
  - Approve and deny only from the requesting member's session. Approve rechecks active status, current role, scope and the subject revision in the subject transaction, then runs the action with that session. A missing action handler returns `503 infra/confirmation_unavailable` before any effect and leaves the row pending. MergeReady and definitive GitHub refusals leave it pending; only a confirmed merge settles it approved.
  - `GET /api/confirmations` lists the caller's own rows (delegated callers see id and state only; run and machine get 403 `permission`; dead callers 401). `POST /api/confirmations` accepts only an eligible full-scope delegated dispatch of a `confirm` command, with one `Authorize` decision. Every mutating route takes `Idempotency-Key` (§6.2.1).

Out: merge guard, squash call and order (T-STK-04, which installs the real merge handler); the catalog `agent` column (T-CAT-01); host turns and persisting the card as a private conversation entry (T-APP-16); the person's own Merge on the TODO card (T-APP-02); browser notifications (T-APP-18); new command policies and host execution of repository code.

## Changes
- `cards/ApprovalCard.tsx` is the card file, migrated in place: it maps the approval row to `views/ConfirmView.tsx` props and binds the verb, Merge and Cancel to approve and deny through `flows/cardActions.ts`, one `Idempotency-Key` per press. `model.action` supplies only the verb label; its initiating tag is never dispatched. Deletes its old markup and `cards/ApprovalAnswer.tsx` with `ApprovalAnswer.test.tsx` (pair: ConfirmView ↔ ApprovalCard + ApprovalAnswer; minimal-code synthesis v1 §2).
- `packages/rpc/src/Cards.ts`: the `approval` kind's payload becomes the Confirm schema; old rows decode through T-APP-22.
- From T-ACC-05: reshape `approvals` (`0001_product_baseline.sql:1884`) in one migration: `session_id` nullable; add `member_id`, `credential_id`, command, subject, revision, and `generation` and `reviewed_head_sha` for `review_merge`. Extend `services/approvals.go` (idempotent decide, 409, expiry) with dispatch-created rows and execute-on-approve. Existing code considered: no other person-approval store exists; `approvals` already has the states, `payload` and `expires_at`.
- `services/command_dispatch.go`: call the catalog authorizer once; run, refuse, or create the row and return 202.
- `routes/confirmations.go` (new; no confirmation route exists) and `docs/api/openapi/confirmations.yaml`, bundled with `scripts/openapi-bundle.mjs`; backend docs page, then `pnpm docs:sync` and `pnpm docs:check`.
- Delete the client-only `GrantConfirm` path (`ChatCards.tsx:73`, `cards/BillingCards.tsx:120`); the approval row is the enforced path.
- `flows/entries/history.ts`: replace `history.land` with `/merge Tn`; delete `landStackItem` (`StackSeam.ts:75`). Remove `change.land` and `prs.land` as member doors; T-STK-04 owns the `prs.land` handler.
- `cards/RunsCards.tsx`: move `ApprovalsInboxCardBody` (kind `approvals-inbox`) next to the Confirm card file when T-UI-12 folds `RunsCards.tsx` into `RunTraceCard.tsx`; card-kinds.md §3 retires the kind with T-CAT-01's `/runs` rename.
- `flows/agent-parity.test.ts`: approve and deny stay user-only with a `userOnlyReason`.
- `e2e/playwright/landing-history.spec.ts`: replace the land flow with the confirmation flow.

## Tests
- Unit (`ApprovalCard.test.tsx`): both kinds pending and in `done`, `cancelled` and `expired`, stale approval asserted separately. For `review_merge`, Merge is enabled exactly when `merge_block` is absent; a pending required check shows "Checks running"; a viewer who may not merge gets no enabled Merge. Each press sends approve or deny with the exact subject and revision for subjects `todo`, `branch`, `flow`, `agent` and `wiki`; no Members, Secrets or Settings path exists.
- Unit (Go): the state table for both kinds, every allowed and refused transition.
- Integration (`compose/confirmations_integration_test.go`, real PostgreSQL, composed router, production dispatcher, GitHub fake):
  - a delegated `/todo.new` returns literal `202 {"confirmation": <id>, "state": "pending"}` and creates no TODO; the author's session press creates exactly one; another member's session gets 403 `permission`;
  - approve from a delegated, run or machine credential gets 403 `permission`;
  - a moved head before approve gives `expired` and 409 with zero merge calls; a row past 24 h is `expired`; deny then approve gets 409;
  - a Member-role delegated merge is refused at create; a steer runs at once with no row; a members, secrets or settings write or `approval.approve` from any delegated credential is refused with no row;
  - an absent handler gives `503 infra/confirmation_unavailable` and zero effects;
  - same key and request replays; same key with another command gives 409 `idempotency_mismatch`; a duplicate session press produces one effect;
  - a confirmation reaches only its member's `/api/live` subscription; another member's subscription gets `forbidden`.
- Merge-handler cases, including kill between approval and the GitHub call with no second merge, run in T-STK-04 with T-GH-09; until then they are pending.
- e2e (`e2e/real/confirm-merge.spec.ts`): a delegated Drop executes only after its person presses the verb; a 202 leaves the toast running; the agent transcript holds only the id and state, never the head SHA or check details.

## Acceptance
- [C-J1-04](../checks/C-J1-04.md): S1 part at its named layer.
- [C-ACC-02](../checks/C-ACC-02.md): a confirmation can be approved only from the member's session, bound to the revision; delegated, run and machine credentials can't merge or approve.
- [C-J6-02](../checks/C-J6-02.md): a laptop `smthrs merge` opens a confirmation.
- [C-UI-13](../checks/C-UI-13.md): `ConfirmView` is reachable from `CardRenderers`; `ApprovalAnswer.tsx` and `ApprovalCard.tsx`'s old markup are deleted.

## Risks and notes
- Risk: the tool result leaks card payloads to the agent. Confirmed if the e2e agent transcript contains the head SHA or check details.
- Approval grants only the re-authorized command, never a reusable credential. A repository-executing target still runs only on a machine (§17.3, M-29). smithers-3f reviews session-only approval, private audience and the execution seam.

## Ready checklist
1. Before start, smithers-3f confirms approve rechecks role and revision and deduplicates effects, and a missing handler leaves the row pending. Record pre-review in #3498.
