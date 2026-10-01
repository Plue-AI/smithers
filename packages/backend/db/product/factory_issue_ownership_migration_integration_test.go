package product

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/stretchr/testify/require"
)

func TestFactoryIssueOwnershipMigrationPreservesAmbiguousOwnersAndFollowers(t *testing.T) {
	pool := reviewDatabase(t, 101)
	ctx := context.Background()
	repo := reviewRepo(t, pool)
	workspace := uuid.NewString()
	_, err := pool.Exec(ctx, `INSERT INTO workspaces(id,repository_id,user_id,status) VALUES($1,$2,1,'running')`, workspace, repo)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO mythical_stacks(repository_id,actor_user_id,state) VALUES($1,1,'active')`, repo)
	require.NoError(t, err)
	store, err := jobs.NewStore(pool)
	require.NoError(t, err)
	dispatcher, err := flowdispatch.New(flowdispatch.Config{Store: store, Resolver: flowruntime.ResolverFunc(func(context.Context, flowruntime.Target) (flowruntime.Runtime, error) {
		return nil, errors.New("migration must never start runtime")
	})})
	require.NoError(t, err)
	scope := jobs.Scope{TenantID: fmt.Sprintf("repository:%d", repo), PrincipalID: "user:1"}
	role := func(number int, job string, admit bool) string {
		t.Helper()
		registration, dispatch := uuid.NewString(), uuid.NewString()
		_, e := pool.Exec(ctx, `INSERT INTO repository_job_registrations(id,repository_id,workspace_id,user_id,job,mode,revision,digest,source_revision,flow_id,configuration,enabled) VALUES($1,$2,$3,1,$4,'enabled',1,'owner-digest',$5,'engineering','{"label":"todo"}',true)`, registration, repo, workspace, job, strings.Repeat("a", 40))
		require.NoError(t, e)
		_, e = pool.Exec(ctx, `INSERT INTO repository_job_dispatches(id,registration_id,revision,digest,delivery_key,source,event_type,event_action,issue_number,payload,status) VALUES($1::uuid,$2::uuid,1,'owner-digest',$1::text,'github','issues','labeled',$3,'{"issue":{"title":"issue","body":"approved"}}','queued')`, dispatch, registration, number)
		require.NoError(t, e)
		if !admit {
			return ""
		}
		auth, _ := json.Marshal(map[string]any{"repositoryId": repo, "userId": 1, "workspaceId": workspace, "registrationId": registration, "dispatchId": dispatch, "revision": 1, "digest": "owner-digest"})
		receipt, e := dispatcher.Admit(ctx, flowdispatch.LaunchRequest{Scope: scope, RequestID: dispatch, Target: flowruntime.Target{WorkspaceID: workspace, BindingKind: "repository-job-dispatch", BindingID: dispatch}, FlowID: "engineering", Payload: json.RawMessage(`{}`), AuthorizationContext: auth})
		require.NoError(t, e)
		return receipt.OperationID
	}
	mythical := func(number int, terminalPhase bool) string {
		t.Helper()
		item := uuid.NewString()
		_, e := pool.Exec(ctx, `INSERT INTO mythical_items(id,repository_id,issue_number,source,state,workspace_id,generation,issue_digest,approved_digest) VALUES($1,$2,$3,'issue','running',$4,1,'original-approved-text','original-approved-text')`, item, repo, number, workspace)
		require.NoError(t, e)
		auth, _ := json.Marshal(map[string]any{"repositoryId": repo, "userId": 1, "workspaceId": workspace, "itemId": item, "generation": 1})
		receipt, e := dispatcher.Admit(ctx, flowdispatch.LaunchRequest{Scope: scope, RequestID: item, Target: flowruntime.Target{WorkspaceID: workspace, BindingKind: "mythical-item", BindingID: item}, FlowID: "coding/request", Payload: json.RawMessage(`{}`), AuthorizationContext: auth})
		require.NoError(t, e)
		if terminalPhase {
			_, e = pool.Exec(ctx, `UPDATE product_job_requests SET state='completed',terminal_receipt='{}' WHERE id=$1::uuid`, receipt.OperationID)
			require.NoError(t, e)
			_, e = pool.Exec(ctx, `UPDATE product_job_dispatches SET external_receipt='{"runId":"phase","run":{"runId":"phase","status":"completed"}}' WHERE operation_id=$1::uuid`, receipt.OperationID)
			require.NoError(t, e)
		}
		return receipt.OperationID
	}
	old := []string{mythical(100, false), role(100, "issues", true), role(100, "feature", true)}
	mythical(300, true)
	role(400, "review", false)
	require.NoError(t, Apply(ctx, pool))
	require.NoError(t, Apply(ctx, pool), "ledger replay never changes retained owner authority")
	var kind, id string
	var authority []byte
	require.NoError(t, pool.QueryRow(ctx, `SELECT owner_kind,owner_id,authority FROM factory_issue_claims WHERE repository_id=$1 AND issue_number=100`, repo).Scan(&kind, &id, &authority))
	require.Equal(t, "ambiguous", kind)
	require.Equal(t, "migration-conflict", id)
	var retained struct {
		Owners []json.RawMessage `json:"owners"`
	}
	require.NoError(t, json.Unmarshal(authority, &retained))
	require.Len(t, retained.Owners, 3, "retain every actual competing legacy admission")
	for _, operation := range old {
		require.Contains(t, string(authority), operation)
	}
	var claims int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM factory_issue_claims WHERE repository_id=$1`, repo).Scan(&claims))
	require.Equal(t, 2, claims, "active mythical phase gap is owned; never-admitted queued follower is not")
	// Even terminal proofs cannot elect a winner from an ambiguous migration.
	for _, operation := range old {
		_, err = pool.Exec(ctx, `UPDATE product_job_requests SET state='completed',terminal_receipt='{}' WHERE id=$1::uuid`, operation)
		require.NoError(t, err)
		_, err = pool.Exec(ctx, `UPDATE product_job_dispatches SET external_receipt='{"runId":"quiet","run":{"runId":"quiet","status":"completed"}}' WHERE operation_id=$1::uuid`, operation)
		require.NoError(t, err)
	}
	// Replaying canonical admissions must retain their original identity, even
	// when INSERT has a new excluded UUID. Store fingerprints still apply.
	operation, err := store.Get(ctx, scope, old[0])
	require.NoError(t, err)
	receipt, err := store.Admit(ctx, jobs.Admission{Scope: scope, RequestID: operation.RequestID, Operation: operation.Operation, Payload: operation.Payload, AuthorizationContext: operation.AuthorizationContext, EffectPolicy: jobs.EffectReconcile, EffectKey: "flow-runtime:" + operation.RequestID})
	require.NoError(t, err)
	require.Equal(t, operation.ID, receipt.OperationID)
	var originalItem string
	require.NoError(t, pool.QueryRow(ctx, `SELECT id::text FROM mythical_items WHERE repository_id=$1 AND issue_number=100`, repo).Scan(&originalItem))
	auth, _ := json.Marshal(map[string]any{"repositoryId": repo, "userId": 1, "workspaceId": workspace, "itemId": originalItem, "generation": 1})
	_, err = dispatcher.Admit(ctx, flowdispatch.LaunchRequest{Scope: scope, RequestID: "later-phase", Target: flowruntime.Target{WorkspaceID: workspace, BindingKind: "mythical-item", BindingID: originalItem}, FlowID: "coding/request", Payload: json.RawMessage(`{}`), AuthorizationContext: auth})
	var pgerr *pgconn.PgError
	require.ErrorAs(t, err, &pgerr)
	require.Equal(t, "P2081", pgerr.Code)
	require.Contains(t, pgerr.Detail, `"ownerKind": "ambiguous"`)
}

// An admission committed while the schema is upgrading must be included in
// the backfill. Observe the real PostgreSQL relation lock rather than assuming
// that CREATE TRIGGER closes a window after the old admissions were scanned.
func TestFactoryIssueOwnershipMigrationWaitsForInFlightAdmission(t *testing.T) {
	pool := reviewDatabase(t, 101)
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	repo := reviewRepo(t, pool)
	workspace, item := uuid.NewString(), uuid.NewString()
	_, err := pool.Exec(ctx, `INSERT INTO workspaces(id,repository_id,user_id,status) VALUES($1,$2,1,'running')`, workspace, repo)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO mythical_stacks(repository_id,actor_user_id,state) VALUES($1,1,'active')`, repo)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO mythical_items(id,repository_id,issue_number,source,state,workspace_id,generation,issue_digest,approved_digest) VALUES($1,$2,100,'issue','running',$3,1,'approved-text','approved-text')`, item, repo, workspace)
	require.NoError(t, err)
	store, err := jobs.NewStore(pool)
	require.NoError(t, err)
	dispatcher, err := flowdispatch.New(flowdispatch.Config{Store: store, Resolver: flowruntime.ResolverFunc(func(context.Context, flowruntime.Target) (flowruntime.Runtime, error) {
		return nil, errors.New("migration must never start runtime")
	})})
	require.NoError(t, err)
	tx, err := pool.Begin(ctx)
	require.NoError(t, err)
	defer tx.Rollback(context.Background())
	scope := jobs.Scope{TenantID: fmt.Sprintf("repository:%d", repo), PrincipalID: "user:1"}
	auth, err := json.Marshal(map[string]any{"repositoryId": repo, "userId": 1, "workspaceId": workspace, "itemId": item, "generation": 1})
	require.NoError(t, err)
	receipt, err := dispatcher.AdmitInTx(ctx, tx, flowdispatch.LaunchRequest{Scope: scope, RequestID: item, Target: flowruntime.Target{WorkspaceID: workspace, BindingKind: "mythical-item", BindingID: item}, FlowID: "coding/request", Payload: json.RawMessage(`{}`), AuthorizationContext: auth})
	require.NoError(t, err)
	upgraded := make(chan error, 1)
	go func() { upgraded <- Apply(ctx, pool) }()
	require.Eventually(t, func() bool {
		var waiting bool
		err := pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_locks WHERE relation='product_job_requests'::regclass AND NOT granted)`).Scan(&waiting)
		return err == nil && waiting
	}, 5*time.Second, 10*time.Millisecond, "schema upgrade must wait for the uncommitted canonical admission")
	require.NoError(t, tx.Commit(ctx))
	require.NoError(t, <-upgraded)
	var kind, owner, operation string
	require.NoError(t, pool.QueryRow(ctx, `SELECT owner_kind,owner_id,operation_id::text FROM factory_issue_claims WHERE repository_id=$1 AND issue_number=100 AND released_at IS NULL`, repo).Scan(&kind, &owner, &operation))
	require.Equal(t, "mythical", kind)
	require.Equal(t, item, owner)
	require.Equal(t, receipt.OperationID, operation, "in-flight admission must be fenced by its original operation after upgrade")
}
