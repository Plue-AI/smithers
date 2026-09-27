package services

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/sandbox"
)

// #2206: a workspace or snapshot built while its repository stored a
// subscription token may hold it on disk. Nothing reuses one until it is
// deleted; deleting it and creating a new workspace is the rebuild.

func flaggedWorkspace(id string) db.Workspace {
	workspace := sampleDBWorkspace(id)
	workspace.RebuildRequiredAt = pgtype.Timestamptz{Valid: true}
	return workspace
}

func requireRebuildRequired(t *testing.T, err error) {
	t.Helper()
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, pkgerrors.CodeWorkspaceRebuildRequired, apiErr.Code)
	assert.Equal(t, 409, apiErr.Status)
}

// sandboxUntouched fails the test on any sandbox call.
func sandboxUntouched(t *testing.T) *mockWorkspaceSandboxVMClient {
	return &mockWorkspaceSandboxVMClient{
		getVMFn: func(context.Context, string) (sandbox.Sandbox, error) {
			t.Error("a rebuild-required workspace must not be inspected")
			return sandbox.Sandbox{}, nil
		},
		startVMFn: func(context.Context, string, sandbox.StartRequest) (sandbox.StartResult, error) {
			t.Error("a rebuild-required workspace must not be started")
			return sandbox.StartResult{}, nil
		},
	}
}

func TestRebuildRequiredWorkspaceIsNotResumed(t *testing.T) {
	t.Parallel()
	for _, status := range []string{"running", "suspended"} {
		q := &mockWorkspaceQuerier{getWorkspaceByRepoFn: func(_ context.Context, arg db.GetWorkspaceByRepoParams) (db.Workspace, error) {
			workspace := flaggedWorkspace(arg.ID)
			workspace.Status = status
			return workspace, nil
		}}
		svc := newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(sandboxUntouched(t)))
		_, err := svc.ResumeWorkspace(context.Background(), "ws-flagged", 101, 1)
		requireRebuildRequired(t, err)
		_, err = svc.ensureWorkspaceRunning(context.Background(), flaggedWorkspace("ws-flagged"), CreateWorkspaceSessionInput{UserID: 1, RepoOwner: "alice", RepoName: "demo"})
		requireRebuildRequired(t, err)
		// The runtime adapter's shared entry, under its workspace lock.
		_, err = svc.ensureRuntimeWorkspaceRunningLocked(context.Background(), flaggedWorkspace("ws-flagged"), 1)
		requireRebuildRequired(t, err)
	}
}

func TestRebuildRequiredPrimaryIsNotReusedByCreate(t *testing.T) {
	t.Parallel()
	q := &mockWorkspaceQuerier{getActiveWorkspaceForUserRepoKindFn: func(context.Context, db.GetActiveWorkspaceForUserRepoKindParams) (db.Workspace, error) {
		return flaggedWorkspace("ws-primary"), nil
	}}
	svc := newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(sandboxUntouched(t)))
	_, err := svc.findOrCreatePrimaryWorkspace(context.Background(), 101, 1, "", "main", workspaceCreateMetadata{})
	requireRebuildRequired(t, err)
}

func TestRebuildRequiredWorkspaceIsNeverAnAgentForkSource(t *testing.T) {
	t.Parallel()
	agent := sampleDBWorkspace("ws-agent")
	agent.Kind = "agent"
	agent.VmID = ""
	candidate := flaggedWorkspace("ws-flagged-candidate")
	candidate.VmID = "vm-flagged-candidate"
	q := &agentForkKindQuerier{mockWorkspaceQuerier: forkKindQuerier(), candidates: []db.Workspace{candidate}}
	svc := newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(sandboxUntouched(t)))
	_, _, ok := svc.agentForkSource(context.Background(), agent, "main")
	assert.False(t, ok)
}

func TestRebuildRequiredSnapshotIsNotRestored(t *testing.T) {
	t.Parallel()
	snapshot := sampleDBWorkspaceSnapshot("11111111-1111-1111-1111-111111111111", "ws-source", "before", "snap-1")
	snapshot.RebuildRequiredAt = pgtype.Timestamptz{Valid: true}
	created := false
	q := &mockWorkspaceQuerier{
		getWorkspaceSnapshotByRepoFn: func(context.Context, db.GetWorkspaceSnapshotByRepoParams) (db.WorkspaceSnapshot, error) {
			return snapshot, nil
		},
		createWorkspaceFn: func(context.Context, db.CreateWorkspaceParams) (db.Workspace, error) {
			created = true
			return db.Workspace{}, nil
		},
	}
	svc := newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(sandboxUntouched(t)))
	input := CreateWorkspaceInput{RepositoryID: 101, UserID: 1, RepoOwner: "alice", RepoName: "demo", SnapshotID: snapshot.ID}
	_, err := svc.CreateWorkspace(context.Background(), input)
	requireRebuildRequired(t, err)
	_, err = svc.CreateWorkspaceAsync(context.Background(), input)
	requireRebuildRequired(t, err)
	assert.False(t, created)
}
