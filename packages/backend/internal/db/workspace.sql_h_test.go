package db

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestWorkspaceFailureTransitionsAreFencedAgainstProvisioning(t *testing.T) {
	ctx := context.Background()
	q, pool := newQueries(t)
	ownerID, repoID := mustCreateUserAndRepo(t, pool, uniqueTestUsername(t), uniqueTestRepoName(t))

	stale := workspaceSQLHCreateWorkspace(t, q, repoID, ownerID, "stale-cas", "pending", true)
	// Give PostgreSQL's timestamp a distinguishable value even when the test
	// transaction's NOW() is stable.
	newerUpdatedAt := stale.UpdatedAt.Add(time.Second)
	_, err := pool.Exec(ctx, `
		UPDATE workspaces
		SET status = 'running', vm_id = 'vm-winner', updated_at = $2
		WHERE id = $1
	`, stale.ID, newerUpdatedAt)
	require.NoError(t, err)

	_, err = q.FailWorkspaceIfUnchanged(ctx, FailWorkspaceIfUnchangedParams{
		ID: stale.ID, ExpectedStatus: stale.Status, ExpectedVmID: stale.VmID,
		ExpectedUpdatedAt: stale.UpdatedAt,
	})
	require.ErrorIs(t, err, pgx.ErrNoRows)
	current, err := q.GetWorkspace(ctx, stale.ID)
	require.NoError(t, err)
	assert.Equal(t, "running", current.Status)
	assert.Equal(t, "vm-winner", current.VmID)

	exact := workspaceSQLHCreateWorkspace(t, q, repoID, ownerID, "exact-cas", "pending", true)
	failed, err := q.FailWorkspaceIfUnchanged(ctx, FailWorkspaceIfUnchangedParams{
		FailureCode: "provisioning_failed", FailureMessage: "workspace provisioning timed out",
		ID: exact.ID, ExpectedStatus: exact.Status, ExpectedVmID: exact.VmID,
		ExpectedUpdatedAt: exact.UpdatedAt,
	})
	require.NoError(t, err)
	assert.Equal(t, "failed", failed.Status)
	assert.Equal(t, "provisioning_failed", failed.FailureCode.String)
	assert.Equal(t, "workspace provisioning timed out", failed.FailureMessage.String)

	registered := workspaceSQLHCreateWorkspace(t, q, repoID, ownerID, "provision-cas", "pending", true)
	_, err = q.RegisterWorkspaceVM(ctx, RegisterWorkspaceVMParams{
		ID: registered.ID, VmID: "vm-registered", Status: "starting",
	})
	require.NoError(t, err)
	_, err = q.FailProvisioningWorkspaceIfCurrent(ctx, FailProvisioningWorkspaceIfCurrentParams{
		FailureCode: "egress_proxy_unavailable", FailureMessage: "egress proxy unavailable",
		ID: registered.ID, ExpectedStatus: "pending", ExpectedVmID: "", ExpectedUpdatedAt: registered.UpdatedAt,
	})
	require.ErrorIs(t, err, pgx.ErrNoRows)
	current, err = q.GetWorkspace(ctx, registered.ID)
	require.NoError(t, err)
	assert.Equal(t, "starting", current.Status)
	assert.Equal(t, "vm-registered", current.VmID)

	reused := workspaceSQLHCreateWorkspace(t, q, repoID, ownerID, "provision-aba", "pending", true)
	_, err = pool.Exec(ctx, `UPDATE workspaces SET updated_at = $2 WHERE id = $1`, reused.ID, reused.UpdatedAt.Add(time.Second))
	require.NoError(t, err)
	_, err = q.FailProvisioningWorkspaceIfCurrent(ctx, FailProvisioningWorkspaceIfCurrentParams{
		FailureCode: "provisioning_failed", FailureMessage: "workspace provisioning timed out",
		ID: reused.ID, ExpectedStatus: reused.Status, ExpectedVmID: reused.VmID, ExpectedUpdatedAt: reused.UpdatedAt,
	})
	require.ErrorIs(t, err, pgx.ErrNoRows, "an empty-VM attempt must not fail a reused pending row")

	// Failure and its retryable cleanup receipt are one durable transition.
	current, err = q.GetWorkspace(ctx, reused.ID)
	require.NoError(t, err)
	failed, err = q.FailProvisioningWorkspaceIfCurrent(ctx, FailProvisioningWorkspaceIfCurrentParams{
		CleanupStage: "start_cleanup_pending",
		FailureCode:  "provisioning_failed", FailureMessage: "workspace repository advertisement could not be verified",
		ID: current.ID, ExpectedStatus: current.Status, ExpectedVmID: current.VmID, ExpectedUpdatedAt: current.UpdatedAt,
	})
	require.NoError(t, err)
	assert.Equal(t, "failed", failed.Status)
	assert.Equal(t, "start_cleanup_pending", failed.ProvisioningStage)
	assert.Equal(t, "workspace repository advertisement could not be verified", failed.FailureMessage.String)
}

func TestWorkspaceSQL_H_WorkspaceSessionSnapshotRoundTrip(t *testing.T) {
	ctx := context.Background()
	q, pool := newQueries(t)
	ownerID, repoID := mustCreateUserAndRepo(t, pool, uniqueTestUsername(t), uniqueTestRepoName(t))
	granteeID := mustCreateUser(t, pool, uniqueTestUsername(t))

	workspace := workspaceSQLHCreateWorkspace(t, q, repoID, ownerID, "primary", "pending", false)

	workspacesCount, err := q.CountWorkspacesByRepo(ctx, CountWorkspacesByRepoParams{RepositoryID: repoID, UserID: ownerID})
	require.NoError(t, err)
	assert.Equal(t, int64(1), workspacesCount)

	_, err = q.GetActiveWorkspaceForUserRepo(ctx, GetActiveWorkspaceForUserRepoParams{RepositoryID: repoID, UserID: ownerID})
	require.ErrorIs(t, err, pgx.ErrNoRows)

	byRepo, err := q.GetWorkspaceByRepo(ctx, GetWorkspaceByRepoParams{ID: workspace.ID, RepositoryID: repoID})
	require.NoError(t, err)
	assert.Equal(t, workspace.ID, byRepo.ID)

	byUser, err := q.GetWorkspaceForUserRepo(ctx, GetWorkspaceForUserRepoParams{ID: workspace.ID, RepositoryID: repoID, UserID: ownerID})
	require.NoError(t, err)
	assert.Equal(t, workspace.ID, byUser.ID)

	executing, err := q.UpdateWorkspaceExecutionInfo(ctx, UpdateWorkspaceExecutionInfoParams{ID: workspace.ID, VmID: "vm-h-primary", Status: "running"})
	require.NoError(t, err)
	assert.Equal(t, "running", executing.Status)
	assert.Equal(t, "vm-h-primary", executing.VmID)

	active, err := q.GetActiveWorkspaceForUserRepo(ctx, GetActiveWorkspaceForUserRepoParams{RepositoryID: repoID, UserID: ownerID})
	require.NoError(t, err)
	assert.Equal(t, workspace.ID, active.ID)

	renamed, err := q.UpdateWorkspaceTargetBookmark(ctx, UpdateWorkspaceTargetBookmarkParams{ID: workspace.ID, TargetBookmark: "feature/h"})
	require.NoError(t, err)
	assert.Equal(t, "feature/h", renamed.TargetBookmark)

	suspendedByStatus, err := q.UpdateWorkspaceStatus(ctx, UpdateWorkspaceStatusParams{ID: workspace.ID, Status: "suspended"})
	require.NoError(t, err)
	assert.True(t, suspendedByStatus.SuspendedAt.Valid)

	runningAgain, err := q.UpdateWorkspaceStatus(ctx, UpdateWorkspaceStatusParams{ID: workspace.ID, Status: "running"})
	require.NoError(t, err)
	assert.False(t, runningAgain.SuspendedAt.Valid)

	suspended, err := q.SuspendRunningWorkspace(ctx, workspace.ID)
	require.NoError(t, err)
	assert.Equal(t, "suspended", suspended.Status)
	assert.True(t, suspended.SuspendedAt.Valid)

	_, err = q.SuspendRunningWorkspace(ctx, workspace.ID)
	require.ErrorIs(t, err, pgx.ErrNoRows)

	require.NoError(t, q.TouchWorkspaceActivity(ctx, workspace.ID))
	require.NoError(t, q.TouchWorkspaceLastAccessed(ctx, workspace.ID))

	definition, err := q.UpsertWorkspaceWorkflowDefinition(ctx, repoID)
	require.NoError(t, err)
	assert.Equal(t, ".smithers/workspace", definition.Path)
	definitionAgain, err := q.UpsertWorkspaceWorkflowDefinition(ctx, repoID)
	require.NoError(t, err)
	assert.Equal(t, definition.ID, definitionAgain.ID)

	session, err := q.CreateWorkspaceSession(ctx, CreateWorkspaceSessionParams{
		WorkspaceID: workspace.ID, RepositoryID: repoID, UserID: ownerID, Cols: 100, Rows: 40,
	})
	require.NoError(t, err)
	assert.Equal(t, "pending", session.Status)

	sessionByID, err := q.GetWorkspaceSession(ctx, session.ID)
	require.NoError(t, err)
	assert.Equal(t, session.ID, sessionByID.ID)

	sessionByRepo, err := q.GetWorkspaceSessionByRepo(ctx, GetWorkspaceSessionByRepoParams{ID: session.ID, RepositoryID: repoID})
	require.NoError(t, err)
	assert.Equal(t, session.ID, sessionByRepo.ID)

	sessionByUser, err := q.GetWorkspaceSessionForUserRepo(ctx, GetWorkspaceSessionForUserRepoParams{ID: session.ID, RepositoryID: repoID, UserID: ownerID})
	require.NoError(t, err)
	assert.Equal(t, session.ID, sessionByUser.ID)

	sshInfo := json.RawMessage(`{"host":"127.0.0.1","port":2222}`)
	withSSH, err := q.UpdateWorkspaceSessionSSHConnectionInfo(ctx, UpdateWorkspaceSessionSSHConnectionInfoParams{ID: session.ID, SshConnectionInfo: sshInfo})
	require.NoError(t, err)
	assert.JSONEq(t, string(sshInfo), string(withSSH.SshConnectionInfo))

	runningSession, err := q.UpdateWorkspaceSessionStatus(ctx, UpdateWorkspaceSessionStatusParams{ID: session.ID, Status: "running"})
	require.NoError(t, err)
	assert.Equal(t, "running", runningSession.Status)
	require.NoError(t, q.TouchWorkspaceSessionActivity(ctx, session.ID))

	pendingSession, err := q.CreateWorkspaceSession(ctx, CreateWorkspaceSessionParams{
		WorkspaceID: workspace.ID, RepositoryID: repoID, UserID: ownerID, Cols: 80, Rows: 24,
	})
	require.NoError(t, err)

	activeForUser, err := q.CountActiveSessionsForUser(ctx, ownerID)
	require.NoError(t, err)
	assert.Equal(t, int64(2), activeForUser)

	activeForWorkspace, err := q.CountActiveSessionsForWorkspace(ctx, workspace.ID)
	require.NoError(t, err)
	assert.Equal(t, int64(2), activeForWorkspace)

	sessionCount, err := q.CountWorkspaceSessionsByRepo(ctx, CountWorkspaceSessionsByRepoParams{RepositoryID: repoID, UserID: ownerID})
	require.NoError(t, err)
	assert.Equal(t, int64(2), sessionCount)

	pendingSessions, err := q.ListPendingSessionsForWorkspace(ctx, workspace.ID)
	require.NoError(t, err)
	require.Len(t, pendingSessions, 1)
	assert.Equal(t, pendingSession.ID, pendingSessions[0].ID)

	sessions, err := q.ListWorkspaceSessionsByRepo(ctx, ListWorkspaceSessionsByRepoParams{RepositoryID: repoID, UserID: ownerID, PageOffset: 0, PageSize: 10})
	require.NoError(t, err)
	require.Len(t, sessions, 2)

	snapshot, err := q.CreateWorkspaceSnapshot(ctx, CreateWorkspaceSnapshotParams{
		RepositoryID: repoID, UserID: ownerID, WorkspaceID: workspace.ID, Name: "snap-h", SnapshotID: "snapshot-h-1",
	})
	require.NoError(t, err)

	snapshotCount, err := q.CountWorkspaceSnapshotsByRepo(ctx, CountWorkspaceSnapshotsByRepoParams{RepositoryID: repoID, UserID: ownerID})
	require.NoError(t, err)
	assert.Equal(t, int64(1), snapshotCount)

	gotSnapshot, err := q.GetWorkspaceSnapshot(ctx, snapshot.ID)
	require.NoError(t, err)
	assert.Equal(t, snapshot.ID, gotSnapshot.ID)

	snapshotByRepo, err := q.GetWorkspaceSnapshotByRepo(ctx, GetWorkspaceSnapshotByRepoParams{ID: snapshot.ID, RepositoryID: repoID})
	require.NoError(t, err)
	assert.Equal(t, snapshot.ID, snapshotByRepo.ID)

	snapshotByUser, err := q.GetWorkspaceSnapshotForUserRepo(ctx, GetWorkspaceSnapshotForUserRepoParams{ID: snapshot.ID, RepositoryID: repoID, UserID: ownerID})
	require.NoError(t, err)
	assert.Equal(t, snapshot.ID, snapshotByUser.ID)

	snapshots, err := q.ListWorkspaceSnapshotsByRepo(ctx, ListWorkspaceSnapshotsByRepoParams{RepositoryID: repoID, UserID: ownerID, PageOffset: 0, PageSize: 10})
	require.NoError(t, err)
	require.Len(t, snapshots, 1)

	share, err := q.UpsertWorkspaceShare(ctx, UpsertWorkspaceShareParams{
		WorkspaceID: workspace.ID, OwnerUserID: ownerID, GranteeUserID: granteeID, Level: "read",
	})
	require.NoError(t, err)
	assert.Equal(t, "read", share.Level)

	share, err = q.UpsertWorkspaceShare(ctx, UpsertWorkspaceShareParams{
		WorkspaceID: workspace.ID, OwnerUserID: ownerID, GranteeUserID: granteeID, Level: "write",
	})
	require.NoError(t, err)
	assert.Equal(t, "write", share.Level)

	gotShare, err := q.GetWorkspaceShare(ctx, GetWorkspaceShareParams{WorkspaceID: workspace.ID, GranteeUserID: granteeID})
	require.NoError(t, err)
	assert.Equal(t, "write", gotShare.Level)

	require.NoError(t, q.DeleteWorkspaceShare(ctx, DeleteWorkspaceShareParams{WorkspaceID: workspace.ID, GranteeUserID: granteeID}))
	_, err = q.GetWorkspaceShare(ctx, GetWorkspaceShareParams{WorkspaceID: workspace.ID, GranteeUserID: granteeID})
	require.ErrorIs(t, err, pgx.ErrNoRows)

	_, err = q.UpsertWorkspaceShare(ctx, UpsertWorkspaceShareParams{
		WorkspaceID: workspace.ID, OwnerUserID: ownerID, GranteeUserID: granteeID, Level: "read",
	})
	require.NoError(t, err)
	require.NoError(t, q.DeleteWorkspaceSharesForWorkspace(ctx, workspace.ID))
	_, err = q.GetWorkspaceShare(ctx, GetWorkspaceShareParams{WorkspaceID: workspace.ID, GranteeUserID: granteeID})
	require.ErrorIs(t, err, pgx.ErrNoRows)

	workspaces, err := q.ListWorkspacesByRepo(ctx, ListWorkspacesByRepoParams{RepositoryID: repoID, UserID: ownerID, PageOffset: 0, PageSize: 10})
	require.NoError(t, err)
	require.NotEmpty(t, workspaces)

	acrossRepos, err := q.ListUserWorkspacesAcrossRepos(ctx, ListUserWorkspacesAcrossReposParams{UserID: ownerID, PageOffset: 0, PageSize: 10})
	require.NoError(t, err)
	require.NotEmpty(t, acrossRepos)
	assert.Equal(t, repoID, acrossRepos[0].RepositoryID)

	require.NoError(t, q.NotifyWorkspaceStatus(ctx, NotifyWorkspaceStatusParams{SessionID: session.ID, Payload: `{"status":"running"}`}))

	require.NoError(t, q.DeleteWorkspaceSnapshot(ctx, snapshot.ID))
	_, err = q.GetWorkspaceSnapshot(ctx, snapshot.ID)
	require.ErrorIs(t, err, pgx.ErrNoRows)
	require.NoError(t, q.DeleteWorkspaceSnapshot(ctx, snapshot.ID))

	deleted, err := q.SoftDeleteWorkspace(ctx, workspace.ID)
	require.NoError(t, err)
	assert.Equal(t, "stopped", deleted.Status)
	assert.True(t, deleted.DeletedAt.Valid)

	_, err = q.GetWorkspaceByRepo(ctx, GetWorkspaceByRepoParams{ID: workspace.ID, RepositoryID: repoID})
	require.ErrorIs(t, err, pgx.ErrNoRows)

	visibleAfterDelete, err := q.CountWorkspacesByRepo(ctx, CountWorkspacesByRepoParams{RepositoryID: repoID, UserID: ownerID})
	require.NoError(t, err)
	assert.Zero(t, visibleAfterDelete)
}

func TestWorkspaceSQL_H_IdleAndStaleListings(t *testing.T) {
	ctx := context.Background()
	q, pool := newQueries(t)
	userID, repoID := mustCreateUserAndRepo(t, pool, uniqueTestUsername(t), uniqueTestRepoName(t))

	idleWorkspace := workspaceSQLHCreateWorkspace(t, q, repoID, userID, "idle", "running", true)
	mustExec(t, pool, `UPDATE workspaces SET last_activity_at = NOW() - INTERVAL '2 hours', idle_timeout_secs = 1 WHERE id = $1`, idleWorkspace.ID)

	idleWorkspaces, err := q.ListIdleWorkspaces(ctx)
	require.NoError(t, err)
	assert.True(t, workspaceSQLHHasWorkspace(idleWorkspaces, idleWorkspace.ID))

	session, err := q.CreateWorkspaceSession(ctx, CreateWorkspaceSessionParams{
		WorkspaceID: idleWorkspace.ID, RepositoryID: repoID, UserID: userID, Cols: 80, Rows: 24,
	})
	require.NoError(t, err)
	_, err = q.UpdateWorkspaceSessionStatus(ctx, UpdateWorkspaceSessionStatusParams{ID: session.ID, Status: "running"})
	require.NoError(t, err)
	mustExec(t, pool, `UPDATE workspace_sessions SET last_activity_at = NOW() - INTERVAL '2 hours', idle_timeout_secs = 1 WHERE id = $1`, session.ID)

	idleSessions, err := q.ListIdleWorkspaceSessions(ctx)
	require.NoError(t, err)
	assert.True(t, workspaceSQLHHasSession(idleSessions, session.ID))

	stalePending := workspaceSQLHCreateWorkspace(t, q, repoID, userID, "stale", "pending", true)
	mustExec(t, pool, `UPDATE workspaces SET updated_at = NOW() - INTERVAL '2 hours' WHERE id = $1`, stalePending.ID)

	stale, err := q.ListStalePendingWorkspaces(ctx, 1)
	require.NoError(t, err)
	assert.True(t, workspaceSQLHHasWorkspace(stale, stalePending.ID))

	missingPending, err := q.ListPendingSessionsForWorkspace(ctx, "00000000-0000-0000-0000-000000000000")
	require.NoError(t, err)
	assert.Empty(t, missingPending)
}

func TestWorkspaceSQL_H_MissingRowsAndConstraintErrors(t *testing.T) {
	ctx := context.Background()
	q, pool := newQueries(t)
	userID, repoID := mustCreateUserAndRepo(t, pool, uniqueTestUsername(t), uniqueTestRepoName(t))
	missingID := "00000000-0000-0000-0000-000000000000"

	_, err := q.GetWorkspaceForUserRepo(ctx, GetWorkspaceForUserRepoParams{ID: missingID, RepositoryID: repoID, UserID: userID})
	require.ErrorIs(t, err, pgx.ErrNoRows)
	_, err = q.GetWorkspaceSession(ctx, missingID)
	require.ErrorIs(t, err, pgx.ErrNoRows)
	_, err = q.GetWorkspaceSnapshotByRepo(ctx, GetWorkspaceSnapshotByRepoParams{ID: missingID, RepositoryID: repoID})
	require.ErrorIs(t, err, pgx.ErrNoRows)
	_, err = q.UpdateWorkspaceSessionStatus(ctx, UpdateWorkspaceSessionStatusParams{ID: missingID, Status: "running"})
	require.ErrorIs(t, err, pgx.ErrNoRows)
	_, err = q.UpdateWorkspaceExecutionInfo(ctx, UpdateWorkspaceExecutionInfoParams{ID: missingID, VmID: "vm-missing", Status: "running"})
	require.ErrorIs(t, err, pgx.ErrNoRows)
	_, err = q.UpdateWorkspaceTargetBookmark(ctx, UpdateWorkspaceTargetBookmarkParams{ID: missingID, TargetBookmark: "none"})
	require.ErrorIs(t, err, pgx.ErrNoRows)
	_, err = q.SoftDeleteWorkspace(ctx, missingID)
	require.ErrorIs(t, err, pgx.ErrNoRows)

	mustExpectQueryError(t, pool, func(spQ *Queries) error {
		_, err := spQ.CreateWorkspaceSession(ctx, CreateWorkspaceSessionParams{
			WorkspaceID: missingID, RepositoryID: repoID, UserID: userID, Cols: 80, Rows: 24,
		})
		return err
	})
	mustExpectQueryError(t, pool, func(spQ *Queries) error {
		_, err := spQ.CreateWorkspaceSnapshot(ctx, CreateWorkspaceSnapshotParams{
			RepositoryID: 999999999, UserID: userID, WorkspaceID: missingID, Name: "bad", SnapshotID: "bad",
		})
		return err
	})
	mustExpectQueryError(t, pool, func(spQ *Queries) error {
		_, err := spQ.UpsertWorkspaceWorkflowDefinition(ctx, 999999999)
		return err
	})
}

func TestWorkspaceSQL_H_ManyErrorBranches(t *testing.T) {
	sentinel := errors.New("workspace h rows failed")
	cases := []struct {
		name string
		call func(*Queries) error
	}{
		{"ListIdleWorkspaceSessions", func(q *Queries) error { _, err := q.ListIdleWorkspaceSessions(context.Background()); return err }},
		{"ListIdleWorkspaces", func(q *Queries) error { _, err := q.ListIdleWorkspaces(context.Background()); return err }},
		{"ListPendingSessionsForWorkspace", func(q *Queries) error {
			_, err := q.ListPendingSessionsForWorkspace(context.Background(), "00000000-0000-0000-0000-000000000000")
			return err
		}},
		{"ListStalePendingWorkspaces", func(q *Queries) error { _, err := q.ListStalePendingWorkspaces(context.Background(), 1); return err }},
		{"ListUserWorkspacesAcrossRepos", func(q *Queries) error {
			_, err := q.ListUserWorkspacesAcrossRepos(context.Background(), ListUserWorkspacesAcrossReposParams{UserID: 1, PageOffset: 0, PageSize: 1})
			return err
		}},
		{"ListWorkspaceSessionsByRepo", func(q *Queries) error {
			_, err := q.ListWorkspaceSessionsByRepo(context.Background(), ListWorkspaceSessionsByRepoParams{RepositoryID: 1, UserID: 1, PageOffset: 0, PageSize: 1})
			return err
		}},
		{"ListWorkspaceSnapshotsByRepo", func(q *Queries) error {
			_, err := q.ListWorkspaceSnapshotsByRepo(context.Background(), ListWorkspaceSnapshotsByRepoParams{RepositoryID: 1, UserID: 1, PageOffset: 0, PageSize: 1})
			return err
		}},
		{"ListWorkspacesByRepo", func(q *Queries) error {
			_, err := q.ListWorkspacesByRepo(context.Background(), ListWorkspacesByRepoParams{RepositoryID: 1, UserID: 1, PageOffset: 0, PageSize: 1})
			return err
		}},
	}

	for _, tc := range cases {
		t.Run(tc.name+"_query", func(t *testing.T) {
			err := tc.call(New(workspaceSQLHDB{queryErr: sentinel}))
			require.ErrorIs(t, err, sentinel)
		})
		t.Run(tc.name+"_scan", func(t *testing.T) {
			err := tc.call(New(workspaceSQLHDB{rows: &workspaceSQLHRows{next: true, scanErr: sentinel}}))
			require.ErrorIs(t, err, sentinel)
		})
		t.Run(tc.name+"_rows_err", func(t *testing.T) {
			err := tc.call(New(workspaceSQLHDB{rows: &workspaceSQLHRows{err: sentinel}}))
			require.ErrorIs(t, err, sentinel)
		})
	}
}

func TestWorkspaceSQL_H_ExecErrorBranches(t *testing.T) {
	sentinel := errors.New("workspace h exec failed")
	q := New(workspaceSQLHDB{execErr: sentinel})
	cases := []struct {
		name string
		call func() error
	}{
		{"DeleteWorkspaceShare", func() error {
			return q.DeleteWorkspaceShare(context.Background(), DeleteWorkspaceShareParams{WorkspaceID: "00000000-0000-0000-0000-000000000000", GranteeUserID: 1})
		}},
		{"DeleteWorkspaceSharesForWorkspace", func() error {
			return q.DeleteWorkspaceSharesForWorkspace(context.Background(), "00000000-0000-0000-0000-000000000000")
		}},
		{"DeleteWorkspaceSnapshot", func() error {
			return q.DeleteWorkspaceSnapshot(context.Background(), "00000000-0000-0000-0000-000000000000")
		}},
		{"NotifyWorkspaceStatus", func() error {
			return q.NotifyWorkspaceStatus(context.Background(), NotifyWorkspaceStatusParams{SessionID: "00000000-0000-0000-0000-000000000000", Payload: "{}"})
		}},
		{"TouchWorkspaceActivity", func() error {
			return q.TouchWorkspaceActivity(context.Background(), "00000000-0000-0000-0000-000000000000")
		}},
		{"TouchWorkspaceLastAccessed", func() error {
			return q.TouchWorkspaceLastAccessed(context.Background(), "00000000-0000-0000-0000-000000000000")
		}},
		{"TouchWorkspaceSessionActivity", func() error {
			return q.TouchWorkspaceSessionActivity(context.Background(), "00000000-0000-0000-0000-000000000000")
		}},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			require.ErrorIs(t, tc.call(), sentinel)
		})
	}
}

func workspaceSQLHCreateWorkspace(t *testing.T, q *Queries, repoID, userID int64, name, status string, isFork bool) Workspace {
	t.Helper()
	workspace, err := q.CreateWorkspace(context.Background(), CreateWorkspaceParams{
		RepositoryID:      repoID,
		UserID:            userID,
		Name:              name,
		IsFork:            isFork,
		ParentWorkspaceID: pgtype.UUID{},
		SourceSnapshotID:  pgtype.UUID{},
		TargetBookmark:    "main",
		Status:            status,
	})
	require.NoError(t, err)
	return workspace
}

func workspaceSQLHHasWorkspace(workspaces []Workspace, id string) bool {
	for _, workspace := range workspaces {
		if workspace.ID == id {
			return true
		}
	}
	return false
}

func workspaceSQLHHasSession(sessions []WorkspaceSession, id string) bool {
	for _, session := range sessions {
		if session.ID == id {
			return true
		}
	}
	return false
}

type workspaceSQLHDB struct {
	execErr  error
	queryErr error
	rows     pgx.Rows
	row      pgx.Row
}

func (db workspaceSQLHDB) Exec(context.Context, string, ...interface{}) (pgconn.CommandTag, error) {
	return pgconn.CommandTag{}, db.execErr
}

func (db workspaceSQLHDB) Query(context.Context, string, ...interface{}) (pgx.Rows, error) {
	if db.queryErr != nil {
		return nil, db.queryErr
	}
	if db.rows != nil {
		return db.rows, nil
	}
	return &workspaceSQLHRows{}, nil
}

func (db workspaceSQLHDB) QueryRow(context.Context, string, ...interface{}) pgx.Row {
	if db.row != nil {
		return db.row
	}
	return workspaceSQLHRow{err: errors.New("workspace h row failed")}
}

type workspaceSQLHRow struct {
	err error
}

func (r workspaceSQLHRow) Scan(...any) error {
	return r.err
}

type workspaceSQLHRows struct {
	next    bool
	scanErr error
	err     error
}

func (r *workspaceSQLHRows) Close() {}

func (r *workspaceSQLHRows) Err() error {
	return r.err
}

func (r *workspaceSQLHRows) CommandTag() pgconn.CommandTag {
	return pgconn.CommandTag{}
}

func (r *workspaceSQLHRows) FieldDescriptions() []pgconn.FieldDescription {
	return nil
}

func (r *workspaceSQLHRows) Next() bool {
	if r.next {
		r.next = false
		return true
	}
	return false
}

func (r *workspaceSQLHRows) Scan(...any) error {
	if r.scanErr != nil {
		return r.scanErr
	}
	return errors.New("workspace h scan unexpectedly succeeded")
}

func (r *workspaceSQLHRows) Values() ([]any, error) {
	return nil, r.err
}

func (r *workspaceSQLHRows) RawValues() [][]byte {
	return nil
}

func (r *workspaceSQLHRows) Conn() *pgx.Conn {
	return nil
}
