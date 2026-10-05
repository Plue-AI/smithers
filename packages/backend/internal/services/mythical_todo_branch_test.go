package services

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
)

// A TODO's card keeps naming its branch after its lane is released: in
// review after the verdict and merged it names its latest coding lane (never
// a review lane), asleep once stopped, under the pull request's head branch;
// while it holds a lane it names that lane. A TODO that never had a lane
// names none.
func TestTodoCardKeepsItsBranchAfterReleaseRealPostgres(t *testing.T) {
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
	for _, title := range []string{"Add a greeting", "Second"} {
		_, err = s.FileTodo(ctx, repoID, userID, MythicalTodoInput{Title: title, Prompt: "Change " + title, Request: title})
		require.NoError(t, err)
	}
	item, err := q.GetMythicalItemByNumber(ctx, repoID, 1)
	require.NoError(t, err)
	lane := func(name, status string) string {
		row, err := q.CreateWorkspace(ctx, db.CreateWorkspaceParams{RepositoryID: repoID, UserID: userID, Name: name, Kind: "agent",
			Status: status, TargetBookmark: "mythical", EnvironmentSource: defaultWorkspaceEnvironmentSource})
		require.NoError(t, err)
		_, _, err = q.BindMythicalLane(ctx, db.MythicalLane{WorkspaceID: row.ID, RepositoryID: repoID, ItemID: item.ID, Name: name})
		require.NoError(t, err)
		return row.ID
	}
	coding := lane("TODO 1 attempt 1 g1", "stopped")
	review := lane("TODO 1 review g2", "running")
	branch := func(n int64) any {
		card, err := s.Todo(ctx, repoID, n)
		require.NoError(t, err)
		return card["branch"]
	}

	// In review, holding its review lane: the card names that lane.
	_, err = pool.Exec(ctx, `UPDATE mythical_items SET state='proposed', workspace_id=$2, pr_number=1, pr_url='https://github.com/o/r/pull/1',
		pr_head='abc', pr_state='open', checks = COALESCE(checks,'{}'::jsonb) || '{"branch":"smithers/add-a-greeting"}'::jsonb WHERE id=$1`, item.ID, review)
	require.NoError(t, err)
	require.Equal(t, map[string]any{"id": review, "name": "smithers/add-a-greeting", "machine": map[string]any{"state": "awake"}}, branch(1))

	// The review answered and its lane was released: the card names the
	// TODO's own coding lane, asleep, under its pull request's branch.
	_, err = pool.Exec(ctx, `UPDATE mythical_items SET workspace_id='' WHERE id=$1`, item.ID)
	require.NoError(t, err)
	want := map[string]any{"id": coding, "name": "smithers/add-a-greeting", "machine": map[string]any{"state": "asleep"}}
	require.Equal(t, want, branch(1))
	_, err = pool.Exec(ctx, `UPDATE mythical_items SET state='landed' WHERE id=$1`, item.ID)
	require.NoError(t, err)
	require.Equal(t, want, branch(1), "a merged TODO keeps naming its branch")

	require.Nil(t, branch(2), "a TODO that never had a lane names none")
	cards, err := s.Todos(ctx, repoID)
	require.NoError(t, err)
	for _, card := range cards {
		if card["n"].(int64) == 1 {
			require.Equal(t, want, card["branch"], "the list agrees")
		}
	}
}
