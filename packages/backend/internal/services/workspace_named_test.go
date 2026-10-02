package services

import (
	"context"
	"errors"
	"fmt"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/sandbox"
)

// Exercise the exported create boundary. The store and already-running runtime
// are isolated here; PostgreSQL identity and races have independent integration
// coverage in workspace_named_integration_test.go.
func TestCreateWorkspaceNamedIdentity(t *testing.T) {
	var rows []db.Workspace
	q := &mockWorkspaceQuerier{
		getRepoByIDFn: func(context.Context, int64) (db.Repository, error) {
			return db.Repository{ID: 101, DefaultBookmark: "main"}, nil
		},
		listWorkspacesByRepoFn: func(context.Context, db.ListWorkspacesByRepoParams) ([]db.Workspace, error) {
			return append([]db.Workspace(nil), rows...), nil
		},
		getActiveWorkspaceForIdentityFn: func(_ context.Context, arg db.GetActiveWorkspaceForIdentityParams) (db.Workspace, error) {
			for _, row := range rows {
				if row.Kind == arg.Kind && row.Name == arg.Name && row.TargetBookmark == arg.TargetBookmark {
					return row, nil
				}
			}
			return db.Workspace{}, pgx.ErrNoRows
		},
		createWorkspaceFn: func(_ context.Context, arg db.CreateWorkspaceParams) (db.Workspace, error) {
			row := sampleDBWorkspace(fmt.Sprintf("named-%d", len(rows)))
			row.Name, row.Kind, row.TargetBookmark, row.IsFork = arg.Name, arg.Kind, arg.TargetBookmark, arg.IsFork
			rows = append(rows, row)
			return row, nil
		},
	}
	svc := newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
		getVMFn: func(context.Context, string) (sandbox.Sandbox, error) { return sandbox.Sandbox{}, nil },
	}))
	create := func(name, bookmark, kind string) WorkspaceResponse {
		t.Helper()
		row, err := svc.CreateWorkspaceAsync(context.Background(), CreateWorkspaceInput{
			RepositoryID: 101, UserID: 1, RepoOwner: "alice", RepoName: "demo",
			Name: name, SourceBookmark: bookmark, Kind: kind,
		})
		require.NoError(t, err)
		return row
	}
	one := create("issue-one", "main", "vm")
	two := create("issue-two", "main", "vm")
	require.NotEqual(t, one.ID, two.ID, "different names on main need distinct workspaces")
	require.Equal(t, one.ID, create(" issue-one ", "main", "vm").ID)
	branch := create("issue-one", "feature/one", "vm")
	require.NotEqual(t, one.ID, branch.ID)
	require.NotEqual(t, branch.ID, create("issue-two", "feature/one", "vm").ID)
	require.Equal(t, branch.ID, create("issue-one", "feature/one", "vm").ID)
	require.NotEqual(t, one.ID, create("issue-one", "main", "container").ID)
	unnamed := create("", "main", "vm")
	require.NotEqual(t, one.ID, unnamed.ID)
	require.Equal(t, unnamed.ID, create("", "main", "vm").ID)
}

func TestCreateWorkspaceConcurrentWinnerSurvivesQuotaRace(t *testing.T) {
	for _, tc := range []struct {
		name          string
		count         int64
		insertErr     error
		winnerErr     error
		rebuild       bool
		disappearOnce bool
		wantLookups   int
		wantCode      pkgerrors.Code
	}{
		{name: "same identity won insert", insertErr: &pgconn.PgError{Code: "23505", ConstraintName: "uq_workspaces_active"}},
		{name: "winner consumed last slot before precheck", count: MaxActiveWorkspacesPerUser},
		{name: "winner consumed last slot before insert", insertErr: &pgconn.PgError{Code: "23514", ConstraintName: "workspaces_user_quota"}},
		{name: "full quota has no same identity", count: MaxActiveWorkspacesPerUser, winnerErr: pgx.ErrNoRows, wantCode: pkgerrors.CodeQuotaExceeded},
		{name: "winner lookup failed", insertErr: &pgconn.PgError{Code: "23505", ConstraintName: "uq_workspaces_active"}, winnerErr: errors.New("database unavailable"), wantCode: pkgerrors.CodeInternal},
		{name: "winner requires rebuild", insertErr: &pgconn.PgError{Code: "23505", ConstraintName: "uq_workspaces_active"}, rebuild: true, wantCode: pkgerrors.CodeWorkspaceRebuildRequired},
		{name: "deleted winner frees identity for bounded retry", insertErr: &pgconn.PgError{Code: "23505", ConstraintName: "uq_workspaces_active"}, winnerErr: pgx.ErrNoRows, disappearOnce: true},
		{name: "repeated disappearing winners return typed error", insertErr: &pgconn.PgError{Code: "23505", ConstraintName: "uq_workspaces_active"}, winnerErr: pgx.ErrNoRows, wantLookups: 3, wantCode: pkgerrors.CodeInternal},
	} {
		t.Run(tc.name, func(t *testing.T) {
			lookups := 0
			inserts := 0
			q := &mockWorkspaceQuerier{
				getActiveWorkspaceForIdentityFn: func(_ context.Context, arg db.GetActiveWorkspaceForIdentityParams) (db.Workspace, error) {
					require.EqualValues(t, 101, arg.RepositoryID)
					require.EqualValues(t, 1, arg.UserID)
					require.Equal(t, "issue", arg.Name)
					require.Equal(t, "main", arg.TargetBookmark)
					require.Equal(t, "container", arg.Kind)
					lookups++
					if lookups == 1 {
						return db.Workspace{}, pgx.ErrNoRows
					}
					winner := sampleDBWorkspace("winning-row")
					winner.Name = "issue"
					if tc.rebuild {
						winner = flaggedWorkspace("winning-row")
						winner.Name = "issue"
					}
					return winner, tc.winnerErr
				},
				countActiveWorkspacesByUserFn: func(context.Context, int64) (int64, error) { return tc.count, nil },
				createWorkspaceFn: func(_ context.Context, arg db.CreateWorkspaceParams) (db.Workspace, error) {
					inserts++
					if tc.disappearOnce && inserts == 2 {
						row := sampleDBWorkspace("winning-row")
						row.Name = arg.Name
						return row, nil
					}
					return db.Workspace{}, tc.insertErr
				},
			}
			svc := newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(sandboxUntouched(t)))
			row, err := svc.CreateWorkspaceAsync(context.Background(), CreateWorkspaceInput{RepositoryID: 101, UserID: 1, Name: "issue"})
			if tc.wantCode == "" {
				require.NoError(t, err)
				require.Equal(t, "winning-row", row.ID)
			} else {
				var apiErr *pkgerrors.APIError
				require.ErrorAs(t, err, &apiErr)
				require.Equal(t, tc.wantCode, apiErr.Code)
			}
			wantLookups := tc.wantLookups
			if wantLookups == 0 {
				wantLookups = 2
			}
			require.Equal(t, wantLookups, lookups)
			if tc.disappearOnce {
				require.Equal(t, 2, inserts)
			}
		})
	}
}

func TestWorkspaceActivationConflictRetainsLoserWhenWinnerWasDeleted(t *testing.T) {
	loser := sampleDBWorkspace("activation-loser")
	loser.Status = "starting"
	q := &mockWorkspaceQuerier{
		updateWorkspaceStatusFn: func(_ context.Context, arg db.UpdateWorkspaceStatusParams) (db.Workspace, error) {
			require.Equal(t, loser.ID, arg.ID)
			require.Equal(t, "failed", arg.Status)
			row := loser
			row.Status = arg.Status
			return row, nil
		},
		getActiveWorkspaceForIdentityFn: func(context.Context, db.GetActiveWorkspaceForIdentityParams) (db.Workspace, error) {
			return db.Workspace{}, pgx.ErrNoRows
		},
	}
	row, err := newWorkspaceServiceForTests(q).reuseWinningWorkspaceAfterActivationConflict(context.Background(), loser)
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	require.Equal(t, 409, apiErr.Status)
	require.Equal(t, loser.ID, row.ID)
	require.Equal(t, "failed", row.Status)
	require.False(t, row.DeletedAt.Valid)
}

func TestCreateWorkspaceReplacesMissingNamedBookmarkGuest(t *testing.T) {
	old := sampleDBWorkspace("missing-branch")
	old.Name, old.TargetBookmark, old.IsFork = "issue", "feature/one", true
	current := old
	var retained db.Workspace
	q := &mockWorkspaceQuerier{
		getActiveWorkspaceForIdentityFn: func(context.Context, db.GetActiveWorkspaceForIdentityParams) (db.Workspace, error) {
			return current, nil
		},
		updateWorkspaceStatusFn: func(_ context.Context, arg db.UpdateWorkspaceStatusParams) (db.Workspace, error) {
			require.Equal(t, old.ID, arg.ID)
			retained = old
			retained.Status = arg.Status
			return retained, nil
		},
		createWorkspaceFn: func(_ context.Context, arg db.CreateWorkspaceParams) (db.Workspace, error) {
			require.Equal(t, "failed", retained.Status)
			current = sampleDBWorkspace("replacement-branch")
			current.Name, current.TargetBookmark, current.IsFork = arg.Name, arg.TargetBookmark, arg.IsFork
			current.VmID = "guest-replacement"
			return current, nil
		},
	}
	svc := newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
		getVMFn: func(_ context.Context, id string) (sandbox.Sandbox, error) {
			if id == old.VmID {
				return sandbox.Sandbox{}, sandbox.ErrNotFound
			}
			return sandbox.Sandbox{ID: id, State: sandbox.StateRunning}, nil
		},
		deleteVMFn: func(context.Context, string) error {
			t.Fatal("old guest reference must be retained for recovery")
			return nil
		},
	}))
	input := CreateWorkspaceInput{RepositoryID: old.RepositoryID, UserID: old.UserID, Name: old.Name, SourceBookmark: old.TargetBookmark}
	row, err := svc.CreateWorkspaceAsync(context.Background(), input)
	require.NoError(t, err)
	require.Equal(t, "replacement-branch", row.ID)
	require.Equal(t, old.VmID, retained.VmID)
	require.False(t, retained.DeletedAt.Valid)
	repeated, err := svc.CreateWorkspaceAsync(context.Background(), input)
	require.NoError(t, err)
	require.Equal(t, row.ID, repeated.ID)
}
