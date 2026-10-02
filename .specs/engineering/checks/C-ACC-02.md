# C-ACC-02 Only a person's session merges or approves; confirmations are session-only and revision-bound

Proves: mvp.md §2 rule 6, §6.10 "Agents can't merge", §6.13 "CLI", M-05, M-21, Appendix B legend (A✓) · spec.md §5.3, §5.4, §10.6.2, §15.1.4, §15.1.5 · Layer: integration · Stage: S1 · Tickets: T-ACC-04, T-ACC-05, T-STK-04
Automation: `packages/backend/internal/compose/confirmations_integration_test.go` (new) · Runs in: CI

## Setup
- The backend at the commit under test in install mode, with real PostgreSQL (`testkit/postgresfixture`).
- A fake GitHub that records every merge call. T1's PR has head `h1`, required checks pass, and it is mergeable.
- Members: O (owner) and E (member).
- Credentials, each minted through the real path:
  - O's session cookie and E's session cookie;
  - O's delegated token (`via=claude-code`), E's delegated token, and O's per-session `delegated(via=smithers)` bearer (T-ACC-04);
  - the run token of T1's `todo` run;
  - the machine token of T1's branch.
- T1 is `in_review` and first in stack order.

## Steps
1. With each of these, call `POST /api/todos/1/merge {reviewed_head_sha: h1}`: O-delegated, O-smithers-delegated, run and machine.
2. With each of these, call the approval route for T1 at `h1`: O-delegated, run and machine.
3. With O-delegated, create a merge confirmation for T1 at `h1`. Record the full response body.
4. Try to approve that confirmation with, in turn: O-delegated, run, machine, E's session, then O's session.
5. Create a second confirmation with O-delegated. Move the fake PR head to `h2`, then approve with O's session.
6. Create a third with O-delegated and deny it with O's session, then approve it with O's session.
7. With E-delegated, create a merge confirmation for T1.
8. Call `GET /api/confirmations` with O-delegated and with O's session.
9. With O's `via=smithers` bearer, dispatch `/todo.new` (A✓). Press the resulting confirmation with E's session, then with O's session.

## Pass when
- Steps 1 and 2 return 403 `class: "permission"` for every credential, and the fake GitHub records 0 merge calls.
- In step 3, the response body has exactly the keys `id` and `state`, and `state = "pending"`.
- In step 4, every credential except O's session gets 403. O's session yields exactly 1 merge call, with `sha = h1` and `merge_method = squash`, and the row becomes `approved`.
- Step 5 returns 409 `class: "conflict"`, the row becomes `expired`, and no new merge call is made.
- In step 6, deny gives `denied`, the later approve returns 409, and no merge call is made.
- Step 7 is refused at create with 403, because a Member's role can't merge.
- In step 8, the delegated response holds only `{id, state}` per row, and the session response holds full rows.
- In step 9, the dispatch returns `202 {state: "requested"}` with a `one_click` row and no TODO. E's press gets 403; O's press creates exactly one TODO attributed to O.
- Over the whole run, the fake GitHub records exactly 1 merge call.

## Fail when
- The app agent's bearer (`via=smithers`) or a CLI token merges directly, or an A✓ command runs before its author presses it.
- A session cookie sent together with a delegated bearer is treated as a session.
- Approve succeeds after the PR head moved.
- Another member's session approves someone else's confirmation.
- An agent response leaks the subject, the checks line or the approver.
- A retried approve causes a second merge.

## Evidence
Written to `.artifacts/checks/C-ACC-02/<UTC timestamp>/`:
- `requests.jsonl`: credential kind, route, status, body keys and request id for each request;
- `github-calls.jsonl`;
- the final `person_confirmations` rows;
- `go test -json` output;
- the commit SHA.
