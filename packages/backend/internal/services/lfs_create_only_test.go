package services

import (
	"context"
	"errors"
	"fmt"
	"io"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/runtimeports"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/blob"
	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// createOnlyMockBlobStore is a mockBlobStore that also advertises create-only
// signed uploads, mirroring what GCSStore provides in production.
type createOnlyMockBlobStore struct {
	mockBlobStore
	signedCreateOnlyFn func(ctx context.Context, key string, contentType string, exactSizeBytes int64, expiry time.Duration) (blob.SignedUpload, error)
}

var _ blob.CreateOnlyUploadSigner = (*createOnlyMockBlobStore)(nil)

func (m *createOnlyMockBlobStore) SignedCreateOnlyUploadURL(ctx context.Context, key string, contentType string, exactSizeBytes int64, expiry time.Duration) (blob.SignedUpload, error) {
	if m.signedCreateOnlyFn != nil {
		return m.signedCreateOnlyFn(ctx, key, contentType, exactSizeBytes, expiry)
	}
	return blob.SignedUpload{
		URL:    "https://upload.create-only/" + key,
		Header: map[string]string{"x-goog-if-generation-match": "0"},
	}, nil
}

func lfsRepoQuerier() *mockLFSQuerier {
	return &mockLFSQuerier{getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
		return lfsRepo(), nil
	}}
}

type dynamicLFSBillingPolicy struct {
	beforeResolve   func()
	resolvedDelta   int64
	resolvedDeltas  []int64
	preflightDeltas []int64
	authorizeErr    error
	rejectPositive  bool
}

func (*dynamicLFSBillingPolicy) AuthorizePrivateRepo(context.Context, string, int64) error {
	return nil
}
func (*dynamicLFSBillingPolicy) AuthorizeWorkflowDispatch(context.Context, int64) error { return nil }
func (*dynamicLFSBillingPolicy) AuthorizeAgentRun(context.Context, int64) error         { return nil }
func (p *dynamicLFSBillingPolicy) AuthorizeStorageIncrease(_ context.Context, _ int64, additionalBytes int64) error {
	p.preflightDeltas = append(p.preflightDeltas, additionalBytes)
	return p.authorizeErr
}
func (*dynamicLFSBillingPolicy) AuthorizePairing(context.Context, int64) error { return nil }
func (p *dynamicLFSBillingPolicy) AuthorizeStorageIncreaseCommittedDynamic(
	ctx context.Context,
	_ int64,
	resolveAdditionalBytes func(context.Context) (int64, error),
	commit func(context.Context) error,
) error {
	if p.beforeResolve != nil {
		p.beforeResolve()
	}
	delta, err := resolveAdditionalBytes(ctx)
	if err != nil {
		return err
	}
	p.resolvedDelta = delta
	p.resolvedDeltas = append(p.resolvedDeltas, delta)
	if p.rejectPositive && delta > 0 {
		return fmt.Errorf("storage cap exceeded")
	}
	return commit(ctx)
}

func TestLFSService_BatchUpload_CreateOnlyStore_ReturnsRequiredHeader(t *testing.T) {
	plainSigned := false
	var signedMaxSize int64
	store := &createOnlyMockBlobStore{mockBlobStore: mockBlobStore{
		signedUploadURLFn: func(ctx context.Context, key, contentType string, maxSizeBytes int64, expiry time.Duration) (string, error) {
			plainSigned = true
			return "https://upload.plain", nil
		},
		existsFn: func(ctx context.Context, key string) (bool, error) { return false, nil },
	}, signedCreateOnlyFn: func(_ context.Context, key, _ string, maxSizeBytes int64, _ time.Duration) (blob.SignedUpload, error) {
		signedMaxSize = maxSizeBytes
		return blob.SignedUpload{
			URL: "https://upload.create-only/" + key,
			Header: map[string]string{
				"x-goog-if-generation-match":  "0",
				"x-goog-content-length-range": "1,1",
			},
		}, nil
	}}
	svc := NewLFSService(lfsRepoQuerier(), store, 5*time.Minute, WithLFSVerifyBaseURL("https://plue.test"))
	resp, err := svc.Batch(context.Background(), lfsUser(), "alice", "demo", LFSBatchInput{Operation: "upload", Objects: []LFSObjectInput{{Oid: strings.Repeat("a", 64), Size: 1}}})
	require.NoError(t, err)
	require.Len(t, resp.Objects, 1)
	action, ok := resp.Objects[0].Actions["upload"]
	require.True(t, ok, "expected upload action")
	assert.Equal(t, "https://upload.create-only/repos/101/lfs/"+strings.Repeat("a", 64), action.Href)
	assert.Equal(t, "0", action.Header["x-goog-if-generation-match"],
		"the signed precondition header must reach the LFS action so the client sends it")
	assert.Equal(t, "1,1", action.Header["x-goog-content-length-range"],
		"git-lfs sends every upload action header, including the signed size bound")
	assert.Equal(t, int64(1), signedMaxSize, "the signed URL must reject bytes beyond the declared LFS size")
	assert.False(t, plainSigned, "create-only capable stores must not fall back to overwritable uploads")
	verify, ok := resp.Objects[0].Actions["verify"]
	require.True(t, ok, "every upload must have the standard git-lfs verify action")
	assert.Equal(t, "https://plue.test/api/repos/alice/demo/lfs/verify", verify.Href)
}

func TestLFSService_BatchUpload_CreateOnlyStore_BoundsEmptyObject(t *testing.T) {
	oid, _ := lfsTestOID("")
	var signedMaxSize int64 = -2
	store := &createOnlyMockBlobStore{mockBlobStore: mockBlobStore{
		existsFn: func(context.Context, string) (bool, error) { return false, nil },
	}, signedCreateOnlyFn: func(_ context.Context, key, _ string, maxSizeBytes int64, _ time.Duration) (blob.SignedUpload, error) {
		signedMaxSize = maxSizeBytes
		return blob.SignedUpload{
			URL: "https://upload.create-only/" + key,
			Header: map[string]string{
				"x-goog-if-generation-match":  "0",
				"x-goog-content-length-range": "0,0",
			},
		}, nil
	}}
	svc := NewLFSService(lfsRepoQuerier(), store, time.Minute, WithLFSVerifyBaseURL("https://plue.test"))
	resp, err := svc.Batch(context.Background(), lfsUser(), "alice", "demo", LFSBatchInput{
		Operation: "upload",
		Objects:   []LFSObjectInput{{Oid: oid, Size: 0}},
	})
	require.NoError(t, err)
	assert.Equal(t, int64(0), signedMaxSize)
	assert.Equal(t, "0,0", resp.Objects[0].Actions["upload"].Header["x-goog-content-length-range"])
}

func TestLFSService_BatchUpload_CreateOnlyStore_InvalidOrphanGetsFreshUploadAndVerifyActions(t *testing.T) {
	deleted := false
	reservationDeleted := false
	var reservation db.LfsUploadReservation
	q := lfsRepoQuerier()
	q.getLFSUploadReservationFn = func(_ context.Context, arg db.GetLFSUploadReservationParams) (db.LfsUploadReservation, error) {
		if reservation.Oid == arg.Oid {
			return reservation, nil
		}
		return db.LfsUploadReservation{}, pgx.ErrNoRows
	}
	q.upsertLFSUploadReservationFn = func(_ context.Context, arg db.UpsertLFSUploadReservationParams) (db.LfsUploadReservation, error) {
		reservation = db.LfsUploadReservation{RepositoryID: arg.RepositoryID, Oid: arg.Oid, Size: arg.Size, ExpiresAt: arg.ExpiresAt}
		return reservation, nil
	}
	q.deleteLFSUploadReservationFn = func(context.Context, db.DeleteLFSUploadReservationParams) error {
		reservationDeleted = true
		return nil
	}
	store := &createOnlyMockBlobStore{mockBlobStore: mockBlobStore{
		existsFn: func(ctx context.Context, key string) (bool, error) { return true, nil },
		newReaderFn: func(context.Context, string) (io.ReadCloser, error) {
			return io.NopCloser(strings.NewReader("bad")), nil
		},
		deleteFn: func(context.Context, string) error {
			deleted = true
			return nil
		},
	}}
	svc := NewLFSService(q, store, 5*time.Minute,
		WithLFSBillingPolicy(&dynamicLFSBillingPolicy{}),
		WithLFSVerifyBaseURL("https://plue.test"),
	)
	resp, err := svc.Batch(context.Background(), lfsUser(), "alice", "demo", LFSBatchInput{Operation: "upload", Objects: []LFSObjectInput{{Oid: strings.Repeat("b", 64), Size: 3}}})
	require.NoError(t, err)
	require.Len(t, resp.Objects, 1)
	assert.True(t, deleted, "an invalid unregistered object must be removed before issuing a create-only URL")
	assert.NotEmpty(t, resp.Objects[0].Actions["upload"].Href)
	assert.NotEmpty(t, resp.Objects[0].Actions["verify"].Href)
	assert.Nil(t, resp.Objects[0].Error)
	assert.Equal(t, int64(3), resp.Objects[0].Size)
	assert.False(t, reservationDeleted, "replacement URL must retain its already-billed reservation")
	assert.Equal(t, strings.Repeat("b", 64), reservation.Oid)
}

func TestLFSService_BatchUpload_InvalidOrphanCleanupFailureDoesNotSignBlockedKey(t *testing.T) {
	oid := strings.Repeat("f", 64)
	q := lfsRepoQuerier()
	q.getLFSUploadReservationFn = func(context.Context, db.GetLFSUploadReservationParams) (db.LfsUploadReservation, error) {
		return db.LfsUploadReservation{}, pgx.ErrNoRows
	}
	q.upsertLFSUploadReservationFn = func(_ context.Context, arg db.UpsertLFSUploadReservationParams) (db.LfsUploadReservation, error) {
		return db.LfsUploadReservation{RepositoryID: arg.RepositoryID, Oid: arg.Oid, Size: arg.Size, ExpiresAt: arg.ExpiresAt}, nil
	}
	signed := false
	store := &createOnlyMockBlobStore{
		mockBlobStore: mockBlobStore{
			existsFn: func(context.Context, string) (bool, error) { return true, nil },
			newReaderFn: func(context.Context, string) (io.ReadCloser, error) {
				return io.NopCloser(strings.NewReader("bad")), nil
			},
			deleteFn: func(context.Context, string) error { return errors.New("purge unavailable") },
		},
		signedCreateOnlyFn: func(context.Context, string, string, int64, time.Duration) (blob.SignedUpload, error) {
			signed = true
			return blob.SignedUpload{URL: "must-not-sign"}, nil
		},
	}
	svc := NewLFSService(q, store, time.Minute,
		WithLFSBillingPolicy(&dynamicLFSBillingPolicy{}),
		WithLFSVerifyBaseURL("https://plue.test"),
	)

	_, err := svc.Batch(context.Background(), lfsUser(), "alice", "demo", LFSBatchInput{
		Operation: "upload",
		Objects:   []LFSObjectInput{{Oid: oid, Size: 3}},
	})
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))
	assert.False(t, signed, "a live invalid generation would reject the replacement create-only URL")
}

func TestLFSService_BatchUpload_ReplacesExactDeletionAllocationWithoutDoubleCharge(t *testing.T) {
	oid := strings.Repeat("e", 64)
	repositoryID := lfsRepo().ID
	q := lfsRepoQuerier()
	q.getLFSUploadReservationFn = func(context.Context, db.GetLFSUploadReservationParams) (db.LfsUploadReservation, error) {
		return db.LfsUploadReservation{}, pgx.ErrNoRows
	}
	q.hasStorageDeletionAllocationFn = func(_ context.Context, arg runtimeports.HasStorageDeletionAllocationParams) (bool, error) {
		assert.Equal(t, repositoryID, arg.RepositoryID)
		assert.Equal(t, lfsStorageAllocationKey(repositoryID, oid), arg.AllocationKey)
		return true, nil
	}
	upserted := false
	q.upsertLFSUploadReservationFn = func(_ context.Context, arg db.UpsertLFSUploadReservationParams) (db.LfsUploadReservation, error) {
		upserted = true
		return db.LfsUploadReservation{RepositoryID: arg.RepositoryID, Oid: arg.Oid, Size: arg.Size, ExpiresAt: arg.ExpiresAt}, nil
	}
	policy := &dynamicLFSBillingPolicy{rejectPositive: true}
	store := &createOnlyMockBlobStore{mockBlobStore: mockBlobStore{
		existsFn: func(context.Context, string) (bool, error) { return false, nil },
	}}
	svc := NewLFSService(q, store, time.Minute,
		WithLFSBillingPolicy(policy),
		WithLFSVerifyBaseURL("https://plue.test"),
	)

	resp, err := svc.Batch(context.Background(), lfsUser(), "alice", "demo", LFSBatchInput{
		Operation: "upload",
		Objects:   []LFSObjectInput{{Oid: oid, Size: 23}},
	})
	require.NoError(t, err)
	assert.Equal(t, int64(0), policy.resolvedDelta)
	assert.True(t, upserted)
	assert.NotEmpty(t, resp.Objects[0].Actions["upload"].Href)
}

func TestLFSService_BatchUpload_CreateOnlyStore_AdoptsValidUnconfirmedBlob(t *testing.T) {
	oid, body := lfsTestOID("uploaded before verify")
	created := false
	q := lfsRepoQuerier()
	q.createLFSObjectFn = func(_ context.Context, arg db.CreateLFSObjectParams) (db.LfsObject, error) {
		created = true
		return db.LfsObject{ID: 8, RepositoryID: arg.RepositoryID, Oid: arg.Oid, Size: arg.Size, GcsPath: arg.GcsPath}, nil
	}
	store := &createOnlyMockBlobStore{mockBlobStore: mockBlobStore{
		existsFn: func(context.Context, string) (bool, error) { return true, nil },
		newReaderFn: func(context.Context, string) (io.ReadCloser, error) {
			return io.NopCloser(strings.NewReader(body)), nil
		},
	}}
	svc := NewLFSService(q, store, 5*time.Minute, WithLFSVerifyBaseURL("https://plue.test"))
	resp, err := svc.Batch(context.Background(), lfsUser(), "alice", "demo", LFSBatchInput{
		Operation: "upload",
		Objects:   []LFSObjectInput{{Oid: oid, Size: int64(len(body))}},
	})
	require.NoError(t, err)
	require.True(t, created, "batch recovery must register the already-uploaded object")
	require.Len(t, resp.Objects, 1)
	assert.Empty(t, resp.Objects[0].Actions, "git-lfs may only infer server ownership after metadata is registered")
	assert.Equal(t, int64(len(body)), resp.Objects[0].Size)
}

func TestLFSService_ConfirmUpload_ConcurrentVerifierDoesNotDoubleCountStorage(t *testing.T) {
	oid, body := lfsTestOID("one stored object")
	registered := false
	createCalled := false
	existing := db.LfsObject{ID: 41, RepositoryID: lfsRepo().ID, Oid: oid, Size: int64(len(body)), GcsPath: lfsObjectKey(lfsRepo().ID, oid)}
	q := lfsRepoQuerier()
	q.getLFSObjectByOIDFn = func(context.Context, db.GetLFSObjectByOIDParams) (db.LfsObject, error) {
		if registered {
			return existing, nil
		}
		return db.LfsObject{}, pgx.ErrNoRows
	}
	q.createLFSObjectFn = func(context.Context, db.CreateLFSObjectParams) (db.LfsObject, error) {
		createCalled = true
		return db.LfsObject{}, fmt.Errorf("second verifier must not insert")
	}
	store := &createOnlyMockBlobStore{mockBlobStore: mockBlobStore{
		newReaderFn: func(context.Context, string) (io.ReadCloser, error) {
			return io.NopCloser(strings.NewReader(body)), nil
		},
	}}
	policy := &dynamicLFSBillingPolicy{beforeResolve: func() {
		// Model another verifier committing while this request waited for the
		// production BillingService's per-owner advisory lock.
		registered = true
	}}
	svc := NewLFSService(q, store, time.Minute, WithLFSBillingPolicy(policy))
	got, err := svc.ConfirmUpload(context.Background(), lfsUser(), "alice", "demo", LFSConfirmUploadInput{Oid: oid, Size: int64(len(body))})
	require.NoError(t, err)
	assert.Equal(t, existing.ID, got.ID)
	assert.Equal(t, int64(0), policy.resolvedDelta, "the concurrent row already accounts for these bytes")
	assert.False(t, createCalled)
}

func TestLFSService_BatchUpload_CreateOnlyStore_RegisteredRowMissingBlobResigns(t *testing.T) {
	oid := strings.Repeat("c", 64)
	q := lfsRepoQuerier()
	q.getLFSObjectByOIDFn = func(ctx context.Context, arg db.GetLFSObjectByOIDParams) (db.LfsObject, error) {
		return db.LfsObject{ID: 7, RepositoryID: 101, Oid: oid, Size: 9, GcsPath: "repos/101/lfs/" + oid}, nil
	}
	store := &createOnlyMockBlobStore{mockBlobStore: mockBlobStore{
		existsFn: func(ctx context.Context, key string) (bool, error) { return false, nil },
	}}
	svc := NewLFSService(q, store, 5*time.Minute, WithLFSVerifyBaseURL("https://plue.test"))
	resp, err := svc.Batch(context.Background(), lfsUser(), "alice", "demo", LFSBatchInput{Operation: "upload", Objects: []LFSObjectInput{{Oid: oid, Size: 9}}})
	require.NoError(t, err)
	require.Len(t, resp.Objects, 1)
	action, ok := resp.Objects[0].Actions["upload"]
	require.True(t, ok, "row without blob must be re-uploadable")
	assert.Equal(t, "0", action.Header["x-goog-if-generation-match"])
	assert.Equal(t, "https://plue.test/api/repos/alice/demo/lfs/verify", resp.Objects[0].Actions["verify"].Href)
}

func TestLFSService_BatchUpload_RegisteredRowAdoptsCompletedPendingRepair(t *testing.T) {
	oid, body := lfsTestOID("completed repair upload")
	row := db.LfsObject{ID: 7, RepositoryID: lfsRepo().ID, Oid: oid, Size: int64(len(body)), GcsPath: lfsObjectKey(lfsRepo().ID, oid)}
	q := lfsRepoQuerier()
	q.getLFSObjectByOIDFn = func(context.Context, db.GetLFSObjectByOIDParams) (db.LfsObject, error) {
		return row, nil
	}
	store := newGenerationBlobStore()
	pendingKey := lfsPendingObjectKey(lfsRepo().ID, oid)
	require.Equal(t, 200, store.put(pendingKey, body, map[string]string{"x-goog-if-generation-match": "0"}))
	svc := NewLFSService(q, store, time.Minute, WithLFSVerifyBaseURL("https://plue.test"))

	resp, err := svc.Batch(context.Background(), lfsUser(), "alice", "demo", LFSBatchInput{
		Operation: "upload",
		Objects:   []LFSObjectInput{{Oid: oid, Size: int64(len(body))}},
	})

	require.NoError(t, err)
	require.Len(t, resp.Objects, 1)
	assert.Empty(t, resp.Objects[0].Actions, "a valid completed repair is adopted instead of re-signed")
	finalExists, _ := store.Exists(context.Background(), row.GcsPath)
	pendingExists, _ := store.Exists(context.Background(), pendingKey)
	assert.True(t, finalExists)
	assert.False(t, pendingExists)
}

func TestLFSService_ConfirmRepair_RecheckErrorPreservesLiveFinalObject(t *testing.T) {
	oid, body := lfsTestOID("repair survives transient metadata read")
	finalKey := lfsObjectKey(lfsRepo().ID, oid)
	pendingKey := lfsPendingObjectKey(lfsRepo().ID, oid)
	existing := db.LfsObject{ID: 71, RepositoryID: lfsRepo().ID, Oid: oid, Size: int64(len(body)), GcsPath: finalKey}
	lookups := 0
	q := lfsRepoQuerier()
	q.getLFSObjectByOIDFn = func(context.Context, db.GetLFSObjectByOIDParams) (db.LfsObject, error) {
		lookups++
		if lookups == 1 {
			return existing, nil
		}
		return db.LfsObject{}, errors.New("database temporarily unavailable")
	}
	store := newGenerationBlobStore()
	require.Equal(t, 200, store.put(pendingKey, body, map[string]string{"x-goog-if-generation-match": "0"}))
	svc := NewLFSService(q, store, time.Minute)

	_, err := svc.ConfirmUpload(context.Background(), lfsUser(), "alice", "demo", LFSConfirmUploadInput{
		Oid: oid, Size: int64(len(body)),
	})

	assert.Equal(t, 500, apiStatus(t, err))
	finalExists, statErr := store.Exists(context.Background(), finalKey)
	require.NoError(t, statErr)
	assert.True(t, finalExists, "an ambiguous metadata read must not destroy a possibly-owned final object")
}

func TestLFSService_ConfirmRepair_AdoptsExactReplacementWithoutDeletingSharedFinal(t *testing.T) {
	oid, body := lfsTestOID("replacement owns deterministic lfs key")
	finalKey := lfsObjectKey(lfsRepo().ID, oid)
	pendingKey := lfsPendingObjectKey(lfsRepo().ID, oid)
	existing := db.LfsObject{ID: 81, RepositoryID: lfsRepo().ID, Oid: oid, Size: int64(len(body)), GcsPath: finalKey}
	replacement := existing
	replacement.ID = 82
	lookups := 0
	q := lfsRepoQuerier()
	q.getLFSObjectByOIDFn = func(context.Context, db.GetLFSObjectByOIDParams) (db.LfsObject, error) {
		lookups++
		if lookups == 1 {
			return existing, nil
		}
		return replacement, nil
	}
	store := newGenerationBlobStore()
	require.Equal(t, 200, store.put(pendingKey, body, map[string]string{"x-goog-if-generation-match": "0"}))
	svc := NewLFSService(q, store, time.Minute)

	got, err := svc.ConfirmUpload(context.Background(), lfsUser(), "alice", "demo", LFSConfirmUploadInput{
		Oid: oid, Size: int64(len(body)),
	})

	require.NoError(t, err)
	assert.Equal(t, replacement.ID, got.ID)
	finalExists, statErr := store.Exists(context.Background(), finalKey)
	require.NoError(t, statErr)
	assert.True(t, finalExists, "the current row's deterministic final key must remain intact")
}

func TestLFSService_BatchUpload_RegisteredRowDeletesInvalidPendingRepairBeforeResigning(t *testing.T) {
	oid, body := lfsTestOID("expected repaired content")
	row := db.LfsObject{ID: 8, RepositoryID: lfsRepo().ID, Oid: oid, Size: int64(len(body)), GcsPath: lfsObjectKey(lfsRepo().ID, oid)}
	q := lfsRepoQuerier()
	q.getLFSObjectByOIDFn = func(context.Context, db.GetLFSObjectByOIDParams) (db.LfsObject, error) {
		return row, nil
	}
	store := newGenerationBlobStore()
	pendingKey := lfsPendingObjectKey(lfsRepo().ID, oid)
	require.Equal(t, 200, store.put(pendingKey, strings.Repeat("x", len(body)), map[string]string{"x-goog-if-generation-match": "0"}))
	svc := NewLFSService(q, store, time.Minute, WithLFSVerifyBaseURL("https://plue.test"))

	resp, err := svc.Batch(context.Background(), lfsUser(), "alice", "demo", LFSBatchInput{
		Operation: "upload",
		Objects:   []LFSObjectInput{{Oid: oid, Size: int64(len(body))}},
	})

	require.NoError(t, err)
	require.Len(t, resp.Objects, 1)
	assert.NotEmpty(t, resp.Objects[0].Actions["upload"].Href)
	pendingExists, _ := store.Exists(context.Background(), pendingKey)
	assert.False(t, pendingExists, "invalid pending bytes must be removed before the fresh create-only action")
}

// TestLFSService_BatchUpload_PlainStore_BehaviorUnchanged locks in that stores
// without create-only support (MemoryStore, test doubles) keep the exact
// pre-fix behavior: an upload action with no required headers and no
// existence probe on the unregistered path.
func TestLFSService_BatchUpload_PlainStore_BehaviorUnchanged(t *testing.T) {
	existsCalled := false
	store := &mockBlobStore{existsFn: func(ctx context.Context, key string) (bool, error) {
		existsCalled = true
		return true, nil
	}}
	svc := NewLFSService(lfsRepoQuerier(), store, 5*time.Minute, WithLFSVerifyBaseURL("https://plue.test"))
	resp, err := svc.Batch(context.Background(), lfsUser(), "alice", "demo", LFSBatchInput{Operation: "upload", Objects: []LFSObjectInput{{Oid: strings.Repeat("d", 64), Size: 1}}})
	require.NoError(t, err)
	require.Len(t, resp.Objects, 1)
	action, ok := resp.Objects[0].Actions["upload"]
	require.True(t, ok, "plain stores keep handing out upload actions")
	assert.Empty(t, action.Header)
	assert.False(t, existsCalled, "no existence probe for unregistered objects on plain stores")
}

// generationBlobStore is an in-memory store that models GCS generation
// semantics: SignedCreateOnlyUploadURL hands out an upload whose put() honors
// x-goog-if-generation-match, so a write against a live object is rejected
// with 412 and leaves the stored content untouched.
type generationBlobStore struct {
	mu         sync.Mutex
	content    map[string][]byte
	generation map[string]int64
}

type lfsDeleteRaceBlobStore struct {
	*generationBlobStore
	finalKey          string
	firstFinalDeleted chan struct{}
	firstDeleteOnce   sync.Once
}

type lfsFailPendingDeleteStore struct {
	*generationBlobStore
	failKey string
}

func (s *lfsFailPendingDeleteStore) Delete(ctx context.Context, key string) error {
	if key == s.failKey {
		return errors.New("pending generation purge failed")
	}
	return s.generationBlobStore.Delete(ctx, key)
}

func (s *lfsDeleteRaceBlobStore) Delete(ctx context.Context, key string) error {
	err := s.generationBlobStore.Delete(ctx, key)
	if err == nil && key == s.finalKey {
		s.firstDeleteOnce.Do(func() { close(s.firstFinalDeleted) })
	}
	return err
}

var _ blob.Store = (*generationBlobStore)(nil)
var _ blob.CreateOnlyUploadSigner = (*generationBlobStore)(nil)
var _ blob.CreateOnlyPromoter = (*generationBlobStore)(nil)

func newGenerationBlobStore() *generationBlobStore {
	return &generationBlobStore{content: map[string][]byte{}, generation: map[string]int64{}}
}

// put simulates the storage layer receiving a PUT through a signed URL with
// the given headers. It returns the HTTP status GCS would return.
func (g *generationBlobStore) put(key, body string, header map[string]string) int {
	g.mu.Lock()
	defer g.mu.Unlock()
	if match, ok := header["x-goog-if-generation-match"]; ok {
		if fmt.Sprintf("%d", g.generation[key]) != match {
			return 412
		}
	}
	g.content[key] = []byte(body)
	g.generation[key]++
	return 200
}

func (g *generationBlobStore) SignedUploadURL(context.Context, string, string, int64, time.Duration) (string, error) {
	return "", fmt.Errorf("plain uploads must not be issued by a create-only store")
}

func (g *generationBlobStore) SignedCreateOnlyUploadURL(_ context.Context, key string, _ string, _ int64, _ time.Duration) (blob.SignedUpload, error) {
	return blob.SignedUpload{URL: "gen://" + key, Header: map[string]string{"x-goog-if-generation-match": "0"}}, nil
}

func (g *generationBlobStore) SignedDownloadURL(_ context.Context, key string, _ time.Duration) (string, error) {
	return "gen-download://" + key, nil
}

func (g *generationBlobStore) PromoteCreateOnly(_ context.Context, sourceKey, destinationKey string) error {
	g.mu.Lock()
	defer g.mu.Unlock()
	body, ok := g.content[sourceKey]
	if !ok {
		return blob.ErrObjectNotFound
	}
	if _, exists := g.content[destinationKey]; exists {
		return blob.ErrObjectAlreadyExists
	}
	g.content[destinationKey] = append([]byte(nil), body...)
	g.generation[destinationKey]++
	delete(g.content, sourceKey)
	g.generation[sourceKey] = 0
	return nil
}

func (g *generationBlobStore) Delete(_ context.Context, key string) error {
	g.mu.Lock()
	defer g.mu.Unlock()
	delete(g.content, key)
	g.generation[key] = 0
	return nil
}

func (g *generationBlobStore) Exists(_ context.Context, key string) (bool, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	_, ok := g.content[key]
	return ok, nil
}

func (g *generationBlobStore) Stat(_ context.Context, key string) (blob.ObjectAttrs, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	body, ok := g.content[key]
	if !ok {
		return blob.ObjectAttrs{}, blob.ErrObjectNotFound
	}
	return blob.ObjectAttrs{Size: int64(len(body))}, nil
}

func (g *generationBlobStore) NewReader(_ context.Context, key string) (io.ReadCloser, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	body, ok := g.content[key]
	if !ok {
		return nil, blob.ErrObjectNotFound
	}
	return io.NopCloser(strings.NewReader(string(body))), nil
}

// TestLFSService_CreateOnly_StaleActionCannotCorruptConfirmedObject drives the
// full corruption-window scenario through the service: two live upload
// actions for the same OID, the first upload is verified and confirmed, then
// the stale second action fires. The stale PUT must be rejected, the
// confirmed content must survive, and a later batch must dedup to the
// existing object.
func TestLFSService_CreateOnly_StaleActionCannotCorruptConfirmedObject(t *testing.T) {
	oid, body := lfsTestOID("verified content")
	key := "repos/101/lfs/" + oid
	pendingKey := lfsPendingObjectKey(101, oid)
	store := newGenerationBlobStore()
	q := lfsRepoQuerier()
	registered := map[string]db.LfsObject{}
	q.createLFSObjectFn = func(ctx context.Context, arg db.CreateLFSObjectParams) (db.LfsObject, error) {
		row := db.LfsObject{ID: 1, RepositoryID: arg.RepositoryID, Oid: arg.Oid, Size: arg.Size, GcsPath: arg.GcsPath}
		registered[arg.Oid] = row
		return row, nil
	}
	q.getLFSObjectByOIDFn = func(ctx context.Context, arg db.GetLFSObjectByOIDParams) (db.LfsObject, error) {
		if row, ok := registered[arg.Oid]; ok {
			return row, nil
		}
		return db.LfsObject{}, pgx.ErrNoRows
	}
	svc := NewLFSService(q, store, 5*time.Minute, WithLFSVerifyBaseURL("https://plue.test"))
	ctx := context.Background()
	input := LFSBatchInput{Operation: "upload", Objects: []LFSObjectInput{{Oid: oid, Size: int64(len(body))}}}

	// Two batch calls before any bytes land: both hand out live actions.
	first, err := svc.Batch(ctx, lfsUser(), "alice", "demo", input)
	require.NoError(t, err)
	stale, err := svc.Batch(ctx, lfsUser(), "alice", "demo", input)
	require.NoError(t, err)
	firstAction := first.Objects[0].Actions["upload"]
	staleAction := stale.Objects[0].Actions["upload"]
	require.NotEmpty(t, firstAction.Href)
	require.NotEmpty(t, staleAction.Href)

	// First client uploads and confirms; the object is verified.
	require.Contains(t, firstAction.Href, pendingKey)
	require.Equal(t, 200, store.put(pendingKey, body, firstAction.Header))
	confirmed, err := svc.ConfirmUpload(ctx, lfsUser(), "alice", "demo", LFSConfirmUploadInput{Oid: oid, Size: int64(len(body))})
	require.NoError(t, err)
	assert.Equal(t, key, confirmed.GcsPath)

	// The stale action fires after confirmation. Promotion removed the pending
	// generation, so the old create-only action can create a new pending object,
	// but it has no capability to overwrite the permanent final key.
	assert.Equal(t, 200, store.put(pendingKey, "corrupted content", staleAction.Header))
	got, err := blob.ComputeSHA256(ctx, store, key)
	require.NoError(t, err)
	assert.Equal(t, oid, got, "confirmed content must still hash to the OID after the stale write attempt")
	assert.Equal(t, int64(1), store.generation[key])

	// Retry/dedup: a later upload batch for the same object returns no
	// actions because the row and blob both exist.
	again, err := svc.Batch(ctx, lfsUser(), "alice", "demo", input)
	require.NoError(t, err)
	require.Len(t, again.Objects, 1)
	assert.Empty(t, again.Objects[0].Actions)
	assert.Nil(t, again.Objects[0].Error)
}

func TestLFSService_BatchExistingFinalRetainsReservationWhenPendingPurgeFails(t *testing.T) {
	oid, body := lfsTestOID("authoritative plus stranded pending")
	finalKey := lfsObjectKey(lfsRepo().ID, oid)
	pendingKey := lfsPendingObjectKey(lfsRepo().ID, oid)
	baseStore := newGenerationBlobStore()
	require.Equal(t, 200, baseStore.put(finalKey, body, nil))
	require.Equal(t, 200, baseStore.put(pendingKey, body, map[string]string{"x-goog-if-generation-match": "0"}))
	store := &lfsFailPendingDeleteStore{generationBlobStore: baseStore, failKey: pendingKey}
	row := db.LfsObject{ID: 90, RepositoryID: lfsRepo().ID, Oid: oid, Size: int64(len(body)), GcsPath: finalKey}
	reservationDeletes := 0
	q := lfsRepoQuerier()
	q.getLFSObjectByOIDFn = func(context.Context, db.GetLFSObjectByOIDParams) (db.LfsObject, error) {
		return row, nil
	}
	q.deleteLFSUploadReservationFn = func(context.Context, db.DeleteLFSUploadReservationParams) error {
		reservationDeletes++
		return nil
	}
	svc := NewLFSService(q, store, time.Minute, WithLFSVerifyBaseURL("https://plue.test"))

	resp, err := svc.Batch(context.Background(), lfsUser(), "alice", "demo", LFSBatchInput{
		Operation: "upload",
		Objects:   []LFSObjectInput{{Oid: oid, Size: int64(len(body))}},
	})

	require.NoError(t, err)
	assert.Empty(t, resp.Objects[0].Actions)
	assert.Zero(t, reservationDeletes, "quota must remain reserved while a physical pending generation may remain")
	pendingExists, _ := store.Exists(context.Background(), pendingKey)
	assert.True(t, pendingExists)
}

func TestLFSService_DeleteObject_ConcurrentRepairConfirmCannotLeaveFinalOrphan(t *testing.T) {
	oid, body := lfsTestOID("delete versus repair promotion")
	finalKey := lfsObjectKey(lfsRepo().ID, oid)
	pendingKey := lfsPendingObjectKey(lfsRepo().ID, oid)
	baseStore := newGenerationBlobStore()
	require.Equal(t, 200, baseStore.put(finalKey, body, nil))
	require.Equal(t, 200, baseStore.put(pendingKey, body, map[string]string{"x-goog-if-generation-match": "0"}))
	store := &lfsDeleteRaceBlobStore{
		generationBlobStore: baseStore,
		finalKey:            finalKey,
		firstFinalDeleted:   make(chan struct{}),
	}

	row := db.LfsObject{ID: 91, RepositoryID: lfsRepo().ID, Oid: oid, Size: int64(len(body)), GcsPath: finalKey}
	var rowMu sync.Mutex
	registered := true
	confirmDone := make(chan struct{})
	q := lfsRepoQuerier()
	q.getLFSObjectByOIDFn = func(context.Context, db.GetLFSObjectByOIDParams) (db.LfsObject, error) {
		rowMu.Lock()
		defer rowMu.Unlock()
		if registered {
			return row, nil
		}
		return db.LfsObject{}, pgx.ErrNoRows
	}
	q.deleteLFSObjectFn = func(context.Context, db.DeleteLFSObjectParams) (int64, error) {
		<-confirmDone
		rowMu.Lock()
		registered = false
		rowMu.Unlock()
		return 1, nil
	}
	svc := NewLFSService(q, store, time.Minute)

	deleteErr := make(chan error, 1)
	go func() {
		deleteErr <- svc.DeleteObject(context.Background(), lfsUser(), "alice", "demo", oid)
	}()
	select {
	case <-store.firstFinalDeleted:
	case <-time.After(2 * time.Second):
		t.Fatal("DeleteObject did not complete its first blob delete")
	}

	_, confirmErr := svc.ConfirmUpload(context.Background(), lfsUser(), "alice", "demo", LFSConfirmUploadInput{
		Oid: oid, Size: int64(len(body)),
	})
	require.NoError(t, confirmErr)
	close(confirmDone)
	select {
	case err := <-deleteErr:
		require.NoError(t, err)
	case <-time.After(2 * time.Second):
		t.Fatal("DeleteObject did not finish after concurrent confirmation")
	}

	finalExists, _ := store.Exists(context.Background(), finalKey)
	pendingExists, _ := store.Exists(context.Background(), pendingKey)
	assert.False(t, finalExists, "post-metadata delete must remove the concurrently promoted final object")
	assert.False(t, pendingExists)
}

func TestLFSService_BatchUpload_PreflightsAggregateNewBytesBeforeSigning(t *testing.T) {
	policy := &lfsCovBillingPolicy{storageErr: fmt.Errorf("quota denied")}
	signed := false
	store := &createOnlyMockBlobStore{mockBlobStore: mockBlobStore{
		existsFn: func(context.Context, string) (bool, error) { return false, nil },
	}, signedCreateOnlyFn: func(context.Context, string, string, int64, time.Duration) (blob.SignedUpload, error) {
		signed = true
		return blob.SignedUpload{}, nil
	}}
	oidA := strings.Repeat("a", 64)
	oidB := strings.Repeat("b", 64)
	svc := NewLFSService(lfsRepoQuerier(), store, time.Minute,
		WithLFSBillingPolicy(policy), WithLFSVerifyBaseURL("https://plue.test"))

	_, err := svc.Batch(context.Background(), lfsUser(), "alice", "demo", LFSBatchInput{
		Operation: "upload",
		Objects: []LFSObjectInput{
			{Oid: oidA, Size: 7},
			{Oid: oidB, Size: 11},
			{Oid: oidA, Size: 7}, // duplicates must not reserve twice
		},
	})

	require.EqualError(t, err, "quota denied")
	assert.Equal(t, []int64{18}, policy.storageBytes)
	assert.False(t, signed, "quota denial must happen before any upload URL is issued")
}

func TestLFSService_BatchUpload_SignerFailurePurgesAndReleasesOnlyFreshReservation(t *testing.T) {
	oid := strings.Repeat("c", 64)
	repositoryID := lfsRepo().ID
	reservations := map[string]db.LfsUploadReservation{}
	q := lfsRepoQuerier()
	q.getLFSUploadReservationFn = func(_ context.Context, arg db.GetLFSUploadReservationParams) (db.LfsUploadReservation, error) {
		reservation, ok := reservations[arg.Oid]
		if !ok {
			return db.LfsUploadReservation{}, pgx.ErrNoRows
		}
		return reservation, nil
	}
	q.upsertLFSUploadReservationFn = func(_ context.Context, arg db.UpsertLFSUploadReservationParams) (db.LfsUploadReservation, error) {
		now := time.Now().UTC()
		reservation := db.LfsUploadReservation{
			RepositoryID: arg.RepositoryID,
			Oid:          arg.Oid,
			Size:         arg.Size,
			ExpiresAt:    arg.ExpiresAt,
			CreatedAt:    now,
			UpdatedAt:    now,
		}
		reservations[arg.Oid] = reservation
		return reservation, nil
	}
	q.deleteUnissuedLFSReservationFn = func(_ context.Context, arg db.DeleteUnissuedLFSUploadReservationParams) (int64, error) {
		reservation, ok := reservations[arg.Oid]
		if !ok || reservation.CreatedAt != arg.CreatedAt || reservation.UpdatedAt != arg.UpdatedAt {
			return 0, nil
		}
		delete(reservations, arg.Oid)
		return 1, nil
	}
	var cleared []runtimeports.ClearPurgedStorageDeletionByExactKeyParams
	q.clearPurgedStorageDeletionFn = func(_ context.Context, arg runtimeports.ClearPurgedStorageDeletionByExactKeyParams) (int64, error) {
		cleared = append(cleared, arg)
		return 1, nil
	}
	var purged []string
	store := &createOnlyMockBlobStore{
		mockBlobStore: mockBlobStore{
			existsFn: func(context.Context, string) (bool, error) { return false, nil },
			deleteFn: func(_ context.Context, key string) error {
				purged = append(purged, key)
				return nil
			},
		},
		signedCreateOnlyFn: func(context.Context, string, string, int64, time.Duration) (blob.SignedUpload, error) {
			return blob.SignedUpload{}, errors.New("sign failed")
		},
	}
	svc := NewLFSService(q, store, time.Minute,
		WithLFSBillingPolicy(&dynamicLFSBillingPolicy{}), WithLFSVerifyBaseURL("https://plue.test"))

	_, err := svc.Batch(context.Background(), lfsUser(), "alice", "demo", LFSBatchInput{
		Operation: "upload",
		Objects:   []LFSObjectInput{{Oid: oid, Size: 17}},
	})

	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))
	assert.NotContains(t, reservations, oid, "unissued fresh reservation must not consume quota")
	assert.ElementsMatch(t, []string{
		lfsObjectKey(repositoryID, oid),
		lfsPendingObjectKey(repositoryID, oid),
	}, purged)
	require.Len(t, cleared, 2)
	for _, call := range cleared {
		assert.Equal(t, repositoryID, call.RepositoryID)
		assert.Equal(t, lfsStorageAllocationKey(repositoryID, oid), call.AllocationKey)
	}
}

func TestLFSService_BatchUpload_SignerFailureRetainsExistingReservation(t *testing.T) {
	oid := strings.Repeat("d", 64)
	reservation := db.LfsUploadReservation{
		RepositoryID: lfsRepo().ID,
		Oid:          oid,
		Size:         19,
		ExpiresAt:    time.Now().Add(time.Hour),
		CreatedAt:    time.Now().Add(-time.Hour),
		UpdatedAt:    time.Now().Add(-time.Hour),
	}
	q := lfsRepoQuerier()
	q.getLFSUploadReservationFn = func(context.Context, db.GetLFSUploadReservationParams) (db.LfsUploadReservation, error) {
		return reservation, nil
	}
	q.upsertLFSUploadReservationFn = func(_ context.Context, arg db.UpsertLFSUploadReservationParams) (db.LfsUploadReservation, error) {
		reservation.ExpiresAt = arg.ExpiresAt
		reservation.UpdatedAt = time.Now().UTC()
		return reservation, nil
	}
	deleteCalls := 0
	clearCalls := 0
	q.deleteUnissuedLFSReservationFn = func(context.Context, db.DeleteUnissuedLFSUploadReservationParams) (int64, error) {
		deleteCalls++
		return 1, nil
	}
	q.clearPurgedStorageDeletionFn = func(context.Context, runtimeports.ClearPurgedStorageDeletionByExactKeyParams) (int64, error) {
		clearCalls++
		return 1, nil
	}
	store := &createOnlyMockBlobStore{
		mockBlobStore: mockBlobStore{existsFn: func(context.Context, string) (bool, error) { return false, nil }},
		signedCreateOnlyFn: func(context.Context, string, string, int64, time.Duration) (blob.SignedUpload, error) {
			return blob.SignedUpload{}, errors.New("sign failed")
		},
	}
	svc := NewLFSService(q, store, time.Minute,
		WithLFSBillingPolicy(&dynamicLFSBillingPolicy{}), WithLFSVerifyBaseURL("https://plue.test"))

	_, err := svc.Batch(context.Background(), lfsUser(), "alice", "demo", LFSBatchInput{
		Operation: "upload",
		Objects:   []LFSObjectInput{{Oid: oid, Size: 19}},
	})

	require.Error(t, err)
	assert.Zero(t, deleteCalls, "an older capability may still own the deterministic key")
	assert.Zero(t, clearCalls)
}

func TestLFSService_BatchUpload_RejectsDuplicateOIDWithConflictingSizes(t *testing.T) {
	policy := &lfsCovBillingPolicy{}
	signed := false
	store := &createOnlyMockBlobStore{signedCreateOnlyFn: func(context.Context, string, string, int64, time.Duration) (blob.SignedUpload, error) {
		signed = true
		return blob.SignedUpload{}, nil
	}}
	oid := strings.Repeat("a", 64)
	svc := NewLFSService(lfsRepoQuerier(), store, time.Minute,
		WithLFSBillingPolicy(policy), WithLFSVerifyBaseURL("https://plue.test"))

	_, err := svc.Batch(context.Background(), lfsUser(), "alice", "demo", LFSBatchInput{
		Operation: "upload",
		Objects: []LFSObjectInput{
			{Oid: oid, Size: 1},
			{Oid: oid, Size: maxLFSObjectSize},
		},
	})

	require.Error(t, err)
	assert.Equal(t, 422, apiStatus(t, err))
	assert.Empty(t, policy.storageBytes, "conflicting duplicates must fail before quota reservation")
	assert.False(t, signed, "conflicting duplicates must fail before URL signing")
}

func TestLFSService_BatchUpload_PersistsAndReusesAggregateReservations(t *testing.T) {
	reservations := map[string]db.LfsUploadReservation{}
	q := lfsRepoQuerier()
	q.getLFSUploadReservationFn = func(_ context.Context, arg db.GetLFSUploadReservationParams) (db.LfsUploadReservation, error) {
		reservation, ok := reservations[arg.Oid]
		if !ok {
			return db.LfsUploadReservation{}, pgx.ErrNoRows
		}
		return reservation, nil
	}
	q.upsertLFSUploadReservationFn = func(_ context.Context, arg db.UpsertLFSUploadReservationParams) (db.LfsUploadReservation, error) {
		reservation := db.LfsUploadReservation{RepositoryID: arg.RepositoryID, Oid: arg.Oid, Size: arg.Size, ExpiresAt: arg.ExpiresAt}
		reservations[arg.Oid] = reservation
		return reservation, nil
	}
	store := &createOnlyMockBlobStore{mockBlobStore: mockBlobStore{
		existsFn: func(context.Context, string) (bool, error) { return false, nil },
	}}
	policy := &dynamicLFSBillingPolicy{}
	svc := NewLFSService(q, store, time.Minute,
		WithLFSBillingPolicy(policy), WithLFSVerifyBaseURL("https://plue.test"))
	input := LFSBatchInput{Operation: "upload", Objects: []LFSObjectInput{
		{Oid: strings.Repeat("a", 64), Size: 7},
		{Oid: strings.Repeat("b", 64), Size: 11},
	}}

	before := time.Now().UTC()
	_, err := svc.Batch(context.Background(), lfsUser(), "alice", "demo", input)
	require.NoError(t, err)
	_, err = svc.Batch(context.Background(), lfsUser(), "alice", "demo", input)
	require.NoError(t, err)

	assert.Equal(t, []int64{18, 0}, policy.resolvedDeltas)
	assert.Len(t, reservations, 2)
	for _, reservation := range reservations {
		minimumFence := before.Add(blob.MaxSignedURLExpiry + lfsVerifyContinuationGrace + lfsReservationCleanupGrace)
		assert.False(t, reservation.ExpiresAt.Before(minimumFence),
			"a lower current config must not shorten a pre-restart provider-maximum capability fence")
	}
}

func TestLFSService_BatchUpload_RefreshesRequestedExpiredReservationWithoutDeletingPendingBytes(t *testing.T) {
	oid, body := lfsTestOID("expired but still physically pending")
	reservation := db.LfsUploadReservation{
		RepositoryID: lfsRepo().ID,
		Oid:          oid,
		Size:         int64(len(body)),
		ExpiresAt:    time.Now().Add(-time.Hour),
	}
	q := lfsRepoQuerier()
	q.listExpiredLFSReservationsFn = func(context.Context, int64) ([]db.LfsUploadReservation, error) {
		return []db.LfsUploadReservation{reservation}, nil
	}
	q.getLFSUploadReservationFn = func(context.Context, db.GetLFSUploadReservationParams) (db.LfsUploadReservation, error) {
		return reservation, nil
	}
	q.upsertLFSUploadReservationFn = func(_ context.Context, arg db.UpsertLFSUploadReservationParams) (db.LfsUploadReservation, error) {
		reservation.ExpiresAt = arg.ExpiresAt
		return reservation, nil
	}
	deleteCalls := 0
	store := &createOnlyMockBlobStore{mockBlobStore: mockBlobStore{
		existsFn: func(context.Context, string) (bool, error) { return false, nil },
		deleteFn: func(context.Context, string) error { deleteCalls++; return nil },
	}}
	policy := &dynamicLFSBillingPolicy{rejectPositive: true}
	svc := NewLFSService(q, store, time.Minute,
		WithLFSBillingPolicy(policy), WithLFSVerifyBaseURL("https://plue.test"))

	_, err := svc.Batch(context.Background(), lfsUser(), "alice", "demo", LFSBatchInput{
		Operation: "upload",
		Objects:   []LFSObjectInput{{Oid: oid, Size: int64(len(body))}},
	})

	require.NoError(t, err)
	assert.Equal(t, int64(0), policy.resolvedDelta, "expired physical bytes remain reserved during refresh")
	assert.Zero(t, deleteCalls, "the requested deterministic key must not race its refreshed upload")
	assert.True(t, reservation.ExpiresAt.After(time.Now()))
}

func TestLFSService_BatchUpload_DeletesExpiredPendingBytesBeforeReleasingReservation(t *testing.T) {
	expiredOID, expiredBody := lfsTestOID("abandoned upload")
	newOID, newBody := lfsTestOID("new upload")
	expired := db.LfsUploadReservation{
		RepositoryID: lfsRepo().ID,
		Oid:          expiredOID,
		Size:         int64(len(expiredBody)),
		ExpiresAt:    time.Now().Add(-time.Hour),
	}
	store := newGenerationBlobStore()
	pendingKey := lfsPendingObjectKey(expired.RepositoryID, expired.Oid)
	require.Equal(t, 200, store.put(pendingKey, expiredBody, map[string]string{"x-goog-if-generation-match": "0"}))
	q := lfsRepoQuerier()
	q.listExpiredLFSReservationsFn = func(context.Context, int64) ([]db.LfsUploadReservation, error) {
		return []db.LfsUploadReservation{expired}, nil
	}
	q.deleteExpiredLFSReservationFn = func(_ context.Context, arg db.DeleteExpiredLFSUploadReservationParams) (int64, error) {
		exists, err := store.Exists(context.Background(), lfsPendingObjectKey(arg.RepositoryID, arg.Oid))
		require.NoError(t, err)
		assert.False(t, exists, "physical deletion must precede reservation release")
		return 1, nil
	}
	policy := &dynamicLFSBillingPolicy{}
	svc := NewLFSService(q, store, time.Minute,
		WithLFSBillingPolicy(policy), WithLFSVerifyBaseURL("https://plue.test"))

	_, err := svc.Batch(context.Background(), lfsUser(), "alice", "demo", LFSBatchInput{
		Operation: "upload",
		Objects:   []LFSObjectInput{{Oid: newOID, Size: int64(len(newBody))}},
	})

	require.NoError(t, err)
	exists, _ := store.Exists(context.Background(), pendingKey)
	assert.False(t, exists)
	assert.Equal(t, int64(len(newBody)), policy.resolvedDelta)
}

func TestLFSService_BatchUpload_RetainsExpiredReservationWhenPendingDeleteFails(t *testing.T) {
	expiredOID, expiredBody := lfsTestOID("cleanup must fail closed")
	newOID, newBody := lfsTestOID("unrelated requested object")
	expired := db.LfsUploadReservation{
		RepositoryID: lfsRepo().ID,
		Oid:          expiredOID,
		Size:         int64(len(expiredBody)),
		ExpiresAt:    time.Now().Add(-time.Hour),
	}
	pendingKey := lfsPendingObjectKey(expired.RepositoryID, expired.Oid)
	baseStore := newGenerationBlobStore()
	require.Equal(t, 200, baseStore.put(pendingKey, expiredBody, map[string]string{"x-goog-if-generation-match": "0"}))
	store := &lfsFailPendingDeleteStore{generationBlobStore: baseStore, failKey: pendingKey}
	released := 0
	q := lfsRepoQuerier()
	q.listExpiredLFSReservationsFn = func(context.Context, int64) ([]db.LfsUploadReservation, error) {
		return []db.LfsUploadReservation{expired}, nil
	}
	q.deleteExpiredLFSReservationFn = func(context.Context, db.DeleteExpiredLFSUploadReservationParams) (int64, error) {
		released++
		return 1, nil
	}
	policy := &dynamicLFSBillingPolicy{}
	svc := NewLFSService(q, store, time.Minute,
		WithLFSBillingPolicy(policy), WithLFSVerifyBaseURL("https://plue.test"))

	_, err := svc.Batch(context.Background(), lfsUser(), "alice", "demo", LFSBatchInput{
		Operation: "upload",
		Objects:   []LFSObjectInput{{Oid: newOID, Size: int64(len(newBody))}},
	})

	require.NoError(t, err)
	assert.Zero(t, released, "failed physical cleanup must retain the billable row")
	exists, _ := store.Exists(context.Background(), pendingKey)
	assert.True(t, exists)
}

func TestLFSService_ConfirmUpload_QuotaRejectionDeletesPendingObject(t *testing.T) {
	oid, body := lfsTestOID("would exceed quota")
	pendingKey := lfsPendingObjectKey(lfsRepo().ID, oid)
	finalKey := lfsObjectKey(lfsRepo().ID, oid)
	store := newGenerationBlobStore()
	require.Equal(t, 200, store.put(pendingKey, body, map[string]string{"x-goog-if-generation-match": "0"}))
	policy := &lfsCovBillingPolicy{storageErr: fmt.Errorf("quota denied")}
	svc := NewLFSService(lfsRepoQuerier(), store, time.Minute, WithLFSBillingPolicy(policy))

	_, err := svc.ConfirmUpload(context.Background(), lfsUser(), "alice", "demo", LFSConfirmUploadInput{
		Oid: oid, Size: int64(len(body)),
	})

	require.EqualError(t, err, "quota denied")
	pendingExists, _ := store.Exists(context.Background(), pendingKey)
	finalExists, _ := store.Exists(context.Background(), finalKey)
	assert.False(t, pendingExists, "rejected staged bytes must be removed immediately")
	assert.False(t, finalExists, "quota rejection must happen before permanent promotion")
}

func TestLFSService_ConfirmUpload_ConsumesExpiredReservationWithoutDoubleCounting(t *testing.T) {
	oid, body := lfsTestOID("already reserved near the cap")
	pendingKey := lfsPendingObjectKey(lfsRepo().ID, oid)
	finalKey := lfsObjectKey(lfsRepo().ID, oid)
	store := newGenerationBlobStore()
	require.Equal(t, 200, store.put(pendingKey, body, map[string]string{"x-goog-if-generation-match": "0"}))

	registered := false
	reservationActive := true
	reservationDeletes := 0
	row := db.LfsObject{ID: 77, RepositoryID: lfsRepo().ID, Oid: oid, Size: int64(len(body)), GcsPath: finalKey}
	q := lfsRepoQuerier()
	q.getLFSObjectByOIDFn = func(context.Context, db.GetLFSObjectByOIDParams) (db.LfsObject, error) {
		if registered {
			return row, nil
		}
		return db.LfsObject{}, pgx.ErrNoRows
	}
	q.getLFSUploadReservationFn = func(context.Context, db.GetLFSUploadReservationParams) (db.LfsUploadReservation, error) {
		if reservationActive {
			return db.LfsUploadReservation{RepositoryID: lfsRepo().ID, Oid: oid, Size: int64(len(body)), ExpiresAt: time.Now().Add(-time.Hour)}, nil
		}
		return db.LfsUploadReservation{}, pgx.ErrNoRows
	}
	q.createLFSObjectFn = func(context.Context, db.CreateLFSObjectParams) (db.LfsObject, error) {
		registered = true
		return row, nil
	}
	q.deleteLFSUploadReservationFn = func(context.Context, db.DeleteLFSUploadReservationParams) error {
		reservationActive = false
		reservationDeletes++
		return nil
	}
	policy := &dynamicLFSBillingPolicy{rejectPositive: true}
	svc := NewLFSService(q, store, time.Minute, WithLFSBillingPolicy(policy))

	confirmed, err := svc.ConfirmUpload(context.Background(), lfsUser(), "alice", "demo", LFSConfirmUploadInput{
		Oid: oid, Size: int64(len(body)),
	})

	require.NoError(t, err)
	assert.Equal(t, row.ID, confirmed.ID)
	assert.Equal(t, int64(0), policy.resolvedDelta, "the expired reservation still consumes the near-cap bytes")
	assert.Equal(t, 1, reservationDeletes, "promotion must replace the reservation with authoritative metadata")
	assert.False(t, reservationActive)
	finalExists, _ := store.Exists(context.Background(), finalKey)
	assert.True(t, finalExists)
}

func (*dynamicLFSBillingPolicy) AuthorizeSandboxStart(context.Context, int64) error { return nil }
func (*dynamicLFSBillingPolicy) SandboxEntitlement(context.Context, int64) (SandboxEntitlement, error) {
	return SandboxEntitlement{}, nil
}
