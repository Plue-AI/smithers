# C-ACC-01 Every permission-matrix cell is enforced server-side for every credential kind

Proves: mvp.md §6.15 "Roles", M-05, §2 rule 6, Appendix B.5 · spec.md §5.2, §5.2.1, §5.3, §5.4, §6.2.3, §15.1.4, §17.2 · Layer: integration · Stage: S1 · Tickets: T-ACC-02, T-ACC-03, T-ACC-04, T-APP-04, T-INS-08, T-TRM-02, T-CUT-03, T-STK-06
Automation: `packages/backend/internal/compose/access_matrix_integration_test.go` (new) · Runs in: CI

## Setup
- Commit literal approved outcome fixtures separately from descriptors and authorizer code. Freeze the 58-cell ledger from T-ACC-03 Tests: SG-01=1, SG-04=10, SG-06=19, SG-07=8, SG-08=14, SG-09=6. Fifty-two cells have authorization results; six trigger cells are retired as not served (404). The oracle does not parse Markdown or generate expectations from catalog data at runtime.
- Mint setup pre-claim/expired/claim-invalidated credentials, provisional owner sessions, full-scope app_agent/external_agent delegated tokens and stored terminal_s1 tokens. Create suspended/removed/absent roster holders, member-bound run sponsors, own/other/missing branch/workspace bindings and unknown/legacy kinds. Include open question/conflict/approval waits and owner-record targets. Install isolated fixtures for destructive requests.
- The backend at the commit under test, composed in install mode. Real PostgreSQL through `packages/backend/testkit/postgresfixture`, migrated to head.
- A fake GitHub (`httptest`) that answers `push` for every member login, and records merge calls.
- Members: O (owner), M (maintainer), E (member).
- Credentials, each minted through the real path, never inserted by hand:
  - a session cookie for each of O, M and E;
  - a delegated token (`via=cli`) for each of O, M and E;
  - one run token for the `todo` run of T1 (branch b1);
  - one machine token for branch b1.
- Fixture data: T1 (`needs_you{kind: conflict}`, branch b1, the run token’s own conflict), T2 (`in_review`, PR head `h2`, branch b2, first merge candidate), an unrelated question wait and secret `S`. Merge requests use T2 at `h2`; run conflict answers use T1.

## Steps
- Adopted T-ACC-04 boundary cases: Through production OAuth/token, command and Git HTTP routes with real PostgreSQL, migrate identical pre-existing install and Plue PAT fixtures. Install PATs lose approval authority; Plue fixtures retain their prior outcomes. Send expired, revoked, inactive-member and wrong-branch credentials and assert typed refusals before writes. Exercise turn completion/cancellation, terminal close and suspension/removal, measuring revocation and testing replacement identity isolation

7. Apply the 58-cell literal fixtures in T-ACC-03 Tests exactly, including command/subject/profile fields for confirmation.create. Add non-? typing cases and trusted actor/profile variants without counting them in the 58.
8. Count Authorize invocations at router, dispatcher and all 12 direct service gates. Use barriers between decision and write: downgrade ordinary role; serialize suspension/removal before and after write; change subject fence/revision. Reauthorize a later request and perform a Merge authority downgrade before send.
9. Send protected-bookmark move/delete landings, including main, with each live credential kind and replay with dead/setup/provisional states. Observe repo-host outbound calls and bookmark state separately from receive-pack.
10. Sweep each T-CUT-03 user-trigger method/path, pause requests and absent resume aliases and alias with every credential and no credential. Assert not served, no authorization matrix row, no install OpenAPI route. Exercise retained internal system work with explicit grant and forbidden bindings.
1. Load reviewed literal request/result fixtures as the expected-policy oracle. Load catalog.mvp.json separately as the descriptor input under test and compare coverage. C-CAT-01 validates product parity, including the approved terminal_s1 exception. Never derive expected permission outcomes from descriptors or runtime spec parsing.
2. Exercise every retained catalog command and hidden system descriptor through served routes and dispatch doors across session/delegated/run/machine/setup, profile and state fixtures. Use exact stored subjects and valid payloads, not one representative per broad matrix row. Report unimplemented commands as pending with an owner ticket.
3. For each cell, send the request once with a fresh `Idempotency-Key` and record status, code, class, body keys, confirmation/recorded-result disclosure, fix and effects.
4. For the run column, also send the scoped cases:
   - answer T1’s own conflict versus T2 or an unrelated question wait;
   - a join on b1 vs on another branch b2.
5. Compose the install router and list every served `/api` route with its declared action.
6. Exercise workspace head, workspace children and provider-pool routes with a real workspace-restricted system token on its own workspace and another workspace. Exercise the 12 non-router person gates listed in T-ACC-03. Send distinct body command ids through `/workflows/{name}/dispatch`, including a forbidden id and a route/body mismatch; assert authorization precedes side effects.

## Pass when
- Backfill stored credential kind/profile metadata in both compositions, but change authorization only in the install composition. Update every credential classifier caller, including the Git HTTP proxy, to resolve install authority from immutable stored kind, actor class and scope profile; system_issued, scopes and userType cannot recreate person authority. Preserve Plue PAT outcomes. Set explicit finite expiries: CLI delegated credentials expire after 30 days; turn and terminal credentials expire after 1 hour. Renewal requires a fresh active-member and subject check and creates a new immutable credential identity. Revoke turn credentials on completion or cancellation; revoke terminal credentials within 5 s of close; suspension/removal immediately denies authorization and physically revokes credentials within 5 s. No renewal outlives the owning turn or terminal session

- All 58 formerly unknown cells match the independent approved ledger: 52 typed authorization results and six retired trigger cells (404). The full command matrix and extra fixtures report their separate totals; no unserved/pending case is counted as an authorization pass.
- Every non-public missing/invalid/expired/revoked or inactive/absent member session/delegated/member-bound run credential returns 401 permission/unauthenticated before command-specific refusal. Live setup non-setup=403 permission/permission; claim-invalidated setup=401 permission/setup_closed; other dead setup=401 permission/unauthenticated; provisional owner non-setup=403 permission/owner_unverified. Lookup failure grants nothing.
- Scope/role checks precede delegation: eligible person-only delegation=403 never/never; excluded trusted actor class on multi-actor row=403 permission/permission. Attribution header changes never alter these decisions. S1 person terminal/CLI append executes without confirmation; delegated append creates a private Confirm card with no TODO before app approval, or returns 403 permission/confirm_in_app, "Confirm in the app", without effects if its S1 card path is absent. S2 uses ordinary delegated catalog policy. Check: C-SEC-05.
- Members-card and secret-name reads: active Member session allows, delegated O/M/E=never, run/machine=permission. Install status after claim allows owner sessions only, including provisional owner; delegated owner=never, lower delegated roles=permission. SSH delegated=never and run/machine=permission. Stored secret-value reads return permission for every live otherwise admitted kind, never a value; earlier death/setup/provisional refusals remain.
- Owner demotion/removal or role-to-owner returns 403 permission/owner_immutable only after validity/scope/role/delegation; lower roles=permission, eligible delegation=never, dead holders=401. No member/projection changes. Stored approval waits resolve to approval.approve/deny before one decision; a run conflict grant never approves.
- Exactly one bound Authorize decision precedes every request effect or saved-result disclosure. Ordinary downgrade after allow may commit; next request uses new role. Serialized suspension/removal committed first prevents the write with 401/no effect; write committed first may stand. Subject guards retain typed conflict. Merge additionally refuses approving-member downgrade before send without a second generic Authorize call.
- All protected-bookmark move/delete repo-host landings are refused in install mode; no repo-host protected ref move, landing effect or confirmation occurs. Earlier dead/setup/provisional refusals retain precedence. Only a person-authorized GitHub squash merge moves main (M-22); Plue ACL behavior remains separate.
- Every SG-09 route is unmounted with 404 and absent install route/OpenAPI manifests. No user trigger-management bypass remains through gateway workers. Hidden internal scheduling/event grants stay separate.
- `main.reset-to-github` succeeds only from the Owner's session; maintainer, member and every delegated credential are refused and post no confirmation. GitHub App changes require the Owner's session.
- Every cell follows §5.2.1: insufficient role or credential scope returns 403 `permission`; an eligible delegated `never` returns 403 `never`; eligible `run` executes; eligible `confirm` returns `202 {confirmation: id, state: "requested"}` without executing the command.
  - Explicit cases: `todo.amend` posts a one-click confirmation; `todo.steer`, move, stop, retry, app_agent personal terminal, eligible delegated sleep and wake execute with no row; external_agent personal terminal is refused permission, while source co-edit admits external_agent only. Member-delegated Discard returns 403 `permission` and posts nothing; maintainer-delegated Discard posts a confirmation approved only by that maintainer’s session. Settings, approvals, members and secrets never create confirmations.
- Run allows own conflict answer, own-branch join, source co-edit, fork and flow execution only as explicitly granted. Own personal terminal, SSH, add-to-stack, rebase/rebase-now, sleep/wake and other-branch commands return 403 permission/permission. Child credentials stay newly scoped without person privileges. Bound TODO/files/diffs/run-trace/coding-readable wiki reads allow only execution fields; no global list, agents.read, roster, secret names/values, private entries, confirmations or view state.
- Machine has no person-command write. It admits exact-bound execution reads and separately declared head/events/children/provider-pool/candidate/propose system grants. Missing/cross binding, wrong ancestry or run/generation mismatch returns 403 permission/permission before effects. Omitted credential_policy kinds deny; unknown and legacy sync/platform kinds have no implicit install authority.
- `/workflows/{name}/dispatch` authorizes the body command id and subject. A permitted route name never admits a forbidden body command. Unknown or mismatched bindings refuse before dispatch; all 12 non-router person gates enforce the same catalog policy.
- No refused cell causes a side effect. The fake GitHub has zero merge calls from refused cells, and no row changed in `collaborators`, `secrets` or `mythical_items`.
- No secrets route returns a value field.
- Every served `/api` route has exactly one declared action, so the unmapped list is empty.
- Routes whose ticket has not landed are reported as "pending route" with that ticket ID. They are not counted as passes. Final acceptance requires zero pending rows.

## Fail when
- A delegated token of an owner or maintainer merges, approves or writes members or secrets.
- A Member session merges or writes secrets.
- A cell is allowed because the UI hides the button, and the server never checks.
- A new route ships without an action.
- The run token acts on another TODO's branch.
- A refusal has the wrong status or class, or a confirmable request returns 403 with a confirmation fix instead of 202 with an id.

## Evidence
- ledger.json records the 58 approved cells, 52 resolved and six retired, plus separately counted via/profile/subject/system/temporal cases.
- decisions.jsonl records immutable credential identity, trusted class/profile, bound command/subject, Authorize count, state/write barrier order, status/code/class and database/outbound effects.
- protected-landings.jsonl, retired-trigger-routes.txt and per-composition OpenAPI diffs record zero protected landing effects and SG-09 404 absence.
Written to `.artifacts/checks/C-ACC-01/<UTC timestamp>/`:
- `matrix.json`: expected cell, actual status, class, fix and request id for each cell;
- `unmapped-routes.txt` and the fake GitHub call log;
- `go test -json` output, the commit SHA and `smithers-backend --version`.
