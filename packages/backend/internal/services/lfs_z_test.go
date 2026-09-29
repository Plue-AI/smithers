package services

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

func TestLfs_Z_EntryPermissionAndValidationErrors(t *testing.T) {
	ctx := context.Background()
	oid := strings.Repeat("a", 64)
	privateRepo := lfsRepo()
	privateRepo.UserID = pgtype.Int8{Int64: 99, Valid: true}

	svc := NewLFSService(&mockLFSQuerier{}, &mockBlobStore{}, time.Minute)
	_, err := svc.Batch(ctx, lfsUser(), "", "demo", LFSBatchInput{Operation: "download", Objects: []LFSObjectInput{{Oid: oid, Size: 1}}})
	require.Equal(t, 400, apiStatus(t, err))

	svc = NewLFSService(&mockLFSQuerier{
		getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return privateRepo, nil
		},
	}, &mockBlobStore{}, time.Minute)
	_, err = svc.Batch(ctx, lfsUser(), "alice", "demo", LFSBatchInput{Operation: "upload", Objects: []LFSObjectInput{{Oid: oid, Size: 1}}})
	require.Equal(t, 404, apiStatus(t, err))

	_, err = svc.ConfirmUpload(ctx, lfsUser(), "", "demo", LFSConfirmUploadInput{Oid: oid, Size: 1})
	require.Equal(t, 400, apiStatus(t, err))
	_, err = svc.ConfirmUpload(ctx, nil, "alice", "demo", LFSConfirmUploadInput{Oid: oid, Size: 1})
	require.Equal(t, 401, apiStatus(t, err))

	ownerRepo := lfsRepo()
	svc = NewLFSService(&mockLFSQuerier{
		getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return ownerRepo, nil
		},
	}, &mockBlobStore{}, time.Minute)
	_, err = svc.ConfirmUpload(ctx, lfsUser(), "alice", "demo", LFSConfirmUploadInput{Oid: "bad", Size: 1})
	require.Equal(t, 422, apiStatus(t, err))

	err = svc.DeleteObject(ctx, lfsUser(), "", "demo", oid)
	require.Equal(t, 400, apiStatus(t, err))
	err = svc.DeleteObject(ctx, nil, "alice", "demo", oid)
	require.Equal(t, 401, apiStatus(t, err))
	err = svc.DeleteObject(ctx, lfsUser(), "alice", "demo", "bad")
	require.Equal(t, 422, apiStatus(t, err))

	_, _, err = svc.ListObjects(ctx, lfsUser(), "", "demo", 1, 10)
	require.Equal(t, 400, apiStatus(t, err))
	_, _, err = NewLFSService(&mockLFSQuerier{
		getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return privateRepo, nil
		},
	}, &mockBlobStore{}, time.Minute).ListObjects(ctx, nil, "alice", "demo", 1, 10)
	require.Equal(t, 403, apiStatus(t, err))
}

func TestLfs_Z_RepositoryObjectAndAccessBranches(t *testing.T) {
	ctx := context.Background()
	oid := strings.Repeat("b", 64)
	repo := lfsRepo()

	svc := NewLFSService(&mockLFSQuerier{}, &mockBlobStore{}, time.Minute)
	_, err := svc.resolveRepoByOwnerAndName(ctx, "alice", "missing")
	require.Equal(t, 404, apiStatus(t, err))

	svc = NewLFSService(&mockLFSQuerier{
		getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return repo, nil
		},
		getLFSObjectByOIDFn: func(context.Context, db.GetLFSObjectByOIDParams) (db.LfsObject, error) {
			return db.LfsObject{}, errors.New("select failed")
		},
	}, &mockBlobStore{}, time.Minute)
	err = svc.DeleteObject(ctx, lfsUser(), "alice", "demo", oid)
	require.Equal(t, 500, apiStatus(t, err))

	svc = NewLFSService(&mockLFSQuerier{
		getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return repo, nil
		},
		countLFSObjectsFn: func(context.Context, int64) (int64, error) {
			return 0, errors.New("count failed")
		},
	}, &mockBlobStore{}, time.Minute)
	_, _, err = svc.ListObjects(ctx, lfsUser(), "alice", "demo", 1, 10)
	require.Equal(t, 500, apiStatus(t, err))

	otherRepo := repo
	otherRepo.UserID = pgtype.Int8{Int64: 99, Valid: true}
	err = NewLFSService(&mockLFSQuerier{}, &mockBlobStore{}, time.Minute).requireReadAccess(ctx, otherRepo, lfsUser())
	require.Equal(t, 403, apiStatus(t, err))

	err = NewLFSService(&mockLFSQuerier{
		getCollaboratorPermissionForRepo: func(context.Context, db.GetCollaboratorPermissionForRepoUserParams) (string, error) {
			return "", errors.New("permission failed")
		},
	}, &mockBlobStore{}, time.Minute).requireWriteAccess(ctx, otherRepo, lfsUser())
	require.Equal(t, 500, apiStatus(t, err))
}

func TestLfs_Z_DownloadMissingRowAndDeleteMetadataError(t *testing.T) {
	ctx := context.Background()
	oid := strings.Repeat("c", 64)
	repo := lfsRepo()
	repo.IsPublic = true

	svc := NewLFSService(&mockLFSQuerier{
		getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return repo, nil
		},
		getLFSObjectByOIDFn: func(context.Context, db.GetLFSObjectByOIDParams) (db.LfsObject, error) {
			return db.LfsObject{}, pgx.ErrNoRows
		},
	}, &mockBlobStore{}, time.Minute)
	resp, err := svc.Batch(ctx, nil, "alice", "demo", LFSBatchInput{Operation: "download", Objects: []LFSObjectInput{{Oid: oid, Size: 1}}})
	require.NoError(t, err)
	require.NotNil(t, resp.Objects[0].Error)
	assert.Equal(t, 404, resp.Objects[0].Error.Code)

	svc = NewLFSService(&mockLFSQuerier{
		getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return lfsRepo(), nil
		},
		getLFSObjectByOIDFn: func(context.Context, db.GetLFSObjectByOIDParams) (db.LfsObject, error) {
			return db.LfsObject{RepositoryID: lfsRepo().ID, Oid: oid, GcsPath: "key"}, nil
		},
		deleteLFSObjectFn: func(context.Context, db.DeleteLFSObjectParams) (int64, error) {
			return 0, errors.New("delete failed")
		},
	}, &mockBlobStore{}, time.Minute)
	err = svc.DeleteObject(ctx, lfsUser(), "alice", "demo", oid)
	require.Equal(t, 500, apiStatus(t, err))
}
