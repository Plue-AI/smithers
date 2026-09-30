package services

import (
	"context"
	stdErrors "errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/sandbox"
)

// egressPolicyStore is an in-memory RepositoryEgressPolicyQuerier.
type egressPolicyStore struct {
	rows     map[int64]db.RepositoryEgressPolicy
	live     []string
	getErr   error
	writeErr error
	listErr  error
}

func (s *egressPolicyStore) GetRepositoryEgressPolicy(_ context.Context, repositoryID int64) (db.RepositoryEgressPolicy, error) {
	if s.getErr != nil {
		return db.RepositoryEgressPolicy{}, s.getErr
	}
	row, ok := s.rows[repositoryID]
	if !ok {
		return db.RepositoryEgressPolicy{}, pgx.ErrNoRows
	}
	return row, nil
}

func (s *egressPolicyStore) UpsertRepositoryEgressPolicy(_ context.Context, arg db.UpsertRepositoryEgressPolicyParams) (db.RepositoryEgressPolicy, error) {
	if s.writeErr != nil {
		return db.RepositoryEgressPolicy{}, s.writeErr
	}
	row := db.RepositoryEgressPolicy{RepositoryID: arg.RepositoryID, AllowDomains: arg.AllowDomains, UpdatedBy: arg.UpdatedBy, UpdatedAt: time.Unix(1_800_000_000, 0).UTC()}
	s.rows[arg.RepositoryID] = row
	return row, nil
}

func (s *egressPolicyStore) ListRepositoryLiveSandboxIDs(context.Context, int64) ([]string, error) {
	return s.live, s.listErr
}

// egressReloaderFake answers each sandbox's reload from failures, recording calls.
type egressReloaderFake struct {
	mu       sync.Mutex
	calls    map[string][]string
	failures map[string]error
}

func (f *egressReloaderFake) ReloadEgress(ctx context.Context, sandboxID string, req sandbox.EgressReloadRequest) (sandbox.EgressReloadResult, error) {
	if _, ok := ctx.Deadline(); !ok {
		return sandbox.EgressReloadResult{}, fmt.Errorf("reload of %s is unbounded", sandboxID)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls[sandboxID] = req.AllowDomains
	if err := f.failures[sandboxID]; err != nil {
		return sandbox.EgressReloadResult{}, err
	}
	return sandbox.EgressReloadResult{SandboxID: sandboxID, AllowDomains: req.AllowDomains}, nil
}

func TestNormalizeEgressAllowDomains(t *testing.T) {
	t.Parallel()
	normalized, err := NormalizeEgressAllowDomains([]string{" Registry.Example.COM. ", "*.pkg.dev", "registry.example.com", "a.io"})
	require.NoError(t, err)
	assert.Equal(t, []string{"*.pkg.dev", "a.io", "registry.example.com"}, normalized)

	empty, err := NormalizeEgressAllowDomains(nil)
	require.NoError(t, err)
	assert.NotNil(t, empty, "an empty list is stored and sent as [], never null")
	assert.Empty(t, empty)

	refused := map[string]string{
		"*":                 "every host",
		"10.0.0.1":          "IP address",
		"::1":               "IP address",
		"10.0.0.0/8":        "not a host name",
		"https://x.example": "not a host name",
		"":                  "not a host name",
		"localhost":         "not a host name",
		"a.*.example":       "not a host name",
		"x.example/path":    "not a host name",
	}
	for domain, reason := range refused {
		_, err := NormalizeEgressAllowDomains([]string{"ok.example", domain})
		var apiErr *pkgerrors.APIError
		require.True(t, stdErrors.As(err, &apiErr), "%q: %v", domain, err)
		assert.Equal(t, pkgerrors.CodeBadRequest, apiErr.Code, domain)
		assert.Contains(t, apiErr.Message, reason, domain)
	}

	atLimit := make([]string, 0, maxRepositoryEgressDomains+1)
	for i := 0; i < maxRepositoryEgressDomains; i++ {
		atLimit = append(atLimit, fmt.Sprintf("h%d.example", i))
	}
	_, err = NormalizeEgressAllowDomains(append(atLimit, "h0.example"))
	require.NoError(t, err, "a duplicate does not count against the limit")
	_, err = NormalizeEgressAllowDomains(append(atLimit, "one-more.example"))
	require.ErrorContains(t, err, "too many egress domains")
}

func TestRepositoryEgressPolicyServiceReadsAnUnsetPolicyAsEmpty(t *testing.T) {
	t.Parallel()
	service := NewRepositoryEgressPolicyService(&egressPolicyStore{rows: map[int64]db.RepositoryEgressPolicy{}}, nil)
	policy, err := service.Get(context.Background(), 7)
	require.NoError(t, err)
	assert.Equal(t, RepositoryEgressPolicy{AllowDomains: []string{}}, policy)
	domains, err := service.AllowDomains(context.Background(), 7)
	require.NoError(t, err)
	assert.Nil(t, domains, "an unset policy leaves the provider's deployment list")
}

func TestRepositoryEgressPolicyServicePutReloadsEveryRunningSandbox(t *testing.T) {
	t.Parallel()
	store := &egressPolicyStore{rows: map[int64]db.RepositoryEgressPolicy{}, live: []string{"vm-a", "vm-b", "vm-c"}}
	reloader := &egressReloaderFake{calls: map[string][]string{}, failures: map[string]error{"vm-b": stdErrors.New("sandbox vm-b is stopped")}}
	service := NewRepositoryEgressPolicyService(store, reloader)

	update, err := service.Put(context.Background(), &db.User{ID: 3}, 7, []string{"B.example", "a.example"})
	require.NoError(t, err)
	assert.Equal(t, []string{"a.example", "b.example"}, update.AllowDomains)
	require.NotNil(t, update.UpdatedAt)
	assert.Equal(t, []RepositoryEgressReload{
		{SandboxID: "vm-a", Reloaded: true},
		{SandboxID: "vm-b", Error: "sandbox vm-b is stopped"},
		{SandboxID: "vm-c", Reloaded: true},
	}, update.Reloads, "a failed reload is reported for its sandbox, not the write")
	for _, id := range store.live {
		assert.Equal(t, []string{"a.example", "b.example"}, reloader.calls[id], id)
	}
	assert.Equal(t, int64(3), store.rows[7].UpdatedBy.Int64)

	domains, err := service.AllowDomains(context.Background(), 7)
	require.NoError(t, err)
	assert.Equal(t, []string{"a.example", "b.example"}, domains)

	// Clearing the list resets running proxies to the deployment list: the
	// reload carries [], and new sandboxes get no list at all.
	update, err = service.Put(context.Background(), nil, 7, []string{})
	require.NoError(t, err)
	assert.Equal(t, []string{}, update.AllowDomains)
	assert.Equal(t, []string{}, reloader.calls["vm-a"])
	assert.False(t, store.rows[7].UpdatedBy.Valid)
	domains, err = service.AllowDomains(context.Background(), 7)
	require.NoError(t, err)
	assert.Nil(t, domains)
}

func TestRepositoryEgressPolicyServiceWithoutLiveReloadWritesAndSaysSo(t *testing.T) {
	t.Parallel()
	store := &egressPolicyStore{rows: map[int64]db.RepositoryEgressPolicy{}, live: []string{"vm-a"}}
	service := NewRepositoryEgressPolicyService(store, nil)
	update, err := service.Put(context.Background(), &db.User{ID: 3}, 7, []string{"a.example"})
	require.NoError(t, err)
	assert.Equal(t, []RepositoryEgressReload{{SandboxID: "vm-a", Error: errEgressReloadUnsupported}}, update.Reloads)
	assert.Equal(t, []string{"a.example"}, store.rows[7].AllowDomains)

	update, err = NewRepositoryEgressPolicyService(&egressPolicyStore{rows: map[int64]db.RepositoryEgressPolicy{}}, nil).
		Put(context.Background(), &db.User{ID: 3}, 7, []string{"a.example"})
	require.NoError(t, err)
	assert.NotNil(t, update.Reloads, "no running sandbox is [], never null")
	assert.Empty(t, update.Reloads)
}

func TestRepositoryEgressPolicyServiceFailures(t *testing.T) {
	t.Parallel()
	boom := stdErrors.New("database down")
	ctx := context.Background()
	internal := func(t *testing.T, err error, message string) {
		t.Helper()
		var apiErr *pkgerrors.APIError
		require.True(t, stdErrors.As(err, &apiErr), "%v", err)
		assert.Equal(t, pkgerrors.CodeInternal, apiErr.Code)
		assert.True(t, strings.Contains(apiErr.Message, message), apiErr.Message)
	}

	_, err := NewRepositoryEgressPolicyService(&egressPolicyStore{getErr: boom}, nil).Get(ctx, 7)
	internal(t, err, "read the repository egress policy")
	_, err = NewRepositoryEgressPolicyService(&egressPolicyStore{getErr: boom}, nil).AllowDomains(ctx, 7)
	require.ErrorIs(t, err, boom, "a sandbox is refused rather than created without its owner's list")

	store := &egressPolicyStore{rows: map[int64]db.RepositoryEgressPolicy{}, writeErr: boom}
	_, err = NewRepositoryEgressPolicyService(store, nil).Put(ctx, nil, 7, []string{"a.example"})
	internal(t, err, "write the repository egress policy")

	store = &egressPolicyStore{rows: map[int64]db.RepositoryEgressPolicy{}, listErr: boom}
	_, err = NewRepositoryEgressPolicyService(store, nil).Put(ctx, nil, 7, []string{"a.example"})
	internal(t, err, "list the repository's running sandboxes")

	reloader := &egressReloaderFake{calls: map[string][]string{}}
	store = &egressPolicyStore{rows: map[int64]db.RepositoryEgressPolicy{}, live: []string{"vm-a"}}
	_, err = NewRepositoryEgressPolicyService(store, reloader).Put(ctx, nil, 7, []string{"*"})
	require.Error(t, err)
	assert.Empty(t, store.rows, "a refused list is never stored")
	assert.Empty(t, reloader.calls, "a refused list reaches no sandbox")
}

// workspaceEgressProxy renders the repository's list into every workspace
// VM it creates, forks or resumes, and refuses the VM when it cannot read it.
func TestWorkspaceEgressProxyCarriesTheRepositoryAllowlist(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	store := &egressPolicyStore{rows: map[int64]db.RepositoryEgressPolicy{7: {RepositoryID: 7, AllowDomains: []string{"a.example"}}}}
	service := NewWorkspaceService(&mockWorkspaceQuerier{}, WithWorkspaceEgressAllowDomains(NewRepositoryEgressPolicyService(store, nil)))

	policy, err := service.workspaceEgressProxy(ctx, 7, "")
	require.NoError(t, err)
	assert.Equal(t, []string{"a.example"}, policy.AllowDomains)

	policy, err = service.workspaceEgressProxy(ctx, 8, "")
	require.NoError(t, err)
	assert.Nil(t, policy.AllowDomains, "a repository with no list leaves the provider default")

	policy, err = service.workspaceEgressProxy(ctx, 0, "")
	require.NoError(t, err)
	assert.Nil(t, policy.AllowDomains, "the golden bake belongs to no repository")

	store.getErr = stdErrors.New("database down")
	_, err = service.workspaceEgressProxy(ctx, 7, "")
	require.ErrorContains(t, err, "read the repository egress policy")
}

// An agent sandbox is created with its repository's allowlist, and a policy
// that cannot be read refuses the sandbox instead of creating it without.
func TestAgentDispatchSendsTheRepositoryAllowlist(t *testing.T) {
	t.Parallel()
	var created sandbox.CreateRequest
	client := &mockSandboxVMClient{createVMFn: func(_ context.Context, req sandbox.CreateRequest) (sandbox.CreateResult, error) {
		created = req
		return sandbox.CreateResult{ID: "vm-listed"}, nil
	}}
	store := &egressPolicyStore{rows: map[int64]db.RepositoryEgressPolicy{42: {RepositoryID: 42, AllowDomains: []string{"registry.example.com"}}}}
	dispatch := newEgressDispatch(t, client)
	dispatch.svc.sandboxConfig.ModelSeats = nil
	dispatch.svc.egressAllowDomains = NewRepositoryEgressPolicyService(store, nil)
	require.NoError(t, dispatch.buildServiceSpec())
	require.NoError(t, dispatch.injectSecrets())
	require.NoError(t, dispatch.createVM())
	require.NotNil(t, created.EgressProxy)
	assert.Equal(t, []string{"registry.example.com"}, created.EgressProxy.AllowDomains)

	created = sandbox.CreateRequest{}
	store.getErr = stdErrors.New("database down")
	failing := newEgressDispatch(t, client)
	failing.svc.sandboxConfig.ModelSeats = nil
	failing.svc.egressAllowDomains = NewRepositoryEgressPolicyService(store, nil)
	require.NoError(t, failing.buildServiceSpec())
	require.NoError(t, failing.injectSecrets())
	require.Error(t, failing.createVM())
	assert.Nil(t, created.EgressProxy, "no sandbox was created without its owner's list")
}
