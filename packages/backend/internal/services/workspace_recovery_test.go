package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/sandbox"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

func TestMissingWorkspaceRecoveryPreservesIdentityAndBindsSnapshotAuthority(t *testing.T) {
	for _, tc := range []struct {
		name      string
		candidate func(db.WorkspaceSnapshot) db.WorkspaceSnapshot
		want      string
		queryErr  error
	}{
		{name: "owned snapshot", want: "11111111-1111-1111-1111-111111111111"},
		{name: "no snapshots", queryErr: pgx.ErrNoRows},
		{name: "unavailable metadata", candidate: func(s db.WorkspaceSnapshot) db.WorkspaceSnapshot { s.SnapshotID = ""; return s }},
		{name: "another owner", candidate: func(s db.WorkspaceSnapshot) db.WorkspaceSnapshot { s.UserID = 2; return s }},
		{name: "another repository", candidate: func(s db.WorkspaceSnapshot) db.WorkspaceSnapshot { s.RepositoryID = 202; return s }},
		{name: "another workspace", candidate: func(s db.WorkspaceSnapshot) db.WorkspaceSnapshot { s.WorkspaceID = "other"; return s }},
		{name: "rebuild required", candidate: func(s db.WorkspaceSnapshot) db.WorkspaceSnapshot {
			s.RebuildRequiredAt = pgtype.Timestamptz{Valid: true}
			return s
		}},
		{name: "unknown store", queryErr: errors.New("offline")},
	} {
		t.Run(tc.name, func(t *testing.T) {
			workspace := sampleDBWorkspace("missing-box")
			workspace.Status = "suspended"
			workspace.VmID = "lost-vm"
			snapshot := sampleDBWorkspaceSnapshot("11111111-1111-1111-1111-111111111111", workspace.ID, "saved", "owned-provider-snapshot")
			if tc.candidate != nil {
				snapshot = tc.candidate(snapshot)
			}
			q := &mockWorkspaceQuerier{
				getWorkspaceByRepoFn: func(context.Context, db.GetWorkspaceByRepoParams) (db.Workspace, error) { return workspace, nil },
				listWorkspaceSnapshotsByRepoFn: func(_ context.Context, p db.ListWorkspaceSnapshotsByRepoParams) ([]db.WorkspaceSnapshot, error) {
					require.Equal(t, workspace.RepositoryID, p.RepositoryID)
					require.Equal(t, workspace.UserID, p.UserID)
					if tc.queryErr != nil {
						return nil, tc.queryErr
					}
					return []db.WorkspaceSnapshot{snapshot}, nil
				},
				countWorkspaceSnapshotsByRepoFn: func(context.Context, db.CountWorkspaceSnapshotsByRepoParams) (int64, error) { return 1, nil },
				updateWorkspaceExecutionInfoFn: func(context.Context, db.UpdateWorkspaceExecutionInfoParams) (db.Workspace, error) {
					t.Fatal("missing VM recovery must not rewrite old identity")
					return db.Workspace{}, nil
				},
			}
			provider := &mockWorkspaceSandboxVMClient{getVMFn: func(context.Context, string) (sandbox.Sandbox, error) {
				return sandbox.Sandbox{}, &sandbox.StatusError{StatusCode: 404, Code: "not_found"}
			}}
			svc := newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(provider))
			_, err := svc.ResumeWorkspace(context.Background(), workspace.ID, workspace.RepositoryID, workspace.UserID)
			require.Error(t, err)
			var typed *pkgerrors.APIError
			require.ErrorAs(t, err, &typed)
			require.Equal(t, pkgerrors.CodeWorkspaceVMMissing, typed.Code)
			encoded, err := json.Marshal(typed.Details)
			require.NoError(t, err)
			var detail struct {
				WorkspaceID string `json:"workspace_id"`
				SnapshotID  string `json:"snapshot_id"`
				CreateFresh bool   `json:"create_fresh"`
			}
			require.NoError(t, json.Unmarshal(encoded, &detail))
			require.Equal(t, workspace.ID, detail.WorkspaceID)
			require.Equal(t, tc.want, detail.SnapshotID)
			require.True(t, detail.CreateFresh)
			require.Equal(t, "lost-vm", workspace.VmID)
			require.Equal(t, "suspended", workspace.Status)
		})
	}
}

func TestMissingWorkspaceRecoveryRetainedSourceRequiresOwnerAndRepository(t *testing.T) {
	for _, tc := range []struct {
		name     string
		change   func(db.WorkspaceSnapshot) db.WorkspaceSnapshot
		countErr error
		want     bool
	}{
		{name: "retained source", want: true},
		{name: "enumeration unavailable retained source", countErr: errors.New("offline"), want: true},
		{name: "foreign retained owner", change: func(s db.WorkspaceSnapshot) db.WorkspaceSnapshot { s.UserID++; return s }},
		{name: "foreign retained repository", change: func(s db.WorkspaceSnapshot) db.WorkspaceSnapshot { s.RepositoryID++; return s }},
		{name: "different returned identity", change: func(s db.WorkspaceSnapshot) db.WorkspaceSnapshot { s.ID = "different"; return s }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			old := sampleDBWorkspace("retained-source")
			old.SourceSnapshotID = stringToUUID("11111111-1111-1111-1111-111111111111")
			saved := sampleDBWorkspaceSnapshot(UUIDString(old.SourceSnapshotID), "original-source", "saved", "provider-disk")
			if tc.change != nil {
				saved = tc.change(saved)
			}
			q := &mockWorkspaceQuerier{
				countWorkspaceSnapshotsByRepoFn: func(context.Context, db.CountWorkspaceSnapshotsByRepoParams) (int64, error) { return 0, tc.countErr },
				getWorkspaceSnapshotForUserRepoFn: func(_ context.Context, p db.GetWorkspaceSnapshotForUserRepoParams) (db.WorkspaceSnapshot, error) {
					require.Equal(t, old.UserID, p.UserID)
					require.Equal(t, old.RepositoryID, p.RepositoryID)
					require.Equal(t, UUIDString(old.SourceSnapshotID), p.ID)
					return saved, nil
				},
			}
			failure := newWorkspaceServiceForTests(q).missingWorkspaceVM(context.Background(), old, old.UserID)
			detail, ok := failure.Details.(WorkspaceRecoveryDetails)
			require.True(t, ok)
			require.Equal(t, tc.want, detail.SnapshotID != "")
			require.True(t, detail.CreateFresh)
			require.Equal(t, old.ID, detail.WorkspaceID)
		})
	}
}
func TestMissingWorkspaceRecoveryWalksOwnedPagesAndHandlesEmptyListing(t *testing.T) {
	for _, empty := range []bool{false, true} {
		t.Run(fmt.Sprintf("empty=%v", empty), func(t *testing.T) {
			old := sampleDBWorkspace("page-two")
			saved := sampleDBWorkspaceSnapshot("saved-id", old.ID, "saved", "provider-disk")
			pages := 0
			q := &mockWorkspaceQuerier{
				countWorkspaceSnapshotsByRepoFn: func(context.Context, db.CountWorkspaceSnapshotsByRepoParams) (int64, error) { return 101, nil },
				listWorkspaceSnapshotsByRepoFn: func(_ context.Context, p db.ListWorkspaceSnapshotsByRepoParams) ([]db.WorkspaceSnapshot, error) {
					pages++
					require.Equal(t, int32(100), p.PageSize)
					if empty {
						return nil, nil
					}
					if p.PageOffset == 0 {
						other := saved
						other.WorkspaceID = "another"
						return []db.WorkspaceSnapshot{other}, nil
					}
					require.Equal(t, int32(100), p.PageOffset)
					return []db.WorkspaceSnapshot{saved}, nil
				},
			}
			failure := newWorkspaceServiceForTests(q).missingWorkspaceVM(context.Background(), old, old.UserID)
			detail := failure.Details.(WorkspaceRecoveryDetails)
			if empty {
				require.Empty(t, detail.SnapshotID)
				require.Equal(t, 1, pages)
			} else {
				require.Equal(t, saved.ID, detail.SnapshotID)
				require.Equal(t, 2, pages)
			}
		})
	}
}
func TestUnavailableWorkspaceSnapshotPreservesTypedCauseAndFreshRemedy(t *testing.T) {
	cause := &sandbox.StatusError{StatusCode: 404, Code: "snapshot_not_found"}
	failure := unavailableWorkspaceSnapshot(sampleDBWorkspace("failed-new"), cause)
	require.Equal(t, pkgerrors.CodeSnapshotNotFound, failure.Code)
	require.Same(t, cause, failure.Cause())
	require.Equal(t, WorkspaceRecoveryDetails{WorkspaceID: "failed-new", CreateFresh: true}, failure.Details)
}

func TestRuntimeSnapshotMissingUsesPublicTypedFreshRemedyAndRetainsNewFailure(t *testing.T) {
	runtime := &snapshotLostWorkerRuntime{lost: workspaceapi.ErrWorkspaceNotFound, fail: "fork"}
	row := sampleDBWorkspace("failed-new-runtime")
	row.Status = "starting"
	snapshot := sampleDBWorkspaceSnapshot("cccccccc-dddd-eeee-ffff-aaaaaaaaaaaa", "retained-source", "saved", "missing-provider-disk")
	q := &lostWorkerRuntimeQuerier{mockWorkspaceQuerier: &mockWorkspaceQuerier{
		getWorkspaceSnapshotByRepoFn: func(context.Context, db.GetWorkspaceSnapshotByRepoParams) (db.WorkspaceSnapshot, error) {
			return snapshot, nil
		},
		createWorkspaceFn: func(context.Context, db.CreateWorkspaceParams) (db.Workspace, error) { return row, nil },
	}}
	svc := newWorkspaceServiceForTests(q, WithWorkspaceRuntime(runtime))
	_, err := svc.CreateWorkspace(context.Background(), CreateWorkspaceInput{RepositoryID: row.RepositoryID, UserID: row.UserID, RepoOwner: "alice", RepoName: "demo", Name: "restored", SnapshotID: snapshot.ID})
	var failure *pkgerrors.APIError
	require.ErrorAs(t, err, &failure)
	require.Equal(t, pkgerrors.CodeSnapshotNotFound, failure.Code)
	require.Equal(t, WorkspaceRecoveryDetails{WorkspaceID: row.ID, CreateFresh: true}, failure.Details)
	require.Same(t, workspaceapi.ErrWorkspaceNotFound, failure.Cause())
	require.Equal(t, []string{string(pkgerrors.CodeSnapshotNotFound)}, q.failedCodes)
	require.Equal(t, 1, runtime.forked)
	require.Equal(t, 0, runtime.deleted, "snapshot and original recovery references are retained")
}
