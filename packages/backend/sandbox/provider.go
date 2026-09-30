package sandbox

import (
	"context"
	"fmt"
)

// ProviderName is the durable identifier for the sandbox implementation.
type ProviderName string

// Capability names are intentionally provider-neutral. Product code asks for
// the behavior it needs instead of branching on implementation details.
type Capability string

const (
	CapabilityExecution         Capability = "execution"
	CapabilityColdLifecycle     Capability = "cold_lifecycle"
	CapabilityColdSnapshots     Capability = "cold_snapshots"
	CapabilityFileTransfer      Capability = "file_transfer"
	CapabilityInteractiveAccess Capability = "interactive_access"
	CapabilityIngress           Capability = "ingress"
)

// Capabilities is an immutable provider capability set.
type Capabilities map[Capability]bool

func (c Capabilities) Supports(capability Capability) bool {
	return c[capability]
}

// UnsupportedCapabilityError is returned when a product path asks the
// sandbox implementation for behavior it cannot provide.
type UnsupportedCapabilityError struct {
	Provider   ProviderName
	Capability Capability
}

func (e *UnsupportedCapabilityError) Error() string {
	return fmt.Sprintf("sandbox provider %q does not support capability %q", e.Provider, e.Capability)
}

// Provider is the deployment-neutral compute boundary consumed by product services.
// Implementation-specific SDK types must not cross this interface.
type Provider interface {
	Name() ProviderName
	Capabilities() Capabilities
	CreateSandbox(context.Context, CreateRequest) (CreateResult, error)
	ForkSandbox(context.Context, string, ForkRequest) (CreateResult, error)
	InspectSandbox(context.Context, string) (Sandbox, error)
	DeleteSandbox(context.Context, string) error
	StartSandbox(context.Context, string, StartRequest) (StartResult, error)
	StopSandbox(context.Context, string) (StopResult, error)
	SuspendSandbox(context.Context, string) (SuspendResult, error)
	Execute(context.Context, string, ExecRequest) (ExecResult, error)
	SnapshotSandbox(context.Context, string, SnapshotRequest) (SnapshotResult, error)
	CreateSnapshot(context.Context, CreateSnapshotRequest) (CreateSnapshotResponse, error)
	DeleteSnapshot(context.Context, string) error
	WriteFile(context.Context, string, string, WriteFileRequest) error
	CreateService(context.Context, string, ServiceSpec) (CreateServiceResult, error)
	CreateIdentity(context.Context) (Identity, error)
	GrantAccess(context.Context, string, string, GrantAccessRequest) (AccessGrant, error)
	CreateIdentityToken(context.Context, string) (CreatedToken, error)
	PublishIngress(context.Context, string, PublishIngressRequest) (IngressRoute, error)
	RevokeIngress(context.Context, string) error
}

// IdentityForSandboxProvider allows an implementation to bind identity creation to
// a sandbox when that is required by its access-grant model.
type IdentityForSandboxProvider interface {
	CreateIdentityForSandbox(context.Context, string) (Identity, error)
}

// AccessGrantRevoker revokes every controller-side SSH credential whose
// identity is permitted on a sandbox. Sandbox ids remain durable across API
// restarts, so revocation events can invalidate grants they did not mint in
// the current process.
type AccessGrantRevoker interface {
	RevokeAccessGrant(context.Context, string) error
}

// EgressRevokeRequest names why a sandbox's egress proxy is being torn down.
type EgressRevokeRequest struct {
	Reason string `json:"reason,omitempty"`
}

// EgressRevokeResult reports the outcome of an egress revocation.
type EgressRevokeResult struct {
	SandboxID string `json:"sandboxId"`
	// Revoked is false when the sandbox had no live proxy to tear down, which
	// is not an error: the goal state (no egress) already held.
	Revoked bool `json:"revoked"`
}

// EgressRevoker is implemented by providers that can tear down a running
// sandbox's egress proxy immediately when the authorization behind it is
// revoked (an agent session cancelled, a bound credential withdrawn). The
// guest keeps running with its default-deny firewall and no egress; the
// credential values that lived only in the proxy process are gone.
type EgressRevoker interface {
	RevokeEgress(ctx context.Context, sandboxID string, req EgressRevokeRequest) (EgressRevokeResult, error)
}

// EgressReloadRequest is the domain allowlist a running sandbox's egress
// proxy switches to. An empty list resets it to the provider's deployment
// list; it never denies everything. Hosts a bound secret names stay
// reachable whatever the list says.
type EgressReloadRequest struct {
	AllowDomains []string `json:"allowDomains"`
}

// EgressReloadResult reports the allowlist the proxy now enforces.
type EgressReloadResult struct {
	SandboxID    string   `json:"sandboxId"`
	AllowDomains []string `json:"allowDomains"`
}

// EgressReloader is implemented by providers that can replace a running
// sandbox's egress allowlist on its live proxy without restarting the
// sandbox. An unknown, stopped, or revoked sandbox is an error.
type EgressReloader interface {
	ReloadEgress(ctx context.Context, sandboxID string, req EgressReloadRequest) (EgressReloadResult, error)
}
