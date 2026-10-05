package services

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
)

// A TODO on the stack carries its place; a merged or dropped TODO has left
// the stack and carries none, so its card never reads "Next to merge". The
// single read and the list agree.
func TestTodoSettledCardHasNoPlaceRealPostgres(t *testing.T) {
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
	card := func(n int64) map[string]any {
		card, err := s.Todo(ctx, repoID, n)
		require.NoError(t, err)
		return card
	}
	require.EqualValues(t, 1, card(1)["place"], "the first TODO is next to merge")

	_, err = pool.Exec(ctx, `UPDATE mythical_items SET state='landed' WHERE repository_id=$1 AND number=1`, repoID)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE mythical_items SET state='cancelled' WHERE repository_id=$1 AND number=2`, repoID)
	require.NoError(t, err)
	merged, dropped, queued := card(1), card(2), card(3)
	require.Equal(t, "merged", merged["state"])
	require.NotContains(t, merged, "place")
	require.Equal(t, "dropped", dropped["state"])
	require.NotContains(t, dropped, "place")
	require.Contains(t, queued, "place", "a TODO still on the stack keeps its place")

	cards, err := s.Todos(ctx, repoID)
	require.NoError(t, err)
	places := map[int64]bool{}
	for _, listed := range cards {
		_, has := listed["place"]
		places[listed["n"].(int64)] = has
	}
	require.Equal(t, map[int64]bool{1: false, 2: false, 3: true}, places)
}
