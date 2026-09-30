package services

import (
	"context"
	"errors"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// TestMythicalItemBeyondSnapshotBound reads one item by id or issue number
// when the snapshot's bound no longer lists it: 500 items still moving push
// a settled one out of the snapshot, and the terminal's watch still finds it.
func TestMythicalItemBeyondSnapshotBound(t *testing.T) {
	pool := newProductTestPool(t)
	ctx := context.Background()
	q := db.New(pool)
	var userID, repoID, otherRepoID int64
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO users(username, lower_username) VALUES ('item-owner', 'item-owner') RETURNING id`).Scan(&userID))
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO repositories(user_id, name, lower_name) VALUES ($1, 'smithers', 'smithers') RETURNING id`, userID).Scan(&repoID))
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO repositories(user_id, name, lower_name) VALUES ($1, 'other', 'other') RETURNING id`, userID).Scan(&otherRepoID))
	_, err := q.RequestMythicalBootstrap(ctx, repoID, userID, 100, false)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE mythical_stacks SET state = 'active' WHERE repository_id = $1`, repoID)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO mythical_items (repository_id, issue_number, issue_title, state, attempt)
		SELECT $1, n, 'Queued ' || n, 'queued', 0 FROM generate_series(1, 500) AS n`, repoID)
	require.NoError(t, err)
	var blockedID string
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO mythical_items (repository_id, issue_number, issue_title, issue_url, state, reason, attempt)
		VALUES ($1, 501, 'Fix login', 'https://github.com/o/smithers/issues/501', 'blocked', 'out of attempts', 3) RETURNING id::text`, repoID).Scan(&blockedID))
	var foreignID string
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO mythical_items (repository_id, issue_number, issue_title, state, attempt)
		VALUES ($1, 7, 'Elsewhere', 'queued', 0) RETURNING id::text`, otherRepoID).Scan(&foreignID))

	service := NewMythicalService(pool, nil)
	view, err := service.Snapshot(ctx, repoID, "o/smithers", "", MythicalViewer{UserID: userID})
	require.NoError(t, err)
	require.Len(t, view.Items, 500)
	for _, item := range view.Items {
		require.NotEqual(t, blockedID, item.ID, "the settled item is past the snapshot's bound")
	}

	for _, ref := range []string{blockedID, "501"} {
		item, err := service.Item(ctx, repoID, ref)
		require.NoError(t, err, ref)
		assert.Equal(t, blockedID, item.ID)
		assert.Equal(t, "blocked", item.State)
		assert.Equal(t, "out of attempts", item.Reason)
		require.NotNil(t, item.Issue)
		assert.Equal(t, MythicalIssueView{Number: 501, Title: "Fix login", URL: "https://github.com/o/smithers/issues/501"}, *item.Issue)
		assert.Equal(t, []string{}, item.DependsOn)
	}

	status := func(err error) int {
		var api *pkgerrors.APIError
		require.True(t, errors.As(err, &api), "%v", err)
		return api.Status
	}
	for ref, want := range map[string]int{
		foreignID:                              404, // another repository's item
		"502":                                  404,
		"0b8e5c3e-8a55-4d4e-9d7f-2f3c6c1f5a10": 404,
		"0":                                    400,
		"-1":                                   400,
		"#501":                                 400,
		"":                                     400,
	} {
		_, err := service.Item(ctx, repoID, ref)
		assert.Equal(t, want, status(err), "ref %q", ref)
	}
}
