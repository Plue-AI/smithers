# T-ACC-02 Members on `collaborators`: roster, hourly recheck, revocation within 5 s, GitHub SSH keys

Stage S1, S2 · Size M · Depends on S1 roster: T-ACC-01,  · S1 revocation: T-INS-02 · S2 keys: — · S1 revocation: T-INS-02 · S2 keys: — · S1 revocation: T-INS-02 · S2 keys: — · Unblocks T-ACC-04, T-APP-02, T-APP-04, T-APP-06, T-APP-16, T-FLW-13, T-GH-02, T-MCH-11, T-REL-02, T-STK-09, T-TRM-02 · Issue: [#3491](https://github.com/smithersai/smithers/issues/3491)
Spec: spec.md §5.1.2–§5.1.4, §5.6, §8.10.2, §12.2 · Product: mvp.md J1.8, J3.2, §6.15, M-05, M-24
Rescoped by the minimal-code synthesis, 2026-10-03 (v2 ruling 1; v2 ticket merges; v1 §4). Absorbs T-ACC-02 ([#3495](https://github.com/smithersai/smithers/issues/3495)) and T-ACC-02 ([#3576](https://github.com/smithersai/smithers/issues/3576)).

## Goal
A maintainer adds a person by GitHub username; that person signs in only while listed and holding `push` or higher. Losing GitHub write access suspends them within one hour. Removal or suspension ends every session, credential, socket, terminal and SSH session within 5 s. In S2 their GitHub SSH keys work without manual setup.

## Scope
In: `GET/POST /api/members`, `PATCH/DELETE /api/members/{login}`; role seeding (admin or maintain = Maintainer, write = Member); one immutable owner (`owner_immutable`, HTTP 403); `needs_github_access` and `unknown_github_user` refusals with no stored row; hourly and on-401/403 recheck; transactional revocation; `todo.takeover`; GitHub key import (S2).
Out: hosted `/api/orgs*` (stays 404 on self-host), invitations, teams, owner transfer, a `members` table, the Members card (T-APP-06), unix users on machines (T-MCH-11).

## Changes
- Reuse `collaborators` (`packages/backend/db/product/migrations/0001_product_baseline.sql:2605`) as the roster: owner from T-ACC-01, Maintainer = `admin`, Member = `write`. Reuse `ListCollaboratorsByRepo` and `GetCollaboratorPermissionForRepoUser` (`db/product/queries/repos.sql:280,318`) and the `can*Repo` helpers over `repoPermissionForUser` (`internal/services/repo_permissions.go:114-207`).
- Enable the uncalled `AddCollaborator` (`repos.sql:313`; interface only at `internal/services/repo.go:80`) for add.
- Reshape `collaborators`: one migration adds `github_id`, `unix_uid` (unique, from 20000, never reused) and `suspended_at`.
- Reuse the last-owner `FOR UPDATE` pattern from `internal/services/org.go:1014-1170` (`GetOrgMemberForUpdate`, `CountOrgOwners`) for owner invariants. Do not reuse `org_members`/`OrgService`: they lack GitHub id, unix uid and suspension (3f).
- Reuse the GitHub permission lookup in `github_issue_text_writer.go:145` (`Maintainer`, TTL cache) for the hourly recheck, run by `internal/cleanup/` on the `auth_cleaner.go` pattern. T-GH-02 adopts it as the §12.2 members stream.
- Reuse revocation: suspension sets `suspended_at` and `users.prohibit_login`, which fires `user_access_revocation` (`0001:12080`, function at `:927`); removal calls the dead `publishCollaboratorsRemoved` (`internal/services/revocation_publishers.go:157`); sessions go through `DeleteUserSessions` (`internal/db/auth.sql.go:620`); bus kinds `token_revoked`, `collaborator_removed`, `ssh_key_revoked` (`internal/revocation/event.go:38-62`). Existing consumers: `routes/workspace_socket_revocation.go`, `ssh/revocation.go`. Catch-up poll at most 1 s.
- Restore test cases from `2753d2e3^:packages/backend/internal/services/pair_desktop_revocation_transaction_test.go` that cover commit-before-publish and rollback-publishes-nothing.
- Delete: one migration drops the 10 orphan tables `pair_*` (8) and `share_listing*` (2) (`0001:4678-5512`; no queries or Go references at HEAD).
- S2: reshape `ssh_keys` with `source manual|github` and a unique user fingerprint index; the sign-in path and the hourly recheck sync `GET /users/{login}/keys` with `If-None-Match`.
- New: `internal/routes/members.go` (about 120 lines). Rejected reuse: no roster route exists; `/api/orgs*` must stay 404.

## Tests
- Integration, real PostgreSQL and `internal/githubfake/server.go`: role seeding for admin, maintain, write, read; read/none refused with no row; owner demotion/removal refused for every caller; Member cannot mutate.
- Injected clock: a read flip suspends within one tick; next sign-in refused; flip back clears it. A 401 on the member token rechecks at once.
- Revocation through `DELETE /api/members/{login}` and the recheck job over real terminal, SSE and SSH transports: every one closed within 5 s, max of 20 runs; old cookie refused right after the response; guest child processes end. `RevokeMember` is idempotent.
- `todo.takeover`: maintainer once; delegated 403 `never`; Member 403 `permission`; no change on refusal.
- S2: key diff over new, unchanged, removed, manual duplicate and another member's fingerprint; 304 does nothing; a revoked key's open session closes within 5 s.

## Acceptance
- [C-J1-04](../checks/C-J1-04.md): S1 part.
- [C-ACC-03](../checks/C-ACC-03.md): GitHub loss suspends within one hour; removal revokes every credential and stream within 5 s.
- [C-ACC-04](../checks/C-ACC-04.md): off-roster or no-write sign-in refused with the reason.
- [C-J1-05](../checks/C-J1-05.md): add by username; passes with T-APP-06.
- [C-APP-01](../checks/C-APP-01.md): `todo.takeover` is maintainer-only and person-only.
- [C-J3-06](../checks/C-J3-06.md) (S2): SSH uses only the GitHub key imported at sign-in.

## Risks and notes
- Activation with T-GH-02: Reuse the existing permission lookup; shared poll scheduling is later integration. Missing providers refuse; joint acceptance gates enabling the path.
- Activation with T-ACC-04: Roster establishes identity before delegated credentials; bearer consumers remain refused until classification is installed. Missing providers refuse; joint acceptance gates enabling the path.
- Activation with T-STK-01: Roster storage and revocation can land before TODO takeover wiring. Missing providers refuse; joint acceptance gates enabling the path.
- GitHub's legacy `permission` reports `maintain` as `write`; seed from `role_name`.
- `collaborators.user_id` is nullable; a member added before first sign-in is matched by `github_id`. Unverified: the OAuth callback links a pre-created row.
- The unique fingerprint index fails on duplicate keys; the migration refuses with a readable error.
