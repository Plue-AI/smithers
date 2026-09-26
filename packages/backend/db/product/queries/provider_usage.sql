-- name: RecordProviderUsage :exec
UPDATE provider_connections SET used_percent=$2, usage_observed_at=clock_timestamp()
WHERE id=$1 AND state='active';

-- name: OwnerAutonomyPaused :one
SELECT EXISTS (SELECT 1 FROM provider_connections
 WHERE user_id=$1 AND owner_type='user' AND state='active' AND used_percent >= 60)::boolean;
