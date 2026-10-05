package middleware

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

func TestCredentialOfNamesWhatTheStoreFilesItUnder(t *testing.T) {
	t.Parallel()
	require.Equal(t, Credential{}, CredentialOf(nil))
	require.Equal(t, Credential{TokenHash: "token-hash"}, CredentialOf(&AuthInfo{IsTokenAuth: true, TokenHash: "token-hash", SessionHash: "ignored"}))
	require.Equal(t, Credential{SessionHash: "session-key"}, CredentialOf(&AuthInfo{SessionHash: "session-key"}))
}

func TestReadsRepositoriesAsPersonFollowsTheCredentialsNarrowestBinding(t *testing.T) {
	t.Parallel()
	person := &db.User{ID: 7, UserType: "individual"}
	token := func(scopes string, systemIssued bool) *AuthInfo {
		return &AuthInfo{User: person, IsTokenAuth: true, TokenHash: "h", RawScopes: scopes, Scopes: ParseTokenScopes(scopes), TokenSystemIssued: systemIssued}
	}
	for name, info := range map[string]*AuthInfo{
		"browser session":       {User: person, SessionHash: "s"},
		"read token":            token("read:repository", false),
		"write token reads too": token("write:repository,write:user", false),
		"every-scope token":     token("all", false),
	} {
		require.True(t, info.ReadsRepositoriesAsPerson(), name)
	}
	for name, info := range map[string]*AuthInfo{
		"nothing":                 nil,
		"no account":              {SessionHash: "s"},
		"session without key":     {User: person},
		"bot session":             {User: &db.User{ID: 8, UserType: "bot"}, SessionHash: "s"},
		"chat-only token":         token("write:user", false),
		"repository-bound token":  token("read:repository,"+RepositoryRestrictionScope(3), false),
		"path-bound token":        token(strings.Join(append([]string{"read:repository"}, PathRestrictionScopes([]string{"docs"})...), ","), false),
		"workspace-bound token":   token("read:repository,"+WorkspaceRestrictionScope("w1"), false),
		"agent run token":         token("read:repository", true),
		"service account's token": {User: &db.User{ID: 9, UserType: "service"}, IsTokenAuth: true, TokenHash: "h", RawScopes: "read:repository", Scopes: ParseTokenScopes("read:repository")},
	} {
		require.False(t, info.ReadsRepositoriesAsPerson(), name)
	}
}

func TestReloadCredentialResolvesAKeptCredentialNow(t *testing.T) {
	t.Parallel()
	now := time.Now().UTC()
	active := db.User{ID: 7, Username: "ben", IsActive: true}
	queries := &mockAuthLoaderQuerier{
		getAuthInfoByTokenHashFn: func(_ context.Context, hash string) (db.GetAuthInfoByTokenHashRow, error) {
			switch hash {
			case "live":
				return db.GetAuthInfoByTokenHashRow{ID: 7, Username: "ben", IsActive: true, TokenID: 3, TokenScopes: "read:repository"}, nil
			case "suspended":
				return db.GetAuthInfoByTokenHashRow{ID: 7, Username: "ben", ProhibitLogin: true}, nil
			case "outage":
				return db.GetAuthInfoByTokenHashRow{}, assert.AnError
			}
			return db.GetAuthInfoByTokenHashRow{}, pgx.ErrNoRows
		},
		getAuthSessionBySessionKeyFn: func(_ context.Context, key string) (db.AuthSession, error) {
			switch key {
			case "live", "disabled":
				return db.AuthSession{SessionKey: key, UserID: map[string]int64{"live": 7, "disabled": 8}[key], ExpiresAt: now.Add(time.Hour)}, nil
			case "expired":
				return db.AuthSession{SessionKey: key, UserID: 7, ExpiresAt: now.Add(-time.Second)}, nil
			case "outage":
				return db.AuthSession{}, assert.AnError
			}
			return db.AuthSession{}, pgx.ErrNoRows
		},
		getUserByIDFn: func(_ context.Context, id int64) (db.User, error) {
			if id == 8 {
				return db.User{ID: 8, IsActive: false}, nil
			}
			return active, nil
		},
	}
	ctx := context.Background()

	token, err := ReloadCredential(ctx, queries, Credential{TokenHash: "live"}, now)
	require.NoError(t, err)
	require.True(t, token.IsTokenAuth)
	require.Equal(t, int64(7), token.User.ID)
	require.True(t, token.Scopes.Has(ScopeReadRepository))
	session, err := ReloadCredential(ctx, queries, Credential{SessionHash: "live"}, now)
	require.NoError(t, err)
	require.False(t, session.IsTokenAuth)
	require.Equal(t, "live", session.SessionHash)
	require.Equal(t, int64(7), session.User.ID)

	for name, credential := range map[string]Credential{
		"revoked token":     {TokenHash: "revoked"},
		"suspended account": {TokenHash: "suspended"},
		"signed out":        {SessionHash: "gone"},
		"expired session":   {SessionHash: "expired"},
		"disabled account":  {SessionHash: "disabled"},
		"no credential":     {},
		"two credentials":   {TokenHash: "live", SessionHash: "live"},
	} {
		_, err = ReloadCredential(ctx, queries, credential, now)
		require.ErrorIs(t, err, ErrCredentialGone, name)
	}
	for name, credential := range map[string]Credential{"token store": {TokenHash: "outage"}, "session store": {SessionHash: "outage"}} {
		_, err = ReloadCredential(ctx, queries, credential, now)
		require.ErrorIs(t, err, assert.AnError, name)
		require.NotErrorIs(t, err, ErrCredentialGone, name)
	}
	// Reloading never refreshes a session or stamps a token's use.
	require.Zero(t, queries.refreshAuthSessionHit)
	require.Zero(t, queries.updateAccessTokenLastUsedHit)
}
