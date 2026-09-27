package services

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/smithersai/smithers/packages/backend/runtimeports"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
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
	getVMFn                func(ctx context.Context, vmID string) (sandbox.Sandbox, error)
	deleteVMFn             func(ctx context.Context, vmID string) error
	createSystemdServiceFn func(ctx context.Context, vmID string, req sandbox.ServiceSpec) (sandbox.CreateServiceResult, error)
	execAwaitFn            func(ctx context.Context, vmID string, req sandbox.ExecRequest) (sandbox.ExecResult, error)

	createDomainMappingFn func(ctx context.Context, domain string, req sandbox.PublishIngressRequest) (sandbox.IngressRoute, error)

	systemdSpecs      []sandbox.ServiceSpec
	execAwaitReqs     []sandbox.ExecRequest
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

func (f *fakeRepoGatewayVMClient) InspectSandbox(ctx context.Context, vmID string) (sandbox.Sandbox, error) {
	f.getVMRequestedIDs = append(f.getVMRequestedIDs, vmID)
	if f.getVMFn != nil {
		return f.getVMFn(ctx, vmID)
	}
	return sandbox.Sandbox{ID: vmID, State: sandbox.StateRunning}, nil
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
		WithRepoGatewayGitBaseURL("https://jjhub.example"),
	}
	return NewRepoGatewayService(q, append(base, opts...)...)
}

// testRepoGatewayInput names a box by a canonical UUID; the degradation tests
// below answer before any box is loaded.
func testRepoGatewayInput() RepoGatewayConnectionInput {
	return RepoGatewayConnectionInput{
		RepositoryID: 200,
		UserID:       1,
		WorkspaceID:  "0f8fad5b-d9cb-469f-a165-70867728950e",
	}
}

// fastRepoGatewaySleep keeps probe-retry tests off wall-clock time.
func fastRepoGatewaySleep(svc *RepoGatewayService) {
	svc.sleep = func(context.Context, time.Duration) error { return nil }
}

// refusingGatewayStore and refusingGatewayVMClient panic on any call: a nil
// embedded interface has no methods to dispatch to.
type refusingGatewayStore struct{ RepoGatewayQuerier }
type refusingGatewayVMClient struct{ RepoGatewayVMClient }

// Every gateway is a box's coding host (#2194): a request that names no box is
// refused before the store or the sandbox provider is touched.
func TestRepoGatewayService_RequiresWorkspace(t *testing.T) {
	t.Parallel()

	svc := NewRepoGatewayService(refusingGatewayStore{}, WithRepoGatewaySandboxClient(refusingGatewayVMClient{}))
	input := testRepoGatewayInput()
	input.WorkspaceID = ""
	_, err := svc.GetRepoGatewayConnectionInfo(context.Background(), input)
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, 400, apiErr.Status)
	assert.Contains(t, apiErr.Message, "workspace_id is required")
}

func TestRepoGatewayService_NoSandbox_DegradesHonestly(t *testing.T) {
	t.Parallel()

	svc := NewRepoGatewayService(refusingGatewayStore{})

	_, err := svc.GetRepoGatewayConnectionInfo(context.Background(), testRepoGatewayInput())
	require.Error(t, err)
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, 409, apiErr.Status)
	assert.Contains(t, strings.ToLower(apiErr.Message), "not configured")
}

func TestRepoGatewayService_NilStore_Errors(t *testing.T) {
	t.Parallel()

	svc := NewRepoGatewayService(nil, WithRepoGatewaySandboxClient(refusingGatewayVMClient{}))
	_, err := svc.GetRepoGatewayConnectionInfo(context.Background(), testRepoGatewayInput())
	assert.Equal(t, 500, apiStatus(t, err))
}

// The reaper reclaims non-terminal rows of both kinds through discardGateway: a
// retired repository-level row loses its VM and ingress, while a box's row
// loses only its service and ingress — never the box's VM.
func TestRepoGatewayService_Reaper_ReclaimsStaleRows(t *testing.T) {
	t.Parallel()

	svc, q, vm, w := boundGatewayFixture(t)
	bound := boundGatewayRow(q, w, "starting")
	q.staleRows = []runtimeports.RepoGateway{
		{ID: "gw-starting", VmID: "vm-abandoned", Status: "starting"},
		{ID: "gw-pending", VmID: "", Status: "pending"},
		*bound,
	}
	svc.sweepStaleGateways(context.Background())

	assert.Equal(t, []string{"vm-abandoned"}, vm.deletedVMIDs, "only the retired gateway's own VM is deleted")
	assert.ElementsMatch(t, []string{repoGatewayDomain("vm-abandoned"), repoGatewayDomain(bound.ID)}, vm.unmappedDomains)
	require.Len(t, vm.execAwaitReqs, 1)
	assert.Contains(t, vm.execAwaitReqs[0].Command, workspaceGatewayServiceName(*bound))
	assert.ElementsMatch(t, []string{"gw-starting", "gw-pending", bound.ID}, q.getSoftDeleted())
	assert.Equal(t, int64(repoGatewayStaleProvisionAge/time.Second), q.getStaleAgeSeconds())
}

// A retired repository-level row (no owning box) is discarded on sight; a box's
// row is kept or discarded on its own evidence, and a box VM is never deleted.
func TestRepoGatewayService_SweepWidowed(t *testing.T) {
	t.Parallel()

	svc, q, vm, _ := boundGatewayFixture(t)
	now := time.Now()
	workspaces := map[string]db.Workspace{}
	bind := func(id, vmID string, idle time.Duration) runtimeports.RepoGateway {
		w := db.Workspace{ID: uuid.NewString(), RepositoryID: 101, UserID: 1, VmID: vmID, Status: "running"}
		workspaces[w.ID] = w
		return runtimeports.RepoGateway{
			ID: id, RepositoryID: w.RepositoryID, UserID: w.UserID, VmID: vmID, Status: "running",
			WorkspaceID:    pgtype.UUID{Bytes: uuid.MustParse(w.ID), Valid: true},
			LastActivityAt: now.Add(-idle),
		}
	}
	rows := []runtimeports.RepoGateway{
		{ID: "gw-retired", RepositoryID: 101, UserID: 1, VmID: "vm-product", Status: "running", LastActivityAt: now},
		bind("gw-healthy", "vm-healthy", 48*time.Hour),
		bind("gw-gone", "vm-gone", time.Hour),
		bind("gw-stale-gen", "vm-stale-gen", time.Hour),
		bind("gw-stale-stopped", "vm-stale", 48*time.Hour),
		bind("gw-fresh-stopped", "vm-fresh", time.Hour),
		bind("gw-blip", "vm-blip", 48*time.Hour),
		bind("gw-vm-replaced", "vm-replaced", time.Hour),
		bind("gw-box-deleted", "vm-box-deleted", time.Hour),
	}
	replaced := workspaces[rows[7].WorkspaceID.String()]
	replaced.VmID = "vm-replacement"
	workspaces[replaced.ID] = replaced
	delete(workspaces, rows[8].WorkspaceID.String())
	svc.workspaces.q = &mockWorkspaceQuerier{getWorkspaceByRepoFn: func(_ context.Context, p db.GetWorkspaceByRepoParams) (db.Workspace, error) {
		w, ok := workspaces[p.ID]
		if !ok || w.RepositoryID != p.RepositoryID {
			return db.Workspace{}, pgx.ErrNoRows
		}
		return w, nil
	}}
	q.activeRows = rows
	vm.getVMFn = func(_ context.Context, vmID string) (sandbox.Sandbox, error) {
		switch vmID {
		case "vm-gone":
			return sandbox.Sandbox{}, &sandbox.StatusError{StatusCode: 404, Message: "sandbox not found"}
		case "vm-stale-gen":
			return sandbox.Sandbox{}, &sandbox.StatusError{StatusCode: 409, Code: "stale_generation", Message: "placement changed"}
		case "vm-stale", "vm-fresh":
			return sandbox.Sandbox{ID: vmID, State: sandbox.StateStopped}, nil
		case "vm-healthy":
			return sandbox.Sandbox{ID: vmID, State: sandbox.StateRunning}, nil
		default:
			return sandbox.Sandbox{}, errors.New("provider transport blip")
		}
	}
	svc.sweepWidowedGateways(context.Background())

	assert.ElementsMatch(t, []string{"gw-retired", "gw-gone", "gw-stale-gen", "gw-stale-stopped", "gw-vm-replaced", "gw-box-deleted"}, q.getSoftDeleted(),
		"kept: a healthy box, a recently idle box, and a provider blip")
	assert.Equal(t, []string{"vm-product"}, vm.deletedVMIDs, "only the retired gateway's own VM is deleted")
	assert.Contains(t, vm.unmappedDomains, repoGatewayDomain("vm-product"))
	assert.Contains(t, vm.unmappedDomains, repoGatewayDomain("gw-gone"))
	assert.NotContains(t, vm.getVMRequestedIDs, "vm-product", "a retired row needs no provider evidence")
}

func TestRepoGatewayService_StartReaper(t *testing.T) {
	NewRepoGatewayService(nil).StartReaper(context.Background())
	NewRepoGatewayService(&fakeRepoGatewayQuerier{}).StartReaper(context.Background())

	old := repoGatewayReaperIntervalDuration
	repoGatewayReaperIntervalDuration = time.Millisecond
	t.Cleanup(func() { repoGatewayReaperIntervalDuration = old })
	q := &fakeRepoGatewayQuerier{}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		newTestRepoGatewayService(q, &fakeRepoGatewayVMClient{}).StartReaper(ctx)
		close(done)
	}()
	require.Eventually(t, func() bool { return q.getStaleAgeSeconds() > 0 }, time.Second, time.Millisecond)
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("StartReaper did not return after context cancellation")
	}
}

type failingGatewayListStore struct{ *fakeRepoGatewayQuerier }

func (failingGatewayListStore) ListStaleRepoGateways(context.Context, int64) ([]runtimeports.RepoGateway, error) {
	return nil, errors.New("list failed")
}

func (failingGatewayListStore) ListActiveRepoGateways(context.Context) ([]runtimeports.RepoGateway, error) {
	return nil, errors.New("list failed")
}

func TestRepoGatewayService_SweepListErrorsAreNonFatal(t *testing.T) {
	q := failingGatewayListStore{&fakeRepoGatewayQuerier{}}
	vm := &fakeRepoGatewayVMClient{}
	svc := newTestRepoGatewayService(q, vm)
	svc.sweepStaleGateways(context.Background())
	svc.sweepWidowedGateways(context.Background())
	assert.Empty(t, q.getSoftDeleted())
	assert.Empty(t, vm.deletedVMIDs)
}

func TestRepoGatewayTokenAndActiveUniqueViolation(t *testing.T) {
	token, hash, err := generateRepoGatewayToken()
	require.NoError(t, err)
	assert.True(t, strings.HasPrefix(token, repoGatewayTokenPrefix))
	sum := sha256.Sum256([]byte(token))
	assert.Equal(t, hex.EncodeToString(sum[:]), hash)

	assert.False(t, isRepoGatewayActiveUniqueViolation(nil))
	assert.True(t, isRepoGatewayActiveUniqueViolation(&pgconn.PgError{Code: "23505", ConstraintName: "uq_repo_gateways_active"}))
	assert.False(t, isRepoGatewayActiveUniqueViolation(&pgconn.PgError{Code: "23505", ConstraintName: "other_unique"}))
	assert.True(t, isRepoGatewayActiveUniqueViolation(errors.New("duplicate key violates uq_repo_gateways_active")))
	assert.False(t, isRepoGatewayActiveUniqueViolation(pgx.ErrNoRows))
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

// boxlessRelayStore serves one retired, box-less gateway row to the relay.
type boxlessRelayStore struct {
	*fakeRepoGatewayQuerier
	row runtimeports.RepoGateway
}

func (s boxlessRelayStore) GetRepoGatewayByID(context.Context, string) (runtimeports.RepoGateway, error) {
	return s.row, nil
}

// A retired product gateway still holding a valid token relays nothing
// (#2194): every relayed gateway belongs to a box.
func TestRepoGatewayService_AuthorizeRelayRefusesBoxlessGateway(t *testing.T) {
	t.Parallel()

	token := "smithers_gateway_retired"
	sum := sha256.Sum256([]byte(token))
	q := &fakeRepoGatewayQuerier{}
	store := boxlessRelayStore{fakeRepoGatewayQuerier: q, row: runtimeports.RepoGateway{
		ID: "gw-retired", VmID: "vm-retired", Status: "running", AuthTokenHash: hex.EncodeToString(sum[:]),
	}}
	svc := NewRepoGatewayService(store, WithRepoGatewaySandboxClient(&fakeRepoGatewayVMClient{}))
	_, err := svc.AuthorizeRelay(context.Background(), "gw-retired", token)
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, 409, apiErr.Status)
	assert.Empty(t, q.touched, "a refused relay must not keep the retired row active")
}
