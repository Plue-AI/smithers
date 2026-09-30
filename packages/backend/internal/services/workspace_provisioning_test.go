package services

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/prometheus/client_golang/prometheus/testutil"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/sandbox"
)

func assertWorkspaceClaudeBootstrap(t *testing.T, req sandbox.CreateRequest) {
	t.Helper()

	assert.Contains(t, req.Packages, "ca-certificates")
	assert.Contains(t, req.Packages, "git")
	assert.Contains(t, req.Packages, "nodejs")
	assert.Contains(t, req.Packages, "npm")

	require.NotNil(t, req.Files)
	scriptFile, ok := req.Files[workspaceClaudeScriptPath]
	require.True(t, ok)
	assert.True(t, scriptFile.Executable)
	assert.Contains(t, scriptFile.Content, workspaceClaudePackage)
	assert.Contains(t, scriptFile.Content, "repos/jj-vcs/jj/releases/tags/v0.39.0")
	assert.Contains(t, scriptFile.Content, "nodejs.org/dist/index.json")
	assert.Contains(t, scriptFile.Content, workspaceLocalBinDir)
	assert.Contains(t, scriptFile.Content, workspaceLocalNodeDir)
	assert.Contains(t, scriptFile.Content, "runuser -u "+defaultWorkspaceUser)
	assert.Contains(t, scriptFile.Content, `cat "`+workspaceCLIPackageB64Path+`".part* | base64 -d | tar -xzf -`)
	assert.Contains(t, scriptFile.Content, "smithers workspace bootstrap: npm CLI package extraction failed")
	assert.Contains(t, scriptFile.Content, "smithers workspace bootstrap: npm CLI package absent")

	// Bun stays best-effort so network failures cannot fail provisioning. The
	// npm CLI is the only smithers binary; there is no global pack to init.
	assert.Contains(t, scriptFile.Content, "npm install -g --prefix /usr/local bun@"+workspaceBunVersion)
	assert.Contains(t, scriptFile.Content, "continuing without bun")
	assert.Contains(t, scriptFile.Content, workspaceCLIPackageDir+"/node_modules/@smthrs/cli/bin/smithers.mjs")
	assert.NotContains(t, scriptFile.Content, "SMITHERS_YES")
	assert.NotContains(t, scriptFile.Content, "init --global")

	require.NotNil(t, req.Init)
	assert.True(t, req.Init.Enabled)
	// Only the boot barrier belongs to Create. Toolchain bootstrap starts
	// after its bounded artifact transfer.
	require.Len(t, req.Init.Services, 1)
	ready := req.Init.Services[0]
	assert.Equal(t, workspaceReadyService, ready.Name)
	assert.Equal(t, sandbox.ServiceModeOneshot, ready.Mode)
	assert.Equal(t, []string{"/bin/true"}, ready.Exec)
	require.NotNil(t, ready.ReadySignal)
	assert.True(t, *ready.ReadySignal)
}

func TestBuildWorkspaceVMRequest_DoesNotPersistRepositorySecrets(t *testing.T) {
	t.Parallel()

	req, err := newWorkspaceServiceForTests(&mockWorkspaceQuerier{}).
		buildWorkspaceVMRequest(context.Background(), "", nil, 123, "", "container")
	require.NoError(t, err)

	assert.NotContains(t, req.Files, "/etc/profile.d/00-smithers-secrets.sh")
	for path, file := range req.Files {
		assert.NotContains(t, path, ".codex/auth.json")
		assert.NotContains(t, file.Content, "CODEX_AUTH_JSON")
	}
}

func TestLocalMicrosandboxHostFirewall(t *testing.T) {
	assert.Nil(t, localMicrosandboxHostFirewall("https://api.smithers.sh"))

	policy := localMicrosandboxHostFirewall("http://host.microsandbox.internal:24000")
	require.NotNil(t, policy)
	require.Len(t, policy.EgressAllow, 1)
	assert.Equal(t, "host", policy.EgressAllow[0].Host)
}

func TestWorkspaceService_BuildWorkspaceVMRequestIncludesCodingHostWhenAvailable(t *testing.T) {
	cliBytes := []byte("#!/bin/sh\necho smithers-test\n")
	cliPath := filepath.Join(t.TempDir(), "smithers")
	require.NoError(t, os.WriteFile(cliPath, cliBytes, 0o755))
	t.Setenv(workspaceCodingHostBinaryEnv, cliPath)

	svc := newWorkspaceServiceForTests(&mockWorkspaceQuerier{})
	req, err := svc.buildWorkspaceVMRequest(context.Background(), "", nil, 0, "", "container")
	require.NoError(t, err)

	require.NotContains(t, req.Files, workspaceCodingHostB64Path)
	files := map[string]sandbox.SandboxFile{}
	require.True(t, addWorkspaceCodingHost(files))
	file, ok := files[workspaceCodingHostB64Path+".part00000000"]
	require.True(t, ok)
	assert.False(t, file.Executable)
	assert.Empty(t, file.Encoding)
	compressed, err := base64.StdEncoding.DecodeString(file.Content)
	require.NoError(t, err)
	reader, err := gzip.NewReader(bytes.NewReader(compressed))
	require.NoError(t, err)
	decoded, err := io.ReadAll(reader)
	require.NoError(t, err)
	require.NoError(t, reader.Close())
	assert.Equal(t, cliBytes, decoded)
}

func TestWorkspaceService_CreateWorkspace_FromSnapshotUsesSnapshot(t *testing.T) {
	t.Parallel()

	// Workspace snapshot IDs must be valid UUIDs because SourceSnapshotID is
	// stored as pgtype.UUID; stringToUUID silently returns an invalid UUID for
	// non-UUID strings, causing UUIDString to return "".
	const snapID = "cccccccc-dddd-eeee-ffff-aaaaaaaaaaaa"

	q := &mockWorkspaceQuerier{
		getWorkspaceSnapshotByRepoFn: func(ctx context.Context, arg db.GetWorkspaceSnapshotByRepoParams) (db.WorkspaceSnapshot, error) {
			return sampleDBWorkspaceSnapshot(arg.ID, "ws-source", "snapshot", "fs-snap-123"), nil
		},
		createWorkspaceFn: func(ctx context.Context, arg db.CreateWorkspaceParams) (db.Workspace, error) {
			assert.True(t, arg.IsFork)
			assert.Equal(t, stringToUUID(snapID), arg.SourceSnapshotID)
			assert.Equal(t, "restored", arg.Name)
			assert.Equal(t, "starting", arg.Status)
			workspace := sampleDBWorkspace("ws-restored")
			workspace.Name = arg.Name
			workspace.IsFork = true
			workspace.SourceSnapshotID = arg.SourceSnapshotID
			workspace.VmID = ""
			workspace.Status = "pending"
			return workspace, nil
		},
		updateWorkspaceExecutionInfoFn: func(ctx context.Context, arg db.UpdateWorkspaceExecutionInfoParams) (db.Workspace, error) {
			workspace := sampleDBWorkspace(arg.ID)
			workspace.Name = "restored"
			workspace.IsFork = true
			workspace.SourceSnapshotID = stringToUUID(snapID)
			workspace.VmID = arg.VmID
			workspace.Status = arg.Status
			return workspace, nil
		},
	}

	svc := newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
		createVMFn: func(ctx context.Context, req sandbox.CreateRequest) (sandbox.CreateResult, error) {
			assert.Equal(t, "fs-snap-123", req.SnapshotID)
			require.NotNil(t, req.WaitForReady)
			assert.True(t, *req.WaitForReady)
			assert.Equal(t, defaultWorkspaceHome, req.Workdir)
			assertWorkspaceClaudeBootstrap(t, req)
			return sandbox.CreateResult{ID: "vm-restored"}, nil
		},
	}))

	workspace, err := svc.CreateWorkspace(context.Background(), CreateWorkspaceInput{
		RepositoryID: 101,
		UserID:       1,
		RepoOwner:    "alice",
		RepoName:     "demo",
		Name:         "restored",
		SnapshotID:   snapID,
	})
	require.NoError(t, err)
	assert.Equal(t, "vm-restored", workspace.VMID)
	assert.Equal(t, snapID, workspace.SnapshotID)
	assert.True(t, workspace.IsFork)
}

func TestWorkspaceService_CreateFreshVM_FallsBackToBareImageWhenGoldenSnapshotRejected(t *testing.T) {
	t.Parallel()

	goldenDB := &fakeGoldenDB{readyID: "snap-bad", readyCreatedAt: time.Now()}
	golden := NewGoldenSnapshotService(goldenDB, nil, nil)

	attempts := 0
	svc := newWorkspaceServiceForTests(&mockWorkspaceQuerier{},
		WithWorkspaceGoldenSnapshots(golden),
		WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
			createVMFn: func(_ context.Context, req sandbox.CreateRequest) (sandbox.CreateResult, error) {
				attempts++
				if req.SnapshotID != "" {
					return sandbox.CreateResult{}, &sandbox.StatusError{
						StatusCode: 404,
						ErrorCode:  "snapshot_not_found",
						Message:    "snapshot snap-bad was not found",
					}
				}
				assert.NotEmpty(t, req.Packages, "bare fallback must keep the apt bootstrap")
				return sandbox.CreateResult{ID: "vm-bare"}, nil
			},
		}))

	vm, err := svc.createFreshWorkspaceVM(context.Background(), 0, "", 0, "container")
	require.NoError(t, err, "a rejected golden snapshot must fall back to the bare image, not fail")
	assert.Equal(t, "vm-bare", vm.ID)
	assert.Equal(t, 2, attempts, "one snapshot attempt, one bare-image retry")
	assert.Equal(t, []string{"snap-bad"}, goldenDB.markedBadIDs, "the bad snapshot must be invalidated after the bare boot succeeds")
}

func TestWorkspaceService_CreateFreshVM_DoesNotInvalidateOnMicrosandboxOutage(t *testing.T) {
	t.Parallel()

	goldenDB := &fakeGoldenDB{readyID: "snap-live", readyCreatedAt: time.Now()}
	golden := NewGoldenSnapshotService(goldenDB, nil, nil)

	svc := newWorkspaceServiceForTests(&mockWorkspaceQuerier{},
		WithWorkspaceGoldenSnapshots(golden),
		WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
			createVMFn: func(_ context.Context, _ sandbox.CreateRequest) (sandbox.CreateResult, error) {
				return sandbox.CreateResult{}, errors.New("microsandbox 503")
			},
		}))

	_, err := svc.createFreshWorkspaceVM(context.Background(), 0, "", 0, "container")
	require.Error(t, err, "when both attempts fail it is a Microsandbox problem, surface the error")
	assert.Empty(t, goldenDB.markedBadIDs, "a full outage must NOT invalidate a good snapshot")
}

func TestWorkspaceService_CreateWorkspace_FromSnapshotRejectsForeignSnapshot(t *testing.T) {
	t.Parallel()

	created := false
	q := &mockWorkspaceQuerier{
		getWorkspaceSnapshotByRepoFn: func(ctx context.Context, arg db.GetWorkspaceSnapshotByRepoParams) (db.WorkspaceSnapshot, error) {
			assert.Equal(t, "snap-foreign", arg.ID)
			assert.Equal(t, int64(101), arg.RepositoryID)
			return db.WorkspaceSnapshot{}, pgx.ErrNoRows
		},
		createWorkspaceFn: func(ctx context.Context, arg db.CreateWorkspaceParams) (db.Workspace, error) {
			created = true
			return db.Workspace{}, nil
		},
	}

	svc := newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{}))

	_, err := svc.CreateWorkspace(context.Background(), CreateWorkspaceInput{
		RepositoryID: 101,
		UserID:       7,
		SnapshotID:   "snap-foreign",
	})
	require.Error(t, err)
	assert.False(t, created)

	apiErr, ok := err.(*pkgerrors.APIError)
	require.True(t, ok)
	assert.Equal(t, 404, apiErr.Status)
}

func TestWorkspaceService_CreateWorkspace_WaitsForReadySignal(t *testing.T) {
	t.Parallel()

	q := &mockWorkspaceQuerier{
		getActiveWorkspaceForUserRepoFn: func(ctx context.Context, arg db.GetActiveWorkspaceForUserRepoParams) (db.Workspace, error) {
			return db.Workspace{}, pgx.ErrNoRows
		},
		createWorkspaceFn: func(ctx context.Context, arg db.CreateWorkspaceParams) (db.Workspace, error) {
			assert.Equal(t, "starting", arg.Status)
			workspace := sampleDBWorkspace("ws-primary")
			workspace.VmID = ""
			workspace.Status = "pending"
			return workspace, nil
		},
		updateWorkspaceExecutionInfoFn: func(ctx context.Context, arg db.UpdateWorkspaceExecutionInfoParams) (db.Workspace, error) {
			workspace := sampleDBWorkspace(arg.ID)
			workspace.VmID = arg.VmID
			workspace.Status = arg.Status
			return workspace, nil
		},
	}

	m := newObserveV2Metrics()
	svc := newWorkspaceServiceForTests(q, WithWorkspaceSandboxMetrics(m), WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
		createVMFn: func(ctx context.Context, req sandbox.CreateRequest) (sandbox.CreateResult, error) {
			require.NotNil(t, req.WaitForReady)
			assert.True(t, *req.WaitForReady)
			assert.Equal(t, defaultWorkspaceHome, req.Workdir)
			assertWorkspaceClaudeBootstrap(t, req)
			return sandbox.CreateResult{ID: "vm-primary"}, nil
		},
	}))

	workspace, err := svc.CreateWorkspace(context.Background(), CreateWorkspaceInput{
		RepositoryID: 101,
		UserID:       1,
		Name:         "primary",
	})
	require.NoError(t, err)
	assert.Equal(t, "vm-primary", workspace.VMID)
	assert.Equal(t, "running", workspace.Status)
	require.Equal(t, 1.0, testutil.ToFloat64(m.lifecycle.WithLabelValues("create", "success")))
	require.Equal(t, 1.0, testutil.ToFloat64(m.lifecycle.WithLabelValues("start", "success")))
}

func TestWorkspaceService_CreateWorkspace_MarksFailedWhenProvisioningFails(t *testing.T) {
	t.Parallel()

	var updatedStatuses []string
	q := &mockWorkspaceQuerier{
		getActiveWorkspaceForUserRepoFn: func(ctx context.Context, arg db.GetActiveWorkspaceForUserRepoParams) (db.Workspace, error) {
			return db.Workspace{}, pgx.ErrNoRows
		},
		createWorkspaceFn: func(ctx context.Context, arg db.CreateWorkspaceParams) (db.Workspace, error) {
			assert.Equal(t, "starting", arg.Status)
			workspace := sampleDBWorkspace("ws-primary")
			workspace.VmID = ""
			workspace.Status = arg.Status
			return workspace, nil
		},
		updateWorkspaceStatusFn: func(ctx context.Context, arg db.UpdateWorkspaceStatusParams) (db.Workspace, error) {
			updatedStatuses = append(updatedStatuses, arg.Status)
			workspace := sampleDBWorkspace(arg.ID)
			workspace.VmID = ""
			workspace.Status = arg.Status
			return workspace, nil
		},
	}

	svc := newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
		createVMFn: func(ctx context.Context, req sandbox.CreateRequest) (sandbox.CreateResult, error) {
			return sandbox.CreateResult{}, assert.AnError
		},
	}))

	_, err := svc.CreateWorkspace(context.Background(), CreateWorkspaceInput{
		RepositoryID: 101,
		UserID:       1,
		Name:         "primary",
	})
	require.Error(t, err)
	assert.Equal(t, []string{"failed"}, updatedStatuses)
}

func TestWorkspaceService_CreateWorkspaceAsync_ProvisioningSurvivesCallerCancellation(t *testing.T) {
	t.Parallel()

	releaseCreate := make(chan struct{})
	createDone := make(chan error, 1)
	q := &mockWorkspaceQuerier{
		getActiveWorkspaceForUserRepoFn: func(ctx context.Context, arg db.GetActiveWorkspaceForUserRepoParams) (db.Workspace, error) {
			return db.Workspace{}, pgx.ErrNoRows
		},
		createWorkspaceFn: func(ctx context.Context, arg db.CreateWorkspaceParams) (db.Workspace, error) {
			require.Equal(t, "landing/demo-123", arg.TargetBookmark)
			workspace := sampleDBWorkspace("ws-async")
			workspace.VmID = ""
			workspace.Status = arg.Status
			workspace.TargetBookmark = arg.TargetBookmark
			return workspace, nil
		},
		updateWorkspaceExecutionInfoFn: func(ctx context.Context, arg db.UpdateWorkspaceExecutionInfoParams) (db.Workspace, error) {
			workspace := sampleDBWorkspace(arg.ID)
			workspace.VmID = arg.VmID
			workspace.Status = arg.Status
			workspace.TargetBookmark = "landing/demo-123"
			return workspace, nil
		},
	}
	svc := newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
		createVMFn: func(ctx context.Context, req sandbox.CreateRequest) (sandbox.CreateResult, error) {
			<-releaseCreate
			createDone <- ctx.Err()
			return sandbox.CreateResult{ID: "vm-async"}, nil
		},
	}))

	ctx, cancel := context.WithCancel(context.Background())
	workspace, err := svc.CreateWorkspaceAsync(ctx, CreateWorkspaceInput{
		RepositoryID:   101,
		UserID:         1,
		RepoOwner:      "alice",
		RepoName:       "demo",
		Name:           "dev-ws",
		SourceBookmark: "landing/demo-123",
	})
	require.NoError(t, err)
	require.Equal(t, "starting", workspace.Status)
	require.Equal(t, "landing/demo-123", workspace.TargetBookmark)

	cancel()
	close(releaseCreate)

	select {
	case err := <-createDone:
		require.NoError(t, err)
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for async VM creation")
	}
}

func TestWorkspaceService_CreateWorkspace_BranchBookmarkCreatesDerivedWorkspace(t *testing.T) {
	t.Parallel()

	primary := sampleDBWorkspace("ws-main")
	primary.Name = "main"
	primary.IsFork = false
	primary.Status = "running"
	primary.VmID = "vm-main"
	primary.TargetBookmark = "main"

	var created db.CreateWorkspaceParams
	q := &mockWorkspaceQuerier{
		countWorkspacesByRepoFn: func(ctx context.Context, arg db.CountWorkspacesByRepoParams) (int64, error) {
			return 1, nil
		},
		listWorkspacesByRepoFn: func(ctx context.Context, arg db.ListWorkspacesByRepoParams) ([]db.Workspace, error) {
			return []db.Workspace{primary}, nil
		},
		getActiveWorkspaceForUserRepoFn: func(ctx context.Context, arg db.GetActiveWorkspaceForUserRepoParams) (db.Workspace, error) {
			// No forkable primary → the branch takes the cold create+clone
			// derived path (fork-from-primary coverage lives in
			// workspace_fork_open_test.go). The branch must still create its
			// OWN derived row, never reuse the primary workspace.
			return db.Workspace{}, pgx.ErrNoRows
		},
		createWorkspaceFn: func(ctx context.Context, arg db.CreateWorkspaceParams) (db.Workspace, error) {
			created = arg
			workspace := sampleDBWorkspace("ws-branch")
			workspace.Name = arg.Name
			workspace.IsFork = arg.IsFork
			workspace.VmID = ""
			workspace.Status = arg.Status
			workspace.TargetBookmark = arg.TargetBookmark
			return workspace, nil
		},
		updateWorkspaceExecutionInfoFn: func(ctx context.Context, arg db.UpdateWorkspaceExecutionInfoParams) (db.Workspace, error) {
			workspace := sampleDBWorkspace(arg.ID)
			workspace.IsFork = true
			workspace.VmID = arg.VmID
			workspace.Status = arg.Status
			workspace.TargetBookmark = "landing/demo-123"
			return workspace, nil
		},
	}
	svc := newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
		createVMFn: func(ctx context.Context, req sandbox.CreateRequest) (sandbox.CreateResult, error) {
			return sandbox.CreateResult{ID: "vm-branch"}, nil
		},
		execAwaitFn: func(ctx context.Context, vmID string, req sandbox.ExecRequest) (sandbox.ExecResult, error) {
			assert.Equal(t, "vm-branch", vmID)
			assert.Contains(t, req.Command, "landing/demo-123@origin")
			status := int32(0)
			return sandbox.ExecResult{StatusCode: &status}, nil
		},
	}))

	workspace, err := svc.CreateWorkspace(context.Background(), CreateWorkspaceInput{
		RepositoryID:   101,
		UserID:         1,
		RepoOwner:      "alice",
		RepoName:       "demo",
		Name:           "demo landing",
		SourceBookmark: "landing/demo-123",
	})
	require.NoError(t, err)
	assert.Equal(t, "ws-branch", workspace.ID)
	assert.True(t, created.IsFork)
	assert.Equal(t, "landing/demo-123", created.TargetBookmark)
	assert.Equal(t, "landing/demo-123", workspace.TargetBookmark)
}

func TestWorkspaceService_FindOrCreateWorkspace_VMThenDesktopOnSameBookmarkCreatesTwoWorkspaces(t *testing.T) {
	t.Parallel()

	var workspaces []db.Workspace
	q := &mockWorkspaceQuerier{
		countWorkspacesByRepoFn: func(context.Context, db.CountWorkspacesByRepoParams) (int64, error) {
			return int64(len(workspaces)), nil
		},
		listWorkspacesByRepoFn: func(context.Context, db.ListWorkspacesByRepoParams) ([]db.Workspace, error) {
			return append([]db.Workspace(nil), workspaces...), nil
		},
		getActiveWorkspaceForUserRepoKindFn: func(_ context.Context, arg db.GetActiveWorkspaceForUserRepoKindParams) (db.Workspace, error) {
			for _, workspace := range workspaces {
				if workspace.RepositoryID == arg.RepositoryID && workspace.UserID == arg.UserID && workspace.Kind == arg.Kind {
					return workspace, nil
				}
			}
			return db.Workspace{}, pgx.ErrNoRows
		},
		createWorkspaceFn: func(_ context.Context, arg db.CreateWorkspaceParams) (db.Workspace, error) {
			workspace := sampleDBWorkspace(fmt.Sprintf("ws-%d", len(workspaces)+1))
			workspace.Name = arg.Name
			workspace.TargetBookmark = arg.TargetBookmark
			workspace.Kind = arg.Kind
			workspaces = append(workspaces, workspace)
			return workspace, nil
		},
	}
	svc := newWorkspaceServiceForTests(q)

	vm, err := svc.findOrCreateWorkspaceForBookmark(context.Background(), 101, 1, "proof-vm", "main", workspaceCreateMetadata{kind: "vm"})
	require.NoError(t, err)
	desktop, err := svc.findOrCreateWorkspaceForBookmark(context.Background(), 101, 1, "proof-desktop", "main", workspaceCreateMetadata{kind: "desktop"})
	require.NoError(t, err)

	assert.Equal(t, "vm", vm.Kind)
	assert.Equal(t, "desktop", desktop.Kind)
	assert.NotEqual(t, vm.ID, desktop.ID)
	assert.Len(t, workspaces, 2)
}

func TestWorkspaceService_CreateWorkspaceAsync_ReusesDerivedWorkspaceForSameBookmark(t *testing.T) {
	t.Parallel()

	existing := sampleDBWorkspace("ws-branch")
	existing.IsFork = true
	existing.Status = "running"
	existing.VmID = "vm-branch"
	existing.TargetBookmark = "landing/demo-123"
	existing.Name = "demo landing"

	q := &mockWorkspaceQuerier{
		countWorkspacesByRepoFn: func(ctx context.Context, arg db.CountWorkspacesByRepoParams) (int64, error) {
			return 1, nil
		},
		listWorkspacesByRepoFn: func(ctx context.Context, arg db.ListWorkspacesByRepoParams) ([]db.Workspace, error) {
			return []db.Workspace{existing}, nil
		},
		getActiveWorkspaceForIdentityFn: func(ctx context.Context, arg db.GetActiveWorkspaceForIdentityParams) (db.Workspace, error) {
			return existing, nil
		},
		createWorkspaceFn: func(ctx context.Context, arg db.CreateWorkspaceParams) (db.Workspace, error) {
			t.Fatal("existing branch workspace should be reused")
			return db.Workspace{}, nil
		},
	}
	svc := newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
		createVMFn: func(ctx context.Context, req sandbox.CreateRequest) (sandbox.CreateResult, error) {
			t.Fatal("running branch workspace should not reprovision")
			return sandbox.CreateResult{}, nil
		},
	}))

	workspace, err := svc.CreateWorkspaceAsync(context.Background(), CreateWorkspaceInput{
		RepositoryID:   101,
		UserID:         1,
		RepoOwner:      "alice",
		RepoName:       "demo",
		Name:           "demo landing",
		SourceBookmark: "landing/demo-123",
	})
	require.NoError(t, err)
	assert.Equal(t, existing.ID, workspace.ID)
	assert.Equal(t, "landing/demo-123", workspace.TargetBookmark)
}

func TestBuildWorkspaceCloneCommand_BindsBookmarkWithJj(t *testing.T) {
	t.Parallel()

	command := buildWorkspaceCloneCommand("https://api.smithers.sh/alice/demo.git", "smithers_token", "landing/demo-123", 0)

	// Credential rides GIT_CONFIG_* env (invisible in /proc cmdline), not argv.
	assert.Contains(t, command, "export GIT_CONFIG_KEY_0=http.extraHeader")
	assert.NotContains(t, command, "-c http.extraHeader=")
	assert.Contains(t, command, "git clone --depth 200 --branch "+shellQuote("landing/demo-123")+" -- ")
	// `jj git init` INITIALIZES a repo so must NOT use -R (which addresses an
	// existing jj repo) — `jj -R <path> git init` fails "There is no jj repo in
	// <path>". The dir is the init destination; bookmark ops below DO use -R.
	assert.Contains(t, command, "jj git init --colocate "+shellQuote(defaultWorkspaceClonePath))
	assert.NotContains(t, command, "jj -R "+shellQuote(defaultWorkspaceClonePath)+" git init")
	assert.Contains(t, command, "jj -R "+shellQuote(defaultWorkspaceClonePath)+" bookmark track "+shellQuote("landing/demo-123@origin"))
	assert.Contains(t, command, "jj -R "+shellQuote(defaultWorkspaceClonePath)+" bookmark set "+shellQuote("landing/demo-123")+" -r "+shellQuote("landing/demo-123@origin"))
	assert.Contains(t, command, "jj -R "+shellQuote(defaultWorkspaceClonePath)+" new "+shellQuote("landing/demo-123"))
	assert.NotContains(t, command, "checkout -B")
}

func TestWorkspaceService_CreateWorkspace_ResolvesDefaultBookmarkForClone(t *testing.T) {
	t.Parallel()

	var created db.CreateWorkspaceParams
	q := &mockWorkspaceQuerier{
		getRepoByIDFn: func(_ context.Context, id int64) (db.Repository, error) {
			return db.Repository{ID: id, DefaultBookmark: "trunk"}, nil
		},
		getActiveWorkspaceForUserRepoKindFn: func(context.Context, db.GetActiveWorkspaceForUserRepoKindParams) (db.Workspace, error) {
			return db.Workspace{}, pgx.ErrNoRows
		},
		createWorkspaceFn: func(_ context.Context, arg db.CreateWorkspaceParams) (db.Workspace, error) {
			created = arg
			workspace := sampleDBWorkspace("ws-trunk")
			workspace.VmID = ""
			workspace.Status = "starting"
			workspace.TargetBookmark = arg.TargetBookmark
			workspace.IsFork = arg.IsFork
			return workspace, nil
		},
		updateWorkspaceExecutionInfoFn: func(_ context.Context, arg db.UpdateWorkspaceExecutionInfoParams) (db.Workspace, error) {
			workspace := sampleDBWorkspace(arg.ID)
			workspace.VmID = arg.VmID
			workspace.Status = arg.Status
			workspace.TargetBookmark = "trunk"
			return workspace, nil
		},
	}
	var cloneCommand string
	svc := newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
		createVMFn: func(context.Context, sandbox.CreateRequest) (sandbox.CreateResult, error) {
			return sandbox.CreateResult{ID: "vm-trunk"}, nil
		},
		execAwaitFn: func(_ context.Context, vmID string, req sandbox.ExecRequest) (sandbox.ExecResult, error) {
			assert.Equal(t, "vm-trunk", vmID)
			cloneCommand = req.Command
			status := int32(0)
			return sandbox.ExecResult{StatusCode: &status}, nil
		},
	}))

	workspace, err := svc.CreateWorkspace(context.Background(), CreateWorkspaceInput{
		RepositoryID: 101,
		UserID:       1,
		RepoOwner:    "alice",
		RepoName:     "demo",
		Name:         "primary",
	})
	require.NoError(t, err)
	assert.False(t, created.IsFork, "repository default must use the primary workspace")
	assert.Equal(t, "trunk", created.TargetBookmark)
	assert.Equal(t, "trunk", workspace.TargetBookmark)
	assert.Contains(t, cloneCommand, "git clone --depth 200 --branch "+shellQuote("trunk")+" -- ")
	assert.Contains(t, cloneCommand, "jj git init --colocate "+shellQuote(defaultWorkspaceClonePath))
	assert.Contains(t, cloneCommand, "jj -R "+shellQuote(defaultWorkspaceClonePath)+" new "+shellQuote("trunk"))
}

func TestBuildForkBookmarkSwitchCommand_InitializesMissingJjRepo(t *testing.T) {
	t.Parallel()

	command := buildForkBookmarkSwitchCommand("smithers_token", "landing/demo-123")
	jjDir := shellQuote(defaultWorkspaceClonePath + "/.jj")
	initCommand := "jj git init --colocate " + shellQuote(defaultWorkspaceClonePath)
	fetchCommand := "git -C " + shellQuote(defaultWorkspaceClonePath) + " fetch origin"

	assert.Contains(t, command, workspaceRuntimeReadyCommand())
	assert.NotContains(t, command, shellQuote(workspaceClaudeScriptPath))
	assert.Contains(t, command, "if [ -d "+jjDir+" ]")
	assert.Contains(t, command, "chown -R "+shellQuote(defaultWorkspaceUser)+":"+shellQuote(defaultWorkspaceUser)+" "+jjDir)
	assert.Contains(t, command, initCommand)
	assert.Less(t, strings.Index(command, workspaceRuntimeReadyCommand()), strings.Index(command, "export GIT_CONFIG_KEY_0"))
	assert.Less(t, strings.Index(command, initCommand), strings.Index(command, fetchCommand))
}

// VerifyPairSourceWorkspace must reject a malformed (non-UUID) workspace id with
// a uniform NotFound BEFORE touching the DB — otherwise the UUID-typed column
// makes Postgres raise 22P02 and loadOwnedWorkspace leaks that driver text as a
// raw 500.
func TestWorkspaceService_VerifyPairSourceWorkspace_RejectsMalformedID(t *testing.T) {
	t.Parallel()

	svc := newWorkspaceServiceForTests(&mockWorkspaceQuerier{})
	err := svc.VerifyPairSourceWorkspace(context.Background(), "not-a-uuid", 1, 2)
	require.Error(t, err)
	apiErr, ok := err.(*pkgerrors.APIError)
	require.True(t, ok, "want APIError, got %T", err)
	assert.Equal(t, 404, apiErr.Status, "malformed source workspace id must be a uniform NotFound, not a 500")
}

func TestBuildWorkspaceClaudeBootstrapScript_InstallRendersAsSingleRunnableLine(t *testing.T) {
	t.Parallel()

	script := buildWorkspaceClaudeBootstrapScript()

	// Regression: the claude-install script is rendered into
	// `bash -lc {{printf "%q" .Script}}`. If it is newline-joined, %q escapes
	// each newline into the literal two-character sequence \n, which bash does
	// NOT re-interpret inside a double-quoted -lc argument — collapsing the whole
	// script into one broken command ("set: pipefailnexport: invalid option
	// name") so the claude install silently never runs. It must be a
	// "; "-joined single line.
	assert.NotContains(t, script, `pipefail\nexport`,
		"the claude script must not carry %q-escaped newlines into bash -lc")
	assert.Contains(t, script, "set -euo pipefail; export")
	assert.Contains(t, script, "export NPM_CONFIG_PREFIX=")
	assert.NotContains(t, script, "init --global")
	assert.Contains(t, script, workspaceCLIPackageDir+"/node_modules/@smthrs/cli/bin/smithers.mjs")
}

func TestWorkspaceService_CreateWorkspace_ReplacesStalePendingWorkspaceWithoutVM(t *testing.T) {
	t.Parallel()

	var (
		countCalls      int
		listCalls       int
		updatedStatuses []string
		createCalls     int
	)

	q := &mockWorkspaceQuerier{
		countWorkspacesByRepoFn: func(ctx context.Context, arg db.CountWorkspacesByRepoParams) (int64, error) {
			countCalls++
			return 1, nil
		},
		listWorkspacesByRepoFn: func(ctx context.Context, arg db.ListWorkspacesByRepoParams) ([]db.Workspace, error) {
			listCalls++
			workspace := sampleDBWorkspace("ws-stale")
			workspace.Status = "pending"
			workspace.VmID = ""
			workspace.UpdatedAt = time.Now().Add(-workspaceStaleAfter - time.Minute)
			return []db.Workspace{workspace}, nil
		},
		getActiveWorkspaceForIdentityFn: func(ctx context.Context, arg db.GetActiveWorkspaceForIdentityParams) (db.Workspace, error) {
			return db.Workspace{}, pgx.ErrNoRows
		},
		createWorkspaceFn: func(ctx context.Context, arg db.CreateWorkspaceParams) (db.Workspace, error) {
			createCalls++
			workspace := sampleDBWorkspace("ws-fresh")
			workspace.VmID = ""
			workspace.Status = "starting"
			workspace.Name = arg.Name
			return workspace, nil
		},
		updateWorkspaceExecutionInfoFn: func(ctx context.Context, arg db.UpdateWorkspaceExecutionInfoParams) (db.Workspace, error) {
			workspace := sampleDBWorkspace(arg.ID)
			workspace.VmID = arg.VmID
			workspace.Status = arg.Status
			return workspace, nil
		},
		updateWorkspaceStatusFn: func(ctx context.Context, arg db.UpdateWorkspaceStatusParams) (db.Workspace, error) {
			updatedStatuses = append(updatedStatuses, arg.Status)
			workspace := sampleDBWorkspace(arg.ID)
			workspace.VmID = ""
			workspace.Status = arg.Status
			return workspace, nil
		},
	}

	svc := newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
		createVMFn: func(ctx context.Context, req sandbox.CreateRequest) (sandbox.CreateResult, error) {
			return sandbox.CreateResult{ID: "vm-fresh"}, nil
		},
	}))

	workspace, err := svc.CreateWorkspace(context.Background(), CreateWorkspaceInput{
		RepositoryID: 101,
		UserID:       1,
		RepoOwner:    "alice",
		RepoName:     "demo",
		Name:         "primary",
	})
	require.NoError(t, err)
	assert.Equal(t, 1, countCalls)
	assert.Equal(t, 1, listCalls)
	assert.Equal(t, 1, createCalls)
	assert.Equal(t, []string{"failed"}, updatedStatuses)
	assert.Equal(t, "vm-fresh", workspace.VMID)
}

func TestWorkspaceService_CreateWorkspace_ReusesWinnerWhenActivationConflicts(t *testing.T) {
	t.Parallel()

	var (
		createVMDeleted []string
		statuses        []string
		getActiveCalls  int
	)

	winning := sampleDBWorkspace("ws-winning")
	winning.VmID = "vm-winning"
	winning.Status = "running"

	q := &mockWorkspaceQuerier{
		countWorkspacesByRepoFn: func(ctx context.Context, arg db.CountWorkspacesByRepoParams) (int64, error) {
			return 0, nil
		},
		createWorkspaceFn: func(ctx context.Context, arg db.CreateWorkspaceParams) (db.Workspace, error) {
			workspace := sampleDBWorkspace("ws-race")
			workspace.VmID = ""
			workspace.Status = "starting"
			return workspace, nil
		},
		getActiveWorkspaceForIdentityFn: func(ctx context.Context, arg db.GetActiveWorkspaceForIdentityParams) (db.Workspace, error) {
			getActiveCalls++
			if getActiveCalls == 1 {
				return db.Workspace{}, pgx.ErrNoRows
			}
			return winning, nil
		},
		updateWorkspaceExecutionInfoFn: func(ctx context.Context, arg db.UpdateWorkspaceExecutionInfoParams) (db.Workspace, error) {
			return db.Workspace{}, &pgconn.PgError{Code: "23505", ConstraintName: "uq_workspaces_active"}
		},
		updateWorkspaceStatusFn: func(ctx context.Context, arg db.UpdateWorkspaceStatusParams) (db.Workspace, error) {
			statuses = append(statuses, arg.Status)
			workspace := sampleDBWorkspace(arg.ID)
			workspace.Status = arg.Status
			workspace.VmID = ""
			return workspace, nil
		},
	}

	svc := newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
		createVMFn: func(ctx context.Context, req sandbox.CreateRequest) (sandbox.CreateResult, error) {
			return sandbox.CreateResult{ID: "vm-race"}, nil
		},
		deleteVMFn: func(ctx context.Context, vmID string) error {
			createVMDeleted = append(createVMDeleted, vmID)
			return nil
		},
	}))

	workspace, err := svc.CreateWorkspace(context.Background(), CreateWorkspaceInput{
		RepositoryID: 101,
		UserID:       1,
		RepoOwner:    "alice",
		RepoName:     "demo",
		Name:         "primary",
	})
	require.NoError(t, err)
	assert.Equal(t, winning.ID, workspace.ID)
	assert.Equal(t, []string{"vm-race"}, createVMDeleted)
	assert.Equal(t, []string{"failed"}, statuses)
	assert.Equal(t, 2, getActiveCalls)
}

func TestWorkspaceService_CreateWorkspace_PreservesStoppedVMOnResumeTimeout(t *testing.T) {
	t.Parallel()

	var updatedStatuses []string
	var executionUpdates []db.UpdateWorkspaceExecutionInfoParams
	q := &mockWorkspaceQuerier{
		getActiveWorkspaceForIdentityFn: func(ctx context.Context, arg db.GetActiveWorkspaceForIdentityParams) (db.Workspace, error) {
			workspace := sampleDBWorkspace("ws-primary")
			workspace.VmID = "vm-stopped"
			workspace.Status = "suspended"
			return workspace, nil
		},
		updateWorkspaceStatusFn: func(ctx context.Context, arg db.UpdateWorkspaceStatusParams) (db.Workspace, error) {
			updatedStatuses = append(updatedStatuses, arg.Status)
			workspace := sampleDBWorkspace(arg.ID)
			workspace.VmID = "vm-stopped"
			workspace.Status = arg.Status
			return workspace, nil
		},
		suspendRunningWorkspaceFn: func(ctx context.Context, id string) (db.Workspace, error) {
			// The row is 'suspended', so the reprovision gauge-release CAS loses.
			return db.Workspace{}, pgx.ErrNoRows
		},
		updateWorkspaceExecutionInfoFn: func(ctx context.Context, arg db.UpdateWorkspaceExecutionInfoParams) (db.Workspace, error) {
			executionUpdates = append(executionUpdates, arg)
			workspace := sampleDBWorkspace(arg.ID)
			workspace.VmID = arg.VmID
			workspace.Status = arg.Status
			return workspace, nil
		},
	}

	var deletedVMs []string
	svc := newWorkspaceServiceForTests(
		q,
		WithWorkspaceGitBaseURL("https://api.smithers.sh"),
		WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
			getVMFn: func(ctx context.Context, vmID string) (sandbox.Sandbox, error) {
				return sandbox.Sandbox{ID: vmID, State: sandbox.StateStopped}, nil
			},
			deleteVMFn: func(ctx context.Context, vmID string) error {
				deletedVMs = append(deletedVMs, vmID)
				return nil
			},
			startVMFn: func(ctx context.Context, vmID string, req sandbox.StartRequest) (sandbox.StartResult, error) {
				_, hasDeadline := ctx.Deadline()
				assert.True(t, hasDeadline)
				assert.Equal(t, "vm-stopped", vmID)
				return sandbox.StartResult{}, context.DeadlineExceeded
			},
			createVMFn: func(ctx context.Context, req sandbox.CreateRequest) (sandbox.CreateResult, error) {
				assert.Empty(t, req.GitRepos)
				require.NotNil(t, req.WaitForReady)
				assert.True(t, *req.WaitForReady)
				assert.Equal(t, defaultWorkspaceHome, req.Workdir)
				assertWorkspaceClaudeBootstrap(t, req)
				return sandbox.CreateResult{ID: "vm-replacement"}, nil
			},
			execAwaitFn: func(ctx context.Context, vmID string, req sandbox.ExecRequest) (sandbox.ExecResult, error) {
				assert.Equal(t, "vm-replacement", vmID)
				assert.Contains(t, req.Command, "GIT_CONFIG_KEY_0=http.extraHeader")
				assert.Contains(t, req.Command, "/roninjin10/smithers.git")
				assert.Contains(t, req.Command, defaultWorkspaceClonePath)
				status := int32(0)
				return sandbox.ExecResult{StatusCode: &status}, nil
			},
		}),
	)

	_, err := svc.CreateWorkspace(context.Background(), CreateWorkspaceInput{
		RepositoryID: 101,
		UserID:       1,
		RepoOwner:    "roninjin10",
		RepoName:     "smithers",
		Name:         "primary",
	})
	require.Error(t, err)
	assert.Empty(t, updatedStatuses)
	assert.Empty(t, executionUpdates)
	assert.Empty(t, deletedVMs)

}

func TestWorkspaceService_ForkWorkspace_UsesFork(t *testing.T) {
	t.Parallel()

	// Workspace IDs must be valid UUIDs because ParentWorkspaceID is stored as
	// pgtype.UUID; stringToUUID silently returns an invalid UUID for non-UUID strings.
	const sourceID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
	const forkID = "11111111-2222-3333-4444-555555555555"

	q := &mockWorkspaceQuerier{
		getWorkspaceByRepoFn: func(ctx context.Context, arg db.GetWorkspaceByRepoParams) (db.Workspace, error) {
			workspace := sampleDBWorkspace(arg.ID)
			workspace.VmID = "vm-source"
			return workspace, nil
		},
		createWorkspaceFn: func(ctx context.Context, arg db.CreateWorkspaceParams) (db.Workspace, error) {
			assert.True(t, arg.IsFork)
			assert.Equal(t, stringToUUID(sourceID), arg.ParentWorkspaceID)
			assert.Equal(t, "starting", arg.Status)
			workspace := sampleDBWorkspace(forkID)
			workspace.Name = arg.Name
			workspace.IsFork = true
			workspace.ParentWorkspaceID = arg.ParentWorkspaceID
			workspace.VmID = ""
			workspace.Status = "pending"
			return workspace, nil
		},
		updateWorkspaceExecutionInfoFn: func(ctx context.Context, arg db.UpdateWorkspaceExecutionInfoParams) (db.Workspace, error) {
			workspace := sampleDBWorkspace(arg.ID)
			workspace.IsFork = true
			workspace.ParentWorkspaceID = stringToUUID(sourceID)
			workspace.VmID = arg.VmID
			workspace.Status = arg.Status
			return workspace, nil
		},
	}

	svc := newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
		getVMFn: func(ctx context.Context, vmID string) (sandbox.Sandbox, error) {
			return sandbox.Sandbox{ID: vmID, State: sandbox.StateRunning}, nil
		},
		forkVMFn: func(ctx context.Context, sourceVMID string, req sandbox.ForkRequest) (sandbox.CreateResult, error) {
			assert.Equal(t, "vm-source", sourceVMID)
			require.NotNil(t, req.IdleTimeoutSeconds)
			return sandbox.CreateResult{ID: "vm-forked"}, nil
		},
	}))

	workspace, err := svc.ForkWorkspace(context.Background(), ForkWorkspaceInput{
		RepositoryID: 101,
		UserID:       1,
		WorkspaceID:  sourceID,
		Name:         "parallel",
	})
	require.NoError(t, err)
	assert.Equal(t, "vm-forked", workspace.VMID)
	assert.True(t, workspace.IsFork)
	assert.Equal(t, sourceID, workspace.ParentWorkspaceID)
}

func TestWorkspaceService_CreateWorkspaceSnapshot_PersistsSnapshotID(t *testing.T) {
	t.Parallel()

	q := &mockWorkspaceQuerier{
		getWorkspaceByRepoFn: func(ctx context.Context, arg db.GetWorkspaceByRepoParams) (db.Workspace, error) {
			workspace := sampleDBWorkspace(arg.ID)
			workspace.VmID = "vm-source"
			return workspace, nil
		},
		createWorkspaceSnapshotFn: func(ctx context.Context, arg db.CreateWorkspaceSnapshotParams) (db.WorkspaceSnapshot, error) {
			assert.Equal(t, "ws-source", arg.WorkspaceID)
			assert.Equal(t, "fs-snap-456", arg.SnapshotID)
			return sampleDBWorkspaceSnapshot("snap-local-456", arg.WorkspaceID, arg.Name, arg.SnapshotID), nil
		},
	}

	svc := newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
		getVMFn: func(ctx context.Context, vmID string) (sandbox.Sandbox, error) {
			return sandbox.Sandbox{ID: vmID, State: sandbox.StateRunning}, nil
		},
		snapshotVMFn: func(ctx context.Context, vmID string, req sandbox.SnapshotRequest) (sandbox.SnapshotResult, error) {
			assert.Equal(t, "vm-source", vmID)
			assert.Equal(t, "restore-point", req.Name)
			return sandbox.SnapshotResult{SnapshotID: "fs-snap-456", SourceSandboxID: vmID}, nil
		},
	}))

	snapshot, err := svc.CreateWorkspaceSnapshot(context.Background(), CreateWorkspaceSnapshotInput{
		RepositoryID: 101,
		UserID:       1,
		WorkspaceID:  "ws-source",
		Name:         "restore-point",
	})
	require.NoError(t, err)
	assert.Equal(t, "snap-local-456", snapshot.ID)
	assert.Equal(t, "fs-snap-456", snapshot.SnapshotID)
}

func TestWorkspaceService_DeleteWorkspaceSnapshot_IgnoresMissingSnapshot(t *testing.T) {
	t.Parallel()

	deleted := false
	q := &mockWorkspaceQuerier{
		getWorkspaceSnapshotByRepoFn: func(ctx context.Context, arg db.GetWorkspaceSnapshotByRepoParams) (db.WorkspaceSnapshot, error) {
			return sampleDBWorkspaceSnapshot(arg.ID, "ws-source", "snapshot", "fs-snap-missing"), nil
		},
		deleteWorkspaceSnapshotFn: func(ctx context.Context, id string) error {
			deleted = true
			assert.Equal(t, "snap-local-missing", id)
			return nil
		},
	}

	svc := newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
		deleteSnapshotFn: func(ctx context.Context, snapshotID string) error {
			assert.Equal(t, "fs-snap-missing", snapshotID)
			return &sandbox.StatusError{StatusCode: 404}
		},
	}))

	err := svc.DeleteWorkspaceSnapshot(context.Background(), "snap-local-missing", 101, 1)
	require.NoError(t, err)
	assert.True(t, deleted)
}

type boundSecretsAgentEnvironmentProvider struct {
	staticAgentEnvironmentProvider
	bound []sandbox.EgressProxySecret
	err   error
	calls []int64
}

func (p *boundSecretsAgentEnvironmentProvider) LoadProxyBoundSecrets(_ context.Context, repositoryID int64) ([]sandbox.EgressProxySecret, error) {
	p.calls = append(p.calls, repositoryID)
	return p.bound, p.err
}

func TestBuildWorkspaceVMRequest_BindsRepositorySecretsToTheEgressProxy(t *testing.T) {
	t.Parallel()
	provider := &boundSecretsAgentEnvironmentProvider{bound: []sandbox.EgressProxySecret{{
		Name: "API_KEY", Value: "bound-value", Hosts: []string{"api.example.com"}, MatchHeaders: []string{"authorization"},
	}}}
	svc := newWorkspaceServiceForTests(&mockWorkspaceQuerier{})
	svc.agentEnvironment = provider

	req, err := svc.buildWorkspaceVMRequest(context.Background(), "", nil, 123, "", "container")
	require.NoError(t, err)
	require.NotNil(t, req.EgressProxy)
	assert.True(t, req.EgressProxy.Enabled)
	require.Len(t, req.EgressProxy.Secrets, 1)
	assert.Equal(t, "API_KEY", req.EgressProxy.Secrets[0].Name)
	assert.Equal(t, []int64{123}, provider.calls)
	// The value rides only inside the proxy policy: never in a guest file or
	// a declared service environment.
	for path, file := range req.Files {
		assert.NotContains(t, file.Content, "bound-value", path)
	}
	for _, service := range req.Init.Services {
		for _, value := range service.Env {
			assert.NotContains(t, value, "bound-value")
		}
	}

	// The golden bake (repository 0) is proxied but binds nothing, so the
	// baked disk never carries a repository's secrets.
	golden := svc.GoldenBakeVMRequest()
	require.NotNil(t, golden.EgressProxy)
	assert.True(t, golden.EgressProxy.Enabled)
	assert.Empty(t, golden.EgressProxy.Secrets)
	assert.Equal(t, []int64{123}, provider.calls, "repository 0 never consults the loader")

	// A loader failure fails the create closed rather than booting with
	// fewer bindings than the repository declared.
	provider.err = errors.New("db down")
	_, err = svc.buildWorkspaceVMRequest(context.Background(), "", nil, 123, "", "container")
	require.Error(t, err)
	// A provider without the loader (test fakes, disabled environments)
	// still gets the proxy boundary.
	svc.agentEnvironment = staticAgentEnvironmentProvider{}
	req, err = svc.buildWorkspaceVMRequest(context.Background(), "", nil, 123, "", "container")
	require.NoError(t, err)
	assert.True(t, req.EgressProxy.Enabled)
	assert.Empty(t, req.EgressProxy.Secrets)
}
