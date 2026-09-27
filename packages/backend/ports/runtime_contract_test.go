package ports_test

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/smithersai/smithers/packages/backend/ports"
	"github.com/smithersai/smithers/packages/backend/productstore"
	"github.com/smithersai/smithers/packages/backend/provisioning"
	"github.com/smithersai/smithers/packages/backend/runtimeports"
)

// These adapters import only exported packages, as a deployment module must.
// The assignments below fail to compile when a runtime store contract gains a
// type that an external implementation cannot name.

type externalGoldenSnapshots struct{}

func (externalGoldenSnapshots) LatestReadyGoldenSnapshot(context.Context, string) (string, time.Time, error) {
	return "", time.Time{}, nil
}
func (externalGoldenSnapshots) ClaimGoldenSnapshotBake(context.Context, string) (string, error) {
	return "", nil
}
func (externalGoldenSnapshots) FinishGoldenSnapshot(context.Context, string, string, string) (string, error) {
	return "", nil
}
func (externalGoldenSnapshots) ReclaimStaleGoldenSnapshot(context.Context, string, int64) (string, error) {
	return "", nil
}
func (externalGoldenSnapshots) SupersedeGoldenSnapshots(context.Context, string, string) error {
	return nil
}
func (externalGoldenSnapshots) ExpiredGoldenSnapshots(context.Context, string, int64) ([]runtimeports.GoldenSnapshotVictim, error) {
	return nil, nil
}
func (externalGoldenSnapshots) DeleteGoldenSnapshot(context.Context, string) error { return nil }
func (externalGoldenSnapshots) MarkBadGoldenSnapshot(context.Context, string, string) error {
	return nil
}
func (externalGoldenSnapshots) FailedGoldenSnapshotBuilders(context.Context) ([]runtimeports.GoldenSnapshotBuilder, error) {
	return nil, nil
}

type externalWorkflowScheduler struct{ productstore.Product }

func (externalWorkflowScheduler) ClaimQueuedWorkflowRuns(context.Context, int32) ([]runtimeports.ClaimQueuedWorkflowRunsRow, error) {
	return nil, nil
}
func (externalWorkflowScheduler) RenewWorkflowSandboxClaim(context.Context, runtimeports.RenewWorkflowSandboxClaimParams) (pgtype.Timestamptz, error) {
	return pgtype.Timestamptz{}, nil
}
func (externalWorkflowScheduler) MarkWorkflowRunSuccess(context.Context, runtimeports.MarkWorkflowRunSuccessParams) (runtimeports.WorkflowRun, error) {
	return runtimeports.WorkflowRun{}, nil
}
func (externalWorkflowScheduler) MarkWorkflowRunFailure(context.Context, runtimeports.MarkWorkflowRunFailureParams) (runtimeports.WorkflowRun, error) {
	return runtimeports.WorkflowRun{}, nil
}

type externalEnvironmentImages struct{}

func (externalEnvironmentImages) UpsertSandboxEnvironmentImage(context.Context, runtimeports.UpsertSandboxEnvironmentImageParams) (runtimeports.SandboxEnvironmentImage, error) {
	return runtimeports.SandboxEnvironmentImage{}, nil
}
func (externalEnvironmentImages) GetLatestReadySandboxEnvironmentImage(context.Context, runtimeports.GetLatestReadySandboxEnvironmentImageParams) (runtimeports.SandboxEnvironmentImage, error) {
	return runtimeports.SandboxEnvironmentImage{}, nil
}
func (externalEnvironmentImages) ListSandboxEnvironmentImages(context.Context, pgtype.Int8) ([]runtimeports.SandboxEnvironmentImage, error) {
	return nil, nil
}
func (externalEnvironmentImages) RetireSandboxEnvironmentImage(context.Context, runtimeports.RetireSandboxEnvironmentImageParams) (runtimeports.SandboxEnvironmentImage, error) {
	return runtimeports.SandboxEnvironmentImage{}, nil
}

type externalRepoGateways struct{}

func (externalRepoGateways) ListActiveRepoGateways(context.Context) ([]runtimeports.RepoGateway, error) {
	return nil, nil
}
func (externalRepoGateways) ListStaleRepoGateways(context.Context, int64) ([]runtimeports.RepoGateway, error) {
	return nil, nil
}
func (externalRepoGateways) SoftDeleteRepoGateway(context.Context, string) (runtimeports.RepoGateway, error) {
	return runtimeports.RepoGateway{}, nil
}
func (externalRepoGateways) ListPendingWorkspaceGatewayCleanup(context.Context) ([]runtimeports.RepoGateway, error) {
	return nil, nil
}
func (externalRepoGateways) TouchDiscardedWorkspaceGatewayCleanup(context.Context, string) error {
	return nil
}
func (externalRepoGateways) ClearDiscardedWorkspaceGatewayCredential(context.Context, string) error {
	return nil
}

type externalOrphans struct{}

func (externalOrphans) ListOrphanedSandboxInstances(context.Context, runtimeports.ListOrphanedSandboxInstancesParams) ([]runtimeports.ListOrphanedSandboxInstancesRow, error) {
	return nil, nil
}

type externalEgressAudit struct{}

func (externalEgressAudit) ListSandboxEgressAuditByResource(context.Context, runtimeports.ListSandboxEgressAuditByResourceParams) ([]runtimeports.SandboxEgressAudit, error) {
	return nil, nil
}

type externalProvisioning struct{}

func (externalProvisioning) Reserve(context.Context, provisioning.Operation) (provisioning.Operation, error) {
	return provisioning.Operation{}, nil
}
func (externalProvisioning) GetByToken(context.Context, string) (provisioning.Operation, error) {
	return provisioning.Operation{}, nil
}
func (externalProvisioning) AcquireProcessing(context.Context, int64, string, string) error {
	return nil
}
func (externalProvisioning) GetPublished(context.Context, provisioning.Operation) (provisioning.Repository, bool, error) {
	return provisioning.Repository{}, false, nil
}
func (externalProvisioning) MarkPublishReady(context.Context, int64, string, string) error {
	return nil
}
func (externalProvisioning) RenewClaim(context.Context, int64, string, string) error { return nil }
func (externalProvisioning) Publish(context.Context, provisioning.Operation, string) (provisioning.Repository, error) {
	return provisioning.Repository{}, nil
}
func (externalProvisioning) Complete(context.Context, int64, string, string) error { return nil }
func (externalProvisioning) Abort(context.Context, provisioning.Operation, string, func(context.Context) error) error {
	return nil
}
func (externalProvisioning) ReleaseClaim(context.Context, provisioning.Operation, string, error) {}
func (externalProvisioning) FindExact(context.Context, provisioning.Operation) (provisioning.Operation, bool, error) {
	return provisioning.Operation{}, false, nil
}
func (externalProvisioning) ClaimReady(context.Context, string) ([]provisioning.Operation, error) {
	return nil, nil
}

var _ = ports.RuntimeStores{
	GoldenSnapshots:   externalGoldenSnapshots{},
	WorkflowScheduler: externalWorkflowScheduler{},
	EnvironmentImages: externalEnvironmentImages{},
	RepoGateways:      externalRepoGateways{},
	Orphans:           externalOrphans{},
	EgressAudit:       externalEgressAudit{},
}

var _ ports.RepositoryProvisioning = externalProvisioning{}
