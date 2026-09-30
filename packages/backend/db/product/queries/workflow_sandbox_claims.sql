-- name: ClaimQueuedSandboxWorkflowRuns :many
-- Atomically acquire renewable, generation-fenced ownership of queued
-- sandbox-plane runs. Expired leases are reclaimed immediately. A running row
-- without a lease predates the lease; it is recoverable after three hours,
-- the old serial five-run batch at the maximum per-run timeout.
WITH candidates AS MATERIALIZED (
    SELECT wr.id
    FROM workflow_runs AS wr
    LEFT JOIN workflow_sandbox_claims AS existing
      ON existing.workflow_run_id = wr.id
    WHERE wr.execution_plane = 'sandbox'
      AND (
        wr.status = 'queued'
        OR (
          wr.status = 'running'
          AND (
            (existing.claim_token IS NOT NULL AND existing.lease_expires_at <= NOW())
            OR (existing.claim_token IS NULL AND wr.updated_at <= NOW() - INTERVAL '3 hours')
          )
        )
      )
    ORDER BY wr.created_at ASC, wr.id ASC
    FOR UPDATE OF wr SKIP LOCKED
    LIMIT sqlc.arg(limit_count)
), leased AS (
    INSERT INTO workflow_sandbox_claims (
        workflow_run_id, generation, claim_token, claimed_at, lease_expires_at
    )
    SELECT candidates.id, 1, gen_random_uuid(), NOW(), NOW() + INTERVAL '2 minutes'
    FROM candidates
    ON CONFLICT (workflow_run_id) DO UPDATE
    SET generation = workflow_sandbox_claims.generation + 1,
        claim_token = gen_random_uuid(),
        claimed_at = NOW(),
        lease_expires_at = NOW() + INTERVAL '2 minutes'
    WHERE workflow_sandbox_claims.claim_token IS NULL
       OR workflow_sandbox_claims.lease_expires_at <= NOW()
    RETURNING workflow_run_id, generation, claim_token, lease_expires_at
)
UPDATE workflow_runs AS wr
SET status = 'running',
    started_at = COALESCE(wr.started_at, NOW()),
    completed_at = NULL,
    updated_at = NOW()
FROM leased
WHERE wr.id = leased.workflow_run_id
RETURNING wr.id, wr.repository_id, wr.workflow_definition_id, wr.trigger_ref,
    wr.trigger_commit_sha, wr.trigger_event, leased.claim_token::uuid AS claim_token,
    leased.generation::bigint AS claim_generation, leased.lease_expires_at::timestamptz AS claim_lease_expires_at;

-- name: RenewSandboxWorkflowRunClaim :one
-- Extend a live lease. No row means the token or generation no longer owns a
-- running sandbox-plane run, or the lease expired: an expired lease is
-- reclaimable and never revived.
UPDATE workflow_sandbox_claims AS claim
SET claimed_at = NOW(),
    lease_expires_at = NOW() + INTERVAL '2 minutes'
WHERE claim.workflow_run_id = sqlc.arg(workflow_run_id)
  AND claim.claim_token = sqlc.arg(claim_token)::uuid
  AND claim.generation = sqlc.arg(claim_generation)::bigint
  AND claim.lease_expires_at > NOW()
  AND EXISTS (
    SELECT 1
    FROM workflow_runs AS wr
    WHERE wr.id = claim.workflow_run_id
      AND wr.execution_plane = 'sandbox'
      AND wr.status = 'running'
  )
RETURNING claim.lease_expires_at::timestamptz;

-- name: FinishClaimedSandboxWorkflowRun :one
-- Write a scheduler outcome only while the caller's token and generation own
-- the run. The terminal guard trigger reads the claim from the transaction
-- settings and the invalidation trigger clears the lease. No row means a
-- cancel, resume, newer owner, or lease expiry took the run.
WITH claim_context AS MATERIALIZED (
    SELECT
      set_config('smithers.workflow_sandbox_claim_token', sqlc.arg(claim_token)::text, true) AS claim_token,
      set_config('smithers.workflow_sandbox_claim_generation', (sqlc.arg(claim_generation)::bigint)::text, true) AS claim_generation
)
UPDATE workflow_runs AS wr
SET status = sqlc.arg(status)::text,
    completed_at = NOW(),
    updated_at = NOW()
FROM workflow_sandbox_claims AS claim, claim_context
WHERE wr.id = sqlc.arg(workflow_run_id)
  AND sqlc.arg(status)::text IN ('success', 'failure')
  AND wr.status = 'running'
  AND wr.execution_plane = 'sandbox'
  AND claim.workflow_run_id = wr.id
  AND claim.claim_token = sqlc.arg(claim_token)::uuid
  AND claim.generation = sqlc.arg(claim_generation)::bigint
  AND claim.lease_expires_at > NOW()
RETURNING wr.*;
