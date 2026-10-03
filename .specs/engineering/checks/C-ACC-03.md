# C-ACC-03 Losing GitHub write suspends within 1 h; removal revokes everything within 5 s

Proves: mvp.md §3 "Member", §6.15 "Members and maintainers", M-05 · spec.md §5.1.3, §5.6, §12.2 (members' permission stream), §15.1.4 · Layer: integration · Stage: S1 · Tickets: T-ACC-02
Automation: `packages/backend/internal/compose/member_revocation_integration_test.go` (new) · Runs in: CI

## Setup
- Mint multiple run credentials with sponsoring member A, including own/other subjects and a token minted before its TODO was transferred to O. Mint an independently workspace-scoped machine credential. Record token identities and sponsor bindings.
- The backend at the commit under test in install mode, with real PostgreSQL. The recheck job runs on an injected clock.
- A fake GitHub whose permission answer per login can be changed during the test.
- Members: O (owner), A (member, GitHub `write`) and E (member).
- A holds:
  - a session cookie;
  - two delegated tokens (one `via=cli`, one per-session `via=smithers` bearer);
  - an open terminal WebSocket on a workspace;
  - an SSE ticket stream;
  - a workspace SSH session through `packages/backend/internal/ssh` (harness of `ssh/workspace_session_test.go`); SSH gateway sessions on `:2222` join this check when T-TRM-03 lands (S2);
  - an `/api/live` socket.
- A owns T3, which has 5 `item_events` rows.

T-APP-23 reruns revocation with real queued/running host turns; T-TRM-07 reruns it through kill_sessions and waits for populated 0; T-MCH-15 proves store deletion and awake-machine file removal, plus deletion before first session after wake. These downstream cases stay pending until consumers land; socket closure alone does not prove them. Preserve all approved member-bound run-sponsor revocation cases.

## Steps
- Adopted T-ACC-06 boundary cases: Drop NOTIFY delivery to a separate consumer, then remove/suspend through production routes/jobs. Measure state-commit-to-stream-close and guest-parent/child termination at no more than 5 s. Inject event insert/NOTIFY failure before commit and assert member state, credential changes and events roll back with no fanout. Crash after commit and verify durable catch-up closes every transport and guest process

10. Suspend/remove A while persistent token cleanup is blocked: immediately call each run credential, then unblock cleanup and measure physical revocation from state commit. Restore A, take over a TODO and resume with a freshly minted O-sponsored run token. Force both serialized write/revocation orders with barriers.
1. **Removal.** O calls `DELETE /api/members/A` and records the response time `t0`, then:
   - polls each of A's streams for close;
   - sends one request on A's old cookie and one on each delegated token right after `t0`.
2. Repeat step 1 twenty times with a fresh A each time. Record `max(close_time − t0)` per stream kind.
3. **Suspension.** Restore A, then switch the fake GitHub's answer for A to `read`. Advance the clock 61 minutes and let the job tick.
4. Repeat step 3, but return 403 on a call made with A's user token instead of advancing the clock.
5. Switch A back to `write` and advance one tick.
6. O takes over T3. Then E (another Member) attempts a takeover.
7. Exercise permission lookups returning installation 401/403/404, expired installation token and an App that lost repository access. Assert GitHub sync health `refused` (§12.2) and byte-for-byte unchanged member access fields. Disambiguate permission 404 with `GET /users/{login}` fixtures for an existing user, unknown user and unresolved installation failure. Confirmed member `none`/`read` suspends; an installation failure never does.
8. Trigger user-token 401/403 through `RefreshUserGitHubToken` callers in `github_user_repos.go`, `github_import.go` and `auth.go`, and through refreshing/non-refreshing proxy paths. Assert one shared reactive recheck without waiting for the hour.

9. Through the real S1 microVM terminal path, start a member command with a lingering guest child, remove the member through DELETE /api/members/{id}, and prove no matching session process remains within 5 s of revocation commit. Record commit-to-close and response-to-close timings. Use POST /api/todos/{n}/takeover, including a delegated attempt returning 403 never without ownership change. Expected responses, events and the 5 s limit are committed literals; no runtime spec or implementation oracle.
- Send takeover through `POST /api/todos/{n} {takeover}` with maintainer session, delegated credentials and Member session.

## Pass when
- Use NewTransactionalDBPublisher with queries bound to the member-revocation transaction. Commit member state, credential revocations and durable revocation events before the response. Rollback publishes no event; local fanout consumes only committed events. Set catch-up polling to at most 1 s and reserve the remaining budget for consumer work and guest child termination so commit-to-termination is at most 5 s, including lost NOTIFY

- Step 10 subsequent run calls return 401 permission/unauthenticated immediately; every A-bound token, including pre-transfer tokens, is physically revoked within 5 s of state commit. Old tokens remain dead after restoration/takeover; resumed work uses a new O-sponsored identity and retained history. A machine token never continues the revoked member run. State-transition-first prevents writes with 401/no effect; write-first may stand under §5.2.1.
- In step 1, every non-public request on A's old session, delegated and member-bound run credentials returns HTTP 401 permission/unauthenticated immediately after the committed state change, including the request right after t0.
- In step 2, the maximum close time for each stream kind is ≤ 5.0 s over all 20 runs (monotonic clock, measured in the test process).
- Step 3 sets `suspended_at` at the first tick after the flip, so detection takes ≤ 60 min plus one tick, and step 1's revocations happen within 5 s of it.
- Step 4 suspends A without waiting for the hour.
- After step 5, A's suspension is cleared. A's next sign-in succeeds, but no old session or token works again.
- In step 6, T3 keeps its 5 events plus one `owner_changed` event with O as actor. E gets 403.
- Maintainer takeover succeeds once; delegated=403 never/never and Member=403 permission/permission; refused requests change no owner or event. The `/takeover` route is absent.

## Fail when
- An SSH or terminal session stays open after removal, because the bus event reached the DB but not the registry.
- A delegated token still works because only sessions were deleted.
- Suspension waits for the member's next sign-in instead of the hourly check.
- Unsuspension resurrects old sessions.
- Removal deletes the member's TODO history.

## Evidence
Written to `.artifacts/checks/C-ACC-03/<UTC timestamp>/`:
- `close-times.csv`: run, stream kind and seconds;
- `requests.jsonl`;
- the revocation bus metrics snapshot (`revocation/bus_metrics.go`);
- the `collaborators` rows before and after;
- `go test -json` output;
- the commit SHA.
