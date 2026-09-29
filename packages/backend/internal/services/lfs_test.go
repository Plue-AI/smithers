package services

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"strings"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/runtimeports"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/blob"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

type mockLFSQuerier struct {
	clearPurgedStorageDeletionFn      func(ctx context.Context, arg runtimeports.ClearPurgedStorageDeletionByExactKeyParams) (int64, error)
	getRepoByOwnerAndLowerNameFn      func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error)
	isOrgOwnerForRepoUserFn           func(ctx context.Context, arg db.IsOrgOwnerForRepoUserParams) (bool, error)
	getHighestTeamPermissionForRepoFn func(ctx context.Context, arg db.GetHighestTeamPermissionForRepoUserParams) (string, error)
	getCollaboratorPermissionForRepo  func(ctx context.Context, arg db.GetCollaboratorPermissionForRepoUserParams) (string, error)
	createLFSObjectFn                 func(ctx context.Context, arg db.CreateLFSObjectParams) (db.LfsObject, error)
	getLFSObjectByOIDFn               func(ctx context.Context, arg db.GetLFSObjectByOIDParams) (db.LfsObject, error)
	deleteLFSObjectFn                 func(ctx context.Context, arg db.DeleteLFSObjectParams) (int64, error)
	upsertLFSUploadReservationFn      func(ctx context.Context, arg db.UpsertLFSUploadReservationParams) (db.LfsUploadReservation, error)
	getLFSUploadReservationFn         func(ctx context.Context, arg db.GetLFSUploadReservationParams) (db.LfsUploadReservation, error)
	deleteLFSUploadReservationFn      func(ctx context.Context, arg db.DeleteLFSUploadReservationParams) error
	deleteUnissuedLFSReservationFn    func(ctx context.Context, arg db.DeleteUnissuedLFSUploadReservationParams) (int64, error)
	listExpiredLFSReservationsFn      func(ctx context.Context, repositoryID int64) ([]db.LfsUploadReservation, error)
	deleteExpiredLFSReservationFn     func(ctx context.Context, arg db.DeleteExpiredLFSUploadReservationParams) (int64, error)
	listLFSObjectsFn                  func(ctx context.Context, arg db.ListLFSObjectsParams) ([]db.LfsObject, error)
	countLFSObjectsFn                 func(ctx context.Context, repositoryID int64) (int64, error)
	hasStorageDeletionAllocationFn    func(ctx context.Context, arg runtimeports.HasStorageDeletionAllocationParams) (bool, error)
	lastCreate                        db.CreateLFSObjectParams
}

func (m *mockLFSQuerier) HasStorageDeletionAllocation(ctx context.Context, arg runtimeports.HasStorageDeletionAllocationParams) (bool, error) {
	if m.hasStorageDeletionAllocationFn != nil {
		return m.hasStorageDeletionAllocationFn(ctx, arg)
	}
	return false, nil
}

func (m *mockLFSQuerier) DeleteUnissuedLFSUploadReservation(ctx context.Context, arg db.DeleteUnissuedLFSUploadReservationParams) (int64, error) {
	if m.deleteUnissuedLFSReservationFn != nil {
		return m.deleteUnissuedLFSReservationFn(ctx, arg)
	}
	return 1, nil
}

func (m *mockLFSQuerier) ClearPurgedStorageDeletionByExactKey(ctx context.Context, arg runtimeports.ClearPurgedStorageDeletionByExactKeyParams) (int64, error) {
	if m.clearPurgedStorageDeletionFn != nil {
		return m.clearPurgedStorageDeletionFn(ctx, arg)
	}
	return 0, nil
}

func (m *mockLFSQuerier) GetRepoByOwnerAndLowerName(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
	if m.getRepoByOwnerAndLowerNameFn != nil {
		return m.getRepoByOwnerAndLowerNameFn(ctx, arg)
	}
	return db.Repository{}, pgx.ErrNoRows
}
func (m *mockLFSQuerier) IsOrgOwnerForRepoUser(ctx context.Context, arg db.IsOrgOwnerForRepoUserParams) (bool, error) {
	if m.isOrgOwnerForRepoUserFn != nil {
		return m.isOrgOwnerForRepoUserFn(ctx, arg)
	}
	return false, nil
}
func (m *mockLFSQuerier) GetHighestTeamPermissionForRepoUser(ctx context.Context, arg db.GetHighestTeamPermissionForRepoUserParams) (string, error) {
	if m.getHighestTeamPermissionForRepoFn != nil {
		return m.getHighestTeamPermissionForRepoFn(ctx, arg)
	}
	return "", nil
}
func (m *mockLFSQuerier) GetCollaboratorPermissionForRepoUser(ctx context.Context, arg db.GetCollaboratorPermissionForRepoUserParams) (string, error) {
	if m.getCollaboratorPermissionForRepo != nil {
		return m.getCollaboratorPermissionForRepo(ctx, arg)
	}
	return "", nil
}
func (m *mockLFSQuerier) CreateLFSObject(ctx context.Context, arg db.CreateLFSObjectParams) (db.LfsObject, error) {
	m.lastCreate = arg
	if m.createLFSObjectFn != nil {
		return m.createLFSObjectFn(ctx, arg)
	}
	return db.LfsObject{ID: 1, RepositoryID: arg.RepositoryID, Oid: arg.Oid, Size: arg.Size, GcsPath: arg.GcsPath}, nil
}
func (m *mockLFSQuerier) GetLFSObjectByOID(ctx context.Context, arg db.GetLFSObjectByOIDParams) (db.LfsObject, error) {
	if m.getLFSObjectByOIDFn != nil {
		return m.getLFSObjectByOIDFn(ctx, arg)
	}
	return db.LfsObject{}, pgx.ErrNoRows
}
func (m *mockLFSQuerier) DeleteLFSObject(ctx context.Context, arg db.DeleteLFSObjectParams) (int64, error) {
	if m.deleteLFSObjectFn != nil {
		return m.deleteLFSObjectFn(ctx, arg)
	}
	return 1, nil
}
func (m *mockLFSQuerier) UpsertLFSUploadReservation(ctx context.Context, arg db.UpsertLFSUploadReservationParams) (db.LfsUploadReservation, error) {
	if m.upsertLFSUploadReservationFn != nil {
		return m.upsertLFSUploadReservationFn(ctx, arg)
	}
	return db.LfsUploadReservation{RepositoryID: arg.RepositoryID, Oid: arg.Oid, Size: arg.Size, ExpiresAt: arg.ExpiresAt}, nil
}
func (m *mockLFSQuerier) GetLFSUploadReservation(ctx context.Context, arg db.GetLFSUploadReservationParams) (db.LfsUploadReservation, error) {
	if m.getLFSUploadReservationFn != nil {
		return m.getLFSUploadReservationFn(ctx, arg)
	}
	return db.LfsUploadReservation{}, pgx.ErrNoRows
}
func (m *mockLFSQuerier) DeleteLFSUploadReservation(ctx context.Context, arg db.DeleteLFSUploadReservationParams) error {
	if m.deleteLFSUploadReservationFn != nil {
		return m.deleteLFSUploadReservationFn(ctx, arg)
	}
	return nil
}
func (m *mockLFSQuerier) ListExpiredLFSUploadReservationsByOwner(ctx context.Context, repositoryID int64) ([]db.LfsUploadReservation, error) {
	if m.listExpiredLFSReservationsFn != nil {
		return m.listExpiredLFSReservationsFn(ctx, repositoryID)
	}
	return nil, nil
}
func (m *mockLFSQuerier) DeleteExpiredLFSUploadReservation(ctx context.Context, arg db.DeleteExpiredLFSUploadReservationParams) (int64, error) {
	if m.deleteExpiredLFSReservationFn != nil {
		return m.deleteExpiredLFSReservationFn(ctx, arg)
	}
	return 0, nil
}
func (m *mockLFSQuerier) ListLFSObjects(ctx context.Context, arg db.ListLFSObjectsParams) ([]db.LfsObject, error) {
	if m.listLFSObjectsFn != nil {
		return m.listLFSObjectsFn(ctx, arg)
	}
	return []db.LfsObject{}, nil
}
func (m *mockLFSQuerier) CountLFSObjects(ctx context.Context, repositoryID int64) (int64, error) {
	if m.countLFSObjectsFn != nil {
		return m.countLFSObjectsFn(ctx, repositoryID)
	}
	return 0, nil
}

type mockBlobStore struct {
	signedUploadURLFn   func(ctx context.Context, key string, contentType string, maxSizeBytes int64, expiry time.Duration) (string, error)
	signedDownloadURLFn func(ctx context.Context, key string, expiry time.Duration) (string, error)
	deleteFn            func(ctx context.Context, key string) error
	existsFn            func(ctx context.Context, key string) (bool, error)
	statFn              func(ctx context.Context, key string) (blob.ObjectAttrs, error)
	newReaderFn         func(ctx context.Context, key string) (io.ReadCloser, error)
}

func (m *mockBlobStore) SignedUploadURL(ctx context.Context, key string, contentType string, maxSizeBytes int64, expiry time.Duration) (string, error) {
	if m.signedUploadURLFn != nil {
		return m.signedUploadURLFn(ctx, key, contentType, maxSizeBytes, expiry)
	}
	return "https://upload", nil
}
func (m *mockBlobStore) SignedDownloadURL(ctx context.Context, key string, expiry time.Duration) (string, error) {
	if m.signedDownloadURLFn != nil {
		return m.signedDownloadURLFn(ctx, key, expiry)
	}
	return "https://download", nil
}
func (m *mockBlobStore) Delete(ctx context.Context, key string) error {
	if m.deleteFn != nil {
		return m.deleteFn(ctx, key)
	}
	return nil
}
func (m *mockBlobStore) Exists(ctx context.Context, key string) (bool, error) {
	if m.existsFn != nil {
		return m.existsFn(ctx, key)
	}
	return true, nil
}
func (m *mockBlobStore) Stat(ctx context.Context, key string) (blob.ObjectAttrs, error) {
	if m.statFn != nil {
		return m.statFn(ctx, key)
	}
	return blob.ObjectAttrs{Size: blob.UnknownObjectSize}, nil
}
func (m *mockBlobStore) NewReader(ctx context.Context, key string) (io.ReadCloser, error) {
	if m.newReaderFn != nil {
		return m.newReaderFn(ctx, key)
	}
	return io.NopCloser(strings.NewReader("")), nil
}

func lfsRepo() db.Repository {
	return db.Repository{ID: 101, Name: "demo", LowerName: "demo", UserID: pgtype.Int8{Int64: 1, Valid: true}}
}
func lfsUser() *db.User { return &db.User{ID: 1, Username: "alice", LowerUsername: "alice"} }

func TestLFSService_BatchUpload_GeneratesSignedURLs(t *testing.T) {
	svc := NewLFSService(&mockLFSQuerier{getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
		return lfsRepo(), nil
	}}, &mockBlobStore{}, 5*time.Minute, WithLFSVerifyBaseURL("https://plue.test"))
	resp, err := svc.Batch(context.Background(), lfsUser(), "alice", "demo", LFSBatchInput{Operation: "upload", Objects: []LFSObjectInput{{Oid: strings.Repeat("a", 64), Size: 1}}})
	require.NoError(t, err)
	assert.Equal(t, "basic", resp.Transfer)
	require.Len(t, resp.Objects, 1)
	uploadAction, ok := resp.Objects[0].Actions["upload"]
	require.True(t, ok, "expected upload action in response")
	assert.NotEmpty(t, uploadAction.Href)
}

func TestLFSService_BatchUpload_RequiresAuth(t *testing.T) {
	svc := NewLFSService(&mockLFSQuerier{}, &mockBlobStore{}, time.Minute)
	_, err := svc.Batch(context.Background(), nil, "alice", "demo", LFSBatchInput{Operation: "upload", Objects: []LFSObjectInput{{Oid: strings.Repeat("a", 64), Size: 1}}})
	assert.Equal(t, 401, apiStatus(t, err))
}

func TestLFSBatchUpload_RefusesObjectOverMaxSize(t *testing.T) {
	svc := NewLFSService(&mockLFSQuerier{getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
		return lfsRepo(), nil
	}}, &mockBlobStore{}, time.Minute, WithLFSVerifyBaseURL("https://plue.test"))

	_, err := svc.Batch(context.Background(), lfsUser(), "alice", "demo", LFSBatchInput{
		Operation: "upload",
		Objects:   []LFSObjectInput{{Oid: strings.Repeat("a", 64), Size: 5*1024*1024*1024 + 1}},
	})
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, pkgerrors.CodeRequestEntityTooLarge, apiErr.Code)
	assert.Equal(t, 413, apiErr.Status)

	resp, err := svc.Batch(context.Background(), lfsUser(), "alice", "demo", LFSBatchInput{
		Operation: "upload",
		Objects:   []LFSObjectInput{{Oid: strings.Repeat("b", 64), Size: maxLFSObjectSize}},
	})
	require.NoError(t, err)
	require.Len(t, resp.Objects, 1)
	assert.Equal(t, maxLFSObjectSize, resp.Objects[0].Size)
}

func TestLFSService_Batch_RejectsOversizedObjectList(t *testing.T) {
	svc := NewLFSService(&mockLFSQuerier{getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
		return lfsRepo(), nil
	}}, &mockBlobStore{}, time.Minute, WithLFSVerifyBaseURL("https://plue.test"))
	objects := make([]LFSObjectInput, maxLFSBatchObjects+1)
	for i := range objects {
		objects[i] = LFSObjectInput{Oid: fmt.Sprintf("%064x", i), Size: 1}
	}
	_, err := svc.Batch(context.Background(), lfsUser(), "alice", "demo", LFSBatchInput{Operation: "download", Objects: objects})
	assert.Equal(t, 422, apiStatus(t, err))
}

func TestLFSService_Batch_AllowsMaxObjectList(t *testing.T) {
	svc := NewLFSService(&mockLFSQuerier{getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
		return lfsRepo(), nil
	}}, &mockBlobStore{}, time.Minute, WithLFSVerifyBaseURL("https://plue.test"))
	objects := make([]LFSObjectInput, maxLFSBatchObjects)
	for i := range objects {
		objects[i] = LFSObjectInput{Oid: fmt.Sprintf("%064x", i), Size: 1}
	}
	resp, err := svc.Batch(context.Background(), lfsUser(), "alice", "demo", LFSBatchInput{Operation: "upload", Objects: objects})
	require.NoError(t, err)
	assert.Len(t, resp.Objects, maxLFSBatchObjects)
}

func TestLFSService_Batch_ValidatesOID(t *testing.T) {
	svc := NewLFSService(&mockLFSQuerier{}, &mockBlobStore{}, time.Minute)
	_, err := svc.Batch(context.Background(), lfsUser(), "alice", "demo", LFSBatchInput{Operation: "upload", Objects: []LFSObjectInput{{Oid: "bad", Size: 1}}})
	assert.Equal(t, 422, apiStatus(t, err))
}

// lfsTestOID returns the SHA-256 hex of content and the content itself.
// Used to build valid (OID, content) pairs for ConfirmUpload tests.
func lfsTestOID(content string) (oid, body string) {
	h := sha256.New()
	_, _ = io.WriteString(h, content)
	return fmt.Sprintf("%x", h.Sum(nil)), content
}

func TestLFSService_ConfirmUpload_ConfirmsUpload(t *testing.T) {
	// Use real SHA-256 so validateUploadedBlob passes.
	oid, body := lfsTestOID("ab") // 2-byte content
	q := &mockLFSQuerier{getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
		return lfsRepo(), nil
	}}
	svc := NewLFSService(q, &mockBlobStore{
		newReaderFn: func(ctx context.Context, key string) (io.ReadCloser, error) {
			return io.NopCloser(strings.NewReader(body)), nil
		},
	}, time.Minute)
	obj, err := svc.ConfirmUpload(context.Background(), lfsUser(), "alice", "demo", LFSConfirmUploadInput{Oid: oid, Size: int64(len(body))})
	require.NoError(t, err)
	assert.Equal(t, int64(len(body)), obj.Size)
}

func TestLFSService_ConfirmUpload_DuplicateReturnsExisting(t *testing.T) {
	// Use real SHA-256 so validateUploadedBlob passes before the duplicate check.
	oid, body := lfsTestOID("x") // 1-byte content
	q := &mockLFSQuerier{getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
		return lfsRepo(), nil
	}, createLFSObjectFn: func(ctx context.Context, arg db.CreateLFSObjectParams) (db.LfsObject, error) {
		return db.LfsObject{}, &pgconn.PgError{Code: "23505"}
	}, getLFSObjectByOIDFn: func(ctx context.Context, arg db.GetLFSObjectByOIDParams) (db.LfsObject, error) {
		return db.LfsObject{ID: 99, RepositoryID: arg.RepositoryID, Oid: arg.Oid, Size: int64(len(body)), GcsPath: "k"}, nil
	}}
	svc := NewLFSService(q, &mockBlobStore{
		newReaderFn: func(ctx context.Context, key string) (io.ReadCloser, error) {
			return io.NopCloser(strings.NewReader(body)), nil
		},
	}, time.Minute)
	obj, err := svc.ConfirmUpload(context.Background(), lfsUser(), "alice", "demo", LFSConfirmUploadInput{Oid: oid, Size: int64(len(body))})
	require.NoError(t, err)
	assert.Equal(t, int64(99), obj.ID)
}

func TestLFSService_ConfirmUpload_ConcurrentDeleteDoesNotResurrectMetadata(t *testing.T) {
	// Simulates a concurrent DeleteObject removing the blob (and the old row)
	// between ConfirmUpload's validation read and its row insert: the
	// post-insert existence re-check must roll the new row back instead of
	// leaving metadata that points at a missing blob.
	oid, body := lfsTestOID("ab")
	var deleted []db.DeleteLFSObjectParams
	q := &mockLFSQuerier{getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
		return lfsRepo(), nil
	}, deleteLFSObjectFn: func(ctx context.Context, arg db.DeleteLFSObjectParams) (int64, error) {
		deleted = append(deleted, arg)
		return 1, nil
	}}
	svc := NewLFSService(q, &mockBlobStore{
		newReaderFn: func(ctx context.Context, key string) (io.ReadCloser, error) {
			return io.NopCloser(strings.NewReader(body)), nil
		},
		// By the time the post-insert re-check runs, the blob is gone.
		existsFn: func(ctx context.Context, key string) (bool, error) { return false, nil },
	}, time.Minute)
	_, err := svc.ConfirmUpload(context.Background(), lfsUser(), "alice", "demo", LFSConfirmUploadInput{Oid: oid, Size: int64(len(body))})
	assert.Equal(t, 400, apiStatus(t, err))
	require.Len(t, deleted, 1)
	assert.Equal(t, int64(1), deleted[0].ID)
	assert.Equal(t, oid, deleted[0].Oid)
	assert.Equal(t, int64(101), deleted[0].RepositoryID)
}

func TestLFSService_ConfirmUpload_RecheckErrorRollsBackRow(t *testing.T) {
	oid, body := lfsTestOID("ab")
	var rolledBack db.DeleteLFSObjectParams
	q := &mockLFSQuerier{getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
		return lfsRepo(), nil
	}, deleteLFSObjectFn: func(ctx context.Context, arg db.DeleteLFSObjectParams) (int64, error) {
		rolledBack = arg
		return 1, nil
	}}
	svc := NewLFSService(q, &mockBlobStore{
		newReaderFn: func(ctx context.Context, key string) (io.ReadCloser, error) {
			return io.NopCloser(strings.NewReader(body)), nil
		},
		existsFn: func(ctx context.Context, key string) (bool, error) { return false, errors.New("gcs down") },
	}, time.Minute)
	_, err := svc.ConfirmUpload(context.Background(), lfsUser(), "alice", "demo", LFSConfirmUploadInput{Oid: oid, Size: int64(len(body))})
	assert.Equal(t, 500, apiStatus(t, err))
	assert.Equal(t, int64(1), rolledBack.ID, "rollback must use the freshly inserted row identity")
	assert.Equal(t, int64(101), rolledBack.RepositoryID)
	assert.Equal(t, oid, rolledBack.Oid)
}

func TestLFSService_DeleteObject_PropagatesBlobError(t *testing.T) {
	svc := NewLFSService(&mockLFSQuerier{getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
		return lfsRepo(), nil
	}, getLFSObjectByOIDFn: func(ctx context.Context, arg db.GetLFSObjectByOIDParams) (db.LfsObject, error) {
		return db.LfsObject{RepositoryID: 101, Oid: arg.Oid, GcsPath: "k"}, nil
	}}, &mockBlobStore{deleteFn: func(ctx context.Context, key string) error { return errors.New("boom") }}, time.Minute)
	err := svc.DeleteObject(context.Background(), lfsUser(), "alice", "demo", strings.Repeat("d", 64))
	assert.Equal(t, 500, apiStatus(t, err))
}

func TestLFSService_DeleteObject_AcceptsDeferredOrMissingBlob(t *testing.T) {
	for _, tc := range []struct {
		name      string
		deleteErr error
	}{
		{name: "legacy final-key purge is deferred", deleteErr: fmt.Errorf("fenced final key: %w", blob.ErrLegacyFinalKeyPurgeFenced)},
		{name: "blob is already missing", deleteErr: blob.ErrObjectNotFound},
	} {
		t.Run(tc.name, func(t *testing.T) {
			oid := strings.Repeat("e", 64)
			metadataDeleted := false
			blobDeleteCalls := 0
			q := &mockLFSQuerier{
				getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
					return lfsRepo(), nil
				},
				getLFSObjectByOIDFn: func(context.Context, db.GetLFSObjectByOIDParams) (db.LfsObject, error) {
					return db.LfsObject{ID: 7, RepositoryID: lfsRepo().ID, Oid: oid, Size: 3, GcsPath: lfsObjectKey(lfsRepo().ID, oid)}, nil
				},
				deleteLFSObjectFn: func(context.Context, db.DeleteLFSObjectParams) (int64, error) {
					metadataDeleted = true
					return 1, nil
				},
			}
			store := &mockBlobStore{deleteFn: func(context.Context, string) error {
				blobDeleteCalls++
				return tc.deleteErr
			}}

			err := NewLFSService(q, store, time.Minute).DeleteObject(
				context.Background(), lfsUser(), "alice", "demo", oid,
			)

			require.NoError(t, err)
			assert.True(t, metadataDeleted, "metadata deletion durably queues deferred blob cleanup")
			assert.Equal(t, 2, blobDeleteCalls, "both concurrency-fencing delete passes must remain idempotent")
		})
	}
}

func TestLFSService_ListObjects_Pagination(t *testing.T) {
	q := &mockLFSQuerier{getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
		repo := lfsRepo()
		repo.IsPublic = true
		return repo, nil
	}, countLFSObjectsFn: func(ctx context.Context, id int64) (int64, error) { return 3, nil }, listLFSObjectsFn: func(ctx context.Context, arg db.ListLFSObjectsParams) ([]db.LfsObject, error) {
		return []db.LfsObject{{ID: 1, RepositoryID: arg.RepositoryID, Oid: "x", Size: 1, GcsPath: "k"}}, nil
	}}
	svc := NewLFSService(q, &mockBlobStore{}, time.Minute)
	rows, total, err := svc.ListObjects(context.Background(), nil, "alice", "demo", 2, 2)
	require.NoError(t, err)
	assert.Equal(t, int64(3), total)
	require.Len(t, rows, 1)
}

var _ blob.Store = (*mockBlobStore)(nil)
