package services

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/blob"
	"github.com/smithersai/smithers/packages/backend/internal/db"
)

type finalizerBarrierBilling struct {
	beforeResolve func()

	mu          sync.Mutex
	deltas      []int64
	commitCalls int
}

func (*finalizerBarrierBilling) AuthorizePrivateRepo(context.Context, string, int64) error {
	return nil
}
func (*finalizerBarrierBilling) AuthorizeWorkflowDispatch(context.Context, int64) error {
	return nil
}
func (*finalizerBarrierBilling) AuthorizeAgentRunCommitted(ctx context.Context, _ int64, commit func(context.Context, db.DBTX) error) error {
	return commit(ctx, nil)
}
func (*finalizerBarrierBilling) AuthorizeStorageIncrease(context.Context, int64, int64) error {
	return nil
}
func (*finalizerBarrierBilling) AuthorizePairing(context.Context, int64) error { return nil }

func (p *finalizerBarrierBilling) AuthorizeStorageIncreaseCommittedDynamic(
	ctx context.Context,
	_ int64,
	resolve func(context.Context) (int64, error),
	commit func(context.Context) error,
) error {
	if p.beforeResolve != nil {
		p.beforeResolve()
	}
	delta, err := resolve(ctx)
	if err != nil {
		return err
	}
	p.mu.Lock()
	p.deltas = append(p.deltas, delta)
	p.commitCalls++
	p.mu.Unlock()
	return commit(ctx)
}

func (p *finalizerBarrierBilling) snapshot() ([]int64, int) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]int64(nil), p.deltas...), p.commitCalls
}

func TestWorkflowArtifactConfirm_ReplacementAtOwnerLockBarrierIsRejected(t *testing.T) {
	t.Parallel()

	captured := db.WorkflowArtifact{
		ID: 1, RepositoryID: 101, WorkflowRunID: 55, Name: "build.tar.gz",
		Size: 64, Status: "pending", GcsKey: "repos/101/runs/55/artifacts/1/build.tar.gz",
	}
	replacement := captured
	replacement.ID = 2
	replacement.Size = 1 << 30
	replacement.GcsKey = "repos/101/runs/55/artifacts/2/build.tar.gz"

	var stateMu sync.Mutex
	current := captured
	confirmCalled := false
	queries := &mockWorkflowArtifactQuerier{
		getWorkflowArtifactByNameFn: func(context.Context, db.GetWorkflowArtifactByNameParams) (db.WorkflowArtifact, error) {
			stateMu.Lock()
			defer stateMu.Unlock()
			return current, nil
		},
		confirmWorkflowArtifactUploadFn: func(context.Context, db.ConfirmWorkflowArtifactUploadParams) (db.WorkflowArtifact, error) {
			confirmCalled = true
			return replacement, nil
		},
	}

	barrierReached := make(chan struct{})
	releaseBarrier := make(chan struct{})
	policy := &finalizerBarrierBilling{beforeResolve: func() {
		close(barrierReached)
		<-releaseBarrier
	}}
	svc := NewWorkflowArtifactService(queries, &mockBlobStore{
		statFn: func(context.Context, string) (blob.ObjectAttrs, error) {
			return blob.ObjectAttrs{Size: captured.Size}, nil
		},
	}, time.Minute, WithWorkflowArtifactBillingPolicy(policy))

	type result struct {
		artifact db.WorkflowArtifact
		err      error
	}
	resultCh := make(chan result, 1)
	go func() {
		artifact, err := svc.ConfirmUpload(context.Background(), workflowArtifactRun(), captured.Name, "")
		resultCh <- result{artifact: artifact, err: err}
	}()

	select {
	case <-barrierReached:
	case <-time.After(2 * time.Second):
		t.Fatal("confirmation did not reach the owner-lock resolver barrier")
	}
	stateMu.Lock()
	current = replacement
	stateMu.Unlock()
	close(releaseBarrier)

	got := <-resultCh
	require.Error(t, got.err)
	assert.Equal(t, 409, apiStatus(t, got.err))
	assert.False(t, confirmCalled)
	deltas, commits := policy.snapshot()
	assert.Empty(t, deltas)
	assert.Zero(t, commits)
}

func TestArtifactFinalizers_ForwardExactReservationCASAndResolveZeroDelta(t *testing.T) {
	t.Run("workflow", func(t *testing.T) {
		captured := db.WorkflowArtifact{
			ID: 3, RepositoryID: 101, WorkflowRunID: 55, Name: "build.tar.gz",
			Size: 64, Status: "pending", GcsKey: "repos/101/runs/55/artifacts/3/build.tar.gz",
		}
		policy := &finalizerBarrierBilling{}
		queries := &mockWorkflowArtifactQuerier{
			getWorkflowArtifactByNameFn: func(context.Context, db.GetWorkflowArtifactByNameParams) (db.WorkflowArtifact, error) {
				return captured, nil
			},
			confirmWorkflowArtifactUploadFn: func(_ context.Context, arg db.ConfirmWorkflowArtifactUploadParams) (db.WorkflowArtifact, error) {
				assert.Equal(t, captured.ID, arg.ID)
				assert.Equal(t, captured.RepositoryID, arg.RepositoryID)
				assert.Equal(t, captured.WorkflowRunID, arg.WorkflowRunID)
				assert.Equal(t, captured.Name, arg.Name)
				assert.Equal(t, captured.GcsKey, arg.GcsKey)
				ready := captured
				ready.Status = "ready"
				return ready, nil
			},
		}
		svc := NewWorkflowArtifactService(queries, &mockBlobStore{
			statFn: func(context.Context, string) (blob.ObjectAttrs, error) {
				return blob.ObjectAttrs{Size: captured.Size}, nil
			},
		}, time.Minute, WithWorkflowArtifactBillingPolicy(policy))
		got, err := svc.ConfirmUpload(context.Background(), workflowArtifactRun(), captured.Name, "")
		require.NoError(t, err)
		assert.Equal(t, "ready", got.Status)
		deltas, commits := policy.snapshot()
		assert.Equal(t, []int64{0}, deltas)
		assert.Equal(t, 1, commits)
	})

}

func TestReleaseAndCacheFinalizers_ConcurrentWinnerResolvesZeroDelta(t *testing.T) {

	t.Run("workflow cache", func(t *testing.T) {
		current := db.WorkflowCache{
			ID: 10, RepositoryID: 42, WorkflowRunID: pgtype.Int8{Int64: 7, Valid: true},
			BookmarkName: "main", CacheKey: "deps", CacheVersion: "v1",
			ObjectKey: "workflow-cache/repos/42/cache.tgz", ObjectSizeBytes: 10, Status: "pending",
			ExpiresAt: time.Now().UTC().Add(time.Hour),
		}
		policy := &finalizerBarrierBilling{beforeResolve: func() {
			current.Status = "finalized"
			current.ObjectSizeBytes = 10
		}}
		finalizeCalled := false
		svc := NewWorkflowCacheService(&mockWorkflowCacheQuerier{
			getWorkflowCacheByIDFn: func(context.Context, int64) (db.WorkflowCache, error) {
				return current, nil
			},
			finalizeWorkflowCacheFn: func(context.Context, db.FinalizeWorkflowCacheParams) (db.WorkflowCache, error) {
				finalizeCalled = true
				return current, nil
			},
			getWorkflowCacheRepoUsageFn: func(context.Context, int64) (int64, error) { return 10, nil },
			listWorkflowCacheEvictionCandidatesFn: func(context.Context, db.ListWorkflowCacheEvictionCandidatesParams) ([]db.WorkflowCache, error) {
				return nil, nil
			},
		}, &mockBlobStore{
			statFn: func(context.Context, string) (blob.ObjectAttrs, error) {
				return blob.ObjectAttrs{Size: 10}, nil
			},
		}, WorkflowCacheConfig{}, WithWorkflowCacheBillingPolicy(policy))
		got, err := svc.FinalizeSave(context.Background(), db.WorkflowRun{ID: 7, RepositoryID: 42}, 10, 10)
		require.NoError(t, err)
		assert.Equal(t, "finalized", got.Status)
		assert.False(t, finalizeCalled)
		deltas, commits := policy.snapshot()
		assert.Equal(t, []int64{0}, deltas)
		assert.Equal(t, 1, commits)
	})
}

func (*finalizerBarrierBilling) AuthorizeSandboxStart(context.Context, int64) error { return nil }
func (*finalizerBarrierBilling) SandboxEntitlement(context.Context, int64) (SandboxEntitlement, error) {
	return SandboxEntitlement{}, nil
}
