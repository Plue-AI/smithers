-- name: CreateRepo :one
INSERT INTO repositories (user_id, name, lower_name, description, is_public, default_bookmark)
VALUES ($1, $2, $3, $4, $5, $6)
RETURNING *;

-- name: CreateOrgRepo :one
INSERT INTO repositories (org_id, name, lower_name, description, is_public, default_bookmark)
VALUES ($1, $2, $3, $4, $5, $6)
RETURNING *;

-- name: DeleteRepo :exec
DELETE FROM repositories WHERE id = $1;

-- name: GetRepoByOwnerAndName :one
SELECT r.id, r.user_id, r.org_id, r.name, r.lower_name, r.is_public, r.is_archived
FROM repositories r
JOIN owner_namespaces ns
  ON ns.lower_slug = LOWER(sqlc.arg(owner))
 AND (
   (ns.owner_type = 'user' AND ns.user_id = r.user_id)
   OR
   (ns.owner_type = 'org' AND ns.org_id = r.org_id)
 )
WHERE r.lower_name = LOWER(sqlc.arg(name));

-- name: IsOrgOwnerForRepoUser :one
SELECT EXISTS (
  SELECT 1
  FROM repositories r
  JOIN org_members om ON om.organization_id = r.org_id
  WHERE r.id = sqlc.arg(repository_id)
    AND om.user_id = sqlc.arg(user_id)
    AND om.role = 'owner'
);

-- name: GetHighestTeamPermissionForRepoUser :one
-- A team grant only counts when the team belongs to the repository's CURRENT
-- organization and the user is still an org member. This keeps stale
-- team_repos/team_members rows (e.g. left behind by a raced repo transfer or
-- org-member removal) from granting cross-org or post-removal access.
SELECT COALESCE((
  SELECT t.permission
  FROM team_repos tr
  JOIN teams t ON t.id = tr.team_id
  JOIN team_members tm ON tm.team_id = t.id
  JOIN repositories r ON r.id = tr.repository_id
  JOIN org_members om ON om.organization_id = t.organization_id AND om.user_id = tm.user_id
  WHERE tr.repository_id = sqlc.arg(repository_id)
    AND tm.user_id = sqlc.arg(user_id)
    AND r.org_id = t.organization_id
  ORDER BY CASE t.permission
    WHEN 'admin' THEN 3
    WHEN 'write' THEN 2
    WHEN 'read' THEN 1
    ELSE 0
  END DESC
  LIMIT 1
), '')::text;

-- name: GetRepoByID :one
SELECT *
FROM repositories
WHERE id = $1;

-- name: GetRepoByIDForUpdate :one
-- Locks the repository row for the duration of the transaction. Ownership
-- transactions (transfer/delete/settings) re-read through this so writers that
-- lock the same row before depending on ownership (e.g. AddTeamRepoIfOrgRepo)
-- serialize with the whole transaction instead of only its final UPDATE.
SELECT *
FROM repositories
WHERE id = $1
FOR UPDATE;

-- name: GetRepoByOwnerAndLowerName :one
SELECT r.*
FROM repositories r
JOIN owner_namespaces ns
  ON ns.lower_slug = LOWER(sqlc.arg(owner))
 AND (
   (ns.owner_type = 'user' AND ns.user_id = r.user_id)
   OR
   (ns.owner_type = 'org' AND ns.org_id = r.org_id)
 )
WHERE r.lower_name = LOWER(sqlc.arg(lower_name));

-- name: ListUserRepos :many
SELECT *
FROM repositories
WHERE user_id = sqlc.arg(user_id)
ORDER BY updated_at DESC, id DESC
LIMIT sqlc.arg(page_size)
OFFSET sqlc.arg(page_offset);

-- name: ListPublicUserRepos :many
SELECT *
FROM repositories
WHERE user_id = sqlc.arg(user_id)
  AND is_public = TRUE
ORDER BY updated_at DESC, id DESC
LIMIT sqlc.arg(page_size)
OFFSET sqlc.arg(page_offset);

-- name: ListOrgRepos :many
SELECT *
FROM repositories
WHERE org_id = sqlc.arg(org_id)
ORDER BY updated_at DESC, id DESC
LIMIT sqlc.arg(page_size)
OFFSET sqlc.arg(page_offset);

-- name: ListPublicOrgRepos :many
SELECT *
FROM repositories
WHERE org_id = sqlc.arg(org_id)
  AND is_public = TRUE
ORDER BY updated_at DESC, id DESC
LIMIT sqlc.arg(page_size)
OFFSET sqlc.arg(page_offset);

-- name: UpdateRepo :one
UPDATE repositories
SET name = sqlc.arg(name),
    lower_name = sqlc.arg(lower_name),
    description = sqlc.arg(description),
    is_public = sqlc.arg(is_public),
    default_bookmark = sqlc.arg(default_bookmark),
    topics = sqlc.arg(topics),
    landing_queue_mode = sqlc.arg(landing_queue_mode),
    landing_queue_required_checks = COALESCE(sqlc.arg(landing_queue_required_checks)::text[], '{}'::text[]),
    updated_at = NOW()
WHERE id = sqlc.arg(id)
RETURNING *;

-- name: UpdateRepoTopics :one
UPDATE repositories
SET topics = sqlc.arg(topics),
    updated_at = NOW()
WHERE id = sqlc.arg(id)
RETURNING *;

-- name: UpdateRepoConfigState :one
UPDATE repositories
SET description = sqlc.arg(description),
    is_public = sqlc.arg(is_public),
    topics = COALESCE(sqlc.arg(topics)::text[], '{}'::text[]),
    is_mirror = sqlc.arg(is_mirror),
    mirror_destination = sqlc.arg(mirror_destination),
    workspace_idle_timeout_secs = sqlc.arg(workspace_idle_timeout_secs),
    workspace_persistence = sqlc.arg(workspace_persistence),
    workspace_dependencies = COALESCE(sqlc.arg(workspace_dependencies)::text[], '{}'::text[]),
    landing_queue_mode = sqlc.arg(landing_queue_mode),
    landing_queue_required_checks = COALESCE(sqlc.arg(landing_queue_required_checks)::text[], '{}'::text[]),
    updated_at = NOW()
WHERE id = sqlc.arg(id)
RETURNING *;

-- name: GetRepositoryCloneDepth :one
SELECT clone_depth
FROM repositories
WHERE id = $1;

-- name: SetRepositoryCloneDepth :exec
UPDATE repositories
SET clone_depth = sqlc.arg(clone_depth),
    updated_at = NOW()
WHERE id = sqlc.arg(id);

-- num_stars / num_forks / num_watches are maintained by database triggers
-- (trg_stars_count_*, trg_repositories_fork_count_*, trg_watches_count_*);
-- there are intentionally no increment/decrement queries for them.

-- name: CountUserRepos :one
SELECT COUNT(*)
FROM repositories
WHERE user_id = $1;

-- name: CountPublicUserRepos :one
SELECT COUNT(*)
FROM repositories
WHERE user_id = $1
  AND is_public = TRUE;

-- name: CountOrgRepos :one
SELECT COUNT(*)
FROM repositories
WHERE org_id = $1;

-- name: CountPublicOrgRepos :one
SELECT COUNT(*)
FROM repositories
WHERE org_id = $1
  AND is_public = TRUE;

-- name: ListAllRepos :many
SELECT *
FROM repositories
ORDER BY updated_at DESC, id DESC
LIMIT sqlc.arg(page_size)
OFFSET sqlc.arg(page_offset);

-- name: CountAllRepos :one
SELECT COUNT(*)
FROM repositories;

-- name: ArchiveRepo :one
UPDATE repositories
SET is_archived = TRUE,
    archived_at = NOW(),
    updated_at = NOW()
WHERE id = $1
RETURNING *;

-- name: UnarchiveRepo :one
UPDATE repositories
SET is_archived = FALSE,
    archived_at = NULL,
    updated_at = NOW()
WHERE id = $1
RETURNING *;

-- name: TransferRepoToUser :one
UPDATE repositories
SET user_id = sqlc.arg(new_user_id),
    org_id = NULL,
    updated_at = NOW()
WHERE id = sqlc.arg(id)
RETURNING *;

-- name: TransferRepoToOrg :one
UPDATE repositories
SET org_id = sqlc.arg(new_org_id),
    user_id = NULL,
    updated_at = NOW()
WHERE id = sqlc.arg(id)
RETURNING *;

-- name: DeleteCollaboratorsByRepo :exec
DELETE FROM collaborators
WHERE repository_id = $1;

-- name: DeleteTeamReposByRepo :exec
DELETE FROM team_repos
WHERE repository_id = $1;

-- name: ListCollaboratorsByRepo :many
-- Excludes tombstone rows (user_id IS NULL from ON DELETE SET NULL) since
-- there is no live user record to display or authorize.
SELECT id, repository_id, user_id, permission, created_at
FROM collaborators
WHERE repository_id = $1
  AND user_id IS NOT NULL
ORDER BY id ASC;

-- name: ListTeamReposByRepo :many
SELECT id, team_id, repository_id, created_at
FROM team_repos
WHERE repository_id = $1
ORDER BY id ASC;

-- name: CreateForkRepo :one
INSERT INTO repositories (user_id, name, lower_name, description, is_public, default_bookmark, is_fork, fork_id)
VALUES (sqlc.arg(user_id), sqlc.arg(name), sqlc.arg(lower_name), sqlc.arg(description), sqlc.arg(is_public), sqlc.arg(default_bookmark), TRUE, sqlc.arg(fork_id))
RETURNING *;

-- name: CountRepoForks :one
SELECT COUNT(*)
FROM repositories
WHERE fork_id = $1;

-- name: ListRepoForks :many
SELECT *
FROM repositories
WHERE fork_id = sqlc.arg(fork_id)
ORDER BY created_at DESC, id DESC
LIMIT sqlc.arg(page_size)
OFFSET sqlc.arg(page_offset);

-- name: AddCollaborator :one
INSERT INTO collaborators (repository_id, user_id, permission)
VALUES ($1, $2, $3)
RETURNING *;

-- name: GetCollaboratorPermissionForRepoUser :one
SELECT COALESCE(
    (SELECT permission FROM collaborators WHERE repository_id = $1 AND user_id = $2),
    ''
)::text AS permission;

-- name: ListReadableReposForUser :many
-- Ticket 0135: returns every repository the given user can read (owner +
-- org-owner + team permission + direct collaborator + public). Used by the
-- /api/user/repos list route and the workspaces realtime stream filter on
-- the client. Must match the readability predicate used by
-- the repository permission resolver.
SELECT
    r.id,
    COALESCE(u.username, o.name, '')::text AS owner,
    r.name,
    r.updated_at
FROM repositories r
LEFT JOIN users u ON u.id = r.user_id
LEFT JOIN organizations o ON o.id = r.org_id
WHERE
        (r.user_id IS NOT NULL AND r.user_id = sqlc.arg(user_id)::bigint)
     OR (r.org_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM org_members om
            WHERE om.organization_id = r.org_id
              AND om.user_id = sqlc.arg(user_id)::bigint
              AND om.role = 'owner'
        ))
     OR (r.org_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM team_repos tr
            JOIN teams t ON t.id = tr.team_id
            JOIN team_members tm ON tm.team_id = t.id
            WHERE tr.repository_id = r.id
              AND tm.user_id = sqlc.arg(user_id)::bigint
        ))
     OR EXISTS (
            SELECT 1 FROM collaborators c
            WHERE c.repository_id = r.id
              AND c.user_id = sqlc.arg(user_id)::bigint
        )
     OR r.is_public
ORDER BY r.updated_at DESC, r.id DESC
LIMIT sqlc.arg(page_size) OFFSET sqlc.arg(page_offset);

-- name: CountReadableReposForUser :one
SELECT COUNT(DISTINCT r.id)
FROM repositories r
WHERE
        (r.user_id IS NOT NULL AND r.user_id = sqlc.arg(user_id)::bigint)
     OR (r.org_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM org_members om
            WHERE om.organization_id = r.org_id
              AND om.user_id = sqlc.arg(user_id)::bigint
              AND om.role = 'owner'
        ))
     OR (r.org_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM team_repos tr
            JOIN teams t ON t.id = tr.team_id
            JOIN team_members tm ON tm.team_id = t.id
            WHERE tr.repository_id = r.id
              AND tm.user_id = sqlc.arg(user_id)::bigint
        ))
     OR EXISTS (
            SELECT 1 FROM collaborators c
            WHERE c.repository_id = r.id
              AND c.user_id = sqlc.arg(user_id)::bigint
        )
     OR r.is_public;

-- name: ListRepositoryNamesAfter :many
-- Keyset page of every repository with its owner's name, for repository
-- maintenance jobs (#2237).
SELECT r.id,
       COALESCE(o.name, u.username, '')::text AS owner,
       r.name
FROM repositories r
LEFT JOIN users u ON u.id = r.user_id
LEFT JOIN organizations o ON o.id = r.org_id
WHERE r.id > sqlc.arg(after_id)::bigint
ORDER BY r.id
LIMIT sqlc.arg(page_size)::int;
