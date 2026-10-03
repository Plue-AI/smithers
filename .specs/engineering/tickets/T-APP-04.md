# T-APP-04 Confirm card: one-click confirmations and Review & merge

Stage S1 · Size M · Depends on T-ACC-05, T-STK-04, T-UI-05, T-APP-19 · Unblocks T-MNT-03, T-REL-02 · Issue: [#3498](https://github.com/smithersai/smithers/issues/3498)
Spec: spec.md §5.2, §5.4, §6.1.2 (`agent`), §6.4, §7.2 (`confirmations`), §10.6.1–10.6.2, §14.3 (Confirm), §14.5.1, §15.1.3–15.1.5, §19.3 · Delta: delta.md §2 (Add `person_confirmations`, the Confirm card), §6 (Delete `change.land` as a TODO merge path) · Product: mvp.md §2 rule 6, §6.10, §6.13, M-05, M-21, Appendix A `/merge` and closing paragraph, Appendix B legend (A✓)

## Goal
One Confirm card renders both kinds of `person_confirmations` (§15.1.5). `one_click`: when any agent (the app agent, Claude Code, the CLI) asks for an `agent: confirm` command, the person it acts for presses once before it runs. `review_merge`: when any agent asks to merge, the person sees their own **Review & merge** card bound to the PR head they review. Only that person's browser session can press either, and the agent learns only the confirmation's id and state.

## Ownership (Will, 2026-10-02)

Design (smithers-06) builds the `ConfirmView` in both kinds, with the CSS, in T-UI-05. This ticket builds no View, CSS or editor presentation. It owns the topic decoder and golden fixture, the adapter, the Container and the commands in Changes ([card-kinds.md §1](../card-kinds.md)). The seam is the view model from T-APP-19 (spec §14.2.1).

## Scope

- A Confirm card is visible only to the person who must press it. Other viewers see nothing in pending or terminal states (§5.4, §15.1.5). Check: C-ACC-02.

In:
- `confirm` on the person’s own `confirmations:<member>` topic (§7.2.2): kind, action, summary, subject and revision, exact text sent (`one_click`), and for `review_merge` title, place, PR, revision-bound evidence with each check, stale approval and `merge`; Cancel and confirm. Check: C-ACC-02.
- Kind `one_click`: a command whose catalog row says `agent: confirm` (§6.1.2, §15.1.5): commit or drop a TODO, add a scratch branch to the stack, delete a wiki page, propose a flow or agent edit. The card names the command and its arguments; **Confirm** runs it from the person's session. Commands with `agent: run` (reads, steer, answer, stop, resume, retry, rebase, fork, run a flow, wiki writes) never produce a card, and `agent: never` commands are refused, never confirmed.
- Kind `review_merge`: bind the reviewed SHA and generation, display each check’s name, required flag and status, and use the same `CanMerge` decision as the TODO Container and T-STK-04 (§10.6.2). Passed required checks plus a failed optional check allow Merge; pending or failed required checks block it with the required check’s reason. Re-evaluate when the head changes; only the requesting owner or maintainer’s session approves. Check: C-J2-05.
- The entry is private to its member (`audience_member_id`, §14.5.1): it publishes on the member's own topics, so other members of the branch conversation see nothing in its place.
- App-agent requests come from the host turn runner (§15.1.4) with a host-minted `delegated(via=smithers)` credential for the prompt's author; the browser holds no bearer. `/merge Tn` from any delegated actor creates a `review_merge` confirmation (T-ACC-05 route), and the tool result carries only `{id, state}` (§5.4).
- Confirm and Merge run `POST /api/confirmations/{id}/approve` with the session cookie; Cancel runs `deny`. The toast stays running until the subject's topic reports the command's terminal event, for example `todo:<n>` reporting `merged` or the merge refusal (§19.3).
- Terminal states (approved, denied, expired) render as a one-line receipt. A confirmation expires after 24 h or when its subject's revision changes (§5.4); a new request creates a new one.

Out:
- The merge guard, squash call and order rule (T-STK-04); confirmation storage, kinds and session-only approval (T-ACC-05); the `agent` column of each catalog row (T-CAT-01); the host turn runner (T-APP-23).
- The person's own Merge on the TODO card (T-APP-02), which needs no confirmation because the session acts.
- Confirmations for role changes: roles are `agent: never` (§15.1.5), so no agent can request one.

## Changes
- `packages/rpc/src/topics/Confirmations.ts` (new): the `confirmations:<member>` decoder, with `kind: one_click | review_merge`. `packages/rpc/test/fixtures/topics/confirmations.json` (new): the golden, which `confirmations_golden_test.go` (new) compares with T-ACC-05's builder.
- `apps/app/src/mainview/cards/containers/confirmModel.ts` (new): `toConfirmModel(row, viewer, todo?)`: the verb from the catalog descriptor; for `review_merge`, Merge's state from the subject TODO's `merge_block` (`MergeReady`, §10.6.2a) at the bound head, with each check's name, required flag and status from the TODO's PR; one-line receipts for approved, denied and expired.
- `apps/app/src/mainview/cards/containers/ConfirmContainer.tsx` (new): subscribes `confirmations:<member>` and the subject's `todo:<n>`; Confirm and Merge run `POST /api/confirmations/{id}/approve` with the session cookie and Cancel runs `deny`; renders `ConfirmView` (T-UI-05).
- `packages/rpc/src/Cards.ts`: kind `confirm {confirmation_id}`.
- `apps/app/src/mainview/flows/entries/history.ts`: replace `history.land` (`:120`) with `/merge Tn`. Delete `landStackItem` (`state/seams/StackSeam.ts:75`) and, with T-APP-01 and T-APP-02 landed, the rest of `StackSeam.ts`.
- `apps/app/src/mainview/flows/entries/change.ts` and `prs.ts`: remove `change.land` and `prs.land` as member doors (Appendix A maps both to `/merge`).
- `flows/agent-parity.test.ts`: Merge's approve and the confirm button stay user-only with a `userOnlyReason` (AGENTS.md three-door law).
- `apps/app/e2e/playwright/landing-history.spec.ts`: replace the land flow with the confirmation flow.

## Tests

- C-ACC-02: `one_click` fixtures cover amend, Bring in, maintainer-only Discard and `/review` with the literal catalog policy.

- Unit (`confirmModel.test.ts`): both kinds in pending, approved, denied, expired by time and expired by a moved head. For `review_merge`, Merge is enabled exactly when `merge_block` is absent: passed required checks with a failed optional check enable it; a pending required check disables it with "Checks running"; a viewer who may not merge gets no enabled Merge.
- Unit (`ConfirmContainer.test.tsx`): the Container subscribes only its member's `confirmations:<member>`; another member's `conversation:<branch>` stream never carries the row.
- Unit: every `Action.label` and `disabled.reason` the adapter emits passes C-UI-02's `lintText` (engineering's copy; the View's copy is its T-UI ticket's).
- Integration (`apps/app/src/mainview/state/seams/ConfirmationSeam.test.ts`, new, real backend with PostgreSQL): the app agent's `/merge T1` and `/todo.drop T2` each create exactly one confirmation per idempotency key with the right kind, and neither runs before approval; its `/todo.stop T2` runs at once with no confirmation; approving with any non-session credential returns 403 and leaves the row pending; `confirmations_golden_test.go` equals the golden.
- e2e (`apps/app/e2e/real/confirm-merge.spec.ts`, new): "merge T1" through ⌘K renders the Review & merge card; Merge by the person merges at the subject sha; the transcript shows "Smithers, for Ben" opening it and Ben merging (M-34). "drop T2" renders a one-click card, and T2 is dropped only after Ben confirms. Ben closes the tab while the agent's turn runs, and the card is there when he returns.
- Rendering of both kinds and their receipts is T-UI-05's.

## Acceptance

- [C-J1-04](../checks/C-J1-04.md): S1 part at its named layer.

- [C-ACC-02](../checks/C-ACC-02.md): delegated, run and machine credentials can't merge or approve; the confirmation this card shows can be approved only from a session.
- [C-UI-13](../checks/C-UI-13.md): A Container's model from a real topic parses with its schema and its actions come from `cardActions`; at each stage exit every §14.3 row of the stage is wired and no View is orphaned

## Risks and notes
- Resolved: §5.4 no longer names a role change as confirmable; members are `agent: never` (§15.1.5).
- The mock's "Merges as <name>" line (`cards/Confirm.tsx`) has no §14.3 Confirm field. The View omits it unless T-APP-19's `ConfirmCard` adds one.
- Risk: the tool contract leaks card payloads to the agent. Confirmed if the agent transcript of the e2e contains the head sha or check details, which is more than §5.4 allows.
