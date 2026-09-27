package flowhost

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/flowruntime"
)

type memoryBindingStore struct {
	mu            sync.Mutex
	binding       Binding
	credential    string
	acquires      int
	rebinds       int
	lastErrorCode string
	busy          bool
}

func (store *memoryBindingStore) Acquire(_ context.Context, authority Authority, catalog Catalog) (BindingLease, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	store.acquires++
	if store.binding.ID == "" {
		if authority.SourceRevision == "" {
			return nil, ErrSourceRevisionRequired
		}
		store.binding = Binding{
			ID:       "11111111-1111-4111-8111-111111111111",
			TenantID: authority.Target.TenantID, PrincipalID: authority.Target.PrincipalID,
			BindingKind: authority.Target.BindingKind, BindingID: authority.Target.BindingID,
			RepositoryID: authority.RepositoryID, UserID: authority.UserID, WorkspaceID: authority.WorkspaceID,
			CatalogKey: catalog.Key, ServiceName: catalog.ServiceName,
			RuntimeArtifactDigest: catalog.ArtifactDigest, SourceRevision: authority.SourceRevision,
			OwnerGeneration: 1, State: "pending",
		}
		store.credential = "server-held-bearer"
	}
	if err := authorityMatches(store.binding, authority, catalog); err != nil {
		return nil, err
	}
	lease := &memoryBindingLease{store: store, binding: store.binding}
	if target, drifted := identityDrift(store.binding, authority, catalog); drifted {
		old := store.binding
		lease.supersedes, lease.target = &old, target
	}
	return lease, nil
}

type memoryBindingLease struct {
	store      *memoryBindingStore
	binding    Binding
	supersedes *Binding
	target     Binding
}

func (store *memoryBindingStore) AcquireExisting(ctx context.Context, authority Authority, catalog Catalog) (BindingLease, error) {
	if store.busy {
		return nil, ErrHostBusy
	}
	if store.binding.ID == "" {
		return nil, ErrHostNotRunning
	}
	return store.Acquire(ctx, authority, catalog)
}

// A read during another caller's host start is a retryable "starting".
func TestReadDuringAHostStartIsStarting(t *testing.T) {
	resolver, store, launcher, target := testResolver(t)
	store.busy = true
	_, err := resolver.ResolveExistingFlowRuntime(context.Background(), target)
	var known flowruntime.Failure
	require.ErrorAs(t, err, &known)
	require.Equal(t, "runtime_host_starting", known.FlowRuntimeCode())
	require.True(t, known.FlowRuntimeRetryable())
	require.Empty(t, launcher.starts)
}

func TestReadResolutionNeverCreatesRestartsOrUpgradesHost(t *testing.T) {
	ctx := context.Background()
	resolver, store, launcher, target := testResolver(t)
	_, err := resolver.ResolveExistingFlowRuntime(ctx, target)
	require.ErrorContains(t, err, "runtime_host_not_running")
	require.Empty(t, store.binding.ID)
	require.Empty(t, launcher.starts)
	require.Equal(t, 0, store.acquires)

	_, err = resolver.ResolveFlowRuntime(ctx, target)
	require.NoError(t, err)
	before := store.binding
	runtime, err := resolver.ResolveExistingFlowRuntime(ctx, target)
	require.NoError(t, err)
	identity, err := runtime.Identity(ctx)
	require.NoError(t, err)
	require.Equal(t, before.OwnerGeneration, identity.OwnerGeneration)
	require.Equal(t, before, store.binding)
	require.Len(t, launcher.starts, 1)

	launcher.running = false
	_, err = resolver.ResolveExistingFlowRuntime(ctx, target)
	require.ErrorContains(t, err, "runtime_host_not_running")
	require.Equal(t, before, store.binding)
	require.Len(t, launcher.starts, 1)

	upgradeCatalog(resolver, strings.Repeat("c", 64))
	_, err = resolver.ResolveExistingFlowRuntime(ctx, target)
	require.ErrorContains(t, err, "runtime_upgrade_required")
	require.Equal(t, before, store.binding)
	require.Equal(t, 0, store.rebinds)
	require.Empty(t, launcher.stops)
	require.Len(t, launcher.starts, 1)
}

func (lease *memoryBindingLease) Supersedes() (Binding, bool) {
	if lease.supersedes == nil {
		return Binding{}, false
	}
	return *lease.supersedes, true
}

func (lease *memoryBindingLease) Rebind(context.Context) (Binding, error) {
	lease.store.mu.Lock()
	defer lease.store.mu.Unlock()
	if lease.supersedes == nil {
		return lease.binding, nil
	}
	if lease.store.binding.OwnerGeneration != lease.binding.OwnerGeneration {
		return Binding{}, errors.New("flow host rebind lost its owner fence")
	}
	lease.target.OwnerGeneration = lease.binding.OwnerGeneration + 1
	lease.target.State = "pending"
	lease.binding, lease.supersedes = lease.target, nil
	lease.store.binding = lease.binding
	lease.store.rebinds++
	return lease.binding, nil
}

func (lease *memoryBindingLease) Binding() Binding   { return lease.binding }
func (lease *memoryBindingLease) Credential() string { return lease.store.credential }
func (lease *memoryBindingLease) PrepareStart(_ context.Context, replace bool) (Binding, error) {
	lease.store.mu.Lock()
	defer lease.store.mu.Unlock()
	if replace {
		lease.binding.OwnerGeneration++
	}
	lease.binding.State = "starting"
	lease.store.binding = lease.binding
	return lease.binding, nil
}
func (lease *memoryBindingLease) MarkRunning(context.Context) error {
	lease.store.mu.Lock()
	defer lease.store.mu.Unlock()
	lease.binding.State = "running"
	lease.store.binding = lease.binding
	return nil
}
func (lease *memoryBindingLease) MarkFailed(_ context.Context, code string) error {
	lease.store.mu.Lock()
	defer lease.store.mu.Unlock()
	lease.binding.State = "failed"
	lease.store.binding = lease.binding
	lease.store.lastErrorCode = code
	return nil
}
func (*memoryBindingLease) Close() error { return nil }

type identityTransport struct {
	mu         sync.Mutex
	identity   flowruntime.Identity
	credential string
	requests   int
}

func (transport *identityTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	transport.mu.Lock()
	defer transport.mu.Unlock()
	transport.requests++
	if request.Header.Get("Authorization") != "Bearer "+transport.credential {
		return &http.Response{StatusCode: http.StatusUnauthorized, Status: "401 Unauthorized", Header: make(http.Header),
			Body: io.NopCloser(strings.NewReader(`{"error":"unauthorized"}`)), Request: request}, nil
	}
	body := `{"runtimeBridge":{"protocol":"` + transport.identity.Protocol + `","runtimeArtifactDigest":"` +
		transport.identity.RuntimeArtifactDigest + `","sourceRevision":"` + transport.identity.SourceRevision +
		`","ownerGeneration":` + intString(transport.identity.OwnerGeneration) + `}}`
	return &http.Response{StatusCode: http.StatusOK, Status: "200 OK", Header: make(http.Header),
		Body: io.NopCloser(strings.NewReader(body)), Request: request}, nil
}

func intString(value int64) string { return strconv.FormatInt(value, 10) }

type memoryLauncher struct {
	mu        sync.Mutex
	startErr  error
	running   bool
	binding   Binding
	transport *identityTransport
	starts    []HostLaunch
	stopErr   error
	stops     []Binding
	calls     []string
}

func (launcher *memoryLauncher) StopFlowHost(_ context.Context, binding Binding) error {
	launcher.mu.Lock()
	defer launcher.mu.Unlock()
	launcher.calls = append(launcher.calls, "stop")
	launcher.stops = append(launcher.stops, binding)
	if launcher.stopErr != nil {
		return launcher.stopErr
	}
	if launcher.binding.ServiceName == binding.ServiceName {
		launcher.running = false
	}
	return nil
}

func (launcher *memoryLauncher) connection(binding Binding, credential string) Connection {
	launcher.transport.identity = flowruntime.Identity{Protocol: flowruntime.Protocol,
		RuntimeArtifactDigest: binding.RuntimeArtifactDigest, SourceRevision: binding.SourceRevision,
		OwnerGeneration: binding.OwnerGeneration}
	launcher.transport.credential = credential
	return Connection{Endpoint: "http://127.0.0.1:7331", HTTPClient: &http.Client{Transport: launcher.transport}}
}

func (launcher *memoryLauncher) InspectFlowHost(_ context.Context, _ HostLaunch) (Connection, error) {
	launcher.mu.Lock()
	defer launcher.mu.Unlock()
	launcher.calls = append(launcher.calls, "inspect")
	if !launcher.running {
		return Connection{}, ErrHostNotRunning
	}
	return launcher.connection(launcher.binding, launcher.transport.credential), nil
}

func (launcher *memoryLauncher) StartFlowHost(_ context.Context, request HostLaunch) (Connection, error) {
	launcher.mu.Lock()
	defer launcher.mu.Unlock()
	launcher.calls = append(launcher.calls, "start")
	launcher.starts = append(launcher.starts, request)
	if launcher.startErr != nil {
		return Connection{}, launcher.startErr
	}
	launcher.running = true
	launcher.binding = request.Binding
	return launcher.connection(request.Binding, request.Credential), nil
}

func testResolver(t *testing.T) (*Resolver, *memoryBindingStore, *memoryLauncher, flowruntime.Target) {
	t.Helper()
	target := flowruntime.Target{TenantID: "repository:5", PrincipalID: "user:9", BindingKind: "agent-session", BindingID: "session-1"}
	authority := Authority{Target: target, RepositoryID: 5, UserID: 9,
		WorkspaceID: "22222222-2222-4222-8222-222222222222", CatalogKey: CatalogCoding, SourceRevision: strings.Repeat("b", 40)}
	store := &memoryBindingStore{}
	launcher := &memoryLauncher{transport: &identityTransport{}}
	resolver, err := New(Config{
		Store: store, Launcher: launcher,
		Targets: TargetResolverFunc(func(context.Context, flowruntime.Target) (Authority, error) { return authority, nil }),
		Catalogs: []Catalog{{Key: CatalogCoding, Family: CatalogCoding, Executable: "/opt/smithers/coding-host",
			ArtifactDigest: strings.Repeat("a", 64),
			ServiceName:    "smithers-flow-coding", ImplementationModel: "openai:gpt-5"}},
	})
	require.NoError(t, err)
	return resolver, store, launcher, target
}

func TestResolverStartsOnceAuthenticatesAndReusesDurableBinding(t *testing.T) {
	resolver, store, launcher, target := testResolver(t)
	runtime, err := resolver.ResolveFlowRuntime(context.Background(), target)
	require.NoError(t, err)
	identity, err := runtime.Identity(context.Background())
	require.NoError(t, err)
	assert.Equal(t, int64(1), identity.OwnerGeneration)

	second, err := resolver.ResolveFlowRuntime(context.Background(), target)
	require.NoError(t, err)
	secondIdentity, err := second.Identity(context.Background())
	require.NoError(t, err)
	assert.Equal(t, identity, secondIdentity)
	require.Len(t, launcher.starts, 1)
	assert.Equal(t, "server-held-bearer", launcher.starts[0].Credential)
	assert.Equal(t, "running", store.binding.State)
	assert.Equal(t, 2, store.acquires)
	assert.GreaterOrEqual(t, launcher.transport.requests, 4)
}

func TestResolverFencesReplacementOwnerButKeepsBearerAndArtifact(t *testing.T) {
	resolver, store, launcher, target := testResolver(t)
	_, err := resolver.ResolveFlowRuntime(context.Background(), target)
	require.NoError(t, err)
	launcher.mu.Lock()
	launcher.running = false
	launcher.mu.Unlock()

	runtime, err := resolver.ResolveFlowRuntime(context.Background(), target)
	require.NoError(t, err)
	identity, err := runtime.Identity(context.Background())
	require.NoError(t, err)
	assert.Equal(t, int64(2), identity.OwnerGeneration)
	require.Len(t, launcher.starts, 2)
	assert.Equal(t, launcher.starts[0].Credential, launcher.starts[1].Credential)
	assert.Equal(t, launcher.starts[0].Catalog.ArtifactDigest, launcher.starts[1].Catalog.ArtifactDigest)
	assert.Equal(t, int64(2), store.binding.OwnerGeneration)
}

func TestResolverRefusesLiveHostWithDifferentIdentityWithoutStartingCompetitor(t *testing.T) {
	resolver, store, launcher, target := testResolver(t)
	store.binding = Binding{ID: "11111111-1111-4111-8111-111111111111",
		TenantID: target.TenantID, PrincipalID: target.PrincipalID, BindingKind: target.BindingKind, BindingID: target.BindingID,
		RepositoryID: 5, UserID: 9, WorkspaceID: "22222222-2222-4222-8222-222222222222", CatalogKey: CatalogCoding,
		ServiceName: "smithers-flow-coding", RuntimeArtifactDigest: strings.Repeat("a", 64), SourceRevision: strings.Repeat("b", 40),
		OwnerGeneration: 1, State: "running"}
	store.credential = "server-held-bearer"
	launcher.running = true
	launcher.binding = store.binding
	launcher.binding.RuntimeArtifactDigest = strings.Repeat("c", 64)
	launcher.transport.credential = store.credential

	_, err := resolver.ResolveFlowRuntime(context.Background(), target)
	require.Error(t, err)
	var bridgeFailure flowruntime.Failure
	require.ErrorAs(t, err, &bridgeFailure)
	assert.Equal(t, "runtime_identity_conflict", bridgeFailure.FlowRuntimeCode())
	assert.False(t, bridgeFailure.FlowRuntimeRetryable())
	assert.Empty(t, launcher.starts)
}

func TestResolverRefusesTargetResolverScopeSubstitution(t *testing.T) {
	resolver, _, launcher, target := testResolver(t)
	resolver.targets = TargetResolverFunc(func(_ context.Context, _ flowruntime.Target) (Authority, error) {
		changed := target
		changed.PrincipalID = "user:10"
		return Authority{Target: changed, RepositoryID: 5, UserID: 10,
			WorkspaceID: "22222222-2222-4222-8222-222222222222", CatalogKey: CatalogCoding, SourceRevision: strings.Repeat("b", 40)}, nil
	})
	_, err := resolver.ResolveFlowRuntime(context.Background(), target)
	require.Error(t, err)
	assert.Empty(t, launcher.starts)
}

func TestCatalogRejectsReservedIdentityEnvironment(t *testing.T) {
	_, err := validateCatalog(Catalog{Key: CatalogCoding, Family: CatalogCoding, Executable: "/host",
		ArtifactDigest: strings.Repeat("a", 64),
		ServiceName:    "host", ImplementationModel: "openai:gpt-5",
		Environment: map[string]string{"SMITHERS_API_KEY": "caller-value"}})
	require.Error(t, err)
}

type snapshotLauncher struct {
	*memoryLauncher
	revision string
	captures int
}

func (launcher *snapshotLauncher) ResolveFlowHostSource(context.Context, Authority) (string, error) {
	launcher.captures++
	return launcher.revision, nil
}

func TestResolverCapturesSourceOnlyForNewBindingAndReauthorizesEveryTarget(t *testing.T) {
	resolver, store, launcher, target := testResolver(t)
	captures := &snapshotLauncher{memoryLauncher: launcher, revision: strings.Repeat("d", 40)}
	resolver.launcher = captures
	original := resolver.targets
	authorized := true
	requests := 0
	resolver.targets = TargetResolverFunc(func(ctx context.Context, target flowruntime.Target) (Authority, error) {
		requests++
		if !authorized {
			return Authority{}, failure{code: "runtime_target_forbidden"}
		}
		authority, err := original.ResolveFlowHostTarget(ctx, target)
		authority.SourceRevision = ""
		authority.Target = target
		return authority, err
	})
	_, err := resolver.ResolveFlowRuntime(context.Background(), target)
	require.NoError(t, err)
	require.Equal(t, 1, captures.captures)
	require.Equal(t, captures.revision, store.binding.SourceRevision)
	captures.revision = strings.Repeat("e", 40)
	target.BindingID = "second-authorized-session"
	_, err = resolver.ResolveFlowRuntime(context.Background(), target)
	require.NoError(t, err)
	require.Equal(t, 1, captures.captures)
	require.Equal(t, strings.Repeat("d", 40), store.binding.SourceRevision)
	require.Len(t, launcher.starts, 1)
	authorized = false
	_, err = resolver.ResolveFlowRuntime(context.Background(), target)
	require.Error(t, err)
	require.Equal(t, 3, requests)
	require.Equal(t, 3, store.acquires) // first attempt asks for source; forbidden request never acquires.
}

func TestResolverRecordsFailedStartAndFencesTheNextOwner(t *testing.T) {
	resolver, store, launcher, target := testResolver(t)
	launcher.startErr = errors.New("exec: coding-host: permission denied")
	_, err := resolver.ResolveFlowRuntime(context.Background(), target)
	var bridgeFailure flowruntime.Failure
	require.ErrorAs(t, err, &bridgeFailure)
	assert.Equal(t, "runtime_start_failed", bridgeFailure.FlowRuntimeCode())
	assert.Equal(t, "failed", store.binding.State)
	assert.Equal(t, "runtime_start_failed", store.lastErrorCode)
	assert.Equal(t, int64(1), store.binding.OwnerGeneration)

	launcher.startErr = nil
	runtime, err := resolver.ResolveFlowRuntime(context.Background(), target)
	require.NoError(t, err)
	identity, err := runtime.Identity(context.Background())
	require.NoError(t, err)
	assert.Equal(t, int64(2), identity.OwnerGeneration, "a start after a failure must fence a new owner")
	assert.Equal(t, "running", store.binding.State)
}

func upgradeCatalog(resolver *Resolver, digest string) {
	catalog := resolver.catalogs[CatalogCoding]
	catalog.ArtifactDigest = digest
	resolver.catalogs[CatalogCoding] = catalog
}

func TestResolverRebindsDurableBindingAfterHostBundleUpgrade(t *testing.T) {
	resolver, store, launcher, target := testResolver(t)
	_, err := resolver.ResolveFlowRuntime(context.Background(), target)
	require.NoError(t, err)
	old := store.binding
	launcher.calls = nil

	upgradeCatalog(resolver, strings.Repeat("c", 64))
	runtime, err := resolver.ResolveFlowRuntime(context.Background(), target)
	require.NoError(t, err)
	identity, err := runtime.Identity(context.Background())
	require.NoError(t, err)

	assert.Equal(t, []string{"stop", "inspect", "start"}, launcher.calls, "the superseded host must stop before the new owner starts")
	require.Len(t, launcher.stops, 1)
	assert.Equal(t, old, launcher.stops[0])
	require.Len(t, launcher.starts, 2)
	assert.Equal(t, strings.Repeat("c", 64), launcher.starts[1].Binding.RuntimeArtifactDigest)
	assert.Equal(t, int64(2), launcher.starts[1].Binding.OwnerGeneration)
	assert.Equal(t, launcher.starts[0].Credential, launcher.starts[1].Credential)
	assert.Equal(t, old.ID, launcher.starts[1].Binding.ID)
	assert.Equal(t, strings.Repeat("c", 64), identity.RuntimeArtifactDigest)
	assert.Equal(t, int64(2), identity.OwnerGeneration)
	assert.Equal(t, "running", store.binding.State)
	assert.Equal(t, 1, store.rebinds)

	launcher.calls = nil
	_, err = resolver.ResolveFlowRuntime(context.Background(), target)
	require.NoError(t, err)
	assert.Equal(t, []string{"inspect"}, launcher.calls, "a rebound binding reconnects without another replacement")
}

func TestResolverRebindsRepositoryJobOnNewSourceRevision(t *testing.T) {
	resolver, store, launcher, target := testResolver(t)
	_, err := resolver.ResolveFlowRuntime(context.Background(), target)
	require.NoError(t, err)
	original := resolver.targets
	resolver.targets = TargetResolverFunc(func(ctx context.Context, target flowruntime.Target) (Authority, error) {
		authority, err := original.ResolveFlowHostTarget(ctx, target)
		authority.SourceRevision = strings.Repeat("e", 40)
		return authority, err
	})
	runtime, err := resolver.ResolveFlowRuntime(context.Background(), target)
	require.NoError(t, err)
	identity, err := runtime.Identity(context.Background())
	require.NoError(t, err)
	assert.Equal(t, strings.Repeat("e", 40), identity.SourceRevision)
	assert.Equal(t, strings.Repeat("e", 40), store.binding.SourceRevision)
	assert.Equal(t, strings.Repeat("a", 64), store.binding.RuntimeArtifactDigest)
	require.Len(t, launcher.stops, 1)
	assert.Equal(t, strings.Repeat("b", 40), launcher.stops[0].SourceRevision)
}

func TestResolverUpgradeStopFailureIsRetryableAndStartsNothing(t *testing.T) {
	resolver, store, launcher, target := testResolver(t)
	_, err := resolver.ResolveFlowRuntime(context.Background(), target)
	require.NoError(t, err)
	old := store.binding
	launcher.stopErr = errors.New("workspace runtime unavailable")
	upgradeCatalog(resolver, strings.Repeat("c", 64))

	_, err = resolver.ResolveFlowRuntime(context.Background(), target)
	var bridgeFailure flowruntime.Failure
	require.ErrorAs(t, err, &bridgeFailure)
	assert.Equal(t, "runtime_upgrade_stop_failed", bridgeFailure.FlowRuntimeCode())
	assert.True(t, bridgeFailure.FlowRuntimeRetryable())
	require.Len(t, launcher.stops, 1, "the stop control must have been consulted")
	require.Len(t, launcher.starts, 1, "no new owner may start while the old one may be live")
	assert.Equal(t, old, store.binding, "the durable row keeps the old owner until the stop succeeds")
	assert.Equal(t, 0, store.rebinds)

	launcher.stopErr = nil
	runtime, err := resolver.ResolveFlowRuntime(context.Background(), target)
	require.NoError(t, err)
	identity, err := runtime.Identity(context.Background())
	require.NoError(t, err)
	assert.Equal(t, strings.Repeat("c", 64), identity.RuntimeArtifactDigest)
}

func TestResolverUpgradeWithoutStopperIsTerminal(t *testing.T) {
	resolver, store, launcher, target := testResolver(t)
	_, err := resolver.ResolveFlowRuntime(context.Background(), target)
	require.NoError(t, err)
	resolver.launcher = struct{ Launcher }{launcher}
	upgradeCatalog(resolver, strings.Repeat("c", 64))

	_, err = resolver.ResolveFlowRuntime(context.Background(), target)
	var bridgeFailure flowruntime.Failure
	require.ErrorAs(t, err, &bridgeFailure)
	assert.Equal(t, "runtime_upgrade_unsupported", bridgeFailure.FlowRuntimeCode())
	assert.False(t, bridgeFailure.FlowRuntimeRetryable())
	assert.Empty(t, launcher.stops)
	require.Len(t, launcher.starts, 1)
	assert.Equal(t, strings.Repeat("a", 64), store.binding.RuntimeArtifactDigest)
}

func TestResolverStillRefusesAuthorityMismatchOnDurableBinding(t *testing.T) {
	resolver, store, launcher, target := testResolver(t)
	_, err := resolver.ResolveFlowRuntime(context.Background(), target)
	require.NoError(t, err)
	store.binding.UserID = 10 // the workspace row now belongs to another user
	upgradeCatalog(resolver, strings.Repeat("c", 64))
	_, err = resolver.ResolveFlowRuntime(context.Background(), target)
	require.Error(t, err)
	assert.Empty(t, launcher.stops, "an authority conflict must never stop or rebind the host")
	require.Len(t, launcher.starts, 1)
}
