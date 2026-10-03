# T-ACC-03 ahead-of-time test plan: one authorizer over the permission matrix

> Rulings (tech lead, 2026-10-02 17:30): repo-host landing requests are refused for run, delegated, machine and session credentials in install mode, and canLandRepo's run-credential allowance is deleted for install-mode routes; CredentialKind grows delegated (with via), machine and the setup session; the member boundary returns role plus state. SG-01..14 ruled in the tech lead's Codex pass.


Status: written before the lane starts. Oracle and skeletons: `T-ACC-03/authorize_matrix_qa_test.go` (package services; the lane moves it to `access/authorize_test.go` and `compose/access_matrix_integration_test.go`).

Summary: 79 action rows x 18 principals = 1,422 oracle cells (2,370 evaluated with the 5 `via` values), 58 cells the spec does not decide, 207 further delegated cells whose refusal class the spec does not state. 14 spec gaps (section 6). The oracle lints itself today (`go test -run QAOracle` passes).

## Current code (read-only reconnaissance)

- `middleware.CredentialKind` has `person | run | sync | platform` only (`middleware/run_credential.go:14-31`). There is no `delegated`, `machine` or `setup` kind, and `TokenCredentialKind` returns `run` for every system-issued token, so a machine token is indistinguishable from a run token today. The ticket's classification work is therefore a real change, not a rename.
- Authorization is scattered: 64 non-test references to `canLandRepo|canAdminRepo|canOwnRepo|RequirePerson|RefuseRunCredentials|requireAdminAccess`; `RefuseRunCredentials` mounts at `compose/router.go:758,1137,1274,1278,1288,1317,1374`. None knows a role beyond the repo ACL.
- `canLandRepo` lets a run credential land when the user owns the repo ("Landing is how an agent's work reaches a bookmark"). That is the opposite of §5.2 (run cannot merge). C-ACC-01 fail-when "run token merges" is a live risk until `canLandRepo` is gone for the install repo.
- In-flight acc lane (`smithers-mvp-acc`): `identity.MemberBoundary.AuthorizeMember(ctx, userID)` returns only member or not (bool from `AuthorizeMemberUser`); `services/members.go` knows only `memberRoleOwner`. The authorizer needs role, state (active|suspended|removed) and provisional flag. The ticket's Ready item 1 says T-ACC-01 supplies that type. Today it does not; ask the acc lane for `MemberByUserID(ctx, id) (Member{Role, State, Provisional}, error)` before T-ACC-03 starts.
- Router: chi. Existing precedent for route sweeps: `router_test.go:1053` (CSRF middleware found by middleware function name) and `openapi_conformance_test.go` (`servedAPIRoutes`, which unions the self-hosted and multitenant compositions plus routes mounted beside `buildRouter`: `mountBrowserFlow`, `mountChatPublic`, `mountModelPublic`, and `/api/bootstrap` served by `withAppBootstrap` outside chi). The name-matching style is exactly weakness W1: it proves a middleware is mounted, not that the handler path calls Authorize. Section 3 replaces it.

## 1. Requirement trace

Layer: U unit (`access/authorize_test.go`, `access/routes_test.go`), P property, I integration (`compose/access_matrix_integration_test.go`, real PostgreSQL + fake GitHub), S static guard. Test names are in the skeleton file unless marked "(plan)".

| Ticket / check requirement | Spec | Proving test | Layer |
| --- | --- | --- | --- |
| Goal: every served `/api` command goes through `Authorize(credential, command, subject)` | §5.2.1 | `TestAccessSweep_EveryServedRouteDeclaresAnAction`, `TestAccessSweep_RefusedProbeNeverReachesHandler` | U + I |
| Goal: scope/role failure = 403 `permission`; eligible forbidden delegated = 403 `never`; eligible confirmable = 202 + id | §5.2.1, §6.2.3 | `TestAuthorizeMatrix_EveryCell`, `TestAuthorizeCheckOrder_ScopeAndRoleBeforePolicy`; status and class asserted again through the router in I | U + I |
| Authorize reads the per-command descriptor, not coarse `todo.write`/`branch.join` | §6.1.2b | `TestAuthorizeMatrix_EveryCell` rows `todo.amend`, `todo.drop`, `todo.new`, `branch.add-to-stack` (C) vs `todo.steer`, `todo.stop`, `branch.rebase` (Y) for the same credential | U |
| Every served route declares a command id; `public`/`self` cover non-command routes | §5.2.1; ticket Scope | `TestAccessSweep_EveryServedRouteDeclaresAnAction` + `TestAccessSweep_UnmappedRouteFixtureFails` | U |
| Delegated `merge`/`flow.merge`: internal confirm decision only for owner/maintainer with confirm scope; never HTTP 403 with a fix | §5.2 rows 2, 4; §15.1.5 | rows `merge`, `flow.merge` x `delegated:*`; `TestAuthorizeConfirmWithoutConsumerFailsClosed` | U + I |
| Delegated `approve`, `members.write`, `secrets.write`, `install.settings` = `never` for eligible, `permission` for insufficient role/scope, no confirmation row | §5.2 rows 1-3; §15.1.5 | rows `approval.*`, `members.*`, `secrets.*`, `install.settings` x `delegated:*`; `TestAbuse_DelegatedMergeApproveMembersSecretsSettings` (0 `person_confirmations` rows) | U + I |
| TODO and branch commands keep individual ids; C-ACC-01 exercises each command | §5.2 rows 5, 7 | one oracle row per command id (79); `TestAuthorizeMatrix_EveryCell` iterates all rows; I iterates every `catalog.mvp.json` command and fails if a catalog id has no oracle row (plan: `TestOracleCoversCatalog`) | U + I |
| Delegated cells identical for every `via` (smithers, claude-code, codex, cli, terminal) | ticket Tests; §5.3 | `TestAuthorizeDelegatedIdenticalAcrossVia` (see SG-02, SG-03 for the exceptions) | U |
| `machine` has no row, refused everywhere except its own branch's events and reads | §5.2 footnote, §17.2 | columns `MO`/`MX`; `TestAbuse_MachineCredentialHostAPIs` | U + I |
| Credential classification: four kinds + role + provisional owner; unknown kind fails closed | §5.1.0, §5.3 | `TestAuthorizeProvisionalOwnerRefusedEverythingButSetup`, `TestAuthorizeUnknownCredentialKindFailsClosed`; `TokenCredentialKind` table test for workspace-restricted token = machine, run token = run, `credential:sync` = refused (plan) | U |
| `RequireAction` router middleware; new route cannot ship unmapped | ticket Scope | `TestAccessSweep_UnmappedRouteFixtureFails` | U |
| `RequirePerson`, `RefuseRunCredentials`, `requireAdminAccess`, install-repo `canLandRepo/canAdminRepo/canOwnRepo` replaced; helpers only for multitenant | ticket Scope; delta §2 | `TestAccessSweep_NoInstallRouteCallsLegacyHelpers` (static: rg over `services/` and `compose/` against an allowlist of multitenant files) ; regression `run_credential_landing_gates_integration_test.go:206` and `run_credential_*_integration_test.go` rewritten to new kinds | S + I |
| Absent confirmation consumer: typed unavailable, never success, never fabricated 202 | ticket Decisions | `TestAuthorizeConfirmWithoutConsumerFailsClosed` | U + I |
| Refusals use the §6.2.3 envelope with class `permission` or `never` | §6.2.3 | `qaMatches` checks status+class+code in every cell; envelope shape test `{code, class, message}` and no `fix` on 403 never/permission (plan: `TestRefusalEnvelopeShape`) | U + I |
| OpenAPI documents the 403 envelope on every served operation | ticket Changes | extend `openapi_conformance_test.go`: every non-public operation lists `403` with the `Error` schema (plan: `TestOpenAPI403OnEveryAuthorizedOperation`) | I |
| C-ACC-01 pass-when 1: `main.reset-to-github` Owner session only; GitHub App Owner only | C-ACC-01; C-J10-07 step 4 | rows `main.reset-to-github`, `github.app.change` | U + I |
| C-ACC-01 pass-when 2: every cell follows §5.2.1; explicit `todo.amend` confirm, steer/move/stop/retry/terminal/sleep/wake execute, member-delegated Discard = permission, maintainer-delegated Discard = confirm | C-ACC-01 | rows `todo.amend`, `todo.steer`, `stack.move`, `todo.stop`, `todo.retry`, `box.terminal`, `branch.sleep`, `branch.wake`, `branch.discard-foreign` | U + I |
| C-ACC-01 pass-when 3: run succeeds only on own conflict and own branch | C-ACC-01 | `TestAuthorizeRunSubjectScoping`; rows `todo.answer`, `branch.join` x `RO`/`RX`; every other `RO` cell is P or undecided | U + I |
| C-ACC-01 pass-when 4: `machine` refused on every row | C-ACC-01; §5.2 | columns `MO`/`MX` | U + I |
| C-ACC-01 pass-when 5: refused cell = zero side effects (0 merge calls; no change in `members`, `secrets`, `todos`) | C-ACC-01 | `TestP3_RefusedCallsHaveZeroSideEffects`; I asserts table digests per refused cell | P + I |
| C-ACC-01 pass-when 6: no secrets route returns a value field | C-ACC-01; §5.2 last row | `TestAccessSweep_NoSecretsRouteReturnsAValueField` | I |
| C-ACC-01 pass-when 7: every served route has exactly one declared action; unmapped list empty | C-ACC-01 | section 3 | U + I |
| C-ACC-02 steps 1-2 (this ticket's half): delegated merge = 202; run/machine merge = 403 permission; delegated approval = 403 never; run/machine approval = permission; zero merges | C-ACC-02 | rows `merge`, `approval.approve` x `DO`/`RO`/`MO`; the confirmation row creation itself is T-ACC-05 | I |
| C-ACC-02 step 9 prerequisite: `via=smithers` bearer reaches `todo.new` as `C` | C-ACC-02 | row `todo.new` x `DO`, via=smithers | U |
| C-J10-07 step 4: maintainer, member, delegated (and owner-delegated) Reset-to-GitHub-main refused 403, nothing changes | C-J10-07 | row `main.reset-to-github` | U + I |
| C-J1-04 (listed acceptance) | C-J1-04 | not provable by this ticket alone: it needs T-ACC-04/05, TODO flow, merge. Report as pending. | - |
| Provisional owner refused everything except setup with `owner_unverified` | §5.1.0; C-SEC-04 step 6 | column `SOp`; `TestAuthorizeProvisionalOwnerRefusedEverythingButSetup` | U + I |
| Setup session reaches only `GET /api/install`, setup steps, OAuth start/callback (G11) | §5.1.0; G11 | column `UP` (Y only on 3 rows); sweep probes every route with a setup-session cookie | U + I |
| Role re-read live per request (no cached role) | §5.4, §5.6.1; `MemberBoundary` doc "reads the roster on every check" | `TestAuthorizeRoleReadLive_NoCache` | U |
| App agent has no write/exec/terminal-input tool (G08) | §15.1.3, §15.1.4 | Not this ticket's check (C-ACC-05, T-STK-04/T-APP-21). This ticket's contribution: `app_agent` eligibility rows (`PA`, `PX`) in the oracle; (plan) `TestAppAgentToolSetIsEligibilityFilteredNever` asserts rows with `agent: never` or without `A` are absent from the tool list, once T-CAT-01 exposes eligibility | U |
| Approval-kind Needs you maintainer-only (G10) | §5.2 row 2; mvp L137 | rows `approval.approve`, `approval.deny` x `SE` (P), `DO` (N); plus `todo.answer` kind=question accepts Member (the same command id with subject.kind, SG-12-style note) | U + I |
| Confirmation expires after 24 h (G14) | §5.4 | `TestAbuse_ConfirmationReplayAfter24h` (T-ACC-05 storage; the authorizer half is the live role re-check at approve) | I |

## 2. The oracle (written from the spec text only)

Principals (columns): `SO` session owner; `SOp` session of a provisional owner (§5.1.0); `SM` session maintainer; `SE` session member; `SS` session of a suspended member; `SR` session of a removed member; `NC` non-member (no roster row, so no credential: unauthenticated); `DO/DM/DE` delegated credential of an owner / maintainer / member (any `via` the row's Who admits); `DS/DR` delegated credential of a suspended / removed member; `RO` run credential on its own conflict or own branch; `RX` run credential on any other TODO, wait or branch; `MO/MX` machine credential on its own branch / another branch; `UP` setup session before the claim; `UQ` the same setup session after the claim.

Tokens: `Y` allow. `C` confirm (202 `{confirmation: id, state: "requested"}`, command not executed). `P` 403 `permission`. `N` 403 `never`. `V` 403 `permission` code `owner_unverified`. `X` 401. `Z` 401 `setup_closed`. `R` refused with 401 or 403, class not specified by the spec (SG-05). A trailing `?` means the spec does not decide the cell; the token is QA's proposal and the test reports it instead of asserting it.

Spec lines behind the columns that repeat on every row:
- `SS/SR/DS/DR` refuse: §5.1.2 (sign-in needs a live roster row and push access), §5.1.3 (loss of write access sets `suspended_at`), §5.6.1 (sessions deleted, delegated credentials revoked within 5 s), §15.1.4a (turn credential refused for a non-active author).
- `NC` is 401: §5.1.2, M-05 "access needs a place on the roster". A GitHub user with no roster row cannot hold a session, so there is no authenticated non-member to refuse; the 403 `not_a_member` path (`identity.MemberBoundary`) covers a credential whose user has left the roster.
- `RO/RX/MO/MX` refuse except the cited cells: §5.2 "Coding agent (run)" column and footnote, §5.3 ("Can approve/merge: No"), §17.2.
- `UP/UQ`: §5.1.0 and G11.
- `SOp`: §5.1.0 "allows the setup steps and refuses every other action".
- A delegated cell on a multi-actor row (`PA`, `PX`) for a `via` outside the row's Who is `P?` (SG-03). A person-only row (Who `P`) is `never` for every delegated credential (§6.1.2).

```
action                     who  SO SOp SM SE SS SR NC DO DM DE DS DR RO RX MO MX UP UQ
install.read               PAX  Y   Y   P   P   R   R   X   Y?  P?  P?  R   R   P   P   P   P   Y   Z 
install.setup-step         P    Y   Y   P   P   R   R   X   N?  P   P   R   R   P   P   P   P   Y   Z 
setup.oauth-start-callback PAX  Y   Y   Y   Y   Y   Y   Y   Y   Y   Y   Y   Y   Y   Y   Y   Y   Y   Z 
install.settings           P    Y   V   P   P   R   R   X   N   P   P   R   R   P   P   P   P   P   Z 
install.quiesce            P    Y   V   P   P   R   R   X   N   P   P   R   R   P   P   P   P   P   Z 
install.scorecard          P    Y   V   P   P   R   R   X   N   P   P   R   R   P   P   P   P   P   Z 
github.app.change          P    Y   V   P   P   R   R   X   N   P   P   R   R   P   P   P   P   P   Z 
main.reset-to-github       P    Y   V   P   P   R   R   X   N   P   P   R   R   P   P   P   P   P   Z 
agents.model.write         P    Y   V   P   P   R   R   X   N   P   P   R   R   P   P   P   P   P   Z 
model.configure            P    Y   V   P   P   R   R   X   N   P   P   R   R   P   P   P   P   P   Z 
triggers.manage            P    Y?  V   P?  P?  R   R   X   N?  P?  P?  R   R   P   P   P   P   P   Z 
merge                      PAX  Y   V   Y   P   R   R   X   C   C   P   R   R   P   P   P   P   P   Z 
flow.merge                 PAX  Y   V   Y   P   R   R   X   C   C   P   R   R   P   P   P   P   P   Z 
approval.approve           P    Y   V   Y   P   R   R   X   N   N   P   R   R   P   P   P   P   P   Z 
approval.deny              P    Y   V   Y   P   R   R   X   N   N   P   R   R   P   P   P   P   P   Z 
members.add                P    Y   V   Y   P   R   R   X   N   N   P   R   R   P   P   P   P   P   Z 
members.role               P    Y   V   Y   P   R   R   X   N   N   P   R   R   P   P   P   P   P   Z 
members.remove             P    Y   V   Y   P   R   R   X   N   N   P   R   R   P   P   P   P   P   Z 
members.write-on-owner     P    R   V   R   R   R   R   X   R   R   R   R   R   R   R   R   R   R   Z 
members.list               P    Y   V   Y   Y?  R   R   X   N?  N?  P?  R   R   P?  P?  P   P   P   Z 
secrets.set                P    Y   V   Y   P   R   R   X   N   N   P   R   R   P   P   P   P   P   Z 
secrets.delete             P    Y   V   Y   P   R   R   X   N   N   P   R   R   P   P   P   P   P   Z 
secrets.scope              P    Y   V   Y   P   R   R   X   N   N   P   R   R   P   P   P   P   P   Z 
secrets.bind               P    Y   V   Y   P   R   R   X   N   N   P   R   R   P   P   P   P   P   Z 
secrets.names              PAX  Y   V   Y   Y?  R   R   X   Y?  Y?  Y?  R   R   P?  P?  P   P   P   Z 
secrets.read-value         P    R   R   R   R   R   R   X   R   R   R   R   R   R   R   R   R   R   Z 
confirmation.decide-own    P    Y   V   Y   Y   R   R   X   R   R   R   R   R   R   R   R   R   P   Z 
confirmation.decide-other  P    R   V   R   R   R   R   X   R   R   R   R   R   R   R   R   R   P   Z 
confirmation.create        PAX  Y?  V   Y?  Y?  R   R   X   Y?  Y?  Y?  R   R   P?  P?  P?  P?  P   Z 
confirmation.list          PAX  Y   V   Y   Y   R   R   X   Y   Y   Y   R   R   P?  P?  P?  P?  P   Z 
todo.read                  PAX  Y   V   Y   Y   R   R   X   Y   Y   Y   R   R   Y?  P?  Y?  P?  P   Z 
todo.new                   PAX  Y   V   Y   Y   R   R   X   C   C   C   R   R   P   P   P   P   P   Z 
todo.from-issue            PAX  Y   V   Y   Y   R   R   X   C   C   C   R   R   P   P   P   P   P   Z 
todo.from-issue-outsider   PAX  Y   V   Y   P   R   R   X   C   C   P   R   R   P   P   P   P   P   Z 
todo.amend                 PAX  Y   V   Y   Y   R   R   X   C   C   C   R   R   P   P   P   P   P   Z 
todo.drop                  PAX  Y   V   Y   Y   R   R   X   C   C   C   R   R   P   P   P   P   P   Z 
todo.steer                 PAX  Y   V   Y   Y   R   R   X   Y   Y   Y   R   R   P   P   P   P   P   Z 
todo.stop                  PAX  Y   V   Y   Y   R   R   X   Y   Y   Y   R   R   P   P   P   P   P   Z 
todo.resume                PAX  Y   V   Y   Y   R   R   X   Y   Y   Y   R   R   P   P   P   P   P   Z 
todo.retry                 PAX  Y   V   Y   Y   R   R   X   Y   Y   Y   R   R   P   P   P   P   P   Z 
todo.retry-current-flow    PA   Y   V   Y   Y   R   R   X   Y   Y   Y   R   R   P   P   P   P   P   Z 
stack.move                 PAX  Y   V   Y   Y   R   R   X   Y   Y   Y   R   R   P   P   P   P   P   Z 
todo.answer                PAX  Y   V   Y   Y   R   R   X   Y   Y   Y   R   R   Y   P   P   P   P   Z 
todo.takeover              P    Y   V   Y   P   R   R   X   N   N   P   R   R   P   P   P   P   P   Z 
todo.return-to-item        PA   Y   V   Y   Y   R   R   X   Y   Y   Y   R   R   P   P   P   P   P   Z 
todo.keep-moved            P    Y   V   Y   Y   R   R   X   N   N   N   R   R   P   P   P   P   P   Z 
order.ok                   PA   Y   V   Y   Y   R   R   X   Y   Y   Y   R   R   P   P   P   P   P   Z 
background.retry           PA   Y   V   Y   Y   R   R   X   Y   Y   Y   R   R   P   P   P   P   P   Z 
background.dismiss         PA   Y   V   Y   Y   R   R   X   Y   Y   Y   R   R   P   P   P   P   P   Z 
branch.bring-in            PA   Y   V   Y   Y   R   R   X   C   C   C   R   R   P   P   P   P   P   Z 
branch.discard-foreign     PA   Y   V   Y   P   R   R   X   C   C   P   R   R   P   P   P   P   P   Z 
change.resolve             PA   Y   V   Y   Y   R   R   X   C   C   C   R   R   P   P   P   P   P   Z 
findings.please-fix        PA   Y   V   Y   Y   R   R   X   C   C   C   R   R   P   P   P   P   P   Z 
learning.accept            PA   Y   V   Y   Y   R   R   X   C   C   C   R   R   P   P   P   P   P   Z 
image.add                  PA   Y   V   Y   Y   R   R   X   C   C   C   R   R   P   P   P   P   P   Z 
prs.triage                 PAX  Y   V   Y   Y   R   R   X   C   C   C   R   R   P   P   P   P   P   Z 
issues.write               PAX  Y   V   Y   Y   R   R   X   C   C   C   R   R   P   P   P   P   P   Z 
wiki.write                 PAX  Y   V   Y   Y   R   R   X   Y   Y   Y   R   R   P   P   P   P   P   Z 
wiki.delete                PAX  Y   V   Y   Y   R   R   X   C   C   C   R   R   P   P   P   P   P   Z 
file.restore               PA   Y   V   Y   Y   R   R   X   Y   Y   Y   R   R   P   P   P   P   P   Z 
file.restore-deleted       PA   Y   V   Y   Y   R   R   X   Y   Y   Y   R   R   P   P   P   P   P   Z 
branch.join                PAX  Y   V   Y   Y   R   R   X   Y   Y   Y   R   R   Y   P   P   P   P   Z 
box.terminal               PA   Y   V   Y   Y   R   R   X   Y   Y   Y   R   R   Y?  P   P   P   P   Z 
ssh.copy                   P    Y   V   Y   Y   R   R   X   N?  N?  N?  R   R   P?  P   P   P   P   Z 
terminal.watch             P    Y   V   Y   Y   R   R   X   N   N   N   R   R   P   P   P   P   P   Z 
flow.source-coedit         PX   Y   V   Y   Y   R   R   X   Y   Y   Y   R   R   Y?  P   P   P   P   Z 
branch.fork                PAX  Y   V   Y   Y   R   R   X   Y   Y   Y   R   R   Y?  P   P   P   P   Z 
branch.rebase              PAX  Y   V   Y   Y   R   R   X   Y   Y   Y   R   R   Y?  P   P   P   P   Z 
branch.rebase-now          PA   Y   V   Y   Y   R   R   X   Y   Y   Y   R   R   Y?  P   P   P   P   Z 
branch.sleep               PA   Y   V   Y   Y   R   R   X   Y   Y   Y   R   R   Y?  P   P   P   P   Z 
branch.wake                PA   Y   V   Y   Y   R   R   X   Y   Y   Y   R   R   Y?  P   P   P   P   Z 
branch.add-to-stack        PAX  Y   V   Y   Y   R   R   X   C   C   C   R   R   P?  P?  P   P   P   Z 
flow.run                   PAX  Y   V   Y   Y   R   R   X   Y   Y   Y   R   R   Y?  P   P   P   P   Z 
flow.create                PAX  Y   V   Y   Y   R   R   X   C   C   C   R   R   P   P   P   P   P   Z 
flow.edit                  PAX  Y   V   Y   Y   R   R   X   C   C   C   R   R   P   P   P   P   P   Z 
agents.read                PAX  Y   V   Y   Y   R   R   X   Y   Y   Y   R   R   Y?  P?  Y?  P?  P   Z 
notifications.allow        P    Y   V   Y   Y   R   R   X   N   N   N   R   R   P   P   P   P   P   Z 
auth.sign-out              P    Y   V   Y   Y   R   R   X   N   N   N   R   R   P   P   P   P   P   Z 
machine.report-events      -    P   P   P   P   R   R   X   P   P   P   R   R   P   P   Y   P   P   Z 
```

Row sources (spec line or Appendix B row each cell is written from):

| Row | Source |
| --- | --- |
| `install.read` | §6.3 /api/install GET; §5.1.0 |
| `install.setup-step` | §5.1.0 setup sessions reach setup steps |
| `setup.oauth-start-callback` | §5.1.0 public route; replay after claim = 401 setup_closed |
| `install.settings` | §5.2 row 1; B.2 settings 'P only; agents: never' |
| `install.quiesce` | §5.2 row 1 (upgrade/capacity); §6.3 |
| `install.scorecard` | §6.3 'GET scorecard (owner)' |
| `github.app.change` | §5.2 row 1; C-ACC-01 'GitHub App changes owner-only' |
| `main.reset-to-github` | B.4 'Owner only'; C-J10-07 step 4 |
| `agents.model.write` | §6.3 'PUT {role}/model (owner)'; §11.5a |
| `model.configure` | B.2 model.* 'Owner' |
| `triggers.manage` | none; ticket Risks maps to install.settings (SG-09) |
| `merge` | §5.2 row 2; §15.1.5 merge opens review_merge |
| `flow.merge` | §5.2 row 4 'same as Merge' |
| `approval.approve` | §5.2 row 2 approvals that gate a merge: never; G10 |
| `approval.deny` | §5.2 row 2; B.2 approval.deny 'P only' |
| `members.add` | §5.2 row 3; B.2 members 'agents: never' |
| `members.role` | §5.2 row 3 |
| `members.remove` | §5.2 row 3 |
| `members.write-on-owner` | §5.1.4 'owner can't be demoted or removed by anyone' |
| `members.list` | §6.3 GET; mvp §6.15 vs B.2 conflict (SG-06) |
| `secrets.set` | §5.2 row 3 |
| `secrets.delete` | §5.2 row 3 |
| `secrets.scope` | §5.2 row 3 |
| `secrets.bind` | §5.2 row 3 |
| `secrets.names` | §6.3 'GET names'; mvp §6.15 'everyone sees names' vs B.2 Maintainer (SG-06) |
| `secrets.read-value` | §5.2 last row: empty for every column; C-ACC-01 'no value field' |
| `confirmation.decide-own` | §5.4 only that member's session approves; session-only |
| `confirmation.decide-other` | §5.4 'only that member's session' |
| `confirmation.create` | §6.3 'POST create (any credential)' vs C-ACC-02 (SG-08) |
| `confirmation.list` | §5.4 delegated sees {id,state} only |
| `todo.read` | §5.2 has no read row (SG-07) |
| `todo.new` | §5.2 row 5 commit: confirm; B.2 history.todo A✓ |
| `todo.from-issue` | §5.2 row 5; B.2 issue.implement A✓ |
| `todo.from-issue-outsider` | §5.2 row 6; §10.2.1 subject.outsider_text |
| `todo.amend` | §5.2 row 5 amend: confirm |
| `todo.drop` | §5.2 row 5 drop: confirm |
| `todo.steer` | §5.2 row 5 run; C-ACC-01 'steer executes with no row' |
| `todo.stop` | §5.2 row 5; §15.1.5 stop run |
| `todo.resume` | §5.2 row 5; §15.1.5 resume run |
| `todo.retry` | §5.2 row 5; B.2 history.retry |
| `todo.retry-current-flow` | B.4 |
| `stack.move` | §5.2 row 5 place; B.2 stack.move 'A for move' |
| `todo.answer` | §5.2 row 5 answer; run column 'answer own conflicts only' |
| `todo.takeover` | B.4 'Maintainer only'; §5.6.1 |
| `todo.return-to-item` | B.4 P, A |
| `todo.keep-moved` | B.4 P only |
| `order.ok` | B.4 P, A |
| `background.retry` | B.4 P, A |
| `background.dismiss` | B.4 P, A |
| `branch.bring-in` | §5.2 row 5 Bring in: confirm; B.4 P; A✓ |
| `branch.discard-foreign` | §5.2 row 6; §6.1.2b |
| `change.resolve` | B.2 'P, A✓' |
| `findings.please-fix` | B.2 'P, A✓' |
| `learning.accept` | B.4 P, A✓ |
| `image.add` | B.4 P, A✓ |
| `prs.triage` | §15.1.5 review a PR (/review): confirm |
| `issues.write` | B.2 issues writes A✓ |
| `wiki.write` | §15.1.5 wiki writes: run |
| `wiki.delete` | §15.1.5 delete a wiki page: confirm |
| `file.restore` | B.4 P, A |
| `file.restore-deleted` | B.4 P, A |
| `branch.join` | §5.2 row 7; C-ACC-01 step 4 join b1 vs b2 |
| `box.terminal` | §5.2 row 7; §15.1.5 open a terminal: run; B.2 P, A |
| `ssh.copy` | §5.2 row 7 says delegated run; B.2 ssh 'P' only (SG-06b) |
| `terminal.watch` | B.4 P |
| `flow.source-coedit` | B.2 'Co-edit source on a machine: P, X' |
| `branch.fork` | §5.2 row 7; §15.1.5 fork run |
| `branch.rebase` | §15.1.5 rebase run |
| `branch.rebase-now` | B.4 |
| `branch.sleep` | §15.1.5 sleep run |
| `branch.wake` | §15.1.5 wake run |
| `branch.add-to-stack` | §5.2 row 7: confirm; run column 'own branch' undecided |
| `flow.run` | §5.2 row 7 run flows; B.2 flow.run |
| `flow.create` | B.2 flow.create A✓ |
| `flow.edit` | §15.1.5 propose a flow or agent edit: confirm |
| `agents.read` | §6.3 /api/agents GET |
| `notifications.allow` | B.4 P only |
| `auth.sign-out` | §6.1.2a 'sign-in and sign-out never agent-invocable' |
| `machine.report-events` | §5.2 footnote: machine reports its own branch's events |

Terminal-token addendum (T-TRM-02 owns it, but Authorize needs a `scopes` input): for `via=terminal` in S1 every `Y` outside the §8.11.1 reads, own-TODO answer and steer, and append-only TODO creation becomes `P`, and every `C` becomes `P` (§5.3.2 "confirmations are outside its scope"; C-SEC-05 step 2 expects `403 permission`). The unit table runs a second pass with `scopes=terminal-s1` and asserts exactly that narrowing.

Undecided cell groups (58 cells): `install.read` x delegated (3); `install.setup-step` x `DO` (1); `triggers.manage` (6); `members.list` (6); `secrets.names` (6); `confirmation.create` (10); `confirmation.list` x run/machine (4); `todo.read` x run/machine (4); `agents.read` x run/machine (4); `ssh.copy` (4); run-on-own-branch cells (`RO`) of `box.terminal`, `flow.source-coedit`, `branch.fork`, `branch.rebase`, `branch.rebase-now`, `branch.sleep`, `branch.wake`, `flow.run` (8); `branch.add-to-stack` x `RO,RX` (2). The test logs each one next to the authorizer's actual answer (`TestAuthorizeMatrix_UndecidedCellsReport`) so the tech lead rules on facts. Rulings then become decided cells in the same PR.

## 3. The "every served route" sweep

Where: `access/routes_test.go` (U, metadata) and `compose/access_matrix_integration_test.go` (I, behavior). Both enumerate routes only to measure coverage; expected policy comes from the literal oracle, never from `RouteTable`.

Enumeration. Build the install composition once (self-hosted config only; do not reuse `servedAPIRoutes`, which unions the multitenant composition and would pass a route that is served only by Plue). Include the routes mounted beside the router (`mountBrowserFlow`, `mountChatPublic`, `mountModelPublic`) and the `/api/bootstrap` document that `withAppBootstrap` serves outside chi. Use `chi.Walk` and keep every `(method, pattern)` under `/api/`, plus `/api/live` upgrade and the SSH gateway's authorizer entry. Method set: every method chi lists, including HEAD/OPTIONS if mounted. Fail if the walk finds zero routes or fewer than a pinned floor (guard against a silent compose change that empties the walk).

Check A, metadata (U): `access.RouteTable()[method pattern]` exists for every walked route and is one of `CommandID | Public | Self`; every `CommandID` exists in `catalog.mvp.json`; no `CommandID` is the coarse `todo.write`, `branch.join`-for-everything or a dispatcher-wide id. Reverse check: every RouteTable key is a walked route (no dead entries). Unmapped list written to `unmapped-routes.txt` (C-ACC-01 evidence).

Check B, behavior (I), the check that closes W1. Metadata can lie: a handler can sit behind a `RequireAction` and still call a service directly, or a route can be mounted through `r.Mount` outside the group that applies the middleware. So send real requests:
1. Substitute a deny-all authorizer through the seam (`access.WithAuthorizer(denyAll)`) and send each walked request with a valid owner session and a valid body fixture. Every non-public, non-self route must return the authorizer's 4xx envelope, the audit sink (`access.WithAuditSink`) must hold exactly one event for that request id naming the declared command, and the DB digest must be unchanged. A route that answers 2xx, 404, 400 or 500 instead bypassed Authorize.
2. Substitute an allow-all spy and send the same requests. Every non-public route must produce exactly one audit event before the handler runs (order asserted by the sink's sequence number against a handler-entry counter that the test installs through a wrapping handler registry).
3. Send each route with `machine:other`, `run:other`, `setup:post-claim` and `session:suspended` credentials with the real authorizer. Expect 401/403 envelope, zero audit "allow" events, zero DB change, zero fake-GitHub writes. The only exceptions are the rows the oracle marks `Y` for that principal.
4. Dispatcher doors: a generic dispatch route (`/api/commands/...`) must authorize the command named in the body, not the route. For each `catalog.mvp.json` command, POST it through the dispatcher; the audit event's command id must equal the body's id. Coarse route-level ids on a dispatcher fail.
5. Path variants must resolve to the same policy: trailing slash, `//api/...`, percent-encoded segments, upper-case, `HEAD` for `GET` routes, `OPTIONS` (CORS preflight must not reach handlers with side effects). A variant that reaches a handler without an audit event fails.

Failing fixture (the sweep must fail when it should), in `routes_test.go`:
- `TestAccessSweep_UnmappedRouteFixtureFails`: build a small chi router with `/api/qa/ok` (declared), `/api/qa/unmapped` (no `RequireAction`), `/api/qa/bad-id` (`RequireAction("nope.nope")`), `/api/qa/mounted` (a sub-router attached with `r.Mount` outside the guarded group), and `/api/qa/skips` (declared, but its handler writes to the DB directly and the test wires a non-calling stub authorizer). Run Check A and Check B helpers against it and assert the returned violation list equals exactly those four routes, by name. Run the same helpers against the production router and assert the list is empty. The helpers live in `access/routestest` so the fixture and production runs execute identical code.
- Mutation guard in CI: a nightly job removes `RequireAction` from one random route in a temp copy, runs the sweep and requires red. Cheap, and it proves the sweep still bites.

Pending routes: a route whose owning ticket has not landed is listed as `pending route <ticket>` and never counted as passed (C-ACC-01 pass-when last bullet). The sweep reads the pending list from a reviewed literal fixture, not from the router.

## 4. Abuse cases

All run through the composed install router with real PostgreSQL and the fake GitHub. Common assertion: status and class from the oracle, zero fake-GitHub merge calls, zero changed rows in `members`, `secrets`, `todos`, `person_confirmations`, `install_settings` for refused cells. Delegated minting arrives with T-ACC-04; until then each delegated case runs against a guard-level fake credential and reports "pending T-ACC-04".

| # | Abuse | Steps | Expected |
| --- | --- | --- | --- |
| 1 | Delegated credential tries merge/approve | For each via, owner-delegated and maintainer-delegated: `POST /api/todos/1/merge {reviewed_head_sha}`, approval answer, `PATCH /api/members`, `PUT /api/secrets`, `PUT /api/install/settings`, `main.reset-to-github` | merge = 202 `requested`, no merge call; approval, members, secrets, settings, reset = 403 `never` (owner/maintainer) or `permission` (member-delegated); no `person_confirmations` row for the `never` cells |
| 2 | Run credential acts on another branch | b1 run token: join b2; answer T2's conflict; answer T1's non-conflict wait; join `b10`, `B1`, `b1/../b2`, `b1%2F..%2Fb2`; steer own TODO; merge; add-to-stack | only `join b1` and `answer T1 conflict` succeed; all others 403 `permission`; token after the run's terminal state = 401 |
| 3 | Machine credential on host APIs | machine token for b1 against every walked route; report events for b2; a token carrying `credential:workspace-children`; a legacy `credential:sync` token | all refused except b1's own events; workspace-children and sync tokens classify as `machine` and refuse (unknown or legacy kinds fail closed, never become `person`) |
| 4 | Setup session after the claim | keep the setup cookie across the claim; replay the token; call setup steps and `GET /api/install` after claim; two sessions racing the claim | every request `401 setup_closed`; no step state changes after the claim transaction |
| 5 | Suspended member's live session | suspend the member (`suspended_at`) with an open cookie, an open `/api/live` socket, a running app-agent turn, an open delegated token | next HTTP request refused at once (roster read per request, `MemberBoundary` doc); socket closed, token revoked, turn stopped in <= 5 s (§5.6.1, §15.1.4a); cancelled turn writes nothing after the revocation event |
| 6 | Removed member's in-flight request | start a slow write (fault hook between Authorize and commit); remove the member in the gap | spec silent (SG-10). QA position: Authorize and the write share a transaction that locks the member row, so the write either commits before the removal or is refused; no write by a removed member after the removal commits. Test records the ordering and asserts no state written after removal |
| 7 | Role downgrade mid-request | (a) maintainer's delegated merge-confirm requested, role set to member before the person presses; (b) press in flight when the downgrade commits | (a) press = 403 `permission`, 0 merge calls (§5.4 "rechecks their current role"; §6.1.2b); (b) fault hook between recheck and the GitHub merge call: 0 merge calls if the downgrade committed first (SG-10) |
| 8 | Header spoofing of `via` | CLI token + `Smithers-Via: smithers`/`session`/`claude-code`; session cookie + `Smithers-Via: cli`; delegated bearer plus a session cookie together; `X-Forwarded-User`; header with CR/LF or 10 KB value | decisions identical to the credential's kind; recorded `via` is the credential's first (§6.4); a session ignores the header and still merges (and a delegated bearer plus cookie is treated as delegated, C-ACC-02 fail-when); injected header never reaches the audit log unescaped |
| 9 | Confirmation approved from a delegated credential | approve and deny with delegated-O, run, machine, member session, another maintainer's session | all 403; only the requesting member's session approves (§5.4); `GET /api/confirmations` for delegated returns `{id, state}` only |
| 10 | Confirmation replayed after 24 h | injected clock: approve at 24 h - 1 s; approve at 24 h + 1 s; approve twice; approve after the PR head moved | 24 h - 1 s approves once; 24 h + 1 s = 409 `expired`, 0 merge calls; second approve = 409, still exactly 1 merge call (G14, C-ACC-02) |
| 11 | Idempotency-Key replay across credentials | delegated-O creates a merge confirmation with key K; a run credential and a member session repeat the request with K | authorization runs before the idempotency lookup and the key is scoped to the credential's member; the replay by a different credential never returns the cached 202 (§6.2.1, SG-14) |
| 12 | Provisional owner | `SOp` hits every row; install App with a forged `installation_id` (C-SEC-04 step 8); restart between claim and verification | all non-setup rows `owner_unverified`; provisional state survives restart; forged id ignored |
| 13 | Confirm without consumer | delete the confirmation consumer from the composition; send every `C` cell | typed unavailable envelope (infra class), not 202, not allow, 0 side effects (ticket Decisions) |
| 14 | Legacy path survives | `rg` for `canLandRepo`, `canAdminRepo`, `canOwnRepo`, `RequirePerson`, `RefuseRunCredentials`, `requireAdminAccess` in install-mode call paths; run-credential landing regression | zero install-mode callers; run credential landing the install repo's default bookmark is refused (today `canLandRepo` allows it for the repo owner) |

## 5. Property test P3 (gap-analysis P3)

Generators (seeded `math/rand`; the repo has no property-test dependency, so no new one: every failure prints its seed as the retained counterexample, per AGENTS.md "retain reproducible fuzz counterexamples"):
- principal: uniform over the 18 columns, with role/state transitions as first-class actions (suspend, remove, demote, promote, claim, restore access) interleaved with commands;
- via: uniform over smithers, terminal, cli, claude-code, codex, plus 5% unknown strings;
- command: uniform over the 79 oracle rows, plus 3% ids not in the catalog (must refuse, fail closed);
- subject: own/other branch, own/other TODO, own/other confirmation, outsider-text issue on/off, owner-as-target for members writes;
- sequence length 1 to 200; world reset per seed (real PostgreSQL schema + fake GitHub).

Invariants:
1. `Authorize(request) == oracle(request)` for every decided cell (`TestP3_AuthorizeEqualsTable`, 20,000 draws, plus exhaustive enumeration in the unit test so the draws add only transition coverage).
2. Refused calls have zero side effects: after any `refuse`, the digest of `members`, `secrets`, `todos`, `person_confirmations`, `install_settings`, `branches` and the fake GitHub write log equals the digest before (`TestP3_RefusedCallsHaveZeroSideEffects`).
3. A `confirm` outcome executes nothing: fake GitHub merge calls and every command table unchanged except one `person_confirmations` row (T-ACC-05 half).
4. No delegated, run or machine credential ever causes a GitHub merge in any sequence; the only legal merge path is a session approving its own `review_merge` confirmation at the reviewed head (`TestP3_NoNonSessionCredentialEverMerges`).
5. Monotonic revocation: once a member is suspended or removed, no later command by any credential of that member returns `allow` or `confirm` until restoration (hourly re-check, §5.1.3).
6. Delegated equality across via: for rows both `A` and `X` admit, the decision is identical for smithers, cli, codex, claude-code.
7. Fail-closed: unknown credential kind, unknown command id and unknown via never produce `allow`.
8. Idempotence of refusal: repeating a refused request with a new `Idempotency-Key` yields the same refusal.

## 6. Spec gaps for the tech lead

- SG-01: `catalog.mvp.json` carries eligibility for `person|app_agent|external_agent` only (§6.1.2). The §5.2 run column ("answer own conflicts only", "within its own branch") and the machine and setup credentials have no descriptor field, so the authorizer cannot derive them from "the literal descriptors" (§5.2.1). Name the field or the table that holds them.
- SG-02: ticket says delegated cells are identical for every `via`, but §5.3.2 narrows the S1 `via=terminal` token (confirmations out of scope) and C-SEC-05 expects `todo.new` to succeed with no confirmation, while `todo.new` is `confirm` (§5.2 row 5, B.2 A✓). Decide which wins for terminal.
- SG-03: Who differs by actor class (`/terminal` and `Return to Tn` are P, A; co-edit source is P, X; Bring in is P, A✓), so `via=smithers` and `via=cli` differ on those rows. State the refusal class for an ineligible actor (`permission` or `never`) and amend "identical for every via".
- SG-04: the run column's blanket "within its own branch" covers join, terminal, SSH, co-edit, fork, add to stack and run flows; C-ACC-01 tests only join. Say which of the seven a run credential may do on its own branch (QA proposes join, terminal, co-edit, fork, run flows allowed; SSH and add to stack refused).
- SG-05: status, class and code for a suspended member, a removed member and a credential whose user left the roster. §5.6.1 deletes sessions (so 401), while `MemberBoundary` returns 403 `not_a_member`. Pick one per credential kind.
- SG-06: reads have no §5.2 row. Conflicts: secret names (§6.15 "everyone sees names" vs B.2 `secrets.*` Maintainer), member list (B.2 Maintainer, §6.15 shows a Members card), SSH (§5.2 row 7 delegated `run` vs B.2 `ssh` P only), install status for delegated and Member credentials.
- SG-07: "a machine ... can read what that branch needs" (§5.2 footnote) is not enumerated, so the machine read cells cannot be tested beyond "own branch only".
- SG-08: §6.3 says `POST /api/confirmations` accepts any credential and `POST /api/todos/{n}/merge` is "session only", but §5.2.1 and C-ACC-02 step 1 have a delegated credential receive 202 from the merge route and run/machine receive 403. State what each route returns per credential.
- SG-09: trigger routes have no §5.2 row (mvp B.2 defers triggers); the ticket maps them owner-only. Will's ruling (or deletion) needed; the oracle row is marked undecided.
- SG-10: no ordering rule between Authorize and the write for in-flight requests when a member is removed, suspended or downgraded. The 5 s bound (§5.6.1) covers sockets, terminals and turns, not HTTP writes.
- SG-11: refusal class for a setup session on non-setup routes: G11 says 403, C-SEC-04 says "401 or 403".
- SG-12: members writes on the owner (demote, remove, role to owner by a maintainer) are forbidden by §5.1.4 but no code or class is given; also whether `needs_you` of kind `question` vs `approval` is one command id with a subject kind or two ids.
- SG-13: a run credential has no role and survives suspension: §5.6.1 revokes sessions and delegated credentials, not run tokens. Say whether a suspended TODO owner's run token keeps working.
- SG-14: `Idempotency-Key` scope (§6.2.1) is unspecified; replay across credentials must not bypass authorization.
