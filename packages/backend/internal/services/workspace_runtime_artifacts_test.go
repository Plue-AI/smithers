package services

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/sandbox"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

type artifactRuntime struct{ workspaceapi.WorkspaceRuntime }

func TestRuntimeWorkspaceCLIProbeExecutesGuestBinary(t *testing.T) {
	bin := t.TempDir()
	command := strings.ReplaceAll(workspaceRuntimeCLIProbe(), workspaceLocalBinDir, bin)
	output, err := exec.Command("/bin/sh", "-c", command).CombinedOutput()
	require.Error(t, err)
	require.Contains(t, string(output), "workspace CLI missing")
	require.NoError(t, os.WriteFile(filepath.Join(bin, "smithers"), []byte("#!/bin/sh\n[ \"$1\" = --version ] || exit 9\nprintf '1.0.0-rc.0\\n'\n"), 0755))
	require.NoError(t, os.Symlink("smithers", filepath.Join(bin, "smthrs")))
	output, err = exec.Command("/bin/sh", "-c", command).CombinedOutput()
	require.NoError(t, err, string(output))
	require.Equal(t, "1.0.0-rc.0\n", string(output))
	require.NoError(t, os.WriteFile(filepath.Join(bin, "smithers"), []byte("#!/bin/sh\necho guest-smoke-failed >&2\nexit 4\n"), 0755))
	output, err = exec.Command("/bin/sh", "-c", command).CombinedOutput()
	require.Error(t, err)
	require.Contains(t, string(output), "guest-smoke-failed")
}

func (*artifactRuntime) Isolation() workspaceapi.IsolationLevel {
	return workspaceapi.IsolationSandboxed
}
func (*artifactRuntime) Capabilities() workspaceapi.WorkspaceCapabilities {
	return workspaceapi.WorkspaceCapabilities{PersistentFiles: true, Execution: true, FileOperations: true}
}

func TestRuntimeRepositoryStagesArtifactsBeforeRepositoryAccess(t *testing.T) {
	artifactCallsiteFixture(t)
	for _, kind := range []string{"container", "vm"} {
		t.Run(kind, func(t *testing.T) {
			row := sampleDBWorkspace("runtime-artifacts")
			row.Kind = kind
			row.VmID = "" // CreateWorkspace persists placement after receiving this row.
			q := &mockWorkspaceQuerier{}
			q.getWorkspaceFn = func(context.Context, string) (db.Workspace, error) {
				current := row
				current.VmID = "placed-guest"
				return current, nil
			}
			client := newArtifactRecordingClient()
			client.failWrite = 1
			svc := newWorkspaceServiceForTests(q, WithWorkspaceRuntime(&artifactRuntime{}), WithWorkspaceSandboxClient(client))
			err := svc.ensureRuntimeWorkspaceRepository(t.Context(), row, row.UserID)
			require.ErrorContains(t, err, "transfer interrupted")
			require.Len(t, client.writes, 1)
		})
	}
}

// The recording provider leaves artifact publication mechanics intact while
// controlling only the guest bootstrap status and final executable probe.
type runtimeArtifactClient struct {
	*artifactRecordingClient
	placementIDs    []string
	bootstrapStatus string
	cliFailure      bool
	probeFailure    bool
	cancel          context.CancelFunc
	deadline        time.Time
}

func (c *runtimeArtifactClient) Execute(ctx context.Context, id string, req sandbox.ExecRequest) (sandbox.ExecResult, error) {
	c.deadline, _ = ctx.Deadline()
	if c.probeFailure && strings.Contains(req.Command, "then printf ready; else printf missing") {
		return sandbox.ExecResult{}, errors.New("guest probe unavailable")
	}
	c.placementIDs = append(c.placementIDs, id)
	command := strings.TrimPrefix(req.Command, workspaceArtifactGuestPath)
	if strings.HasPrefix(command, "if ! test -L ") {
		c.commands = append(c.commands, req.Command)
		if c.cancel != nil {
			c.cancel()
			return sandbox.ExecResult{}, ctx.Err()
		}
		return sandbox.ExecResult{StatusCode: new(int32), Stdout: c.bootstrapStatus}, nil
	}
	if strings.Contains(command, "--version") && c.cliFailure {
		c.commands = append(c.commands, req.Command)
		return sandbox.ExecResult{}, errors.New("guest CLI unavailable")
	}
	return c.artifactRecordingClient.Execute(ctx, id, req)
}

func TestRuntimeArtifactsUseDurablePlacementAndAwaitBootstrap(t *testing.T) {
	artifactCallsiteFixture(t)
	for _, outcome := range []string{"ready", "bootstrap failure", "cancelled", "CLI failure"} {
		t.Run(outcome, func(t *testing.T) {
			row := sampleDBWorkspace("artifacts-barrier")
			row.VmID = "stale-placement"
			row.Status = "starting"
			q := &mockWorkspaceQuerier{getWorkspaceFn: func(context.Context, string) (db.Workspace, error) {
				current := row
				current.VmID = "durable-placement"
				return current, nil
			}}
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			client := &runtimeArtifactClient{artifactRecordingClient: newArtifactRecordingClient(), bootstrapStatus: "done"}
			switch outcome {
			case "bootstrap failure":
				client.bootstrapStatus = "failed:23"
			case "cancelled":
				client.cancel = cancel
			case "CLI failure":
				client.cliFailure = true
			}
			svc := newWorkspaceServiceForTests(q, WithWorkspaceRuntime(&artifactRuntime{}), WithWorkspaceSandboxClient(client))
			err := svc.ensureRuntimeWorkspaceArtifacts(ctx, row, row.UserID)
			switch outcome {
			case "ready":
				require.NoError(t, err)
			case "bootstrap failure":
				require.ErrorContains(t, err, "bootstrap failed (exit 23)")
			case "cancelled":
				var apiErr *pkgerrors.APIError
				require.ErrorAs(t, err, &apiErr)
				require.ErrorIs(t, apiErr.Cause(), context.Canceled)
			case "CLI failure":
				require.ErrorContains(t, err, "guest CLI unavailable")
			}
			require.NotEmpty(t, client.writes)
			require.NotEmpty(t, client.placementIDs)
			require.False(t, client.deadline.IsZero())
			require.LessOrEqual(t, time.Until(client.deadline), workspaceResumeProvisionTimeout)
			for _, id := range client.placementIDs {
				require.Equal(t, "durable-placement", id)
			}
			cliIndex, waitIndex := -1, -1
			for i, command := range client.commands {
				if strings.HasPrefix(strings.TrimPrefix(command, workspaceArtifactGuestPath), "if ! test -L ") {
					waitIndex = i
				}
				if strings.Contains(command, "--version") {
					cliIndex = i
				}
			}
			require.GreaterOrEqual(t, waitIndex, 0)
			if outcome == "ready" || outcome == "CLI failure" {
				require.Greater(t, cliIndex, waitIndex)
			} else {
				require.Equal(t, -1, cliIndex)
			}
		})
	}
}

func TestRuntimeArtifactsRejectMissingOrChangedPlacement(t *testing.T) {
	for _, failure := range []string{"missing placement", "changed owner", "changed repository", "changed identity", "database failure"} {
		t.Run(failure, func(t *testing.T) {
			row := sampleDBWorkspace("artifacts-identity")
			current := row
			switch failure {
			case "missing placement":
				current.VmID = ""
			case "changed owner":
				current.UserID++
			case "changed repository":
				current.RepositoryID++
			case "changed identity":
				current.ID = "another-workspace"
			}
			q := &mockWorkspaceQuerier{getWorkspaceFn: func(context.Context, string) (db.Workspace, error) {
				if failure == "database failure" {
					return db.Workspace{}, errors.New("database unavailable")
				}
				return current, nil
			}}
			client := newArtifactRecordingClient()
			options := []WorkspaceServiceOption{WithWorkspaceRuntime(&artifactRuntime{})}
			options = append(options, WithWorkspaceSandboxClient(client))
			svc := newWorkspaceServiceForTests(q, options...)
			require.Error(t, svc.ensureRuntimeWorkspaceArtifacts(t.Context(), row, row.UserID))
			require.Empty(t, client.writes)
			require.Empty(t, client.commands)
		})
	}
}

type selfManagedArtifactRuntime struct {
	workspaceapi.WorkspaceRuntime
	t *testing.T
}

func (r *selfManagedArtifactRuntime) Isolation() workspaceapi.IsolationLevel {
	r.t.Fatal("self-managed runtime isolation consulted without a compute provider")
	return workspaceapi.IsolationSandboxed
}

func TestRuntimeArtifactsSelfManagedSandboxSkipsComputeBootstrap(t *testing.T) {
	q := &mockWorkspaceQuerier{getWorkspaceFn: func(context.Context, string) (db.Workspace, error) {
		t.Fatal("self-managed sandbox attempted compute placement lookup")
		return db.Workspace{}, nil
	}}
	svc := newWorkspaceServiceForTests(q, WithWorkspaceRuntime(&selfManagedArtifactRuntime{t: t}))
	require.NoError(t, svc.ensureRuntimeWorkspaceArtifacts(t.Context(), sampleDBWorkspace("self-managed"), 1))
}

type trustedArtifactRuntime struct{ artifactRuntime }

func (*trustedArtifactRuntime) Isolation() workspaceapi.IsolationLevel {
	return workspaceapi.IsolationTrustedProcess
}
func TestRuntimeArtifactsTrustedProcessSkipsGuestBootstrap(t *testing.T) {
	q := &mockWorkspaceQuerier{getWorkspaceFn: func(context.Context, string) (db.Workspace, error) {
		t.Fatal("trusted runtime attempted guest placement lookup")
		return db.Workspace{}, nil
	}}
	client := newArtifactRecordingClient()
	svc := newWorkspaceServiceForTests(q, WithWorkspaceRuntime(&trustedArtifactRuntime{}), WithWorkspaceSandboxClient(client))
	require.NoError(t, svc.ensureRuntimeWorkspaceArtifacts(t.Context(), sampleDBWorkspace("trusted"), 1))
	require.Empty(t, client.writes)
	require.Empty(t, client.commands)
}

func TestRuntimeArtifactsBootstrapMatchesPlacedEnvironment(t *testing.T) {
	artifactCallsiteFixture(t)
	for _, scenario := range []struct{ name, kind, closure, guestKind string }{
		{"container", "container", "", "container"},
		{"VM without closure uses container", "vm", "", "container"},
		{"pinned VM uses Nix", "vm", "closure-sha", "vm"},
		{"pinned desktop uses Nix", "desktop", "closure-sha", "desktop"},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			row := sampleDBWorkspace("placed-environment")
			row.Status = "starting"
			row.Kind = scenario.kind
			row.EnvironmentClosureHash = scenario.closure
			q := &mockWorkspaceQuerier{getWorkspaceFn: func(context.Context, string) (db.Workspace, error) { return row, nil }}
			client := &runtimeArtifactClient{artifactRecordingClient: newArtifactRecordingClient(), bootstrapStatus: "done"}
			svc := newWorkspaceServiceForTests(q, WithWorkspaceRuntime(&artifactRuntime{}), WithWorkspaceSandboxClient(client))
			require.NoError(t, svc.ensureRuntimeWorkspaceArtifacts(t.Context(), row, row.UserID))
			require.Equal(t, workspaceBootstrapScriptForKind(scenario.guestKind), stagedWorkspaceScript(client.artifactRecordingClient))
		})
	}
}

// This repository-only fixture has no guest transport; explicitly declare its
// trusted process isolation now that repository readiness consults isolation.
func (lostWorkerRepositoryRuntime) Isolation() workspaceapi.IsolationLevel {
	return workspaceapi.IsolationTrustedProcess
}

// A running guest's installed toolchain is pinned until its next resume.
type installedArtifactClient struct{ *runtimeArtifactClient }

func (c *installedArtifactClient) Execute(ctx context.Context, id string, req sandbox.ExecRequest) (sandbox.ExecResult, error) {
	if strings.Contains(req.Command, "then printf ready; else printf missing") {
		c.commands = append(c.commands, req.Command)
		return sandbox.ExecResult{StatusCode: new(int32), Stdout: "ready"}, nil
	}
	return c.runtimeArtifactClient.Execute(ctx, id, req)
}
func TestRuntimeArtifactsRunningGuestKeepsInstalledRelease(t *testing.T) {
	row := sampleDBWorkspace("installed-release")
	q := &mockWorkspaceQuerier{getWorkspaceFn: func(context.Context, string) (db.Workspace, error) { return row, nil }}
	client := &installedArtifactClient{&runtimeArtifactClient{artifactRecordingClient: newArtifactRecordingClient()}}
	// Even if a new API release has no local bundle, an installed live guest
	// remains usable and must not be modified beneath its running coding host.
	t.Setenv(workspaceCLIPackageEnv, t.TempDir()+"/absent-new-release")
	svc := newWorkspaceServiceForTests(q, WithWorkspaceRuntime(&artifactRuntime{}), WithWorkspaceSandboxClient(client))
	require.NoError(t, svc.ensureRuntimeWorkspaceArtifacts(t.Context(), row, row.UserID))
	require.Empty(t, client.writes)
	require.Len(t, client.commands, 1)
}
func TestRuntimeArtifactsMissingHostBundleFailsBeforeTransfer(t *testing.T) {
	artifactCallsiteFixture(t)
	for _, artifact := range []struct{ label, env string }{
		{"npm CLI package", workspaceCLIPackageEnv}, {"jj export helper", workspaceJJExportBinaryEnv},
	} {
		t.Run(artifact.label, func(t *testing.T) {
			t.Setenv(artifact.env, t.TempDir()+"/missing")
			row := sampleDBWorkspace("missing-bundle")
			row.Status = "starting"
			q := &mockWorkspaceQuerier{getWorkspaceFn: func(context.Context, string) (db.Workspace, error) { return row, nil }}
			client := newArtifactRecordingClient()
			svc := newWorkspaceServiceForTests(q, WithWorkspaceRuntime(&artifactRuntime{}), WithWorkspaceSandboxClient(client))
			err := svc.ensureRuntimeWorkspaceArtifacts(t.Context(), row, row.UserID)
			var apiErr *pkgerrors.APIError
			require.ErrorAs(t, err, &apiErr)
			require.Equal(t, pkgerrors.CodeServiceUnavailable, apiErr.Code)
			require.Contains(t, apiErr.Message, artifact.label)
			require.Empty(t, client.writes)
			require.Empty(t, client.commands)
		})
	}
}

func TestRuntimeArtifactsOptionalInteractiveHostMayBeAbsent(t *testing.T) {
	artifactCallsiteFixture(t)
	t.Setenv(workspaceCodingHostBinaryEnv, t.TempDir()+"/absent")
	row := sampleDBWorkspace("optional-interactive-host")
	row.Status = "starting"
	q := &mockWorkspaceQuerier{getWorkspaceFn: func(context.Context, string) (db.Workspace, error) { return row, nil }}
	client := &runtimeArtifactClient{artifactRecordingClient: newArtifactRecordingClient(), bootstrapStatus: "done"}
	svc := newWorkspaceServiceForTests(q, WithWorkspaceRuntime(&artifactRuntime{}), WithWorkspaceSandboxClient(client))
	require.NoError(t, svc.ensureRuntimeWorkspaceArtifacts(t.Context(), row, row.UserID))
	require.NotEmpty(t, client.writes)
}

func TestRuntimeArtifactsRunningGuestRepairAndProbeFailure(t *testing.T) {
	artifactCallsiteFixture(t)
	for _, probeFailure := range []bool{false, true} {
		row := sampleDBWorkspace("running-repair")
		q := &mockWorkspaceQuerier{getWorkspaceFn: func(context.Context, string) (db.Workspace, error) { return row, nil }}
		client := &runtimeArtifactClient{artifactRecordingClient: newArtifactRecordingClient(), bootstrapStatus: "done", probeFailure: probeFailure}
		svc := newWorkspaceServiceForTests(q, WithWorkspaceRuntime(&artifactRuntime{}), WithWorkspaceSandboxClient(client))
		err := svc.ensureRuntimeWorkspaceArtifacts(t.Context(), row, row.UserID)
		if probeFailure {
			require.ErrorContains(t, err, "guest probe unavailable")
			require.Empty(t, client.writes)
		} else {
			require.NoError(t, err)
			require.NotEmpty(t, client.writes)
		}
	}
}

type lifecycleArtifactRuntime struct {
	artifactRuntime
	state workspaceapi.WorkspaceState
}

func (r *lifecycleArtifactRuntime) InspectWorkspace(_ context.Context, id string) (workspaceapi.Workspace, error) {
	return workspaceapi.Workspace{ID: id, State: r.state}, nil
}
func (*lifecycleArtifactRuntime) CreateWorkspace(_ context.Context, spec workspaceapi.WorkspaceSpec) (workspaceapi.Workspace, error) {
	return workspaceapi.Workspace{ID: spec.ID, State: workspaceapi.WorkspaceRunning}, nil
}
func (*lifecycleArtifactRuntime) StartWorkspace(_ context.Context, id string) (workspaceapi.Workspace, error) {
	return workspaceapi.Workspace{ID: id, State: workspaceapi.WorkspaceRunning}, nil
}
func TestRuntimeWorkspaceNeverActivatesBeforeArtifactBootstrap(t *testing.T) {
	artifactCallsiteFixture(t)
	for _, scenario := range []struct {
		status string
		state  workspaceapi.WorkspaceState
	}{{"starting", workspaceapi.WorkspaceRunning}, {"suspended", workspaceapi.WorkspaceStopped}, {"running", workspaceapi.WorkspaceRunning}} {
		t.Run(scenario.status, func(t *testing.T) {
			row := sampleDBWorkspace("lifecycle-bootstrap")
			row.Status = scenario.status
			q := &mockWorkspaceQuerier{getWorkspaceFn: func(context.Context, string) (db.Workspace, error) { return row, nil }, updateWorkspaceStatusFn: func(context.Context, db.UpdateWorkspaceStatusParams) (db.Workspace, error) {
				t.Fatal("activated before bootstrap")
				return db.Workspace{}, nil
			}}
			client := newArtifactRecordingClient()
			client.failWrite = 1
			runtime := &lifecycleArtifactRuntime{state: scenario.state}
			svc := newWorkspaceServiceForTests(q, WithWorkspaceRuntime(runtime), WithWorkspaceSandboxClient(client))
			_, err := svc.ensureRuntimeWorkspaceRunningLocked(t.Context(), row, row.UserID)
			require.ErrorContains(t, err, "transfer interrupted")
			require.Len(t, client.writes, 1)
		})
	}
}
