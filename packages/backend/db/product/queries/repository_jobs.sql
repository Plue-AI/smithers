-- name: RegisterRepositoryJob :one
WITH registered AS (
  INSERT INTO repository_job_registrations
    (repository_id, workspace_id, user_id, job, mode, revision, digest, source_revision,
     flow_id, configuration, enabled, trial_issue_number, trial_source, schedule, next_fire_at)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true,$11,$12,$13,sqlc.narg(next_fire_at))
  ON CONFLICT (repository_id,job,mode) DO UPDATE SET
    workspace_id=EXCLUDED.workspace_id, user_id=EXCLUDED.user_id,
    revision=EXCLUDED.revision, digest=EXCLUDED.digest, source_revision=EXCLUDED.source_revision,
    flow_id=EXCLUDED.flow_id, configuration=EXCLUDED.configuration, enabled=true,
    trial_issue_number=EXCLUDED.trial_issue_number, trial_source=EXCLUDED.trial_source,
    schedule=EXCLUDED.schedule,
    next_fire_at=CASE WHEN repository_job_registrations.revision=EXCLUDED.revision
      THEN repository_job_registrations.next_fire_at ELSE EXCLUDED.next_fire_at END,
    activated_at=CASE WHEN repository_job_registrations.revision=EXCLUDED.revision
      THEN repository_job_registrations.activated_at ELSE now() END,
    updated_at=now()
  WHERE repository_job_registrations.revision < EXCLUDED.revision OR
    (repository_job_registrations.revision=EXCLUDED.revision AND repository_job_registrations.enabled
     AND repository_job_registrations.digest=EXCLUDED.digest
     AND repository_job_registrations.configuration=EXCLUDED.configuration
     AND repository_job_registrations.source_revision=EXCLUDED.source_revision
     AND repository_job_registrations.flow_id=EXCLUDED.flow_id
     AND repository_job_registrations.workspace_id=EXCLUDED.workspace_id
     AND repository_job_registrations.user_id=EXCLUDED.user_id)
  RETURNING *
), retired_trial AS (
  UPDATE repository_job_registrations SET enabled=false,updated_at=now()
  WHERE mode='trial' AND repository_id=$1 AND job=$4 AND $5='enabled'
    AND EXISTS (SELECT 1 FROM registered)
)
SELECT * FROM registered;

-- name: GetRepositoryJobRegistration :one
SELECT * FROM repository_job_registrations WHERE id=$1;

-- name: ListRepositoryJobRegistrations :many
SELECT * FROM repository_job_registrations WHERE repository_id=$1 ORDER BY job,mode;

-- name: PauseRepositoryJob :many
-- A person's pause drops the factory refusal mark, so approval never undoes it.
UPDATE repository_job_registrations SET enabled=false, configuration=configuration - 'factory_unapproved' - 'factory_owner_suspended', updated_at=now()
WHERE repository_id=$1 AND job=$2 RETURNING *;

-- name: ListRepositoryJobDispatchesForCancellation :many
SELECT d.* FROM repository_job_dispatches d
JOIN repository_job_registrations r ON r.id=d.registration_id
WHERE r.repository_id=$1 AND r.job=$2 AND d.status IN ('waiting','submitted')
ORDER BY d.created_at,d.id;

-- name: AdmitRepositoryJobEvent :exec
INSERT INTO repository_job_events
  (repository_id,delivery_key,source,event_type,event_action,issue_number,payload)
VALUES ($1,$2,$3,$4,$5,$6,$7)
ON CONFLICT (repository_id,delivery_key) DO NOTHING;

-- name: ListRepositoryJobAdmissions :many
SELECT sqlc.embed(r), sqlc.embed(e)
FROM repository_job_registrations r JOIN repository_job_events e ON e.repository_id=r.repository_id
WHERE r.enabled
  AND NOT EXISTS (SELECT 1 FROM repository_job_comments c
    JOIN repository_job_dispatches original ON original.id=c.dispatch_id
    JOIN repository_job_registrations origin ON origin.id=original.registration_id
    WHERE e.source='smithers-cloud' AND e.event_type='issue_comment'
      AND origin.repository_id=r.repository_id AND origin.job=r.job
      AND e.payload->'comment'->>'id'=c.comment_id::text)
  AND ((r.mode='trial' AND e.issue_number=r.trial_issue_number AND e.source=r.trial_source)
    OR (r.mode='enabled' AND e.received_at>=r.activated_at
      AND NOT EXISTS (SELECT 1 FROM repository_job_trials trial
        WHERE e.source='smithers-cloud' AND trial.repository_id=r.repository_id
          AND trial.job=r.job AND trial.issue_number=e.issue_number)
      AND NOT EXISTS (SELECT 1 FROM repository_job_registrations t
        WHERE t.repository_id=r.repository_id AND t.job=r.job AND t.mode='trial' AND t.enabled
          AND t.trial_issue_number=e.issue_number AND t.trial_source=e.source)))
  AND NOT EXISTS (SELECT 1 FROM repository_job_dispatches d
    WHERE d.registration_id=r.id AND d.revision=r.revision AND d.delivery_key=e.delivery_key)
ORDER BY e.received_at,e.id,r.id LIMIT $1;

-- name: EnqueueRepositoryJobDispatch :exec
INSERT INTO repository_job_dispatches
  (registration_id,revision,digest,delivery_key,source,event_type,event_action,issue_number,payload,status)
SELECT r.id,r.revision,r.digest,$3,$4,$5,$6,$7,$8,$9 FROM repository_job_registrations r
WHERE r.id=$1 AND r.revision=$2 AND r.enabled
ON CONFLICT (registration_id,revision,delivery_key) DO NOTHING;

-- name: SkipRetiredRepositoryJobDispatches :exec
UPDATE repository_job_dispatches d SET status='skipped',error='Registration was paused or replaced',updated_at=now()
FROM repository_job_registrations r WHERE r.id=d.registration_id
  AND (NOT r.enabled OR r.revision<>d.revision)
  AND (d.status IN ('queued','waiting') OR (d.status='dispatching' AND d.lease_until<now()));

-- name: ClaimRepositoryJobDispatches :many
WITH picked AS (
 SELECT d.id FROM repository_job_dispatches d
 JOIN repository_job_registrations r ON r.id=d.registration_id
 WHERE r.enabled AND r.revision=d.revision AND d.next_attempt_at<=now()
   AND (d.status IN ('queued','waiting') OR (d.status='dispatching' AND d.lease_until<now()))
   AND NOT EXISTS (SELECT 1 FROM repository_job_dispatches earlier
     WHERE earlier.registration_id=d.registration_id AND earlier.revision=d.revision
       AND earlier.issue_number=d.issue_number AND earlier.source=d.source
       AND earlier.status IN ('queued','dispatching','waiting')
       AND (earlier.created_at,earlier.id)<(d.created_at,d.id))
 ORDER BY d.created_at,d.id LIMIT $1 FOR UPDATE OF d SKIP LOCKED
)
UPDATE repository_job_dispatches d SET status='dispatching',claim_token=gen_random_uuid(),
  lease_until=now()+interval '2 minutes',attempts=attempts+1,updated_at=now()
FROM picked WHERE d.id=picked.id RETURNING d.*;

-- name: GetRepositoryJobDispatch :one
SELECT * FROM repository_job_dispatches WHERE id=$1;

-- name: SaveRepositoryJobPlan :execrows
UPDATE repository_job_dispatches SET plan=$3,updated_at=now()
WHERE id=$1 AND claim_token=$2 AND status='dispatching';

-- name: SettleRepositoryJobDispatch :execrows
UPDATE repository_job_dispatches SET status=$3,run_id=$4,receipt=$5,error=$6,
  next_attempt_at=$7,claim_token=NULL,lease_until=NULL,updated_at=now()
WHERE id=$1 AND claim_token=$2 AND status='dispatching';

-- name: ProjectRepositoryJobDispatch :execrows
UPDATE repository_job_dispatches SET status=$2,run_id=$3,plan=$4,receipt=$5,error=$6,
  next_attempt_at=$7,claim_token=NULL,lease_until=NULL,updated_at=now()
WHERE id=$1 AND status<>'dispatching';

-- name: ProjectRepositoryJobSignal :execrows
UPDATE repository_job_dispatches SET status=$2,run_id=$3,plan=$4,receipt=$5,error=$6,
  next_attempt_at=$7,claim_token=NULL,lease_until=NULL,updated_at=now()
WHERE id=$1 AND status='waiting' AND signal_attempt=sqlc.arg(expected_signal_attempt)
  AND receipt->>'operationId'=sqlc.arg(expected_operation_id)::text;

-- name: RetryRepositoryJobSignal :execrows
UPDATE repository_job_dispatches SET status='waiting',signal_attempt=signal_attempt+1,
  run_id=$3,receipt='{"_tag":"NoMatchingWait"}'::jsonb,error='Waiting for the issue flow to accept the reply',
  next_attempt_at=$4,claim_token=NULL,lease_until=NULL,updated_at=now()
WHERE id=$1 AND claim_token=$2 AND status='dispatching';

-- name: RetryProjectedRepositoryJobSignal :execrows
UPDATE repository_job_dispatches SET status='waiting',signal_attempt=signal_attempt+1,
  receipt=$2,error='Waiting for the issue flow to accept the reply',next_attempt_at=$3,
  claim_token=NULL,lease_until=NULL,updated_at=now()
WHERE id=$1 AND status='waiting' AND signal_attempt=sqlc.arg(expected_signal_attempt)
  AND receipt->>'operationId'=sqlc.arg(expected_operation_id)::text;

-- name: LatestRepositoryJobIssueRun :one
SELECT * FROM repository_job_dispatches
WHERE registration_id=$1 AND revision=$2 AND source=$3 AND issue_number=$4
  AND status='submitted' AND run_id<>''
ORDER BY created_at DESC,id DESC LIMIT 1;

-- name: RepositoryJobCommentAlreadyTaken :one
-- A mention rule takes one comment text once per issue: a second comment
-- with the same text proposes nothing new.
SELECT EXISTS (SELECT 1 FROM repository_job_dispatches
  WHERE registration_id=$1 AND source=$2 AND issue_number=$3
    AND event_type='issue_comment' AND status<>'skipped'
    AND btrim(payload->'comment'->>'body',E' \t\r\n')=btrim(sqlc.arg(body)::text,E' \t\r\n'));

-- name: ListRepositoryJobDispatches :many
SELECT d.* FROM repository_job_dispatches d
JOIN repository_job_registrations r ON r.id=d.registration_id
WHERE r.repository_id=$1 AND r.job=$2
ORDER BY d.created_at DESC,d.id DESC LIMIT 50;

-- name: ListDueRepositoryJobSchedules :many
SELECT * FROM repository_job_registrations
WHERE enabled AND mode='enabled' AND schedule<>'' AND next_fire_at<=now()
AND NOT EXISTS (SELECT 1 FROM provider_connections p WHERE p.user_id=repository_job_registrations.user_id AND p.owner_type='user' AND p.state='active' AND p.used_percent>=60)
ORDER BY next_fire_at,id LIMIT $1;

-- name: AdvanceRepositoryJobSchedule :execrows
UPDATE repository_job_registrations SET next_fire_at=$4,updated_at=now()
WHERE id=$1 AND revision=$2 AND enabled AND next_fire_at=$3;

-- name: LockRepositoryJobTrial :exec
SELECT pg_advisory_xact_lock(hashtextextended('repository_job_trial:' || sqlc.arg(repository_id)::bigint::text || ':' || sqlc.arg(job)::text || ':' || sqlc.arg(request_id)::text,0));

-- name: GetRepositoryJobTrial :one
SELECT * FROM repository_job_trials WHERE repository_id=$1 AND job=$2 AND request_id=$3;

-- name: CreateRepositoryJobTrial :one
INSERT INTO repository_job_trials
  (repository_id,job,request_id,workspace_id,user_id,revision,digest,title,body,issue_id,issue_number)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *;

-- name: GetRepositoryJobCommentDispatch :one
SELECT sqlc.embed(r),sqlc.embed(d)
FROM repository_job_registrations r JOIN repository_job_dispatches d ON d.registration_id=r.id
WHERE r.repository_id=$1 AND r.job=$2 AND d.revision=$3 AND d.digest=$4
  AND d.delivery_key=$5 AND d.source=$6 AND d.issue_number=$7
ORDER BY r.mode DESC LIMIT 1 FOR SHARE OF r;

-- name: LockRepositoryJobComment :exec
SELECT pg_advisory_xact_lock(hashtextextended('repository_job_comment:' || sqlc.arg(dispatch_id)::text || ':' || sqlc.arg(step)::text,0));

-- name: GetRepositoryJobComment :one
SELECT * FROM repository_job_comments WHERE dispatch_id=$1 AND step=$2;

-- name: CreateRepositoryJobComment :one
INSERT INTO repository_job_comments(dispatch_id,step,body,comment_id)
VALUES ($1,$2,$3,$4) RETURNING *;

-- name: ListRepositoryGitHubSources :many
-- Prefer the current sync registry (which follows GitHub renames); fall back
-- to immutable successful import provenance bound to this exact native repo.
WITH current_source AS (
  SELECT g.owner_login::text AS github_owner,g.repo_name::text AS github_repo
  FROM repositories r
  LEFT JOIN users u ON u.id=r.user_id
  LEFT JOIN organizations o ON o.id=r.org_id
  JOIN github_synced_repos g ON LOWER(g.mirror_owner)=LOWER(COALESCE(u.username,o.name))
    AND LOWER(g.mirror_repo)=r.lower_name AND g.sync_state<>'disabled'
  WHERE r.id=$1
), imported_source AS (
  SELECT github_owner::text,github_repo::text FROM import_jobs
  WHERE repository_id=$1 AND status='ready'
  ORDER BY created_at DESC,id DESC LIMIT 1
)
SELECT DISTINCT github_owner,github_repo FROM current_source
UNION
SELECT github_owner,github_repo FROM imported_source WHERE NOT EXISTS (SELECT 1 FROM current_source);

-- name: LockRepositoryJobManual :exec
SELECT pg_advisory_xact_lock(hashtextextended('repository_job_manual:' || sqlc.arg(repository_id)::bigint::text || ':' || sqlc.arg(job)::text || ':' || sqlc.arg(request_id)::text,0));

-- name: GetRepositoryJobManualDispatch :one
SELECT sqlc.embed(r),sqlc.embed(d)
FROM repository_job_registrations r JOIN repository_job_dispatches d ON d.registration_id=r.id
WHERE r.repository_id=$1 AND r.job=$2 AND d.delivery_key=$3 AND d.event_type='manual'
ORDER BY d.created_at,d.id LIMIT 1 FOR SHARE OF r;

-- name: GetEnabledRepositoryJobForManual :one
SELECT * FROM repository_job_registrations
WHERE repository_id=$1 AND job=$2 AND mode='enabled' AND enabled
FOR SHARE;

-- name: GetRepositoryJobNativeIssueSubject :one
SELECT repository_job_native_issue_payload(i)::jsonb AS payload
FROM issues i WHERE i.kind <> 'chat' AND i.repository_id=$1 AND i.number=$2;

-- name: GetRepositoryJobGitHubSubject :one
SELECT i.payload FROM github_synced_repos g JOIN github_synced_issues i ON i.synced_repo_id=g.id
WHERE g.owner_login_lower=LOWER(sqlc.arg(github_owner)::text)
  AND g.repo_name_lower=LOWER(sqlc.arg(github_repo)::text) AND g.sync_state<>'disabled'
  AND i.resource=sqlc.arg(resource)::text AND i.number=sqlc.arg(number);

-- name: GetRepositoryCiLandingPolicy :one
-- Deliberately not filtered on enabled: PauseRepositoryJob keeps the row, so
-- pausing CI keeps the landing protection it registered.
SELECT id, revision, digest, workspace_id, configuration
FROM repository_job_registrations
WHERE repository_id = $1 AND job = 'ci' AND mode = 'enabled';

-- name: LockRepositoryCiCheckReceipt :exec
SELECT pg_advisory_xact_lock(hashtextextended('repository_ci_check_receipt:' || sqlc.arg(registration_id)::text || ':' || sqlc.arg(request_id)::text,0));

-- name: GetRepositoryCiCheckReceipt :one
SELECT * FROM repository_ci_check_receipts WHERE registration_id=$1 AND request_id=$2;

-- name: CreateRepositoryCiCheckReceipt :one
INSERT INTO repository_ci_check_receipts
  (repository_id,registration_id,revision,digest,execution_digest,workspace_id,run_id,execution_id,
   commit_sha,change_id,base_commit_sha,checks,context,commit_status_id,request_id)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *;

-- name: GetRepositoryCiDispatchRunStatus :one
-- The receipt must name a run retained for this repository and workspace. A
-- usable dispatch is preferred over a retired one for the same run.
SELECT d.status FROM repository_job_dispatches d
JOIN repository_job_registrations r ON r.id=d.registration_id
WHERE r.repository_id=$1 AND r.workspace_id=$2 AND d.run_id=sqlc.arg(run_id)::text
ORDER BY (d.status IN ('failed','skipped')), d.created_at DESC, d.id DESC LIMIT 1;

-- name: UpsertRepositoryJobApproval :one
-- approved_by and approved_at come from the authenticated session and now();
-- no request field can name either of them.
INSERT INTO repository_job_approvals
  (repository_id,job,plan_digest,plan_id,flow_id,envelope,approved_by)
VALUES ($1,$2,$3,$4,$5,$6,$7)
ON CONFLICT (repository_id,job,plan_digest) DO UPDATE SET
  plan_id=EXCLUDED.plan_id, flow_id=EXCLUDED.flow_id, envelope=EXCLUDED.envelope,
  approved_by=EXCLUDED.approved_by, approved_at=now()
RETURNING *;

-- name: GetRepositoryJobApproval :one
SELECT * FROM repository_job_approvals
WHERE repository_id=$1 AND job=$2 AND plan_digest=$3;

-- name: ListRepositoryJobApprovals :many
SELECT * FROM repository_job_approvals
WHERE repository_id=$1 AND job=$2 ORDER BY approved_at DESC LIMIT 50;

-- name: PersonPressedRepositoryTrial :one
-- Whether the person pressed Trial in exactly this setup request (its
-- request id is the trial's), for this candidate, trial text and box, and
-- the request is still running. Only a person reaches the setup trial route
-- (person_trial_press), so a match is that person's own filing of the
-- trial issue.
SELECT EXISTS (
    SELECT 1 FROM repository_setup_requests
    WHERE repository_id = sqlc.arg(repository_id) AND user_id = sqlc.arg(user_id) AND job = sqlc.arg(job)
      AND request_id = sqlc.arg(request_id)::text
      AND person_trial_press AND NOT terminal
      AND (workspace_id IS NULL OR workspace_id = sqlc.arg(workspace_id)::uuid)
      AND input->>'operation' = 'trial'
      AND input->>'revision' = sqlc.arg(revision)::bigint::text
      AND input->>'digest' = sqlc.arg(digest)::text
      AND input->'draft'->>'trialTitle' = sqlc.arg(title)::text
      AND COALESCE(input->'draft'->>'trialBody', '') = sqlc.arg(body)::text
)::boolean;
