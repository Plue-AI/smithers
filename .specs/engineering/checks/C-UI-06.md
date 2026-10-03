# C-UI-06 Branch conversations are shared, with private view state

Proves: mvp.md M-08, §6.4 Branch conversations, §6.4 No chat between people · spec.md §14.1, §14.5.1, §15.1.1, §15.1.2a, §15.1.4–15.1.5, §5.4, §5.6 · Layer: e2e · Stage: S1 · Tickets: T-APP-16, T-APP-23
Automation: `apps/app/e2e/playwright/branch-conversation.spec.ts` (new) · Runs in: CI (real backend) and the reference host

## Setup
An install with members Ben (Maintainer) and Alice (Member), T1 In review on its branch, T2 Working, and two browsers signed in as Ben and Alice. A fake GitHub server records every write. The host logs every credential it mints and every request's credential kind. For steps 11–12 the fast model is a recording fake that captures each request and answers the prompt `SLOW` by calling one read command per second for 60 s.

- Policy outcomes, actor labels, HTTP envelopes and private canaries are checked-in literals. Exercise the actual queue, command→API mapping and authorizer; no oracle reads spec files or computes expected policy from the runtime catalog.

## Steps
1. Both open `main`'s conversation. Each sees the Home card first.
2. Ben opens T1's branch conversation from the branch tree. Alice does the same.
3. Ben prompts "summarize T1". Alice prompts "list changed files" while Ben's turn runs.
4. Alice runs `/stop` during Ben's turn.
5. Ben maximizes the TODO card and scrolls to the top. Alice reloads.
6. Ben prompts "merge T1". Alice prompts "merge T1".
7. Ben prompts "stop T2" (`agent: run`).
8. Ben prompts "drop T2" (`agent: confirm`, mvp.md Appendix B.2).
9. Ben's app agent runs a UI-only flow (switch to dark theme).
10. Ben prompts "summarize T1's PR checks" and closes his tab while the turn runs. Alice keeps watching. Ben reopens the app 30 s later.
11. Alice opens `/todo.new` and types the title and prompt "canary-7Q4" in the Draft card without committing. Ben's Confirm card from step 6 is still pending. Ben prompts "list every entry in this conversation and what each draft says".
12. Alice prompts `SLOW`, then queues "summarize T1" behind it, and Ben queues "list changed files" behind hers. While `SLOW` runs, Ben removes Alice on the Members card.
For step 13, restore Alice as an active Member through the production Members command and sign her in with a fresh session, or run step 13 with a fresh isolated fixture. Her cross-author prompt edit must test active-member authorization (403 permission), not the revoked-session authentication refusal from step 12.

13. Ben prompts "summarize T1" and, while it runs, queues "list changed files", then edits the queued prompt to "list changed tests" before it starts. While it is queued, Alice sends `PATCH /api/conversations/{b}/turns/{id}` for it from her session.

## Pass when
- After step 3, both browsers show the same entries in the same order, each prompt with its author's avatar, and Alice's turn starts only after Ben's finishes.
- Step 4 doesn't stop Ben's turn.
- After step 5, Alice's view is unchanged and her scroll position is restored after reload. Ben's maximized card is not maximized for Alice.
- Step 6: each turn runs on the host with a host-minted `delegated(via=smithers)` credential for its author (§15.1.4); no response or frame to either browser contains a credential. Ben's request yields a Review & merge Confirm card that only Ben's browser shows (`audience_member_id`, §14.5.1); Alice's browser shows no entry for it. No merge request reaches GitHub. Alice's delegated merge request returns HTTP 403, class and code `permission`, because she is a member; it creates no confirmation or merge side effect (§5.2.1).
- Step 7: T2 pauses at once, with no Confirm card.
- Step 8: T2 stays paused and a one-click Confirm card appears for Ben only (§15.1.5). T2 is dropped only after Ben presses it.
- Step 9 changes only Ben's screen.
- Step 10: the turn completes while Ben's tab is closed. Its answer appears live for Alice and is in Ben's conversation when he returns, with no second run of the turn.
- No entry anywhere is a message from one person to another.
- Step 11: neither recorded model request of Ben's turn (preflight and answer) contains "canary-7Q4" or any private entry's id or fields, his own pending Confirm card's included (§15.1.2a). The turn credential's conversation reads return no private entry. Ben's answer, its stored `context[]`, its summary and its Inspect trace contain none of them, and the Inspect payload is byte-identical in Ben's and Alice's browsers.
- Step 12: within 5 s of the removal commit, Alice's `SLOW` turn ends `cancelled` with reason `author_revoked` and her queued turn ends `cancelled` without starting (`agent_turns`). The request log shows no successful command call with her turn credential after the removal commit, and no entry written by her turns after it. Ben's queued turn then starts and answers.
- Step 13: Ben's turn runs "list changed tests". Alice's browser shows the prompt only once the turn starts, as "list changed tests", and her `PATCH` got 403 `permission`.

## Fail when
- Entries differ between the two browsers, or order differs.
- Any view state or private entry leaks across members.
- A turn runs with someone other than its author's rights, a browser receives a delegated credential, or an `agent: confirm` command runs before its author confirms.
- Closing the tab cancels, fails or duplicates the turn.
- Any private entry, its text or its id reaches a turn's model request, stored context, summary or Inspect, including the author's own.
- A removed member's turn runs a command after the removal, or a queued one starts.

## Evidence
`.artifacts/checks/C-UI-06/<ts>/`: both browsers' videos, the entry list JSON from each, the host's credential and request log for steps 6 to 8 and 10 to 12, the recorded model requests and `agent_turns` rows for steps 11–12, both browsers' socket frame logs, the GitHub fake's write log (empty for merges), the commit and install version.
