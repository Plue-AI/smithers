package services

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/modelproxy"
	"github.com/smithersai/smithers/packages/backend/runtimeports"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/sandbox"
)

func boundGatewayFixture(t *testing.T) (*RepoGatewayService, *fakeRepoGatewayQuerier, *fakeRepoGatewayVMClient, *db.Workspace) {
	t.Helper()
	workspace := &db.Workspace{ID: uuid.NewString(), RepositoryID: 101, UserID: 1, VmID: "owned-vm", Status: "running"}
	wq := &mockWorkspaceQuerier{getWorkspaceByRepoFn: func(_ context.Context, p db.GetWorkspaceByRepoParams) (db.Workspace, error) {
		if p.ID != workspace.ID || p.RepositoryID != workspace.RepositoryID || workspace.DeletedAt.Valid {
			return db.Workspace{}, pgx.ErrNoRows
		}
		return *workspace, nil
	}}
	ws := newWorkspaceServiceForTests(wq, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{}))
	q := &fakeRepoGatewayQuerier{nextGatewayID: uuid.NewString()}
	vm := &fakeRepoGatewayVMClient{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hash := sha256.Sum256([]byte(defaultWorkspaceClonePath))
		_ = json.NewEncoder(w).Encode(map[string]any{"gatewayId": q.nextGatewayID, "workspaceHash": hex.EncodeToString(hash[:])[:16], "protocolVersion": "1", "version": "1.0.0-rc.0", "capabilities": []string{"coding-plan/v1"}})
	}))
	t.Cleanup(server.Close)
	return newTestRepoGatewayService(q, vm, WithRepoGatewayHealthProbe(server.URL, server.Client()), WithRepoGatewayWorkspaces(ws), WithRepoGatewaySecretCodec(&staticTestCodec{prefix: "enc:"})), q, vm, workspace
}

// boundGatewayRow is an existing gateway row of the fixture's box whose ID the
// fixture's health server answers for.
func boundGatewayRow(q *fakeRepoGatewayQuerier, w *db.Workspace, status string) *runtimeports.RepoGateway {
	const token = "smithers_gateway_bound"
	digest := sha256.Sum256([]byte(token))
	return &runtimeports.RepoGateway{
		ID: q.nextGatewayID, RepositoryID: w.RepositoryID, UserID: w.UserID,
		WorkspaceID: pgtype.UUID{Bytes: uuid.MustParse(w.ID), Valid: true}, VmID: w.VmID,
		BaseUrl: "https://" + repoGatewayDomain(q.nextGatewayID), AuthTokenHash: hex.EncodeToString(digest[:]),
		AuthTokenCiphertext: "enc:" + token, Status: status, LastActivityAt: time.Now(),
	}
}

func TestWorkspaceGateway_UsesOwnedVMAndModernService(t *testing.T) {
	s, q, vm, w := boundGatewayFixture(t)
	input := RepoGatewayConnectionInput{RepositoryID: w.RepositoryID, UserID: w.UserID, WorkspaceID: w.ID}
	info, err := s.GetRepoGatewayConnectionInfo(context.Background(), input)
	require.NoError(t, err)
	require.Equal(t, w.ID, info.WorkspaceID)
	require.Equal(t, w.VmID, info.VMID)
	require.Empty(t, vm.deletedVMIDs)
	require.Len(t, vm.systemdSpecs, 1)
	spec := vm.systemdSpecs[0]
	assert.Equal(t, defaultWorkspaceUser, spec.User)
	assert.Equal(t, defaultWorkspaceClonePath, spec.Workdir)
	assert.Equal(t, defaultWorkspaceHome, spec.Env["HOME"])
	require.NoError(t, spec.ValidateExec())
	require.Len(t, spec.Exec, 3)
	assert.Equal(t, []string{"/bin/sh", "-c"}, spec.Exec[:2])
	assert.Contains(t, spec.Exec[2], "serve --root /home/developer/workspace")
	assert.Contains(t, spec.Exec[2], "--listen")
	assert.NotContains(t, strings.Join(spec.Exec, " "), info.Token)
	assert.NotContains(t, spec.Exec[2], "bun x")
	assert.Equal(t, "smithers-gateway-"+info.GatewayID, spec.Name)
	assert.Equal(t, []string{repoGatewayDomain(info.GatewayID)}, vm.mappedDomains)
	require.Len(t, vm.execAwaitReqs, 1)
	assert.NotContains(t, vm.execAwaitReqs[0].Command, "clone")
	assert.NotContains(t, vm.execAwaitReqs[0].Command, "rm -rf")
	assert.Contains(t, vm.execAwaitReqs[0].Command, w.ID)
	assert.True(t, q.created[0].WorkspaceID.Valid)
	assert.Equal(t, "running", q.statusUpdates[len(q.statusUpdates)-1].Status)
}

func TestWorkspaceGateway_RefusesMissingRuntimeWithoutDeletingWorkspace(t *testing.T) {
	s, q, vm, w := boundGatewayFixture(t)
	one := int32(1)
	vm.execAwaitFn = func(context.Context, string, sandbox.ExecRequest) (sandbox.ExecResult, error) {
		return sandbox.ExecResult{StatusCode: &one}, nil
	}
	_, err := s.GetRepoGatewayConnectionInfo(context.Background(), RepoGatewayConnectionInput{RepositoryID: w.RepositoryID, UserID: w.UserID, WorkspaceID: w.ID})
	require.NotEqual(t, pkgerrors.CodeRepositoryWorkspacePending, assertAPIErrorStatus(t, err, http.StatusConflict).Code)
	assert.Empty(t, vm.systemdSpecs)
	assert.Empty(t, vm.deletedVMIDs)
	assert.Empty(t, vm.mappedDomains)
	require.Len(t, q.executionInfo, 1)
	assert.Equal(t, "starting", q.executionInfo[0].Status, "existing row supports retry after runtime correction")
}

func TestWorkspaceGateway_PrimaryProbeReturnsTypedPendingWithoutIdentity(t *testing.T) {
	s, _, vm, w := boundGatewayFixture(t)
	s.provisionResponseBudget = 20 * time.Millisecond
	release, finished := make(chan struct{}), make(chan struct{})
	vm.execAwaitFn = func(ctx context.Context, _ string, _ sandbox.ExecRequest) (sandbox.ExecResult, error) {
		defer close(finished)
		select {
		case <-release:
		case <-ctx.Done():
		}
		one := int32(1)
		return sandbox.ExecResult{StatusCode: &one}, nil
	}
	t.Cleanup(func() {
		close(release)
		select {
		case <-finished:
		case <-time.After(time.Second):
			t.Error("detached preflight did not finish")
		}
	})
	compatible, err := s.ProbeWorkspaceCapability(context.Background(), *w, repositoryJobsCapability)
	require.False(t, compatible)
	api := assertAPIErrorStatus(t, err, http.StatusConflict)
	require.Equal(t, pkgerrors.CodeRepositoryWorkspacePending, api.Code)
	require.Nil(t, api.Details, "pending observation does not confer a workspace selection")
}

func TestWorkspaceGateway_MissingVMPendingOnlyWhenProvisioning(t *testing.T) {
	for _, status := range []string{"pending", "starting", "running"} {
		t.Run(status, func(t *testing.T) {
			s, q, vm, w := boundGatewayFixture(t)
			w.VmID = ""
			w.Status = status
			info, err := s.GetRepoGatewayConnectionInfo(context.Background(), RepoGatewayConnectionInput{RepositoryID: w.RepositoryID, UserID: w.UserID, WorkspaceID: w.ID})
			api := assertAPIErrorStatus(t, err, http.StatusConflict)
			require.Empty(t, info.WorkspaceID)
			require.Empty(t, q.created)
			require.Empty(t, vm.execAwaitReqs)
			if status == "running" {
				require.NotEqual(t, pkgerrors.CodeRepositoryWorkspacePending, api.Code)
			} else {
				require.Equal(t, pkgerrors.CodeRepositoryWorkspacePending, api.Code)
			}
		})
	}
}

func TestWorkspaceGateway_RechecksLifecycleDuringProvision(t *testing.T) {
	for _, mode := range []string{"deleted", "vm-replaced", "suspended"} {
		t.Run(mode, func(t *testing.T) {
			s, _, vm, w := boundGatewayFixture(t)
			vm.createSystemdServiceFn = func(context.Context, string, sandbox.ServiceSpec) (sandbox.CreateServiceResult, error) {
				switch mode {
				case "deleted":
					w.DeletedAt.Valid = true
				case "vm-replaced":
					w.VmID = "replacement-vm"
				case "suspended":
					w.Status = "suspended"
				}
				return sandbox.CreateServiceResult{Success: true}, nil
			}
			_, err := s.GetRepoGatewayConnectionInfo(context.Background(), RepoGatewayConnectionInput{RepositoryID: w.RepositoryID, UserID: w.UserID, WorkspaceID: w.ID})
			require.Error(t, err)
			assert.Empty(t, vm.deletedVMIDs)
			assert.Empty(t, vm.mappedDomains)
			require.Len(t, vm.execAwaitReqs, 2)
			assert.Contains(t, vm.execAwaitReqs[1].Command, "systemctl disable --now")
		})
	}
}

func TestWorkspaceGateway_ReaperNeverDeletesUserVM(t *testing.T) {
	for _, status := range []string{"pending", "starting", "running", "failed"} {
		t.Run(status, func(t *testing.T) {
			s, q, vm, w := boundGatewayFixture(t)
			g := runtimeports.RepoGateway{ID: uuid.NewString(), WorkspaceID: pgtype.UUID{Bytes: uuid.MustParse(w.ID), Valid: true}, VmID: w.VmID, Status: status, RepositoryID: w.RepositoryID, UserID: w.UserID}
			if status == "running" {
				s.discardGateway(context.Background(), g)
			} else {
				q.staleRows = []runtimeports.RepoGateway{g}
				s.sweepStaleGateways(context.Background())
			}
			assert.Empty(t, vm.deletedVMIDs)
			assert.Equal(t, []string{repoGatewayDomain(g.ID)}, vm.unmappedDomains)
			require.Len(t, vm.execAwaitReqs, 1)
			assert.Contains(t, vm.execAwaitReqs[0].Command, workspaceGatewayServiceName(g))
			assert.Equal(t, []string{g.ID}, q.getSoftDeleted())
		})
	}
}

func TestWorkspaceGateway_BindingValidationBeforeSideEffects(t *testing.T) {
	s, q, vm, w := boundGatewayFixture(t)
	for _, input := range []RepoGatewayConnectionInput{
		{WorkspaceID: "nope", RepositoryID: w.RepositoryID, UserID: w.UserID},
		{WorkspaceID: w.ID, RepositoryID: w.RepositoryID + 1, UserID: w.UserID},
		{WorkspaceID: w.ID, RepositoryID: w.RepositoryID, UserID: 999},
	} {
		_, err := s.GetRepoGatewayConnectionInfo(context.Background(), input)
		require.Error(t, err)
	}
	assert.Empty(t, q.created)
	assert.Empty(t, vm.execAwaitReqs)
}

func TestWorkspaceGateway_ReadinessRequiresRegisteredCodingHost(t *testing.T) {
	for _, capabilities := range []bool{false, true} {
		t.Run(fmt.Sprint(capabilities), func(t *testing.T) {
			s, q, vm, w := boundGatewayFixture(t)
			server := httptest.NewServer(http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
				hash := sha256.Sum256([]byte(defaultWorkspaceClonePath))
				health := map[string]any{"gatewayId": q.nextGatewayID, "workspaceHash": hex.EncodeToString(hash[:])[:16], "protocolVersion": "1", "version": "1.0.0-rc.0"}
				if capabilities {
					health["capabilities"] = []string{"coding-plan/v1"}
				}
				_ = json.NewEncoder(rw).Encode(health)
			}))
			defer server.Close()
			s.healthProbeBaseURL = server.URL
			s.healthProbeClient = server.Client()
			_, err := s.GetRepoGatewayConnectionInfo(context.Background(), RepoGatewayConnectionInput{RepositoryID: w.RepositoryID, UserID: w.UserID, WorkspaceID: w.ID})
			if capabilities {
				require.NoError(t, err)
			} else {
				assertAPIErrorStatus(t, err, http.StatusConflict)
				require.Contains(t, err.Error(), "coding-plan/v1")
			}
			assert.Empty(t, vm.deletedVMIDs)
		})
	}
}

// A deployment with no health probe configured refuses every bound gateway,
// for every account, until an operator sets the variable. It used to answer
// coding_host_unavailable — a 409 that told the caller their box needed a
// newer runtime, about a box that was never looked at.
func TestWorkspaceGateway_UnconfiguredProbeBlamesTheDeployment(t *testing.T) {
	s, _, vm, w := boundGatewayFixture(t)
	s.healthProbeBaseURL = ""
	_, err := s.GetRepoGatewayConnectionInfo(context.Background(), RepoGatewayConnectionInput{RepositoryID: w.RepositoryID, UserID: w.UserID, WorkspaceID: w.ID})
	apiErr := assertAPIErrorStatus(t, err, http.StatusServiceUnavailable)
	assert.Equal(t, pkgerrors.CodeCodingGatewayNotConfigured, apiErr.Code)
	assert.NotContains(t, err.Error(), "provisioned runtime",
		"the box was never inspected; do not tell the caller to update it")
	assert.Empty(t, vm.deletedVMIDs)
}

// Exercise the real conditional status write at the last readiness boundary,
// where a reaper can win after the service's last identity read.

func TestWorkspaceGateway_ReplacementSharesProcessLockButNotCleanupIdentity(t *testing.T) {
	_, _, _, workspace := boundGatewayFixture(t)
	old := runtimeports.RepoGateway{ID: uuid.NewString(), WorkspaceID: pgtype.UUID{Bytes: uuid.MustParse(workspace.ID), Valid: true}}
	replacement := old
	replacement.ID = uuid.NewString()
	assert.Equal(t, workspaceGatewayLockPath(old), workspaceGatewayLockPath(replacement))
	assert.NotEqual(t, workspaceGatewayServiceName(old), workspaceGatewayServiceName(replacement))
	assert.NotEqual(t, gatewayIngressDomain(old), gatewayIngressDomain(replacement))
	command := workspaceGatewayCommand(replacement)
	assert.Contains(t, command, "flock --nonblock --no-fork --conflict-exit-code 75")
	assert.Contains(t, command, workspace.ID)
	assert.NotContains(t, command, replacement.ID)
	preflight := workspaceGatewayPreflight(replacement)
	assert.Contains(t, preflight, "PATH=/usr/local/bin:/run/current-system/sw/bin:/usr/sbin:/usr/bin:/sbin:/bin")
	assert.Contains(t, preflight, "touch '"+workspaceGatewayLockPath(old)+"'")
	assert.Contains(t, preflight, "chown root:root")
	assert.NotContains(t, preflight, "rm ")
}

func TestWorkspaceGateway_RefusesMissingModelBeforeStartingService(t *testing.T) {
	s, _, vm, w := boundGatewayFixture(t)
	missing := int32(43)
	vm.execAwaitFn = func(context.Context, string, sandbox.ExecRequest) (sandbox.ExecResult, error) {
		return sandbox.ExecResult{StatusCode: &missing}, nil
	}
	_, err := s.GetRepoGatewayConnectionInfo(context.Background(), RepoGatewayConnectionInput{RepositoryID: w.RepositoryID, UserID: w.UserID, WorkspaceID: w.ID})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "SMITHERS_CODING_IMPLEMENT_MODEL")
	apiErr := assertAPIErrorStatus(t, err, http.StatusConflict)
	assert.Equal(t, pkgerrors.CodeCodingProviderRefreshRequired, apiErr.Code)
	assert.Empty(t, vm.systemdSpecs)
	assert.Empty(t, vm.mappedDomains)
	assert.Empty(t, vm.deletedVMIDs)
}

func TestWorkspaceGateway_ProviderBootstrapPreservesHealthyHost(t *testing.T) {
	s, q, vm, w := boundGatewayFixture(t)
	input := RepoGatewayConnectionInput{RepositoryID: w.RepositoryID, UserID: w.UserID, WorkspaceID: w.ID}
	first, err := s.GetRepoGatewayConnectionInfo(context.Background(), input)
	require.NoError(t, err)
	// This capture-only fixture does not persist writes automatically.
	q.active = &runtimeports.RepoGateway{ID: first.GatewayID, RepositoryID: w.RepositoryID, UserID: w.UserID,
		WorkspaceID: pgtype.UUID{Bytes: uuid.MustParse(w.ID), Valid: true}, VmID: w.VmID,
		AuthTokenCiphertext: "enc:" + first.Token, Status: "running"}
	WithWorkspaceProviderBootstrap([]modelproxy.Seat{modelproxy.Seats[1]}, "openai:gpt-6-luna")(s.workspaces)
	s.workspaces.sandbox = &mockWorkspaceSandboxVMClient{
		startVMFn: func(context.Context, string, sandbox.StartRequest) (sandbox.StartResult, error) {
			t.Error("a healthy host must not replace its live egress proxy")
			return sandbox.StartResult{}, errors.New("unexpected proxy replacement")
		},
	}
	vm.execAwaitFn = func(context.Context, string, sandbox.ExecRequest) (sandbox.ExecResult, error) {
		t.Error("a healthy host must not rerun provider or runtime preflight")
		return sandbox.ExecResult{}, errors.New("unexpected preflight")
	}
	serviceCount := len(vm.systemdSpecs)
	second, err := s.GetRepoGatewayConnectionInfo(context.Background(), input)
	require.NoError(t, err)
	require.Equal(t, first.GatewayID, second.GatewayID)
	require.Len(t, vm.systemdSpecs, serviceCount, "a running service and its outstanding runs remain alive")
	require.Empty(t, vm.deletedVMIDs)
}

func TestWorkspaceGateway_RequiredCapabilityPreservesOlderLiveHost(t *testing.T) {
	s, q, vm, w := boundGatewayFixture(t)
	input := RepoGatewayConnectionInput{RepositoryID: w.RepositoryID, UserID: w.UserID, WorkspaceID: w.ID}
	first, err := s.GetRepoGatewayConnectionInfo(context.Background(), input)
	require.NoError(t, err)
	q.active = &runtimeports.RepoGateway{ID: first.GatewayID, RepositoryID: w.RepositoryID, UserID: w.UserID,
		WorkspaceID: pgtype.UUID{Bytes: uuid.MustParse(w.ID), Valid: true}, VmID: w.VmID,
		AuthTokenCiphertext: "enc:" + first.Token, Status: "running"}
	vm.execAwaitReqs, vm.systemdSpecs = nil, nil
	input.RequiredCapability = repositoryJobsCapability
	_, err = s.GetRepoGatewayConnectionInfo(context.Background(), input)
	apiError := assertAPIErrorStatus(t, err, http.StatusConflict)
	require.Equal(t, pkgerrors.CodeCodingHostUpgradeRequired, apiError.Code)
	require.Equal(t, w.ID, apiError.Details.(map[string]string)["workspace_id"])
	require.Empty(t, vm.execAwaitReqs, "no read-then-restart race may stop an older host")
	require.Empty(t, vm.systemdSpecs)
	require.Empty(t, vm.deletedVMIDs)
	compatible, err := s.ProbeWorkspaceCapability(context.Background(), *w, repositoryJobsCapability)
	require.NoError(t, err)
	require.False(t, compatible, "a healthy older host is an unsuitable primary, not permission to restart it")
	require.Empty(t, vm.execAwaitReqs)
	require.Empty(t, vm.systemdSpecs)
	input.RequiredCapability = ""
	_, err = s.GetRepoGatewayConnectionInfo(context.Background(), input)
	require.NoError(t, err, "existing ordinary operations keep their old host")
	capabilities := make(chan []string, 4)
	for range 2 {
		capabilities <- []string{"coding-plan/v1", repositoryJobsCapability}
	}
	for range 2 {
		capabilities <- []string{"coding-plan/v1", repositoryJobsCapability, "repository-source/v1"}
	}
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		hash := sha256.Sum256([]byte(defaultWorkspaceClonePath))
		_ = json.NewEncoder(response).Encode(map[string]any{"gatewayId": first.GatewayID, "workspaceHash": hex.EncodeToString(hash[:])[:16], "protocolVersion": "1", "version": "1.0.0", "capabilities": <-capabilities})
	}))
	defer server.Close()
	s.healthProbeBaseURL, s.healthProbeClient = server.URL, server.Client()
	input.RequiredCapability = repositoryJobsCapability
	_, err = s.GetRepoGatewayConnectionInfo(context.Background(), input)
	require.Equal(t, pkgerrors.CodeCodingHostUpgradeRequired, assertAPIErrorStatus(t, err, http.StatusConflict).Code, "baseline repository-jobs alone cannot capture fork sources")
	ready, err := s.GetRepoGatewayConnectionInfo(context.Background(), input)
	require.NoError(t, err)
	require.Equal(t, first.GatewayID, ready.GatewayID)
	require.Empty(t, vm.systemdSpecs)
}

func TestWorkspaceGateway_PrimaryCapabilityStartsHostWithoutAllocating(t *testing.T) {
	s, q, vm, w := boundGatewayFixture(t)
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		hash := sha256.Sum256([]byte(defaultWorkspaceClonePath))
		_ = json.NewEncoder(response).Encode(map[string]any{"gatewayId": q.nextGatewayID, "workspaceHash": hex.EncodeToString(hash[:])[:16], "protocolVersion": "1", "version": "1.0.0", "capabilities": []string{"coding-plan/v1", repositoryJobsCapability, "repository-source/v1"}})
	}))
	defer server.Close()
	s.healthProbeBaseURL, s.healthProbeClient = server.URL, server.Client()
	compatible, err := s.ProbeWorkspaceCapability(context.Background(), *w, repositoryJobsCapability)
	require.NoError(t, err)
	require.True(t, compatible)
	require.Len(t, vm.systemdSpecs, 1, "fresh imported workspace starts its already staged host")
	require.Empty(t, vm.deletedVMIDs)
	stale := *w
	stale.VmID = "previous-vm"
	_, err = s.ProbeWorkspaceCapability(context.Background(), stale, repositoryJobsCapability)
	require.ErrorContains(t, err, "workspace changed during capability check")
}

// Store failures while recording a new host fail before anything runs in the
// box; a lost race for the active slot is the poll-me answer, not an error.
func TestWorkspaceGateway_ProvisionStoreFailures(t *testing.T) {
	for _, tc := range []struct {
		name         string
		create, exec error
		status       int
		pending      bool
		markedFailed bool
	}{
		{name: "create", create: errors.New("insert failed"), status: http.StatusInternalServerError},
		{name: "write shared", create: &pgconn.PgError{Code: "23514", ConstraintName: "workspace_gateway_private_execution"}, status: http.StatusConflict},
		{name: "lost race", exec: &pgconn.PgError{Code: "23505", ConstraintName: "uq_repo_gateways_active"}, status: http.StatusConflict, pending: true, markedFailed: true},
		{name: "persist", exec: errors.New("update failed"), status: http.StatusInternalServerError, markedFailed: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s, q, vm, w := boundGatewayFixture(t)
			q.createGatewayErr, q.executionInfoErr = tc.create, tc.exec
			_, err := s.GetRepoGatewayConnectionInfo(context.Background(), RepoGatewayConnectionInput{RepositoryID: w.RepositoryID, UserID: w.UserID, WorkspaceID: w.ID})
			apiErr := assertAPIErrorStatus(t, err, tc.status)
			assert.Equal(t, tc.pending, apiErr.Code == pkgerrors.CodeRepositoryWorkspacePending)
			if tc.markedFailed {
				require.NotEmpty(t, q.statusUpdates)
				assert.Equal(t, "failed", q.statusUpdates[len(q.statusUpdates)-1].Status)
			}
			assert.Empty(t, vm.execAwaitReqs)
			assert.Empty(t, vm.systemdSpecs)
		})
	}
}
