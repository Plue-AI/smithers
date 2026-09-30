package ports

import (
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/runtimeports"
)

// RuntimeStores supplies optional deployment storage extensions to canonical
// product services. A nil field uses product SQL only where that service has a
// complete product implementation; fleet-only capabilities require a store.
// Implementations must retain their transaction and optional extension methods.
type RuntimeStores struct {
	GoldenSnapshots   runtimeports.GoldenSnapshotStore
	LFS               services.LFSQuerier
	WorkflowCache     services.WorkflowCacheQuerier
	WorkflowArtifacts services.WorkflowArtifactQuerier
	WorkflowRuns      services.WorkflowRunQuerier
	AgentDispatch     services.AgentDispatchQuerier
	Workspaces        services.WorkspaceQuerier
	EnvironmentImages services.SandboxEnvironmentImageQuerier
	RepoGateways      RepoGatewayStore
	Orphans           services.SandboxOrphanQuerier
	EgressAudit       services.SandboxEgressAuditQuerier
}

// RepoGatewayStore is the retired box gateways' inventory, read and cleared
// by the one-release convergence (services.RepoGatewayRetirement, #2198).
// Delete it with that reaper.
type RepoGatewayStore interface {
	services.RepoGatewayRetirementStore
}
