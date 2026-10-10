-- name: GetNotificationJournal :one
SELECT * FROM notification_journals WHERE user_id = sqlc.arg(user_id);

-- name: ListNotificationFacts :many
-- Gate historical snippets against both their original source and the latest
-- notification source at this page's committed head. Filtering old events
-- alone could resurrect an obsolete public post-image after a private update.
SELECT f.*, latest.post_image AS current_post_image
FROM notification_facts f
CROSS JOIN LATERAL (
    SELECT current_fact.post_image
    FROM notification_facts current_fact
    WHERE current_fact.user_id = f.user_id
      AND current_fact.notification_id = f.notification_id
      AND current_fact.sequence <= sqlc.arg(through_sequence)
    ORDER BY current_fact.sequence DESC LIMIT 1
) latest
WHERE f.user_id = sqlc.arg(user_id)
  AND f.sequence > sqlc.arg(after_sequence)
  AND f.sequence <= sqlc.arg(through_sequence)
ORDER BY f.sequence ASC
LIMIT sqlc.arg(page_size);

-- name: GetNotificationBranchLockRepository :one
-- Historical join-request notifications still require repository authorization.
-- This read grants no lock and is the only retained branch-lock query.
SELECT repository_id FROM branch_lock_join_requests WHERE id = $1;
