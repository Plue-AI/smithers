package services

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

func TestGitHubImportRetryDelayHonorsWrappedProviderBackoff(t *testing.T) {
	t.Parallel()

	assert.Equal(t, durationSeconds(githubImportRetryDelay), githubImportRetryDelaySeconds(fmt.Errorf("temporary")))
	assert.Equal(t, durationSeconds(githubImportRetryDelay), githubImportRetryDelaySeconds(&pkgerrors.APIError{RetryAfter: 3}))
	assert.Equal(t, int32(97), githubImportRetryDelaySeconds(fmt.Errorf("github: %w", &pkgerrors.APIError{RetryAfter: 97})))
}

func TestWorkflowArtifactPruneRechecksLifecycleAfterOwnerLock(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, 7, 18, 12, 0, 0, 0, time.UTC)
	candidate := db.WorkflowArtifact{
		ID: 1, RepositoryID: 42, WorkflowRunID: 7, Name: "report.json", Size: 9,
		GcsKey: "runs/7/report.json", Status: "pending",
		CreatedAt: now.Add(-48 * time.Hour), UpdatedAt: now.Add(-48 * time.Hour),
	}
	current := candidate
	current.Status = "ready"
	current.ExpiresAt = now.Add(time.Hour)
	current.UpdatedAt = now
	claims := 0
	queries := &mockWorkflowArtifactQuerier{
		listPrunableWorkflowArtifactsFn: func(context.Context, db.ListPrunableWorkflowArtifactsParams) ([]db.WorkflowArtifact, error) {
			return []db.WorkflowArtifact{candidate}, nil
		},
		getWorkflowArtifactByNameFn: func(context.Context, db.GetWorkflowArtifactByNameParams) (db.WorkflowArtifact, error) {
			return current, nil
		},
		claimWorkflowArtifactDeletionFn: func(context.Context, db.ClaimWorkflowArtifactDeletionParams) (db.WorkflowArtifact, error) {
			claims++
			return db.WorkflowArtifact{}, nil
		},
	}
	svc := NewWorkflowArtifactService(queries, &mockBlobStore{}, time.Minute).(*workflowArtifactService)
	svc.now = func() time.Time { return now }

	deleted, err := svc.PruneExpired(context.Background(), 10)
	require.NoError(t, err)
	assert.Zero(t, deleted)
	assert.Zero(t, claims, "a refreshed ready artifact with a future expiry must not inherit a stale pending prune decision")
}

func TestWorkflowArtifactPruneDrainsMoreThanOneBatch(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, 7, 18, 12, 0, 0, 0, time.UTC)
	artifacts := []db.WorkflowArtifact{
		{ID: 1, RepositoryID: 42, WorkflowRunID: 7, Name: "one", GcsKey: "runs/7/one", Status: "ready", ExpiresAt: now.Add(-time.Hour)},
		{ID: 2, RepositoryID: 42, WorkflowRunID: 7, Name: "two", GcsKey: "runs/7/two", Status: "ready", ExpiresAt: now.Add(-time.Hour)},
		{ID: 3, RepositoryID: 42, WorkflowRunID: 7, Name: "three", GcsKey: "runs/7/three", Status: "ready", ExpiresAt: now.Add(-time.Hour)},
	}
	byName := make(map[string]db.WorkflowArtifact, len(artifacts))
	for _, artifact := range artifacts {
		byName[artifact.Name] = artifact
	}
	listCalls := 0
	queries := &mockWorkflowArtifactQuerier{
		listPrunableWorkflowArtifactsFn: func(context.Context, db.ListPrunableWorkflowArtifactsParams) ([]db.WorkflowArtifact, error) {
			listCalls++
			if listCalls == 1 {
				return artifacts[:2], nil
			}
			return artifacts[2:], nil
		},
		getWorkflowArtifactByNameFn: func(_ context.Context, arg db.GetWorkflowArtifactByNameParams) (db.WorkflowArtifact, error) {
			return byName[arg.Name], nil
		},
	}
	svc := NewWorkflowArtifactService(queries, &mockBlobStore{}, time.Minute).(*workflowArtifactService)
	svc.now = func() time.Time { return now }

	deleted, err := svc.PruneExpired(context.Background(), 2)
	require.NoError(t, err)
	assert.Equal(t, 3, deleted)
	assert.Equal(t, 2, listCalls)
}

type releaseReservationBilling struct {
	dynamicCalls int
	fixedCalls   int
}

func (*releaseReservationBilling) AuthorizePrivateRepo(context.Context, string, int64) error {
	return nil
}
func (*releaseReservationBilling) AuthorizeWorkflowDispatchCommitted(ctx context.Context, _ int64, commit func(context.Context, pgx.Tx) error) error {
	return commit(ctx, nil)
}
func (*releaseReservationBilling) AuthorizeAgentRunCommitted(ctx context.Context, _ int64, commit func(context.Context, db.DBTX) error) error {
	return commit(ctx, nil)
}
func (*releaseReservationBilling) AuthorizeStorageIncrease(context.Context, int64, int64) error {
	return nil
}

func (p *releaseReservationBilling) AuthorizeStorageIncreaseCommitted(
	ctx context.Context,
	_ int64,
	_ int64,
	commit func(context.Context) error,
) error {
	p.fixedCalls++
	return commit(ctx)
}
func (p *releaseReservationBilling) AuthorizeStorageIncreaseCommittedDynamic(
	ctx context.Context,
	_ int64,
	resolve func(context.Context) (int64, error),
	commit func(context.Context) error,
) error {
	p.dynamicCalls++
	if _, err := resolve(ctx); err != nil {
		return err
	}
	return commit(ctx)
}

func (*releaseReservationBilling) AuthorizeSandboxStart(context.Context, int64) error {
	return nil
}
func (*releaseReservationBilling) SandboxEntitlement(context.Context, int64) (SandboxEntitlement, error) {
	return SandboxEntitlement{}, nil
}
