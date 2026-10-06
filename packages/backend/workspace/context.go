package workspace

import (
	"context"
	"net"
	"strings"
)

// Operation is identity and retry evidence supplied after common product
// authentication, authorization, and admission. Runtime adapters may use it
// for tenant fencing and infrastructure idempotency, but must not replace the
// product policy decision with their own interpretation of these fields.
type Operation struct {
	TenantID    string
	PrincipalID string
	OperationID string
}

type operationContextKey struct{}

// WithOperation attaches an already-authorized product operation to a runtime
// call. OperationID is required for mutations and may be empty for reads.
func WithOperation(ctx context.Context, operation Operation) context.Context {
	operation.TenantID = strings.TrimSpace(operation.TenantID)
	operation.PrincipalID = strings.TrimSpace(operation.PrincipalID)
	operation.OperationID = strings.TrimSpace(operation.OperationID)
	return context.WithValue(ctx, operationContextKey{}, operation)
}

// OperationFromContext returns only explicitly attached identity. There is no
// header, environment, or process identity fallback.
func OperationFromContext(ctx context.Context) (Operation, bool) {
	operation, ok := ctx.Value(operationContextKey{}).(Operation)
	return operation, ok
}

// IsolationGuarantees are machine-readable facts reported by an adapter.
// They are runtime evidence rather than an edition or billing label.
type IsolationGuarantees struct {
	Level                     IsolationLevel
	Boundary                  string
	DedicatedTenantFilesystem bool
	DedicatedTenantNetwork    bool
	DefaultDenyEgress         bool
	NonPersistentCredentials  bool
	PlacementFencing          bool
	RuntimeVersion            string
	ControllerVersion         string
}

type IsolationReporter interface {
	WorkspaceIsolation(ctx context.Context, workspaceID string) (IsolationGuarantees, error)
}

// PortPurpose prevents a private runtime-control connection from being
// confused with a user preview or public ingress route.
type PortPurpose string

const PortPurposeFlowRuntime PortPurpose = "flow_runtime"

// PortPurposeMachined carries the authenticated ADR 0004 private connection.
const PortPurposeMachined PortPurpose = "machined"

type PortRequest struct {
	Port    uint16
	Purpose PortPurpose
}

// PortDialer is an optional isolated-runtime facet. It opens an authenticated,
// tenant-scoped, placement-fenced stream to a declared guest port.
type PortDialer interface {
	DialWorkspacePort(ctx context.Context, workspaceID string, request PortRequest) (net.Conn, error)
}

// RoutedPreviewSpec names a route approved by common product authorization.
// The adapter still validates the hostname against deployment policy.
type RoutedPreviewSpec struct {
	Hostname string
	Port     uint16
}

type RoutedPreview struct {
	ID       string
	Hostname string
	URL      string
}

// RoutedPreviewPublisher preserves a hosted deployment's authenticated
// preview gateway. It is optional because the local runtime exposes a
// loopback PreviewTarget for the common authenticated reverse proxy instead.
type RoutedPreviewPublisher interface {
	PublishWorkspacePreview(ctx context.Context, workspaceID string, spec RoutedPreviewSpec) (RoutedPreview, error)
	RevokeWorkspacePreview(ctx context.Context, workspaceID, hostname string) error
}
