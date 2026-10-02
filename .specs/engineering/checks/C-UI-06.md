# C-UI-06 Branch conversations are shared, with private view state

Proves: mvp.md M-08, §6.4 Branch conversations, §6.4 No chat between people · spec.md §14.1, §14.5.1, §15.1.1, §15.1.4–15.1.5, §5.4 · Layer: e2e · Stage: S1 · Tickets: T-APP-16, T-UI-07
Automation: `apps/app/e2e/playwright/branch-conversation.spec.ts` (new) · Runs in: CI (real backend) and the reference host

## Setup
An install with members Ben (Maintainer) and Alice (Member), T1 In review on its branch, T2 Working, and two browsers signed in as Ben and Alice. A fake GitHub server records every write. The host logs every credential it mints and every request's credential kind.

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

## Pass when
- After step 3, both browsers show the same entries in the same order, each prompt with its author's avatar, and Alice's turn starts only after Ben's finishes.
- Step 4 doesn't stop Ben's turn.
- After step 5, Alice's view is unchanged and her scroll position is restored after reload. Ben's maximized card is not maximized for Alice.
- Step 6: each turn runs on the host with a host-minted `delegated(via=smithers)` credential for its author (§15.1.4); no response or frame to either browser contains a credential. Ben's request yields a Review & merge Confirm card that only Ben's browser shows (`audience_member_id`, §14.5.1); Alice's browser shows no entry for it. No merge request reaches GitHub. Alice's prompt merges nothing: approving any confirmation it created, from her session, is refused with the `permission` class (§5.2).
- Step 7: T2 pauses at once, with no Confirm card.
- Step 8: T2 stays paused and a one-click Confirm card appears for Ben only (§15.1.5). T2 is dropped only after Ben presses it.
- Step 9 changes only Ben's screen.
- Step 10: the turn completes while Ben's tab is closed. Its answer appears live for Alice and is in Ben's conversation when he returns, with no second run of the turn.
- No entry anywhere is a message from one person to another.

## Fail when
- Entries differ between the two browsers, or order differs.
- Any view state or private entry leaks across members.
- A turn runs with someone other than its author's rights, a browser receives a delegated credential, or an `agent: confirm` command runs before its author confirms.
- Closing the tab cancels, fails or duplicates the turn.

## Evidence
`.artifacts/checks/C-UI-06/<ts>/`: both browsers' videos, the entry list JSON from each, the host's credential and request log for steps 6 to 8 and 10, both browsers' socket frame logs, the GitHub fake's write log (empty for merges), the commit and install version.
