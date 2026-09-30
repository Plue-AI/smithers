package services

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/smithersai/smithers/packages/backend/sandbox"
	"github.com/stretchr/testify/require"
)

func artifactCallsiteFixture(t *testing.T) {
	t.Helper()
	source := filepath.Join(t.TempDir(), "artifact")
	require.NoError(t, os.WriteFile(source, []byte("bounded artifact fixture"), 0600))
	t.Setenv(workspaceCLIPackageEnv, source)
	t.Setenv(workspaceCodingHostBinaryEnv, source)
	t.Setenv(workspaceJJExportBinaryEnv, source)
}

func stagedWorkspaceScript(client *artifactRecordingClient) string {
	for path, content := range client.content {
		if strings.HasSuffix(path, "/bootstrap.sh") {
			return content
		}
	}
	return ""
}

func TestWorkspaceArtifactCreateKindsAndSnapshots(t *testing.T) {
	artifactCallsiteFixture(t)
	for _, kind := range []string{"container", "vm", "desktop"} {
		for _, snapshot := range []string{"", "snapshot-source"} {
			t.Run(kind+"/"+snapshot, func(t *testing.T) {
				svc := newWorkspaceServiceForTests(&mockWorkspaceQuerier{}, WithWorkspaceEnvironmentImages(&stubEnvironmentImageResolver{image: nixTestImage(kind)}))
				req, err := svc.buildWorkspaceVMRequest(t.Context(), snapshot, nil, 0, "same-workspace", kind)
				require.NoError(t, err)
				// The Nix resolver selects a closure-specific golden image;
				// inject the snapshot at the transport boundary under test.
				req.SnapshotID = snapshot
				require.Equal(t, workspaceArtifactOwner("same-workspace"), req.Files[workspaceArtifactOwnerPath].Content)
				client := newArtifactRecordingClient()
				_, err = createWorkspaceSandbox(t.Context(), client, req)
				require.NoError(t, err)
				require.Len(t, client.writes, 5) // Current script, three artifacts, and the manifest.
				require.Equal(t, req.Files[workspaceClaudeScriptPath].Content, stagedWorkspaceScript(client))
				require.Equal(t, snapshot, client.createCalls[0].SnapshotID)
				require.Len(t, client.createCalls[0].Init.Services, len(req.Init.Services)-1)
				for _, service := range client.createCalls[0].Init.Services {
					require.NotEqual(t, workspaceClaudeService, service.Name)
				}
			})
		}
	}
}

func TestWorkspaceArtifactGoldenBuilderFailureReapsAllocatedVM(t *testing.T) {
	artifactCallsiteFixture(t)
	req, err := newWorkspaceServiceForTests(&mockWorkspaceQuerier{}).buildWorkspaceVMRequest(t.Context(), "", nil, 0, "builder", "container")
	require.NoError(t, err)
	client := newArtifactRecordingClient()
	client.failWrite = 1
	var deleted []string
	client.deleteVMFn = func(ctx context.Context, id string) error {
		require.NoError(t, ctx.Err())
		deleted = append(deleted, id)
		return nil
	}
	svc := NewGoldenSnapshotService(&fakeGoldenDB{}, client, func() sandbox.CreateRequest { return req })
	_, err = svc.bakeWith(t.Context(), "row", func() sandbox.CreateRequest { return req }, "true")
	require.ErrorContains(t, err, "transfer interrupted")
	require.Equal(t, []string{"vm-test-123"}, deleted)
}

type artifactCIGuests struct{ req sandbox.CreateRequest }

func (g artifactCIGuests) CIGuestVMRequest(context.Context, int64, []sandbox.GitRepositorySpec) (sandbox.CreateRequest, error) {
	return g.req, nil
}

func TestWorkspaceArtifactCIRetriesReapAllocatedVMs(t *testing.T) {
	artifactCallsiteFixture(t)
	req, err := newWorkspaceServiceForTests(&mockWorkspaceQuerier{}).buildWorkspaceVMRequest(t.Context(), "", nil, 0, "ci", "container")
	require.NoError(t, err)
	for _, cleanupFails := range []bool{false, true} {
		t.Run(map[bool]string{false: "retry", true: "cleanup-failure"}[cleanupFails], func(t *testing.T) {
			client := newArtifactRecordingClient()
			client.failWrite = 1
			var deletes int
			client.deleteVMFn = func(ctx context.Context, _ string) error {
				require.NoError(t, ctx.Err())
				deletes++
				if cleanupFails {
					return errors.New("delete failed")
				}
				return nil
			}
			queries := nixCIQuerier(nil)
			ledger := newNixCITokenLedger()
			queries.createAccessTokenFn = ledger.create
			queries.deleteAccessTokenFn = ledger.delete
			worker := NewWorkflowSandboxSchedulerWorker(queries, client, WithWorkflowSandboxSchedulerGitBaseURL("https://git.example.test"), WithWorkflowSandboxSchedulerCIGuests(artifactCIGuests{req: req}))
			guest, err := worker.provisionNixCIGuest(t.Context(), nixTask(1, "build"), nixCIRunEnvironment{RepositoryID: 100, Owner: "alice", RepositoryName: "demo", CloneUserID: 9}, nil)
			id := guest.ID
			require.Equal(t, 1, deletes)
			if cleanupFails {
				require.ErrorContains(t, err, "delete failed")
				require.Len(t, client.createCalls, 1)
				require.Empty(t, id)
			} else {
				require.NoError(t, err)
				require.Len(t, client.createCalls, 2)
				require.NotEmpty(t, id)
			}
		})
	}
}

func TestWorkspaceArtifactForkUsesChildIdentityAndOneBootstrapPath(t *testing.T) {
	artifactCallsiteFixture(t)
	client := newArtifactRecordingClient()
	svc := newWorkspaceServiceForTests(&mockWorkspaceQuerier{}, WithWorkspaceSandboxClient(client))
	_, err := svc.forkWorkspaceSandbox(t.Context(), "parent", "child", "container", nil)
	require.NoError(t, err)
	require.Equal(t, workspaceArtifactOwner("child"), client.content[workspaceArtifactOwnerPath])
	require.Len(t, client.writes, 6) // Child owner, current script, three artifacts and the manifest.
	require.Equal(t, workspaceBootstrapScriptForKind("container"), stagedWorkspaceScript(client))
	require.Contains(t, buildForkBookmarkSwitchCommand("", "main"), workspaceRuntimeReadyCommand())
	require.NotContains(t, buildForkBookmarkSwitchCommand("", "main"), shellQuote(workspaceClaudeScriptPath))
	require.NotContains(t, buildWorkspaceCloneCommand("https://git.test/repo", "", "main", 0), shellQuote(workspaceClaudeScriptPath))
}
