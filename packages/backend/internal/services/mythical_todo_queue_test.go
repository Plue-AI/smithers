package services

import (
	"context"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/stretchr/testify/require"
)

// A queued TODO's card names why it waits and where it is in line (mvp.md
// §4.1: "waiting for a machine #2"); a TODO past queued carries no queue and
// takes no place in line. The single read and the list agree.
func TestTodoQueueReasonAndPositionRealPostgres(t *testing.T) {
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
	s := NewMythicalService(pool, nil)
	ctx = middleware.ContextWithAuthInfo(ctx, &middleware.AuthInfo{User: &db.User{ID: userID}, SessionHash: "session"})
	for _, title := range []string{"One", "Two", "Three"} {
		_, err = s.FileTodo(ctx, repoID, userID, MythicalTodoInput{Title: title, Prompt: "Change " + title, Request: title})
		require.NoError(t, err)
	}
	queue := func(n int64) any {
		card, err := s.Todo(ctx, repoID, n)
		require.NoError(t, err)
		return card["queue"]
	}
	machine := func(position int64) map[string]any { return map[string]any{"reason": "machine", "position": position} }
	require.Equal(t, machine(1), queue(1))
	require.Equal(t, machine(2), queue(2))
	require.Equal(t, machine(3), queue(3))

	// T1 leaves the queue for a lane: T2 and T3 move up, and T1 shows no queue.
	_, err = pool.Exec(ctx, `UPDATE mythical_items SET state='running' WHERE repository_id=$1 AND number=1`, repoID)
	require.NoError(t, err)
	card, err := s.Todo(ctx, repoID, 1)
	require.NoError(t, err)
	require.Equal(t, "working", card["state"])
	require.NotContains(t, card, "queue")
	require.Equal(t, machine(1), queue(2))
	require.Equal(t, machine(2), queue(3))

	cards, err := s.Todos(ctx, repoID)
	require.NoError(t, err)
	listed := map[int64]any{}
	for _, card := range cards {
		listed[card["n"].(int64)] = card["queue"]
	}
	require.Equal(t, map[int64]any{1: nil, 2: machine(1), 3: machine(2)}, listed)
}
