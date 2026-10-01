-- name: GetFactoryIssueClaimByOwner :one
SELECT * FROM factory_issue_claims
WHERE owner_kind=$1 AND owner_id=$2 ORDER BY claimed_at DESC,id DESC LIMIT 1;

-- name: GetActiveFactoryIssueClaim :one
SELECT * FROM factory_issue_claims
WHERE repository_id=$1 AND issue_number=$2 AND released_at IS NULL;

-- name: GetLatestFactoryIssueEvent :one
SELECT * FROM repository_job_events
WHERE repository_id=$1 AND source='github' AND issue_number=$2 AND payload->'issue' IS NOT NULL
ORDER BY received_at DESC,id DESC LIMIT 1;

-- name: GetFactoryIssueClaimOperation :one
SELECT r.id::text AS id,r.tenant_id,r.principal_id,r.cancellation_requested,d.external_receipt,d.external_started_at
FROM product_job_requests r JOIN product_job_dispatches d ON d.operation_id=r.id
WHERE r.id::text=$1;

-- name: GetFactoryIssueClaimByContinuation :one
SELECT * FROM factory_issue_claims
WHERE owner_kind='repository-job' AND authority->'continuations' ? sqlc.arg(dispatch_id)::text
ORDER BY claimed_at DESC,id DESC LIMIT 1;

-- name: DeferFactoryIssueFollower :execrows
UPDATE repository_job_dispatches SET status='queued',error=$3,next_attempt_at=$4,
 attempts=GREATEST(attempts-1,0),claim_token=NULL,lease_until=NULL,updated_at=now()
WHERE id=$1 AND claim_token=$2 AND status='dispatching';

-- name: ListFactoryIssueDispatchesForCancellation :many
SELECT d.* FROM repository_job_dispatches d JOIN repository_job_registrations r ON r.id=d.registration_id
WHERE r.repository_id=$1 AND r.job=$2
AND EXISTS(SELECT 1 FROM factory_issue_claims c WHERE c.repository_id=r.repository_id
 AND c.owner_kind='repository-job' AND c.released_at IS NULL
 AND (c.owner_id=d.id::text OR c.authority->'continuations' ? d.id::text))
ORDER BY d.created_at,d.id;
