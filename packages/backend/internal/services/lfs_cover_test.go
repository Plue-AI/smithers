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

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/blob"
	"github.com/smithersai/smithers/packages/backend/internal/db"
)

type lfsCovBillingPolicy struct {
	storageCalls int
	storageErr   error
	storageBytes []int64
}

func (p *lfsCovBillingPolicy) AuthorizePrivateRepo(context.Context, string, int64) error {
	return nil
}
func (p *lfsCovBillingPolicy) AuthorizeWorkflowDispatch(context.Context, int64) error {
	return nil
}
func (p *lfsCovBillingPolicy) AuthorizeAgentRunCommitted(ctx context.Context, _ int64, commit func(context.Context, db.DBTX) error) error {
	return commit(ctx, nil)
}
func (p *lfsCovBillingPolicy) AuthorizeStorageIncrease(_ context.Context, _ int64, additionalBytes int64) error {
	p.storageCalls++
	p.storageBytes = append(p.storageBytes, additionalBytes)
	return p.storageErr
}
func (p *lfsCovBillingPolicy) AuthorizePairing(context.Context, int64) error {
	return nil
}

func lfsCovOID(body string) string {
	sum := sha256.Sum256([]byte(body))
	return fmt.Sprintf("%x", sum[:])
}

func TestLFS_Cov_DownloadMissingAndExistingObjects(t *testing.T) {
	oid := strings.Repeat("a", 64)
	q := &mockLFSQuerier{
		getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			repo := lfsRepo()
			repo.IsPublic = true
			return repo, nil
		},
		getLFSObjectByOIDFn: func(_ context.Context, arg db.GetLFSObjectByOIDParams) (db.LfsObject, error) {
			if arg.Oid == oid {
				return db.LfsObject{RepositoryID: arg.RepositoryID, Oid: arg.Oid, Size: 12, GcsPath: "stored/key"}, nil
			}
			return db.LfsObject{}, pgx.ErrNoRows
		},
	}
	svc := NewLFSService(q, &mockBlobStore{
		existsFn: func(_ context.Context, key string) (bool, error) {
			return key == "stored/key", nil
		},
		signedDownloadURLFn: func(_ context.Context, key string, expiry time.Duration) (string, error) {
			assert.Equal(t, "stored/key", key)
			assert.Equal(t, 2*time.Minute, expiry)
			return "https://download.example/stored", nil
		},
	}, 2*time.Minute)

	resp, err := svc.Batch(context.Background(), nil, "alice", "demo", LFSBatchInput{
		Operation: "download",
		Objects: []LFSObjectInput{
			{Oid: oid, Size: 12},
			{Oid: strings.Repeat("b", 64), Size: 7},
		},
	})
	require.NoError(t, err)
	require.Len(t, resp.Objects, 2)
	assert.Equal(t, "https://download.example/stored", resp.Objects[0].Actions["download"].Href)
	require.NotNil(t, resp.Objects[1].Error)
	assert.Equal(t, 404, resp.Objects[1].Error.Code)
}

func TestLFS_Cov_ValidationPermissionAndStorageErrors(t *testing.T) {
	svc := NewLFSService(&mockLFSQuerier{}, &mockBlobStore{}, time.Minute)
	_, err := svc.Batch(context.Background(), lfsUser(), "alice", "demo", LFSBatchInput{Operation: "move", Objects: []LFSObjectInput{{Oid: strings.Repeat("a", 64), Size: 1}}})
	require.Error(t, err)
	assert.Equal(t, 400, apiStatus(t, err))

	_, err = svc.Batch(context.Background(), lfsUser(), "alice", "demo", LFSBatchInput{Operation: "download"})
	require.Error(t, err)
	assert.Equal(t, 400, apiStatus(t, err))

	_, err = svc.Batch(context.Background(), lfsUser(), "", "demo", LFSBatchInput{Operation: "download", Objects: []LFSObjectInput{{Oid: strings.Repeat("a", 64), Size: 1}}})
	require.Error(t, err)
	assert.Equal(t, 400, apiStatus(t, err))

	privateRepo := lfsRepo()
	privateRepo.UserID = pgtype.Int8{Int64: 99, Valid: true}
	svc = NewLFSService(&mockLFSQuerier{
		getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return privateRepo, nil
		},
	}, &mockBlobStore{}, time.Minute)
	_, err = svc.Batch(context.Background(), nil, "alice", "demo", LFSBatchInput{Operation: "download", Objects: []LFSObjectInput{{Oid: strings.Repeat("a", 64), Size: 1}}})
	require.Error(t, err)
	assert.Equal(t, 404, apiStatus(t, err))
}

func TestLFS_Cov_ConfirmUploadBillingAndBlobValidation(t *testing.T) {
	body := "cache payload"
	oid := lfsCovOID(body)
	policy := &lfsCovBillingPolicy{}
	q := &mockLFSQuerier{
		getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return lfsRepo(), nil
		},
	}
	svc := NewLFSService(q, &mockBlobStore{
		newReaderFn: func(context.Context, string) (io.ReadCloser, error) {
			return io.NopCloser(strings.NewReader(body)), nil
		},
	}, 0, WithLFSBillingPolicy(policy))

	obj, err := svc.ConfirmUpload(context.Background(), lfsUser(), "alice", "demo", LFSConfirmUploadInput{Oid: oid, Size: int64(len(body))})
	require.NoError(t, err)
	assert.Equal(t, oid, obj.Oid)
	assert.Equal(t, 1, policy.storageCalls)

	policy.storageErr = errors.New("quota")
	_, err = svc.ConfirmUpload(context.Background(), lfsUser(), "alice", "demo", LFSConfirmUploadInput{Oid: oid, Size: int64(len(body))})
	require.Error(t, err)
	assert.Equal(t, "quota", err.Error())

	svc = NewLFSService(q, &mockBlobStore{
		newReaderFn: func(context.Context, string) (io.ReadCloser, error) {
			return nil, blob.ErrObjectNotFound
		},
		deleteFn: func(context.Context, string) error { return nil },
	}, time.Minute)
	_, err = svc.ConfirmUpload(context.Background(), lfsUser(), "alice", "demo", LFSConfirmUploadInput{Oid: oid, Size: int64(len(body))})
	require.Error(t, err)
	assert.Equal(t, 400, apiStatus(t, err))

	svc = NewLFSService(q, &mockBlobStore{
		newReaderFn: func(context.Context, string) (io.ReadCloser, error) {
			return io.NopCloser(strings.NewReader("wrong")), nil
		},
		deleteFn: func(context.Context, string) error { return nil },
	}, time.Minute)
	_, err = svc.ConfirmUpload(context.Background(), lfsUser(), "alice", "demo", LFSConfirmUploadInput{Oid: oid, Size: int64(len(body))})
	require.Error(t, err)
	assert.Equal(t, 422, apiStatus(t, err))
}

func TestLFS_Cov_DeleteListAndOIDBranches(t *testing.T) {
	oid := strings.ToUpper(strings.Repeat("c", 64))
	q := &mockLFSQuerier{
		getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return lfsRepo(), nil
		},
		getLFSObjectByOIDFn: func(context.Context, db.GetLFSObjectByOIDParams) (db.LfsObject, error) {
			return db.LfsObject{}, pgx.ErrNoRows
		},
	}
	svc := NewLFSService(q, &mockBlobStore{}, time.Minute)
	err := svc.DeleteObject(context.Background(), lfsUser(), "alice", "demo", oid)
	require.Error(t, err)
	assert.Equal(t, 404, apiStatus(t, err))

	norm, err := validateLFSOID(oid)
	require.NoError(t, err)
	assert.Equal(t, strings.ToLower(oid), norm)
	_, _, err = validateLFSObjectInput(LFSObjectInput{Oid: strings.Repeat("d", 64), Size: -1})
	require.Error(t, err)
	assert.Equal(t, 422, apiStatus(t, err))

	svc = NewLFSService(&mockLFSQuerier{
		getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			repo := lfsRepo()
			repo.IsPublic = true
			return repo, nil
		},
		countLFSObjectsFn: func(context.Context, int64) (int64, error) {
			return 0, errors.New("count failed")
		},
	}, &mockBlobStore{}, time.Minute)
	_, _, err = svc.ListObjects(context.Background(), nil, "alice", "demo", 1, 10)
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))
}

func (*lfsCovBillingPolicy) AuthorizeSandboxStart(context.Context, int64) error { return nil }
func (*lfsCovBillingPolicy) SandboxEntitlement(context.Context, int64) (SandboxEntitlement, error) {
	return SandboxEntitlement{}, nil
}
