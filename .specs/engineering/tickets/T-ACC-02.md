# T-ACC-02 Members roster, access check, hourly recheck, `/api/members`

Stage S1 · Size M · Depends on T-ACC-01, T-STK-01 · Unblocks T-ACC-04, T-ACC-06, T-APP-06, T-APP-16, T-FLW-13, T-GH-02, T-MCH-11, T-REL-02, T-STK-09, T-TRM-04 · Issue: [#3491](https://github.com/smithersai/smithers/issues/3491)
Spec: spec.md §5.1.2–§5.1.4, §2 (Install: one owner), §3 (`members`), §3.1, §6.3 (`/api/members`), §7.2 (`members` topic), §12.2 (members' permission stream) · Delta: delta.md §2 (Add `members`; Restore-reference closed-alpha roster) · Product: mvp.md J1.8, §3 "Member", §6.2, §6.15 "Members and maintainers", M-05
Ready: 2026-10-02 smithers-8a sha256:06cbf6936190

## Goal
A maintainer adds a person by GitHub username. That person can sign in only while they are on the roster and hold `push` or higher on GitHub. Losing GitHub write access suspends them within one hour.

## Scope
Approved integration requirements (In):
- After credential validity, scope, minimum role and actor/delegation policy pass, any request to demote or remove the owner, or set any member's role to owner, returns HTTP 403, class `permission`, code `owner_immutable`, and creates no member or projection change. The owner is equally subject to this invariant. Lower-role callers retain the ordinary permission refusal; eligible delegated callers retain the preceding `never` refusal. A no-op write on an owner record does not constitute owner transfer and must not be used to bypass the invariant. The member boundary returns current role/state/provisional status; non-active or missing member credentials are dead, with no conflicting not_a_member 403. Serialize state changes with writes. Checks: C-ACC-01, C-ACC-03.
In:
- GET /api/members admits every active member session (minimum role member), no delegated/run/machine path. Check: C-ACC-01.
- `POST` (add by login), `PATCH` (role) and `DELETE` (remove) on `/api/members`, owner or maintainer only.
- Role seeding from GitHub: admin or maintain becomes `maintainer`, write becomes `member` (§5.1.4).
- A person with only read access, or none, cannot be added: return `{code: "needs_github_access", class: "user", fix: "https://github.com/<o>/<r>/settings/access"}` and store no row (§5.1.4). API messages contain no "↗" glyph; the UI renders `fix` as the link. A member whose access later drops below `push` is suspended (§5.1.3). Checks: C-ACC-04, C-J1-05.
- The owner can't be demoted or removed by anyone, and there is exactly one owner (§2, §5.1.4). Owner transfer is deferred.
- Sign-in gate widened from owner-only (T-ACC-01) to roster ∧ `push` (§5.1.2).
- Hourly recheck of every active member, plus an immediate recheck on a 401 or 403 from GitHub for that member (§5.1.3). Loss sets `suspended_at`; regaining access clears it.
- Stable `unix_uid` allocated at add time (§5.5.1; first used in S2).
- A `members` projection event in the same transaction as each change (§3.1).

Out:
- Closing sessions, sockets and grants on removal or suspension (T-ACC-06).
- The matrix authorizer (T-ACC-03). This ticket's owner-or-maintainer check is folded into `Authorize` and deleted there.
- The Members card (T-APP-06), SSH key import (T-TRM-04), unix users on machines (T-MCH-11).
- Invitations, organizations and teams. mvp.md §6.15 says there are no invitations, and `/api/orgs*` stays 404.

- Out of scope: owner transfer, delegated member administration, changing GitHub permissions, and a second permission scheduler. No repository code executes in this ticket.

## Changes
- `packages/backend/internal/services/members.go` (from T-ACC-01): `Add`, `SetRole`, `Remove`, `List`, `Recheck(member)`, `RecheckAll`.
  - Permission comes from the shared lookup extracted in T-ACC-01 (`GET /repos/{o}/{r}/collaborators/{login}/permission` with the installation token). It returns `{permission, role_name}` plus a classified outcome. Successful member-level `none` or `read` suspends an existing member; installation-level 401/403/404 sets the permission stream’s `github_sync` health to `refused` (§4.4) with no member change. An expired installation token or an App that lost the repository is an installation failure. Disambiguate 404 through `GET /users/{login}` before assigning an unknown-user or no-permission result; an unresolved lookup fails closed with no member change. Checks: C-ACC-03, C-ACC-04.
  - An unknown GitHub login returns `{code: "unknown_github_user", class: "user"}`. Owner demotion or removal returns `{code: "owner_immutable", class: "permission"}`. After T-ACC-03 integration, a Member role caller returns HTTP 403 permission/permission before delegation and owner invariants. A transient GitHub error returns `{code: "github_unavailable", class: "github", retry_at}` and preserves the last state. Checks: C-ACC-04, C-J1-05.
- `packages/backend/internal/routes/members.go` (new) and its mount in `compose/router.go`: `GET/POST /api/members`, `PATCH/DELETE /api/members/{login}`.
  - Every mutating request takes an `Idempotency-Key` (§6.2.1).
  - Errors use the typed envelope (§6.2.3). Until T-ACC-03 lands, POST/PATCH/DELETE reuse `RequirePerson` (`packages/backend/internal/middleware/run_credential.go:145`) before any mutation, refusing non-person credentials (run tokens today, delegated credentials when available) with HTTP 403 `{code: "person_only", class: "never", message: "Only a person can do this"}`. T-ACC-03 replaces this interim gate with §5.2.1 precedence: dead holders=401 permission/unauthenticated; run/machine and scope/role failures=403 permission/permission; eligible delegated person-only=403 never/never. PATCH accepts `{role: "maintainer"|"member"}`; `{role: "owner"}` returns `owner_immutable` with class `permission`, never owner transfer. GET returns exactly the `packages/rpc/src/MembersCard.ts` model owned by T-APP-19: `{members: [{login, name, avatar_url, color_index, role, needs_access, suspended, actions}], access_url}`. Keep `unix_uid` internal and omit it from the public response; the container has no second mapping. Checks: C-ACC-04, C-J1-05, C-UI-08.
- `packages/backend/db/product/queries/members.sql` (new); regenerate sqlc.
- Hourly recheck job on the existing periodic runner (`packages/backend/internal/cleanup/`, pattern of `auth_cleaner.go`).
  - Each GitHub call goes through the shared budget (`services/github_budget.go`).
  - T-GH-02 adopts this job as the §12.2 "members' permission" stream. No second scheduler.
- Immediate recheck hook: a 401 or 403 on a member user-token call enqueues the shared `Recheck(member)` job. Cover `services/github_proxy.go:275-292` and `RefreshUserGitHubToken` (`services/auth.go:1384`) with its callers `github_user_repos.go:579`, `github_import.go:2464` and `auth.go:1673`. Carry the member identity and token kind through refresh errors; installation errors update sync health and never suspend a member. C-ACC-03 drives each caller and the non-refreshing proxy 403.
- The identity boundary from frozen T-ACC-01 returns current role, state (active | suspended | removed) and provisional status, including absence for dead-credential handling; lookup failure gives no allow/effect. Checks: C-ACC-01, C-ACC-03.
- OpenAPI: add `docs/api/openapi/members.yaml` (new), then run `scripts/openapi-bundle.mjs`.
- Docs: add a members section to the backend package docs (`packages/backend/docs/`), then run `pnpm docs:sync`, `pnpm docs:check` and `smthrs docs //packages/backend:docs`.

## Decisions and pre-review
- Before start, smithers-3f approves the member-boundary, scheduler and transaction seams; smithers-b8 approves the public members API and refusal text. The tech lead (smithers-8a) resolves contract disagreements; Will decides any product-policy change. Existing role and access rules are binding.
- The thin path uses T-ACC-01's installation-token lookup. T-GH-01 and T-GH-02 later replace credential storage and adopt the job; neither is required to land this API.

## Tests
- Active Member session GET succeeds; delegated O/M/E GET=never and run/machine=permission. Dead credentials=401. Test current role/state/provisional boundary, owner demotion/removal and role-to-owner precedence; no refused member/projection effects. Checks: C-ACC-01, C-ACC-03.
- Integration, real PostgreSQL plus an httptest GitHub fake: `packages/backend/internal/compose/members_integration_test.go` (new).
  - Role seeding covers all four GitHub answers: admin, maintain, write and read.
  - Adding a login with read or no access returns the literal `needs_github_access` code, `user` class and repository access `fix`, with no glyph in the message and no stored row.
  - Demoting or removing the owner is refused for every role, including the owner's own session.
  - Adding a member with an unknown login is refused.
  - A Member may not add, change roles or remove; an owner or maintainer may.
  - `unix_uid` values are unique, start at 20000, and are never reused after a removal.
- Integration with an injected clock: after GitHub flips a member to read, `RecheckAll` sets `suspended_at` within one tick. The member's next sign-in is refused. A flip back clears the suspension.
- Integration: a 401 from GitHub on the member's token triggers a recheck without waiting for the hour.
- Unit: the role-seeding table, and the decision on transient errors (fail closed, no state change).

- Boundary integration in `compose/members_integration_test.go`: send GET/POST/PATCH/DELETE through the composed install router with real cookies, real PostgreSQL and fixed GitHub responses. Exercise sign-in through OAuth start/callback. Advance the composed periodic runner's clock, rather than calling `RecheckAll`; trigger both 401 and 403 through the served GitHub proxy route. Assert literal statuses, roles, messages, UID values and stored events from reviewed test fixtures; never load spec Markdown or derive expected values from implementation code. C-ACC-03 and C-ACC-04 cover these paths. After T-ACC-03 lands, run/machine writes=403 permission/permission and eligible delegated writes=403 never/never; role/scope failure=permission, with no member/projection effects. Report interim person_only gates separately, not final matrix passes. Add delegated cases when T-ACC-04 lands. Assert each refusal code/class, GitHub `retry_at`, PATCH owner refusal, and the exact MembersCard GET fields with no `unix_uid`; validate against the T-APP-19 schema. Checks: C-ACC-04, C-J1-05, C-UI-08.
- C-ACC-03's socket/grant revocation and C-J1-05's Members view remain joint acceptance with T-ACC-06 and T-APP-06, not prerequisites for landing this ticket.

- C-ACC-03 adds literal lookup fixtures for installation 401/403/404, expired token, removed App repository, member `none`/`read`, existing-user 404 and unknown-user 404. Drive hourly and each reactive caller; assert sync health, unchanged member rows for installation failures and suspension only for confirmed member permission loss.

## Acceptance



- [C-J1-04](../checks/C-J1-04.md): S1 part at its named layer.

- [C-ACC-03](../checks/C-ACC-03.md): GitHub loss suspends within one hour. The revocation half comes from T-ACC-06.
- [C-ACC-04](../checks/C-ACC-04.md): a sign-in off the roster or without write is refused, with the reason.
- [C-J1-05](../checks/C-J1-05.md): add by username, "needs access on GitHub", and a teammate signs in. Passes together with T-APP-06.

## Risks and notes
- **`maintain` is invisible in `permission`.** GitHub's legacy `permission` field reports `maintain` as `write`. Confirm with the fake GitHub and once against a real repository: a user with the maintain role must seed as Maintainer through `role_name`.
- **Catalog doors:** add, change role and remove are the catalog commands `members.add`, `members.role` and `members.remove` behind `/members` (mvp.md Appendix B.2, Maintainer, person only). T-CAT-01 assigns their visibility; the API here doesn't depend on it.
- **Projection events:** T-STK-01 supplies the §3.1 migration and transactional writer. T-COL-02 adds transport later; it is not a landing precondition.
- Don't restore the closed-alpha tables (`0100_drop_alpha_access_tables.sql`). Delta §2 marks them reference-only.

## Ready checklist
1. Dependencies: T-ACC-01 supplies identity and the permission lookup; T-STK-01 supplies the transactional projection writer. Later credential storage, transport and revocation remain named integrations.
2. Exclusions: owner transfer, invitations, teams, delegated administration, GitHub ACL writes, machine users, UI and a second scheduler are explicit.
3. Tests: composed members routes, OAuth callback, proxy and periodic runner use literal reviewed fixtures; no runtime spec or implementation oracle.
4. Decisions: smithers-3f approves backend seams; smithers-b8 approves the public API; smithers-8a resolves seams and Will decides product changes.
5. Owner pre-review: smithers-3f: Answered at 2026-10-02 23:39 UTC; tech lead ADOPTS the blocking permission classification and all refresh-hook callers. Member/projection changes stay atomic and hourly/reactive checks share one job. smithers-b8: Answered at 17:05 with these changes: person-only mutation gates, literal refusal envelopes, PATCH roles and the MembersCard response.
6. Security: no repository execution is added; smithers-3f reviews fail-closed access checks and identity gates. Machine execution remains subject to §1.3 and M-29.
