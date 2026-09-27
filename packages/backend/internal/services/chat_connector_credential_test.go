package services

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/stretchr/testify/require"
)

type connectorTokenStore struct {
	sandboxHelperTokenStore
	row db.GetAuthInfoByTokenHashRow
}

func (s connectorTokenStore) GetAuthInfoByTokenHash(_ context.Context, hash string) (db.GetAuthInfoByTokenHashRow, error) {
	sum := sha256.Sum256([]byte("bootstrap"))
	if hash != hex.EncodeToString(sum[:]) {
		panic("bootstrap was not hashed")
	}
	return s.row, nil
}
func TestChatConnectorCredential(t *testing.T) {
	for _, tc := range []struct {
		name, scopes               string
		system, prohibited, denied bool
	}{
		{name: "owner", scopes: "write:repository"},
		{name: "bound owner", scopes: "write:repository,repo:314"},
		{name: "read only", scopes: "read:repository", denied: true},
		{name: "other repository", scopes: "write:repository,repo:315", denied: true},
		{name: "run", scopes: "write:repository", system: true, denied: true},
		{name: "suspended", scopes: "write:repository", prohibited: true, denied: true},
		{name: "workspace", scopes: "write:repository," + middleware.WorkspaceRestrictionScope("one"), denied: true},
		{name: "paths", scopes: "write:repository," + middleware.PathRestrictionScopes([]string{"src/**"})[0], denied: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			q := &mockIssueQuerier{getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				return db.Repository{ID: 314, UserID: pgtype.Int8{Int64: 42, Valid: true}}, nil
			}}
			var created db.CreateAccessTokenParams
			revoked := false
			store := connectorTokenStore{row: db.GetAuthInfoByTokenHashRow{ID: 42, TokenScopes: tc.scopes, TokenSystemIssued: tc.system, ProhibitLogin: tc.prohibited}, sandboxHelperTokenStore: sandboxHelperTokenStore{
				createFn: func(_ context.Context, arg db.CreateAccessTokenParams) (db.AccessToken, error) {
					created = arg
					return db.AccessToken{ID: 7}, nil
				},
				deleteFn: func(ctx context.Context, arg db.DeleteAccessTokenParams) error {
					require.NoError(t, ctx.Err())
					require.Equal(t, int64(7), arg.ID)
					revoked = true
					return nil
				},
			}}
			token, revoke, err := NewIssueService(q).IssueChatConnectorCredential(context.Background(), store, "owner", "repo", "bootstrap")
			if tc.denied {
				require.Error(t, err)
				require.Empty(t, token)
				require.Zero(t, created.UserID)
				return
			}
			require.NoError(t, err)
			require.NotEmpty(t, token)
			require.Equal(t, int64(42), created.UserID)
			require.Equal(t, middleware.CredentialSync, middleware.TokenCredentialKind(created.SystemIssued, created.Scopes))
			require.Equal(t, int64(314), middleware.ParseTokenRepositoryRestriction(created.Scopes))
			require.WithinDuration(t, time.Now().Add(time.Hour), created.ExpiresAt.Time, time.Second)
			revoke()
			require.True(t, revoked)
		})
	}
}
