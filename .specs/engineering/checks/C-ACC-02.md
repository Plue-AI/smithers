# C-ACC-02 Only a person's session merges or approves; confirmations are session-only and revision-bound

Proves: mvp.md §2 rule 6, §6.10 "Agents can't merge", §6.13 "CLI", M-05, M-21, Appendix B legend (A✓) · spec.md §5.3, §5.4, §10.6.2, §10.6.2a, §10.6.2c, §15.1.4, §15.1.5 · Layer: integration · Stage: S1 · Tickets: T-ACC-04, T-APP-04, T-STK-04
Automation: `packages/backend/internal/compose/confirmations_integration_test.go` (new) · Runs in: CI

M-39 (Will, 2026-10-02): a maintainer's pre-approval of a TODO is itself a person-session approval. It isn't revision-bound, and the merge it authorizes runs only through T-STK-16's MergeReady evaluator (C-STK-13). No agent, delegated, run or machine credential can grant or remove it. Nothing in this check is weakened: Review & merge stays revision-bound.

## Setup
- Additional cases below use isolated fresh fixtures so the original ten-step run still records exactly one merge. Add maintainer credentials, terminal_s1/S2 profiles, live/dead setup, dead member/run sponsors and role-change barriers. Explicit-create payloads identify command, subject and validated command payload; expected outcomes are committed literal fixtures, not descriptor-derived.
- The backend at the commit under test in install mode, with real PostgreSQL (`testkit/postgresfixture`).
- A fake GitHub that records every merge call. T1's PR has head `h1`, required checks pass, and it is mergeable.
- Members: O (owner) and E (member).
- Credentials, each minted through the real path:
  - O's session cookie and E's session cookie;
  - O's delegated token (`via=claude-code`), E's delegated token, and O's per-session `delegated(via=smithers)` bearer (T-ACC-04);
  - the run token of T1's `todo` run;
  - the machine token of T1's branch.
- T1 is `in_review` and first in stack order.

T-ACC-04 proves real OAuth/token minting and the missing-consumer guard. T-ACC-05 proves production one-click dispatch, persisted confirmations and private live subscriptions; an unavailable action handler returns HTTP 503, class infra, code confirmation_unavailable, before approval or effects. T-STK-04 installs the real merge handler and owns complete merge/GitHub/fault cases; keep those pending until it lands. T-APP-23 proves real turn-runner lifetime revocation. No service fake discharges these boundaries. Use committed literal request/result fixtures; no runtime spec, catalog or production-policy oracle. An S1 terminal profile permits append-only todo.new without confirmation and refuses Merge/explicit confirmation creation with 403 permission; S2 follows catalog policy. Include current-role, sponsor/member revocation and credential-scoped idempotency fixtures from the approved rulings.
- Drive the real approval route and production merge consumer with PostgreSQL and fake GitHub. Include a crash between approval and the external call and T-GH-09 reconciliation; a test-only merge handler does not pass.

## Steps
- Adopted T-ACC-05 boundary cases: Use production create/approve routes and real merge-consumer wiring with fixed GitHub outcomes. Change generation while the displayed head stays unchanged and assert stale refusal, zero merge sends and no approved row. Assert MergeReady and each definitive GitHub refusal leave pending; only independently confirmed merge marks approved. Retain these assertions in downstream T-STK-04 integration

11. In isolated fixtures, call explicit create as session O/M/E, delegated O/M/E, run, machine and setup. Target member-level todo.new, maintainer-only Merge, person-only never and ordinary run-policy commands; include insufficient scope and terminal_s1. List own/other rows and decide as each kind.
12. Retry same credential/key/canonical create, then change command/subject/payload. Reuse keys across session/delegated, replacement and run/machine bindings. Downgrade role or kill credentials before replay, expire/resolve a confirmation, and retry approval with same and distinct session credentials.
13. Count one decision at create, each press and replay before row/effect/result disclosure. Remove the consumer and call delegated confirm dispatch. Race ordinary downgrade and serialized member revocation with writes; downgrade Merge approving-member authority before send.
1. With each of these, call `POST /api/todos/1/merge {reviewed_head_sha: h1}`: O-delegated, O-smithers-delegated, run and machine.
2. With each of these, call the approval route for T1 at `h1`: O-delegated, run and machine.
3. With O-delegated, create a merge confirmation for T1 at `h1`. Record the full response body.
4. Try to approve that confirmation with, in turn: O-delegated, run, machine, E's session, then O's session.
5. Create a second confirmation with O-delegated. Move the fake PR head to `h2`, then approve with O's session.
6. Create a third with O-delegated and deny it with O's session, then approve it with O's session.
7. With E-delegated, create a merge confirmation for T1.
8. Call `GET /api/confirmations` with O-delegated and with O's session.
9. With O's `via=smithers` bearer, dispatch `/todo.new` (A✓). Press the resulting confirmation with E's session, then with O's session.
10. Restore T1 to `in_review` at generation g with head `h1`. Create a merge confirmation with O-delegated. Steer T1 with E's session, so T1 turns `working` while its PR head stays `h1`. Approve with O's session. Then let T1's run propose generation g+1 with head `h3`, and approve again with O's session.
- Compare the production confirmation-create response, GET list, delegated read and live projection with the persisted row.

## Pass when
- Store review_merge bindings as (generation, reviewed_pr_head_sha). Approval rereads both under the subject transaction and expires/refuses a stale binding before effects. Pass both to the merge consumer. MergeReady and definitive GitHub refusals leave the confirmation pending; only a confirmed merge settles approved. Missing handlers leave it unapproved

- Explicit-create literals: live session O/M/E and run/machine/setup=403 permission/permission; eligible full-scope delegated O/M/E todo.new=202 without TODO; Merge delegated O/M=202 and E=permission; never target=403 never/never after role/scope; run target=permission; terminal_s1 explicit create=permission. Dead callers retain 401 permission/unauthenticated or setup_closed.
- List is own-only session full rows or delegated id/state; run/machine refuses permission. Approve/deny requires the confirmation requester session, current bound-command role and exact revision; all non-session and other-member callers=403 permission/permission. Stored wait kinds cannot turn approval into answer.
- No consumer=503 infra/confirmation_unavailable, zero row/handler effects. Each resolved create, press and replay obtains one fresh bound-action decision; there is no generic-create decision followed by a second command decision.
- Same immutable credential/key/canonical request reuses permitted result without duplicate row/effect. Mismatch within scope=409 conflict/idempotency_mismatch. Other credential identities/bindings have distinct scopes and no result leakage. Downgraded/dead callers get current refusal before recorded response; expired/resolved confirmation replay reports actual state, never fabricated pending. Terminal confirmation state and durable operation deduplication prevent duplicate merge even across distinct approval scopes.
- Ordinary role downgrade after allow may commit; later requests use new role. Member revocation committed before serialized write=401/no effect. Merge checks current approving-member role/state/confirmation ownership before send under STK-04 S20; downgrade/suspension/removal produces no outbound merge. All isolated cases report effect totals separately from steps 1–10.
- Step 1: eligible delegated merge requests return 202 with a confirmation id and `state: "pending"`; run and machine return 403 `permission`. Step 2: eligible delegated approval returns 403 `never`; run and machine return 403 `permission`. No request in these steps merges. Cancel the step 1 confirmations before step 3.
- In step 3, dispatch returns 202 with exactly `confirmation` and `state`, and `state = "pending"`; the stored row is `pending`.
- In step 4, every credential except O's session gets 403. O's session yields exactly 1 merge call, with `sha = h1` and `merge_method = squash`, and the row becomes `approved`.
- Step 5 returns 409 `class: "conflict"`, the row becomes `expired`, and no new merge call is made.
- In step 6, deny gives `denied`, the later approve returns 409, and no merge call is made.
- Step 7 is refused at create with 403, because a Member's role can't merge.
- In step 8, the delegated response holds only `{id, state}` per row, and the session response holds full rows.
- In step 9, dispatch returns `202 {confirmation: id, state: "pending"}` with a `one_click` row and no TODO. E’s press gets 403 `permission`; O’s press creates exactly one TODO attributed to O.
- In step 10, the first approve returns 409 `class: "conflict"` with reason `state`, makes no merge call and leaves the row `pending`; after g+1 is accepted the row is `expired`, and the second approve returns 409.
- Over the whole run, the fake GitHub records exactly 1 merge call.
- All initial confirmation states equal the literal `pending`; no response reports `requested`.

## Fail when
- The app agent's bearer (`via=smithers`) or a CLI token merges directly, or an A✓ command runs before its author presses it.
- A session cookie sent together with a delegated bearer is treated as a session.
- Approve succeeds after the PR head moved.
- Another member's session approves someone else's confirmation.
- An agent response leaks the subject, its checks or the approver.
- A retried approve causes a second merge.

## Evidence
- isolated-cases.jsonl records literal create/list/decision/replay results, credential-scope identity, current confirmation state, Authorize counts, write ordering and effects; merge calls remain exactly once per admitted operation.
Written to `.artifacts/checks/C-ACC-02/<UTC timestamp>/`:
- `requests.jsonl`: credential kind, route, status, body keys and request id for each request;
- `github-calls.jsonl`;
- the final `approvals` rows;
- `go test -json` output;
- the commit SHA.
