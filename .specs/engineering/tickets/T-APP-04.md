# T-APP-04 Confirm card: one-click confirmations and Review & merge

Stage S1 · Size M · Depends on T-ACC-05, T-STK-04, T-UI-05, T-APP-19, T-APP-08, T-APP-16, T-APP-22, T-APP-09, T-STK-05, T-ACC-06 · Unblocks T-APP-01, T-APP-02, T-APP-05, T-FLW-05, T-FLW-13, T-MNT-03, T-REL-02, T-TRM-02 · Issue: [#3498](https://github.com/smithersai/smithers/issues/3498)
Spec: spec.md §5.2, §5.4, §6.1.2 (`agent`), §6.4, §7.2 (`confirmations`), §10.6.1–10.6.2, §14.3 (Confirm), §14.5.1, §15.1.3–15.1.5, §19.3 · Delta: delta.md §2 (Add `person_confirmations`, the Confirm card), §6 (Delete `change.land` as a TODO merge path) · Product: mvp.md §2 rule 6, §6.10, §6.13, M-05, M-21, Appendix A `/merge` and closing paragraph, Appendix B legend (A✓)

## Goal
One Confirm card renders both kinds of `person_confirmations` (§15.1.5). `one_click`: when any agent (the app agent, Claude Code, the CLI) asks for an `agent: confirm` command, the person it acts for presses once before it runs. `review_merge`: when any agent asks to merge, the person sees their own **Review & merge** card bound to the PR head they review. Only that person's browser session can press either, and the agent learns only the confirmation's id and state.

## Ownership (Will, 2026-10-02)

Design (smithers-06) builds the `ConfirmView` in both kinds, with the CSS, in T-UI-05. This ticket builds no View, CSS or editor presentation. It owns the topic decoder and golden fixture, the adapter, the Container and the commands in Changes ([card-kinds.md §1](../card-kinds.md)). The seam is the view model from T-APP-19 (spec §14.2.1).

## Scope

- A Confirm card is visible only to the person who must press it. Other viewers see nothing in pending or terminal states (§5.4, §15.1.5). Check: C-ACC-02.

In:
- `confirm` on the person’s own `confirmations:<member>` topic (§7.2.2): kind, action, summary, subject and revision, exact text sent (`one_click`), and for `review_merge` title, place, PR, revision-bound evidence with each check, stale approval and `merge`; Cancel and confirm. Check: C-ACC-02.
- Kind `one_click`: a command whose catalog row says `agent: confirm` (§6.1.2, §15.1.5): commit or drop a TODO, add a scratch branch to the stack, delete a wiki page, propose a flow or agent edit. The card names the command and its arguments; The primary button uses the command's verb and runs it from the person's session, with Cancel beside it. Commands with `agent: run` (reads, steer, answer, stop, resume, retry, rebase, fork, run a flow, wiki writes) never produce a card, and `agent: never` commands are refused, never confirmed.
- Kind `review_merge`: bind the reviewed SHA and generation, display each check’s name, required flag and status, and use T-STK-04's shared `DecideMerge`/`MergeReady` decision as the TODO Container and T-STK-04 (§10.6.2). Passed required checks plus a failed optional check allow Merge; pending or failed required checks block it with the required check’s reason. Re-evaluate when the head changes; only the requesting owner or maintainer’s session approves. Check: C-J2-05.
- The entry is private to its member (`audience_member_id`, §14.5.1): it publishes on the member's own topics, so other members of the branch conversation see nothing in its place.
- App-agent requests come from the host turn runner (§15.1.4) with a host-minted `delegated(via=smithers)` credential for the prompt's author; the browser holds no bearer. `/merge Tn` from any delegated actor creates a `review_merge` confirmation (T-ACC-05 route), and the tool result carries only `{id, state}` (§5.4).
- Confirm and Merge run `POST /api/confirmations/{id}/approve` with the session cookie; Cancel runs `deny`. The toast stays running until the subject's topic reports the command's terminal event, for example `todo:<n>` reporting `merged` or the merge refusal (§19.3).
- Terminal results (`done`, `cancelled`, `expired`) render as a one-line receipt. A confirmation expires after 24 h or when its subject's revision changes (§5.4); a new request creates a new one. Stale describes revision approval separately from the receipt result. Check: C-UI-13.

Out:
- The merge guard, squash call and order rule (T-STK-04); confirmation storage, kinds and session-only approval (T-ACC-05); the `agent` column of each catalog row (T-CAT-01); the host turn runner (T-APP-23).
- The person's own Merge on the TODO card (T-APP-02), which needs no confirmation because the session acts.
- Confirmations for members, secrets, settings or merge-gating approvals: these are `agent: never` (§15.1.5), so no agent can request one.
- New command policies, direct GitHub merges, host-turn execution/recovery, public API expansion, new Views/CSS and removal of StackSeam consumers that still belong to other tickets. Host-turn/tab-close coverage belongs to T-APP-23 after this card is wired.

## Changes

- T-STK-04 owns the `prs.land` command handler and install route deletion; T-APP-04 binds and removes the control only. Confirmation state is `pending`. Checks: C-STK-07, C-ACC-02.
- `packages/rpc/src/topics/Confirmations.ts` (new): the `confirmations:<member>` decoder, with `kind: one_click | review_merge`. `packages/rpc/test/fixtures/topics/confirmations.json` (new): the golden, which `confirmations_golden_test.go` (new) compares with T-ACC-05's builder.
- `apps/app/src/mainview/cards/containers/confirmModel.ts` (new): `toConfirmModel(row, viewer, todo?)`: the verb from the catalog descriptor; for `review_merge`, Merge's state from the subject TODO's `merge_block` (`MergeReady`, §10.6.2a) at the bound head, with each check's name, required flag and status from the TODO's PR; one-line receipt results `done`, `cancelled` and `expired`; stale describes revision approval separately.
- `apps/app/src/mainview/cards/containers/ConfirmContainer.tsx` (new): subscribes `confirmations:<member>` and the subject's `todo:<n>`; Confirm and Merge run `POST /api/confirmations/{id}/approve` with the session cookie and Cancel runs `deny`; renders `ConfirmView` (T-UI-05).
- `packages/rpc/src/Cards.ts`: kind `confirm {confirmation_id}`.
- `apps/app/src/mainview/flows/entries/history.ts`: replace `history.land` (`:120`) with `/merge Tn`. Delete `landStackItem` (`state/seams/StackSeam.ts:75`) only; T-APP-01 removes the remaining seam once T-APP-02 and this ticket have replaced their readers. Do not depend on the downstream Home/TODO tickets.
- Register `confirm` in `cards/CardRenderers.tsx`; ConfirmContainer builds actions through `cardActions` → `flowAction` for the approve/deny catalog controls, with one Idempotency-Key per press. The private entry writer comes from T-APP-16. Consume T-APP-19b contracts. Bind the verb, Merge/Review & merge and Cancel controls to supplied `actions[]` approve/deny actions with subject/revision arguments. `model.action` supplies only the verb label; never dispatch its initiating tag. Subject kinds are `todo|branch|flow|agent|wiki`; no Members/Secrets/Settings path exists. Checks: C-UI-13, C-ACC-02.
- `apps/app/src/mainview/flows/entries/change.ts` and `prs.ts`: remove `change.land` and `prs.land` as member doors (Appendix A maps both to `/merge`).
- `flows/agent-parity.test.ts`: Merge's approve and the confirm button stay user-only with a `userOnlyReason` (AGENTS.md three-door law).
- `apps/app/e2e/playwright/landing-history.spec.ts`: replace the land flow with the confirmation flow.

## Tests

- C-UI-13 production-boundary regression: press the verb, Merge/Review & merge and Cancel from T-APP-19b fixtures through CardRenderers/ConfirmContainer and the production approve/deny routes. Assert the supplied action and exact subject/revision arguments; fail if the initiating `model.action` tag is dispatched. Cover `todo|branch|flow|agent|wiki`, absence of Members/Secrets/Settings confirmation paths, terminal receipt results `done|cancelled|expired` and separate stale revision approval. Retain C-ACC-02 private audience assertions on every state.

- C-ACC-02: `one_click` fixtures cover amend, Bring in, maintainer-only Discard and `/review` with the literal catalog policy.

- Unit (`confirmModel.test.ts`): both kinds in pending and terminal results `done`, `cancelled`, `expired` by time or a moved head, with stale revision approval asserted separately. For `review_merge`, Merge is enabled exactly when `merge_block` is absent: passed required checks with a failed optional check enable it; a pending required check disables it with "Checks running"; a viewer who may not merge gets no enabled Merge.
- Unit (`ConfirmContainer.test.tsx`): the Container subscribes only its member's `confirmations:<member>`; another member's `conversation:<branch>` stream never carries the row.
- Unit: every `Action.label` and `disabled.reason` the adapter emits passes C-UI-02's `lintText` (engineering's copy; the View's copy is its T-UI ticket's).
- Integration (`apps/app/src/mainview/state/seams/ConfirmationSeam.test.ts`, new): use the production dispatcher/authorizer, composed merge/confirmation routes, real PostgreSQL and real `/api/live` subscriptions. A delegated Merge/Drop creates one row per key and no effect before approval; Stop runs at once without a row. Non-session or wrong-member approval returns literal 403 permission; expiry or a moved subject prevents execution; duplicate eligible press sends one GitHub merge. Another member receives no card, placeholder or receipt on shared/member streams. `confirmations_golden_test.go` compares the real builder with a pinned fixture. Literal policy, SHA, state and error fixtures supply expected values; no test reads spec files or uses the production authorizer/merge function to compute expectations.
- e2e (`apps/app/e2e/real/confirm-merge.spec.ts`, new): invoke the production delegated command path, then open the private entry through CardRenderers/ConfirmContainer/ConfirmView. Merge by its person sends the literal reviewed SHA; Drop executes only after its person presses the command's verb. Actor chips use T-APP-09. A 202 leaves the toast running until the subject's terminal event; a refused merge keeps the confirmation pending. The host-turn prompt and close-tab recovery extension runs in T-APP-23.
- Rendering of both kinds and their receipts is T-UI-05's.

## Acceptance

- [C-J1-04](../checks/C-J1-04.md): S1 part at its named layer.

- [C-ACC-02](../checks/C-ACC-02.md): delegated, run and machine credentials can't merge or approve; the confirmation this card shows can be approved only from a session.
- [C-UI-13](../checks/C-UI-13.md): A Container's model from a real topic parses with its schema and its actions come from `cardActions`; at each stage exit every §14.3 row of the stage is wired and no View is orphaned

## Risks and notes
- Resolved: §5.4 no longer names a role change as confirmable; members are `agent: never` (§15.1.5).
- `cards/Confirm.tsx` is absent in the current checkout. Use §14.3/T-APP-19's Confirm model; a requested extra field goes to smithers-8a, with smithers-06 accepting its View seam and smithers-38 signing off the RPC API under §21.1.
- Risk: the tool contract leaks card payloads to the agent. Confirmed if the agent transcript of the e2e contains the head sha or check details, which is more than §5.4 allows.

## Ready checklist

1. Depends on supplies confirmation/merge handlers, live subscriptions, private entry storage, schema/View, actor decoding, legacy decoding, Drop/Stop and revocation. Removing the remaining StackSeam and host-turn recovery are downstream work, avoiding a Home/TODO cycle.
2. Out names backend policy/merge/storage, own-session TODO Merge, all person-only commands, host turns, public API expansion, visuals and unrelated seam readers.
3. C-ACC-02 and the app tests use production dispatch, composed create/approve/deny/merge routes and live private subscriptions with PostgreSQL, followed by the real renderer/Container/View. Literal policy/SHA/state/error fixtures define expectations; other viewers see nothing.
4. smithers-8a decides extra fields and cutover ownership; smithers-06 accepts ConfirmView; smithers-b8 accepts app/catalog behavior; smithers-38 accepts the decoder; smithers-3f accepts revision/merge/credential rules.
5. Before start, smithers-06: do both kinds, command-verb buttons and receipts fit ConfirmView? smithers-b8: do cardActions use the same approve/deny dispatcher and keep 202 running; are private receipts hidden from others? smithers-38: does the pinned decoder preserve both kinds and bound revisions? smithers-3f: do presses reauthorize the active member/revision and deduplicate effects; do agents see only id/state? Record pre-review in #3498.
6. Confirmations never execute their saved text on the host; an eligible session press dispatches the bound packaged command. Repository-executing targets remain machine-only through T-INS-02/T-FLW-01 (§17.3, M-29). smithers-3f reviews exact-revision dispatch, credential scope and this execution boundary; C-ACC-02 proves refusal before effects.

