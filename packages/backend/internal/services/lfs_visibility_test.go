package services

import (
	"context"
	"io"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/lfsauth"
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

// lfsVerifyVisibilityService serves alice/demo (private unless public is set),
// reports alice/missing as absent, and grants user 3 read-only collaborator
// access. User 1 owns the repository; user 2 has no access.
func lfsVerifyVisibilityService(public bool, body string) *LFSService {
	repository := lfsRepo()
	repository.IsPublic = public
	return NewLFSService(&mockLFSQuerier{
		getRepoByOwnerAndLowerNameFn: func(_ context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			if arg.LowerName == "missing" {
				return db.Repository{}, pgx.ErrNoRows
			}
			return repository, nil
		},
		getCollaboratorPermissionForRepo: func(_ context.Context, arg db.GetCollaboratorPermissionForRepoUserParams) (string, error) {
			if arg.UserID.Int64 == 3 {
				return "read", nil
			}
			return "", nil
		},
	}, &mockBlobStore{newReaderFn: func(context.Context, string) (io.ReadCloser, error) {
		return io.NopCloser(strings.NewReader(body)), nil
	}}, time.Minute)
}

func requireLFSAPIError(t *testing.T, err error, status int, message string) *errors.APIError {
	t.Helper()
	var apiErr *errors.APIError
	require.ErrorAs(t, err, &apiErr)
	require.Equal(t, status, apiErr.Status)
	require.Equal(t, message, apiErr.Message)
	return apiErr
}

func TestLFSConfirmUploadUnreadablePrivateRepositoryLooksMissing(t *testing.T) {
	oid, body := lfsTestOID("verify visibility")
	input := LFSConfirmUploadInput{Oid: oid, Size: int64(len(body))}
	stranger := &db.User{ID: 2, Username: "mallory", LowerUsername: "mallory"}
	reader := &db.User{ID: 3, Username: "rita", LowerUsername: "rita"}
	writeToken := func(user *db.User, extraScopes ...string) context.Context {
		return middleware.ContextWithAuthInfo(context.Background(), &middleware.AuthInfo{
			User: user, IsTokenAuth: true,
			RawScopes: strings.Join(append([]string{string(middleware.ScopeWriteRepository)}, extraScopes...), ","),
			Scopes:    middleware.ParseTokenScopes(string(middleware.ScopeWriteRepository)),
		})
	}
	for name, ctx := range map[string]context.Context{
		"session":     context.Background(),
		"write token": writeToken(stranger),
	} {
		t.Run(name, func(t *testing.T) {
			svc := lfsVerifyVisibilityService(false, body)
			_, missingErr := svc.ConfirmUpload(ctx, stranger, "alice", "missing", input)
			_, privateErr := svc.ConfirmUpload(ctx, stranger, "alice", "demo", input)
			missing := requireLFSAPIError(t, missingErr, 404, "repository not found")
			private := requireLFSAPIError(t, privateErr, 404, "repository not found")
			require.Equal(t, missing.Code, private.Code)

			// A reader of the private repository already knows it exists and
			// keeps the write-permission error.
			_, readerErr := svc.ConfirmUpload(ctx, reader, "alice", "demo", input)
			requireLFSAPIError(t, readerErr, 403, "permission denied")

			// Public repositories are visible to everyone.
			_, publicErr := lfsVerifyVisibilityService(true, body).ConfirmUpload(ctx, stranger, "alice", "demo", input)
			requireLFSAPIError(t, publicErr, 403, "permission denied")

			obj, err := svc.ConfirmUpload(ctx, lfsUser(), "alice", "demo", input)
			require.NoError(t, err)
			require.Equal(t, oid, obj.Oid)
		})
	}

	t.Run("repository-bound token", func(t *testing.T) {
		ctx := writeToken(lfsUser(), middleware.RepositoryRestrictionScope(lfsRepo().ID+1))
		_, privateErr := lfsVerifyVisibilityService(false, body).ConfirmUpload(ctx, lfsUser(), "alice", "demo", input)
		requireLFSAPIError(t, privateErr, 404, "repository not found")
		_, publicErr := lfsVerifyVisibilityService(true, body).ConfirmUpload(ctx, lfsUser(), "alice", "demo", input)
		requireLFSAPIError(t, publicErr, 403, "repository-bound token cannot access resources outside its repository")
	})

	t.Run("scoped verify credential", func(t *testing.T) {
		manager, err := lfsauth.NewManager("lfs-verify-visibility-secret")
		require.NoError(t, err)
		issue := func(repositoryID int64, repo string) context.Context {
			token, claims, err := manager.IssueVerify(lfsauth.VerifyGrant{
				RepositoryID: repositoryID, Owner: "alice", Repository: repo,
				OID: oid, Size: int64(len(body)), Principal: lfsauth.PrincipalDeployKey,
			}, time.Hour)
			require.NoError(t, err)
			return lfsauth.ContextWithGrant(context.Background(), claims, token)
		}
		svc := lfsVerifyVisibilityService(false, body)
		_, missingErr := svc.ConfirmUpload(issue(lfsRepo().ID, "missing"), nil, "alice", "missing", input)
		_, staleErr := svc.ConfirmUpload(issue(lfsRepo().ID+1, "demo"), nil, "alice", "demo", input)
		missing := requireLFSAPIError(t, missingErr, 404, "repository not found")
		stale := requireLFSAPIError(t, staleErr, 404, "repository not found")
		require.Equal(t, missing.Code, stale.Code)

		obj, err := svc.ConfirmUpload(issue(lfsRepo().ID, "demo"), nil, "alice", "demo", input)
		require.NoError(t, err)
		require.Equal(t, oid, obj.Oid)
	})
}
