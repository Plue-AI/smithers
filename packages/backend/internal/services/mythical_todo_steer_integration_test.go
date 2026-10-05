package services

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"

	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/stretchr/testify/require"
)

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
