package services

import (
	"context"
	"errors"
	"math"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

func TestWorkspace_H_GetWorkspaceBranches(t *testing.T) {
	ctx := context.Background()
	workspaceID := "11111111-1111-1111-1111-111111111111"

	_, err := NewWorkspaceService(nil).GetWorkspace(ctx, workspaceID, 101, 1)
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	_, err = newWorkspaceServiceForTests(&mockWorkspaceQuerier{
		getWorkspaceByRepoFn: func(context.Context, db.GetWorkspaceByRepoParams) (db.Workspace, error) {
			return db.Workspace{}, &pgconn.PgError{Code: "22P02"}
		},
	}).GetWorkspace(ctx, "bad", 101, 1)
	require.Error(t, err)
	assert.Equal(t, 404, apiStatus(t, err))
}

func TestWorkspace_H_LoadOwnedSnapshotAndSessionBranches(t *testing.T) {
	ctx := context.Background()
	workspaceID := "11111111-1111-1111-1111-111111111111"
	snapshotID := "22222222-2222-2222-2222-222222222222"
	sessionID := "33333333-3333-3333-3333-333333333333"

	for name, errToReturn := range map[string]error{
		"invalid": &pgconn.PgError{Code: "22P02"},
		"missing": pgx.ErrNoRows,
	} {
		t.Run("snapshot_"+name, func(t *testing.T) {
			_, err := newWorkspaceServiceForTests(&mockWorkspaceQuerier{
				getWorkspaceSnapshotByRepoFn: func(context.Context, db.GetWorkspaceSnapshotByRepoParams) (db.WorkspaceSnapshot, error) {
					return db.WorkspaceSnapshot{}, errToReturn
				},
			}).loadOwnedWorkspaceSnapshot(ctx, snapshotID, 101, 1)
			require.Error(t, err)
			assert.Equal(t, 404, apiStatus(t, err))
		})

		t.Run("session_"+name, func(t *testing.T) {
			_, err := newWorkspaceServiceForTests(&mockWorkspaceQuerier{
				getWorkspaceSessionByRepoFn: func(context.Context, db.GetWorkspaceSessionByRepoParams) (db.WorkspaceSession, error) {
					return db.WorkspaceSession{}, errToReturn
				},
			}).loadOwnedWorkspaceSession(ctx, sessionID, 101, 1)
			require.Error(t, err)
			assert.Equal(t, 404, apiStatus(t, err))
		})
	}

	_, err := newWorkspaceServiceForTests(&mockWorkspaceQuerier{
		getWorkspaceSnapshotByRepoFn: func(context.Context, db.GetWorkspaceSnapshotByRepoParams) (db.WorkspaceSnapshot, error) {
			return db.WorkspaceSnapshot{}, errors.New("snapshot db failed")
		},
	}).loadOwnedWorkspaceSnapshot(ctx, snapshotID, 101, 1)
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	_, err = newWorkspaceServiceForTests(&mockWorkspaceQuerier{
		getWorkspaceSessionByRepoFn: func(context.Context, db.GetWorkspaceSessionByRepoParams) (db.WorkspaceSession, error) {
			return db.WorkspaceSession{}, errors.New("session db failed")
		},
	}).loadOwnedWorkspaceSession(ctx, sessionID, 101, 1)
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	_, err = newWorkspaceServiceForTests(&mockWorkspaceQuerier{
		getWorkspaceSnapshotByRepoFn: func(_ context.Context, arg db.GetWorkspaceSnapshotByRepoParams) (db.WorkspaceSnapshot, error) {
			snap := sampleDBWorkspaceSnapshot(arg.ID, "", "snap", "fs-snap")
			snap.UserID = 1
			return snap, nil
		},
	}).loadOwnedWorkspaceSnapshot(ctx, snapshotID, 101, 2)
	require.Error(t, err)
	assert.Equal(t, 403, apiStatus(t, err))

	_, err = newWorkspaceServiceForTests(&mockWorkspaceQuerier{
		getWorkspaceSnapshotByRepoFn: func(_ context.Context, arg db.GetWorkspaceSnapshotByRepoParams) (db.WorkspaceSnapshot, error) {
			snap := sampleDBWorkspaceSnapshot(arg.ID, workspaceID, "snap", "fs-snap")
			snap.UserID = 1
			return snap, nil
		},
		getWorkspaceShareFn: func(context.Context, db.GetWorkspaceShareParams) (db.WorkspaceShare, error) {
			return db.WorkspaceShare{}, errors.New("share failed")
		},
	}).loadOwnedWorkspaceSnapshot(ctx, snapshotID, 101, 2)
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	snap, err := newWorkspaceServiceForTests(&mockWorkspaceQuerier{
		getWorkspaceSnapshotByRepoFn: func(_ context.Context, arg db.GetWorkspaceSnapshotByRepoParams) (db.WorkspaceSnapshot, error) {
			snap := sampleDBWorkspaceSnapshot(arg.ID, workspaceID, "snap", "fs-snap")
			snap.UserID = 1
			return snap, nil
		},
		getWorkspaceShareFn: func(context.Context, db.GetWorkspaceShareParams) (db.WorkspaceShare, error) {
			return db.WorkspaceShare{Level: string(WorkspaceAccessWrite)}, nil
		},
	}).loadOwnedWorkspaceSnapshot(ctx, snapshotID, 101, 2)
	require.NoError(t, err)
	assert.Equal(t, snapshotID, snap.ID)

	_, err = newWorkspaceServiceForTests(&mockWorkspaceQuerier{
		getWorkspaceSessionByRepoFn: func(_ context.Context, arg db.GetWorkspaceSessionByRepoParams) (db.WorkspaceSession, error) {
			return db.WorkspaceSession{ID: arg.ID, WorkspaceID: workspaceID, RepositoryID: arg.RepositoryID, UserID: 1}, nil
		},
		getWorkspaceShareFn: func(context.Context, db.GetWorkspaceShareParams) (db.WorkspaceShare, error) {
			return db.WorkspaceShare{Level: string(WorkspaceAccessRead)}, nil
		},
	}).loadOwnedWorkspaceSession(ctx, sessionID, 101, 2)
	require.Error(t, err)
	assert.Equal(t, 403, apiStatus(t, err))

	session, err := newWorkspaceServiceForTests(&mockWorkspaceQuerier{
		getWorkspaceSessionByRepoFn: func(_ context.Context, arg db.GetWorkspaceSessionByRepoParams) (db.WorkspaceSession, error) {
			return db.WorkspaceSession{ID: arg.ID, WorkspaceID: workspaceID, RepositoryID: arg.RepositoryID, UserID: 1}, nil
		},
		getWorkspaceShareFn: func(context.Context, db.GetWorkspaceShareParams) (db.WorkspaceShare, error) {
			return db.WorkspaceShare{Level: string(WorkspaceAccessWrite)}, nil
		},
	}).loadOwnedWorkspaceSession(ctx, sessionID, 101, 2)
	require.NoError(t, err)
	assert.Equal(t, sessionID, session.ID)
}

func TestWorkspace_H_ListUserWorkspacesAcrossReposBranches(t *testing.T) {
	ctx := context.Background()
	_, err := NewWorkspaceService(nil).ListUserWorkspacesAcrossRepos(ctx, 7, 1, 30)
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	now := time.Now().UTC().Truncate(time.Second)
	var captured db.ListUserWorkspacesAcrossReposParams
	result, err := newWorkspaceServiceForTests(&mockWorkspaceQuerier{
		listUserWorkspacesAcrossReposFn: func(_ context.Context, arg db.ListUserWorkspacesAcrossReposParams) ([]db.ListUserWorkspacesAcrossReposRow, error) {
			captured = arg
			return []db.ListUserWorkspacesAcrossReposRow{
				{
					WorkspaceID:     "ws-valid",
					RepositoryID:    101,
					RepositoryOwner: "alice",
					RepositoryName:  "demo",
					WorkspaceTitle:  "primary",
					Status:          "running",
					LastAccessedAt:  pgtype.Timestamptz{Time: now, Valid: true},
					CreatedAt:       now.Add(-time.Hour),
					SortTimestamp:   now,
				},
				{
					WorkspaceID:     "ws-no-access",
					RepositoryID:    102,
					RepositoryOwner: "bob",
					RepositoryName:  "demo",
					WorkspaceTitle:  "secondary",
					Status:          "suspended",
					CreatedAt:       now.Add(-2 * time.Hour),
					SortTimestamp:   now.Add(-time.Hour),
				},
			}, nil
		},
		countUserWorkspacesAcrossReposFn: func(context.Context, int64) (int64, error) {
			return 2, nil
		},
	}).ListUserWorkspacesAcrossRepos(ctx, 7, 0, 0)
	require.NoError(t, err)
	assert.Equal(t, int64(7), captured.UserID)
	assert.Equal(t, int32(0), captured.PageOffset)
	assert.Equal(t, int32(30), captured.PageSize)
	assert.Equal(t, 1, result.Page)
	assert.Equal(t, 30, result.PerPage)
	assert.Equal(t, int64(2), result.TotalCount)
	require.Len(t, result.Items, 2)
	require.NotNil(t, result.Items[0].LastAccessedAt)
	assert.Nil(t, result.Items[1].LastAccessedAt)

	result, err = newWorkspaceServiceForTests(&mockWorkspaceQuerier{
		listUserWorkspacesAcrossReposFn: func(_ context.Context, arg db.ListUserWorkspacesAcrossReposParams) ([]db.ListUserWorkspacesAcrossReposRow, error) {
			captured = arg
			return nil, nil
		},
	}).ListUserWorkspacesAcrossRepos(ctx, 7, math.MaxInt32, 500)
	require.NoError(t, err)
	assert.Equal(t, MaxUserWorkspacesPerPage, result.PerPage)
	assert.GreaterOrEqual(t, captured.PageOffset, int32(0))

	_, err = newWorkspaceServiceForTests(&mockWorkspaceQuerier{
		listUserWorkspacesAcrossReposFn: func(context.Context, db.ListUserWorkspacesAcrossReposParams) ([]db.ListUserWorkspacesAcrossReposRow, error) {
			return nil, errors.New("list failed")
		},
	}).ListUserWorkspacesAcrossRepos(ctx, 7, 1, 30)
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	_, err = newWorkspaceServiceForTests(&mockWorkspaceQuerier{
		listUserWorkspacesAcrossReposFn: func(context.Context, db.ListUserWorkspacesAcrossReposParams) ([]db.ListUserWorkspacesAcrossReposRow, error) {
			return nil, nil
		},
		countUserWorkspacesAcrossReposFn: func(context.Context, int64) (int64, error) {
			return 0, errors.New("count failed")
		},
	}).ListUserWorkspacesAcrossRepos(ctx, 7, 1, 30)
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))
}
