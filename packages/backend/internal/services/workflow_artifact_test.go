package services

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/runtimeports"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/blob"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/webhooks"
)

type mockWorkflowArtifactQuerier struct {
	clearPurgedStorageDeletionFn       func(ctx context.Context, arg runtimeports.ClearPurgedStorageDeletionByExactKeyParams) (int64, error)
	getWorkflowRunFn                   func(ctx context.Context, arg db.GetWorkflowRunParams) (db.WorkflowRun, error)
	createWorkflowArtifactFn           func(ctx context.Context, arg db.CreateWorkflowArtifactParams) (db.WorkflowArtifact, error)
	confirmWorkflowArtifactUploadFn    func(ctx context.Context, arg db.ConfirmWorkflowArtifactUploadParams) (db.WorkflowArtifact, error)
	getWorkflowDefinitionNameByRunIDFn func(ctx context.Context, workflowRunID int64) (string, error)
	listWorkflowArtifactsByRunFn       func(ctx context.Context, workflowRunID int64) ([]db.WorkflowArtifact, error)
	getWorkflowArtifactByNameFn        func(ctx context.Context, arg db.GetWorkflowArtifactByNameParams) (db.WorkflowArtifact, error)
	claimWorkflowArtifactDeletionFn    func(ctx context.Context, arg db.ClaimWorkflowArtifactDeletionParams) (db.WorkflowArtifact, error)
	retryWorkflowArtifactDeletionFn    func(ctx context.Context, arg db.RetryWorkflowArtifactDeletionParams) (db.WorkflowArtifact, error)
	releaseWorkflowArtifactDeletionFn  func(ctx context.Context, arg db.ReleaseWorkflowArtifactDeletionClaimParams) error
	deleteClaimedWorkflowArtifactFn    func(ctx context.Context, arg db.DeleteClaimedWorkflowArtifactParams) (db.WorkflowArtifact, error)
	listPrunableWorkflowArtifactsFn    func(ctx context.Context, arg db.ListPrunableWorkflowArtifactsParams) ([]db.WorkflowArtifact, error)
	attachWorkflowArtifactToReleaseFn  func(ctx context.Context, arg db.AttachWorkflowArtifactToReleaseParams) (db.WorkflowArtifact, error)
	lastCreate                         db.CreateWorkflowArtifactParams
	lastDelete                         db.DeleteClaimedWorkflowArtifactParams
	lastPrune                          db.ListPrunableWorkflowArtifactsParams
}

func (m *mockWorkflowArtifactQuerier) ClearPurgedStorageDeletionByExactKey(ctx context.Context, arg runtimeports.ClearPurgedStorageDeletionByExactKeyParams) (int64, error) {
	if m.clearPurgedStorageDeletionFn != nil {
		return m.clearPurgedStorageDeletionFn(ctx, arg)
	}
	return 0, nil
}

func (m *mockWorkflowArtifactQuerier) GetWorkflowRun(ctx context.Context, arg db.GetWorkflowRunParams) (db.WorkflowRun, error) {
	if m.getWorkflowRunFn != nil {
		return m.getWorkflowRunFn(ctx, arg)
	}
	return db.WorkflowRun{}, pgx.ErrNoRows
}

func (m *mockWorkflowArtifactQuerier) CreateWorkflowArtifact(ctx context.Context, arg db.CreateWorkflowArtifactParams) (db.WorkflowArtifact, error) {
	m.lastCreate = arg
	if m.createWorkflowArtifactFn != nil {
		return m.createWorkflowArtifactFn(ctx, arg)
	}
	return db.WorkflowArtifact{
		ID:            1,
		RepositoryID:  arg.RepositoryID,
		WorkflowRunID: arg.WorkflowRunID,
		Name:          arg.Name,
		Size:          arg.Size,
		ContentType:   arg.ContentType,
		Status:        "pending",
		GcsKey:        "repos/101/runs/55/artifacts/1/" + arg.Name,
		ExpiresAt:     arg.ExpiresAt,
		CreatedAt:     time.Now().UTC(),
		UpdatedAt:     time.Now().UTC(),
	}, nil
}

func (m *mockWorkflowArtifactQuerier) ConfirmWorkflowArtifactUpload(ctx context.Context, arg db.ConfirmWorkflowArtifactUploadParams) (db.WorkflowArtifact, error) {
	if m.confirmWorkflowArtifactUploadFn != nil {
		return m.confirmWorkflowArtifactUploadFn(ctx, arg)
	}
	return db.WorkflowArtifact{
		ID:            1,
		RepositoryID:  101,
		WorkflowRunID: arg.WorkflowRunID,
		Name:          arg.Name,
		Size:          128,
		ContentType:   "application/gzip",
		Status:        "ready",
		ConfirmedAt:   pgtype.Timestamptz{Time: time.Now().UTC(), Valid: true},
		CreatedAt:     time.Now().UTC(),
		UpdatedAt:     time.Now().UTC(),
	}, nil
}

func (m *mockWorkflowArtifactQuerier) GetWorkflowDefinitionNameByRunID(ctx context.Context, workflowRunID int64) (string, error) {
	if m.getWorkflowDefinitionNameByRunIDFn != nil {
		return m.getWorkflowDefinitionNameByRunIDFn(ctx, workflowRunID)
	}
	return "", pgx.ErrNoRows
}

func (m *mockWorkflowArtifactQuerier) ListWorkflowArtifactsByRun(ctx context.Context, workflowRunID int64) ([]db.WorkflowArtifact, error) {
	if m.listWorkflowArtifactsByRunFn != nil {
		return m.listWorkflowArtifactsByRunFn(ctx, workflowRunID)
	}
	return nil, nil
}

func (m *mockWorkflowArtifactQuerier) GetWorkflowArtifactByName(ctx context.Context, arg db.GetWorkflowArtifactByNameParams) (db.WorkflowArtifact, error) {
	if m.getWorkflowArtifactByNameFn != nil {
		return m.getWorkflowArtifactByNameFn(ctx, arg)
	}
	return db.WorkflowArtifact{}, pgx.ErrNoRows
}

func (m *mockWorkflowArtifactQuerier) ClaimWorkflowArtifactDeletion(ctx context.Context, arg db.ClaimWorkflowArtifactDeletionParams) (db.WorkflowArtifact, error) {
	if m.claimWorkflowArtifactDeletionFn != nil {
		return m.claimWorkflowArtifactDeletionFn(ctx, arg)
	}
	return db.WorkflowArtifact{ID: arg.ID, RepositoryID: arg.RepositoryID, WorkflowRunID: arg.WorkflowRunID, Name: arg.Name, GcsKey: arg.GcsKey, Status: "deleting"}, nil
}

func (m *mockWorkflowArtifactQuerier) RetryWorkflowArtifactDeletion(ctx context.Context, arg db.RetryWorkflowArtifactDeletionParams) (db.WorkflowArtifact, error) {
	if m.retryWorkflowArtifactDeletionFn != nil {
		return m.retryWorkflowArtifactDeletionFn(ctx, arg)
	}
	return db.WorkflowArtifact{ID: arg.ID, RepositoryID: arg.RepositoryID, WorkflowRunID: arg.WorkflowRunID, Name: arg.Name, GcsKey: arg.GcsKey, Status: "deleting"}, nil
}

func (m *mockWorkflowArtifactQuerier) ReleaseWorkflowArtifactDeletionClaim(ctx context.Context, arg db.ReleaseWorkflowArtifactDeletionClaimParams) error {
	if m.releaseWorkflowArtifactDeletionFn != nil {
		return m.releaseWorkflowArtifactDeletionFn(ctx, arg)
	}
	return nil
}

func (m *mockWorkflowArtifactQuerier) DeleteClaimedWorkflowArtifact(ctx context.Context, arg db.DeleteClaimedWorkflowArtifactParams) (db.WorkflowArtifact, error) {
	m.lastDelete = arg
	if m.deleteClaimedWorkflowArtifactFn != nil {
		return m.deleteClaimedWorkflowArtifactFn(ctx, arg)
	}
	return db.WorkflowArtifact{ID: arg.ID, RepositoryID: arg.RepositoryID, WorkflowRunID: arg.WorkflowRunID, Name: arg.Name, GcsKey: arg.GcsKey, Status: "deleting"}, nil
}

func (m *mockWorkflowArtifactQuerier) ListPrunableWorkflowArtifacts(ctx context.Context, arg db.ListPrunableWorkflowArtifactsParams) ([]db.WorkflowArtifact, error) {
	m.lastPrune = arg
	if m.listPrunableWorkflowArtifactsFn != nil {
		return m.listPrunableWorkflowArtifactsFn(ctx, arg)
	}
	return nil, nil
}

func (m *mockWorkflowArtifactQuerier) AttachWorkflowArtifactToRelease(ctx context.Context, arg db.AttachWorkflowArtifactToReleaseParams) (db.WorkflowArtifact, error) {
	if m.attachWorkflowArtifactToReleaseFn != nil {
		return m.attachWorkflowArtifactToReleaseFn(ctx, arg)
	}
	return db.WorkflowArtifact{}, nil
}

func workflowArtifactRun() db.WorkflowRun {
	return db.WorkflowRun{
		ID:               55,
		RepositoryID:     101,
		Status:           "running",
		TriggerRef:       "refs/heads/main",
		TriggerCommitSha: "abc123",
	}
}

type mockArtifactWorkflowRunService struct {
	dispatchFn    func(ctx context.Context, input DispatchForEventInput) ([]WorkflowRunResult, error)
	dispatchCalls []DispatchForEventInput
}

func (m *mockArtifactWorkflowRunService) DispatchForEvent(ctx context.Context, input DispatchForEventInput) ([]WorkflowRunResult, error) {
	m.dispatchCalls = append(m.dispatchCalls, input)
	if m.dispatchFn != nil {
		return m.dispatchFn(ctx, input)
	}
	return nil, nil
}

func (m *mockArtifactWorkflowRunService) CancelRun(ctx context.Context, repositoryID, runID int64) error {
	return nil
}

func (m *mockArtifactWorkflowRunService) RerunRun(ctx context.Context, input RerunInput) (*WorkflowRunResult, error) {
	return nil, nil
}

func (m *mockArtifactWorkflowRunService) ResumeRun(_ context.Context, _, _ int64) error {
	return nil
}

func TestWorkflowArtifactService_IssueUploadURL_UsesDefaultRetention(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, 3, 10, 15, 0, 0, 0, time.UTC)
	queries := &mockWorkflowArtifactQuerier{}
	svc := NewWorkflowArtifactService(queries, &mockBlobStore{}, 5*time.Minute).(*workflowArtifactService)
	svc.now = func() time.Time { return now }

	result, err := svc.IssueUploadURL(context.Background(), workflowArtifactRun(), WorkflowArtifactUploadInput{
		Name:        "build.tar.gz",
		Size:        1024,
		ContentType: "application/gzip",
	})
	require.NoError(t, err)

	assert.Equal(t, int64(101), queries.lastCreate.RepositoryID)
	assert.Equal(t, int64(55), queries.lastCreate.WorkflowRunID)
	assert.Equal(t, "build.tar.gz", queries.lastCreate.Name)
	assert.Equal(t, now.Add(defaultWorkflowArtifactRetention), queries.lastCreate.ExpiresAt)
	assert.Equal(t, "https://upload", result.UploadURL)
}

func TestWorkflowArtifactService_IssueUploadURL_AllowsZeroSize(t *testing.T) {
	t.Parallel()

	queries := &mockWorkflowArtifactQuerier{}
	svc := NewWorkflowArtifactService(queries, &mockBlobStore{}, time.Minute)

	result, err := svc.IssueUploadURL(context.Background(), workflowArtifactRun(), WorkflowArtifactUploadInput{
		Name: "build.tar.gz",
		Size: 0,
	})
	require.NoError(t, err)
	assert.Equal(t, int64(0), queries.lastCreate.Size)
	assert.NotEmpty(t, result.UploadURL)
}

func TestWorkflowArtifactService_IssueUploadURL_RejectsOversizeArtifact(t *testing.T) {
	t.Parallel()

	createCalled := false
	queries := &mockWorkflowArtifactQuerier{
		createWorkflowArtifactFn: func(ctx context.Context, arg db.CreateWorkflowArtifactParams) (db.WorkflowArtifact, error) {
			createCalled = true
			return db.WorkflowArtifact{}, nil
		},
	}
	svc := NewWorkflowArtifactService(queries, &mockBlobStore{}, time.Minute)

	_, err := svc.IssueUploadURL(context.Background(), workflowArtifactRun(), WorkflowArtifactUploadInput{
		Name: "build.tar.gz",
		Size: MaxWorkflowArtifactUploadSizeBytes + 1,
	})
	require.Error(t, err)
	assert.Equal(t, 422, apiStatus(t, err))
	assert.False(t, createCalled)

	apiErr, ok := err.(*pkgerrors.APIError)
	require.True(t, ok)
	require.Len(t, apiErr.Errors, 1)
	assert.Equal(t, pkgerrors.FieldError{
		Resource: "WorkflowArtifact",
		Field:    "size",
		Code:     "invalid",
	}, apiErr.Errors[0])
}

func TestWorkflowArtifactService_ConfirmUpload_RequiresBlob(t *testing.T) {
	t.Parallel()

	queries := &mockWorkflowArtifactQuerier{
		getWorkflowArtifactByNameFn: func(ctx context.Context, arg db.GetWorkflowArtifactByNameParams) (db.WorkflowArtifact, error) {
			return db.WorkflowArtifact{
				ID:            1,
				RepositoryID:  101,
				WorkflowRunID: arg.WorkflowRunID,
				Name:          arg.Name,
				Status:        "pending",
				GcsKey:        "repos/101/runs/55/artifacts/1/build.tar.gz",
			}, nil
		},
	}
	svc := NewWorkflowArtifactService(queries, &mockBlobStore{
		statFn: func(ctx context.Context, key string) (blob.ObjectAttrs, error) {
			return blob.ObjectAttrs{}, blob.ErrObjectNotFound
		},
	}, time.Minute)

	_, err := svc.ConfirmUpload(context.Background(), workflowArtifactRun(), "build.tar.gz", "")
	assert.Equal(t, 400, apiStatus(t, err))
}

func TestWorkflowArtifactService_ConfirmUpload_RejectsSizeMismatch(t *testing.T) {
	t.Parallel()

	confirmCalled := false
	queries := &mockWorkflowArtifactQuerier{
		getWorkflowArtifactByNameFn: func(ctx context.Context, arg db.GetWorkflowArtifactByNameParams) (db.WorkflowArtifact, error) {
			return db.WorkflowArtifact{
				ID:            1,
				RepositoryID:  101,
				WorkflowRunID: arg.WorkflowRunID,
				Name:          arg.Name,
				Size:          128,
				Status:        "pending",
				GcsKey:        "repos/101/runs/55/artifacts/1/build.tar.gz",
			}, nil
		},
		confirmWorkflowArtifactUploadFn: func(ctx context.Context, arg db.ConfirmWorkflowArtifactUploadParams) (db.WorkflowArtifact, error) {
			confirmCalled = true
			return db.WorkflowArtifact{}, nil
		},
	}
	svc := NewWorkflowArtifactService(queries, &mockBlobStore{
		statFn: func(ctx context.Context, key string) (blob.ObjectAttrs, error) {
			return blob.ObjectAttrs{Size: 256}, nil
		},
	}, time.Minute)

	_, err := svc.ConfirmUpload(context.Background(), workflowArtifactRun(), "build.tar.gz", "")
	require.Error(t, err)
	assert.Equal(t, 400, apiStatus(t, err))
	assert.False(t, confirmCalled)
}

func TestWorkflowArtifactService_ConfirmUpload_RejectsUnknownBlobSize(t *testing.T) {
	t.Parallel()

	confirmCalled := false
	queries := &mockWorkflowArtifactQuerier{
		getWorkflowArtifactByNameFn: func(ctx context.Context, arg db.GetWorkflowArtifactByNameParams) (db.WorkflowArtifact, error) {
			return db.WorkflowArtifact{
				ID:            1,
				RepositoryID:  101,
				WorkflowRunID: arg.WorkflowRunID,
				Name:          arg.Name,
				Size:          128,
				Status:        "pending",
				GcsKey:        "repos/101/runs/55/artifacts/1/build.tar.gz",
			}, nil
		},
		confirmWorkflowArtifactUploadFn: func(ctx context.Context, arg db.ConfirmWorkflowArtifactUploadParams) (db.WorkflowArtifact, error) {
			confirmCalled = true
			return db.WorkflowArtifact{}, nil
		},
	}
	svc := NewWorkflowArtifactService(queries, &mockBlobStore{
		statFn: func(ctx context.Context, key string) (blob.ObjectAttrs, error) {
			return blob.ObjectAttrs{Size: blob.UnknownObjectSize}, nil
		},
	}, time.Minute)

	_, err := svc.ConfirmUpload(context.Background(), workflowArtifactRun(), "build.tar.gz", "")
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))
	assert.False(t, confirmCalled)
}

func TestWorkflowArtifactService_ConfirmUpload_AllowsUnknownBlobSizeForMemoryStore(t *testing.T) {
	t.Parallel()

	store := blob.NewMemoryStore()
	_, err := store.SignedUploadURL(context.Background(), "repos/101/runs/55/artifacts/1/build.tar.gz", "application/gzip", 0, time.Minute)
	require.NoError(t, err)

	queries := &mockWorkflowArtifactQuerier{
		getWorkflowArtifactByNameFn: func(ctx context.Context, arg db.GetWorkflowArtifactByNameParams) (db.WorkflowArtifact, error) {
			return db.WorkflowArtifact{
				ID:            1,
				RepositoryID:  101,
				WorkflowRunID: arg.WorkflowRunID,
				Name:          arg.Name,
				Size:          128,
				Status:        "pending",
				GcsKey:        "repos/101/runs/55/artifacts/1/build.tar.gz",
			}, nil
		},
	}

	artifact, err := NewWorkflowArtifactService(queries, store, time.Minute).ConfirmUpload(context.Background(), workflowArtifactRun(), "build.tar.gz", "")
	require.NoError(t, err)
	assert.Equal(t, "ready", artifact.Status)
}

func TestWorkflowArtifactService_ConfirmUpload_DispatchesWebhookAndTrigger(t *testing.T) {
	t.Parallel()

	dispatcher := &mockWorkflowRunDispatcher{}
	workflowRuns := &mockArtifactWorkflowRunService{}
	confirmedAt := time.Date(2026, time.March, 10, 12, 1, 0, 0, time.UTC)

	queries := &mockWorkflowArtifactQuerier{
		getWorkflowArtifactByNameFn: func(ctx context.Context, arg db.GetWorkflowArtifactByNameParams) (db.WorkflowArtifact, error) {
			return db.WorkflowArtifact{
				ID:            1,
				RepositoryID:  101,
				WorkflowRunID: arg.WorkflowRunID,
				Name:          arg.Name,
				Size:          128,
				Status:        "pending",
				GcsKey:        "repos/101/runs/55/artifacts/1/build.tar.gz",
			}, nil
		},
		confirmWorkflowArtifactUploadFn: func(ctx context.Context, arg db.ConfirmWorkflowArtifactUploadParams) (db.WorkflowArtifact, error) {
			return db.WorkflowArtifact{
				ID:            1,
				RepositoryID:  101,
				WorkflowRunID: arg.WorkflowRunID,
				Name:          arg.Name,
				Size:          128,
				ContentType:   "application/gzip",
				Status:        "ready",
				ConfirmedAt:   pgtype.Timestamptz{Time: confirmedAt, Valid: true},
				CreatedAt:     confirmedAt.Add(-time.Minute),
				UpdatedAt:     confirmedAt,
			}, nil
		},
		getWorkflowDefinitionNameByRunIDFn: func(ctx context.Context, workflowRunID int64) (string, error) {
			require.Equal(t, int64(55), workflowRunID)
			return "Research", nil
		},
	}

	svc := NewWorkflowArtifactService(
		queries,
		&mockBlobStore{
			statFn: func(ctx context.Context, key string) (blob.ObjectAttrs, error) {
				return blob.ObjectAttrs{Size: 128}, nil
			},
		},
		time.Minute,
		WithWorkflowArtifactWebhookDispatcher(dispatcher),
		WithWorkflowArtifactWorkflowRunService(workflowRuns),
	)

	artifact, err := svc.ConfirmUpload(context.Background(), workflowArtifactRun(), "build.tar.gz", "")
	require.NoError(t, err)
	assert.Equal(t, "ready", artifact.Status)

	require.Len(t, dispatcher.calls, 1)
	assert.Equal(t, int64(101), dispatcher.calls[0].repoID)
	assert.Equal(t, string(webhooks.EventTypeWorkflowArtifact), dispatcher.calls[0].eventType)
	payload, ok := dispatcher.calls[0].payload.(webhooks.WorkflowArtifactEventPayload)
	require.True(t, ok)
	assert.Equal(t, "ready", payload.Action)
	assert.Equal(t, "build.tar.gz", payload.Artifact.Name)
	assert.Equal(t, "Research", payload.Artifact.SourceWorkflow)

	require.Len(t, workflowRuns.dispatchCalls, 1)
	dispatchCall := workflowRuns.dispatchCalls[0]
	assert.Equal(t, int64(101), dispatchCall.RepositoryID)
	assert.Equal(t, "workflow_artifact", dispatchCall.Event.Type)
	assert.Equal(t, "ready", dispatchCall.Event.Action)
	assert.Equal(t, "build.tar.gz", dispatchCall.Event.ArtifactName)
	assert.Equal(t, "Research", dispatchCall.Event.SourceWorkflow)
	assert.Equal(t, "refs/heads/main", dispatchCall.Event.Ref)
	assert.Equal(t, "abc123", dispatchCall.Event.CommitSHA)
}

// confirmCommitTrackingBilling mirrors production StorageCommitAuthorizer
// semantics closely enough to assert "committed" bytes only ever reflect a
// commit callback that actually succeeded, never one that lost a CAS race.
type confirmCommitTrackingBilling struct {
	committedBytes int64
	committedCalls int
}

func (b *confirmCommitTrackingBilling) AuthorizePrivateRepo(context.Context, string, int64) error {
	return nil
}
func (b *confirmCommitTrackingBilling) AuthorizeWorkflowDispatch(context.Context, int64) error {
	return nil
}
func (b *confirmCommitTrackingBilling) AuthorizeAgentRunCommitted(ctx context.Context, _ int64, commit func(context.Context, db.DBTX) error) error {
	return commit(ctx, nil)
}
func (b *confirmCommitTrackingBilling) AuthorizeStorageIncrease(context.Context, int64, int64) error {
	return nil
}
func (b *confirmCommitTrackingBilling) AuthorizePairing(context.Context, int64) error { return nil }
func (b *confirmCommitTrackingBilling) AuthorizeStorageIncreaseCommitted(ctx context.Context, _, additionalBytes int64, commit func(ctx context.Context) error) error {
	if err := commit(ctx); err != nil {
		return err
	}
	b.committedBytes += additionalBytes
	b.committedCalls++
	return nil
}

func TestWorkflowArtifactService_ConfirmUpload_LoserOfCASReturnsWinnerWithoutSideEffects(t *testing.T) {
	t.Parallel()

	dispatcher := &mockWorkflowRunDispatcher{}
	workflowRuns := &mockArtifactWorkflowRunService{}
	billing := &confirmCommitTrackingBilling{}

	lookupCalls := 0
	queries := &mockWorkflowArtifactQuerier{
		getWorkflowArtifactByNameFn: func(ctx context.Context, arg db.GetWorkflowArtifactByNameParams) (db.WorkflowArtifact, error) {
			lookupCalls++
			if lookupCalls == 1 {
				return db.WorkflowArtifact{
					ID:            1,
					RepositoryID:  101,
					WorkflowRunID: arg.WorkflowRunID,
					Name:          arg.Name,
					Size:          128,
					Status:        "pending",
					GcsKey:        "repos/101/runs/55/artifacts/1/build.tar.gz",
				}, nil
			}
			// A concurrent caller already won the CAS and confirmed the artifact.
			return db.WorkflowArtifact{
				ID:            1,
				RepositoryID:  101,
				WorkflowRunID: arg.WorkflowRunID,
				Name:          arg.Name,
				Size:          128,
				ContentType:   "application/gzip",
				Status:        "ready",
				GcsKey:        "repos/101/runs/55/artifacts/1/build.tar.gz",
			}, nil
		},
		confirmWorkflowArtifactUploadFn: func(ctx context.Context, arg db.ConfirmWorkflowArtifactUploadParams) (db.WorkflowArtifact, error) {
			// The pending -> ready compare-and-swap loses the race.
			return db.WorkflowArtifact{}, pgx.ErrNoRows
		},
	}

	svc := NewWorkflowArtifactService(
		queries,
		&mockBlobStore{
			statFn: func(ctx context.Context, key string) (blob.ObjectAttrs, error) {
				return blob.ObjectAttrs{Size: 128}, nil
			},
		},
		time.Minute,
		WithWorkflowArtifactBillingPolicy(billing),
		WithWorkflowArtifactWebhookDispatcher(dispatcher),
		WithWorkflowArtifactWorkflowRunService(workflowRuns),
	)

	artifact, err := svc.ConfirmUpload(context.Background(), workflowArtifactRun(), "build.tar.gz", "")
	require.NoError(t, err)
	assert.Equal(t, "ready", artifact.Status)
	assert.Equal(t, int64(1), artifact.ID)

	assert.Equal(t, 2, lookupCalls, "loser must re-fetch the winner's row exactly once")
	assert.Empty(t, dispatcher.calls, "the CAS loser must not re-dispatch the artifact webhook")
	assert.Empty(t, workflowRuns.dispatchCalls, "the CAS loser must not re-dispatch downstream triggers")
	assert.Equal(t, int64(0), billing.committedBytes, "the CAS loser must not double-meter billing bytes")
	assert.Equal(t, 0, billing.committedCalls)
}

func TestWorkflowArtifactService_ConfirmUpload_RejectsOversizeBlob(t *testing.T) {
	t.Parallel()

	confirmCalled := false
	queries := &mockWorkflowArtifactQuerier{
		getWorkflowArtifactByNameFn: func(ctx context.Context, arg db.GetWorkflowArtifactByNameParams) (db.WorkflowArtifact, error) {
			return db.WorkflowArtifact{
				ID:            1,
				RepositoryID:  101,
				WorkflowRunID: arg.WorkflowRunID,
				Name:          arg.Name,
				Size:          MaxWorkflowArtifactUploadSizeBytes - 1,
				Status:        "pending",
				GcsKey:        "repos/101/runs/55/artifacts/1/build.tar.gz",
			}, nil
		},
		confirmWorkflowArtifactUploadFn: func(ctx context.Context, arg db.ConfirmWorkflowArtifactUploadParams) (db.WorkflowArtifact, error) {
			confirmCalled = true
			return db.WorkflowArtifact{}, nil
		},
	}
	svc := NewWorkflowArtifactService(queries, &mockBlobStore{
		statFn: func(ctx context.Context, key string) (blob.ObjectAttrs, error) {
			return blob.ObjectAttrs{Size: MaxWorkflowArtifactUploadSizeBytes + 1}, nil
		},
	}, time.Minute)

	_, err := svc.ConfirmUpload(context.Background(), workflowArtifactRun(), "build.tar.gz", "")
	require.Error(t, err)
	assert.Equal(t, 400, apiStatus(t, err))
	assert.False(t, confirmCalled)
}

func TestWorkflowArtifactService_ListArtifacts_FiltersPendingRows(t *testing.T) {
	t.Parallel()

	queries := &mockWorkflowArtifactQuerier{
		getWorkflowRunFn: func(ctx context.Context, arg db.GetWorkflowRunParams) (db.WorkflowRun, error) {
			return workflowArtifactRun(), nil
		},
		listWorkflowArtifactsByRunFn: func(ctx context.Context, workflowRunID int64) ([]db.WorkflowArtifact, error) {
			return []db.WorkflowArtifact{
				{ID: 1, RepositoryID: 101, WorkflowRunID: workflowRunID, Name: "ready.txt", Status: "ready"},
				{ID: 2, RepositoryID: 101, WorkflowRunID: workflowRunID, Name: "pending.txt", Status: "pending"},
			}, nil
		},
	}
	svc := NewWorkflowArtifactService(queries, &mockBlobStore{}, time.Minute)

	artifacts, err := svc.ListArtifacts(context.Background(), 101, 55)
	require.NoError(t, err)
	require.Len(t, artifacts, 1)
	assert.Equal(t, "ready.txt", artifacts[0].Name)
}

func TestWorkflowArtifactService_DeleteArtifact_RemovesBlobAndMetadata(t *testing.T) {
	t.Parallel()

	var deletedKey string
	queries := &mockWorkflowArtifactQuerier{
		getWorkflowRunFn: func(ctx context.Context, arg db.GetWorkflowRunParams) (db.WorkflowRun, error) {
			return workflowArtifactRun(), nil
		},
		getWorkflowArtifactByNameFn: func(ctx context.Context, arg db.GetWorkflowArtifactByNameParams) (db.WorkflowArtifact, error) {
			return db.WorkflowArtifact{
				ID:            1,
				RepositoryID:  101,
				WorkflowRunID: arg.WorkflowRunID,
				Name:          arg.Name,
				Status:        "ready",
				GcsKey:        "repos/101/runs/55/artifacts/1/build.tar.gz",
			}, nil
		},
	}
	svc := NewWorkflowArtifactService(queries, &mockBlobStore{
		deleteFn: func(ctx context.Context, key string) error {
			deletedKey = key
			return nil
		},
	}, time.Minute)

	err := svc.DeleteArtifact(context.Background(), 101, 55, "build.tar.gz")
	require.NoError(t, err)
	assert.Equal(t, "repos/101/runs/55/artifacts/1/build.tar.gz", deletedKey)
	assert.Equal(t, int64(55), queries.lastDelete.WorkflowRunID)
	assert.Equal(t, "build.tar.gz", queries.lastDelete.Name)
}

func TestWorkflowArtifactService_DeleteArtifact_IgnoresMissingBlob(t *testing.T) {
	t.Parallel()

	queries := &mockWorkflowArtifactQuerier{
		getWorkflowRunFn: func(ctx context.Context, arg db.GetWorkflowRunParams) (db.WorkflowRun, error) {
			return workflowArtifactRun(), nil
		},
		getWorkflowArtifactByNameFn: func(ctx context.Context, arg db.GetWorkflowArtifactByNameParams) (db.WorkflowArtifact, error) {
			return db.WorkflowArtifact{
				ID:            1,
				RepositoryID:  101,
				WorkflowRunID: arg.WorkflowRunID,
				Name:          arg.Name,
				Status:        "ready",
				GcsKey:        "repos/101/runs/55/artifacts/1/build.tar.gz",
			}, nil
		},
	}
	svc := NewWorkflowArtifactService(queries, &mockBlobStore{
		deleteFn: func(ctx context.Context, key string) error {
			return blob.ErrObjectNotFound
		},
	}, time.Minute)

	err := svc.DeleteArtifact(context.Background(), 101, 55, "build.tar.gz")
	require.NoError(t, err)
	assert.Equal(t, int64(55), queries.lastDelete.WorkflowRunID)
	assert.Equal(t, "build.tar.gz", queries.lastDelete.Name)
}

func TestWorkflowArtifactService_IssueUploadURL_PreservesExistingArtifact(t *testing.T) {
	t.Parallel()

	deleteCalls := 0
	createCalls := 0
	queries := &mockWorkflowArtifactQuerier{
		getWorkflowArtifactByNameFn: func(ctx context.Context, arg db.GetWorkflowArtifactByNameParams) (db.WorkflowArtifact, error) {
			return db.WorkflowArtifact{
				ID:            7,
				RepositoryID:  101,
				WorkflowRunID: arg.WorkflowRunID,
				Name:          arg.Name,
				Status:        "ready",
				GcsKey:        "repos/101/runs/55/artifacts/7/build.tar.gz",
			}, nil
		},
		createWorkflowArtifactFn: func(context.Context, db.CreateWorkflowArtifactParams) (db.WorkflowArtifact, error) {
			createCalls++
			return db.WorkflowArtifact{}, nil
		},
	}
	svc := NewWorkflowArtifactService(queries, &mockBlobStore{
		deleteFn: func(ctx context.Context, key string) error {
			deleteCalls++
			return nil
		},
		signedUploadURLFn: func(context.Context, string, string, int64, time.Duration) (string, error) {
			t.Fatal("replacement must be rejected before signing")
			return "", nil
		},
	}, time.Minute)

	_, err := svc.IssueUploadURL(context.Background(), workflowArtifactRun(), WorkflowArtifactUploadInput{
		Name: "build.tar.gz",
		Size: 64,
	})
	require.Error(t, err)
	assert.Equal(t, 409, apiStatus(t, err))
	assert.Zero(t, createCalls)
	assert.Zero(t, deleteCalls, "existing artifact bytes must survive a rejected replacement")
}

func TestWorkflowArtifactService_PruneExpired_ContinuesOnBlobDeleteFailures(t *testing.T) {
	t.Parallel()

	queries := &mockWorkflowArtifactQuerier{
		listPrunableWorkflowArtifactsFn: func(ctx context.Context, arg db.ListPrunableWorkflowArtifactsParams) ([]db.WorkflowArtifact, error) {
			return []db.WorkflowArtifact{
				{
					ID:            7,
					RepositoryID:  101,
					WorkflowRunID: 55,
					Name:          "expired.txt",
					GcsKey:        "repos/101/runs/55/artifacts/7/expired.txt",
					Status:        "ready",
				},
			}, nil
		},
		getWorkflowArtifactByNameFn: func(context.Context, db.GetWorkflowArtifactByNameParams) (db.WorkflowArtifact, error) {
			return db.WorkflowArtifact{
				ID: 7, RepositoryID: 101, WorkflowRunID: 55, Name: "expired.txt",
				GcsKey: "repos/101/runs/55/artifacts/7/expired.txt", Status: "ready",
			}, nil
		},
	}
	svc := NewWorkflowArtifactService(queries, &mockBlobStore{
		deleteFn: func(ctx context.Context, key string) error {
			return errors.New("boom")
		},
	}, time.Minute).(*workflowArtifactService)
	svc.now = func() time.Time {
		return time.Date(2026, 3, 10, 12, 0, 0, 0, time.UTC)
	}

	deleted, err := svc.PruneExpired(context.Background(), 10)
	require.Error(t, err)
	assert.Equal(t, 0, deleted, "metadata remains metered when physical deletion fails")
	assert.Equal(t, int32(10), queries.lastPrune.LimitRows)
}

func TestWorkflowArtifactService_DeleteArtifact_ClaimsThenDeletesBlobBeforeMetadata(t *testing.T) {
	t.Parallel()

	// The deleting claim fences confirmation/replacement. Metadata remains
	// metered until the fallible physical deletion succeeds.
	var ops []string
	var mu sync.Mutex
	queries := &mockWorkflowArtifactQuerier{
		getWorkflowRunFn: func(ctx context.Context, arg db.GetWorkflowRunParams) (db.WorkflowRun, error) {
			return workflowArtifactRun(), nil
		},
		getWorkflowArtifactByNameFn: func(ctx context.Context, arg db.GetWorkflowArtifactByNameParams) (db.WorkflowArtifact, error) {
			return db.WorkflowArtifact{
				ID:            1,
				RepositoryID:  101,
				WorkflowRunID: arg.WorkflowRunID,
				Name:          arg.Name,
				Status:        "ready",
				GcsKey:        "repos/101/runs/55/artifacts/1/build.tar.gz",
			}, nil
		},
		claimWorkflowArtifactDeletionFn: func(ctx context.Context, arg db.ClaimWorkflowArtifactDeletionParams) (db.WorkflowArtifact, error) {
			mu.Lock()
			ops = append(ops, "claim")
			mu.Unlock()
			return db.WorkflowArtifact{ID: arg.ID, RepositoryID: arg.RepositoryID, WorkflowRunID: arg.WorkflowRunID, Name: arg.Name, GcsKey: arg.GcsKey, Status: "deleting"}, nil
		},
		deleteClaimedWorkflowArtifactFn: func(ctx context.Context, arg db.DeleteClaimedWorkflowArtifactParams) (db.WorkflowArtifact, error) {
			mu.Lock()
			ops = append(ops, "metadata")
			mu.Unlock()
			return db.WorkflowArtifact{ID: arg.ID}, nil
		},
	}
	svc := NewWorkflowArtifactService(queries, &mockBlobStore{
		deleteFn: func(ctx context.Context, key string) error {
			mu.Lock()
			ops = append(ops, "blob:"+key)
			mu.Unlock()
			return nil
		},
	}, time.Minute)

	err := svc.DeleteArtifact(context.Background(), 101, 55, "build.tar.gz")
	require.NoError(t, err)
	finalKey := "repos/101/runs/55/artifacts/1/build.tar.gz"
	require.Equal(t, []string{
		"claim",
		"blob:" + blob.PendingUploadKey("workflow-artifacts", finalKey),
		"blob:" + finalKey,
		"metadata",
	}, ops)
}

func TestWorkflowArtifactService_ConfirmUpload_VerifiesSHA256WhenDeclared(t *testing.T) {
	t.Parallel()

	const content = "hello artifact"

	// Compute the expected SHA256 of the content.
	h := sha256.Sum256([]byte(content))
	correctHash := hex.EncodeToString(h[:])

	makeStore := func() *mockBlobStore {
		return &mockBlobStore{
			statFn: func(ctx context.Context, key string) (blob.ObjectAttrs, error) {
				return blob.ObjectAttrs{Size: int64(len(content))}, nil
			},
			newReaderFn: func(ctx context.Context, key string) (io.ReadCloser, error) {
				return io.NopCloser(strings.NewReader(content)), nil
			},
		}
	}

	makeQueries := func(id int64) *mockWorkflowArtifactQuerier {
		return &mockWorkflowArtifactQuerier{
			getWorkflowArtifactByNameFn: func(ctx context.Context, arg db.GetWorkflowArtifactByNameParams) (db.WorkflowArtifact, error) {
				return db.WorkflowArtifact{
					ID:            id,
					RepositoryID:  101,
					WorkflowRunID: arg.WorkflowRunID,
					Name:          arg.Name,
					Size:          int64(len(content)),
					Status:        "pending",
					GcsKey:        "repos/101/runs/55/artifacts/1/build.tar.gz",
				}, nil
			},
		}
	}

	// Correct hash: should succeed.
	svc := NewWorkflowArtifactService(makeQueries(1), makeStore(), time.Minute)
	artifact, err := svc.ConfirmUpload(context.Background(), workflowArtifactRun(), "build.tar.gz", correctHash)
	require.NoError(t, err)
	assert.Equal(t, "ready", artifact.Status)

	// Wrong hash: should fail with 400.
	svc2 := NewWorkflowArtifactService(makeQueries(2), makeStore(), time.Minute)
	_, err = svc2.ConfirmUpload(context.Background(), workflowArtifactRun(), "build.tar.gz", "deadbeefdeadbeef")
	require.Error(t, err)
	assert.Equal(t, 400, apiStatus(t, err))

	// No hash declared: should succeed without reading blob.
	readCalled := false
	noHashStore := &mockBlobStore{
		statFn: func(ctx context.Context, key string) (blob.ObjectAttrs, error) {
			return blob.ObjectAttrs{Size: int64(len(content))}, nil
		},
		newReaderFn: func(ctx context.Context, key string) (io.ReadCloser, error) {
			readCalled = true
			return io.NopCloser(strings.NewReader(content)), nil
		},
	}
	svc3 := NewWorkflowArtifactService(makeQueries(3), noHashStore, time.Minute)
	_, err = svc3.ConfirmUpload(context.Background(), workflowArtifactRun(), "build.tar.gz", "")
	require.NoError(t, err)
	assert.False(t, readCalled, "blob content must not be read when no SHA256 is declared")
}

func TestWorkflowArtifactService_IssueUploadURL_RejectsOversizeArtifactWithCustomLimit(t *testing.T) {
	t.Parallel()

	const customLimitBytes int64 = 512
	createCalled := false
	queries := &mockWorkflowArtifactQuerier{
		createWorkflowArtifactFn: func(ctx context.Context, arg db.CreateWorkflowArtifactParams) (db.WorkflowArtifact, error) {
			createCalled = true
			return db.WorkflowArtifact{}, nil
		},
	}
	svc := NewWorkflowArtifactService(queries, &mockBlobStore{}, time.Minute,
		WithWorkflowArtifactMaxUploadSize(customLimitBytes),
	)

	// Exactly at limit: OK.
	_, err := svc.IssueUploadURL(context.Background(), workflowArtifactRun(), WorkflowArtifactUploadInput{
		Name: "small.bin",
		Size: customLimitBytes,
	})
	require.NoError(t, err)

	// One byte over: rejected.
	createCalled = false
	_, err = svc.IssueUploadURL(context.Background(), workflowArtifactRun(), WorkflowArtifactUploadInput{
		Name: "big.bin",
		Size: customLimitBytes + 1,
	})
	require.Error(t, err)
	assert.Equal(t, 422, apiStatus(t, err))
	assert.False(t, createCalled)
}

func (*confirmCommitTrackingBilling) AuthorizeSandboxStart(context.Context, int64) error {
	return nil
}
func (*confirmCommitTrackingBilling) SandboxEntitlement(context.Context, int64) (SandboxEntitlement, error) {
	return SandboxEntitlement{}, nil
}
