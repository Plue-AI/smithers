package services

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/blob"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

type artifactPendingStore struct {
	mu sync.Mutex

	objects map[string][]byte

	signedKey         string
	signedContentType string
	signedMaxSize     int64
	signedExpiry      time.Duration
	signedUpload      blob.SignedUpload

	promoteCalls int
	promoteFn    func(sourceKey, destinationKey string) error
	deleteCalls  []string
	deleteErr    error
}

func newArtifactPendingStore() *artifactPendingStore {
	return &artifactPendingStore{
		objects: make(map[string][]byte),
		signedUpload: blob.SignedUpload{
			URL: "https://upload.example/create-only",
			Header: map[string]string{
				"Content-Type":                "application/octet-stream",
				"x-goog-content-length-range": "0,0",
				"x-goog-if-generation-match":  "0",
			},
		},
	}
}

func (s *artifactPendingStore) SignedCreateOnlyUploadURL(_ context.Context, key, contentType string, exactSizeBytes int64, expiry time.Duration) (blob.SignedUpload, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.signedKey = key
	s.signedContentType = contentType
	s.signedMaxSize = exactSizeBytes
	s.signedExpiry = expiry
	return s.signedUpload, nil
}

func (*artifactPendingStore) SignedUploadURL(context.Context, string, string, int64, time.Duration) (string, error) {
	return "", errors.New("plain artifact upload signing must not be used")
}

func (*artifactPendingStore) SignedDownloadURL(context.Context, string, time.Duration) (string, error) {
	return "https://download.example/artifact", nil
}

func (s *artifactPendingStore) Delete(_ context.Context, key string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.deleteCalls = append(s.deleteCalls, key)
	if s.deleteErr != nil {
		return s.deleteErr
	}
	delete(s.objects, key)
	return nil
}

func (s *artifactPendingStore) Exists(_ context.Context, key string) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, ok := s.objects[key]
	return ok, nil
}

func (s *artifactPendingStore) Stat(_ context.Context, key string) (blob.ObjectAttrs, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	contents, ok := s.objects[key]
	if !ok {
		return blob.ObjectAttrs{}, blob.ErrObjectNotFound
	}
	return blob.ObjectAttrs{Size: int64(len(contents))}, nil
}

func (s *artifactPendingStore) NewReader(_ context.Context, key string) (io.ReadCloser, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	contents, ok := s.objects[key]
	if !ok {
		return nil, blob.ErrObjectNotFound
	}
	return io.NopCloser(strings.NewReader(string(contents))), nil
}

func (s *artifactPendingStore) PromoteCreateOnly(_ context.Context, sourceKey, destinationKey string) error {
	s.mu.Lock()
	s.promoteCalls++
	if s.promoteFn != nil {
		fn := s.promoteFn
		s.mu.Unlock()
		return fn(sourceKey, destinationKey)
	}
	defer s.mu.Unlock()
	contents, ok := s.objects[sourceKey]
	if !ok {
		return blob.ErrObjectNotFound
	}
	if _, exists := s.objects[destinationKey]; exists {
		return blob.ErrObjectAlreadyExists
	}
	s.objects[destinationKey] = append([]byte(nil), contents...)
	delete(s.objects, sourceKey)
	return nil
}

func (s *artifactPendingStore) put(key string, contents []byte) {
	s.mu.Lock()
	s.objects[key] = append([]byte(nil), contents...)
	s.mu.Unlock()
}

func (s *artifactPendingStore) has(key string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, ok := s.objects[key]
	return ok
}

var _ blob.Store = (*artifactPendingStore)(nil)
var _ blob.CreateOnlyUploadSigner = (*artifactPendingStore)(nil)
var _ blob.CreateOnlyPromoter = (*artifactPendingStore)(nil)

type artifactAdmissionBilling struct {
	mu sync.Mutex

	inside bool
	deltas []int64
	limit  int64
	usage  int64
}

func (*artifactAdmissionBilling) AuthorizePrivateRepo(context.Context, string, int64) error {
	return nil
}
func (*artifactAdmissionBilling) AuthorizeWorkflowDispatchCommitted(ctx context.Context, _ int64, commit func(context.Context, pgx.Tx) error) error {
	return commit(ctx, nil)
}
func (*artifactAdmissionBilling) AuthorizeAgentRunCommitted(ctx context.Context, _ int64, commit func(context.Context, db.DBTX) error) error {
	return commit(ctx, nil)
}
func (*artifactAdmissionBilling) AuthorizeStorageIncrease(context.Context, int64, int64) error {
	return nil
}
func (*artifactAdmissionBilling) AuthorizePairing(context.Context, int64) error { return nil }

func (p *artifactAdmissionBilling) AuthorizeStorageIncreaseCommittedDynamic(ctx context.Context, _ int64, resolve func(context.Context) (int64, error), commit func(context.Context) error) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.inside = true
	defer func() { p.inside = false }()
	delta, err := resolve(ctx)
	if err != nil {
		return err
	}
	p.deltas = append(p.deltas, delta)
	if p.limit > 0 && (p.usage > p.limit || delta > p.limit-p.usage) {
		return pkgerrors.Forbidden("storage cap exceeded for the current billing plan")
	}
	if err := commit(ctx); err != nil {
		return err
	}
	p.usage += delta
	return nil
}

func TestWorkflowArtifactIssueUploadURL_ReservesAndSignsExactCreateOnlyAction(t *testing.T) {
	for _, tc := range []struct {
		name string
		size int64
	}{
		{name: "zero", size: 0},
		{name: "nonzero", size: 42},
	} {
		t.Run(tc.name, func(t *testing.T) {
			store := newArtifactPendingStore()
			exactSize := strconv.FormatInt(tc.size, 10)
			store.signedUpload.Header["x-goog-content-length-range"] = exactSize + "," + exactSize
			policy := &artifactAdmissionBilling{}
			q := &mockWorkflowArtifactQuerier{
				createWorkflowArtifactFn: func(_ context.Context, arg db.CreateWorkflowArtifactParams) (db.WorkflowArtifact, error) {
					assert.True(t, policy.inside)
					return db.WorkflowArtifact{
						ID: 9, RepositoryID: arg.RepositoryID, WorkflowRunID: arg.WorkflowRunID,
						Name: arg.Name, Size: arg.Size, ContentType: arg.ContentType, Status: "pending",
						GcsKey: "repos/101/runs/55/artifacts/9/" + arg.Name,
					}, nil
				},
			}
			svc := NewWorkflowArtifactService(q, store, 3*time.Minute, WithWorkflowArtifactBillingPolicy(policy))

			result, err := svc.IssueUploadURL(context.Background(), workflowArtifactRun(), WorkflowArtifactUploadInput{
				Name: "artifact.bin", Size: tc.size, ContentType: "application/octet-stream",
			})
			require.NoError(t, err)
			assert.Equal(t, blob.PendingUploadKey("workflow-artifacts", result.Artifact.GcsKey), store.signedKey)
			assert.Equal(t, tc.size, store.signedMaxSize)
			assert.Equal(t, 3*time.Minute, store.signedExpiry)
			assert.Equal(t, store.signedUpload.Header, result.UploadHeaders)
			assert.Equal(t, []int64{tc.size}, policy.deltas)
		})
	}
}

func TestWorkflowArtifactIssueUploadURL_PendingReuseCannotOutliveOriginalCapabilityHorizon(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, 7, 18, 12, 0, 0, 0, time.UTC)
	base := db.WorkflowArtifact{
		ID: 17, RepositoryID: 101, WorkflowRunID: 55, Name: "build.tgz",
		Size: 12, ContentType: defaultWorkflowArtifactContentType, Status: "pending",
		GcsKey: "repos/101/runs/55/artifacts/17/build.tgz",
	}

	t.Run("caps renewed url to original horizon", func(t *testing.T) {
		artifact := base
		artifact.CreatedAt = now.Add(-blob.MaxSignedURLExpiry + 5*time.Minute)
		store := newArtifactPendingStore()
		q := &mockWorkflowArtifactQuerier{
			getWorkflowArtifactByNameFn: func(context.Context, db.GetWorkflowArtifactByNameParams) (db.WorkflowArtifact, error) {
				return artifact, nil
			},
		}
		svc := NewWorkflowArtifactService(q, store, 30*time.Minute).(*workflowArtifactService)
		svc.now = func() time.Time { return now }

		_, err := svc.IssueUploadURL(context.Background(), workflowArtifactRun(), WorkflowArtifactUploadInput{Name: artifact.Name, Size: artifact.Size})
		require.NoError(t, err)
		assert.Equal(t, 5*time.Minute, store.signedExpiry)
	})

	t.Run("rejects renewal after original horizon", func(t *testing.T) {
		artifact := base
		artifact.CreatedAt = now.Add(-blob.MaxSignedURLExpiry)
		store := newArtifactPendingStore()
		q := &mockWorkflowArtifactQuerier{
			getWorkflowArtifactByNameFn: func(context.Context, db.GetWorkflowArtifactByNameParams) (db.WorkflowArtifact, error) {
				return artifact, nil
			},
		}
		svc := NewWorkflowArtifactService(q, store, 30*time.Minute).(*workflowArtifactService)
		svc.now = func() time.Time { return now }

		_, err := svc.IssueUploadURL(context.Background(), workflowArtifactRun(), WorkflowArtifactUploadInput{Name: artifact.Name, Size: artifact.Size})
		require.Error(t, err)
		assert.Equal(t, 409, apiStatus(t, err))
		assert.Empty(t, store.signedKey)
	})
}

func TestWorkflowArtifactIssueUploadURL_RechecksCountUnderAdmissionLock(t *testing.T) {
	store := newArtifactPendingStore()
	policy := &artifactAdmissionBilling{}
	var stateMu sync.Mutex
	count := maxWorkflowArtifactsPerRun - 1
	q := &mockWorkflowArtifactQuerier{
		getWorkflowArtifactByNameFn: func(context.Context, db.GetWorkflowArtifactByNameParams) (db.WorkflowArtifact, error) {
			return db.WorkflowArtifact{}, pgx.ErrNoRows
		},
		listWorkflowArtifactsByRunFn: func(context.Context, int64) ([]db.WorkflowArtifact, error) {
			assert.True(t, policy.inside)
			stateMu.Lock()
			defer stateMu.Unlock()
			return make([]db.WorkflowArtifact, count), nil
		},
		createWorkflowArtifactFn: func(_ context.Context, arg db.CreateWorkflowArtifactParams) (db.WorkflowArtifact, error) {
			assert.True(t, policy.inside)
			stateMu.Lock()
			count++
			id := int64(count)
			stateMu.Unlock()
			return db.WorkflowArtifact{
				ID: id, RepositoryID: arg.RepositoryID, WorkflowRunID: arg.WorkflowRunID, Name: arg.Name,
				Size: arg.Size, ContentType: arg.ContentType, Status: "pending",
				GcsKey: "repos/101/runs/55/artifacts/" + strconv.FormatInt(id, 10) + "/" + arg.Name,
			}, nil
		},
	}
	svc := NewWorkflowArtifactService(q, store, time.Minute, WithWorkflowArtifactBillingPolicy(policy))

	start := make(chan struct{})
	errs := make(chan error, 2)
	for _, name := range []string{"one.bin", "two.bin"} {
		name := name
		go func() {
			<-start
			_, err := svc.IssueUploadURL(context.Background(), workflowArtifactRun(), WorkflowArtifactUploadInput{Name: name, Size: 0})
			errs <- err
		}()
	}
	close(start)
	successes := 0
	rejections := 0
	for range 2 {
		err := <-errs
		if err == nil {
			successes++
			continue
		}
		assert.Equal(t, 422, apiStatus(t, err))
		rejections++
	}
	assert.Equal(t, 1, successes)
	assert.Equal(t, 1, rejections)
	assert.Equal(t, maxWorkflowArtifactsPerRun, count)
}

func TestArtifactUploadReplacement_IsRejectedWithoutDeletingReadyArtifact(t *testing.T) {
	t.Run("workflow", func(t *testing.T) {
		old := db.WorkflowArtifact{ID: 1, RepositoryID: 101, WorkflowRunID: 55, Name: "artifact.bin", Size: 40, ContentType: "application/octet-stream", Status: "ready", GcsKey: "repos/101/runs/55/artifacts/1/artifact.bin"}
		store := newArtifactPendingStore()
		policy := &artifactAdmissionBilling{}
		q := &mockWorkflowArtifactQuerier{
			getWorkflowArtifactByNameFn: func(context.Context, db.GetWorkflowArtifactByNameParams) (db.WorkflowArtifact, error) {
				return old, nil
			},
		}
		svc := NewWorkflowArtifactService(q, store, time.Minute, WithWorkflowArtifactBillingPolicy(policy))
		_, err := svc.IssueUploadURL(context.Background(), workflowArtifactRun(), WorkflowArtifactUploadInput{Name: old.Name, Size: 65})
		require.Error(t, err)
		assert.Equal(t, 409, apiStatus(t, err))
		assert.Empty(t, policy.deltas)
		assert.Empty(t, store.deleteCalls)
	})

}

func TestArtifactPrune_ConfigLoweringStillUsesProviderCapabilityFence(t *testing.T) {
	fixedNow := time.Date(2026, 7, 18, 12, 0, 0, 0, time.UTC)
	signedExpiry := 17 * time.Minute

	t.Run("workflow", func(t *testing.T) {
		q := &mockWorkflowArtifactQuerier{
			listPrunableWorkflowArtifactsFn: func(_ context.Context, arg db.ListPrunableWorkflowArtifactsParams) ([]db.WorkflowArtifact, error) {
				assert.Equal(t, fixedNow.Add(-(blob.MaxSignedURLExpiry + workflowArtifactUploadGrace)), arg.PendingCreatedBefore)
				assert.Equal(t, fixedNow, arg.ReadyExpiresBefore)
				assert.Equal(t, fixedNow.Add(-workflowArtifactDeletionLease), arg.DeletionStaleBefore)
				assert.Equal(t, int32(23), arg.LimitRows)
				return nil, nil
			},
		}
		svc := NewWorkflowArtifactService(q, newArtifactPendingStore(), signedExpiry).(*workflowArtifactService)
		svc.now = func() time.Time { return fixedNow }

		deleted, err := svc.PruneExpired(context.Background(), 23)
		require.NoError(t, err)
		assert.Zero(t, deleted)
	})

}

func TestWorkflowArtifactConfirm_PromotesPurgesAndValidatesDigestBeforeReady(t *testing.T) {
	contents := []byte("artifact-body")
	digest := sha256.Sum256(contents)
	artifact := db.WorkflowArtifact{
		ID: 7, RepositoryID: 101, WorkflowRunID: 55, Name: "artifact.bin",
		Size: int64(len(contents)), ContentType: "application/octet-stream", Status: "pending",
		GcsKey: "repos/101/runs/55/artifacts/7/artifact.bin",
	}
	pendingKey := blob.PendingUploadKey("workflow-artifacts", artifact.GcsKey)
	store := newArtifactPendingStore()
	store.put(pendingKey, contents)
	policy := &artifactAdmissionBilling{}

	state := artifact
	q := &mockWorkflowArtifactQuerier{
		getWorkflowArtifactByNameFn: func(context.Context, db.GetWorkflowArtifactByNameParams) (db.WorkflowArtifact, error) {
			return state, nil
		},
		confirmWorkflowArtifactUploadFn: func(_ context.Context, arg db.ConfirmWorkflowArtifactUploadParams) (db.WorkflowArtifact, error) {
			assert.False(t, store.has(pendingKey))
			assert.True(t, store.has(artifact.GcsKey))
			assert.Equal(t, artifact.ID, arg.ID)
			state.Status = "ready"
			return state, nil
		},
	}
	svc := NewWorkflowArtifactService(q, store, time.Minute, WithWorkflowArtifactBillingPolicy(policy))
	confirmed, err := svc.ConfirmUpload(context.Background(), workflowArtifactRun(), artifact.Name, hex.EncodeToString(digest[:]))
	require.NoError(t, err)
	assert.Equal(t, "ready", confirmed.Status)
	assert.Equal(t, 1, store.promoteCalls)
	assert.False(t, store.has(pendingKey))
	assert.True(t, store.has(artifact.GcsKey))
	assert.Equal(t, []int64{0}, policy.deltas)
}

func TestWorkflowArtifactConfirm_PreservesPreexistingCreateOnlyDestinationOnDigestConflict(t *testing.T) {
	stagedContents := []byte("aaaa")
	preexistingContents := []byte("bbbb")
	stagedDigest := sha256.Sum256(stagedContents)
	artifact := db.WorkflowArtifact{
		ID: 8, RepositoryID: 101, WorkflowRunID: 55, Name: "artifact.bin",
		Size: int64(len(stagedContents)), ContentType: "application/octet-stream", Status: "pending",
		GcsKey: "repos/101/runs/55/artifacts/8/artifact.bin",
	}
	pendingKey := blob.PendingUploadKey("workflow-artifacts", artifact.GcsKey)
	store := newArtifactPendingStore()
	store.put(pendingKey, stagedContents)
	store.put(artifact.GcsKey, preexistingContents)
	confirmCalls := 0
	q := &mockWorkflowArtifactQuerier{
		getWorkflowArtifactByNameFn: func(context.Context, db.GetWorkflowArtifactByNameParams) (db.WorkflowArtifact, error) {
			return artifact, nil
		},
		confirmWorkflowArtifactUploadFn: func(context.Context, db.ConfirmWorkflowArtifactUploadParams) (db.WorkflowArtifact, error) {
			confirmCalls++
			return db.WorkflowArtifact{}, nil
		},
	}
	svc := NewWorkflowArtifactService(q, store, time.Minute)

	_, err := svc.ConfirmUpload(context.Background(), workflowArtifactRun(), artifact.Name, hex.EncodeToString(stagedDigest[:]))
	require.Error(t, err)
	assert.Equal(t, 409, apiStatus(t, err))
	assert.Zero(t, confirmCalls)
	assert.True(t, store.has(artifact.GcsKey), "a create-only race loser must not delete the winning destination")
	assert.True(t, store.has(pendingKey), "the losing staged upload remains available for explicit reconciliation")
	assert.NotContains(t, store.deleteCalls, artifact.GcsKey)
}

func TestArtifactConfirm_InvalidStagingCanBeCorrectedWithSameReservation(t *testing.T) {
	t.Run("workflow", func(t *testing.T) {
		correct := []byte("correct")
		digest := sha256.Sum256(correct)
		artifact := db.WorkflowArtifact{
			ID: 7, RepositoryID: 101, WorkflowRunID: 55, Name: "artifact.bin",
			Size: int64(len(correct)), ContentType: "application/octet-stream", Status: "pending",
			GcsKey: "repos/101/runs/55/artifacts/7/artifact.bin",
		}
		pendingKey := blob.PendingUploadKey("workflow-artifacts", artifact.GcsKey)
		store := newArtifactPendingStore()
		store.put(pendingKey, []byte("wrong!!"))
		state := artifact
		q := &mockWorkflowArtifactQuerier{
			getWorkflowArtifactByNameFn: func(context.Context, db.GetWorkflowArtifactByNameParams) (db.WorkflowArtifact, error) {
				return state, nil
			},
			confirmWorkflowArtifactUploadFn: func(context.Context, db.ConfirmWorkflowArtifactUploadParams) (db.WorkflowArtifact, error) {
				state.Status = "ready"
				return state, nil
			},
		}
		svc := NewWorkflowArtifactService(q, store, time.Minute)

		_, err := svc.ConfirmUpload(context.Background(), workflowArtifactRun(), artifact.Name, hex.EncodeToString(digest[:]))
		require.Error(t, err)
		assert.Equal(t, 400, apiStatus(t, err))
		assert.False(t, store.has(pendingKey), "invalid create-only object must be purged")
		assert.Equal(t, "pending", state.Status, "the metered reservation remains reusable")

		store.put(pendingKey, correct)
		confirmed, err := svc.ConfirmUpload(context.Background(), workflowArtifactRun(), artifact.Name, hex.EncodeToString(digest[:]))
		require.NoError(t, err)
		assert.Equal(t, "ready", confirmed.Status)
		assert.True(t, store.has(artifact.GcsKey))
	})

}

func TestArtifactConfirm_RemovesPromotedOrphanWhenCascadeWins(t *testing.T) {
	t.Run("workflow", func(t *testing.T) {
		contents := []byte("workflow")
		artifact := db.WorkflowArtifact{ID: 3, RepositoryID: 101, WorkflowRunID: 55, Name: "out.bin", Size: int64(len(contents)), ContentType: "application/octet-stream", Status: "pending", GcsKey: "repos/101/runs/55/artifacts/3/out.bin"}
		pendingKey := blob.PendingUploadKey("workflow-artifacts", artifact.GcsKey)
		store := newArtifactPendingStore()
		store.put(pendingKey, contents)
		promoted := make(chan struct{})
		continuePromotion := make(chan struct{})
		store.promoteFn = func(sourceKey, destinationKey string) error {
			store.mu.Lock()
			store.objects[destinationKey] = append([]byte(nil), store.objects[sourceKey]...)
			store.mu.Unlock()
			close(promoted)
			<-continuePromotion
			return nil
		}

		var stateMu sync.Mutex
		exists := true
		q := &mockWorkflowArtifactQuerier{
			getWorkflowArtifactByNameFn: func(context.Context, db.GetWorkflowArtifactByNameParams) (db.WorkflowArtifact, error) {
				stateMu.Lock()
				defer stateMu.Unlock()
				if !exists {
					return db.WorkflowArtifact{}, pgx.ErrNoRows
				}
				return artifact, nil
			},
			confirmWorkflowArtifactUploadFn: func(context.Context, db.ConfirmWorkflowArtifactUploadParams) (db.WorkflowArtifact, error) {
				stateMu.Lock()
				defer stateMu.Unlock()
				if !exists {
					return db.WorkflowArtifact{}, pgx.ErrNoRows
				}
				artifact.Status = "ready"
				return artifact, nil
			},
		}
		svc := NewWorkflowArtifactService(q, store, time.Minute, WithWorkflowArtifactBillingPolicy(&artifactAdmissionBilling{}))
		result := make(chan error, 1)
		go func() {
			_, err := svc.ConfirmUpload(context.Background(), workflowArtifactRun(), artifact.Name, "")
			result <- err
		}()
		<-promoted
		stateMu.Lock()
		exists = false
		stateMu.Unlock()
		close(continuePromotion)
		require.Error(t, <-result)
		assert.False(t, store.has(pendingKey))
		assert.False(t, store.has(artifact.GcsKey))
	})

}

func TestArtifactConfirm_ReconciliationLookupFailurePreservesPromotedFinal(t *testing.T) {
	t.Run("workflow", func(t *testing.T) {
		contents := []byte("workflow")
		artifact := db.WorkflowArtifact{ID: 30, RepositoryID: 101, WorkflowRunID: 55, Name: "out.bin", Size: int64(len(contents)), ContentType: "application/octet-stream", Status: "pending", GcsKey: "repos/101/runs/55/artifacts/30/out.bin"}
		pendingKey := blob.PendingUploadKey("workflow-artifacts", artifact.GcsKey)
		store := newArtifactPendingStore()
		store.put(pendingKey, contents)

		lookupCalls := 0
		q := &mockWorkflowArtifactQuerier{
			getWorkflowArtifactByNameFn: func(context.Context, db.GetWorkflowArtifactByNameParams) (db.WorkflowArtifact, error) {
				lookupCalls++
				if lookupCalls == 3 {
					return db.WorkflowArtifact{}, errors.New("database temporarily unavailable")
				}
				return artifact, nil
			},
			confirmWorkflowArtifactUploadFn: func(context.Context, db.ConfirmWorkflowArtifactUploadParams) (db.WorkflowArtifact, error) {
				return db.WorkflowArtifact{}, pgx.ErrNoRows
			},
		}
		svc := NewWorkflowArtifactService(q, store, time.Minute, WithWorkflowArtifactBillingPolicy(&artifactAdmissionBilling{}))

		_, err := svc.ConfirmUpload(context.Background(), workflowArtifactRun(), artifact.Name, "")
		require.Error(t, err)
		assert.Equal(t, 500, apiStatus(t, err))
		assert.Equal(t, 3, lookupCalls)
		assert.True(t, store.has(artifact.GcsKey), "an uncertain CAS winner may own the promoted final")
		assert.NotContains(t, store.deleteCalls, artifact.GcsKey)
	})

}

func TestWorkflowArtifactDelete_BlobFailureRetainsRetryableMeteredMetadata(t *testing.T) {
	artifact := db.WorkflowArtifact{ID: 8, RepositoryID: 101, WorkflowRunID: 55, Name: "out.bin", Size: 8, Status: "ready", GcsKey: "repos/101/runs/55/artifacts/8/out.bin"}
	store := newArtifactPendingStore()
	store.put(artifact.GcsKey, []byte("12345678"))
	store.deleteErr = errors.New("storage unavailable")

	var stateMu sync.Mutex
	state := artifact
	exists := true
	q := &mockWorkflowArtifactQuerier{
		getWorkflowRunFn: func(context.Context, db.GetWorkflowRunParams) (db.WorkflowRun, error) {
			return workflowArtifactRun(), nil
		},
		getWorkflowArtifactByNameFn: func(context.Context, db.GetWorkflowArtifactByNameParams) (db.WorkflowArtifact, error) {
			stateMu.Lock()
			defer stateMu.Unlock()
			if !exists {
				return db.WorkflowArtifact{}, pgx.ErrNoRows
			}
			return state, nil
		},
		claimWorkflowArtifactDeletionFn: func(context.Context, db.ClaimWorkflowArtifactDeletionParams) (db.WorkflowArtifact, error) {
			stateMu.Lock()
			defer stateMu.Unlock()
			state.Status = "deleting"
			return state, nil
		},
		retryWorkflowArtifactDeletionFn: func(context.Context, db.RetryWorkflowArtifactDeletionParams) (db.WorkflowArtifact, error) {
			stateMu.Lock()
			defer stateMu.Unlock()
			return state, nil
		},
		deleteClaimedWorkflowArtifactFn: func(context.Context, db.DeleteClaimedWorkflowArtifactParams) (db.WorkflowArtifact, error) {
			stateMu.Lock()
			defer stateMu.Unlock()
			exists = false
			return state, nil
		},
	}
	svc := NewWorkflowArtifactService(q, store, time.Minute, WithWorkflowArtifactBillingPolicy(&artifactAdmissionBilling{}))

	err := svc.DeleteArtifact(context.Background(), artifact.RepositoryID, artifact.WorkflowRunID, artifact.Name)
	require.Error(t, err)
	stateMu.Lock()
	assert.True(t, exists)
	assert.Equal(t, "deleting", state.Status)
	stateMu.Unlock()

	store.mu.Lock()
	store.deleteErr = nil
	store.mu.Unlock()
	require.NoError(t, svc.DeleteArtifact(context.Background(), artifact.RepositoryID, artifact.WorkflowRunID, artifact.Name))
	stateMu.Lock()
	assert.False(t, exists)
	stateMu.Unlock()
}

func (*artifactAdmissionBilling) AuthorizeSandboxStart(context.Context, int64) error {
	return nil
}
func (*artifactAdmissionBilling) SandboxEntitlement(context.Context, int64) (SandboxEntitlement, error) {
	return SandboxEntitlement{}, nil
}
