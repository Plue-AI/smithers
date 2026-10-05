package services

import (
	"context"
	"encoding/json"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/stretchr/testify/require"
)

func TestTodoCreationRealPostgres(t *testing.T) {
	pool := newProductTestPool(t)
	ctx := context.Background()
	var userID, repoID int64
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO users(username,lower_username) VALUES('owner','owner') RETURNING id`).Scan(&userID))
	_, err := pool.Exec(ctx, `INSERT INTO self_host_owners(singleton,user_id) VALUES(true,$1)`, userID)
	require.NoError(t, err)
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO repositories(user_id,name,lower_name) VALUES($1,'repo','repo') RETURNING id`, userID).Scan(&repoID))
	q := db.New(pool)
	_, err = q.RequestMythicalBootstrap(ctx, repoID, userID, 1, false)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE mythical_stacks SET state='active' WHERE repository_id=$1`, repoID)
	require.NoError(t, err)
	s := NewMythicalService(pool, nil) // nil GitHub/launcher: any outbound call fails.
	ctx = middleware.ContextWithAuthInfo(ctx, &middleware.AuthInfo{User: &db.User{ID: userID}, SessionHash: "session-one"})
	input := MythicalTodoInput{Title: "One", Prompt: "Change the README", Context: "--- a/flows/todo/flow.ts\n+++ b/flows/todo/flow.ts\n@@ -1 +1 @@\n-old\n+new", Request: "same"}
	first, err := s.FileTodo(ctx, repoID, userID, input)
	require.NoError(t, err)
	require.EqualValues(t, 1, first.Number)
	require.Equal(t, "queued", first.TodoState)
	require.Nil(t, first.Issue)
	repeated, err := s.FileTodo(ctx, repoID, userID, input)
	require.NoError(t, err)
	require.Equal(t, first.ID, repeated.ID)
	changedContext := input
	changedContext.Context += "\n+another"
	_, err = s.FileTodo(ctx, repoID, userID, changedContext)
	var contextErr *TodoControlError
	require.ErrorAs(t, err, &contextErr)
	require.Equal(t, "idempotency_mismatch", contextErr.Code)
	input.Prompt = "Different"
	_, err = s.FileTodo(ctx, repoID, userID, input)
	var typed *TodoControlError
	require.ErrorAs(t, err, &typed)
	require.Equal(t, "idempotency_mismatch", typed.Code)
	input.Prompt = "Change the README"
	start := make(chan struct{})
	results := make(chan error, 20)
	var wg sync.WaitGroup
	for range 20 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			view, err := s.FileTodo(ctx, repoID, userID, input)
			if err == nil && view.ID != first.ID {
				err = pgx.ErrNoRows
			}
			results <- err
		}()
	}
	close(start)
	wg.Wait()
	close(results)
	for err := range results {
		require.NoError(t, err)
	}
	item, err := q.GetMythicalItemByNumber(ctx, repoID, 1)
	require.NoError(t, err)
	var count int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM mythical_items WHERE repository_id=$1`, repoID).Scan(&count))
	require.Equal(t, 1, count)
	store, err := jobs.NewStore(pool)
	require.NoError(t, err)
	events, err := store.Replay(ctx, todoOperationScope(item), 0, 100)
	require.NoError(t, err)
	require.Len(t, events.Events, 1)
	require.Equal(t, "todo.created", events.Events[0].Type)
	card, err := s.Todo(ctx, repoID, 1)
	require.NoError(t, err)
	require.Equal(t, int64(1), card["n"])
	require.NotContains(t, card, "branch")
	var revisions []map[string]any
	require.NoError(t, json.Unmarshal(item.Revisions, &revisions))
	require.Equal(t, "Change the README", revisions[0]["text"])
	require.Equal(t, input.Context, revisions[0]["context"])
	stale := item
	item.Reason = "saved"
	saved, err := q.SaveMythicalItem(ctx, item)
	require.NoError(t, err)
	require.Equal(t, item.Version+1, saved.Version)
	_, err = q.SaveMythicalItem(ctx, stale)
	require.ErrorIs(t, err, pgx.ErrNoRows)
	// The same member's replacement session owns a distinct idempotency scope.
	ctx2 := middleware.ContextWithAuthInfo(context.Background(), &middleware.AuthInfo{User: &db.User{ID: userID}, SessionHash: "session-two"})
	second, err := s.FileTodo(ctx2, repoID, userID, input)
	require.NoError(t, err)
	require.EqualValues(t, 2, second.Number)
	other, err := q.GetMythicalItemByNumber(ctx, repoID, 2)
	require.NoError(t, err)
	separate, err := store.Replay(ctx, todoOperationScope(other), 0, 100)
	require.NoError(t, err)
	require.Len(t, separate.Events, 1)
	require.NotEqual(t, events.Events[0].OperationID, separate.Events[0].OperationID)
	// Fail after item insertion but before its event commits. The item, request
	// identity, number and stream cursor must all roll back together.
	_, err = pool.Exec(ctx, `CREATE FUNCTION reject_todo_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected event failure'; END $$;
 CREATE TRIGGER reject_todo_event BEFORE INSERT ON product_job_events FOR EACH ROW EXECUTE FUNCTION reject_todo_event();`)
	require.NoError(t, err)
	failed := input
	failed.Request = "rollback"
	_, err = s.FileTodo(ctx, repoID, userID, failed)
	require.Error(t, err)
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM mythical_items WHERE repository_id=$1`, repoID).Scan(&count))
	require.Equal(t, 2, count)
	_, err = pool.Exec(ctx, `DROP TRIGGER reject_todo_event ON product_job_events; DROP FUNCTION reject_todo_event();`)
	require.NoError(t, err)
	third, err := s.FileTodo(ctx, repoID, userID, failed)
	require.NoError(t, err)
	require.EqualValues(t, 3, third.Number)

}
