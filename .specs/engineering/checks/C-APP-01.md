# C-APP-01 Take over a removed member's TODO from the TODO card

Proves: mvp.md §6.15 Members and maintainers, Appendix B.4 `todo.takeover` · spec.md §5.2, §5.6, §15.1.5 · Layer: e2e · Stage: S1 · Tickets: T-ACC-06, T-APP-02
Automation: `apps/app/e2e/real/todo-takeover.spec.ts` (new) · Runs in: reference host

## Setup
- Install at the commit under test; scratch repository `smithers-mvp-canary/<date>`; members Maya (owner), Ben (maintainer), Alice (member) and Eve (member).
- Eve owns T3 (Queued) and T4 (Working, attempt 1).
- Browsers signed in as Maya, Ben and Alice.

## Steps
1. Maya removes Eve on the Members card.
2. Ben opens `/todo T3`. Alice opens `/todo T3`.
3. Alice prompts the app agent "take over T3", then sends `POST /api/todos/3 {takeover}` from her own session.
4. Ben presses **Take over** on T3.
5. Ben opens `/todo T4` and presses **Take over**.
6. T4's run asks a question.

## Pass when
- After step 1, every browser shows Eve as T3's and T4's removed owner, and T3 keeps its history and revisions.
- Step 2: Ben's T3 card offers Take over; Alice's doesn't.
- Step 3: the app agent's tools have no `todo.takeover`, and the turn changes nothing; Alice's request gets 403 class `permission` and changes nothing.
- Step 4: within 1 s, T3's owner is Ben in all three browsers; one `todo_events` row records Ben as the actor; T3 keeps its place and revisions.
- Step 5: T4's run continues on attempt 1 with no restart; its owner is Ben.
- Step 6: the Needs you toast reaches Ben, T4's owner now.

## Fail when
- Take over shows for a member, or on a TODO whose owner is active.
- An agent or a member's session changes an owner.
- A takeover restarts or drops a working TODO's run.

## Evidence
`.artifacts/checks/C-APP-01/<UTC timestamp>/`: the three browsers' videos, the `todo_events` and audit rows for T3 and T4, the app agent's tool list, the commit and install version.
