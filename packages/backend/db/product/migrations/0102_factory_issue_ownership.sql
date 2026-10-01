-- The existing product Flow admission is the only acquisition transaction.
-- No declaration, dispatch-worker lease or timeout transfers execution ownership.
CREATE TABLE factory_issue_claims (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 repository_id bigint NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
 issue_number bigint NOT NULL CHECK (issue_number>0),
 owner_kind text NOT NULL CHECK (owner_kind IN ('mythical','repository-job','ambiguous')),
 owner_id text NOT NULL CHECK (owner_id<>''),
 approved_digest text NOT NULL CHECK (approved_digest<>''),
 authority jsonb NOT NULL CHECK (jsonb_typeof(authority)='object'),
 operation_id uuid REFERENCES product_job_requests(id) DEFERRABLE INITIALLY DEFERRED,
 claimed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 released_at timestamptz,
 release_reason text NOT NULL DEFAULT '',
 CHECK ((released_at IS NULL)=(release_reason=''))
);
CREATE UNIQUE INDEX factory_issue_one_owner ON factory_issue_claims(repository_id,issue_number) WHERE released_at IS NULL;
CREATE INDEX factory_issue_owner_identity ON factory_issue_claims(owner_kind,owner_id,claimed_at DESC);

-- A completed product admission or a bridge error is not a terminal run.
-- Only canonical terminal observation or proven cancellation before any launch
-- permits a handoff. Unknown external attempts stay fenced indefinitely.
CREATE FUNCTION factory_issue_operation_finished(operation uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT COALESCE((
  SELECT (d.external_receipt->'run'->>'status' IN ('completed','failed','cancelled')
    AND d.external_receipt->>'runId'<>''
    AND d.external_receipt->'run'->>'runId'=d.external_receipt->>'runId')
   OR (r.state='cancelled' AND r.terminal_receipt->>'kind'='cancelled-before-runtime-launch'
       AND COALESCE(d.external_receipt->>'runId','')='')
   OR (r.state='failed' AND d.external_started_at IS NULL AND COALESCE(d.external_receipt->>'runId','')='')
  FROM product_job_requests r JOIN product_job_dispatches d ON d.operation_id=r.id WHERE r.id=$1 AND r.operation='flow.runtime.launch'
 ),false)
$$;

CREATE FUNCTION factory_issue_claim_request(request product_job_requests, upgrading boolean DEFAULT false)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
 repo bigint; number bigint; kind text; identity text; digest text; pinned jsonb;
 item mythical_items%ROWTYPE;
 dispatch repository_job_dispatches%ROWTYPE;
 registration repository_job_registrations%ROWTYPE;
 held factory_issue_claims%ROWTYPE;
BEGIN
 IF request.operation NOT IN ('flow.runtime.launch','flow.runtime.signal') THEN RETURN; END IF;
 -- Replayed admission joins its original operation; never repoint a claim at
 -- an excluded INSERT's new UUID before the jobs store checks its fingerprint.
 IF NOT upgrading AND EXISTS(SELECT 1 FROM product_job_requests r WHERE
   (r.tenant_id,r.principal_id,r.operation,r.request_id)=
   (request.tenant_id,request.principal_id,request.operation,request.request_id)) THEN RETURN; END IF;
 IF request.payload->'target'->>'BindingKind'='mythical-item' THEN
  IF request.operation<>'flow.runtime.launch' THEN RETURN; END IF;
  SELECT * INTO item FROM mythical_items WHERE id::text=request.payload->'target'->>'BindingID' FOR SHARE;
  IF NOT FOUND OR item.source<>'issue' OR item.issue_number IS NULL THEN RETURN; END IF;
  repo:=item.repository_id;number:=item.issue_number;kind:='mythical';identity:=item.id::text;digest:=item.approved_digest;
  IF NOT upgrading AND (digest='' OR digest<>item.issue_digest
    OR request.authorization_context->>'generation' IS DISTINCT FROM item.generation::text
    OR NOT EXISTS(SELECT 1 FROM mythical_stacks s WHERE s.repository_id=repo AND s.actor_user_id::text=request.authorization_context->>'userId')
    OR request.authorization_context->>'itemId' IS DISTINCT FROM identity
    OR request.authorization_context->>'repositoryId' IS DISTINCT FROM repo::text
    OR request.authorization_context->>'workspaceId' IS DISTINCT FROM item.workspace_id
    OR request.tenant_id IS DISTINCT FROM 'repository:'||repo::text
    OR request.principal_id IS DISTINCT FROM 'user:'||(request.authorization_context->>'userId')
    OR request.payload->'target'->>'WorkspaceID' IS DISTINCT FROM item.workspace_id) THEN
   RAISE EXCEPTION 'factory issue admission identity is invalid' USING ERRCODE='P2082';
  END IF;
  pinned:=jsonb_build_object('authorization',request.authorization_context,'target',request.payload->'target');
 ELSIF request.payload->'target'->>'BindingKind'='repository-job-dispatch' THEN
  SELECT * INTO dispatch FROM repository_job_dispatches WHERE id::text=request.payload->'target'->>'BindingID' FOR SHARE;
  IF NOT FOUND OR dispatch.issue_number<=0 OR dispatch.source<>'github'
     OR dispatch.payload->'issue' IS NULL THEN RETURN; END IF;
  SELECT * INTO registration FROM repository_job_registrations WHERE id=dispatch.registration_id FOR SHARE;
  IF NOT FOUND THEN RETURN; END IF;
  -- Only the canonical repository factory or an explicit implementation TODO
  -- participates. Ordinary registrations and schedules keep their behavior.
  IF registration.mode<>'enabled' OR lower(btrim(COALESCE(registration.configuration->>'label','')))<>'todo'
     OR dispatch.event_type NOT IN ('issue','issues','issue_comment') THEN RETURN; END IF;
  repo:=registration.repository_id;number:=dispatch.issue_number;kind:='repository-job';identity:=dispatch.id;
  digest:=encode(sha256(convert_to(COALESCE(dispatch.payload->'issue'->>'title',''),'UTF8')||decode('00','hex')||convert_to(COALESCE(dispatch.payload->'issue'->>'body',''),'UTF8')),'hex');
  IF NOT upgrading AND (NOT registration.enabled OR registration.revision<>dispatch.revision OR registration.digest<>dispatch.digest
    OR dispatch.payload->'issue'->>'title' IS NULL
    OR request.authorization_context->>'dispatchId' IS DISTINCT FROM identity
    OR request.authorization_context->>'registrationId' IS DISTINCT FROM registration.id::text
    OR request.authorization_context->>'revision' IS DISTINCT FROM dispatch.revision::text
    OR request.authorization_context->>'digest' IS DISTINCT FROM dispatch.digest
    OR request.authorization_context->>'repositoryId' IS DISTINCT FROM repo::text
    OR request.authorization_context->>'userId' IS DISTINCT FROM registration.user_id::text
    OR request.authorization_context->>'workspaceId' IS DISTINCT FROM registration.workspace_id::text
    OR request.tenant_id IS DISTINCT FROM 'repository:'||repo::text OR request.principal_id IS DISTINCT FROM 'user:'||registration.user_id::text
    OR request.payload->'target'->>'WorkspaceID' IS DISTINCT FROM registration.workspace_id::text
    OR request.payload->>'flowId' IS DISTINCT FROM registration.flow_id) THEN
   RAISE EXCEPTION 'factory issue admission identity is invalid' USING ERRCODE='P2082';
  END IF;
  -- Mutable rows can no longer supply authority for a previously admitted run.
  -- A mismatched legacy row is retained as unknown, never fabricated authority.
  pinned:=jsonb_build_object('authorization',request.authorization_context,'target',request.payload->'target');
  IF registration.revision=dispatch.revision AND registration.digest=dispatch.digest
    AND request.authorization_context->>'userId'=registration.user_id::text
    AND request.authorization_context->>'workspaceId'=registration.workspace_id::text THEN
   pinned:=pinned||jsonb_build_object('registration',to_jsonb(registration));
  END IF;
 ELSE RETURN; END IF;
 IF NOT upgrading AND (request.payload->'target'->>'TenantID' IS DISTINCT FROM request.tenant_id
   OR request.payload->'target'->>'PrincipalID' IS DISTINCT FROM request.principal_id) THEN
  RAISE EXCEPTION 'factory issue target scope is invalid' USING ERRCODE='P2082';
 END IF;
 IF COALESCE(digest,'')='' THEN digest:='unknown'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('factory-issue:'||repo::text||':'||number::text,0));
 SELECT * INTO held FROM factory_issue_claims WHERE repository_id=repo AND issue_number=number AND released_at IS NULL FOR UPDATE;
 IF request.operation='flow.runtime.signal' THEN
  -- A reply is a distinct operation, never a fresh owner. Only the exact
  -- current registration that admitted the original live run may add it.
  -- Retain its operation separately so later replacement can only reconcile
  -- this already attempted mutation, not grant a new one.
  IF held.id IS NULL OR held.owner_kind<>'repository-job'
    OR ((held.authority->'registration') - ARRAY['created_at','updated_at','activated_at','next_fire_at'])
       IS DISTINCT FROM ((pinned->'registration') - ARRAY['created_at','updated_at','activated_at','next_fire_at'])
    OR factory_issue_operation_finished(held.operation_id)
    OR NOT EXISTS(SELECT 1 FROM product_job_dispatches d WHERE d.operation_id=held.operation_id
      AND d.external_receipt->>'runId'<>'' AND d.external_receipt->>'runId'=request.payload->>'runId') THEN
   RAISE EXCEPTION 'factory issue reply authority changed or its original run is unavailable' USING ERRCODE='P2082';
  END IF;
  IF EXISTS(SELECT 1 FROM product_job_requests p JOIN product_job_dispatches d ON d.operation_id=p.id
    WHERE p.id::text=held.authority->'continuations'->identity->>'operationId'
     AND NOT(p.state='completed' OR (p.state='failed' AND d.external_receipt->>'failureCode'='no_matching_wait'))) THEN
   RAISE EXCEPTION 'the original reply operation is still active' USING ERRCODE='P2082';
  END IF;
  UPDATE factory_issue_claims SET authority=jsonb_set(authority,'{continuations}',
   COALESCE(authority->'continuations','{}'::jsonb)||jsonb_build_object(identity,
    jsonb_build_object('operationId',request.id,'registration',pinned->'registration')))
   WHERE id=held.id;
  RETURN;
 END IF;
 IF held.id IS NOT NULL AND held.owner_kind<>'ambiguous' AND factory_issue_operation_finished(held.operation_id)
   AND (held.owner_kind='repository-job' OR EXISTS(SELECT 1 FROM mythical_items m WHERE m.id::text=held.owner_id
        AND (m.state IN ('landed','declined','cancelled','rejected','skipped')
          OR (kind='mythical' AND identity=held.owner_id AND digest<>held.approved_digest
            AND m.generation>COALESCE((held.authority->'authorization'->>'generation')::bigint,m.generation)))
        AND NOT EXISTS(SELECT 1 FROM product_job_requests p WHERE p.operation='flow.runtime.launch'
          AND p.payload->'target'->>'BindingKind'='mythical-item' AND p.payload->'target'->>'BindingID'=held.owner_id
          AND NOT factory_issue_operation_finished(p.id)))) THEN
  UPDATE factory_issue_claims SET released_at=clock_timestamp(),release_reason='canonical terminal handoff' WHERE id=held.id;
  held:=NULL;
 END IF;
 IF held.id IS NOT NULL AND (held.owner_kind<>kind OR held.owner_id<>identity OR held.approved_digest<>digest) THEN
  IF upgrading THEN
   -- Preserve every ambiguous premigration owner. Never elect a winner from
   -- an ambiguous run or reinterpret a never-admitted queued follower as one.
   UPDATE factory_issue_claims SET owner_kind='ambiguous',owner_id='migration-conflict',
    authority=jsonb_build_object('owners',COALESCE(held.authority->'owners',jsonb_build_array(to_jsonb(held)))
     ||jsonb_build_array(jsonb_build_object('owner_kind',kind,'owner_id',identity,'approved_digest',digest,'authority',pinned,'operation_id',request.id)))
    WHERE id=held.id;
   RETURN;
  END IF;
  RAISE EXCEPTION 'factory issue is owned' USING ERRCODE='P2081',
   DETAIL=jsonb_build_object('claimId',held.id,'ownerKind',held.owner_kind,'ownerId',held.owner_id,'approvedDigest',held.approved_digest)::text;
 END IF;
 IF held.id IS NULL THEN
  INSERT INTO factory_issue_claims(repository_id,issue_number,owner_kind,owner_id,approved_digest,authority,operation_id)
   VALUES(repo,number,kind,identity,digest,pinned,request.id);
 ELSE
  UPDATE factory_issue_claims SET operation_id=request.id,
   authority=CASE WHEN kind='mythical' THEN pinned ELSE authority END WHERE id=held.id;
 END IF;
END
$$;

-- Backfill actual canonical admissions, including accepted/uncertain ones and
-- externally attempted failures. Dispatch rows without a launch are followers,
-- not owners. This also fences a premigration worker still holding its claim.
DO $$
DECLARE request product_job_requests%ROWTYPE;
BEGIN
 FOR request IN SELECT * FROM product_job_requests p WHERE p.operation='flow.runtime.launch'
  AND (NOT factory_issue_operation_finished(p.id) OR EXISTS(SELECT 1 FROM mythical_items m WHERE m.id::text=p.payload->'target'->>'BindingID'
   AND p.payload->'target'->>'BindingKind'='mythical-item' AND m.state NOT IN ('landed','declined','cancelled','rejected','skipped'))) ORDER BY p.created_at,p.id LOOP
  PERFORM factory_issue_claim_request(request,true);
 END LOOP;
END
$$;
CREATE FUNCTION factory_issue_admission_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN PERFORM factory_issue_claim_request(NEW); RETURN NEW; END
$$;
CREATE TRIGGER factory_issue_admission_guard BEFORE INSERT ON product_job_requests
 FOR EACH ROW EXECUTE FUNCTION factory_issue_admission_guard();
