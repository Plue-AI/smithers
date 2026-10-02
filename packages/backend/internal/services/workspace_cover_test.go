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
	"github.com/smithersai/smithers/packages/backend/sandbox"
)

func TestWorkspace_Cov_OptionsResponsesAndListBranches(t *testing.T) {
	ctx := context.Background()
	svc := NewWorkspaceService(&mockWorkspaceQuerier{}, WithWorkspaceSandboxConfig(42, sandbox.PersistenceEphemeral))
	assert.Equal(t, int64(42), svc.workspaceIdleTimeoutSeconds)
	assert.Equal(t, sandbox.PersistenceEphemeral, svc.workspacePersistence)
	defaultSvc := NewWorkspaceService(&mockWorkspaceQuerier{}, WithWorkspaceSandboxConfig(0, ""))
	assert.Equal(t, int64(1800), defaultSvc.workspaceIdleTimeoutSeconds)
	assert.Equal(t, sandbox.PersistencePersistent, defaultSvc.workspacePersistence)

	assert.False(t, stringToUUID("").Valid)
	assert.False(t, stringToUUID("not-a-uuid").Valid)
	sourceSnapshot := stringToUUID("33333333-3333-3333-3333-333333333333")
	require.True(t, sourceSnapshot.Valid)

	ws := sampleDBWorkspace("11111111-1111-1111-1111-111111111111")
	ws.VmID = "vm-1"
	ws.SourceSnapshotID = sourceSnapshot
	ws.SuspendedAt = pgtype.Timestamptz{Time: time.Now().UTC(), Valid: true}
	resp := svc.toWorkspaceResponse(ws)
	assert.Equal(t, ws.ID, resp.ID)
	assert.Equal(t, "main", resp.TargetBookmark)
	assert.Equal(t, "vm-1@vm-ssh.smithers.sh", resp.SSHHost)
	assert.Equal(t, "33333333-3333-3333-3333-333333333333", resp.SnapshotID)
	require.NotNil(t, resp.SuspendedAt)

	_, _, err := NewWorkspaceService(nil).ListWorkspaces(ctx, 1, 1, 1, 30)
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	var listArg db.ListWorkspacesByRepoParams
	svc = newWorkspaceServiceForTests(&mockWorkspaceQuerier{
		listWorkspacesByRepoFn: func(_ context.Context, arg db.ListWorkspacesByRepoParams) ([]db.Workspace, error) {
			listArg = arg
			return []db.Workspace{ws}, nil
		},
		countWorkspacesByRepoFn: func(context.Context, db.CountWorkspacesByRepoParams) (int64, error) {
			return 1, nil
		},
	})
	items, total, err := svc.ListWorkspaces(ctx, 101, 7, 0, 500)
	require.NoError(t, err)
	require.Len(t, items, 1)
	assert.Equal(t, int64(1), total)
	assert.Equal(t, int32(0), listArg.PageOffset)
	assert.Equal(t, int32(30), listArg.PageSize)

	svc = newWorkspaceServiceForTests(&mockWorkspaceQuerier{
		listWorkspacesByRepoFn: func(context.Context, db.ListWorkspacesByRepoParams) ([]db.Workspace, error) {
			return nil, errors.New("list failed")
		},
	})
	_, _, err = svc.ListWorkspaces(ctx, 101, 7, 1, 30)
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	svc = newWorkspaceServiceForTests(&mockWorkspaceQuerier{
		listWorkspacesByRepoFn: func(context.Context, db.ListWorkspacesByRepoParams) ([]db.Workspace, error) {
			return []db.Workspace{ws}, nil
		},
		countWorkspacesByRepoFn: func(context.Context, db.CountWorkspacesByRepoParams) (int64, error) {
			return 0, errors.New("count failed")
		},
	})
	_, _, err = svc.ListWorkspaces(ctx, 101, 7, 1, 30)
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	lastAccessed := time.Now().UTC().Add(-time.Hour)
	var userListArg db.ListUserWorkspacesAcrossReposParams
	svc = newWorkspaceServiceForTests(&mockWorkspaceQuerier{
		listUserWorkspacesAcrossReposFn: func(_ context.Context, arg db.ListUserWorkspacesAcrossReposParams) ([]db.ListUserWorkspacesAcrossReposRow, error) {
			userListArg = arg
			return []db.ListUserWorkspacesAcrossReposRow{{
				WorkspaceID:     ws.ID,
				RepositoryID:    101,
				RepositoryOwner: "alice",
				RepositoryName:  "demo",
				WorkspaceTitle:  "primary",
				Status:          "running",
				LastAccessedAt:  pgtype.Timestamptz{Time: lastAccessed, Valid: true},
				CreatedAt:       ws.CreatedAt,
				SortTimestamp:   lastAccessed,
			}}, nil
		},
		countUserWorkspacesAcrossReposFn: func(context.Context, int64) (int64, error) {
			return 1, nil
		},
	})
	result, err := svc.ListUserWorkspacesAcrossRepos(ctx, 7, math.MaxInt32, 500)
	require.NoError(t, err)
	require.Len(t, result.Items, 1)
	assert.Equal(t, MaxUserWorkspacesPerPage, result.PerPage)
	assert.Equal(t, int32((result.Page-1)*result.PerPage), userListArg.PageOffset)
	require.NotNil(t, result.Items[0].LastAccessedAt)
	assert.Equal(t, lastAccessed, *result.Items[0].LastAccessedAt)

	_, err = NewWorkspaceService(nil).ListUserWorkspacesAcrossRepos(ctx, 7, 1, 30)
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))
	svc = newWorkspaceServiceForTests(&mockWorkspaceQuerier{
		listUserWorkspacesAcrossReposFn: func(context.Context, db.ListUserWorkspacesAcrossReposParams) ([]db.ListUserWorkspacesAcrossReposRow, error) {
			return nil, errors.New("list failed")
		},
	})
	_, err = svc.ListUserWorkspacesAcrossRepos(ctx, 7, 1, 30)
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))
	svc = newWorkspaceServiceForTests(&mockWorkspaceQuerier{
		listUserWorkspacesAcrossReposFn: func(context.Context, db.ListUserWorkspacesAcrossReposParams) ([]db.ListUserWorkspacesAcrossReposRow, error) {
			return nil, nil
		},
		countUserWorkspacesAcrossReposFn: func(context.Context, int64) (int64, error) {
			return 0, errors.New("count failed")
		},
	})
	_, err = svc.ListUserWorkspacesAcrossRepos(ctx, 7, 1, 30)
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))
}

func TestWorkspace_Cov_LoadOwnedWorkspaceSnapshotSessionAndPairSource(t *testing.T) {
	ctx := context.Background()
	workspaceID := "11111111-1111-1111-1111-111111111111"
	snapshotID := "22222222-2222-2222-2222-222222222222"
	sessionID := "33333333-3333-3333-3333-333333333333"

	invalidUUIDErr := &pgconn.PgError{Code: "22P02"}
	svc := newWorkspaceServiceForTests(&mockWorkspaceQuerier{
		getWorkspaceByRepoFn: func(context.Context, db.GetWorkspaceByRepoParams) (db.Workspace, error) {
			return db.Workspace{}, invalidUUIDErr
		},
		getWorkspaceSnapshotByRepoFn: func(context.Context, db.GetWorkspaceSnapshotByRepoParams) (db.WorkspaceSnapshot, error) {
			return db.WorkspaceSnapshot{}, invalidUUIDErr
		},
		getWorkspaceSessionByRepoFn: func(context.Context, db.GetWorkspaceSessionByRepoParams) (db.WorkspaceSession, error) {
			return db.WorkspaceSession{}, invalidUUIDErr
		},
	})
	_, err := svc.loadOwnedWorkspace(ctx, "not-a-uuid", 101, 1)
	require.Error(t, err)
	assert.Equal(t, 404, apiStatus(t, err))
	_, err = svc.loadOwnedWorkspaceSnapshot(ctx, "not-a-uuid", 101, 1)
	require.Error(t, err)
	assert.Equal(t, 404, apiStatus(t, err))
	_, err = svc.loadOwnedWorkspaceSession(ctx, "not-a-uuid", 101, 1)
	require.Error(t, err)
	assert.Equal(t, 404, apiStatus(t, err))

	svc = newWorkspaceServiceForTests(&mockWorkspaceQuerier{
		getWorkspaceByRepoFn: func(context.Context, db.GetWorkspaceByRepoParams) (db.Workspace, error) {
			return db.Workspace{}, pgx.ErrNoRows
		},
	})
	_, err = svc.GetWorkspace(ctx, workspaceID, 101, 1)
	require.Error(t, err)
	assert.Equal(t, 404, apiStatus(t, err))

	svc = newWorkspaceServiceForTests(&mockWorkspaceQuerier{
		getWorkspaceByRepoFn: func(context.Context, db.GetWorkspaceByRepoParams) (db.Workspace, error) {
			return db.Workspace{}, errors.New("load failed")
		},
	})
	_, err = svc.GetWorkspace(ctx, workspaceID, 101, 1)
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	svc = newWorkspaceServiceForTests(&mockWorkspaceQuerier{
		getWorkspaceByRepoFn: func(_ context.Context, arg db.GetWorkspaceByRepoParams) (db.Workspace, error) {
			ws := sampleDBWorkspace(arg.ID)
			ws.UserID = 1
			return ws, nil
		},
		getWorkspaceShareFn: func(context.Context, db.GetWorkspaceShareParams) (db.WorkspaceShare, error) {
			return db.WorkspaceShare{Level: string(WorkspaceAccessRead)}, nil
		},
	})
	_, err = svc.loadOwnedWorkspace(ctx, workspaceID, 101, 2)
	require.Error(t, err)
	assert.Equal(t, 403, apiStatus(t, err))

	svc.q.(*mockWorkspaceQuerier).getWorkspaceShareFn = func(context.Context, db.GetWorkspaceShareParams) (db.WorkspaceShare, error) {
		return db.WorkspaceShare{Level: string(WorkspaceAccessWrite)}, nil
	}
	loaded, err := svc.loadOwnedWorkspace(ctx, workspaceID, 101, 2)
	require.NoError(t, err)
	assert.Equal(t, workspaceID, loaded.ID)

	svc = newWorkspaceServiceForTests(&mockWorkspaceQuerier{
		getWorkspaceSnapshotByRepoFn: func(_ context.Context, arg db.GetWorkspaceSnapshotByRepoParams) (db.WorkspaceSnapshot, error) {
			return sampleDBWorkspaceSnapshot(arg.ID, "", "snap", "fs-snap"), nil
		},
	})
	snap, err := svc.loadOwnedWorkspaceSnapshot(ctx, snapshotID, 101, 1)
	require.NoError(t, err)
	assert.Equal(t, snapshotID, snap.ID)
	svc.q.(*mockWorkspaceQuerier).getWorkspaceSnapshotByRepoFn = func(_ context.Context, arg db.GetWorkspaceSnapshotByRepoParams) (db.WorkspaceSnapshot, error) {
		snap := sampleDBWorkspaceSnapshot(arg.ID, "", "snap", "fs-snap")
		snap.UserID = 1
		return snap, nil
	}
	_, err = svc.loadOwnedWorkspaceSnapshot(ctx, snapshotID, 101, 2)
	require.Error(t, err)
	assert.Equal(t, 403, apiStatus(t, err))

	svc.q.(*mockWorkspaceQuerier).getWorkspaceSnapshotByRepoFn = func(_ context.Context, arg db.GetWorkspaceSnapshotByRepoParams) (db.WorkspaceSnapshot, error) {
		snap := sampleDBWorkspaceSnapshot(arg.ID, workspaceID, "snap", "fs-snap")
		snap.UserID = 1
		return snap, nil
	}
	svc.q.(*mockWorkspaceQuerier).getWorkspaceShareFn = func(context.Context, db.GetWorkspaceShareParams) (db.WorkspaceShare, error) {
		return db.WorkspaceShare{Level: string(WorkspaceAccessWrite)}, nil
	}
	_, err = svc.loadOwnedWorkspaceSnapshot(ctx, snapshotID, 101, 2)
	require.NoError(t, err)

	svc = newWorkspaceServiceForTests(&mockWorkspaceQuerier{
		getWorkspaceSessionByRepoFn: func(_ context.Context, arg db.GetWorkspaceSessionByRepoParams) (db.WorkspaceSession, error) {
			return db.WorkspaceSession{ID: arg.ID, WorkspaceID: workspaceID, RepositoryID: arg.RepositoryID, UserID: 1}, nil
		},
		getWorkspaceShareFn: func(context.Context, db.GetWorkspaceShareParams) (db.WorkspaceShare, error) {
			return db.WorkspaceShare{Level: string(WorkspaceAccessWrite)}, nil
		},
	})
	session, err := svc.loadOwnedWorkspaceSession(ctx, sessionID, 101, 2)
	require.NoError(t, err)
	assert.Equal(t, sessionID, session.ID)

	svc.q.(*mockWorkspaceQuerier).getWorkspaceSessionByRepoFn = func(context.Context, db.GetWorkspaceSessionByRepoParams) (db.WorkspaceSession, error) {
		return db.WorkspaceSession{}, pgx.ErrNoRows
	}
	_, err = svc.loadOwnedWorkspaceSession(ctx, sessionID, 101, 2)
	require.Error(t, err)
	assert.Equal(t, 404, apiStatus(t, err))
}
