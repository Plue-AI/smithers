package flowhost

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/flowruntime"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
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
func (lease *memoryBindingLease) MarkRunning(_ context.Context, serviceIdentity string) error {
	lease.store.mu.Lock()
	defer lease.store.mu.Unlock()
	lease.binding.State = "running"
	lease.binding.ServiceIdentity = serviceIdentity
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
	isolation workspaceapi.IsolationLevel
	mu        sync.Mutex
	startErr  error
	running   bool
	binding   Binding
	transport *identityTransport
	starts    []HostLaunch
	stopErr   error
	stops     []Binding
	calls     []string
	// fingerprint is the live service's configuration identity, as a
	// workspace runtime records it at start and compares on inspect.
	fingerprint string
}

func (launcher *memoryLauncher) Isolation() workspaceapi.IsolationLevel { return launcher.isolation }

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

func (launcher *memoryLauncher) InspectFlowHost(_ context.Context, request HostLaunch) (Connection, error) {
	launcher.mu.Lock()
	defer launcher.mu.Unlock()
	launcher.calls = append(launcher.calls, "inspect")
	if !launcher.running {
		return Connection{}, ErrHostNotRunning
	}
	want := hostServiceIdentity(request)
	if request.Superseded {
		want = request.Binding.ServiceIdentity
	}
	if launcher.fingerprint != "" && launcher.fingerprint != want {
		return Connection{}, fmt.Errorf("%w: live service configuration differs", ErrHostIdentityConflict)
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
	launcher.fingerprint = hostServiceIdentity(request)
	return launcher.connection(request.Binding, request.Credential), nil
}

func testResolver(t *testing.T) (*Resolver, *memoryBindingStore, *memoryLauncher, flowruntime.Target) {
	t.Helper()
	target := flowruntime.Target{TenantID: "repository:5", PrincipalID: "user:9", BindingKind: "agent-session", BindingID: "session-1"}
	authority := Authority{Target: target, RepositoryID: 5, UserID: 9,
		WorkspaceID: "22222222-2222-4222-8222-222222222222", CatalogKey: CatalogCoding, SourceRevision: strings.Repeat("b", 40)}
	store := &memoryBindingStore{}
	launcher := &memoryLauncher{transport: &identityTransport{}, isolation: workspaceapi.IsolationSandboxed}
	resolver, err := New(Config{
		Store: store, Launcher: launcher,
		Targets: TargetResolverFunc(func(context.Context, flowruntime.Target) (Authority, error) { return authority, nil }),
		Catalogs: []Catalog{{Key: CatalogCoding, Family: CatalogCoding, Executable: "/opt/smithers/coding-host",
			SystemFlows:    []string{"merge", "stack.propose", "flow-load", "repository/setup"},
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
	var classified interface{ FlowRuntimeClass() string }
	require.ErrorAs(t, err, &classified)
	require.Empty(t, classified.FlowRuntimeClass(), "scope refusals must not invent an infra class")
}

func TestCatalogRejectsReservedIdentityEnvironment(t *testing.T) {
	_, err := validateCatalog(Catalog{Key: CatalogCoding, Family: CatalogCoding, Executable: "/host",
		SystemFlows:    []string{"merge"},
		ArtifactDigest: strings.Repeat("a", 64),
		ServiceName:    "host", ImplementationModel: "openai:gpt-5",
		Environment: map[string]string{"SMITHERS_API_KEY": "caller-value"}})
	require.ErrorContains(t, err, "reserved identity SMITHERS_API_KEY")
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

type launcherRefusal struct{ reason string }

func (refusal *launcherRefusal) Error() string { return refusal.reason }

// A launcher's typed refusal (a box whose helper could not be refreshed,
// #3111) stays in the failed start's chain, so the caller can answer it
// instead of a generic host outage.
func TestResolverKeepsTheLauncherRefusalOfAFailedStart(t *testing.T) {
	resolver, store, launcher, target := testResolver(t)
	refusal := &launcherRefusal{reason: "workspace helper could not be refreshed; retry"}
	launcher.startErr = refusal
	_, err := resolver.ResolveFlowRuntime(context.Background(), target)
	var bridgeFailure flowruntime.Failure
	require.ErrorAs(t, err, &bridgeFailure)
	assert.Equal(t, "runtime_start_failed", bridgeFailure.FlowRuntimeCode())
	assert.NotContains(t, err.Error(), refusal.reason, "the bridge failure never prints the cause")
	var kept *launcherRefusal
	require.ErrorAs(t, err, &kept)
	assert.Same(t, refusal, kept)
	assert.Equal(t, "failed", store.binding.State)
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
	resolver.launcher = struct {
		Launcher
		IsolationLauncher
	}{launcher, launcher}
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

// abandoningLauncher answers a start with a host of another generation.
type abandoningLauncher struct {
	*memoryLauncher
	abandoned []Binding
}

func (launcher *abandoningLauncher) StartFlowHost(ctx context.Context, request HostLaunch) (Connection, error) {
	connection, err := launcher.memoryLauncher.StartFlowHost(ctx, request)
	launcher.transport.identity.OwnerGeneration++
	return connection, err
}

func (launcher *abandoningLauncher) AbandonFlowHostStart(_ context.Context, binding Binding) {
	launcher.abandoned = append(launcher.abandoned, binding)
}

// A start the resolver refuses after launch releases the start's credentials.
func TestResolverAbandonsAStartItRefuses(t *testing.T) {
	resolver, _, memory, target := testResolver(t)
	launcher := &abandoningLauncher{memoryLauncher: memory}
	resolver.launcher = launcher
	_, err := resolver.ResolveFlowRuntime(context.Background(), target)
	require.ErrorContains(t, err, "runtime_identity_conflict")
	require.Len(t, launcher.abandoned, 1)
}

// memoryRuns is durable work pinned to a host identity; state is "accepted",
// "parked" (waiting on approval), or "completed".
type memoryRuns struct {
	mu      sync.Mutex
	runs    map[string]memoryRun
	queries int
	err     error
}

type memoryRun struct{ digest, source, state string }

func (runs *memoryRuns) set(id string, host Binding, state string) {
	runs.mu.Lock()
	defer runs.mu.Unlock()
	if runs.runs == nil {
		runs.runs = map[string]memoryRun{}
	}
	runs.runs[id] = memoryRun{digest: host.RuntimeArtifactDigest, source: host.SourceRevision, state: state}
}

func (runs *memoryRuns) ActiveFlowRuns(_ context.Context, host Binding) (bool, error) {
	runs.mu.Lock()
	defer runs.mu.Unlock()
	runs.queries++
	if runs.err != nil {
		return false, runs.err
	}
	for _, run := range runs.runs {
		if run.state != "completed" && run.digest == host.RuntimeArtifactDigest && run.source == host.SourceRevision {
			return true, nil
		}
	}
	return false, nil
}

func resolvedIdentity(t *testing.T, resolve func(context.Context, flowruntime.Target) (flowruntime.Runtime, error), target flowruntime.Target) flowruntime.Identity {
	t.Helper()
	runtime, err := resolve(context.Background(), target)
	require.NoError(t, err)
	identity, err := runtime.Identity(context.Background())
	require.NoError(t, err)
	return identity
}

// A host-bundle upgrade must not stop the host an accepted run or an
// approval-parked plan depends on (plue#538). Resolves keep serving that
// owner until the work settles; the next resolve then rebinds with a new
// owner generation.
func TestResolverDefersHostBundleUpgradeWhileRunIsActive(t *testing.T) {
	for _, state := range []string{"accepted", "parked"} {
		t.Run(state, func(t *testing.T) {
			resolver, store, launcher, target := testResolver(t)
			runs := &memoryRuns{}
			resolver.activeRuns = runs
			digestA, digestB := strings.Repeat("a", 64), strings.Repeat("c", 64)

			first := resolvedIdentity(t, resolver.ResolveFlowRuntime, target)
			require.Equal(t, digestA, first.RuntimeArtifactDigest)
			old := store.binding
			runs.set("run-1", old, state)

			upgradeCatalog(resolver, digestB)
			for range 2 { // the run's own poll and any other resolve of the workspace
				identity := resolvedIdentity(t, resolver.ResolveFlowRuntime, target)
				require.Equal(t, first, identity, "an active run keeps its host")
			}
			require.Equal(t, first, resolvedIdentity(t, resolver.ResolveExistingFlowRuntime, target),
				"a read sees the live host, not an upgrade to start")
			require.Empty(t, launcher.stops, "a host with an active run must not stop")
			require.Len(t, launcher.starts, 1)
			require.Equal(t, 0, store.rebinds)
			require.Equal(t, old, store.binding)

			if state == "parked" {
				runs.set("run-1", old, "accepted") // approved on A
				require.Equal(t, first, resolvedIdentity(t, resolver.ResolveFlowRuntime, target))
				require.Empty(t, launcher.stops)
			}
			runs.set("run-1", old, "completed")

			upgraded := resolvedIdentity(t, resolver.ResolveFlowRuntime, target)
			require.Equal(t, digestB, upgraded.RuntimeArtifactDigest)
			require.Equal(t, old.OwnerGeneration+1, upgraded.OwnerGeneration)
			require.Equal(t, []Binding{old}, launcher.stops)
			require.Len(t, launcher.starts, 2)
			require.Equal(t, 1, store.rebinds)
		})
	}
}

// A new source revision cannot be served by a host pinned to the old one, so
// while a run holds that host the new work waits, retryably.
func TestResolverRefusesNewSourceRetryablyWhileRunIsActive(t *testing.T) {
	resolver, store, launcher, target := testResolver(t)
	runs := &memoryRuns{}
	resolver.activeRuns = runs
	resolvedIdentity(t, resolver.ResolveFlowRuntime, target)
	old := store.binding
	runs.set("run-1", old, "accepted")
	original := resolver.targets
	resolver.targets = TargetResolverFunc(func(ctx context.Context, target flowruntime.Target) (Authority, error) {
		authority, err := original.ResolveFlowHostTarget(ctx, target)
		authority.SourceRevision = strings.Repeat("e", 40)
		return authority, err
	})

	_, err := resolver.ResolveFlowRuntime(context.Background(), target)
	var bridgeFailure flowruntime.Failure
	require.ErrorAs(t, err, &bridgeFailure)
	require.Equal(t, "runtime_upgrade_pending", bridgeFailure.FlowRuntimeCode())
	require.True(t, bridgeFailure.FlowRuntimeRetryable())
	require.Empty(t, launcher.stops)
	require.Equal(t, old, store.binding)

	runs.set("run-1", old, "completed")
	identity := resolvedIdentity(t, resolver.ResolveFlowRuntime, target)
	require.Equal(t, strings.Repeat("e", 40), identity.SourceRevision)
	require.Len(t, launcher.stops, 1)
}

// Deferral keeps a live host; a host already gone cannot be kept, so the
// upgrade proceeds (lost-host recovery is smithers#1868).
func TestResolverUpgradesAGoneHostEvenWithAnActiveRun(t *testing.T) {
	resolver, store, launcher, target := testResolver(t)
	runs := &memoryRuns{}
	resolver.activeRuns = runs
	resolvedIdentity(t, resolver.ResolveFlowRuntime, target)
	runs.set("run-1", store.binding, "accepted")
	launcher.running = false
	upgradeCatalog(resolver, strings.Repeat("c", 64))

	identity := resolvedIdentity(t, resolver.ResolveFlowRuntime, target)
	require.Equal(t, strings.Repeat("c", 64), identity.RuntimeArtifactDigest)
	require.Equal(t, int64(2), identity.OwnerGeneration)
	require.Equal(t, 1, store.rebinds)
}

// A host the resolver cannot reach under any recorded identity (started
// before identities were recorded, or recorded by an older replica) cannot be
// kept; waiting would wedge its run, so the upgrade proceeds as before.
func TestResolverUpgradesAnUnreachableHostEvenWithAnActiveRun(t *testing.T) {
	for _, recorded := range []string{"", "flow-host:stale"} {
		t.Run(map[string]string{"": "unrecorded", "flow-host:stale": "stale"}[recorded], func(t *testing.T) {
			resolver, store, launcher, target := testResolver(t)
			runs := &memoryRuns{}
			resolver.activeRuns = runs
			resolvedIdentity(t, resolver.ResolveFlowRuntime, target)
			store.binding.ServiceIdentity = recorded
			old := store.binding
			runs.set("run-1", old, "accepted")
			upgradeCatalog(resolver, strings.Repeat("c", 64))

			identity := resolvedIdentity(t, resolver.ResolveFlowRuntime, target)
			require.Equal(t, strings.Repeat("c", 64), identity.RuntimeArtifactDigest)
			require.Equal(t, []Binding{old}, launcher.stops)
		})
	}
}

// An unanswerable activity check never stops a host.
func TestResolverActiveRunCheckFailureIsRetryableAndStopsNothing(t *testing.T) {
	resolver, store, launcher, target := testResolver(t)
	runs := &memoryRuns{err: errors.New("jobs table unavailable")}
	resolver.activeRuns = runs
	resolvedIdentity(t, resolver.ResolveFlowRuntime, target)
	old := store.binding
	upgradeCatalog(resolver, strings.Repeat("c", 64))

	_, err := resolver.ResolveFlowRuntime(context.Background(), target)
	var bridgeFailure flowruntime.Failure
	require.ErrorAs(t, err, &bridgeFailure)
	require.True(t, bridgeFailure.FlowRuntimeRetryable())
	require.Empty(t, launcher.stops)
	require.Equal(t, old, store.binding)
}

type recordingJournals struct {
	journals            *PostgresJournals
	described, provided []string
	describeErr, err    error
}

func (j *recordingJournals) Describe(workspaceID string) (JournalDatabase, error) {
	j.described = append(j.described, workspaceID)
	if j.describeErr != nil {
		return JournalDatabase{}, j.describeErr
	}
	return j.journals.Describe(workspaceID)
}

func (j *recordingJournals) Provision(_ context.Context, workspaceID string) (JournalDatabase, error) {
	j.provided = append(j.provided, workspaceID)
	if j.err != nil {
		return JournalDatabase{}, j.err
	}
	return j.journals.Describe(workspaceID)
}

// With PostgreSQL journals, the resolver provisions the workspace's database
// before each start and names it on every inspection, so the identity it
// records is the live host's and the host is reused (#2099).
func TestResolverGivesEachHostItsWorkspaceJournal(t *testing.T) {
	ctx := context.Background()
	resolver, store, launcher, target := testResolver(t)
	journals := &recordingJournals{journals: &PostgresJournals{address: mustURL(t, "postgres://journal.internal:5432/"), key: journalTestKey}}
	resolver.journals = journals
	workspace := "22222222-2222-4222-8222-222222222222"

	// An unprovisionable journal fails the start before the host starts.
	journals.err = errors.New("journal server unavailable at postgres://admin:secret@db")
	_, err := resolver.ResolveFlowRuntime(ctx, target)
	var known flowruntime.Failure
	require.ErrorAs(t, err, &known)
	require.Equal(t, "runtime_journal_unavailable", known.FlowRuntimeCode())
	require.NotContains(t, err.Error(), "secret")
	require.Empty(t, launcher.starts)
	require.Equal(t, "failed", store.binding.State)

	journals.err = nil
	_, err = resolver.ResolveFlowRuntime(ctx, target)
	require.NoError(t, err)
	require.Len(t, launcher.starts, 1)
	require.Equal(t, []string{workspace, workspace}, journals.provided)
	expected, err := journals.journals.Describe(workspace)
	require.NoError(t, err)
	require.Equal(t, expected, launcher.starts[0].Journal)
	require.Equal(t, launcher.fingerprint, store.binding.ServiceIdentity, "the recorded identity is the live host's")

	_, err = resolver.ResolveFlowRuntime(ctx, target)
	require.NoError(t, err)
	require.Len(t, launcher.starts, 1, "the live host is reused")

	// A host that cannot name its journal is refused, never restarted on SQLite.
	journals.describeErr = errors.New("invalid workspace")
	_, err = resolver.ResolveFlowRuntime(ctx, target)
	require.ErrorAs(t, err, &known)
	require.Equal(t, "runtime_journal_unavailable", known.FlowRuntimeCode())
	require.Len(t, launcher.starts, 1)

	// A host started before journals moved is not reused.
	journals.describeErr = nil
	resolver.journals = nil
	_, err = resolver.ResolveFlowRuntime(ctx, target)
	require.Error(t, err)
	require.Len(t, launcher.starts, 1)
}

// Refusal precedes source capture, journals, lease acquisition, inspection and
// recovery. A retained row or active run never authorizes a host process.
func TestResolverRequiresIsolationBeforeAnyHostWork(t *testing.T) {
	for _, mode := range []string{"new", "existing", "recovery", "superseded"} {
		t.Run(mode, func(t *testing.T) {
			resolver, store, launcher, target := testResolver(t)
			if mode == "recovery" || mode == "superseded" {
				resolvedIdentity(t, resolver.ResolveFlowRuntime, target)
				if mode == "recovery" {
					launcher.running = false
				}
				if mode == "superseded" {
					runs := &memoryRuns{}
					runs.set("active", store.binding, "accepted")
					resolver.activeRuns = runs
					upgradeCatalog(resolver, strings.Repeat("c", 64))
				}
			}
			captures := &snapshotLauncher{memoryLauncher: launcher, revision: strings.Repeat("d", 40)}
			resolver.launcher = captures
			original := resolver.targets
			resolver.targets = TargetResolverFunc(func(ctx context.Context, target flowruntime.Target) (Authority, error) {
				authority, err := original.ResolveFlowHostTarget(ctx, target)
				authority.SourceRevision = ""
				return authority, err
			})
			journals := &recordingJournals{journals: &PostgresJournals{address: mustURL(t, "postgres://journal.internal:5432/"), key: journalTestKey}}
			resolver.journals = journals
			before, acquires, starts, requests := store.binding, store.acquires, len(launcher.starts), launcher.transport.requests
			launcher.calls = nil
			launcher.isolation = workspaceapi.IsolationTrustedProcess
			resolve := resolver.ResolveFlowRuntime
			if mode == "existing" {
				resolve = resolver.ResolveExistingFlowRuntime
			}
			runtime, err := resolve(context.Background(), target)
			require.Nil(t, runtime)
			requireIsolationRequired(t, err)
			require.Equal(t, before, store.binding)
			require.Equal(t, acquires, store.acquires)
			require.Len(t, launcher.starts, starts)
			require.Empty(t, launcher.calls)
			require.Zero(t, captures.captures)
			require.Equal(t, requests, launcher.transport.requests)
			require.Empty(t, journals.described)
			require.Empty(t, journals.provided)
		})
	}
}

func requireIsolationRequired(t *testing.T, err error) {
	t.Helper()
	var known flowruntime.Failure
	require.ErrorAs(t, err, &known)
	require.Equal(t, "isolation_required", known.FlowRuntimeCode())
	require.False(t, known.FlowRuntimeRetryable())
	var classified interface{ FlowRuntimeClass() string }
	require.ErrorAs(t, err, &classified)
	require.Equal(t, "infra", classified.FlowRuntimeClass())
}

func TestResolverFailsClosedForUnreportedIsolation(t *testing.T) {
	for _, level := range []workspaceapi.IsolationLevel{"", "unknown"} {
		t.Run(string(level), func(t *testing.T) {
			resolver, store, launcher, target := testResolver(t)
			launcher.isolation = level
			_, err := resolver.ResolveFlowRuntime(context.Background(), target)
			requireIsolationRequired(t, err)
			require.Zero(t, store.acquires)
			require.Empty(t, launcher.calls)
		})
	}
	resolver, store, launcher, target := testResolver(t)
	resolver.launcher = unreportedLauncher{launcher}
	_, err := resolver.ResolveFlowRuntime(context.Background(), target)
	requireIsolationRequired(t, err)
	require.Zero(t, store.acquires)
	require.Empty(t, launcher.calls)
}

type unreportedLauncher struct{ delegate Launcher }

func (l unreportedLauncher) InspectFlowHost(ctx context.Context, launch HostLaunch) (Connection, error) {
	return l.delegate.InspectFlowHost(ctx, launch)
}
func (l unreportedLauncher) StartFlowHost(ctx context.Context, launch HostLaunch) (Connection, error) {
	return l.delegate.StartFlowHost(ctx, launch)
}

func TestResolverTrustedProcessRequiresExplicitTestConfiguration(t *testing.T) {
	resolver, store, launcher, target := testResolver(t)
	authority, err := resolver.targets.ResolveFlowHostTarget(context.Background(), target)
	require.NoError(t, err)
	launcher.isolation = workspaceapi.IsolationTrustedProcess
	optedIn, err := New(Config{Store: store, Targets: resolver.targets, Launcher: launcher,
		Catalogs: []Catalog{resolver.catalogs[authority.CatalogKey]}, AllowTrustedProcessForTests: true})
	require.NoError(t, err)
	require.NotEmpty(t, resolvedIdentity(t, optedIn.ResolveFlowRuntime, target).Protocol)
	require.Len(t, launcher.starts, 1)
	launcher.isolation = "unknown"
	_, err = optedIn.ResolveFlowRuntime(context.Background(), target)
	requireIsolationRequired(t, err)
	require.Len(t, launcher.starts, 1)
}

func TestCatalogCopiesAndValidatesSystemFlowNames(t *testing.T) {
	resolver, _, _, _ := testResolver(t)
	catalog := resolver.catalogs[CatalogCoding]
	catalog.SystemFlows = []string{"merge", "stack.propose", "repository/setup"}
	validated, err := validateCatalog(catalog)
	require.NoError(t, err)
	catalog.SystemFlows[0] = "changed"
	require.Equal(t, []string{"merge", "stack.propose", "repository/setup"}, validated.SystemFlows)
	for _, names := range [][]string{{""}, {" merge"}, {"merge", "merge"}, {"../merge"}, {"merge//x"}, {strings.Repeat("x", 257)}} {
		catalog.SystemFlows = names
		_, err := validateCatalog(catalog)
		require.Error(t, err, "%q", names)
	}
	catalog.SystemFlows = []string{"merge"}
	catalog.Environment = map[string]string{SystemFlowsEnv: "[]"}
	_, err = validateCatalog(catalog)
	require.ErrorContains(t, err, "reserved identity")
}

func TestResolverRejectsMissingSystemFlowsBeforeLaunch(t *testing.T) {
	for _, names := range [][]string{nil, {}} {
		t.Run(fmt.Sprintf("nil=%t", names == nil), func(t *testing.T) {
			resolver, store, launcher, _ := testResolver(t)
			catalog := resolver.catalogs[CatalogCoding]
			catalog.SystemFlows = names
			targetCalls := 0
			created, err := New(Config{Store: store, Launcher: launcher, Catalogs: []Catalog{catalog},
				Targets: TargetResolverFunc(func(context.Context, flowruntime.Target) (Authority, error) {
					targetCalls++
					return Authority{}, nil
				})})
			require.Nil(t, created)
			var known flowruntime.Failure
			require.ErrorAs(t, err, &known)
			require.Equal(t, "runtime_catalog_invalid", known.FlowRuntimeCode())
			require.False(t, known.FlowRuntimeRetryable())
			var classified interface{ FlowRuntimeClass() string }
			require.ErrorAs(t, err, &classified)
			require.Equal(t, "infra", classified.FlowRuntimeClass())
			require.Zero(t, targetCalls)
			require.Zero(t, store.acquires)
			require.Empty(t, launcher.calls)
			require.Empty(t, launcher.starts)
		})
	}
}

// Use the actual workspace launcher against a sandboxed managed-host fixture.
// The transport substitutes the HTTP application only; the launch contract and
// authentication pass through the same public boundaries as a guest host.
type sandboxedManagedRuntime struct {
	workspaceapi.WorkspaceRuntime
	connection workspaceapi.ManagedHostConnection
	starts     int
	commands   []workspaceapi.Command
}

func (*sandboxedManagedRuntime) Isolation() workspaceapi.IsolationLevel {
	return workspaceapi.IsolationSandboxed
}
func (*sandboxedManagedRuntime) Capabilities() workspaceapi.WorkspaceCapabilities {
	return workspaceapi.WorkspaceCapabilities{ManagedHTTPHosts: true, SourceRevision: true}
}
func (*sandboxedManagedRuntime) ResolveWorkspaceSourceRevision(context.Context, string) (string, error) {
	return strings.Repeat("b", 40), nil
}
func (r *sandboxedManagedRuntime) InspectManagedHost(context.Context, string, workspaceapi.ManagedHostSpec) (workspaceapi.ManagedHostConnection, error) {
	if r.starts == 0 {
		return workspaceapi.ManagedHostConnection{}, workspaceapi.ErrManagedHostNotRunning
	}
	return r.connection, nil
}
func (r *sandboxedManagedRuntime) StartManagedHost(ctx context.Context, id string, spec workspaceapi.ManagedHostSpec) (workspaceapi.ManagedHostConnection, error) {
	command, err := spec.Builder.BuildManagedHost(ctx, workspaceapi.ManagedHostPlacement{
		Workspace: workspaceapi.Workspace{ID: id, Root: "/guest/repository"}, StateDir: "/guest/state", Host: "127.0.0.1", Port: 7331, Address: "127.0.0.1:7331",
	})
	if err != nil {
		return workspaceapi.ManagedHostConnection{}, err
	}
	r.commands = append(r.commands, command)
	r.starts++
	transport := &identityTransport{credential: command.Environment["SMITHERS_API_KEY"], identity: flowruntime.Identity{
		Protocol: spec.Expected.Protocol, RuntimeArtifactDigest: spec.Expected.ArtifactDigest,
		SourceRevision: spec.Expected.SourceRevision, OwnerGeneration: spec.Expected.OwnerGeneration,
	}}
	r.connection = workspaceapi.ManagedHostConnection{Endpoint: "http://127.0.0.1:7331", HTTPClient: &http.Client{Transport: transport}}
	return r.connection, nil
}
func TestSandboxedWorkspaceLauncherBindsAndReconnects(t *testing.T) {
	resolver, store, _, target := testResolver(t)
	sandbox := &sandboxedManagedRuntime{}
	launcher, err := NewWorkspaceLauncher(sandbox)
	require.NoError(t, err)
	resolver.launcher = launcher
	identity := resolvedIdentity(t, resolver.ResolveFlowRuntime, target)
	require.Equal(t, flowruntime.Protocol, identity.Protocol)
	require.Equal(t, int64(1), identity.OwnerGeneration)
	require.Equal(t, identity, resolvedIdentity(t, resolver.ResolveExistingFlowRuntime, target))
	require.Equal(t, 1, sandbox.starts)
	require.Equal(t, "running", store.binding.State)
	require.Contains(t, sandbox.commands[0].Args, "/guest/repository")
}
