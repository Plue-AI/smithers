package services

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/base64"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
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
	assert.Contains(t, scriptFile.Content, defaultWorkspaceGuestLayout.localBinDir())
	assert.Contains(t, scriptFile.Content, defaultWorkspaceGuestLayout.localNodeDir())
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
	f := newBranchMachineFixture(t)
	ctx := context.Background()
	source, err := f.q.CreateWorkspace(ctx, db.CreateWorkspaceParams{RepositoryID: f.repo, UserID: f.user, Name: "source", TargetBookmark: "source", Kind: "container", Status: "running"})
	require.NoError(t, err)
	snapshot, err := f.q.CreateWorkspaceSnapshot(ctx, db.CreateWorkspaceSnapshotParams{RepositoryID: f.repo, UserID: f.user, WorkspaceID: source.ID, Name: "snapshot", SnapshotID: "fs-snap-123"})
	require.NoError(t, err)

	svc := f.service(nil, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
		createVMFn: func(ctx context.Context, req sandbox.CreateRequest) (sandbox.CreateResult, error) {
			assert.Equal(t, "fs-snap-123", req.SnapshotID)
			require.NotNil(t, req.WaitForReady)
			assert.True(t, *req.WaitForReady)
			assert.Equal(t, defaultWorkspaceHome, req.Workdir)
			assertWorkspaceClaudeBootstrap(t, req)
			return sandbox.CreateResult{ID: "vm-restored"}, nil
		},
	}))

	workspace, err := svc.CreateWorkspace(ctx, CreateWorkspaceInput{
		RepositoryID:   f.repo,
		UserID:         f.user,
		RepoOwner:      "alice",
		RepoName:       "demo",
		Name:           "restored",
		SnapshotID:     snapshot.ID,
		SourceBookmark: "restored",
	})
	require.NoError(t, err)
	assert.Equal(t, "vm-restored", workspace.VMID)
	assert.Equal(t, snapshot.ID, workspace.SnapshotID)
	assert.True(t, workspace.IsFork)
	row, err := f.q.GetWorkspace(ctx, workspace.ID)
	require.NoError(t, err)
	assert.Equal(t, stringToUUID(snapshot.ID), row.SourceSnapshotID)
	assert.Equal(t, "restored", row.Name)
	assert.Equal(t, "running", row.Status)
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

	vm, err := svc.createFreshWorkspaceVM(context.Background(), db.Workspace{RepositoryID: 0, ID: "", ProvisioningGeneration: 0, Kind: "container"})
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

	_, err := svc.createFreshWorkspaceVM(context.Background(), db.Workspace{RepositoryID: 0, ID: "", ProvisioningGeneration: 0, Kind: "container"})
	require.Error(t, err, "when both attempts fail it is a Microsandbox problem, surface the error")
	assert.Empty(t, goldenDB.markedBadIDs, "a full outage must NOT invalidate a good snapshot")
}

func TestWorkspaceService_CreateWorkspace_FromSnapshotRejectsForeignSnapshot(t *testing.T) {
	t.Parallel()
	f := newBranchMachineFixture(t)
	ctx := context.Background()
	otherUser, otherRepo := setupTestUserAndRepo(t, f.pool)
	source, err := f.q.CreateWorkspace(ctx, db.CreateWorkspaceParams{RepositoryID: otherRepo, UserID: otherUser, Name: "source", TargetBookmark: "source", Kind: "container", Status: "running"})
	require.NoError(t, err)
	foreign, err := f.q.CreateWorkspaceSnapshot(ctx, db.CreateWorkspaceSnapshotParams{RepositoryID: otherRepo, UserID: otherUser, WorkspaceID: source.ID, Name: "foreign", SnapshotID: "fs-foreign"})
	require.NoError(t, err)

	created := false
	svc := f.service(nil, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
		createVMFn: func(context.Context, sandbox.CreateRequest) (sandbox.CreateResult, error) {
			created = true
			return sandbox.CreateResult{ID: "vm-foreign"}, nil
		},
	}))

	_, err = svc.CreateWorkspace(ctx, CreateWorkspaceInput{
		RepositoryID:   f.repo,
		UserID:         f.user,
		SnapshotID:     foreign.ID,
		SourceBookmark: "restored",
	})
	require.Error(t, err)
	assert.False(t, created)
	assert.Empty(t, f.branch(t, "restored"), "a foreign snapshot reserves no machine")

	apiErr, ok := err.(*pkgerrors.APIError)
	require.True(t, ok)
	assert.Equal(t, 404, apiErr.Status)
}

func TestWorkspaceService_CreateWorkspace_WaitsForReadySignal(t *testing.T) {
	t.Parallel()
	f := newBranchMachineFixture(t)

	m := newObserveV2Metrics()
	svc := f.service(nil, WithWorkspaceSandboxMetrics(m), WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
		createVMFn: func(ctx context.Context, req sandbox.CreateRequest) (sandbox.CreateResult, error) {
			require.NotNil(t, req.WaitForReady)
			assert.True(t, *req.WaitForReady)
			assert.Equal(t, defaultWorkspaceHome, req.Workdir)
			assertWorkspaceClaudeBootstrap(t, req)
			return sandbox.CreateResult{ID: "vm-primary"}, nil
		},
	}))

	workspace, err := svc.CreateWorkspace(context.Background(), CreateWorkspaceInput{
		RepositoryID: f.repo,
		UserID:       f.user,
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
	f := newBranchMachineFixture(t)

	svc := f.service(nil, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
		createVMFn: func(ctx context.Context, req sandbox.CreateRequest) (sandbox.CreateResult, error) {
			return sandbox.CreateResult{}, assert.AnError
		},
	}))

	_, err := svc.CreateWorkspace(context.Background(), CreateWorkspaceInput{
		RepositoryID: f.repo,
		UserID:       f.user,
		Name:         "primary",
	})
	require.Error(t, err)
	rows := f.branch(t, "main")
	require.Len(t, rows, 1)
	assert.Equal(t, "failed", rows[0].Status)
}

func TestWorkspaceService_CreateWorkspaceAsync_ProvisioningSurvivesCallerCancellation(t *testing.T) {
	t.Parallel()
	f := newBranchMachineFixture(t)

	releaseCreate := make(chan struct{})
	createDone := make(chan error, 1)
	svc := f.service(nil, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
		createVMFn: func(ctx context.Context, req sandbox.CreateRequest) (sandbox.CreateResult, error) {
			<-releaseCreate
			createDone <- ctx.Err()
			return sandbox.CreateResult{ID: "vm-async"}, nil
		},
	}))

	ctx, cancel := context.WithCancel(context.Background())
	workspace, err := svc.CreateWorkspaceAsync(ctx, CreateWorkspaceInput{
		RepositoryID:   f.repo,
		UserID:         f.user,
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
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for async VM creation")
	}
	require.NoError(t, svc.WaitForProvisioning(context.Background()))
	row, err := f.q.GetWorkspace(context.Background(), workspace.ID)
	require.NoError(t, err)
	assert.Equal(t, "vm-async", row.VmID, "the canceled caller's VM is still registered")
}

func TestWorkspaceService_CreateWorkspace_BranchBookmarkCreatesDerivedWorkspace(t *testing.T) {
	t.Parallel()
	f := newBranchMachineFixture(t)
	// No forkable primary (it has no VM) sends the branch down the cold
	// create+clone path; fork-from-primary coverage lives in
	// workspace_fork_open_test.go. The branch still gets its OWN machine.
	primary := f.machine(t, db.CreateWorkspaceParams{Name: "main", TargetBookmark: "main", Status: "pending"})

	var cloneCommand string
	svc := f.service(nil, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
		createVMFn: func(ctx context.Context, req sandbox.CreateRequest) (sandbox.CreateResult, error) {
			return sandbox.CreateResult{ID: "vm-branch"}, nil
		},
		execAwaitFn: func(ctx context.Context, vmID string, req sandbox.ExecRequest) (sandbox.ExecResult, error) {
			assert.Equal(t, "vm-branch", vmID)
			if strings.Contains(req.Command, "git clone") {
				cloneCommand = req.Command
			}
			status := int32(0)
			return sandbox.ExecResult{StatusCode: &status}, nil
		},
	}))

	workspace, err := svc.CreateWorkspace(context.Background(), CreateWorkspaceInput{
		RepositoryID:   f.repo,
		UserID:         f.user,
		RepoOwner:      "alice",
		RepoName:       "demo",
		Name:           "demo landing",
		SourceBookmark: "landing/demo-123",
	})
	require.NoError(t, err)
	assert.NotEqual(t, primary.ID, workspace.ID)
	assert.Equal(t, "vm-branch", workspace.VMID)
	assert.Equal(t, "landing/demo-123", workspace.TargetBookmark)
	created, err := f.q.GetWorkspace(context.Background(), workspace.ID)
	require.NoError(t, err)
	assert.True(t, created.IsFork)
	assert.Equal(t, "landing/demo-123", created.TargetBookmark)
	assert.Contains(t, cloneCommand, "landing/demo-123@origin")
}

func TestWorkspaceService_CreateWorkspaceAsync_ReusesDerivedWorkspaceForSameBookmark(t *testing.T) {
	t.Parallel()
	f := newBranchMachineFixture(t)
	existing := f.machine(t, db.CreateWorkspaceParams{Name: "demo landing", TargetBookmark: "landing/demo-123", IsFork: true, Status: "running"})
	f.exec(t, `UPDATE workspaces SET vm_id='vm-branch' WHERE id=$1`, existing.ID)

	svc := f.service(nil, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
		createVMFn: func(ctx context.Context, req sandbox.CreateRequest) (sandbox.CreateResult, error) {
			t.Error("running branch workspace should not reprovision")
			return sandbox.CreateResult{}, nil
		},
	}))

	workspace, err := svc.CreateWorkspaceAsync(context.Background(), CreateWorkspaceInput{
		RepositoryID:   f.repo,
		UserID:         f.user,
		RepoOwner:      "alice",
		RepoName:       "demo",
		Name:           "demo landing",
		SourceBookmark: "landing/demo-123",
	})
	require.NoError(t, err)
	require.NoError(t, svc.WaitForProvisioning(context.Background()))
	assert.Equal(t, existing.ID, workspace.ID)
	assert.Equal(t, "landing/demo-123", workspace.TargetBookmark)
	assert.Len(t, f.branch(t, "landing/demo-123"), 1)
}

func TestBuildWorkspaceCloneCommand_BindsBookmarkWithJj(t *testing.T) {
	t.Parallel()

	command := buildWorkspaceCloneCommand("https://api.smithers.sh/alice/demo.git", "smithers_token", "landing/demo-123", 0, workspaceCloneSource{})

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
	f := newBranchMachineFixture(t)
	f.exec(t, `UPDATE repositories SET default_bookmark='trunk' WHERE id=$1`, f.repo)

	var cloneCommand string
	svc := f.service(nil, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
		createVMFn: func(context.Context, sandbox.CreateRequest) (sandbox.CreateResult, error) {
			return sandbox.CreateResult{ID: "vm-trunk"}, nil
		},
		execAwaitFn: func(_ context.Context, vmID string, req sandbox.ExecRequest) (sandbox.ExecResult, error) {
			assert.Equal(t, "vm-trunk", vmID)
			if strings.Contains(req.Command, "git clone") {
				cloneCommand = req.Command
			}
			status := int32(0)
			return sandbox.ExecResult{StatusCode: &status}, nil
		},
	}))

	workspace, err := svc.CreateWorkspace(context.Background(), CreateWorkspaceInput{
		RepositoryID: f.repo,
		UserID:       f.user,
		RepoOwner:    "alice",
		RepoName:     "demo",
		Name:         "primary",
	})
	require.NoError(t, err)
	created, err := f.q.GetWorkspace(context.Background(), workspace.ID)
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

func TestBuildWorkspaceClaudeBootstrapScript_InstallRendersAsSingleRunnableLine(t *testing.T) {
	t.Parallel()

	script := buildWorkspaceClaudeBootstrapScript(defaultWorkspaceGuestLayout)

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

func TestWorkspaceService_CreateWorkspace_ReusesWinnerWhenActivationConflicts(t *testing.T) {
	t.Parallel()
	f := newBranchMachineFixture(t)

	winning := sampleDBWorkspace("ws-winning")
	winning.RepositoryID = f.repo
	winning.VmID = "vm-winning"
	winning.Status = "running"
	store := &activationConflictQuerier{Queries: f.q, winner: winning}

	var createVMDeleted []string
	svc := f.service(store, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
		createVMFn: func(ctx context.Context, req sandbox.CreateRequest) (sandbox.CreateResult, error) {
			return sandbox.CreateResult{ID: "vm-race"}, nil
		},
		deleteVMFn: func(ctx context.Context, vmID string) error {
			createVMDeleted = append(createVMDeleted, vmID)
			return nil
		},
	}))

	workspace, err := svc.CreateWorkspace(context.Background(), CreateWorkspaceInput{
		RepositoryID: f.repo,
		UserID:       f.user,
		RepoOwner:    "alice",
		RepoName:     "demo",
		Name:         "primary",
	})
	require.NoError(t, err)
	assert.Equal(t, winning.ID, workspace.ID)
	assert.Equal(t, []string{"vm-race"}, createVMDeleted)
	assert.Equal(t, 1, store.lookups)
	rows := f.branch(t, "main")
	require.Len(t, rows, 1)
	assert.Equal(t, "failed", rows[0].Status, "the losing machine is failed, not left active")
}

// A resume that times out keeps the asleep machine: no replacement VM, no
// delete and no status write. Since de86a86992 (#3565) CreateWorkspace joins
// the canonical main machine, and the wake passes machine admission
// (c240bd3cf7, #3568), so the case composes both instead of meeting them.
func TestWorkspaceService_CreateWorkspace_PreservesStoppedVMOnResumeTimeout(t *testing.T) {
	t.Parallel()
	pool, member, repo, asleep := asleepMainMachine(t, "vm-stopped")

	var starts, creates int
	var deletedVMs []string
	svc := composeHostedSandboxWake(newWorkspaceServiceForTests(
		db.New(pool),
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
				starts++
				_, hasDeadline := ctx.Deadline()
				assert.True(t, hasDeadline, "a resume is bounded")
				assert.Equal(t, "vm-stopped", vmID)
				return sandbox.StartResult{}, context.DeadlineExceeded
			},
			createVMFn: func(ctx context.Context, req sandbox.CreateRequest) (sandbox.CreateResult, error) {
				creates++
				return sandbox.CreateResult{ID: "vm-replacement"}, nil
			},
		}),
	), pool)

	_, err := svc.CreateWorkspace(context.Background(), CreateWorkspaceInput{RepositoryID: repo, UserID: member, RepoOwner: "roninjin10", RepoName: "smithers", Name: "primary"})
	var refusal *pkgerrors.APIError
	require.ErrorAs(t, err, &refusal)
	assert.Equal(t, 503, refusal.Status, "a timed-out resume is retryable")
	assert.Positive(t, starts)
	assert.Zero(t, creates, "a timed-out resume never replaces the machine")
	assert.Empty(t, deletedVMs)
	row, err := db.New(pool).GetWorkspace(context.Background(), asleep.ID)
	require.NoError(t, err)
	assert.Equal(t, "vm-stopped", row.VmID)
	assert.Equal(t, "suspended", row.Status)
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

// Both bootstrap variants install one exact Claude Code release, so every
// workspace runs the `claude` a flow was tested against (plue#776).
func TestWorkspaceBootstrapsInstallPinnedClaudeCode(t *testing.T) {
	t.Parallel()
	for name, script := range map[string]string{
		"container": buildWorkspaceClaudeBootstrapScript(defaultWorkspaceGuestLayout),
		"nixos":     buildWorkspaceNixBootstrapScript(defaultWorkspaceGuestLayout),
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			assert.Regexp(t, `npm install -g \\"@anthropic-ai/claude-code@\d+\.\d+\.\d+\\"`, script)
			assert.NotRegexp(t, `@anthropic-ai/claude-code\\"`, script, "an unversioned package resolves the registry's latest")
		})
	}
}

// The artifact bootstrap runs with workspaceArtifactGuestPath. A container
// guest keeps bun, jj and node in /usr/local/bin, so a PATH without it made
// the bootstrap report "required JJ 0.39.0 could not be installed" and fail
// every container workspace (prod, 2026-10-01). A stand-in for /usr/local/bin
// proves the bootstrap's own lookup finds a tool there.
func TestWorkspaceArtifactGuestPathFindsContainerTools(t *testing.T) {
	t.Parallel()
	dirs := strings.Split(strings.TrimSuffix(strings.TrimPrefix(workspaceArtifactGuestPath, "PATH="), "; export PATH; "), ":")
	require.Contains(t, dirs, "/usr/local/bin")
	require.Contains(t, dirs, "/run/current-system/sw/bin")
	for _, system := range []string{"/usr/bin", "/bin"} {
		assert.Less(t, slices.Index(dirs, system), slices.Index(dirs, "/usr/local/bin"), "/usr/local/bin must not shadow %s", system)
	}

	local := t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(local, "jj"), []byte("#!/bin/sh\necho 'jj 0.39.0-d9689cd9'\n"), 0o755))
	guestPath := strings.ReplaceAll(workspaceArtifactGuestPath, "/usr/local/bin", local)
	out, err := exec.Command("/bin/sh", "-c", guestPath+`jj --version | grep -Eq '^jj 0\.39\.0([-+].*)?$' && echo found`).CombinedOutput()
	require.NoError(t, err, string(out))
	assert.Equal(t, "found\n", string(out))
}

// One branch has one machine (de86a86992, #3565): a later caller asking for
// another kind on the same bookmark joins the existing machine instead of
// creating a second computer, as the old per-requester identity did.
func TestWorkspaceService_FindOrCreateWorkspace_KindsOnOneBookmarkShareTheBranchMachine(t *testing.T) {
	t.Parallel()
	f := newBranchMachineFixture(t)
	ctx := context.Background()
	svc := f.service(nil)

	vm, err := svc.findOrCreateWorkspaceForBookmark(ctx, f.repo, f.user, "proof-vm", "main", workspaceCreateMetadata{kind: "vm"})
	require.NoError(t, err)
	container, err := svc.findOrCreateWorkspaceForBookmark(ctx, f.repo, f.user, "proof-container", "main", workspaceCreateMetadata{kind: "container"})
	require.NoError(t, err)

	assert.Equal(t, "vm", vm.Kind)
	assert.Equal(t, vm.ID, container.ID)
	assert.Equal(t, "vm", container.Kind, "the machine keeps the kind it was created with")
	assert.Len(t, f.branch(t, "main"), 1)

	_, err = svc.findOrCreateWorkspaceForBookmark(ctx, f.repo, f.user, "proof-desktop", "main", workspaceCreateMetadata{kind: "desktop"})
	assert.Equal(t, 400, apiStatus(t, err))
}

// A branch machine left pending with no VM (a provisioner that died before
// creating one) is provisioned in place by the next open. de86a86992 (#3565)
// replaced the per-requester stale-row replacement with the one canonical
// machine per branch, so the open neither fails the row nor adds a second.
func TestWorkspaceService_CreateWorkspace_ProvisionsStalePendingBranchMachineInPlace(t *testing.T) {
	t.Parallel()
	f := newBranchMachineFixture(t)
	stale := f.machine(t, db.CreateWorkspaceParams{Name: "primary", TargetBookmark: "main", Status: "pending"})
	f.exec(t, `UPDATE workspaces SET updated_at=$2 WHERE id=$1`, stale.ID, time.Now().Add(-workspaceStaleAfter-time.Minute))

	svc := f.service(nil, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
		createVMFn: func(ctx context.Context, req sandbox.CreateRequest) (sandbox.CreateResult, error) {
			return sandbox.CreateResult{ID: "vm-fresh"}, nil
		},
	}))

	workspace, err := svc.CreateWorkspace(context.Background(), CreateWorkspaceInput{
		RepositoryID: f.repo,
		UserID:       f.user,
		RepoOwner:    "alice",
		RepoName:     "demo",
		Name:         "primary",
	})
	require.NoError(t, err)
	assert.Equal(t, stale.ID, workspace.ID)
	assert.Equal(t, "vm-fresh", workspace.VMID)
	rows := f.branch(t, "main")
	require.Len(t, rows, 1)
	assert.Equal(t, "running", rows[0].Status)
}

func (q *activationConflictQuerier) UpdateWorkspaceExecutionInfo(ctx context.Context, arg db.UpdateWorkspaceExecutionInfoParams) (db.Workspace, error) {
	if arg.Status == "running" {
		return db.Workspace{}, &pgconn.PgError{Code: "23505", ConstraintName: "uq_workspaces_active"}
	}
	return q.Queries.UpdateWorkspaceExecutionInfo(ctx, arg)
}

func (q *activationConflictQuerier) GetActiveWorkspaceForIdentity(context.Context, db.GetActiveWorkspaceForIdentityParams) (db.Workspace, error) {
	q.lookups++
	return q.winner, nil
}

// ForkWorkspace hands the source machine to the stack's revision writer.
// f6e8615156 (#3525) removed the hosted path that forked the source VM, so a
// fork never copies the source sandbox.
func TestWorkspaceService_ForkWorkspace_UsesRevisionWriter(t *testing.T) {
	t.Parallel()
	f := newBranchMachineFixture(t)
	source := f.machine(t, db.CreateWorkspaceParams{Name: "source", TargetBookmark: "source", Status: "running"})
	f.exec(t, `UPDATE workspaces SET vm_id='vm-source' WHERE id=$1`, source.ID)

	svc := f.service(nil, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
		forkVMFn: func(context.Context, string, sandbox.ForkRequest) (sandbox.CreateResult, error) {
			t.Error("a fork never copies the source VM")
			return sandbox.CreateResult{}, nil
		},
	}))
	var handed db.Workspace
	var request ForkWorkspaceInput
	svc.revisionFork = func(_ context.Context, src db.Workspace, input ForkWorkspaceInput) (WorkspaceResponse, error) {
		handed, request = src, input
		return WorkspaceResponse{ID: "fork", IsFork: true, ParentWorkspaceID: src.ID}, nil
	}

	workspace, err := svc.ForkWorkspace(context.Background(), ForkWorkspaceInput{
		RepositoryID: f.repo,
		UserID:       f.user,
		WorkspaceID:  source.ID,
		Name:         "parallel",
	})
	require.NoError(t, err)
	assert.Equal(t, source.ID, handed.ID)
	assert.Equal(t, "parallel", request.Name)
	assert.True(t, workspace.IsFork)
	assert.Equal(t, source.ID, workspace.ParentWorkspaceID)
}

func newBranchMachineFixture(t *testing.T) branchMachineFixture {
	t.Helper()
	pool := newProductTestPool(t)
	user, repo := setupTestUserAndRepo(t, pool)
	return branchMachineFixture{pool: pool, q: db.New(pool), user: user, repo: repo}
}

// service builds the workspace service over store, the fixture's database
// when nil; a test wraps the database to inject one store outcome.
func (f branchMachineFixture) service(store WorkspaceQuerier, opts ...WorkspaceServiceOption) *WorkspaceService {
	if store == nil {
		store = f.q
	}
	return newWorkspaceServiceForTests(store, append([]WorkspaceServiceOption{
		WithWorkspaceTransactions(f.pool), WithBranchMachineProviders(branchMachineTestProviders()),
	}, opts...)...)
}

// machine inserts a branch machine owned by the machine service and shared
// with the fixture's user, as a reservation leaves it.
func (f branchMachineFixture) machine(t *testing.T, arg db.CreateWorkspaceParams) db.Workspace {
	t.Helper()
	ctx := context.Background()
	owner, err := f.q.GetBranchMachineOwner(ctx)
	require.NoError(t, err)
	arg.RepositoryID, arg.UserID = f.repo, owner
	if arg.Kind == "" {
		arg.Kind = "container"
	}
	row, err := f.q.CreateWorkspace(ctx, arg)
	require.NoError(t, err)
	_, err = f.q.UpsertWorkspaceShare(ctx, db.UpsertWorkspaceShareParams{WorkspaceID: row.ID, OwnerUserID: owner, GranteeUserID: f.user, Level: string(WorkspaceAccessWrite)})
	require.NoError(t, err)
	return row
}

// branch returns the live machines on one bookmark of the fixture repository.
func (f branchMachineFixture) branch(t *testing.T, bookmark string) []db.Workspace {
	t.Helper()
	ctx := context.Background()
	rows, err := f.pool.Query(ctx, `SELECT id::text FROM workspaces WHERE repository_id=$1 AND target_bookmark=$2 AND deleted_at IS NULL ORDER BY created_at`, f.repo, bookmark)
	require.NoError(t, err)
	ids, err := pgx.CollectRows(rows, pgx.RowTo[string])
	require.NoError(t, err)
	out := make([]db.Workspace, 0, len(ids))
	for _, id := range ids {
		row, err := f.q.GetWorkspace(ctx, id)
		require.NoError(t, err)
		out = append(out, row)
	}
	return out
}

func (f branchMachineFixture) exec(t *testing.T, sql string, args ...any) {
	t.Helper()
	_, err := f.pool.Exec(context.Background(), sql, args...)
	require.NoError(t, err)
}

// activationConflictQuerier makes the final running write lose the active
// workspace index to a concurrent activation; one canonical machine per
// branch cannot produce that race in PostgreSQL, so the store injects it.
type activationConflictQuerier struct {
	*db.Queries
	winner  db.Workspace
	lookups int
}

// branchMachineFixture composes what every workspace creation door needs since
// de86a86992 (#3565): a PostgreSQL product database, its transactions and the
// branch machine activation providers. Mock sandbox clients stand in for the
// VMs; TestBranchMachineUnavailableProviders covers the refusal without them.
type branchMachineFixture struct {
	pool       *pgxpool.Pool
	q          *db.Queries
	user, repo int64
}

// sessionStatuses returns the statuses of the sessions on one bookmark's
// machines, oldest first.
func (f branchMachineFixture) sessionStatuses(t *testing.T, bookmark string) []string {
	t.Helper()
	rows, err := f.pool.Query(context.Background(), `SELECT s.status FROM workspace_sessions s JOIN workspaces w ON w.id=s.workspace_id
		WHERE w.repository_id=$1 AND w.target_bookmark=$2 ORDER BY s.created_at`, f.repo, bookmark)
	require.NoError(t, err)
	statuses, err := pgx.CollectRows(rows, pgx.RowTo[string])
	require.NoError(t, err)
	return statuses
}
