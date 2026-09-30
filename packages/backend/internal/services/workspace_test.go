package services

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/sandbox"
)

const testWorkspaceGitBaseURL = "http://localhost"
const maxActiveSessions = 10

func newWorkspaceServiceForTests(q WorkspaceQuerier, opts ...WorkspaceServiceOption) *WorkspaceService {
	return NewWorkspaceService(q, append([]WorkspaceServiceOption{
		WithWorkspaceGitBaseURL(testWorkspaceGitBaseURL),
		func(s *WorkspaceService) { s.launchSessionCleanup = func(_ string, fn func()) { fn() } },
		// Mocked provisioning settles at once, but a loaded runner can delay the
		// provisioning goroutine past the production grace and turn a synchronous
		// outcome into the pending ticket. Tests of that deferral opt back in
		// with withProductionProvisionGrace.
		func(s *WorkspaceService) { s.sessionProvisionGrace = time.Minute },
	}, opts...)...)
}

// withProductionProvisionGrace restores the grace CreateSession uses in
// production, for tests of the pending-ticket deferral itself.
func withProductionProvisionGrace(s *WorkspaceService) {
	s.sessionProvisionGrace = workspaceSessionProvisionGrace
}

type mockWorkspaceQuerier struct {
	sandboxUsageRecorder
	getRepoByIDFn                          func(ctx context.Context, id int64) (db.Repository, error)
	createWorkspaceFn                      func(ctx context.Context, arg db.CreateWorkspaceParams) (db.Workspace, error)
	getWorkspaceFn                         func(ctx context.Context, id string) (db.Workspace, error)
	getWorkspaceByRepoFn                   func(ctx context.Context, arg db.GetWorkspaceByRepoParams) (db.Workspace, error)
	getWorkspaceForUserRepoFn              func(ctx context.Context, arg db.GetWorkspaceForUserRepoParams) (db.Workspace, error)
	listWorkspacesByRepoFn                 func(ctx context.Context, arg db.ListWorkspacesByRepoParams) ([]db.Workspace, error)
	countWorkspacesByRepoFn                func(ctx context.Context, arg db.CountWorkspacesByRepoParams) (int64, error)
	countActiveWorkspacesByUserFn          func(ctx context.Context, userID int64) (int64, error)
	getActiveWorkspaceForUserRepoFn        func(ctx context.Context, arg db.GetActiveWorkspaceForUserRepoParams) (db.Workspace, error)
	getActiveWorkspaceForUserRepoKindFn    func(ctx context.Context, arg db.GetActiveWorkspaceForUserRepoKindParams) (db.Workspace, error)
	getActiveWorkspaceForIdentityFn        func(ctx context.Context, arg db.GetActiveWorkspaceForIdentityParams) (db.Workspace, error)
	updateWorkspaceStatusFn                func(ctx context.Context, arg db.UpdateWorkspaceStatusParams) (db.Workspace, error)
	suspendRunningWorkspaceFn              func(ctx context.Context, id string) (db.Workspace, error)
	suspendRunningWorkspaceIfSessionlessFn func(ctx context.Context, id string) (db.Workspace, error)
	resumeWorkspaceToRunningFn             func(ctx context.Context, id string) (db.Workspace, error)
	markWorkspaceSessionRunningFn          func(ctx context.Context, id string) (db.WorkspaceSession, error)
	failActiveWorkspaceSessionFn           func(ctx context.Context, id string) (db.WorkspaceSession, error)
	listStaleStartingWorkspacesWithVMFn    func(ctx context.Context, staleAfterSecs int32) ([]db.Workspace, error)
	failStaleStartingWorkspaceFn           func(ctx context.Context, arg db.FailStaleStartingWorkspaceParams) (db.Workspace, error)
	updateWorkspaceExecutionInfoFn         func(ctx context.Context, arg db.UpdateWorkspaceExecutionInfoParams) (db.Workspace, error)
	markWorkspaceResumedFn                 func(ctx context.Context, arg db.MarkWorkspaceResumedParams) error
	updateWorkspaceHeadFn                  func(ctx context.Context, arg db.UpdateWorkspaceHeadParams) (db.Workspace, error)
	updateWorkspaceTargetBookmarkFn        func(ctx context.Context, arg db.UpdateWorkspaceTargetBookmarkParams) (db.Workspace, error)
	softDeleteWorkspaceFn                  func(ctx context.Context, id string) (db.Workspace, error)
	touchWorkspaceActivityFn               func(ctx context.Context, id string) error
	touchWorkspaceLastAccessedFn           func(ctx context.Context, id string) error
	listUserWorkspacesAcrossReposFn        func(ctx context.Context, arg db.ListUserWorkspacesAcrossReposParams) ([]db.ListUserWorkspacesAcrossReposRow, error)
	countUserWorkspacesAcrossReposFn       func(ctx context.Context, userID int64) (int64, error)
	countActiveSessionsForWorkspaceFn      func(ctx context.Context, workspaceID string) (int64, error)
	countActiveSessionsForUserFn           func(ctx context.Context, userID int64) (int64, error)
	listIdleWorkspacesFn                   func(ctx context.Context) ([]db.Workspace, error)
	listRunningWorkspacesFn                func(ctx context.Context) ([]db.Workspace, error)
	listStalePendingWorkspacesFn           func(ctx context.Context, staleAfterSecs int32) ([]db.Workspace, error)
	createWorkspaceSnapshotFn              func(ctx context.Context, arg db.CreateWorkspaceSnapshotParams) (db.WorkspaceSnapshot, error)
	getWorkspaceSnapshotFn                 func(ctx context.Context, id string) (db.WorkspaceSnapshot, error)
	getWorkspaceSnapshotByRepoFn           func(ctx context.Context, arg db.GetWorkspaceSnapshotByRepoParams) (db.WorkspaceSnapshot, error)
	getWorkspaceSnapshotForUserRepoFn      func(ctx context.Context, arg db.GetWorkspaceSnapshotForUserRepoParams) (db.WorkspaceSnapshot, error)
	listWorkspaceSnapshotsByRepoFn         func(ctx context.Context, arg db.ListWorkspaceSnapshotsByRepoParams) ([]db.WorkspaceSnapshot, error)
	countWorkspaceSnapshotsByRepoFn        func(ctx context.Context, arg db.CountWorkspaceSnapshotsByRepoParams) (int64, error)
	deleteWorkspaceSnapshotFn              func(ctx context.Context, id string) error
	createWorkspaceSessionFn               func(ctx context.Context, arg db.CreateWorkspaceSessionParams) (db.WorkspaceSession, error)
	createWorkspaceLSPSessionFn            func(ctx context.Context, arg db.CreateWorkspaceLSPSessionParams) (db.WorkspaceSession, error)
	getActiveWorkspaceLSPSessionFn         func(ctx context.Context, arg db.GetActiveWorkspaceLSPSessionParams) (db.WorkspaceSession, error)
	getWorkspaceSessionFn                  func(ctx context.Context, id string) (db.WorkspaceSession, error)
	getWorkspaceSessionByRepoFn            func(ctx context.Context, arg db.GetWorkspaceSessionByRepoParams) (db.WorkspaceSession, error)
	getWorkspaceSessionForUserRepoFn       func(ctx context.Context, arg db.GetWorkspaceSessionForUserRepoParams) (db.WorkspaceSession, error)
	listWorkspaceSessionsByRepoFn          func(ctx context.Context, arg db.ListWorkspaceSessionsByRepoParams) ([]db.WorkspaceSession, error)
	countWorkspaceSessionsByRepoFn         func(ctx context.Context, arg db.CountWorkspaceSessionsByRepoParams) (int64, error)
	updateWorkspaceSessionStatusFn         func(ctx context.Context, arg db.UpdateWorkspaceSessionStatusParams) (db.WorkspaceSession, error)
	updateWorkspaceSessionSSHConnectionFn  func(ctx context.Context, arg db.UpdateWorkspaceSessionSSHConnectionInfoParams) (db.WorkspaceSession, error)
	touchWorkspaceSessionActivityFn        func(ctx context.Context, id string) error
	listIdleWorkspaceSessionsFn            func(ctx context.Context) ([]db.WorkspaceSession, error)
	createAccessTokenFn                    func(ctx context.Context, arg db.CreateAccessTokenParams) (db.AccessToken, error)
	deleteAccessTokenFn                    func(ctx context.Context, arg db.DeleteAccessTokenParams) error
	notifyWorkspaceStatusFn                func(ctx context.Context, arg db.NotifyWorkspaceStatusParams) error
	getWorkspaceShareFn                    func(ctx context.Context, arg db.GetWorkspaceShareParams) (db.WorkspaceShare, error)
	markSandboxAccessTokenUsedFn           func(ctx context.Context, id string) error
	deleteExpiredSandboxAccessTokensFn     func(ctx context.Context) error
}

func (m *mockWorkspaceQuerier) GetRepoByID(ctx context.Context, id int64) (db.Repository, error) {
	if m.getRepoByIDFn != nil {
		return m.getRepoByIDFn(ctx, id)
	}
	return db.Repository{ID: id, DefaultBookmark: "main"}, nil
}

func (m *mockWorkspaceQuerier) CreateWorkspace(ctx context.Context, arg db.CreateWorkspaceParams) (db.Workspace, error) {
	if m.createWorkspaceFn != nil {
		return m.createWorkspaceFn(ctx, arg)
	}
	return sampleDBWorkspace("ws-1"), nil
}

func (m *mockWorkspaceQuerier) IsOutsiderWorkspace(context.Context, string) (bool, error) {
	return false, nil
}

func (m *mockWorkspaceQuerier) MarkOutsiderWorkspace(context.Context, int64, string) error {
	return nil
}

func (m *mockWorkspaceQuerier) IsOutsiderWorkspaceEgressSealed(context.Context, string) (bool, error) {
	return false, nil
}

func (m *mockWorkspaceQuerier) SealOutsiderWorkspaceEgress(context.Context, string) error { return nil }

func (m *mockWorkspaceQuerier) GetWorkspace(ctx context.Context, id string) (db.Workspace, error) {
	if m.getWorkspaceFn != nil {
		return m.getWorkspaceFn(ctx, id)
	}
	return sampleDBWorkspace(id), nil
}

func (m *mockWorkspaceQuerier) GetWorkspaceByRepo(ctx context.Context, arg db.GetWorkspaceByRepoParams) (db.Workspace, error) {
	if m.getWorkspaceByRepoFn != nil {
		return m.getWorkspaceByRepoFn(ctx, arg)
	}
	return sampleDBWorkspace(arg.ID), nil
}

func (m *mockWorkspaceQuerier) GetWorkspaceForUserRepo(ctx context.Context, arg db.GetWorkspaceForUserRepoParams) (db.Workspace, error) {
	if m.getWorkspaceForUserRepoFn != nil {
		return m.getWorkspaceForUserRepoFn(ctx, arg)
	}
	return sampleDBWorkspace(arg.ID), nil
}

func (m *mockWorkspaceQuerier) ListWorkspacesByRepo(ctx context.Context, arg db.ListWorkspacesByRepoParams) ([]db.Workspace, error) {
	if m.listWorkspacesByRepoFn != nil {
		return m.listWorkspacesByRepoFn(ctx, arg)
	}
	return []db.Workspace{sampleDBWorkspace("ws-1")}, nil
}

func (m *mockWorkspaceQuerier) CountWorkspacesByRepo(ctx context.Context, arg db.CountWorkspacesByRepoParams) (int64, error) {
	if m.countWorkspacesByRepoFn != nil {
		return m.countWorkspacesByRepoFn(ctx, arg)
	}
	return 1, nil
}

func (m *mockWorkspaceQuerier) CountActiveWorkspacesByUser(ctx context.Context, userID int64) (int64, error) {
	if m.countActiveWorkspacesByUserFn != nil {
		return m.countActiveWorkspacesByUserFn(ctx, userID)
	}
	return 0, nil
}

func (m *mockWorkspaceQuerier) SoftDeleteWorkspace(ctx context.Context, id string) (db.Workspace, error) {
	if m.softDeleteWorkspaceFn != nil {
		return m.softDeleteWorkspaceFn(ctx, id)
	}
	workspace := sampleDBWorkspace(id)
	workspace.Status = "stopped"
	return workspace, nil
}

func (m *mockWorkspaceQuerier) GetActiveWorkspaceForUserRepo(ctx context.Context, arg db.GetActiveWorkspaceForUserRepoParams) (db.Workspace, error) {
	if m.getActiveWorkspaceForUserRepoFn != nil {
		return m.getActiveWorkspaceForUserRepoFn(ctx, arg)
	}
	return db.Workspace{}, pgx.ErrNoRows
}

func (m *mockWorkspaceQuerier) GetActiveWorkspaceForUserRepoKind(ctx context.Context, arg db.GetActiveWorkspaceForUserRepoKindParams) (db.Workspace, error) {
	if m.getActiveWorkspaceForUserRepoKindFn != nil {
		return m.getActiveWorkspaceForUserRepoKindFn(ctx, arg)
	}
	if m.getActiveWorkspaceForUserRepoFn != nil {
		return m.getActiveWorkspaceForUserRepoFn(ctx, db.GetActiveWorkspaceForUserRepoParams{
			RepositoryID: arg.RepositoryID,
			UserID:       arg.UserID,
		})
	}
	return db.Workspace{}, pgx.ErrNoRows
}

func (m *mockWorkspaceQuerier) GetActiveWorkspaceForIdentity(ctx context.Context, arg db.GetActiveWorkspaceForIdentityParams) (db.Workspace, error) {
	var rows []db.Workspace
	if m.getActiveWorkspaceForIdentityFn != nil {
		row, err := m.getActiveWorkspaceForIdentityFn(ctx, arg)
		if err != nil {
			return db.Workspace{}, err
		}
		rows = []db.Workspace{row}
	} else if m.listWorkspacesByRepoFn != nil {
		var err error
		rows, err = m.listWorkspacesByRepoFn(ctx, db.ListWorkspacesByRepoParams{RepositoryID: arg.RepositoryID, UserID: arg.UserID, PageSize: 100})
		if err != nil {
			return db.Workspace{}, err
		}
	}
	for _, row := range rows {
		active := row.Status == "pending" || row.Status == "starting" || row.Status == "running" || row.Status == "suspended"
		if row.RepositoryID == arg.RepositoryID && row.UserID == arg.UserID && row.Kind == arg.Kind &&
			row.Name == arg.Name && row.TargetBookmark == arg.TargetBookmark && active &&
			!row.DeletedAt.Valid && !row.ParentWorkspaceID.Valid && !row.SourceSnapshotID.Valid && !row.AgentSessionID.Valid {
			return row, nil
		}
	}
	return db.Workspace{}, pgx.ErrNoRows
}

func (m *mockWorkspaceQuerier) UpdateWorkspaceStatus(ctx context.Context, arg db.UpdateWorkspaceStatusParams) (db.Workspace, error) {
	if m.updateWorkspaceStatusFn != nil {
		return m.updateWorkspaceStatusFn(ctx, arg)
	}
	workspace := sampleDBWorkspace(arg.ID)
	workspace.Status = arg.Status
	return workspace, nil
}

func (m *mockWorkspaceQuerier) SuspendRunningWorkspace(ctx context.Context, id string) (db.Workspace, error) {
	if m.suspendRunningWorkspaceFn != nil {
		return m.suspendRunningWorkspaceFn(ctx, id)
	}
	workspace := sampleDBWorkspace(id)
	workspace.Status = "suspended"
	return workspace, nil
}

// SuspendRunningWorkspaceIfSessionless mirrors the real CAS semantics against
// the mock's own CountActiveSessionsForWorkspace / GetWorkspace hooks so tests
// exercising DestroySession keep their count-driven expectations.
func (m *mockWorkspaceQuerier) SuspendRunningWorkspaceIfSessionless(ctx context.Context, id string) (db.Workspace, error) {
	if m.suspendRunningWorkspaceIfSessionlessFn != nil {
		return m.suspendRunningWorkspaceIfSessionlessFn(ctx, id)
	}
	active, err := m.CountActiveSessionsForWorkspace(ctx, id)
	if err != nil || active > 0 {
		return db.Workspace{}, pgx.ErrNoRows
	}
	if current, getErr := m.GetWorkspace(ctx, id); getErr == nil && current.Status != "running" {
		return db.Workspace{}, pgx.ErrNoRows
	}
	return m.SuspendRunningWorkspace(ctx, id)
}

// ResumeWorkspaceToRunning delegates to the UpdateWorkspaceStatus hook so tests
// observing "running" writes keep working against the CAS-based resume path.
func (m *mockWorkspaceQuerier) ResumeWorkspaceToRunning(ctx context.Context, id string) (db.Workspace, error) {
	if m.resumeWorkspaceToRunningFn != nil {
		return m.resumeWorkspaceToRunningFn(ctx, id)
	}
	return m.UpdateWorkspaceStatus(ctx, db.UpdateWorkspaceStatusParams{ID: id, Status: "running"})
}

func (m *mockWorkspaceQuerier) UpdateWorkspaceExecutionInfo(ctx context.Context, arg db.UpdateWorkspaceExecutionInfoParams) (db.Workspace, error) {
	if m.updateWorkspaceExecutionInfoFn != nil {
		return m.updateWorkspaceExecutionInfoFn(ctx, arg)
	}
	workspace := sampleDBWorkspace(arg.ID)
	workspace.VmID = arg.VmID
	workspace.Status = arg.Status
	return workspace, nil
}

func (m *mockWorkspaceQuerier) MarkWorkspaceResumed(ctx context.Context, arg db.MarkWorkspaceResumedParams) error {
	if m.markWorkspaceResumedFn != nil {
		return m.markWorkspaceResumedFn(ctx, arg)
	}
	return nil
}

func (m *mockWorkspaceQuerier) UpdateWorkspaceHead(ctx context.Context, arg db.UpdateWorkspaceHeadParams) (db.Workspace, error) {
	if m.updateWorkspaceHeadFn != nil {
		return m.updateWorkspaceHeadFn(ctx, arg)
	}
	workspace := sampleDBWorkspace(arg.ID)
	workspace.HeadChangeID = arg.HeadChangeID
	workspace.HeadCommitID = arg.HeadCommitID
	workspace.Ahead = arg.Ahead
	workspace.Behind = arg.Behind
	return workspace, nil
}

func (m *mockWorkspaceQuerier) UpdateWorkspaceTargetBookmark(ctx context.Context, arg db.UpdateWorkspaceTargetBookmarkParams) (db.Workspace, error) {
	if m.updateWorkspaceTargetBookmarkFn != nil {
		return m.updateWorkspaceTargetBookmarkFn(ctx, arg)
	}
	workspace := sampleDBWorkspace(arg.ID)
	workspace.TargetBookmark = arg.TargetBookmark
	return workspace, nil
}

func (m *mockWorkspaceQuerier) TouchWorkspaceLastAccessed(ctx context.Context, id string) error {
	if m.touchWorkspaceLastAccessedFn != nil {
		return m.touchWorkspaceLastAccessedFn(ctx, id)
	}
	return nil
}

func (m *mockWorkspaceQuerier) ListUserWorkspacesAcrossRepos(ctx context.Context, arg db.ListUserWorkspacesAcrossReposParams) ([]db.ListUserWorkspacesAcrossReposRow, error) {
	if m.listUserWorkspacesAcrossReposFn != nil {
		return m.listUserWorkspacesAcrossReposFn(ctx, arg)
	}
	return nil, nil
}

func (m *mockWorkspaceQuerier) CountUserWorkspacesAcrossRepos(ctx context.Context, userID int64) (int64, error) {
	if m.countUserWorkspacesAcrossReposFn != nil {
		return m.countUserWorkspacesAcrossReposFn(ctx, userID)
	}
	return 0, nil
}

func (m *mockWorkspaceQuerier) TouchWorkspaceActivity(ctx context.Context, id string) error {
	if m.touchWorkspaceActivityFn != nil {
		return m.touchWorkspaceActivityFn(ctx, id)
	}
	return nil
}

func (m *mockWorkspaceQuerier) CountActiveSessionsForWorkspace(ctx context.Context, workspaceID string) (int64, error) {
	if m.countActiveSessionsForWorkspaceFn != nil {
		return m.countActiveSessionsForWorkspaceFn(ctx, workspaceID)
	}
	return 0, nil
}

func (m *mockWorkspaceQuerier) CountActiveSessionsForUser(ctx context.Context, userID int64) (int64, error) {
	if m.countActiveSessionsForUserFn != nil {
		return m.countActiveSessionsForUserFn(ctx, userID)
	}
	return 0, nil
}

func (m *mockWorkspaceQuerier) ListIdleWorkspaces(ctx context.Context) ([]db.Workspace, error) {
	if m.listIdleWorkspacesFn != nil {
		return m.listIdleWorkspacesFn(ctx)
	}
	return nil, nil
}

func (m *mockWorkspaceQuerier) ListRunningWorkspaces(ctx context.Context) ([]db.Workspace, error) {
	if m.listRunningWorkspacesFn != nil {
		return m.listRunningWorkspacesFn(ctx)
	}
	return nil, nil
}

func (m *mockWorkspaceQuerier) ListStalePendingWorkspaces(ctx context.Context, staleAfterSecs int32) ([]db.Workspace, error) {
	if m.listStalePendingWorkspacesFn != nil {
		return m.listStalePendingWorkspacesFn(ctx, staleAfterSecs)
	}
	return nil, nil
}

func (m *mockWorkspaceQuerier) ListStaleStartingWorkspacesWithVM(ctx context.Context, staleAfterSecs int32) ([]db.Workspace, error) {
	if m.listStaleStartingWorkspacesWithVMFn != nil {
		return m.listStaleStartingWorkspacesWithVMFn(ctx, staleAfterSecs)
	}
	return nil, nil
}

func (m *mockWorkspaceQuerier) FailStaleStartingWorkspace(ctx context.Context, arg db.FailStaleStartingWorkspaceParams) (db.Workspace, error) {
	if m.failStaleStartingWorkspaceFn != nil {
		return m.failStaleStartingWorkspaceFn(ctx, arg)
	}
	return m.UpdateWorkspaceStatus(ctx, db.UpdateWorkspaceStatusParams{ID: arg.ID, Status: "failed"})
}

func (m *mockWorkspaceQuerier) CreateWorkspaceSnapshot(ctx context.Context, arg db.CreateWorkspaceSnapshotParams) (db.WorkspaceSnapshot, error) {
	if m.createWorkspaceSnapshotFn != nil {
		return m.createWorkspaceSnapshotFn(ctx, arg)
	}
	return sampleDBWorkspaceSnapshot("snap-1", arg.WorkspaceID, arg.Name, arg.SnapshotID), nil
}

func (m *mockWorkspaceQuerier) GetWorkspaceSnapshot(ctx context.Context, id string) (db.WorkspaceSnapshot, error) {
	if m.getWorkspaceSnapshotFn != nil {
		return m.getWorkspaceSnapshotFn(ctx, id)
	}
	return sampleDBWorkspaceSnapshot(id, "ws-1", "snapshot", "fs-snap-1"), nil
}

func (m *mockWorkspaceQuerier) GetWorkspaceSnapshotByRepo(ctx context.Context, arg db.GetWorkspaceSnapshotByRepoParams) (db.WorkspaceSnapshot, error) {
	if m.getWorkspaceSnapshotByRepoFn != nil {
		return m.getWorkspaceSnapshotByRepoFn(ctx, arg)
	}
	return sampleDBWorkspaceSnapshot(arg.ID, "ws-1", "snapshot", "fs-snap-1"), nil
}

func (m *mockWorkspaceQuerier) GetWorkspaceSnapshotForUserRepo(ctx context.Context, arg db.GetWorkspaceSnapshotForUserRepoParams) (db.WorkspaceSnapshot, error) {
	if m.getWorkspaceSnapshotForUserRepoFn != nil {
		return m.getWorkspaceSnapshotForUserRepoFn(ctx, arg)
	}
	return sampleDBWorkspaceSnapshot(arg.ID, "ws-1", "snapshot", "fs-snap-1"), nil
}

func (m *mockWorkspaceQuerier) ListWorkspaceSnapshotsByRepo(ctx context.Context, arg db.ListWorkspaceSnapshotsByRepoParams) ([]db.WorkspaceSnapshot, error) {
	if m.listWorkspaceSnapshotsByRepoFn != nil {
		return m.listWorkspaceSnapshotsByRepoFn(ctx, arg)
	}
	return []db.WorkspaceSnapshot{sampleDBWorkspaceSnapshot("snap-1", "ws-1", "snapshot", "fs-snap-1")}, nil
}

func (m *mockWorkspaceQuerier) CountWorkspaceSnapshotsByRepo(ctx context.Context, arg db.CountWorkspaceSnapshotsByRepoParams) (int64, error) {
	if m.countWorkspaceSnapshotsByRepoFn != nil {
		return m.countWorkspaceSnapshotsByRepoFn(ctx, arg)
	}
	return 1, nil
}

func (m *mockWorkspaceQuerier) DeleteWorkspaceSnapshot(ctx context.Context, id string) error {
	if m.deleteWorkspaceSnapshotFn != nil {
		return m.deleteWorkspaceSnapshotFn(ctx, id)
	}
	return nil
}

func (m *mockWorkspaceQuerier) CreateWorkspaceSession(ctx context.Context, arg db.CreateWorkspaceSessionParams) (db.WorkspaceSession, error) {
	if m.createWorkspaceSessionFn != nil {
		return m.createWorkspaceSessionFn(ctx, arg)
	}
	return db.WorkspaceSession{ID: "sess-1", WorkspaceID: arg.WorkspaceID, RepositoryID: arg.RepositoryID, UserID: arg.UserID}, nil
}

func (m *mockWorkspaceQuerier) CreateWorkspaceLSPSession(ctx context.Context, arg db.CreateWorkspaceLSPSessionParams) (db.WorkspaceSession, error) {
	if m.createWorkspaceLSPSessionFn != nil {
		return m.createWorkspaceLSPSessionFn(ctx, arg)
	}
	return db.WorkspaceSession{
		ID:              "lsp-session-1",
		WorkspaceID:     arg.WorkspaceID,
		RepositoryID:    arg.RepositoryID,
		UserID:          arg.UserID,
		Status:          "running",
		Kind:            WorkspaceSessionKindLSP,
		Language:        arg.Language,
		Cols:            arg.Cols,
		Rows:            arg.Rows,
		IdleTimeoutSecs: arg.IdleTimeoutSecs,
	}, nil
}

func (m *mockWorkspaceQuerier) GetActiveWorkspaceLSPSession(ctx context.Context, arg db.GetActiveWorkspaceLSPSessionParams) (db.WorkspaceSession, error) {
	if m.getActiveWorkspaceLSPSessionFn != nil {
		return m.getActiveWorkspaceLSPSessionFn(ctx, arg)
	}
	return db.WorkspaceSession{}, pgx.ErrNoRows
}

func (m *mockWorkspaceQuerier) GetWorkspaceSession(ctx context.Context, id string) (db.WorkspaceSession, error) {
	if m.getWorkspaceSessionFn != nil {
		return m.getWorkspaceSessionFn(ctx, id)
	}
	return db.WorkspaceSession{ID: id, WorkspaceID: "ws-1", RepositoryID: 101, UserID: 1, Status: "running"}, nil
}

func (m *mockWorkspaceQuerier) GetWorkspaceSessionByRepo(ctx context.Context, arg db.GetWorkspaceSessionByRepoParams) (db.WorkspaceSession, error) {
	if m.getWorkspaceSessionByRepoFn != nil {
		return m.getWorkspaceSessionByRepoFn(ctx, arg)
	}
	return db.WorkspaceSession{ID: arg.ID, WorkspaceID: "ws-1", RepositoryID: arg.RepositoryID, UserID: 1, Status: "running"}, nil
}

func (m *mockWorkspaceQuerier) GetWorkspaceSessionForUserRepo(ctx context.Context, arg db.GetWorkspaceSessionForUserRepoParams) (db.WorkspaceSession, error) {
	if m.getWorkspaceSessionForUserRepoFn != nil {
		return m.getWorkspaceSessionForUserRepoFn(ctx, arg)
	}
	return db.WorkspaceSession{ID: arg.ID, WorkspaceID: "ws-1", RepositoryID: arg.RepositoryID, UserID: arg.UserID, Status: "running"}, nil
}

func (m *mockWorkspaceQuerier) ListWorkspaceSessionsByRepo(ctx context.Context, arg db.ListWorkspaceSessionsByRepoParams) ([]db.WorkspaceSession, error) {
	if m.listWorkspaceSessionsByRepoFn != nil {
		return m.listWorkspaceSessionsByRepoFn(ctx, arg)
	}
	return nil, nil
}

func (m *mockWorkspaceQuerier) CountWorkspaceSessionsByRepo(ctx context.Context, arg db.CountWorkspaceSessionsByRepoParams) (int64, error) {
	if m.countWorkspaceSessionsByRepoFn != nil {
		return m.countWorkspaceSessionsByRepoFn(ctx, arg)
	}
	return 0, nil
}

func (m *mockWorkspaceQuerier) UpdateWorkspaceSessionStatus(ctx context.Context, arg db.UpdateWorkspaceSessionStatusParams) (db.WorkspaceSession, error) {
	if m.updateWorkspaceSessionStatusFn != nil {
		return m.updateWorkspaceSessionStatusFn(ctx, arg)
	}
	return db.WorkspaceSession{ID: arg.ID, WorkspaceID: "ws-1", RepositoryID: 101, UserID: 1, Status: arg.Status}, nil
}

// MarkWorkspaceSessionRunning delegates to the UpdateWorkspaceSessionStatus
// hook so tests observing "running" writes keep working against the CAS path.
func (m *mockWorkspaceQuerier) MarkWorkspaceSessionRunning(ctx context.Context, id string) (db.WorkspaceSession, error) {
	if m.markWorkspaceSessionRunningFn != nil {
		return m.markWorkspaceSessionRunningFn(ctx, id)
	}
	return m.UpdateWorkspaceSessionStatus(ctx, db.UpdateWorkspaceSessionStatusParams{ID: id, Status: "running"})
}

// FailActiveWorkspaceSession delegates to the UpdateWorkspaceSessionStatus hook
// so tests observing "failed" writes keep working against the CAS path.
func (m *mockWorkspaceQuerier) FailActiveWorkspaceSession(ctx context.Context, id string) (db.WorkspaceSession, error) {
	if m.failActiveWorkspaceSessionFn != nil {
		return m.failActiveWorkspaceSessionFn(ctx, id)
	}
	return m.UpdateWorkspaceSessionStatus(ctx, db.UpdateWorkspaceSessionStatusParams{ID: id, Status: "failed"})
}

func (m *mockWorkspaceQuerier) UpdateWorkspaceSessionSSHConnectionInfo(ctx context.Context, arg db.UpdateWorkspaceSessionSSHConnectionInfoParams) (db.WorkspaceSession, error) {
	if m.updateWorkspaceSessionSSHConnectionFn != nil {
		return m.updateWorkspaceSessionSSHConnectionFn(ctx, arg)
	}
	return db.WorkspaceSession{ID: arg.ID, WorkspaceID: "ws-1", RepositoryID: 101, UserID: 1, Status: "running", SshConnectionInfo: arg.SshConnectionInfo}, nil
}

func (m *mockWorkspaceQuerier) TouchWorkspaceSessionActivity(ctx context.Context, id string) error {
	if m.touchWorkspaceSessionActivityFn != nil {
		return m.touchWorkspaceSessionActivityFn(ctx, id)
	}
	return nil
}

func (m *mockWorkspaceQuerier) ListIdleWorkspaceSessions(ctx context.Context) ([]db.WorkspaceSession, error) {
	if m.listIdleWorkspaceSessionsFn != nil {
		return m.listIdleWorkspaceSessionsFn(ctx)
	}
	return nil, nil
}

func (m *mockWorkspaceQuerier) CreateAccessToken(ctx context.Context, arg db.CreateAccessTokenParams) (db.AccessToken, error) {
	if m.createAccessTokenFn != nil {
		return m.createAccessTokenFn(ctx, arg)
	}
	return db.AccessToken{ID: 1}, nil
}

func (m *mockWorkspaceQuerier) DeleteAccessToken(ctx context.Context, arg db.DeleteAccessTokenParams) error {
	if m.deleteAccessTokenFn != nil {
		return m.deleteAccessTokenFn(ctx, arg)
	}
	return nil
}

func (m *mockWorkspaceQuerier) NotifyWorkspaceStatus(ctx context.Context, arg db.NotifyWorkspaceStatusParams) error {
	if m.notifyWorkspaceStatusFn != nil {
		return m.notifyWorkspaceStatusFn(ctx, arg)
	}
	return nil
}

func (m *mockWorkspaceQuerier) GetWorkspaceShare(ctx context.Context, arg db.GetWorkspaceShareParams) (db.WorkspaceShare, error) {
	if m.getWorkspaceShareFn != nil {
		return m.getWorkspaceShareFn(ctx, arg)
	}
	// Default: no share row exists (simulates non-owner without a share).
	return db.WorkspaceShare{}, pgx.ErrNoRows
}

func (m *mockWorkspaceQuerier) MarkSandboxAccessTokenUsed(ctx context.Context, id string) error {
	if m.markSandboxAccessTokenUsedFn != nil {
		return m.markSandboxAccessTokenUsedFn(ctx, id)
	}
	return nil
}

func (m *mockWorkspaceQuerier) DeleteExpiredSandboxAccessTokens(ctx context.Context) error {
	if m.deleteExpiredSandboxAccessTokensFn != nil {
		return m.deleteExpiredSandboxAccessTokensFn(ctx)
	}
	return nil
}

type mockWorkspaceSandboxVMClient struct {
	createIdentityTokenFn  func(context.Context, string) (sandbox.CreatedToken, error)
	createVMFn             func(ctx context.Context, req sandbox.CreateRequest) (sandbox.CreateResult, error)
	forkVMFn               func(ctx context.Context, sourceVMID string, req sandbox.ForkRequest) (sandbox.CreateResult, error)
	execAwaitFn            func(ctx context.Context, vmID string, req sandbox.ExecRequest) (sandbox.ExecResult, error)
	writeFileFn            func(ctx context.Context, vmID, path string, req sandbox.WriteFileRequest) error
	createSystemdServiceFn func(ctx context.Context, vmID string, req sandbox.ServiceSpec) (sandbox.CreateServiceResult, error)
	getVMFn                func(ctx context.Context, vmID string) (sandbox.Sandbox, error)
	deleteVMFn             func(ctx context.Context, vmID string) error
	startVMFn              func(ctx context.Context, vmID string, req sandbox.StartRequest) (sandbox.StartResult, error)
	suspendVMFn            func(ctx context.Context, vmID string) (sandbox.SuspendResult, error)
	snapshotVMFn           func(ctx context.Context, vmID string, req sandbox.SnapshotRequest) (sandbox.SnapshotResult, error)
	deleteSnapshotFn       func(ctx context.Context, snapshotID string) error
	grantVMPermissionFn    func(ctx context.Context, identityID, vmID string, req sandbox.GrantAccessRequest) (sandbox.AccessGrant, error)
	publishIngressFn       func(ctx context.Context, domain string, req sandbox.PublishIngressRequest) (sandbox.IngressRoute, error)
}

func (m *mockWorkspaceSandboxVMClient) CreateSandbox(ctx context.Context, req sandbox.CreateRequest) (sandbox.CreateResult, error) {
	if m.createVMFn != nil {
		return m.createVMFn(ctx, req)
	}
	return sandbox.CreateResult{ID: "vm-test-123"}, nil
}

func (m *mockWorkspaceSandboxVMClient) ForkSandbox(ctx context.Context, sourceVMID string, req sandbox.ForkRequest) (sandbox.CreateResult, error) {
	if m.forkVMFn != nil {
		return m.forkVMFn(ctx, sourceVMID, req)
	}
	return sandbox.CreateResult{ID: "vm-fork-123"}, nil
}

func (m *mockWorkspaceSandboxVMClient) Execute(ctx context.Context, vmID string, req sandbox.ExecRequest) (sandbox.ExecResult, error) {
	// Artifact RPCs have their own file-transfer/ordering tests; the legacy
	// callbacks below model repository and provider commands.
	if isWorkspaceArtifactCommand(req.Command) {
		code := int32(0)
		stdout := ""
		if strings.HasPrefix(strings.TrimPrefix(req.Command, workspaceArtifactGuestPath), "if ! test -L ") {
			stdout = "done"
		}
		return sandbox.ExecResult{StatusCode: &code, Stdout: stdout}, nil
	}
	if m.execAwaitFn != nil {
		return m.execAwaitFn(ctx, vmID, req)
	}
	status := int32(0)
	return sandbox.ExecResult{StatusCode: &status}, nil
}

func (m *mockWorkspaceSandboxVMClient) WriteFile(ctx context.Context, vmID, path string, req sandbox.WriteFileRequest) error {
	if m.writeFileFn != nil {
		return m.writeFileFn(ctx, vmID, path, req)
	}
	return nil
}

func (m *mockWorkspaceSandboxVMClient) CreateService(ctx context.Context, vmID string, req sandbox.ServiceSpec) (sandbox.CreateServiceResult, error) {
	if m.createSystemdServiceFn != nil {
		return m.createSystemdServiceFn(ctx, vmID, req)
	}
	return sandbox.CreateServiceResult{Success: true, ServiceName: req.Name}, nil
}

func (m *mockWorkspaceSandboxVMClient) InspectSandbox(ctx context.Context, vmID string) (sandbox.Sandbox, error) {
	if m.getVMFn != nil {
		return m.getVMFn(ctx, vmID)
	}
	return sandbox.Sandbox{ID: vmID, State: sandbox.StateRunning}, nil
}

func (m *mockWorkspaceSandboxVMClient) DeleteSandbox(ctx context.Context, vmID string) error {
	if m.deleteVMFn != nil {
		return m.deleteVMFn(ctx, vmID)
	}
	return nil
}

func (m *mockWorkspaceSandboxVMClient) StartSandbox(ctx context.Context, vmID string, req sandbox.StartRequest) (sandbox.StartResult, error) {
	if m.startVMFn != nil {
		return m.startVMFn(ctx, vmID, req)
	}
	return sandbox.StartResult{ID: vmID}, nil
}

func (m *mockWorkspaceSandboxVMClient) SuspendSandbox(ctx context.Context, vmID string) (sandbox.SuspendResult, error) {
	if m.suspendVMFn != nil {
		return m.suspendVMFn(ctx, vmID)
	}
	return sandbox.SuspendResult{ID: vmID}, nil
}

func (m *mockWorkspaceSandboxVMClient) SnapshotSandbox(ctx context.Context, vmID string, req sandbox.SnapshotRequest) (sandbox.SnapshotResult, error) {
	if m.snapshotVMFn != nil {
		return m.snapshotVMFn(ctx, vmID, req)
	}
	return sandbox.SnapshotResult{SnapshotID: "snap-123", SourceSandboxID: vmID}, nil
}

func (m *mockWorkspaceSandboxVMClient) DeleteSnapshot(ctx context.Context, snapshotID string) error {
	if m.deleteSnapshotFn != nil {
		return m.deleteSnapshotFn(ctx, snapshotID)
	}
	return nil
}

func (m *mockWorkspaceSandboxVMClient) PublishIngress(ctx context.Context, domain string, req sandbox.PublishIngressRequest) (sandbox.IngressRoute, error) {
	if m.publishIngressFn != nil {
		return m.publishIngressFn(ctx, domain, req)
	}
	return sandbox.IngressRoute{ID: domain, Hostname: domain, SandboxID: req.SandboxID, Port: req.Port}, nil
}

func (m *mockWorkspaceSandboxVMClient) CreateIdentity(ctx context.Context) (sandbox.Identity, error) {
	return sandbox.Identity{ID: "identity-test-123"}, nil
}

func (m *mockWorkspaceSandboxVMClient) GrantAccess(ctx context.Context, identityID, vmID string, req sandbox.GrantAccessRequest) (sandbox.AccessGrant, error) {
	if m.grantVMPermissionFn != nil {
		return m.grantVMPermissionFn(ctx, identityID, vmID, req)
	}
	return sandbox.AccessGrant{ID: "perm-test-123"}, nil
}

func (m *mockWorkspaceSandboxVMClient) CreateIdentityToken(ctx context.Context, identityID string) (sandbox.CreatedToken, error) {
	if m.createIdentityTokenFn != nil {
		return m.createIdentityTokenFn(ctx, identityID)
	}
	return sandbox.CreatedToken{ID: "token-test-123", Token: "test-token"}, nil
}

func sampleDBWorkspace(id string) db.Workspace {
	now := time.Now().UTC().Truncate(time.Second)
	return db.Workspace{
		ID:                id,
		RepositoryID:      101,
		UserID:            1,
		Name:              "primary",
		TargetBookmark:    "main",
		Kind:              "container",
		EnvironmentSource: defaultWorkspaceEnvironmentSource,
		VmID:              "vm-source-1",
		Status:            "running",
		IdleTimeoutSecs:   1800,
		CreatedAt:         now,
		UpdatedAt:         now,
		LastActivityAt:    now,
		ParentWorkspaceID: pgtype.UUID{},
		SourceSnapshotID:  pgtype.UUID{},
	}
}

func sampleUnnamedDBWorkspace(id string) db.Workspace {
	row := sampleDBWorkspace(id)
	row.Name = ""
	return row
}

func sampleDBWorkspaceSnapshot(id, workspaceID, name, snapshotID string) db.WorkspaceSnapshot {
	now := time.Now().UTC().Truncate(time.Second)
	return db.WorkspaceSnapshot{
		ID:           id,
		RepositoryID: 101,
		UserID:       1,
		WorkspaceID:  workspaceID,
		Name:         name,
		SnapshotID:   snapshotID,
		CreatedAt:    now,
		UpdatedAt:    now,
	}
}

func TestWorkspaceService_ListWorkspaces_ScopesToUser(t *testing.T) {
	t.Parallel()

	q := &mockWorkspaceQuerier{
		listWorkspacesByRepoFn: func(ctx context.Context, arg db.ListWorkspacesByRepoParams) ([]db.Workspace, error) {
			assert.Equal(t, int64(101), arg.RepositoryID)
			assert.Equal(t, int64(7), arg.UserID)
			return []db.Workspace{sampleDBWorkspace("ws-owned")}, nil
		},
		countWorkspacesByRepoFn: func(ctx context.Context, arg db.CountWorkspacesByRepoParams) (int64, error) {
			assert.Equal(t, int64(101), arg.RepositoryID)
			assert.Equal(t, int64(7), arg.UserID)
			return 1, nil
		},
	}

	svc := newWorkspaceServiceForTests(q)

	workspaces, total, err := svc.ListWorkspaces(context.Background(), 101, 7, 1, 20)
	require.NoError(t, err)
	require.Len(t, workspaces, 1)
	assert.Equal(t, "ws-owned", workspaces[0].ID)
	assert.Equal(t, int64(1), total)
}

func TestWorkspaceService_ListUserWorkspacesAcrossRepos_PaginatesThreePages(t *testing.T) {
	t.Parallel()

	rows := []db.ListUserWorkspacesAcrossReposRow{
		{WorkspaceID: "ws-5"},
		{WorkspaceID: "ws-4"},
		{WorkspaceID: "ws-3"},
		{WorkspaceID: "ws-2"},
		{WorkspaceID: "ws-1"},
	}
	var offsets []int32
	q := &mockWorkspaceQuerier{
		listUserWorkspacesAcrossReposFn: func(_ context.Context, arg db.ListUserWorkspacesAcrossReposParams) ([]db.ListUserWorkspacesAcrossReposRow, error) {
			offsets = append(offsets, arg.PageOffset)
			start := int(arg.PageOffset)
			end := min(start+int(arg.PageSize), len(rows))
			return rows[start:end], nil
		},
		countUserWorkspacesAcrossReposFn: func(context.Context, int64) (int64, error) {
			return int64(len(rows)), nil
		},
	}
	svc := newWorkspaceServiceForTests(q)

	var seen []string
	for page := 1; page <= 3; page++ {
		result, err := svc.ListUserWorkspacesAcrossRepos(context.Background(), 7, page, 2)
		require.NoError(t, err)
		assert.Equal(t, int64(5), result.TotalCount)
		assert.Equal(t, page, result.Page)
		assert.Equal(t, 2, result.PerPage)
		for _, item := range result.Items {
			seen = append(seen, item.WorkspaceID)
		}
	}

	assert.Equal(t, []int32{0, 2, 4}, offsets)
	assert.Equal(t, []string{"ws-5", "ws-4", "ws-3", "ws-2", "ws-1"}, seen)
}

func TestWorkspaceSSH_CredentialScopedToOwner(t *testing.T) {
	t.Parallel()

	tokenCreated := false
	q := &mockWorkspaceQuerier{
		// loadOwnedWorkspaceSession calls GetWorkspaceSessionByRepo (not the
		// user-scoped variant); it then enforces ownership via requireWorkspaceAccess.
		getWorkspaceSessionByRepoFn: func(ctx context.Context, arg db.GetWorkspaceSessionByRepoParams) (db.WorkspaceSession, error) {
			if arg.ID == "sess-owner" && arg.RepositoryID == 101 {
				return db.WorkspaceSession{
					ID:           arg.ID,
					WorkspaceID:  "ws-owner",
					RepositoryID: 101,
					UserID:       1, // owned by user 1
					Status:       "running",
				}, nil
			}
			return db.WorkspaceSession{}, pgx.ErrNoRows
		},
	}

	svc := NewWorkspaceService(q, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{createIdentityTokenFn: func(context.Context, string) (sandbox.CreatedToken, error) {
		tokenCreated = true
		return sandbox.CreatedToken{Token: "should-not-mint"}, nil
	}}))

	// User 2 tries to SSH into a session owned by user 1 — must be rejected.
	_, err := svc.GetSSHConnectionInfo(context.Background(), "sess-owner", 101, 2)
	require.Error(t, err)
	assert.False(t, tokenCreated)

	apiErr, ok := err.(*pkgerrors.APIError)
	require.True(t, ok)
	// 403 Forbidden: session exists in this repo but is owned by a different user.
	assert.Equal(t, 403, apiErr.Status)
}

func TestWorkspaceSSH_CrossRepoRejected(t *testing.T) {
	t.Parallel()

	tokenCreated := false
	q := &mockWorkspaceQuerier{
		// loadOwnedWorkspaceSession calls GetWorkspaceSessionByRepo.
		// Session "sess-repo-a" only exists in repository 101, so querying
		// with repository 202 returns ErrNoRows → 404.
		getWorkspaceSessionByRepoFn: func(ctx context.Context, arg db.GetWorkspaceSessionByRepoParams) (db.WorkspaceSession, error) {
			if arg.ID == "sess-repo-a" && arg.RepositoryID == 101 {
				return db.WorkspaceSession{
					ID:           arg.ID,
					WorkspaceID:  "ws-repo-a",
					RepositoryID: 101,
					UserID:       1,
					Status:       "running",
				}, nil
			}
			return db.WorkspaceSession{}, pgx.ErrNoRows
		},
	}

	svc := NewWorkspaceService(q, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{createIdentityTokenFn: func(context.Context, string) (sandbox.CreatedToken, error) {
		tokenCreated = true
		return sandbox.CreatedToken{Token: "should-not-mint"}, nil
	}}))

	// Access via wrong repo ID (202 instead of 101) — session not found → 404.
	_, err := svc.GetSSHConnectionInfo(context.Background(), "sess-repo-a", 202, 1)
	require.Error(t, err)
	assert.False(t, tokenCreated)

	apiErr, ok := err.(*pkgerrors.APIError)
	require.True(t, ok)
	assert.Equal(t, 404, apiErr.Status)
}
