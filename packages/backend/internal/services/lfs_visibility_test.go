package services

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

func TestLFSBatchUnreadablePrivateRepositoryLooksMissing(t *testing.T) {
	privateRepo := lfsRepo()
	privateRepo.UserID = pgtype.Int8{Int64: 99, Valid: true}
	svc := NewLFSService(&mockLFSQuerier{
		getRepoByOwnerAndLowerNameFn: func(_ context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			if arg.LowerName == "missing" {
				return db.Repository{}, pgx.ErrNoRows
			}
			return privateRepo, nil
		},
	}, &mockBlobStore{}, time.Minute)
	for _, operation := range []string{"download", "upload"} {
		input := LFSBatchInput{Operation: operation, Objects: []LFSObjectInput{{Oid: strings.Repeat("a", 64), Size: 1}}}
		for _, actor := range []*db.User{nil, lfsUser()} {
			_, missingErr := svc.Batch(context.Background(), actor, "alice", "missing", input)
			_, privateErr := svc.Batch(context.Background(), actor, "alice", "demo", input)
			var missingAPI, privateAPI *errors.APIError
			require.ErrorAs(t, missingErr, &missingAPI)
			require.ErrorAs(t, privateErr, &privateAPI)
			require.Equal(t, 404, missingAPI.Status)
			require.Equal(t, missingAPI.Status, privateAPI.Status, "%s actor=%v", operation, actor)
			require.Equal(t, missingAPI.Code, privateAPI.Code, "%s actor=%v", operation, actor)
			require.Equal(t, missingAPI.Message, privateAPI.Message, "%s actor=%v", operation, actor)
		}
	}
}

func TestLFSBatchTokenWithoutReadScopeCannotRevealPrivateRepository(t *testing.T) {
	svc := NewLFSService(&mockLFSQuerier{
		getRepoByOwnerAndLowerNameFn: func(_ context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			if arg.LowerName == "missing" {
				return db.Repository{}, pgx.ErrNoRows
			}
			return lfsRepo(), nil
		},
	}, &mockBlobStore{}, time.Minute)
	ctx := middleware.ContextWithAuthInfo(context.Background(), &middleware.AuthInfo{
		User: lfsUser(), IsTokenAuth: true,
		Scopes: middleware.ParseTokenScopes(""),
	})
	for _, operation := range []string{"download", "upload"} {
		input := LFSBatchInput{Operation: operation, Objects: []LFSObjectInput{{Oid: strings.Repeat("a", 64), Size: 1}}}
		_, missingErr := svc.Batch(ctx, lfsUser(), "alice", "missing", input)
		_, privateErr := svc.Batch(ctx, lfsUser(), "alice", "demo", input)
		var missingAPI, privateAPI *errors.APIError
		require.ErrorAs(t, missingErr, &missingAPI)
		require.ErrorAs(t, privateErr, &privateAPI)
		require.Equal(t, 404, privateAPI.Status, operation)
		require.Equal(t, missingAPI.Code, privateAPI.Code, operation)
		require.Equal(t, missingAPI.Message, privateAPI.Message, operation)
	}
}
