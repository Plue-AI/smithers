-- name: CreateOrganization :one
INSERT INTO organizations (name, lower_name, description, visibility)
VALUES ($1, $2, $3, $4)
RETURNING *;

-- name: AddOrgMember :one
INSERT INTO org_members (organization_id, user_id, role)
VALUES ($1, $2, $3)
RETURNING *;

-- name: CreateTeam :one
INSERT INTO teams (organization_id, name, lower_name, description, permission)
VALUES ($1, $2, $3, $4, $5)
RETURNING *;

-- name: AddTeamMember :one
INSERT INTO team_members (team_id, user_id)
VALUES ($1, $2)
RETURNING *;

-- name: AddTeamMemberIfOrgMember :one
-- Locks the org membership row (FOR UPDATE OF om) so team-member admission
-- serializes with RemoveOrgMember, which locks the same row in its transaction
-- before stripping team memberships. Without the lock a concurrent removal
-- could clean up team memberships, this insert could land, and the org-member
-- delete could then commit — leaving a removed user on a team with repo access.
WITH org_membership AS (
    SELECT om.id
    FROM teams t
    JOIN org_members om ON om.organization_id = t.organization_id
    WHERE t.id = sqlc.arg(team_id)
      AND om.user_id = sqlc.arg(user_id)
    FOR UPDATE OF om
)
INSERT INTO team_members (team_id, user_id)
SELECT sqlc.arg(team_id), sqlc.arg(user_id)
FROM org_membership
RETURNING *;

-- name: AddTeamRepo :one
INSERT INTO team_repos (team_id, repository_id)
VALUES ($1, $2)
RETURNING *;

-- name: AddTeamRepoIfOrgRepo :one
-- Locks the repository row (FOR UPDATE OF r) so team-repo admission serializes
-- with repository transfers, whose ownership transaction locks the same row via
-- GetRepoByIDForUpdate. A grant that races a transfer either commits before the
-- transfer locks the row (so the transfer's team_repos cleanup removes it) or
-- waits for the transfer to commit and re-checks the org against the
-- repository's new owner.
WITH org_repo AS (
    SELECT r.id
    FROM repositories r
    JOIN teams t ON t.id = sqlc.arg(team_id)
    WHERE r.id = sqlc.arg(repository_id)
      AND r.org_id = t.organization_id
    FOR UPDATE OF r
)
INSERT INTO team_repos (team_id, repository_id)
SELECT sqlc.arg(team_id), sqlc.arg(repository_id)
FROM org_repo
RETURNING *;

-- name: GetOrgByID :one
SELECT *
FROM organizations
WHERE id = $1;

-- name: GetOrgByLowerName :one
SELECT *
FROM organizations
WHERE lower_name = $1;

-- name: UpdateOrganization :one
UPDATE organizations
SET name = sqlc.arg(name),
    lower_name = sqlc.arg(lower_name),
    description = sqlc.arg(description),
    visibility = sqlc.arg(visibility),
    website = sqlc.arg(website),
    location = sqlc.arg(location),
    factory_owner_id = CASE WHEN sqlc.arg(set_factory_owner)::boolean THEN sqlc.narg(factory_owner_id)::bigint ELSE factory_owner_id END,
    updated_at = NOW()
WHERE id = sqlc.arg(id)
RETURNING *;

-- name: DeleteOrganization :exec
DELETE FROM organizations
WHERE id = $1;

-- name: ListOrgMembers :many
SELECT
    u.*,
    om.role
FROM org_members om
JOIN users u ON u.id = om.user_id
WHERE om.organization_id = sqlc.arg(organization_id)
ORDER BY u.id ASC
LIMIT sqlc.arg(page_size)
OFFSET sqlc.arg(page_offset);

-- name: GetOrgMember :one
SELECT *
FROM org_members
WHERE organization_id = sqlc.arg(organization_id)
  AND user_id = sqlc.arg(user_id);

-- name: LockOrganization :one
-- Serializes owner-invariant flows (last-owner check + member delete) across
-- concurrent member removals in the same organization.
SELECT id
FROM organizations
WHERE id = $1
FOR UPDATE;

-- name: GetOrgMemberForUpdate :one
-- Locks the membership row so member removal serializes with
-- AddTeamMemberIfOrgMember, which locks the same row before inserting.
SELECT *
FROM org_members
WHERE organization_id = sqlc.arg(organization_id)
  AND user_id = sqlc.arg(user_id)
FOR UPDATE;

-- name: RemoveOrgMember :exec
DELETE FROM org_members
WHERE organization_id = sqlc.arg(organization_id)
  AND user_id = sqlc.arg(user_id);

-- name: DeleteTeamMembershipsForOrgUser :exec
-- Remove a user from every team of an organization. Team membership grants
-- repo access independently of org membership, so this must run when a user is
-- removed from the org, otherwise the user keeps team-based repo access.
DELETE FROM team_members
WHERE user_id = sqlc.arg(user_id)
  AND team_id IN (
    SELECT id FROM teams WHERE organization_id = sqlc.arg(organization_id)
  );

-- name: UpdateOrgMemberRole :exec
UPDATE org_members
SET role = sqlc.arg(role),
    updated_at = NOW()
WHERE organization_id = sqlc.arg(organization_id)
  AND user_id = sqlc.arg(user_id);

-- name: ListUserOrgs :many
SELECT o.*
FROM organizations o
JOIN org_members om ON om.organization_id = o.id
WHERE om.user_id = sqlc.arg(user_id)
ORDER BY o.id ASC
LIMIT sqlc.arg(page_size)
OFFSET sqlc.arg(page_offset);

-- name: CountUserOrgs :one
SELECT COUNT(*)
FROM org_members
WHERE user_id = sqlc.arg(user_id);

-- name: ListOrgTeams :many
SELECT *
FROM teams
WHERE organization_id = sqlc.arg(organization_id)
ORDER BY id ASC
LIMIT sqlc.arg(page_size)
OFFSET sqlc.arg(page_offset);

-- name: GetTeamByID :one
SELECT *
FROM teams
WHERE id = $1;

-- name: GetTeamByOrgAndLowerName :one
SELECT *
FROM teams
WHERE organization_id = sqlc.arg(organization_id)
  AND lower_name = sqlc.arg(lower_name);

-- name: UpdateTeam :one
UPDATE teams
SET name = sqlc.arg(name),
    lower_name = sqlc.arg(lower_name),
    description = sqlc.arg(description),
    permission = sqlc.arg(permission),
    updated_at = NOW()
WHERE id = sqlc.arg(id)
RETURNING *;

-- name: DeleteTeam :exec
DELETE FROM teams
WHERE id = $1;

-- name: ListTeamMembers :many
SELECT u.*
FROM team_members tm
JOIN users u ON u.id = tm.user_id
WHERE tm.team_id = sqlc.arg(team_id)
ORDER BY u.id ASC
LIMIT sqlc.arg(page_size)
OFFSET sqlc.arg(page_offset);

-- name: CountTeamMembers :one
SELECT COUNT(*)
FROM team_members
WHERE team_id = sqlc.arg(team_id);

-- name: RemoveTeamMember :exec
DELETE FROM team_members
WHERE team_id = sqlc.arg(team_id)
  AND user_id = sqlc.arg(user_id);

-- name: ListTeamRepos :many
SELECT r.*
FROM team_repos tr
JOIN repositories r ON r.id = tr.repository_id
WHERE tr.team_id = sqlc.arg(team_id)
ORDER BY r.id ASC
LIMIT sqlc.arg(page_size)
OFFSET sqlc.arg(page_offset);

-- name: CountTeamRepos :one
SELECT COUNT(*)
FROM team_repos
WHERE team_id = sqlc.arg(team_id);

-- name: RemoveTeamRepo :exec
DELETE FROM team_repos
WHERE team_id = sqlc.arg(team_id)
  AND repository_id = sqlc.arg(repository_id);

-- name: CountOrgMembers :one
SELECT COUNT(*)
FROM org_members
WHERE organization_id = $1;

-- name: CountOrgTeams :one
SELECT COUNT(*)
FROM teams
WHERE organization_id = $1;

-- name: CountOrgOwners :one
SELECT COUNT(*)
FROM org_members
WHERE organization_id = $1 AND role = 'owner';

-- name: GetOrgCredentialOwnerID :one
-- Picks a stable owner of the organization whose tokens authenticate (see
-- GetAuthInfoByTokenHash). Access tokens need a user, so platform-minted,
-- repository-bound credentials for org-owned repositories (sandbox-plane CI
-- clones) are issued under this owner.
SELECT om.user_id
FROM org_members om
JOIN users u ON u.id = om.user_id
WHERE om.organization_id = $1
  AND om.role = 'owner'
  AND u.is_active = true
  AND u.prohibit_login = false
  AND u.deleted_at IS NULL
ORDER BY om.user_id ASC
LIMIT 1;

-- name: ListAllOrgs :many
SELECT *
FROM organizations
ORDER BY id ASC
LIMIT sqlc.arg(page_size)
OFFSET sqlc.arg(page_offset);

-- name: CountAllOrgs :one
SELECT COUNT(*)
FROM organizations;
