-- ---- App-machine timelines (realtime-synchronized xstate history) ----
-- See db/product/migrations/0001_product_baseline.sql. Writes are REST
-- (routes/app_timelines.go -> services/app_timeline.go); reads are the
-- membership-authorized app_timeline_* realtime streams.

-- name: CreateAppTimeline :one
-- Race-safe find-or-create half: the partial-unique conflict target makes a
-- concurrent duplicate create return no row (pgx.ErrNoRows) instead of
-- erroring; the service then re-reads the winner.
INSERT INTO app_timelines (owner_user_id, client_key)
VALUES (sqlc.arg(owner_user_id), sqlc.arg(client_key)::text)
ON CONFLICT (owner_user_id, client_key) WHERE deleted_at IS NULL DO NOTHING
RETURNING *;

-- name: GetAppTimeline :one
SELECT * FROM app_timelines
WHERE id = $1
  AND deleted_at IS NULL;

-- name: GetAppTimelineByOwnerClientKey :one
SELECT * FROM app_timelines
WHERE owner_user_id = $1
  AND client_key = sqlc.arg(client_key)::text
  AND deleted_at IS NULL;

-- name: CountAppTimelinesForOwner :one
SELECT COUNT(*) FROM app_timelines
WHERE owner_user_id = $1
  AND deleted_at IS NULL;

-- name: TouchAppTimeline :one
UPDATE app_timelines
SET head_seq = sqlc.arg(head_seq),
    updated_at = NOW()
WHERE id = $1
  AND deleted_at IS NULL
RETURNING *;

-- ---- Members ----

-- name: UpsertAppTimelineMember :one
-- Never resurrect a removed (revoked) member: re-adding a revoked user is an
-- explicit owner action (ReAddAppTimelineMember), mirroring
-- the persisted membership contract.
INSERT INTO app_timeline_members (timeline_id, user_id, role)
VALUES (sqlc.arg(timeline_id)::uuid, sqlc.arg(user_id), sqlc.arg(role)::text)
ON CONFLICT (timeline_id, user_id) DO UPDATE
SET role = EXCLUDED.role
WHERE app_timeline_members.removed_at IS NULL
RETURNING *;

-- name: ReAddAppTimelineMember :one
-- Owner-granted readmission: clears removed_at (the one path that may
-- resurrect a revoked member).
INSERT INTO app_timeline_members (timeline_id, user_id, role)
VALUES (sqlc.arg(timeline_id)::uuid, sqlc.arg(user_id), sqlc.arg(role)::text)
ON CONFLICT (timeline_id, user_id) DO UPDATE
SET role = EXCLUDED.role,
    removed_at = NULL,
    joined_at = NOW()
RETURNING *;

-- name: GetLiveAppTimelineMember :one
SELECT * FROM app_timeline_members
WHERE timeline_id = sqlc.arg(timeline_id)::uuid
  AND user_id = $1
  AND removed_at IS NULL;

-- name: ListLiveAppTimelineMemberProfiles :many
-- Members with their public identity for the members list (public profile
-- fields only).
SELECT m.timeline_id, m.user_id, m.role, m.joined_at,
       u.username, u.display_name, u.avatar_url
FROM app_timeline_members m
JOIN users u ON u.id = m.user_id
WHERE m.timeline_id = sqlc.arg(timeline_id)::uuid
  AND m.removed_at IS NULL
ORDER BY m.joined_at ASC;

-- name: RevokeAppTimelineMember :one
UPDATE app_timeline_members
SET removed_at = NOW()
WHERE timeline_id = sqlc.arg(timeline_id)::uuid
  AND user_id = $1
  AND removed_at IS NULL
  AND role <> 'owner'
RETURNING *;

-- ---- Events (positional, gapless prefix) ----

-- name: InsertAppTimelineEvent :one
-- Upsert at seq: an append that lands on an existing seq is a fork overwrite
-- (the service first truncates the tail with DeleteAppTimelineEventsFrom, so
-- the conflict arm only fires for the boundary row in the same transaction).
INSERT INTO app_timeline_events (timeline_id, seq, payload)
VALUES (sqlc.arg(timeline_id)::uuid, sqlc.arg(seq), sqlc.arg(payload))
ON CONFLICT (timeline_id, seq) DO UPDATE
SET payload = EXCLUDED.payload,
    created_at = NOW()
RETURNING *;

-- name: DeleteAppTimelineEventsFrom :exec
DELETE FROM app_timeline_events
WHERE timeline_id = sqlc.arg(timeline_id)::uuid
  AND seq >= sqlc.arg(seq);

-- name: DeleteAllAppTimelineEvents :exec
DELETE FROM app_timeline_events
WHERE timeline_id = sqlc.arg(timeline_id)::uuid;

-- name: ListAppTimelineEvents :many
SELECT * FROM app_timeline_events
WHERE timeline_id = sqlc.arg(timeline_id)::uuid
ORDER BY seq ASC;

-- ---- Branches (sealed forks, positional) ----

-- name: InsertAppTimelineBranch :one
INSERT INTO app_timeline_branches (timeline_id, ordinal, from_seq, events)
VALUES (sqlc.arg(timeline_id)::uuid, sqlc.arg(ordinal), sqlc.arg(from_seq), sqlc.arg(events))
ON CONFLICT (timeline_id, ordinal) DO UPDATE
SET from_seq = EXCLUDED.from_seq,
    events = EXCLUDED.events,
    created_at = NOW()
RETURNING *;

-- name: DeleteAllAppTimelineBranches :exec
DELETE FROM app_timeline_branches
WHERE timeline_id = sqlc.arg(timeline_id)::uuid;

-- name: ListAppTimelineBranches :many
SELECT * FROM app_timeline_branches
WHERE timeline_id = sqlc.arg(timeline_id)::uuid
ORDER BY ordinal ASC;

-- ---- Snapshots (rehydration points, pruned window) ----

-- name: UpsertAppTimelineSnapshot :one
INSERT INTO app_timeline_snapshots (timeline_id, seq, state)
VALUES (sqlc.arg(timeline_id)::uuid, sqlc.arg(seq), sqlc.arg(state))
ON CONFLICT (timeline_id, seq) DO UPDATE
SET state = EXCLUDED.state,
    updated_at = NOW()
RETURNING *;

-- name: DeleteAppTimelineSnapshotsFrom :exec
-- Strictly-greater: a snapshot AT the fork boundary is still valid (it
-- captures state after event seq-1, before the overwritten seq).
DELETE FROM app_timeline_snapshots
WHERE timeline_id = sqlc.arg(timeline_id)::uuid
  AND seq > sqlc.arg(seq);

-- name: DeleteAllAppTimelineSnapshots :exec
DELETE FROM app_timeline_snapshots
WHERE timeline_id = sqlc.arg(timeline_id)::uuid;

-- name: PruneAppTimelineSnapshots :exec
-- Keep only the newest keep_count snapshots by seq.
DELETE FROM app_timeline_snapshots
WHERE timeline_id = sqlc.arg(timeline_id)::uuid
  AND seq NOT IN (
    SELECT seq FROM app_timeline_snapshots
    WHERE timeline_id = sqlc.arg(timeline_id)::uuid
    ORDER BY seq DESC
    LIMIT sqlc.arg(keep_count)
  );

-- name: ListAppTimelineSnapshots :many
SELECT * FROM app_timeline_snapshots
WHERE timeline_id = sqlc.arg(timeline_id)::uuid
ORDER BY seq ASC;
