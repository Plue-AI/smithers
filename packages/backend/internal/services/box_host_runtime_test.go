package services

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/sandbox"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

type codingBindingRuntime struct {
	workspaceapi.WorkspaceRuntime
	events     []string
	binding    workspaceapi.WorkspaceCodingBinding
	installErr error
	probeErr   error
}

func (*codingBindingRuntime) Isolation() workspaceapi.IsolationLevel {
	return workspaceapi.IsolationSandboxed
}
func (*codingBindingRuntime) Capabilities() workspaceapi.WorkspaceCapabilities {
	return workspaceapi.WorkspaceCapabilities{Execution: true, ManagedServices: true}
}
func (r *codingBindingRuntime) InspectWorkspace(context.Context, string) (workspaceapi.Workspace, error) {
	return workspaceapi.Workspace{ID: "coding-lane", Root: "/workspace", Home: "/home/agent"}, nil
}
func (r *codingBindingRuntime) ExecuteCommand(_ context.Context, _ string, _ workspaceapi.Command) (workspaceapi.CommandResult, error) {
	r.events = append(r.events, "publisher")
	return workspaceapi.CommandResult{}, r.probeErr
}
func (r *codingBindingRuntime) InstallWorkspaceCodingBinding(ctx context.Context, id string, binding workspaceapi.WorkspaceCodingBinding) error {
	r.events = append(r.events, "binding:"+id)
	r.binding = binding
	operation, ok := workspaceapi.OperationFromContext(ctx)
	if !ok || operation.PrincipalID != "9" || operation.TenantID != "9" {
		return errors.New("binding lacks owner context")
	}
	return r.installErr
}

type codingBindingQuerier struct{ *boxHostTestQuerier }

func (*codingBindingQuerier) SwapWorkspaceHeadPushTokenID(context.Context, string, int64, pgtype.Int8, pgtype.Int8) (bool, error) {
	return true, nil
}

func codingBindingServiceFixture(t *testing.T) (*WorkspaceService, *codingBindingRuntime, *codingBindingQuerier, db.Workspace) {
	t.Helper()
	row := db.Workspace{ID: "coding-lane", RepositoryID: 77, UserID: 9, Status: "running", HeadPushTokenID: pgtype.Int8{Int64: 42, Valid: true}}
	q := &codingBindingQuerier{&boxHostTestQuerier{workspaceHeadTestQuerier: &workspaceHeadTestQuerier{mockWorkspaceQuerier: &mockWorkspaceQuerier{
		getWorkspaceByRepoFn: func(context.Context, db.GetWorkspaceByRepoParams) (db.Workspace, error) { return row, nil },
		getWorkspaceFn:       func(context.Context, string) (db.Workspace, error) { return row, nil },
	}}}}
	runtime := &codingBindingRuntime{}
	service := newWorkspaceServiceForTests(q, WithWorkspaceRuntime(runtime), WithWorkspaceGitBaseURL("http://127.0.0.1:4000"))
	return service, runtime, q, row
}

func TestPrepareBoxHostInstallsSelfHostedGuestBindingBeforeCredentials(t *testing.T) {
	service, runtime, _, row := codingBindingServiceFixture(t)
	environment, err := service.PrepareBoxHost(context.Background(), "host", row.ID, row.RepositoryID, row.UserID)
	require.NoError(t, err)
	require.Equal(t, []string{"publisher", "binding:coding-lane"}, runtime.events)
	require.Equal(t, workspaceapi.WorkspaceCodingBinding{ActorID: 9, RepositoryID: 77, RepositorySlug: "acme/widgets", APIBaseURL: "http://127.0.0.1:4000/api", GitURL: "http://127.0.0.1:4000/acme/widgets.git"}, runtime.binding)
	require.NotEmpty(t, environment["SMITHERS_JJHUB_TOKEN"])
	require.NotContains(t, environment, "SMITHERS_CODING_LOCAL_OWNER")
	// Every launch repairs the binding after reboot or loss of guest state.
	_, err = service.PrepareBoxHost(context.Background(), "host", row.ID, row.RepositoryID, row.UserID)
	require.NoError(t, err)
	require.Equal(t, []string{"publisher", "binding:coding-lane", "publisher", "binding:coding-lane"}, runtime.events)
}

func TestPrepareBoxHostSelfHostedBindingFailuresStopTheLaunch(t *testing.T) {
	for _, name := range []string{"publisher failure", "binding failure", "missing API", "shared"} {
		t.Run(name, func(t *testing.T) {
			service, runtime, q, row := codingBindingServiceFixture(t)
			switch name {
			case "publisher failure":
				runtime.probeErr = errors.New("publisher unavailable")
			case "binding failure":
				runtime.installErr = errors.New("binding unavailable")
			case "missing API":
				service.gitBaseURL = ""
			case "shared":
				q.shared = true
			}
			environment, err := service.PrepareBoxHost(context.Background(), "host", row.ID, row.RepositoryID, row.UserID)
			if name == "shared" {
				require.NoError(t, err)
			} else {
				require.Error(t, err)
			}
			require.NotContains(t, environment, "SMITHERS_JJHUB_TOKEN")
			require.Empty(t, q.tokens, "failed preparation mints no host credential")
			if name != "binding failure" {
				require.NotContains(t, runtime.events, "binding:coding-lane")
			}
		})
	}
}

// sandboxedPlainRuntime is a sandboxed runtime that installs no binding.
type sandboxedPlainRuntime struct{ workspaceapi.WorkspaceRuntime }

// A hosted deployment composes its sandboxed workspace runtime beside the
// sandbox client it uses for compute and chat. Every box is the runtime's
// guest: the runtime owns its checkout, user and publisher, so the runtime
// installs the binding. The sandbox client's check expects its own layout
// (/workspace and a binding only its provisioning writes), which no runtime
// guest has, so before this fix every hosted coding host start failed with
// "workspace coding configuration does not name this workspace".
func TestPrepareBoxHostBindsARuntimeGuestThroughItsRuntimeBesideASandboxClient(t *testing.T) {
	prepareRuntimeTestHelper(t)
	row := db.Workspace{ID: "agent-box", RepositoryID: 77, UserID: 9, VmID: "msb-agent-box", Status: "running",
		Kind: "agent", HeadPushTokenID: pgtype.Int8{Int64: 42, Valid: true}}
	fixture := func(t *testing.T, runtime workspaceapi.WorkspaceRuntime) (*WorkspaceService, *codingBindingQuerier, *[]string) {
		t.Helper()
		q := &codingBindingQuerier{&boxHostTestQuerier{workspaceHeadTestQuerier: &workspaceHeadTestQuerier{mockWorkspaceQuerier: &mockWorkspaceQuerier{
			getWorkspaceByRepoFn: func(context.Context, db.GetWorkspaceByRepoParams) (db.Workspace, error) { return row, nil },
			getWorkspaceFn:       func(context.Context, string) (db.Workspace, error) { return row, nil },
		}}}}
		var commands []string
		client := &mockWorkspaceSandboxVMClient{execAwaitFn: func(_ context.Context, _ string, req sandbox.ExecRequest) (sandbox.ExecResult, error) {
			commands = append(commands, req.Command)
			status := int32(0)
			if strings.Contains(req.Command, "--check-config") {
				// The guest carries this release's helper and no binding for /workspace.
				status = 1
				return sandbox.ExecResult{StatusCode: &status, Stdout: strings.TrimSuffix(runtimeTestReceipt(t, row, ""), "ok\n")}, nil
			}
			return sandbox.ExecResult{StatusCode: &status}, nil
		}}
		service := newWorkspaceServiceForTests(q, WithWorkspaceRuntime(runtime), WithWorkspaceSandboxClient(client),
			WithWorkspaceGitBaseURL("https://api.jjhub.tech"))
		return service, q, &commands
	}
	t.Run("installs", func(t *testing.T) {
		runtime := &codingBindingRuntime{}
		service, q, commands := fixture(t, runtime)
		environment, err := service.PrepareBoxHost(context.Background(), "host", row.ID, row.RepositoryID, row.UserID)
		require.NoError(t, err)
		require.Equal(t, []string{"publisher", "binding:agent-box"}, runtime.events)
		require.Equal(t, workspaceapi.WorkspaceCodingBinding{ActorID: 9, RepositoryID: 77, RepositorySlug: "acme/widgets",
			APIBaseURL: "https://api.jjhub.tech/api", GitURL: "https://api.jjhub.tech/acme/widgets.git"}, runtime.binding)
		require.Empty(t, *commands, "the sandbox client never probes a runtime guest")
		require.NotEmpty(t, environment["SMITHERS_JJHUB_TOKEN"])
		require.Len(t, q.tokens, 2, "the landing and cache credentials")
	})
	t.Run("installs none", func(t *testing.T) {
		runtime := &codingBindingRuntime{}
		service, q, commands := fixture(t, sandboxedPlainRuntime{runtime})
		environment, err := service.PrepareBoxHost(context.Background(), "host", row.ID, row.RepositoryID, row.UserID)
		require.ErrorContains(t, err, "workspace coding source binding provisioning is unavailable")
		require.NotContains(t, environment, "SMITHERS_JJHUB_TOKEN")
		require.Empty(t, q.tokens, "a refused start mints no host credential")
		require.Empty(t, runtime.events)
		require.Empty(t, *commands)
	})
}

// trustedBindingRuntime is a trusted-process runtime that installs a box's
// source binding (the J1 rehearsal's); trustedPlainRuntime installs none (the
// trusted-process runtime as composed everywhere else).
type trustedBindingRuntime struct{ *codingBindingRuntime }

func (trustedBindingRuntime) Isolation() workspaceapi.IsolationLevel {
	return workspaceapi.IsolationTrustedProcess
}

type trustedPlainRuntime struct{ workspaceapi.WorkspaceRuntime }

func (trustedPlainRuntime) Isolation() workspaceapi.IsolationLevel {
	return workspaceapi.IsolationTrustedProcess
}

func TestPrepareBoxHostBindsATrustedProcessBoxOnlyWhenItsRuntimeInstallsTheBinding(t *testing.T) {
	t.Run("installs", func(t *testing.T) {
		_, runtime, q, row := codingBindingServiceFixture(t)
		service := newWorkspaceServiceForTests(q, WithWorkspaceRuntime(trustedBindingRuntime{runtime}), WithWorkspaceGitBaseURL("http://127.0.0.1:4000"))
		environment, err := service.PrepareBoxHost(context.Background(), "host", row.ID, row.RepositoryID, row.UserID)
		require.NoError(t, err)
		require.Equal(t, []string{"publisher", "binding:coding-lane"}, runtime.events, "the publisher's credential precedes the binding, as in a guest")
		require.Equal(t, "http://127.0.0.1:4000/acme/widgets.git", runtime.binding.GitURL)
		require.NotEmpty(t, environment["SMITHERS_JJHUB_TOKEN"])
		require.Equal(t, "http://127.0.0.1:4000/api", environment["SMITHERS_JJHUB_API_URL"])
	})
	t.Run("installs none", func(t *testing.T) {
		_, runtime, q, row := codingBindingServiceFixture(t)
		service := newWorkspaceServiceForTests(q, WithWorkspaceRuntime(trustedPlainRuntime{runtime}), WithWorkspaceGitBaseURL("http://127.0.0.1:4000"))
		environment, err := service.PrepareBoxHost(context.Background(), "host", row.ID, row.RepositoryID, row.UserID)
		require.NoError(t, err)
		require.Empty(t, runtime.events, "a plain trusted-process box gets no publisher and no binding")
		require.NotContains(t, environment, "SMITHERS_JJHUB_TOKEN")
		require.Empty(t, q.tokens, "and no host credential")
	})
	t.Run("binding failure stops the launch", func(t *testing.T) {
		_, runtime, q, row := codingBindingServiceFixture(t)
		runtime.installErr = errors.New("binding unavailable")
		service := newWorkspaceServiceForTests(q, WithWorkspaceRuntime(trustedBindingRuntime{runtime}), WithWorkspaceGitBaseURL("http://127.0.0.1:4000"))
		environment, err := service.PrepareBoxHost(context.Background(), "host", row.ID, row.RepositoryID, row.UserID)
		require.Error(t, err)
		require.NotContains(t, environment, "SMITHERS_JJHUB_TOKEN")
		require.Empty(t, q.tokens)
	})
}

type daemonCodingBindingRuntime struct{ *codingBindingRuntime }

func (r *daemonCodingBindingRuntime) EnsureMachined(context.Context, string) error {
	r.events = append(r.events, "daemon")
	return r.probeErr
}

func TestBoxHostCodingBindingUsesInstalledDaemonWithoutRetiredPublisher(t *testing.T) {
	for _, fail := range []bool{false, true} {
		t.Run(fmt.Sprintf("daemon_failure_%t", fail), func(t *testing.T) {
			service, runtime, _, row := codingBindingServiceFixture(t)
			row.HeadPushTokenID = pgtype.Int8{}
			service.runtime = &daemonCodingBindingRuntime{runtime}
			if fail {
				runtime.probeErr = errors.New("daemon unavailable")
			}
			err := service.installRuntimeBoxCodingBinding(t.Context(), row, row.UserID)
			if fail {
				require.EqualError(t, err, "daemon unavailable")
				require.Equal(t, []string{"daemon"}, runtime.events)
			} else {
				require.NoError(t, err)
				require.Equal(t, []string{"daemon", "binding:coding-lane"}, runtime.events)
			}
		})
	}
}
