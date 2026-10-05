package services

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/stretchr/testify/require"
)

func TestTodoAmendRevisionAndReplay(t *testing.T) {
	item, input, ctx := steerFixture()
	item.Revisions = []byte(`[{"text":"Original","acceptance":["Original check"],"custom":"retained"}]`)
	amendment := TodoAmendInput{Prompt: " New prompt\nverbatim ", Acceptance: []string{"First check", "Second check"}}
	text, err := amendment.feedback()
	require.NoError(t, err)
	input.Steer = &text
	now := time.Unix(1234, 0).UTC()
	next, feedback, replay, err := prepareTodoAmend(ctx, item, input, amendment, json.RawMessage(`{"kind":"person","login":"alice"}`), map[string]string{"person": "alice"}, now)
	require.NoError(t, err)
	require.False(t, replay)
	require.Equal(t, 2, feedback.Revision)
	require.Equal(t, " New prompt\nverbatim \n\nAcceptance:\n- First check\n- Second check", feedback.Text)
	var revisions []map[string]any
	require.NoError(t, json.Unmarshal(next.Revisions, &revisions))
	require.Len(t, revisions, 2)
	require.Equal(t, "retained", revisions[0]["custom"])
	require.Equal(t, map[string]any{"text": amendment.Prompt, "acceptance": []any{"First check", "Second check"}, "by": map[string]any{"kind": "person", "login": "alice"}, "at": "1970-01-01T00:20:34Z", "reason": "amend"}, revisions[1])
	require.False(t, next.CandidateVerified)
	require.Nil(t, mythicalChecksOf(next).Land)
	replayed, repeated, replay, err := prepareTodoAmend(ctx, next, input, amendment, nil, nil, now.Add(time.Hour))
	require.NoError(t, err)
	require.True(t, replay)
	require.Equal(t, next, replayed)
	require.Equal(t, feedback, repeated)
	// A Steer with identical rendered text cannot borrow an Amend receipt.
	_, _, _, _, err = prepareTodoSteer(ctx, next, input, nil, nil, now)
	require.Error(t, err)
	// Different structured input can render identically; it is still a conflict.
	_, _, _, err = prepareTodoAmend(ctx, next, input, TodoAmendInput{Prompt: text}, nil, nil, now)
	require.Error(t, err)
	item.PendingOp = []byte(`{"kind":"merge","target":"3","desired":"` + strings.Repeat("c", 40) + `","state":"intended"}`)
	unchanged, _, _, err := prepareTodoAmend(ctx, item, input, amendment, nil, nil, now)
	require.Equal(t, "merging", err.(*TodoControlError).Code)
	require.Equal(t, item, unchanged)
}

func TestTodoAmendTransactionAndDelivery(t *testing.T) {
	o, session := newTodoAdmission(t)
	ctx := context.Background()
	q := db.New(o.pool)
	binding := fmt.Sprintf(`{"owner_login":"smithers-canary","repository_name":"smithers","repository_id":%d}`, o.repoID)
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "github.repository", Value: []byte(binding)}))
	o.service.SetTodoFlow(func(context.Context, int64, string) (string, error) { return todoPinOne, nil })
	o.service.todoSteering = true
	peer := &todoRuntimeHost{}
	pool, start := o.runDispatcher(t, peer.resolver(t))
	item := o.fileTodo(session, "amend")
	ready, _, _ := steerFixture()
	item.State, item.Attempt, item.RequestRunID = "proposed", ready.Attempt, ready.RequestRunID
	item.WorkspaceID, item.FlowDigest, item.Checks = ready.WorkspaceID, ready.FlowDigest, ready.Checks
	item.CandidateVerified, item.CandidateHead, item.CandidateBase = true, strings.Repeat("c", 40), o.landedMain()
	checks := mythicalChecksOf(item)
	checks.Waits = []TodoWait{{ID: "question", Kind: "question", Prompt: "Keep this open?"}}
	item.Checks = checks.encode()
	item, err := q.SaveMythicalItem(ctx, item)
	require.NoError(t, err)
	// A verified successor must lose the evidence tied to the amended prefix.
	later := o.fileTodo(session, "after-amend")
	later.State, later.CandidateVerified = "proposed", true
	later.CandidateBase, later.CandidateHead = item.CandidateHead, strings.Repeat("e", 40)
	later.Checks = (mythicalChecks{Todo: true, Land: &mythicalLand{Head: later.CandidateHead}}).encode()
	later, err = q.SaveMythicalItem(ctx, later)
	require.NoError(t, err)
	input := TodoAmendInput{Repository: o.repoID, Actor: o.userID, Request: "amend-1", Prompt: "Use the existing retry helper", Acceptance: []string{"Cancellation stops the retry"}}
	_, err = pool.Exec(ctx, `CREATE FUNCTION reject_amend_intent() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN IF NEW.operation = 'flow.runtime.steer' THEN RAISE EXCEPTION 'test amendment unavailable'; END IF; RETURN NEW; END $$;
 CREATE TRIGGER reject_amend_intent BEFORE INSERT ON product_job_requests FOR EACH ROW EXECUTE FUNCTION reject_amend_intent()`)
	require.NoError(t, err)
	_, err = o.service.AmendTodo(session, item.Number.Int64, input)
	require.ErrorContains(t, err, "test amendment unavailable")
	require.Equal(t, item, o.byID(uuidString(item.ID)))
	require.Equal(t, later, o.byID(uuidString(later.ID)))
	var count int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_requests WHERE operation IN ('todo.amended','todo.steer_received','flow.runtime.steer')`).Scan(&count))
	require.Zero(t, count)
	_, err = pool.Exec(ctx, `DROP TRIGGER reject_amend_intent ON product_job_requests; DROP FUNCTION reject_amend_intent()`)
	require.NoError(t, err)
	receipt, err := o.service.AmendTodo(session, item.Number.Int64, input)
	require.NoError(t, err)
	require.Equal(t, TodoControlReceipt{State: "accepted", Attempt: 2, Number: item.Number.Int64, Revision: 2}, receipt)
	replayed, err := o.service.AmendTodo(session, item.Number.Int64, input)
	require.NoError(t, err)
	require.Equal(t, receipt, replayed)
	saved := o.byID(uuidString(item.ID))
	require.Equal(t, item.ID, saved.ID)
	require.Equal(t, item.RequestRunID, saved.RequestRunID)
	require.Equal(t, item.WorkspaceID, saved.WorkspaceID)
	require.Equal(t, item.PRNumber, saved.PRNumber)
	require.Equal(t, item.Attempt, saved.Attempt)
	require.Equal(t, "running", saved.State)
	require.Equal(t, checks.Waits, mythicalChecksOf(saved).Waits)
	rebased := o.byID(uuidString(later.ID))
	require.False(t, rebased.CandidateVerified)
	require.Equal(t, "rebase_pending", rebased.Reason)
	require.Nil(t, mythicalChecksOf(rebased).Land)
	start()
	store, err := jobs.NewStore(pool)
	require.NoError(t, err)
	var id string
	require.NoError(t, pool.QueryRow(ctx, `SELECT id::text FROM product_job_requests WHERE operation='flow.runtime.steer'`).Scan(&id))
	require.Eventually(t, func() bool {
		operation, err := store.Get(ctx, jobs.Scope{TenantID: fmt.Sprintf("repository:%d", o.repoID), PrincipalID: fmt.Sprintf("user:%d", o.userID)}, id)
		return err == nil && operation.State == jobs.StateCompleted
	}, 5*time.Second, 5*time.Millisecond)
	peer.mu.Lock()
	sent := append([]map[string]any(nil), peer.steers...)
	peer.mu.Unlock()
	require.Len(t, sent, 1)
	require.Equal(t, "same-run", sent[0]["runId"])
	require.Equal(t, map[string]any{"kind": "Message", "body": "Use the existing retry helper\n\nAcceptance:\n- Cancellation stops the retry"}, sent[0]["steer"])
	for _, operation := range []string{"todo.amended", "todo.steer_received", "flow.runtime.steer"} {
		require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_requests WHERE operation=$1`, operation).Scan(&count))
		require.Equal(t, 1, count, operation)
	}
	// A currently authorized role is required even when only reading a receipt.
	bad := input
	bad.Actor++
	_, err = o.service.AmendTodo(session, item.Number.Int64, bad)
	require.Error(t, err)
	scopes := fmt.Sprintf("read:repository,read:user,repo:%d,", o.repoID) + strings.Join(middleware.DelegationScopes(middleware.Delegation{Via: "terminal", Branch: item.WorkspaceID, Profile: middleware.TerminalProfileS1, Session: "amend-terminal"}), ",")
	delegated := middleware.ContextWithAuthInfo(ctx, &middleware.AuthInfo{User: &db.User{ID: o.userID}, IsTokenAuth: true, TokenSystemIssued: true, RawScopes: scopes, Scopes: middleware.ParseTokenScopes(scopes)})
	_, err = o.service.AmendTodo(delegated, item.Number.Int64, input)
	var denied *AccessError
	require.ErrorAs(t, err, &denied)
	require.Equal(t, "confirmation_unavailable", denied.Code)
	require.Equal(t, 503, denied.Status)
	// Refusal neither adds a revision nor invalidates current runtime evidence.
	require.Equal(t, saved, o.byID(uuidString(item.ID)))
}

func TestTodoAmendHeldLifecycle(t *testing.T) {
	for _, state := range []string{"queued", "blocked", "proposed", "landed", "cancelled"} {
		t.Run(state, func(t *testing.T) {
			item, input, ctx := steerFixture()
			item.State, item.Revisions = state, []byte(`[{"text":"Original","acceptance":[]}]`)
			item.PausedAt = pgtype.Timestamptz{Time: time.Unix(1, 0), Valid: state == "proposed"}
			amendment := TodoAmendInput{Prompt: "Revised"}
			text, err := amendment.feedback()
			require.NoError(t, err)
			input.Steer = &text
			next, feedback, _, err := prepareTodoAmend(ctx, item, input, amendment, json.RawMessage(`{}`), nil, time.Now())
			if state == "landed" || state == "cancelled" {
				require.Equal(t, "todo_closed", err.(*TodoControlError).Code)
				require.Equal(t, item, next)
				return
			}
			require.NoError(t, err)
			require.True(t, feedback.ReleasePending)
			require.Equal(t, 2, feedback.Revision)
			require.Equal(t, item.RequestRunID, next.RequestRunID)
			require.Equal(t, item.PausedAt, next.PausedAt)
		})
	}
}
