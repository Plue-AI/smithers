# T-APP-04 Confirm card: one-click confirmations and Review & merge

Stage S1 · Size S · Depends on T-ACC-05, T-STK-04 · Unblocks — · Issue: to file
Spec: spec.md §5.2, §5.4, §6.1.2 (`agent`), §6.4, §7.2 (`confirmations`), §10.6.1–10.6.2, §14.3 (Confirm), §14.5.1, §15.1.3–15.1.5, §19.3 · Delta: delta.md §2 (Add `person_confirmations`, the Confirm card), §6 (Delete `change.land` as a TODO merge path) · Product: mvp.md §2 rule 6, §6.10, §6.13, M-05, M-21, Appendix A `/merge` and closing paragraph, Appendix B legend (A✓)

## Goal
One Confirm card renders both kinds of `person_confirmations` (§15.1.5). `one_click`: when any agent (the app agent, Claude Code, the CLI) asks for an `agent: confirm` command, the person it acts for presses once before it runs. `review_merge`: when any agent asks to merge, the person sees their own **Review & merge** card bound to the PR head they review. Only that person's browser session can press either, and the agent learns only the confirmation's id and state.

## Scope
In:
- `confirm` card on the person's pending `person_confirmations` rows from their own `confirmations:<member>` topic (§7.2.2), with the §14.3 fields: kind, action, a one-line summary, subject and its revision, place in the stack, checks line, Cancel (deny) and the confirm button.
- Kind `one_click`: a command whose catalog row says `agent: confirm` (§6.1.2, §15.1.5): commit or drop a TODO, add a scratch branch to the stack, delete a wiki page, propose a flow or agent edit. The card names the command and its arguments; **Confirm** runs it from the person's session. Commands with `agent: run` (reads, steer, answer, stop, resume, retry, rebase, fork, run a flow, wiki writes) never produce a card, and `agent: never` commands are refused, never confirmed.
- Kind `review_merge`: "Merge PR #pr into main", the subject revision, place, checks line and **on GitHub ↗**. Merge stays disabled with "Checks running" until every check passed on the subject revision, and only a maintainer or the owner may press it (§10.6.2).
- The entry is private to its member (`audience_member_id`, §14.5.1): it publishes on the member's own topics, so other members of the branch conversation see nothing in its place.
- App-agent requests come from the host turn runner (§15.1.4) with a host-minted `delegated(via=smithers)` credential for the prompt's author; the browser holds no bearer. `/merge Tn` from any delegated actor creates a `review_merge` confirmation (T-ACC-05 route), and the tool result carries only `{id, state}` (§5.4).
- Confirm and Merge run `POST /api/confirmations/{id}/approve` with the session cookie; Cancel runs `deny`. The toast stays running until the subject's topic reports the command's terminal event, for example `todo:<n>` reporting `merged` or the merge refusal (§19.3).
- Terminal states (approved, denied, expired) render as a one-line receipt. A confirmation expires after 24 h or when its subject's revision changes (§5.4); a new request creates a new one.

Out:
- The merge guard, squash call and order rule (T-STK-04); confirmation storage, kinds and session-only approval (T-ACC-05); the `agent` column of each catalog row (T-CAT-01); the host turn runner (T-APP-16).
- The person's own Merge on the TODO card (T-APP-02), which needs no confirmation because the session acts.
- Confirmations for role changes: roles are `agent: never` (§15.1.5), so no agent can request one.

## Changes
- `apps/app/src/mainview/cards/ConfirmCard.tsx` (new) and test; spread into `cards/CardRenderers.tsx`.
- `packages/rpc/src/Cards.ts`: kind `confirm {confirmation_id}`. `packages/rpc/src/Confirmation.ts` (new): the row model with `kind: one_click | review_merge`.
- `apps/app/src/mainview/flows/entries/history.ts`: replace `history.land` (`:120`) with `/merge Tn`. Delete `landStackItem` (`state/seams/StackSeam.ts:75`) and, with T-APP-01 and T-APP-02 landed, the rest of `StackSeam.ts`.
- `apps/app/src/mainview/flows/entries/change.ts` and `prs.ts`: remove `change.land` and `prs.land` as member doors (Appendix A maps both to `/merge`).
- `flows/agent-parity.test.ts`: Merge's approve and the confirm button stay user-only with a `userOnlyReason` (AGENTS.md three-door law).
- `apps/app/e2e/playwright/landing-history.spec.ts`: replace the land flow with the confirmation flow.

## Tests
- Unit (`ConfirmCard.test.tsx`): both kinds in pending, ready, approved, denied, expired by time and expired by a moved head; `review_merge` with checks running; a member who may not merge sees the card without an enabled Merge.
- Unit: the card renders for its member only; another member's `conversation:<branch>` stream never carries the row.
- Integration (`apps/app/src/mainview/state/seams/ConfirmationSeam.test.ts`, new, real backend with PostgreSQL): the app agent's `/merge T1` and `/todo.drop T2` each create exactly one confirmation per idempotency key with the right kind, and neither runs before approval; its `/todo.stop T2` runs at once with no confirmation; approving with any non-session credential returns 403 and leaves the row pending.
- e2e (`apps/app/e2e/real/confirm-merge.spec.ts`, new): "merge T1" through ⌘K renders the Review & merge card; Merge by the person merges at the subject sha; the transcript shows "Ben via Smithers" opening it and Ben merging. "drop T2" renders a one-click card, and T2 is dropped only after Ben confirms. Ben closes the tab while the agent's turn runs, and the card is there when he returns.

## Acceptance
- [C-ACC-02](../checks/C-ACC-02.md): delegated, run and machine credentials can't merge or approve; the confirmation this card shows can be approved only from a session.

## Risks and notes
- Spec gap: §5.4 still names "change a role" as confirmable, while §15.1.5 makes members `agent: never`. This ticket follows §15.1.5 (owner: tech lead).
- Spec gap: §14.3 Confirm has no "Merges as <name>" line, which the mock shows (`cards/Confirm.tsx`). The card omits it until the tech lead adds it.
- Risk: the tool contract leaks card payloads to the agent. Confirmed if the agent transcript of the e2e contains the head sha or check details, which is more than §5.4 allows.
