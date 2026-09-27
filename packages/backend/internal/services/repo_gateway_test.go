package services

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/runtimeports"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/sandbox"
)

// fakeRepoGatewayQuerier is an in-memory RepoGatewayQuerier + access-token store.
type fakeRepoGatewayQuerier struct {
	sandboxUsageRecorder
	// mu guards the fields the background reaper goroutine mutates
	// (staleAgeSeconds, softDeleted) so tests can read them race-free.
	mu                          sync.Mutex
	active                      *runtimeports.RepoGateway
	created                     []runtimeports.CreateRepoGatewayParams
	executionInfo               []runtimeports.UpdateRepoGatewayExecutionInfoParams
	statusUpdates               []runtimeports.UpdateRepoGatewayStatusParams
	touched                     []string
	softDeleted                 []string
	accessTokens                []db.CreateAccessTokenParams
	deletedTokens               []db.DeleteAccessTokenParams
	createGatewayErr            error
	executionInfoErr            error
	nextGatewayID               string
	activeAfterCreate           *runtimeports.RepoGateway
	staleRows                   []runtimeports.RepoGateway
	staleAgeSeconds             int64
	activeRows                  []runtimeports.RepoGateway
	discardedWorkspaceRows      []runtimeports.RepoGateway
	writableWorkspaceShares     bool
	clearedWorkspaceCredentials []string
	workspaceCleanupAttempts    []string
	landingTokenWrites          []runtimeports.SetRepoGatewayLandingTokenIDParams
}

func (f *fakeRepoGatewayQuerier) SetRepoGatewayLandingTokenID(_ context.Context, p runtimeports.SetRepoGatewayLandingTokenIDParams) error {
	f.landingTokenWrites = append(f.landingTokenWrites, p)
	if f.active != nil && f.active.ID == p.ID {
		f.active.LandingTokenID = p.LandingTokenID
	}
	return nil
}

func (f *fakeRepoGatewayQuerier) ListDiscardedWorkspaceGateways(_ context.Context, p runtimeports.ListDiscardedWorkspaceGatewaysParams) ([]runtimeports.RepoGateway, error) {
	return f.discardedWorkspaceRows, nil
}

func (f *fakeRepoGatewayQuerier) HasWritableWorkspaceShares(_ context.Context, workspaceID string) (bool, error) {
	return f.writableWorkspaceShares, nil
}

func (f *fakeRepoGatewayQuerier) ClearDiscardedWorkspaceGatewayCredential(_ context.Context, gatewayID string) error {
	f.clearedWorkspaceCredentials = append(f.clearedWorkspaceCredentials, gatewayID)
	return nil
}

func (f *fakeRepoGatewayQuerier) TouchDiscardedWorkspaceGatewayCleanup(_ context.Context, gatewayID string) error {
	f.workspaceCleanupAttempts = append(f.workspaceCleanupAttempts, gatewayID)
	return nil
}

func (f *fakeRepoGatewayQuerier) ListPendingWorkspaceGatewayCleanup(_ context.Context) ([]runtimeports.RepoGateway, error) {
	return f.discardedWorkspaceRows, nil
}

func (f *fakeRepoGatewayQuerier) CreateRepoGateway(ctx context.Context, arg runtimeports.CreateRepoGatewayParams) (runtimeports.RepoGateway, error) {
	if f.createGatewayErr != nil {
		return runtimeports.RepoGateway{}, f.createGatewayErr
	}
	f.created = append(f.created, arg)
	id := f.nextGatewayID
	if id == "" {
		id = "gw-1"
	}
	return runtimeports.RepoGateway{
		ID:           id,
		RepositoryID: arg.RepositoryID,
		UserID:       arg.UserID,
		Status:       arg.Status,
	}, nil
}

func (f *fakeRepoGatewayQuerier) GetActiveRepoGatewayForUserRepo(ctx context.Context, arg runtimeports.GetActiveRepoGatewayForUserRepoParams) (runtimeports.RepoGateway, error) {
	if f.active != nil {
		return *f.active, nil
	}
	return runtimeports.RepoGateway{}, pgx.ErrNoRows
}

func (f *fakeRepoGatewayQuerier) UpdateRepoGatewayExecutionInfo(ctx context.Context, arg runtimeports.UpdateRepoGatewayExecutionInfoParams) (runtimeports.RepoGateway, error) {
	if f.executionInfoErr != nil {
		return runtimeports.RepoGateway{}, f.executionInfoErr
	}
	f.executionInfo = append(f.executionInfo, arg)
	return runtimeports.RepoGateway{
		ID:                  arg.ID,
		VmID:                arg.VmID,
		BaseUrl:             arg.BaseUrl,
		AuthTokenHash:       arg.AuthTokenHash,
		AuthTokenCiphertext: arg.AuthTokenCiphertext,
		Status:              arg.Status,
	}, nil
}

func (f *fakeRepoGatewayQuerier) UpdateRepoGatewayStatus(ctx context.Context, arg runtimeports.UpdateRepoGatewayStatusParams) (runtimeports.RepoGateway, error) {
	f.statusUpdates = append(f.statusUpdates, arg)
	return runtimeports.RepoGateway{ID: arg.ID, Status: arg.Status}, nil
}

func (f *fakeRepoGatewayQuerier) TouchRepoGatewayActivity(ctx context.Context, id string) error {
	f.touched = append(f.touched, id)
	return nil
}

func (f *fakeRepoGatewayQuerier) SoftDeleteRepoGateway(ctx context.Context, id string) (runtimeports.RepoGateway, error) {
	f.mu.Lock()
	f.softDeleted = append(f.softDeleted, id)
	f.mu.Unlock()
	return runtimeports.RepoGateway{ID: id, Status: "stopped"}, nil
}

func (f *fakeRepoGatewayQuerier) ListStaleRepoGateways(ctx context.Context, ageSeconds int64) ([]runtimeports.RepoGateway, error) {
	f.mu.Lock()
	f.staleAgeSeconds = ageSeconds
	rows := f.staleRows
	f.mu.Unlock()
	return rows, nil
}

func (f *fakeRepoGatewayQuerier) ListActiveRepoGateways(ctx context.Context) ([]runtimeports.RepoGateway, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]runtimeports.RepoGateway(nil), f.activeRows...), nil
}

// getSoftDeleted returns a copy of the tombstoned gateway IDs under lock, so
// tests can read them without racing the background reaper goroutine.
func (f *fakeRepoGatewayQuerier) getSoftDeleted() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.softDeleted...)
}

// getStaleAgeSeconds returns the last age passed to ListStaleRepoGateways under lock.
func (f *fakeRepoGatewayQuerier) getStaleAgeSeconds() int64 {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.staleAgeSeconds
}

func (f *fakeRepoGatewayQuerier) CreateAccessToken(ctx context.Context, arg db.CreateAccessTokenParams) (db.AccessToken, error) {
	f.accessTokens = append(f.accessTokens, arg)
	return db.AccessToken{ID: int64(len(f.accessTokens)), UserID: arg.UserID}, nil
}

func (f *fakeRepoGatewayQuerier) DeleteAccessToken(ctx context.Context, arg db.DeleteAccessTokenParams) error {
	f.deletedTokens = append(f.deletedTokens, arg)
	return nil
}

// fakeRepoGatewayVMClient fakes the minimal Microsandbox surface used by the
// repo gateway service.
type fakeRepoGatewayVMClient struct {
	createVMFn             func(ctx context.Context, req sandbox.CreateRequest) (sandbox.CreateResult, error)
	getVMFn                func(ctx context.Context, vmID string) (sandbox.Sandbox, error)
	startVMFn              func(ctx context.Context, vmID string, req sandbox.StartRequest) (sandbox.StartResult, error)
	deleteVMFn             func(ctx context.Context, vmID string) error
	createSystemdServiceFn func(ctx context.Context, vmID string, req sandbox.ServiceSpec) (sandbox.CreateServiceResult, error)
	execAwaitFn            func(ctx context.Context, vmID string, req sandbox.ExecRequest) (sandbox.ExecResult, error)

	createDomainMappingFn func(ctx context.Context, domain string, req sandbox.PublishIngressRequest) (sandbox.IngressRoute, error)

	createVMReqs      []sandbox.CreateRequest
	systemdSpecs      []sandbox.ServiceSpec
	execAwaitReqs     []sandbox.ExecRequest
	startedVMIDs      []string
	startReqs         []sandbox.StartRequest
	deletedVMIDs      []string
	getVMRequestedIDs []string
	mappedDomains     []string
	mappedPorts       []int32
	unmappedDomains   []string
}

func (f *fakeRepoGatewayVMClient) PublishIngress(ctx context.Context, domain string, req sandbox.PublishIngressRequest) (sandbox.IngressRoute, error) {
	f.mappedDomains = append(f.mappedDomains, domain)
	f.mappedPorts = append(f.mappedPorts, req.Port)
	if f.createDomainMappingFn != nil {
		return f.createDomainMappingFn(ctx, domain, req)
	}
	return sandbox.IngressRoute{Hostname: domain, SandboxID: req.SandboxID, Port: req.Port}, nil
}

func (f *fakeRepoGatewayVMClient) RevokeIngress(ctx context.Context, domain string) error {
	f.unmappedDomains = append(f.unmappedDomains, domain)
	return nil
}

func (f *fakeRepoGatewayVMClient) CreateSandbox(ctx context.Context, req sandbox.CreateRequest) (sandbox.CreateResult, error) {
	f.createVMReqs = append(f.createVMReqs, req)
	if f.createVMFn != nil {
		return f.createVMFn(ctx, req)
	}
	// Ingress publication is a separate capability from sandbox creation.
	return sandbox.CreateResult{ID: "vm-gw-1"}, nil
}

func (f *fakeRepoGatewayVMClient) InspectSandbox(ctx context.Context, vmID string) (sandbox.Sandbox, error) {
	f.getVMRequestedIDs = append(f.getVMRequestedIDs, vmID)
	if f.getVMFn != nil {
		return f.getVMFn(ctx, vmID)
	}
	return sandbox.Sandbox{ID: vmID, State: sandbox.StateRunning}, nil
}

func (f *fakeRepoGatewayVMClient) StartSandbox(ctx context.Context, vmID string, req sandbox.StartRequest) (sandbox.StartResult, error) {
	f.startedVMIDs = append(f.startedVMIDs, vmID)
	f.startReqs = append(f.startReqs, req)
	if f.startVMFn != nil {
		return f.startVMFn(ctx, vmID, req)
	}
	return sandbox.StartResult{ID: vmID}, nil
}

func (f *fakeRepoGatewayVMClient) DeleteSandbox(ctx context.Context, vmID string) error {
	f.deletedVMIDs = append(f.deletedVMIDs, vmID)
	if f.deleteVMFn != nil {
		return f.deleteVMFn(ctx, vmID)
	}
	return nil
}

func (f *fakeRepoGatewayVMClient) CreateService(ctx context.Context, vmID string, req sandbox.ServiceSpec) (sandbox.CreateServiceResult, error) {
	f.systemdSpecs = append(f.systemdSpecs, req)
	if f.createSystemdServiceFn != nil {
		return f.createSystemdServiceFn(ctx, vmID, req)
	}
	return sandbox.CreateServiceResult{Success: true, ServiceName: req.Name}, nil
}

func (f *fakeRepoGatewayVMClient) Execute(ctx context.Context, vmID string, req sandbox.ExecRequest) (sandbox.ExecResult, error) {
	f.execAwaitReqs = append(f.execAwaitReqs, req)
	if f.execAwaitFn != nil {
		return f.execAwaitFn(ctx, vmID, req)
	}
	zero := int32(0)
	return sandbox.ExecResult{StatusCode: &zero}, nil
}

func newTestRepoGatewayService(q RepoGatewayQuerier, vm RepoGatewayVMClient, opts ...RepoGatewayServiceOption) *RepoGatewayService {
	base := []RepoGatewayServiceOption{
		WithRepoGatewaySandboxClient(vm),
		func(s *RepoGatewayService) { s.productHostPath = "testdata/product-gateway-fixture.mjs" },
		WithRepoGatewayGitBaseURL("https://jjhub.example"),
	}
	return NewRepoGatewayService(q, append(base, opts...)...)
}

func testRepoGatewayInput() RepoGatewayConnectionInput {
	return RepoGatewayConnectionInput{
		RepositoryID:        200,
		UserID:              1,
		RepoOwner:           "alice",
		RepoName:            "demo",
		RepoDefaultBookmark: "main",
	}
}

func TestRepoGatewayBunInstallScript_UpgradesStalePreinstalledBun(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	installedBun := filepath.Join(dir, "installed", "bun")
	stagedBun := filepath.Join(dir, "staged", "bun")
	freshBun := filepath.Join(dir, "fresh-bun")
	require.NoError(t, os.MkdirAll(filepath.Dir(installedBun), 0o755))
	require.NoError(t, os.MkdirAll(filepath.Dir(stagedBun), 0o755))
	require.NoError(t, os.WriteFile(installedBun, []byte("#!/bin/sh\nprintf '1.3.9\\n'\n"), 0o755))
	require.NoError(t, os.WriteFile(freshBun, []byte("#!/bin/sh\nprintf '"+repoGatewayBunVersion+"\\n'\n"), 0o755))

	installer := "install -m 755 " + shellQuote(freshBun) + " " + shellQuote(stagedBun)
	script := "set -euo pipefail\n" + repoGatewayBunInstallScript(installedBun, stagedBun, installer)
	output, err := exec.Command("bash", "-c", script).CombinedOutput()
	require.NoError(t, err, string(output))

	version, err := exec.Command(installedBun, "--version").CombinedOutput()
	require.NoError(t, err, string(version))
	assert.Equal(t, repoGatewayBunVersion, strings.TrimSpace(string(version)))
}

// The 2026-08-04 production failure: the VM base image exports
// BUN_INSTALL=/workspace/.bun, and bun's installer honors that over the
// staged path the script later stats. The script must pin BUN_INSTALL to the
// staged binary's directory so an ambient value can never redirect the
// install.
func TestRepoGatewayBunInstallScript_AmbientBunInstallCannotRedirect(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	installedBun := filepath.Join(dir, "installed", "bun")
	// The staged path follows the bun installer's layout, <prefix>/bin/bun —
	// the script pins BUN_INSTALL to its grandparent.
	stagedBun := filepath.Join(dir, "staged", "bin", "bun")
	decoyInstall := filepath.Join(dir, "decoy")
	freshBun := filepath.Join(dir, "fresh-bun")
	require.NoError(t, os.MkdirAll(filepath.Dir(installedBun), 0o755))
	require.NoError(t, os.MkdirAll(filepath.Dir(stagedBun), 0o755))
	require.NoError(t, os.MkdirAll(decoyInstall, 0o755))
	require.NoError(t, os.WriteFile(installedBun, []byte("#!/bin/sh\nprintf '1.3.9\\n'\n"), 0o755))
	require.NoError(t, os.WriteFile(freshBun, []byte("#!/bin/sh\nprintf '"+repoGatewayBunVersion+"\\n'\n"), 0o755))

	// Mimics bun's install.sh: stages the binary at $BUN_INSTALL/bin/bun.
	installer := "install -d \"$BUN_INSTALL/bin\" && install -m 755 " + shellQuote(freshBun) + " \"$BUN_INSTALL/bin/bun\""
	script := "set -euo pipefail\n" + repoGatewayBunInstallScript(installedBun, stagedBun, installer)
	cmd := exec.Command("bash", "-c", script)
	cmd.Env = append(os.Environ(), "BUN_INSTALL="+decoyInstall)
	output, err := cmd.CombinedOutput()
	require.NoError(t, err, string(output))

	version, err := exec.Command(installedBun, "--version").CombinedOutput()
	require.NoError(t, err, string(version))
	assert.Equal(t, repoGatewayBunVersion, strings.TrimSpace(string(version)))
	_, decoyErr := os.Stat(filepath.Join(decoyInstall, "bin", "bun"))
	assert.Error(t, decoyErr, "the ambient BUN_INSTALL directory must stay empty")
}

func TestRepoGatewayService_Provision_CreatesGatewayVM(t *testing.T) {
	t.Parallel()

	q := &fakeRepoGatewayQuerier{}
	vm := &fakeRepoGatewayVMClient{}
	// Capture how many exec steps ran before the gateway service was created
	// so ordering (clone -> global pack init -> systemd) is provable.
	execsBeforeSystemd := -1
	vm.createSystemdServiceFn = func(ctx context.Context, vmID string, req sandbox.ServiceSpec) (sandbox.CreateServiceResult, error) {
		execsBeforeSystemd = len(vm.execAwaitReqs)
		return sandbox.CreateServiceResult{Success: true, ServiceName: req.Name}, nil
	}
	svc := newTestRepoGatewayService(q, vm)

	before := time.Now()
	info, err := svc.GetRepoGatewayConnectionInfo(context.Background(), testRepoGatewayInput())
	require.NoError(t, err)

	// The boot contract installs required OS packages, waits for readiness, and
	// keeps public ingress as a separate capability.
	require.Len(t, vm.createVMReqs, 1)
	req := vm.createVMReqs[0]
	assert.Empty(t, req.Ports)
	assert.ElementsMatch(t, []string{"git", "curl", "ca-certificates", "unzip"}, req.Packages)
	assert.Empty(t, req.Workdir, "the runtime step creates /workspace before the service starts")
	require.NotNil(t, req.WaitForReady)
	assert.True(t, *req.WaitForReady)
	require.Len(t, vm.mappedDomains, 1)
	assert.Equal(t, "smithers-gw-vm-gw-1.preview.jjhub.tech", vm.mappedDomains[0])
	assert.Equal(t, []int32{7331}, vm.mappedPorts)
	require.NotNil(t, req.Persistence)
	assert.Equal(t, sandbox.PersistencePersistent, req.Persistence.Type)
	require.NotNil(t, req.IdleTimeoutSeconds)
	assert.Positive(t, *req.IdleTimeoutSeconds)

	// Post-boot exec order: runtime install (bun + jj to /usr/local/bin; OS
	// packages are part of the controller boot contract) → repo clone into the workspace dir (empty repos clone
	// cleanly, unlike create-time GitRepos) → global smithers pack init so the
	// gateway serves the stock workflows even when the repo has no .smithers/
	// of its own.
	require.Len(t, vm.execAwaitReqs, 3)
	runtimeCmd := vm.execAwaitReqs[0].Command
	assert.NotContains(t, runtimeCmd, "apt-get install")
	assert.Contains(t, runtimeCmd, "github.com/oven-sh/bun/releases/download/")
	assert.Contains(t, runtimeCmd, "bun_version="+shellQuote(repoGatewayBunVersion))
	assert.Contains(t, runtimeCmd, `if [ "$installed_bun_version" != "$bun_version" ]; then`)
	assert.Contains(t, runtimeCmd, "sha256sum -c -")
	assert.Contains(t, runtimeCmd, "jj-vcs/jj/releases")
	assert.Contains(t, runtimeCmd, "/usr/local/bin/jj")
	cloneCmd := vm.execAwaitReqs[1].Command
	assert.Contains(t, cloneCmd, "git")
	assert.Contains(t, cloneCmd, "clone")
	assert.Contains(t, cloneCmd, "/workspace/repo")
	// smithers >=0.28.0 boots bare workspaces itself (creates smithers.db at
	// its Workdir); the old seed-an-empty-DB workaround must stay gone.
	assert.NotContains(t, cloneCmd, "smithers.db")
	initCmd := vm.execAwaitReqs[2].Command
	assert.Contains(t, initCmd, repoGatewayProductHostPath)
	assert.Contains(t, initCmd, "base64 -d")
	assert.NotContains(t, initCmd, "bun x")
	assert.NotContains(t, initCmd, "smithers init")
	require.Contains(t, req.Files, repoGatewayProductHostB64Path)
	// All exec steps (runtime install + clone + pack init) run before the
	// gateway service starts.
	assert.Equal(t, 3, execsBeforeSystemd)
	// Clone auth uses a short-lived repo token that is revoked afterwards.
	require.Len(t, q.accessTokens, 1)
	require.Len(t, q.deletedTokens, 1)

	// Gateway systemd unit: long-lived service, restart on failure, bearer
	// token via SMITHERS_API_KEY, serving on 0.0.0.0:7331.
	require.Len(t, vm.systemdSpecs, 1)
	spec := vm.systemdSpecs[0]
	assert.Equal(t, "smithers-gateway", spec.Name)
	assert.Equal(t, sandbox.ServiceModeService, spec.Mode)
	require.NotNil(t, spec.RestartPolicy)
	assert.Equal(t, sandbox.RestartPolicyOnFailure, spec.RestartPolicy.Kind)
	require.NoError(t, spec.ValidateExec())
	assert.Equal(t, []string{"/usr/local/bin/bun", repoGatewayProductHostPath, "serve", "--root", repoGatewayWorkspace, "--host", "0.0.0.0", "--port", "7331", "--listen"}, spec.Exec)
	assert.Equal(t, "/workspace/repo", spec.Workdir)
	assert.NotEmpty(t, spec.Env["PATH"])
	assert.Equal(t, info.Token, spec.Env["SMITHERS_API_KEY"])

	// Returned connection info.
	assert.Equal(t, "https://smithers-gw-vm-gw-1.preview.jjhub.tech", info.BaseURL)
	assert.True(t, strings.HasPrefix(info.Token, "smithers_gateway_"), "token %q should have gateway prefix", info.Token)
	assert.Equal(t, "running", info.Status)
	assert.Equal(t, "vm-gw-1", info.VMID)
	assert.True(t, info.ExpiresAt.After(before), "expires_at must be in the future")
	assert.True(t, info.ExpiresAt.Before(before.Add(25*time.Hour)), "expires_at must be bounded")

	// Persistence: hash + ciphertext stored, never the plaintext. The vm_id +
	// base_url are EARLY-persisted as status='starting' immediately after the VM
	// exists (so a crash mid-provision leaves a reaper-collectable row), then the
	// row is flipped to 'running' at the end.
	require.Len(t, q.executionInfo, 1)
	stored := q.executionInfo[0]
	sum := sha256.Sum256([]byte(info.Token))
	assert.Equal(t, hex.EncodeToString(sum[:]), stored.AuthTokenHash)
	assert.NotEmpty(t, stored.AuthTokenCiphertext)
	assert.Equal(t, "vm-gw-1", stored.VmID)
	assert.Equal(t, "https://smithers-gw-vm-gw-1.preview.jjhub.tech", stored.BaseUrl)
	assert.Equal(t, "starting", stored.Status, "vm_id is persisted as 'starting' before the slow setup steps")
	// The final flip to 'running' is the last status update on the happy path.
	require.NotEmpty(t, q.statusUpdates)
	assert.Equal(t, "running", q.statusUpdates[len(q.statusUpdates)-1].Status)
}

func TestRepoGatewayService_Provision_EncryptsTokenAtRest(t *testing.T) {
	t.Parallel()

	q := &fakeRepoGatewayQuerier{}
	vm := &fakeRepoGatewayVMClient{}
	codec := &staticTestCodec{prefix: "enc:"}
	svc := newTestRepoGatewayService(q, vm, WithRepoGatewaySecretCodec(codec))

	info, err := svc.GetRepoGatewayConnectionInfo(context.Background(), testRepoGatewayInput())
	require.NoError(t, err)

	require.Len(t, q.executionInfo, 1)
	stored := q.executionInfo[0]
	assert.Equal(t, "enc:"+info.Token, stored.AuthTokenCiphertext)
	assert.NotEqual(t, info.Token, stored.AuthTokenCiphertext, "ciphertext must differ from plaintext")
}

func TestRepoGatewayService_Provision_IngressMappingFailure_FailsHonestly(t *testing.T) {
	t.Parallel()

	q := &fakeRepoGatewayQuerier{}
	vm := &fakeRepoGatewayVMClient{
		createVMFn: func(ctx context.Context, req sandbox.CreateRequest) (sandbox.CreateResult, error) {
			return sandbox.CreateResult{ID: "vm-nodomain"}, nil
		},
		createDomainMappingFn: func(ctx context.Context, domain string, req sandbox.PublishIngressRequest) (sandbox.IngressRoute, error) {
			return sandbox.IngressRoute{}, errors.New("mapping refused")
		},
	}
	svc := newTestRepoGatewayService(q, vm)

	_, err := svc.GetRepoGatewayConnectionInfo(context.Background(), testRepoGatewayInput())
	require.Error(t, err)
	assert.Contains(t, err.Error(), "ingress domain")
	// The orphaned VM is deleted and the row marked failed.
	assert.Contains(t, vm.deletedVMIDs, "vm-nodomain")
	require.NotEmpty(t, q.statusUpdates)
	assert.Equal(t, "failed", q.statusUpdates[len(q.statusUpdates)-1].Status)
}

func TestRepoGatewayService_Provision_CloneFailure_FailsProvision(t *testing.T) {
	t.Parallel()

	q := &fakeRepoGatewayQuerier{}
	one := int32(1)
	zero := int32(0)
	vm := &fakeRepoGatewayVMClient{
		execAwaitFn: func(ctx context.Context, vmID string, req sandbox.ExecRequest) (sandbox.ExecResult, error) {
			// The runtime-install step precedes the clone; only the clone fails.
			if strings.Contains(req.Command, "clone") {
				return sandbox.ExecResult{StatusCode: &one, Stderr: "fatal: repository not found"}, nil
			}
			return sandbox.ExecResult{StatusCode: &zero}, nil
		},
	}
	svc := newTestRepoGatewayService(q, vm)

	_, err := svc.GetRepoGatewayConnectionInfo(context.Background(), testRepoGatewayInput())
	require.Error(t, err)
	assert.Contains(t, err.Error(), "clone")
	assert.Contains(t, vm.deletedVMIDs, "vm-gw-1")
	require.NotEmpty(t, q.statusUpdates)
	assert.Equal(t, "failed", q.statusUpdates[len(q.statusUpdates)-1].Status)
	// No gateway service was started on the dead VM.
	assert.Empty(t, vm.systemdSpecs)
}

func TestRepoGatewayService_Provision_SystemdFailure_CleansUp(t *testing.T) {
	t.Parallel()

	q := &fakeRepoGatewayQuerier{}
	vm := &fakeRepoGatewayVMClient{
		createSystemdServiceFn: func(ctx context.Context, vmID string, req sandbox.ServiceSpec) (sandbox.CreateServiceResult, error) {
			return sandbox.CreateServiceResult{Success: false, Message: "unit rejected"}, nil
		},
	}
	svc := newTestRepoGatewayService(q, vm)

	_, err := svc.GetRepoGatewayConnectionInfo(context.Background(), testRepoGatewayInput())
	require.Error(t, err)
	assert.Contains(t, vm.deletedVMIDs, "vm-gw-1")
	require.NotEmpty(t, q.statusUpdates)
	assert.Equal(t, "failed", q.statusUpdates[len(q.statusUpdates)-1].Status)
}

func TestRepoGatewayService_Provision_DoesNotPersistRepoSecrets(t *testing.T) {
	t.Parallel()

	q := &fakeRepoGatewayQuerier{}
	vm := &fakeRepoGatewayVMClient{}
	svc := newTestRepoGatewayService(q, vm)

	_, err := svc.GetRepoGatewayConnectionInfo(context.Background(), testRepoGatewayInput())
	require.NoError(t, err)

	require.Len(t, vm.systemdSpecs, 1)
	assert.NotContains(t, vm.systemdSpecs[0].Env, "ANTHROPIC_API_KEY")
	assert.Len(t, vm.systemdSpecs[0].Env, 7)
	assert.NotEmpty(t, vm.systemdSpecs[0].Env["SMITHERS_API_KEY"])
}

func TestRepoGatewayService_Reuse_RunningVM_ReturnsExistingToken(t *testing.T) {
	t.Parallel()

	q := &fakeRepoGatewayQuerier{
		active: &runtimeports.RepoGateway{
			ID:                  "gw-live",
			RepositoryID:        200,
			UserID:              1,
			VmID:                "vm-live",
			BaseUrl:             "https://vm-live.sandbox.sh",
			AuthTokenCiphertext: "smithers_gateway_deadbeef",
			Status:              "running",
		},
	}
	vm := &fakeRepoGatewayVMClient{}
	svc := newTestRepoGatewayService(q, vm)

	info, err := svc.GetRepoGatewayConnectionInfo(context.Background(), testRepoGatewayInput())
	require.NoError(t, err)

	assert.Empty(t, vm.createVMReqs, "must not provision a second VM")
	assert.Empty(t, vm.startedVMIDs, "running VM needs no resume")
	assert.Equal(t, "https://vm-live.sandbox.sh", info.BaseURL)
	assert.Equal(t, "smithers_gateway_deadbeef", info.Token)
	assert.Equal(t, "vm-live", info.VMID)
	assert.Contains(t, q.touched, "gw-live")
}

func TestRepoGatewayService_Reuse_StartingRowReturnsProvisioningConflict(t *testing.T) {
	t.Parallel()

	q := &fakeRepoGatewayQuerier{
		active: &runtimeports.RepoGateway{
			ID:                  "gw-starting",
			RepositoryID:        200,
			UserID:              1,
			VmID:                "vm-starting",
			BaseUrl:             "https://vm-starting.sandbox.sh",
			AuthTokenCiphertext: "smithers_gateway_pending",
			Status:              "starting",
		},
	}
	vm := &fakeRepoGatewayVMClient{}
	svc := newTestRepoGatewayService(q, vm)

	_, err := svc.GetRepoGatewayConnectionInfo(context.Background(), testRepoGatewayInput())
	require.Error(t, err)
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, 409, apiErr.Status)
	assert.Contains(t, strings.ToLower(apiErr.Message), "provisioning")
	assert.Empty(t, vm.getVMRequestedIDs, "starting rows must not be probed and promoted by reuse")
	assert.Empty(t, q.statusUpdates, "starting rows must only become running after provisioning completes")
	assert.Empty(t, vm.createVMReqs, "a live starting reservation must not trigger a competing provision")
}

func TestRepoGatewayService_Reuse_SuspendedVM_Resumes(t *testing.T) {
	t.Parallel()

	q := &fakeRepoGatewayQuerier{
		active: &runtimeports.RepoGateway{
			ID:                  "gw-idle",
			RepositoryID:        200,
			UserID:              1,
			VmID:                "vm-idle",
			BaseUrl:             "https://vm-idle.sandbox.sh",
			AuthTokenCiphertext: "smithers_gateway_cafe",
			Status:              "suspended",
		},
	}
	vm := &fakeRepoGatewayVMClient{
		getVMFn: func(ctx context.Context, vmID string) (sandbox.Sandbox, error) {
			return sandbox.Sandbox{ID: vmID, State: sandbox.StateStopped}, nil
		},
	}
	svc := newTestRepoGatewayService(q, vm)

	info, err := svc.GetRepoGatewayConnectionInfo(context.Background(), testRepoGatewayInput())
	require.NoError(t, err)

	assert.Equal(t, []string{"vm-idle"}, vm.startedVMIDs)
	assert.Empty(t, vm.createVMReqs)
	assert.Equal(t, "smithers_gateway_cafe", info.Token)
	assert.Equal(t, "running", info.Status)
	// Status transitions back to running in the store.
	require.NotEmpty(t, q.statusUpdates)
	assert.Equal(t, "running", q.statusUpdates[len(q.statusUpdates)-1].Status)
}

// A resumed VM boots with no gateway process: the worker launches services as
// detached guest processes (not systemd units), and the controller's start
// replay deliberately skips the secret-bearing declaration. The resume path
// must re-apply the engine patch while the process is down and re-declare the
// service with the full env (the operator token decrypts from the row; the
// seat key is config) — exactly the provision order — or the resumed gateway
// never serves and every parked run on it is orphaned.
func TestRepoGatewayService_Reuse_SuspendedVM_RedeclaresServiceWithSecrets(t *testing.T) {
	t.Parallel()

	q := &fakeRepoGatewayQuerier{
		active: &runtimeports.RepoGateway{
			ID:                  "gw-idle-seated",
			RepositoryID:        200,
			UserID:              1,
			VmID:                "vm-idle-seated",
			BaseUrl:             "https://vm-idle-seated.sandbox.sh",
			AuthTokenCiphertext: "smithers_gateway_cafe",
			Status:              "suspended",
		},
	}
	vm := &fakeRepoGatewayVMClient{
		getVMFn: func(ctx context.Context, vmID string) (sandbox.Sandbox, error) {
			return sandbox.Sandbox{ID: vmID, State: sandbox.StateStopped}, nil
		},
	}
	svc := newTestRepoGatewayService(q, vm, WithRepoGatewayModelSeats(testGatewayModelSeats))

	info, err := svc.GetRepoGatewayConnectionInfo(context.Background(), testRepoGatewayInput())
	require.NoError(t, err)
	assert.Equal(t, "running", info.Status)

	require.Len(t, vm.systemdSpecs, 1, "resume must re-declare the gateway service")
	spec := vm.systemdSpecs[0]
	assert.Equal(t, "smithers_gateway_cafe", spec.Env["SMITHERS_API_KEY"])
	require.NotEmpty(t, vm.startReqs)
	assertGatewayModelSeat(t, spec.Env, vm.startReqs[len(vm.startReqs)-1].EgressProxy)

	assert.Equal(t, "alice/demo", spec.Env["SMITHERS_REPO"])
	assert.Equal(t, "gw-idle-seated", spec.Env["SMITHERS_GATEWAY_ID"])
	var checked bool
	for _, req := range vm.execAwaitReqs {
		checked = checked || strings.Contains(req.Command, repoGatewayProductHostMarker)
		assert.NotContains(t, req.Command, "SMITHERS_GATEWAY_ENGINE_PATCH")
	}
	assert.True(t, checked, "resume must verify the product host protocol")

}

// The resume re-declare gets exactly one chance per VM lifetime: the block is
// gated on the VM not running, so a successful resume means no later resolve
// re-enters it and nothing else ever starts the gateway process. A single
// transient CreateService failure would then guarantee a dead liveness probe
// and hand the caller a discard + reprovision — destroying the persistent
// workspace and every parked run on a VM that resumed perfectly well. Retry
// once, exactly as the resume itself does.
func TestRepoGatewayService_Reuse_TransientServiceDeclareFailure_RetriesInPlace(t *testing.T) {
	t.Parallel()

	q := &fakeRepoGatewayQuerier{
		active: &runtimeports.RepoGateway{
			ID:                  "gw-idle-flaky-declare",
			RepositoryID:        200,
			UserID:              1,
			VmID:                "vm-idle-flaky-declare",
			BaseUrl:             "https://vm-idle-flaky-declare.sandbox.sh",
			AuthTokenCiphertext: "smithers_gateway_cafe",
			Status:              "running",
		},
	}
	declares := 0
	vm := &fakeRepoGatewayVMClient{
		getVMFn: func(ctx context.Context, vmID string) (sandbox.Sandbox, error) {
			return sandbox.Sandbox{ID: vmID, State: sandbox.StateStopped}, nil
		},
		createSystemdServiceFn: func(ctx context.Context, vmID string, req sandbox.ServiceSpec) (sandbox.CreateServiceResult, error) {
			declares++
			if declares == 1 {
				return sandbox.CreateServiceResult{}, errors.New("connection reset by peer")
			}
			return sandbox.CreateServiceResult{Success: true, ServiceName: req.Name}, nil
		},
	}
	svc := newTestRepoGatewayService(q, vm, WithRepoGatewayModelSeats(testGatewayModelSeats))

	info, err := svc.GetRepoGatewayConnectionInfo(context.Background(), testRepoGatewayInput())
	require.NoError(t, err)
	assert.Equal(t, "running", info.Status)

	require.Equal(t, 2, declares, "a transient re-declare failure must be retried once")
	assert.Empty(t, vm.deletedVMIDs, "the gateway survives a transient re-declare failure")
	require.Len(t, vm.systemdSpecs, 2)
	assert.Equal(t, "smithers_gateway_cafe", vm.systemdSpecs[1].Env["SMITHERS_API_KEY"],
		"the retry carries the same full env, not a degraded one")
	require.NotEmpty(t, vm.startReqs)
	assertGatewayModelSeat(t, vm.systemdSpecs[1].Env, vm.startReqs[len(vm.startReqs)-1].EgressProxy)
}

func TestRepoGatewayService_Reuse_TransientHardResumeFailure_RetriesInPlace(t *testing.T) {
	t.Parallel()

	q := &fakeRepoGatewayQuerier{
		active: &runtimeports.RepoGateway{
			ID: "gw-transient", RepositoryID: 200, UserID: 1, VmID: "vm-transient",
			BaseUrl: "https://vm-transient.sandbox.sh", AuthTokenCiphertext: "smithers_gateway_live",
			Status: "running",
		},
	}
	startCalls := 0
	vm := &fakeRepoGatewayVMClient{
		getVMFn: func(_ context.Context, vmID string) (sandbox.Sandbox, error) {
			return sandbox.Sandbox{ID: vmID, State: sandbox.StateStopped}, nil
		},
		startVMFn: func(_ context.Context, vmID string, _ sandbox.StartRequest) (sandbox.StartResult, error) {
			startCalls++
			if startCalls == 1 {
				return sandbox.StartResult{}, &sandbox.StatusError{StatusCode: 500, Message: "temporary upstream failure"}
			}
			return sandbox.StartResult{ID: vmID}, nil
		},
	}
	svc := newTestRepoGatewayService(q, vm)

	info, err := svc.GetRepoGatewayConnectionInfo(context.Background(), testRepoGatewayInput())
	require.NoError(t, err)
	assert.Equal(t, "vm-transient", info.VMID)
	assert.Equal(t, 2, startCalls)
	assert.Empty(t, q.getSoftDeleted(), "a recovered transient failure must preserve the gateway")
	assert.Empty(t, vm.createVMReqs, "a recovered transient failure must not provision a replacement")
}

func TestRepoGatewayService_Reuse_PersistentHardResumeFailure_Reprovisions(t *testing.T) {
	t.Parallel()

	q := &fakeRepoGatewayQuerier{
		active: &runtimeports.RepoGateway{
			ID: "gw-uffd", RepositoryID: 200, UserID: 1, VmID: "vm-uffd",
			BaseUrl: "https://vm-uffd.sandbox.sh", AuthTokenCiphertext: "smithers_gateway_live",
			Status: "running",
		},
	}
	vm := &fakeRepoGatewayVMClient{
		getVMFn: func(_ context.Context, vmID string) (sandbox.Sandbox, error) {
			return sandbox.Sandbox{ID: vmID, State: sandbox.StateStopped}, nil
		},
		startVMFn: func(_ context.Context, _ string, _ sandbox.StartRequest) (sandbox.StartResult, error) {
			return sandbox.StartResult{}, &sandbox.StatusError{
				StatusCode: 500,
				Message:    "Failed to spawn UFFD handler 'uffd:vm-uffd'",
			}
		},
	}
	svc := newTestRepoGatewayService(q, vm)

	info, err := svc.GetRepoGatewayConnectionInfo(context.Background(), testRepoGatewayInput())
	require.NoError(t, err, "a persistently unresumable gateway must self-heal instead of returning 500")
	assert.Equal(t, []string{"vm-uffd", "vm-uffd"}, vm.startedVMIDs, "hard failures get exactly one retry")
	assert.Contains(t, q.getSoftDeleted(), "gw-uffd")
	assert.Contains(t, vm.unmappedDomains, repoGatewayDomain("vm-uffd"))
	assert.Contains(t, vm.deletedVMIDs, "vm-uffd")
	require.Len(t, vm.createVMReqs, 1)
	assert.NotEqual(t, "vm-uffd", info.VMID)
}

func TestRepoGatewayService_Reuse_ResumeTimeout_Reprovisions(t *testing.T) {
	t.Parallel()

	q := &fakeRepoGatewayQuerier{
		active: &runtimeports.RepoGateway{
			ID: "gw-timeout", RepositoryID: 200, UserID: 1, VmID: "vm-timeout",
			BaseUrl: "https://vm-timeout.sandbox.sh", AuthTokenCiphertext: "smithers_gateway_live",
			Status: "running",
		},
	}
	vm := &fakeRepoGatewayVMClient{
		getVMFn: func(_ context.Context, vmID string) (sandbox.Sandbox, error) {
			return sandbox.Sandbox{ID: vmID, State: sandbox.StateStopped}, nil
		},
		startVMFn: func(_ context.Context, _ string, _ sandbox.StartRequest) (sandbox.StartResult, error) {
			return sandbox.StartResult{}, context.DeadlineExceeded
		},
	}
	svc := newTestRepoGatewayService(q, vm)

	info, err := svc.GetRepoGatewayConnectionInfo(context.Background(), testRepoGatewayInput())
	require.NoError(t, err, "an internally timed-out gateway resume must self-heal")
	assert.Equal(t, []string{"vm-timeout"}, vm.startedVMIDs, "timeouts must not add another two-minute retry")
	assert.Contains(t, q.getSoftDeleted(), "gw-timeout")
	assert.Contains(t, vm.deletedVMIDs, "vm-timeout")
	require.Len(t, vm.createVMReqs, 1)
	assert.NotEqual(t, "vm-timeout", info.VMID)
}

func TestRepoGatewayService_Reuse_CallerCancellation_DoesNotReprovision(t *testing.T) {
	t.Parallel()

	q := &fakeRepoGatewayQuerier{
		active: &runtimeports.RepoGateway{
			ID: "gw-canceled", RepositoryID: 200, UserID: 1, VmID: "vm-canceled",
			BaseUrl: "https://vm-canceled.sandbox.sh", AuthTokenCiphertext: "smithers_gateway_live",
			Status: "running",
		},
	}
	vm := &fakeRepoGatewayVMClient{
		getVMFn: func(_ context.Context, vmID string) (sandbox.Sandbox, error) {
			return sandbox.Sandbox{ID: vmID, State: sandbox.StateStopped}, nil
		},
		startVMFn: func(ctx context.Context, _ string, _ sandbox.StartRequest) (sandbox.StartResult, error) {
			return sandbox.StartResult{}, ctx.Err()
		},
	}
	svc := newTestRepoGatewayService(q, vm)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	_, err := svc.GetRepoGatewayConnectionInfo(ctx, testRepoGatewayInput())
	require.Error(t, err)
	assert.Empty(t, q.getSoftDeleted(), "caller cancellation must preserve the existing gateway")
	assert.Empty(t, vm.deletedVMIDs)
	assert.Empty(t, vm.createVMReqs)
}

// A 'running' gateway whose VM Microsandbox idle-suspended out from under us must
// NOT increment the active-VM gauge on resume — the row was never decremented
// for the idle suspend, so re-adding +1 makes the gauge drift up every cycle.
func TestRepoGatewayService_Reuse_AutoSuspendedVM_DoesNotInflateGauge(t *testing.T) {
	t.Parallel()

	var gauge float64
	metrics := &mockSandboxMetricsRecorder{addActiveVMsFn: func(vmType string, delta float64) {
		if vmType == "gateway" {
			gauge += delta
		}
	}}
	q := &fakeRepoGatewayQuerier{
		active: &runtimeports.RepoGateway{
			ID: "gw-run", RepositoryID: 200, UserID: 1, VmID: "vm-run",
			BaseUrl: "https://vm-run.sandbox.sh", AuthTokenCiphertext: "smithers_gateway_run",
			Status: "running", // DB still 'running'; Microsandbox auto-suspended the VM
		},
	}
	vm := &fakeRepoGatewayVMClient{
		getVMFn: func(_ context.Context, vmID string) (sandbox.Sandbox, error) {
			return sandbox.Sandbox{ID: vmID, State: sandbox.StateStopped}, nil
		},
	}
	svc := newTestRepoGatewayService(q, vm, WithRepoGatewaySandboxMetrics(metrics))

	_, err := svc.GetRepoGatewayConnectionInfo(context.Background(), testRepoGatewayInput())
	require.NoError(t, err)
	assert.Equal(t, []string{"vm-run"}, vm.startedVMIDs, "the auto-suspended VM must be resumed")
	assert.Equal(t, float64(0), gauge, "resuming a still-'running' row must not move the gauge")
}

// Resuming a genuinely 'suspended' row (a state that carried a prior -1) must
// re-add exactly +1 on the committed suspended->running transition.
func TestRepoGatewayService_Reuse_SuspendedVM_ReAddsGauge(t *testing.T) {
	t.Parallel()

	var gauge float64
	metrics := &mockSandboxMetricsRecorder{addActiveVMsFn: func(vmType string, delta float64) {
		if vmType == "gateway" {
			gauge += delta
		}
	}}
	q := &fakeRepoGatewayQuerier{
		active: &runtimeports.RepoGateway{
			ID: "gw-susp", RepositoryID: 200, UserID: 1, VmID: "vm-susp",
			BaseUrl: "https://vm-susp.sandbox.sh", AuthTokenCiphertext: "smithers_gateway_susp",
			Status: "suspended",
		},
	}
	vm := &fakeRepoGatewayVMClient{
		getVMFn: func(_ context.Context, vmID string) (sandbox.Sandbox, error) {
			return sandbox.Sandbox{ID: vmID, State: sandbox.StateStopped}, nil
		},
	}
	svc := newTestRepoGatewayService(q, vm, WithRepoGatewaySandboxMetrics(metrics))

	_, err := svc.GetRepoGatewayConnectionInfo(context.Background(), testRepoGatewayInput())
	require.NoError(t, err)
	assert.Equal(t, float64(1), gauge, "a suspended->running resume must re-add the +1 a prior -1 removed")
}

// Discarding a 'running' gateway whose VM already 404s must still return its +1
// (net 0 across discard+reprovision), not leak it.
func TestRepoGatewayService_Reuse_GoneVM_GaugeNetZero(t *testing.T) {
	t.Parallel()

	var gauge float64
	metrics := &mockSandboxMetricsRecorder{addActiveVMsFn: func(vmType string, delta float64) {
		if vmType == "gateway" {
			gauge += delta
		}
	}}
	q := &fakeRepoGatewayQuerier{
		active: &runtimeports.RepoGateway{
			ID: "gw-gone", RepositoryID: 200, UserID: 1, VmID: "vm-gone",
			BaseUrl: "https://vm-gone.sandbox.sh", AuthTokenCiphertext: "smithers_gateway_live",
			Status: "running",
		},
	}
	vm := &fakeRepoGatewayVMClient{
		getVMFn: func(_ context.Context, _ string) (sandbox.Sandbox, error) {
			return sandbox.Sandbox{}, &sandbox.StatusError{StatusCode: 404, Message: "no such vm"}
		},
		deleteVMFn: func(_ context.Context, _ string) error {
			return &sandbox.StatusError{StatusCode: 404, Message: "no such vm"}
		},
	}
	svc := newTestRepoGatewayService(q, vm, WithRepoGatewaySandboxMetrics(metrics))

	_, err := svc.GetRepoGatewayConnectionInfo(context.Background(), testRepoGatewayInput())
	require.NoError(t, err)
	// -1 from discarding the counted 'running' row (even though DeleteSandbox 404s),
	// +1 from the fresh provision.
	assert.Equal(t, float64(0), gauge, "discard(-1)+provision(+1) must net zero, not leak the +1")
}

func TestRepoGatewayService_Reuse_UnrecoverableToken_Reprovisions(t *testing.T) {
	t.Parallel()

	q := &fakeRepoGatewayQuerier{
		active: &runtimeports.RepoGateway{
			ID:                  "gw-corrupt",
			RepositoryID:        200,
			UserID:              1,
			VmID:                "vm-corrupt",
			BaseUrl:             "https://vm-corrupt.sandbox.sh",
			AuthTokenCiphertext: "garbage",
			Status:              "running",
		},
	}
	vm := &fakeRepoGatewayVMClient{}
	codec := &staticTestCodec{prefix: "enc:", decryptErr: errors.New("cipher: message authentication failed")}
	svc := newTestRepoGatewayService(q, vm, WithRepoGatewaySecretCodec(codec))

	info, err := svc.GetRepoGatewayConnectionInfo(context.Background(), testRepoGatewayInput())
	require.NoError(t, err)

	// The stale row is tombstoned, its VM deleted, and a fresh gateway provisioned.
	assert.Contains(t, q.getSoftDeleted(), "gw-corrupt")
	assert.Contains(t, vm.deletedVMIDs, "vm-corrupt")
	require.Len(t, vm.createVMReqs, 1)
	assert.True(t, strings.HasPrefix(info.Token, "smithers_gateway_"))
}

// A gateway whose Microsandbox VM was reclaimed out-of-band (404) must reprovision
// rather than 500 forever: before the fix, InspectSandbox's 404 propagated as an internal
// error and the active row kept 500ing every resolve until manual DB surgery.
func TestRepoGatewayService_Reuse_GoneVM_Reprovisions(t *testing.T) {
	t.Parallel()

	q := &fakeRepoGatewayQuerier{
		active: &runtimeports.RepoGateway{
			ID:                  "gw-gone",
			RepositoryID:        200,
			UserID:              1,
			VmID:                "vm-gone",
			BaseUrl:             "https://vm-gone.sandbox.sh",
			AuthTokenCiphertext: "smithers_gateway_live",
			Status:              "running",
		},
	}
	vm := &fakeRepoGatewayVMClient{
		getVMFn: func(_ context.Context, _ string) (sandbox.Sandbox, error) {
			return sandbox.Sandbox{}, &sandbox.StatusError{StatusCode: 404, Message: "no such vm"}
		},
	}
	svc := newTestRepoGatewayService(q, vm)

	info, err := svc.GetRepoGatewayConnectionInfo(context.Background(), testRepoGatewayInput())
	require.NoError(t, err, "a gone VM must reprovision, not 500 forever")

	assert.Contains(t, q.getSoftDeleted(), "gw-gone", "stale gateway row must be tombstoned")
	require.Len(t, vm.createVMReqs, 1, "a fresh gateway VM must be provisioned")
	assert.True(t, strings.HasPrefix(info.Token, "smithers_gateway_"))
}

func TestRepoGatewayService_NoSandbox_DegradesHonestly(t *testing.T) {
	t.Parallel()

	q := &fakeRepoGatewayQuerier{}
	svc := NewRepoGatewayService(q)

	_, err := svc.GetRepoGatewayConnectionInfo(context.Background(), testRepoGatewayInput())
	require.Error(t, err)
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, 409, apiErr.Status)
	assert.Contains(t, strings.ToLower(apiErr.Message), "not configured")
}

func TestRepoGatewayService_NilStore_Errors(t *testing.T) {
	t.Parallel()

	svc := NewRepoGatewayService(nil, WithRepoGatewaySandboxClient(&fakeRepoGatewayVMClient{}))
	_, err := svc.GetRepoGatewayConnectionInfo(context.Background(), testRepoGatewayInput())
	require.Error(t, err)
}

func TestRepoGatewayService_Provision_RequiresRepoIdentity(t *testing.T) {
	t.Parallel()
	q := &fakeRepoGatewayQuerier{}
	vm := &fakeRepoGatewayVMClient{}
	svc := newTestRepoGatewayService(q, vm)
	input := testRepoGatewayInput()
	input.RepoOwner = ""
	_, err := svc.GetRepoGatewayConnectionInfo(context.Background(), input)
	require.Equal(t, 400, apiStatus(t, err))
	require.Empty(t, vm.createVMReqs)
	require.Empty(t, q.created)
}

func TestRepoGatewayService_Provision_ProductHostInstallFailure_FailsProvision(t *testing.T) {
	t.Parallel()

	q := &fakeRepoGatewayQuerier{}
	one := int32(1)
	zero := int32(0)
	vm := &fakeRepoGatewayVMClient{}
	vm.execAwaitFn = func(ctx context.Context, vmID string, req sandbox.ExecRequest) (sandbox.ExecResult, error) {
		if strings.Contains(req.Command, "base64 -d") {
			return sandbox.ExecResult{StatusCode: &one, Stderr: "bun x: network unreachable"}, nil
		}
		return sandbox.ExecResult{StatusCode: &zero}, nil
	}
	svc := newTestRepoGatewayService(q, vm)

	_, err := svc.GetRepoGatewayConnectionInfo(context.Background(), testRepoGatewayInput())
	require.Error(t, err)
	assert.Contains(t, err.Error(), "install product gateway host")
	// The dead VM is reclaimed, the row marked failed, and no gateway service
	// was started on it.
	assert.Contains(t, vm.deletedVMIDs, "vm-gw-1")
	require.NotEmpty(t, q.statusUpdates)
	assert.Equal(t, "failed", q.statusUpdates[len(q.statusUpdates)-1].Status)
	assert.Empty(t, vm.systemdSpecs)
}

// fakeSandboxCounter reports a fixed active-sandbox count for the concurrency
// cap tests.
type fakeSandboxCounter struct {
	count int
	err   error
	calls int
}

func (f *fakeSandboxCounter) CountActiveSandboxesForUser(_ context.Context, _ int64) (int, error) {
	f.calls++
	return f.count, f.err
}

// Provisioning a NEW gateway while the user is already at their active-sandbox
// cap is refused with 429 — before the VM is ever created. The cap check runs
// AFTER the caller inserts its own 'pending' reservation row (which the count
// includes), so a user at the cap of 3 sees a count of 4 and is refused, and
// two provisions racing for the last slot each see the other's reservation.
func TestRepoGatewayService_Provision_OverConcurrencyCap_429(t *testing.T) {
	t.Parallel()

	q := &fakeRepoGatewayQuerier{} // no active gateway → provision path
	vm := &fakeRepoGatewayVMClient{}
	counter := &fakeSandboxCounter{count: 4} // 3 live + this provision's reservation
	svc := newTestRepoGatewayService(q, vm, WithRepoGatewayConcurrencyCap(counter, 3))

	_, err := svc.GetRepoGatewayConnectionInfo(context.Background(), testRepoGatewayInput())
	require.Error(t, err)
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, 429, apiErr.Status)
	assert.Equal(t, pkgerrors.CodeQuotaExceeded, apiErr.Code)
	assert.Empty(t, vm.createVMReqs, "no VM may be created when over the cap")
	// The reservation row was created before the check and released after it.
	require.Len(t, q.created, 1)
	assert.Equal(t, "pending", q.created[0].Status)
	require.NotEmpty(t, q.statusUpdates)
	assert.Equal(t, "failed", q.statusUpdates[len(q.statusUpdates)-1].Status,
		"a refused provision must release its pending reservation")
}

// A provision whose own reservation exactly fills the last slot must be
// allowed: the count includes the caller's pending row, so count == max means
// the user was UNDER the cap before this provision.
func TestRepoGatewayService_Provision_ReservationFillsLastSlot_Allowed(t *testing.T) {
	t.Parallel()

	q := &fakeRepoGatewayQuerier{}
	vm := &fakeRepoGatewayVMClient{}
	counter := &fakeSandboxCounter{count: 3} // 2 live + this provision's reservation
	svc := newTestRepoGatewayService(q, vm, WithRepoGatewayConcurrencyCap(counter, 3))

	info, err := svc.GetRepoGatewayConnectionInfo(context.Background(), testRepoGatewayInput())
	require.NoError(t, err)
	assert.Equal(t, "running", info.Status)
	assert.Equal(t, 1, counter.calls, "the cap must be consulted exactly once per provision")
}

// Resuming an EXISTING gateway must never be blocked by the concurrency cap,
// even when the user is over it — a resume consumes no new capacity.
func TestRepoGatewayService_Reuse_AtCap_Allowed(t *testing.T) {
	t.Parallel()

	q := &fakeRepoGatewayQuerier{
		active: &runtimeports.RepoGateway{
			ID:                  "gw-live",
			RepositoryID:        200,
			UserID:              1,
			VmID:                "vm-live",
			BaseUrl:             "https://vm-live.sandbox.sh",
			AuthTokenCiphertext: "smithers_gateway_deadbeef",
			Status:              "running",
		},
	}
	vm := &fakeRepoGatewayVMClient{}
	counter := &fakeSandboxCounter{count: 99} // way over any cap
	svc := newTestRepoGatewayService(q, vm, WithRepoGatewayConcurrencyCap(counter, 3))

	info, err := svc.GetRepoGatewayConnectionInfo(context.Background(), testRepoGatewayInput())
	require.NoError(t, err, "reuse must be allowed even over the concurrency cap")
	assert.Equal(t, "smithers_gateway_deadbeef", info.Token)
	assert.Empty(t, vm.createVMReqs, "reuse must not provision a new VM")
	assert.Zero(t, counter.calls, "the concurrency cap must not even be consulted on reuse")
}

// The reaper reclaims non-terminal rows: it deletes the backing sandbox and preview
// domain mapping for rows that have one and soft-deletes every stale row.
func TestRepoGatewayService_Reaper_ReclaimsStaleRows(t *testing.T) {
	t.Parallel()

	q := &fakeRepoGatewayQuerier{
		staleRows: []runtimeports.RepoGateway{
			{ID: "gw-starting", VmID: "vm-abandoned", Status: "starting"},
			{ID: "gw-pending", VmID: "", Status: "pending"},
		},
	}
	vm := &fakeRepoGatewayVMClient{}
	svc := newTestRepoGatewayService(q, vm)

	svc.sweepStaleGateways(context.Background())

	// The row with a VM has its VM + domain torn down; the pending row (no VM
	// yet) does not.
	assert.Equal(t, []string{"vm-abandoned"}, vm.deletedVMIDs)
	assert.Equal(t, []string{repoGatewayDomain("vm-abandoned")}, vm.unmappedDomains)
	// Both stale rows are soft-deleted.
	assert.ElementsMatch(t, []string{"gw-starting", "gw-pending"}, q.getSoftDeleted())
	// The reaper queries with the stale-provision age guard (well above the
	// worst-case provision wall-clock).
	assert.Equal(t, int64(repoGatewayStaleProvisionAge/time.Second), q.getStaleAgeSeconds())
}

// fakeRepoGatewayAccessQuerier drives the access-revocation sweep: a set of
// live gateway rows, their repositories, and per-user collaborator permissions.
type fakeRepoGatewayAccessQuerier struct {
	rows        []runtimeports.RepoGateway
	repos       map[int64]db.Repository
	collabPerms map[int64]string // userID → collaborator permission
	listErr     error
}

func (f *fakeRepoGatewayAccessQuerier) ListActiveRepoGateways(_ context.Context) ([]runtimeports.RepoGateway, error) {
	if f.listErr != nil {
		return nil, f.listErr
	}
	return f.rows, nil
}

func (f *fakeRepoGatewayAccessQuerier) GetRepoByID(_ context.Context, id int64) (db.Repository, error) {
	repo, ok := f.repos[id]
	if !ok {
		return db.Repository{}, pgx.ErrNoRows
	}
	return repo, nil
}

func (f *fakeRepoGatewayAccessQuerier) IsOrgOwnerForRepoUser(_ context.Context, _ db.IsOrgOwnerForRepoUserParams) (bool, error) {
	return false, nil
}

func (f *fakeRepoGatewayAccessQuerier) GetHighestTeamPermissionForRepoUser(_ context.Context, _ db.GetHighestTeamPermissionForRepoUserParams) (string, error) {
	return "", nil
}

func (f *fakeRepoGatewayAccessQuerier) GetCollaboratorPermissionForRepoUser(_ context.Context, arg db.GetCollaboratorPermissionForRepoUserParams) (string, error) {
	return f.collabPerms[arg.UserID.Int64], nil
}

// The access-revocation sweep tears down (VM + domain + row + slot) exactly
// the gateways whose user no longer has write access to the repository — a
// revoked writer must not keep a working VM-local operator token — while
// leaving still-authorized users' gateways untouched.
func TestRepoGatewayService_RevocationSweep_TearsDownRevokedGateways(t *testing.T) {
	t.Parallel()

	repo := db.Repository{
		ID:     200,
		UserID: pgtype.Int8{Int64: 99, Valid: true}, // owned by neither gateway user
	}
	q := &fakeRepoGatewayQuerier{}
	vm := &fakeRepoGatewayVMClient{}
	access := &fakeRepoGatewayAccessQuerier{
		rows: []runtimeports.RepoGateway{
			{ID: "gw-ok", RepositoryID: 200, UserID: 1, VmID: "vm-ok", Status: "running"},
			{ID: "gw-revoked", RepositoryID: 200, UserID: 2, VmID: "vm-revoked", Status: "running"},
			{ID: "gw-repo-gone", RepositoryID: 999, UserID: 3, VmID: "vm-repo-gone", Status: "suspended"},
		},
		repos:       map[int64]db.Repository{200: repo},
		collabPerms: map[int64]string{1: "write", 2: "read"},
	}
	svc := newTestRepoGatewayService(q, vm, WithRepoGatewayAccessRevocation(access))

	svc.sweepRevokedGateways(context.Background())

	// The downgraded collaborator and the gateway on a deleted repository are
	// torn down: ingress unmapped, VM deleted, row tombstoned.
	assert.ElementsMatch(t, []string{"vm-revoked", "vm-repo-gone"}, vm.deletedVMIDs)
	assert.ElementsMatch(t,
		[]string{repoGatewayDomain("vm-revoked"), repoGatewayDomain("vm-repo-gone")},
		vm.unmappedDomains)
	assert.ElementsMatch(t, []string{"gw-revoked", "gw-repo-gone"}, q.getSoftDeleted())
}

// A permission-resolution failure must keep the gateway (retry next sweep),
// and a service without the access querier wired must be a no-op.
func TestRepoGatewayService_RevocationSweep_KeepsGatewaysOnUncertainty(t *testing.T) {
	t.Parallel()

	q := &fakeRepoGatewayQuerier{}
	vm := &fakeRepoGatewayVMClient{}
	access := &fakeRepoGatewayAccessQuerier{listErr: errors.New("db down")}
	svc := newTestRepoGatewayService(q, vm, WithRepoGatewayAccessRevocation(access))
	svc.sweepRevokedGateways(context.Background())
	assert.Empty(t, vm.deletedVMIDs)
	assert.Empty(t, q.getSoftDeleted())

	// Not wired → no-op.
	newTestRepoGatewayService(q, vm).sweepRevokedGateways(context.Background())
	assert.Empty(t, vm.deletedVMIDs)
}

// staticTestCodec is a deterministic SecretCodec for tests.
type staticTestCodec struct {
	prefix     string
	decryptErr error
}

func (c *staticTestCodec) EncryptString(plaintext string) (string, error) {
	return c.prefix + plaintext, nil
}

func (c *staticTestCodec) DecryptString(ciphertext string) (string, error) {
	if c.decryptErr != nil {
		return "", c.decryptErr
	}
	return strings.TrimPrefix(ciphertext, c.prefix), nil
}
