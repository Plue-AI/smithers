package services

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/stretchr/testify/require"
)

func TestTodoSteerDeliveryAuthorizer(t *testing.T) {
	for _, delegated := range []bool{false, true} {
		t.Run(fmt.Sprintf("delegated=%t", delegated), func(t *testing.T) {
			testTodoSteerDeliveryAuthorizer(t, delegated)
		})
	}
}

func testTodoSteerDeliveryAuthorizer(t *testing.T, delegated bool) {
	t.Helper()
	o, ownerSession := newTodoAdmission(t)
	ctx := context.Background()
	q := db.New(o.pool)
	binding := fmt.Sprintf(`{"owner_login":"smithers-canary","repository_name":"smithers","repository_id":%d}`, o.repoID)
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "github.repository", Value: []byte(binding)}))
	member, err := q.CreateUser(ctx, db.CreateUserParams{Username: "steer-member", LowerUsername: "steer-member", DisplayName: "Member"})
	require.NoError(t, err)
	_, err = o.pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,'write')`, o.repoID, member.ID)
	require.NoError(t, err)
	memberSession := middleware.ContextWithAuthInfo(ctx, &middleware.AuthInfo{User: &member, SessionHash: "member-session"})
	o.service.SetTodoFlow(func(context.Context, int64, string) (string, error) { return todoPinOne, nil })
	o.service.todoSteering = true
	pool, start := o.runDispatcher(t, flowruntime.ResolverFunc(func(context.Context, flowruntime.Target) (flowruntime.Runtime, error) {
		t.Error("authorization must not contact the runtime")
		return nil, fmt.Errorf("unexpected runtime resolution")
	}))
	item := o.fileTodo(ownerSession, "member-steering")
	ready, input, _ := steerFixture()
	item.State, item.Attempt, item.RequestRunID = ready.State, ready.Attempt, ready.RequestRunID
	item.WorkspaceID, item.FlowDigest, item.Checks = ready.WorkspaceID, ready.FlowDigest, ready.Checks
	item, err = q.SaveMythicalItem(ctx, item)
	require.NoError(t, err)
	input.Repository, input.Actor = o.repoID, member.ID
	wantAttribution := map[string]string{"person": "steer-member"}
	if delegated {
		scopes := fmt.Sprintf("read:repository,read:user,repo:%d,", o.repoID) + strings.Join(middleware.DelegationScopes(middleware.Delegation{
			Via: "terminal", Branch: item.WorkspaceID, Profile: middleware.TerminalProfileS1, Session: "terminal-1",
		}), ",")
		memberSession = middleware.ContextWithAuthInfo(ctx, &middleware.AuthInfo{User: &member, IsTokenAuth: true, TokenSystemIssued: true,
			RawScopes: scopes, Scopes: middleware.ParseTokenScopes(scopes), ViaHint: "codex"})
		wantAttribution = map[string]string{"person": "steer-member", "via": "codex", "session": "terminal-1"}
	}
	_, err = o.service.ControlTodo(memberSession, item.Number.Int64, input)
	require.NoError(t, err)
	var payload, authority json.RawMessage
	var requestID, operationID string
	require.NoError(t, o.pool.QueryRow(ctx, `SELECT payload,authorization_context,request_id,id::text FROM product_job_requests WHERE operation='flow.runtime.steer'`).Scan(&payload, &authority, &requestID, &operationID))
	var request flowdispatch.SteerRequest
	require.NoError(t, json.Unmarshal(payload, &request))
	request.Scope = jobs.Scope{TenantID: request.Target.TenantID, PrincipalID: request.Target.PrincipalID}
	request.RequestID, request.AuthorizationContext = requestID, authority
	require.Equal(t, wantAttribution, request.Attribution)
	require.NoError(t, o.service.AuthorizeFlowSteer(ctx, request))
	baseline := o.byID(uuidString(item.ID))
	current := baseline
	for _, tc := range []struct {
		name, code string
		retryable  bool
		change     func(*db.MythicalItem)
	}{
		{"paused question", "steer_held", true, func(i *db.MythicalItem) {
			i.PausedAt = pgtype.Timestamptz{Time: time.Now(), Valid: true}
			checks := mythicalChecksOf(*i)
			checks.Waits = []TodoWait{{ID: "question", Kind: "question"}}
			i.Checks = checks.encode()
		}},
		{"queued", "steer_held", true, func(i *db.MythicalItem) { i.State = "queued" }},
		{"failed", "steer_held", true, func(i *db.MythicalItem) { i.State = "blocked" }},
		{"starting", "steer_held", true, func(i *db.MythicalItem) {
			checks := mythicalChecksOf(*i)
			checks.RunAttached = false
			i.Checks = checks.encode()
		}},
		{"merge fence", "steer_held", true, func(i *db.MythicalItem) {
			i.PendingOp = []byte(`{"kind":"merge","target":"3","desired":"` + strings.Repeat("c", 40) + `","state":"intended"}`)
		}},
		{"lost pin", "steer_authorizer_unavailable", true, func(i *db.MythicalItem) { i.FlowDigest.Valid = false }},
		{"merged", "steer_todo_closed", false, func(i *db.MythicalItem) { i.State = "landed" }},
		{"dropped", "steer_todo_closed", false, func(i *db.MythicalItem) { i.State = "cancelled" }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			changed := current
			tc.change(&changed)
			current, err = q.SaveMythicalItem(ctx, changed)
			require.NoError(t, err)
			var failure flowruntime.FlowRuntimeFailure
			require.ErrorAs(t, o.service.AuthorizeFlowSteer(ctx, request), &failure)
			require.Equal(t, tc.code, failure.FlowRuntimeCode())
			require.Equal(t, tc.retryable, failure.FlowRuntimeRetryable())
			restored := baseline
			restored.Version = current.Version
			current, err = q.SaveMythicalItem(ctx, restored)
			require.NoError(t, err)
			require.NoError(t, o.service.AuthorizeFlowSteer(ctx, request))
		})
	}

	for _, tc := range []struct {
		name, revoke, restore string
	}{
		{"suspended", `UPDATE collaborators SET suspended_at=NOW() WHERE user_id=$1`, `UPDATE collaborators SET suspended_at=NULL WHERE user_id=$1`},
		{"read only", `UPDATE collaborators SET permission='read' WHERE user_id=$1`, `UPDATE collaborators SET permission='write' WHERE user_id=$1`},
		{"login blocked", `UPDATE users SET prohibit_login=true WHERE id=$1`, `UPDATE users SET prohibit_login=false WHERE id=$1`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := o.pool.Exec(ctx, tc.revoke, member.ID)
			require.NoError(t, err)
			require.ErrorContains(t, o.service.AuthorizeFlowSteer(ctx, request), "steer_author_revoked")
			_, err = o.pool.Exec(ctx, tc.restore, member.ID)
			require.NoError(t, err)
			require.NoError(t, o.service.AuthorizeFlowSteer(ctx, request))
		})
	}
	for name, change := range map[string]func(*flowdispatch.SteerRequest){
		"body":        func(r *flowdispatch.SteerRequest) { r.Body = "changed" },
		"attribution": func(r *flowdispatch.SteerRequest) { r.Attribution = map[string]string{"person": "other"} },
		"run":         func(r *flowdispatch.SteerRequest) { r.RunID = "other" },
		"workspace":   func(r *flowdispatch.SteerRequest) { r.Target.WorkspaceID = "other" },
		"message":     func(r *flowdispatch.SteerRequest) { r.MessageID = "other" },
		"timestamp":   func(r *flowdispatch.SteerRequest) { r.CreatedAt++ },
		"scope":       func(r *flowdispatch.SteerRequest) { r.Scope.PrincipalID = "user:999" },
		"author": func(r *flowdispatch.SteerRequest) {
			r.AuthorizationContext = []byte(fmt.Sprintf(`{"repositoryId":%d,"userId":%d,"itemId":%q,"input":%q}`, o.repoID, o.userID, r.Target.BindingID, r.MessageID))
		},
	} {
		t.Run(name, func(t *testing.T) {
			changed := request
			change(&changed)
			require.ErrorContains(t, o.service.AuthorizeFlowSteer(ctx, changed), "steer_input_mismatch")
		})
	}
	o.service.todoSteering = false
	require.ErrorContains(t, o.service.AuthorizeFlowSteer(ctx, request), "steer_authorizer_unavailable")
	o.service.todoSteering = true
	_, err = o.pool.Exec(ctx, `DELETE FROM collaborators WHERE repository_id=$1 AND user_id=$2`, o.repoID, member.ID)
	require.NoError(t, err)
	require.ErrorContains(t, o.service.AuthorizeFlowSteer(ctx, request), "steer_author_revoked")
	// The real jobs worker must use the same check after the membership
	// removal, without reaching the resolver or erasing the original input.
	store, err := jobs.NewStore(pool)
	require.NoError(t, err)
	start()
	var result jobs.Operation
	require.Eventually(t, func() bool {
		result, err = store.Get(ctx, request.Scope, operationID)
		return err == nil && result.State.Terminal()
	}, 5*time.Second, 10*time.Millisecond)
	require.Equal(t, jobs.StateFailed, result.State)
	require.Contains(t, string(result.TerminalReceipt), "steer_author_revoked")
	read, err := q.GetMythicalItemByNumber(ctx, o.repoID, item.Number.Int64)
	require.NoError(t, err)
	require.Len(t, mythicalChecksOf(read).Steers, 1, "refusal retains the committed feedback")
}

// The product transaction, worker and HTTP bridge are real; the host records
// accepted commands. This is delivery gating evidence, not guest execution.
func TestTodoSteerWorkerHoldsAcrossLifecycleChanges(t *testing.T) {
	for _, duringWake := range []bool{false, true} {
		for _, hold := range []string{"paused", "merge fence", "merged"} {
			t.Run(fmt.Sprintf("%s/during-wake=%t", hold, duringWake), func(t *testing.T) {
				o, session := newTodoAdmission(t)
				ctx := context.Background()
				q := db.New(o.pool)
				binding := fmt.Sprintf(`{"owner_login":"smithers-canary","repository_name":"smithers","repository_id":%d}`, o.repoID)
				require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "github.repository", Value: []byte(binding)}))
				o.service.SetTodoFlow(func(context.Context, int64, string) (string, error) { return todoPinOne, nil })
				o.service.todoSteering = true
				item := o.fileTodo(session, "held-steer")
				ready, input, _ := steerFixture()
				item.State, item.Attempt, item.RequestRunID = ready.State, ready.Attempt, ready.RequestRunID
				item.WorkspaceID, item.FlowDigest, item.Checks = ready.WorkspaceID, ready.FlowDigest, ready.Checks
				var err error
				item, err = q.SaveMythicalItem(ctx, item)
				require.NoError(t, err)
				setHold := func() {
					changed := o.byID(uuidString(item.ID))
					switch hold {
					case "paused":
						changed.PausedAt = pgtype.Timestamptz{Time: time.Now(), Valid: true}
					case "merge fence":
						changed.PendingOp = []byte(`{"kind":"merge","target":"3","desired":"` + strings.Repeat("c", 40) + `","state":"intended"}`)
					case "merged":
						changed.State = "landed"
					}
					_, err := q.SaveMythicalItem(ctx, changed)
					require.NoError(t, err)
				}
				peer := &todoRuntimeHost{}
				resolver := peer.resolver(t)
				var resolves atomic.Int32
				pool, start := o.runDispatcher(t, flowruntime.ResolverFunc(func(ctx context.Context, target flowruntime.Target) (flowruntime.Runtime, error) {
					if resolves.Add(1) == 1 && duringWake {
						setHold()
					}
					return resolver.ResolveFlowRuntime(ctx, target)
				}))
				input.Actor, input.Repository = o.userID, o.repoID
				_, err = o.service.ControlTodo(session, item.Number.Int64, input)
				require.NoError(t, err)
				if !duringWake {
					setHold()
				}
				var operationID string
				require.NoError(t, pool.QueryRow(ctx, `SELECT id::text FROM product_job_requests WHERE operation='flow.runtime.steer'`).Scan(&operationID))
				store, err := jobs.NewStore(pool)
				require.NoError(t, err)
				scope := jobs.Scope{TenantID: fmt.Sprintf("repository:%d", o.repoID), PrincipalID: fmt.Sprintf("user:%d", o.userID)}
				start()
				var operation jobs.Operation
				require.Eventually(t, func() bool {
					operation, err = store.Get(ctx, scope, operationID)
					return err == nil && (operation.State.Terminal() || operation.Attempt >= 2)
				}, 5*time.Second, 5*time.Millisecond)
				peer.mu.Lock()
				require.Empty(t, peer.steers)
				peer.mu.Unlock()
				if duringWake {
					require.EqualValues(t, 1, resolves.Load())
				} else {
					require.Zero(t, resolves.Load())
				}
				retained := o.byID(uuidString(item.ID))
				require.Len(t, mythicalChecksOf(retained).Steers, 1)
				if hold == "merged" {
					require.Equal(t, jobs.StateFailed, operation.State)
					require.Contains(t, string(operation.TerminalReceipt), "steer_todo_closed")
					return
				}
				require.False(t, operation.State.Terminal())
				retained.PausedAt, retained.PendingOp = pgtype.Timestamptz{}, nil
				_, err = q.SaveMythicalItem(ctx, retained)
				require.NoError(t, err)
				require.Eventually(t, func() bool {
					operation, err = store.Get(ctx, scope, operationID)
					return err == nil && operation.State == jobs.StateCompleted
				}, 5*time.Second, 5*time.Millisecond)
				peer.mu.Lock()
				defer peer.mu.Unlock()
				require.Len(t, peer.steers, 1)
				require.Equal(t, "same-run", peer.steers[0]["runId"])
				require.Equal(t, map[string]any{"kind": "Message", "body": *input.Steer}, peer.steers[0]["steer"])
				require.Equal(t, mythicalChecksOf(retained).Steers[0].ID, peer.steers[0]["messageId"])
			})
		}
	}
}

// Real product storage and flowdispatch admission; runtime delivery is not
// started. This verifies the transaction boundary, not guest consumption.
func TestTodoSteerAdmissionTransaction(t *testing.T) {
	o, session := newTodoAdmission(t)
	ctx := context.Background()
	q := db.New(o.pool)
	binding := fmt.Sprintf(`{"owner_login":"smithers-canary","repository_name":"smithers","repository_id":%d}`, o.repoID)
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "github.repository", Value: []byte(binding)}))
	o.service.SetTodoFlow(func(context.Context, int64, string) (string, error) { return todoPinOne, nil })
	o.service.todoSteering = true // deliberately unbound in production
	o.runDispatcher(t, flowruntime.ResolverFunc(func(context.Context, flowruntime.Target) (flowruntime.Runtime, error) {
		t.Error("admission must not resolve the runtime")
		return nil, fmt.Errorf("runtime must not be contacted")
	}))
	item := o.fileTodo(session, "steering")
	ready, input, _ := steerFixture()
	item.State, item.Attempt, item.RequestRunID = ready.State, ready.Attempt, ready.RequestRunID
	item.WorkspaceID, item.FlowDigest, item.Checks = ready.WorkspaceID, ready.FlowDigest, ready.Checks
	item, err := q.SaveMythicalItem(ctx, item)
	require.NoError(t, err)
	input.Repository, input.Actor = o.repoID, o.userID

	// A durable-intent write failing after the item/event updates must roll
	// back all three. PostgreSQL, rather than a mock store, enforces this.
	_, err = o.pool.Exec(ctx, `CREATE FUNCTION reject_test_steer() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN IF NEW.operation = 'flow.runtime.steer' THEN RAISE EXCEPTION 'test steer unavailable'; END IF; RETURN NEW; END $$;
 CREATE TRIGGER reject_test_steer BEFORE INSERT ON product_job_requests FOR EACH ROW EXECUTE FUNCTION reject_test_steer()`)
	require.NoError(t, err)
	_, err = o.service.ControlTodo(session, item.Number.Int64, input)
	require.ErrorContains(t, err, "test steer unavailable")
	read, err := q.GetMythicalItemByNumber(ctx, o.repoID, item.Number.Int64)
	require.NoError(t, err)
	require.JSONEq(t, string(item.Checks), string(read.Checks))
	var events int
	require.NoError(t, o.pool.QueryRow(ctx, `SELECT count(*) FROM product_job_requests WHERE operation='todo.steer_received'`).Scan(&events))
	require.Zero(t, events)
	_, err = o.pool.Exec(ctx, `DROP TRIGGER reject_test_steer ON product_job_requests; DROP FUNCTION reject_test_steer()`)
	require.NoError(t, err)

	receipt, err := o.service.ControlTodo(session, item.Number.Int64, input)
	require.NoError(t, err)
	replay, err := o.service.ControlTodo(session, item.Number.Int64, input)
	require.NoError(t, err)
	require.Equal(t, receipt, replay)
	read, err = q.GetMythicalItemByNumber(ctx, o.repoID, item.Number.Int64)
	require.NoError(t, err)
	feedback := mythicalChecksOf(read).Steers
	require.Len(t, feedback, 1)
	require.Equal(t, *input.Steer, feedback[0].Text)
	require.NoError(t, o.pool.QueryRow(ctx, `SELECT count(*) FROM product_job_requests WHERE operation='todo.steer_received'`).Scan(&events))
	require.Equal(t, 1, events)
	var payload json.RawMessage
	require.NoError(t, o.pool.QueryRow(ctx, `SELECT payload FROM product_job_requests WHERE operation='flow.runtime.steer'`).Scan(&payload))
	var sent struct{ RunID, MessageID, Body string }
	require.NoError(t, json.Unmarshal(payload, &sent))
	require.Equal(t, "same-run", sent.RunID)
	require.Equal(t, feedback[0].ID, sent.MessageID)
	require.Equal(t, *input.Steer, sent.Body)
	// A forged subject must be refused even when it would replay an input.
	input.Actor++
	_, err = o.service.ControlTodo(session, item.Number.Int64, input)
	require.Error(t, err)
}
