// Package flowhost resolves product-owned bindings to authenticated instances
// of the canonical TypeScript Flow host. It owns host identity and lifecycle
// coordination only; graph, journal, scheduling, and execution stay in Flow
// and Control.
package flowhost

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/modelproxy"
)

const (
	CatalogCoding    = "coding"
	CatalogLibrarian = "librarian"
)

var ErrHostNotRunning = errors.New("flow host is not running")

// ErrSourceRevisionRequired asks the resolver to capture a workspace snapshot
// only when there is no durable binding to reconnect to.
var ErrSourceRevisionRequired = errors.New("flow host creation requires a workspace source revision")

// SecretCodec protects the host bearer at rest. The existing application
// secret codec satisfies this interface; a plaintext fallback is deliberately
// not provided.
type SecretCodec interface {
	EncryptString(string) (string, error)
	DecryptString(string) (string, error)
}

// Catalog is immutable operator configuration for one packaged host family.
// Executable is supplied locally by the distribution; resolving a catalog
// never downloads an artifact.
type Catalog struct {
	Key                 string
	Family              string
	Executable          string
	ArtifactDigest      string
	ServiceName         string
	ReadyTimeout        time.Duration
	Environment         map[string]string
	ImplementationModel string
	// ModelProxyURL is the metered platform-model proxy reachable from the
	// host; ModelSeats are the platform seats it serves. Each seat's key is
	// the binding's model credential (ModelCredential), never a provider key.
	ModelProxyURL string
	ModelSeats    []modelproxy.Seat
	// AccountPoolURL is the provider account pool ({base}/provider-pool)
	// reachable from the host, set when the deployment allows subscription
	// connections. The host's key is the binding's model credential; the
	// pool serves the binding user's connected accounts on its repository,
	// and the host asks the pool which providers have any.
	AccountPoolURL string
}

// The account pool's guest environment (NativeEquipment): its origin, the
// routes a host may take to it, and the host's pool key.
const (
	AccountPoolURLEnv       = "SMITHERS_ACCOUNT_POOL_URL"
	AccountPoolProvidersEnv = "SMITHERS_ACCOUNT_POOL_PROVIDERS"
	AccountPoolKeyEnv       = "SMITHERS_ACCOUNT_POOL_KEY"
	// AccountPoolRoutes are every route a pool serves.
	AccountPoolRoutes = "anthropic,chatgpt"
)

type WorkspacePaths struct {
	Root     string
	StateDir string
	// Host is allocated by the workspace adapter; empty retains IPv4 loopback.
	Host string
}

// ProcessSpec is the identical canonical-host argv/environment contract used
// by trusted-process and isolated adapters after the adapter selects a port.
type ProcessSpec struct {
	Name         string
	Identity     string
	Args         []string
	Environment  map[string]string
	ReadyAddress string
	ReadyTimeout time.Duration
}

// Authority is the server-resolved product binding. None of these values may
// come from a jobs payload beyond the Target fields that are revalidated here.
type Authority struct {
	Target       flowruntime.Target
	RepositoryID int64
	UserID       int64
	WorkspaceID  string
	CatalogKey   string
	Repository   string
	// SourceRevision names the actual workspace snapshot read by the host.
	// It may be empty when reconnecting to an existing, pinned binding.
	SourceRevision string
}

// TargetResolver maps a durable product target to its current authorized
// repository/workspace binding. Implementations conceal cross-scope targets.
type TargetResolver interface {
	ResolveFlowHostTarget(context.Context, flowruntime.Target) (Authority, error)
}

type TargetResolverFunc func(context.Context, flowruntime.Target) (Authority, error)

func (resolve TargetResolverFunc) ResolveFlowHostTarget(ctx context.Context, target flowruntime.Target) (Authority, error) {
	return resolve(ctx, target)
}

// Binding is the durable host authority. Credential material is intentionally
// absent; it is exposed only by the short-lived locked lease passed internally
// to Resolver.
type Binding struct {
	ID                    string
	TenantID              string
	PrincipalID           string
	BindingKind           string
	BindingID             string
	RepositoryID          int64
	UserID                int64
	WorkspaceID           string
	CatalogKey            string
	ServiceName           string
	RuntimeArtifactDigest string
	SourceRevision        string
	OwnerGeneration       int64
	State                 string
}

// HostLaunch contains the exact, server-held inputs required to start one
// canonical host. Adapters allocate/route the port in their own namespace and
// return the resulting private connection; callers never provide an endpoint
// or bearer in Flow payloads.
type HostLaunch struct {
	Binding    Binding
	Authority  Authority
	Catalog    Catalog
	Credential string
}

// Connection is a private bridge transport. Isolated adapters use HTTPClient
// to dial the placement-fenced WorkspacePortDialer while retaining a loopback
// URL; trusted-process adapters return their loopback endpoint directly.
type Connection struct {
	Endpoint   string
	HTTPClient *http.Client
}

// Launcher is the deployment adapter facet owned by the workspace runtime.
// Inspect must return ErrHostNotRunning when no live process owns the binding;
// it must not claim readiness from a stale product row or a bare TCP listener.
type Launcher interface {
	InspectFlowHost(context.Context, HostLaunch) (Connection, error)
	StartFlowHost(context.Context, HostLaunch) (Connection, error)
}

// SourceResolver is an optional launcher facet. It captures the authorized
// workspace's immutable source snapshot; artifact build provenance is unrelated.
// A missing/dirty/unreadable snapshot must fail, never manufacture a revision.
type SourceResolver interface {
	ResolveFlowHostSource(context.Context, Authority) (string, error)
}

// BindingLease holds the cross-replica ensure lock. Resolver deliberately
// keeps it through process inspection/start and the authenticated identity
// probe, preventing two API/worker replicas from creating competing owners.
type BindingLease interface {
	Binding() Binding
	Credential() string
	// Supersedes reports a durable owner whose artifact digest, service name,
	// or source revision no longer matches the catalog/authority. Acquire
	// succeeds for such a row; the resolver stops that owner and calls Rebind.
	Supersedes() (Binding, bool)
	// Rebind installs the current identity on the same row with a new owner
	// generation, fencing any late host of the superseded identity.
	Rebind(context.Context) (Binding, error)
	PrepareStart(context.Context, bool) (Binding, error)
	MarkRunning(context.Context) error
	// MarkFailed records a failed start so the next start fences a new owner.
	MarkFailed(ctx context.Context, code string) error
	Close() error
}

type BindingStore interface {
	Acquire(context.Context, Authority, Catalog) (BindingLease, error)
}

type ExistingBindingStore interface {
	AcquireExisting(context.Context, Authority, Catalog) (BindingLease, error)
}

type Config struct {
	Store    BindingStore
	Targets  TargetResolver
	Launcher Launcher
	Catalogs []Catalog
}
