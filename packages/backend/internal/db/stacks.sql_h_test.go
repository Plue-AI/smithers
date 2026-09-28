package db

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type stacksSQLHDB = chunk4SQLHDB
type stacksSQLHRow = chunk4SQLHRow
type stacksSQLHRows = chunk4SQLHRows

func TestStacksSQL_H_RoundTripAndDeletePaths(t *testing.T) {
	ctx := context.Background()
	q, pool := newQueries(t)
	userID, repoID := mustCreateUserAndRepo(t, pool, uniqueTestUsername(t), uniqueTestRepoName(t))

	stack, err := q.UpsertActiveStack(ctx, UpsertActiveStackParams{RepositoryID: repoID, UserID: userID, TargetRef: "main"})
	require.NoError(t, err)
	assert.Equal(t, "active", stack.State)
	upserted, err := q.UpsertActiveStack(ctx, UpsertActiveStackParams{RepositoryID: repoID, UserID: userID, TargetRef: "main"})
	require.NoError(t, err)
	assert.Equal(t, stack.ID, upserted.ID)

	active, err := q.GetActiveStack(ctx, GetActiveStackParams{RepositoryID: repoID, UserID: userID, TargetRef: "main"})
	require.NoError(t, err)
	assert.Equal(t, stack.ID, active.ID)
	_, err = q.GetActiveStack(ctx, GetActiveStackParams{RepositoryID: repoID, UserID: userID, TargetRef: "missing"})
	require.ErrorIs(t, err, pgx.ErrNoRows)

	stacks, err := q.ListStacksByRepository(ctx, repoID)
	require.NoError(t, err)
	require.Len(t, stacks, 1)
	assert.Equal(t, stack.ID, stacks[0].ID)

	first, err := q.UpsertStackChange(ctx, UpsertStackChangeParams{
		StackID:      stack.ID,
		ChangeID:     "change-one-" + randSlug(t),
		Position:     1,
		BranchName:   "branch-one",
		PRNumber:     pgtype.Int8{Int64: 11, Valid: true},
		PRState:      pgtype.Text{String: "open", Valid: true},
		ReviewStatus: pgtype.Text{String: "approved", Valid: true},
		CiStatus:     pgtype.Text{String: "success", Valid: true},
	})
	require.NoError(t, err)
	second, err := q.UpsertStackChange(ctx, UpsertStackChangeParams{
		StackID:    stack.ID,
		ChangeID:   "change-two-" + randSlug(t),
		Position:   2,
		BranchName: "branch-two",
	})
	require.NoError(t, err)
	updatedFirst, err := q.UpsertStackChange(ctx, UpsertStackChangeParams{
		StackID:    stack.ID,
		ChangeID:   first.ChangeID,
		Position:   3,
		BranchName: "branch-one-updated",
	})
	require.NoError(t, err)
	assert.Equal(t, first.ID, updatedFirst.ID)
	assert.Equal(t, int32(3), updatedFirst.Position)

	changes, err := q.ListStackChangesByStack(ctx, stack.ID)
	require.NoError(t, err)
	require.Len(t, changes, 2)
	assert.Equal(t, second.ID, changes[0].ID)

	require.NoError(t, q.DeleteStackChangesNotInSet(ctx, DeleteStackChangesNotInSetParams{
		StackID:   stack.ID,
		ChangeIds: []string{first.ChangeID},
	}))
	changes, err = q.ListStackChangesByStack(ctx, stack.ID)
	require.NoError(t, err)
	require.Len(t, changes, 1)
	assert.Equal(t, first.ChangeID, changes[0].ChangeID)

	require.NoError(t, q.DeleteAllStackChanges(ctx, stack.ID))
	changes, err = q.ListStackChangesByStack(ctx, stack.ID)
	require.NoError(t, err)
	assert.Empty(t, changes)
	require.NoError(t, q.DeleteStackByID(ctx, stack.ID))
	_, err = q.GetActiveStack(ctx, GetActiveStackParams{RepositoryID: repoID, UserID: userID, TargetRef: "main"})
	require.ErrorIs(t, err, pgx.ErrNoRows)

	_ = mustExpectQueryError(t, pool, func(spQ *Queries) error {
		_, err := spQ.UpsertActiveStack(ctx, UpsertActiveStackParams{RepositoryID: 999999, UserID: userID, TargetRef: "bad"})
		return err
	})
	_ = mustExpectQueryError(t, pool, func(spQ *Queries) error {
		_, err := spQ.UpsertStackChange(ctx, UpsertStackChangeParams{StackID: 999999, ChangeID: "bad", Position: 1, BranchName: "bad"})
		return err
	})
}

func TestStacksSQL_H_GitHubInstallationLookup(t *testing.T) {
	ctx := context.Background()
	q, pool := newQueries(t)

	const installationID int64 = 440044
	mustExec(t, pool, `
		INSERT INTO github_app_installations (installation_id, account_login, account_type, repository_selection)
		VALUES ($1, 'Octo', 'User', 'selected')
	`, installationID)
	mustExec(t, pool, `
		INSERT INTO github_app_installation_repositories (
			installation_id, github_repository_id, owner_login, owner_login_lower, repo_name, repo_name_lower
		) VALUES ($1, 123456, 'Octo', 'octo', 'Hello', 'hello')
	`, installationID)

	got, err := q.GetGitHubAppInstallationForOwnerRepo(ctx, GetGitHubAppInstallationForOwnerRepoParams{Owner: "octo", Repo: "hello"})
	require.NoError(t, err)
	assert.Equal(t, installationID, got)
	_, err = q.GetGitHubAppInstallationForOwnerRepo(ctx, GetGitHubAppInstallationForOwnerRepoParams{Owner: "octo", Repo: "missing"})
	require.ErrorIs(t, err, pgx.ErrNoRows)
}

func TestStacksSQL_H_ManyErrorBranches(t *testing.T) {
	sentinel := errors.New("stacks h rows failed")
	cases := []struct {
		name string
		call func(*Queries) error
	}{
		{"ListStackChangesByStack", func(q *Queries) error { _, err := q.ListStackChangesByStack(context.Background(), 1); return err }},
		{"ListStacksByRepository", func(q *Queries) error { _, err := q.ListStacksByRepository(context.Background(), 1); return err }},
	}
	for _, tc := range cases {
		t.Run(tc.name+"_query", func(t *testing.T) {
			require.ErrorIs(t, tc.call(New(stacksSQLHDB{queryErr: sentinel})), sentinel)
		})
		t.Run(tc.name+"_scan", func(t *testing.T) {
			require.ErrorIs(t, tc.call(New(stacksSQLHDB{rows: &stacksSQLHRows{next: true, scanErr: sentinel}})), sentinel)
		})
		t.Run(tc.name+"_rows_err", func(t *testing.T) {
			require.ErrorIs(t, tc.call(New(stacksSQLHDB{rows: &stacksSQLHRows{err: sentinel}})), sentinel)
		})
	}
}

func TestStacksSQL_H_QueryRowAndExecErrorBranches(t *testing.T) {
	sentinel := errors.New("stacks h failed")
	rowQ := New(stacksSQLHDB{row: stacksSQLHRow{err: sentinel}})
	_, err := rowQ.GetActiveStack(context.Background(), GetActiveStackParams{})
	require.ErrorIs(t, err, sentinel)
	_, err = rowQ.GetGitHubAppInstallationForOwnerRepo(context.Background(), GetGitHubAppInstallationForOwnerRepoParams{})
	require.ErrorIs(t, err, sentinel)
	_, err = rowQ.UpsertActiveStack(context.Background(), UpsertActiveStackParams{})
	require.ErrorIs(t, err, sentinel)
	_, err = rowQ.UpsertStackChange(context.Background(), UpsertStackChangeParams{})
	require.ErrorIs(t, err, sentinel)

	execQ := New(stacksSQLHDB{execErr: sentinel})
	require.ErrorIs(t, execQ.DeleteAllStackChanges(context.Background(), 1), sentinel)
	require.ErrorIs(t, execQ.DeleteStackByID(context.Background(), 1), sentinel)
	require.ErrorIs(t, execQ.DeleteStackChangesNotInSet(context.Background(), DeleteStackChangesNotInSetParams{}), sentinel)
}
