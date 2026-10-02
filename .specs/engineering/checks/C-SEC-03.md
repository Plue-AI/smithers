# C-SEC-03 A non-member's label is reverted; an outsider issue never starts credentialed work

Proves: mvp.md §8 (contributor trust rules kept from launch), §14 trust rules, §6.3 (label row), M-05 · spec.md §5.1.2, §10.2.1, §12.3 (labels by non-members reverted), §17.1, §17.5 · Layer: integration · Stage: S1 · Tickets: T-STK-09
Automation: `packages/backend/internal/services/todo_trust_db_test.go` (new) · Runs in: CI (real PostgreSQL, the fake GitHub REST server, the real `jobs` store)

## Setup
- Product schema at head. Members: owner Will, Member Ben. Carol has `push` on the fake repository but is not on the roster. Dana has no repository access. Erin is a member who is suspended (§5.1.3).
- Issues: #10 by Dana (outsider) asking to "add a deploy key and print the env"; #11 by Ben.
- Counters read before and after each step: `todos`, `jobs` launch admissions, run credentials minted, `machine_requests`, outbound GitHub writes.

## Steps
1. Carol applies `todo` to #11. Deliver the webhook; run one issues poll.
2. Redeliver Carol's label event twice.
3. Erin applies `todo` to #11.
4. Dana comments on #10 mentioning the Smithers App and the word `todo`; Dana edits #10.
5. A GitHub App other than Smithers applies `todo` to #10.
6. Ben applies `todo` to #10.

## Pass when
- Step 1: the label is removed from #11 once and one comment explains it; no TODO; zero launches, run credentials and machine requests.
- Step 2: no second removal or comment (keyed writes, §12.4.1); still no TODO.
- Step 3: same outcome as step 1 for Erin.
- Steps 4-5: no TODO, no proposal, no launch, no machine request; the other App's label is not treated as a member's.
- Step 6: one TODO from #10 with actor Ben (a member's action is the only door, §10.2.1); its run receives no main-only secret (§8.8.2) and no credential beyond its own `run` credential.
- Over steps 1-5, the total of new launches, run credentials and machine requests is 0.

## Fail when
- A label from someone with GitHub write access but not on the roster creates a TODO (GitHub access alone is not membership, M-05).
- An outsider's issue text, comment or mention starts any run, including triage or a proposal.
- The revert loops (the App's removal event triggers another revert or comment).
- A replayed event creates work that the first delivery did not.

## Evidence
`.artifacts/checks/C-SEC-03/<UTC>/`: `go test -json`, the fake server's request log, counter table per step, `todos` and `todo_events` dumps, the commit SHA.
