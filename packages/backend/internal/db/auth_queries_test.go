package db

import (
	"context"
	"crypto/sha256"
	"fmt"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestCreateAndGetAuthSession(t *testing.T) {
	q, pool := newQueries(t)
	userID := mustCreateUser(t, pool, "auth-session-user")

	expiresAt := time.Now().UTC().Add(24 * time.Hour)
	created, err := q.CreateAuthSession(context.Background(), CreateAuthSessionParams{
		SessionKey: "e05f7f02-3cb9-4fd6-841d-d5f72e8c2f4f",
		UserID:     userID,
		Username:   "auth-session-user",
		IsAdmin:    false,
		ExpiresAt:  expiresAt,
	})
	require.NoError(t, err)
	assert.Equal(t, userID, created.UserID)

	fetched, err := q.GetAuthSessionBySessionKey(context.Background(), "e05f7f02-3cb9-4fd6-841d-d5f72e8c2f4f")
	require.NoError(t, err)
	assert.Equal(t, created.SessionKey, fetched.SessionKey)

	err = q.DeleteAuthSession(context.Background(), created.SessionKey)
	require.NoError(t, err)

	_, err = q.GetAuthSessionBySessionKey(context.Background(), "e05f7f02-3cb9-4fd6-841d-d5f72e8c2f4f")
	require.Error(t, err)
	assert.ErrorIs(t, err, pgx.ErrNoRows)
}

func TestCreateAuthSession_StoresSHA256Digest(t *testing.T) {
	q, pool := newQueries(t)
	userID := mustCreateUser(t, pool, "auth-session-hash-user")
	raw := "550e8400-e29b-41d4-a716-446655440000"
	digest := fmt.Sprintf("%x", sha256.Sum256([]byte(raw)))
	ctx := context.Background()
	_, err := q.CreateAuthSession(ctx, CreateAuthSessionParams{SessionKey: digest, UserID: userID, Username: "auth-session-hash-user", ExpiresAt: time.Now().Add(time.Hour)})
	require.NoError(t, err)
	stored, err := q.GetAuthSessionBySessionKey(ctx, digest)
	require.NoError(t, err)
	assert.Equal(t, digest, stored.SessionKey)
	_, err = q.GetAuthSessionBySessionKey(ctx, raw)
	require.ErrorIs(t, err, pgx.ErrNoRows)
	_, err = q.RefreshAuthSession(ctx, RefreshAuthSessionParams{SessionKey: digest, ExpiresAt: time.Now().Add(2 * time.Hour)})
	require.NoError(t, err)
	require.NoError(t, q.DeleteAuthSession(ctx, digest))
	_, err = q.GetAuthSessionBySessionKey(ctx, digest)
	require.ErrorIs(t, err, pgx.ErrNoRows)
}

func TestConsumeAuthNonce_OneTimeUse(t *testing.T) {
	q, _ := newQueries(t)

	expiresAt := time.Now().UTC().Add(10 * time.Minute)
	_, err := q.CreateAuthNonce(context.Background(), CreateAuthNonceParams{
		Nonce:     "nonce-abc",
		ExpiresAt: expiresAt,
	})
	require.NoError(t, err)

	rows, err := q.ConsumeAuthNonce(context.Background(), ConsumeAuthNonceParams{
		Nonce:         "nonce-abc",
		WalletAddress: pgtype.Text{String: "0x1234567890123456789012345678901234567890", Valid: true},
	})
	require.NoError(t, err)
	assert.Equal(t, int64(1), rows)

	rows, err = q.ConsumeAuthNonce(context.Background(), ConsumeAuthNonceParams{
		Nonce:         "nonce-abc",
		WalletAddress: pgtype.Text{String: "0x1234567890123456789012345678901234567890", Valid: true},
	})
	require.NoError(t, err)
	assert.Equal(t, int64(0), rows)
}

func TestCreateAndConsumeOAuthState_OneTimeUse(t *testing.T) {
	q, _ := newQueries(t)

	_, err := q.CreateOAuthState(context.Background(), CreateOAuthStateParams{
		State:       "oauth-state-1",
		ContextHash: "ctx-hash-1",
		ExpiresAt:   time.Now().UTC().Add(10 * time.Minute),
	})
	require.NoError(t, err)

	rows, err := q.ConsumeOAuthState(context.Background(), ConsumeOAuthStateParams{
		State:       "oauth-state-1",
		ContextHash: "ctx-hash-1",
	})
	require.NoError(t, err)
	assert.Equal(t, int64(1), rows)

	rows, err = q.ConsumeOAuthState(context.Background(), ConsumeOAuthStateParams{
		State:       "oauth-state-1",
		ContextHash: "ctx-hash-1",
	})
	require.NoError(t, err)
	assert.Equal(t, int64(0), rows)
}

func TestConsumeOAuthStateWithScopes_ReturnsRequestedScopesOnce(t *testing.T) {
	q, _ := newQueries(t)

	want := []string{"read:user", "write:agent", "write:workspace"}
	_, err := q.CreateOAuthState(context.Background(), CreateOAuthStateParams{
		State:           "oauth-state-scoped",
		ContextHash:     "ctx-hash-scoped",
		RequestedScopes: want,
		ExpiresAt:       time.Now().UTC().Add(10 * time.Minute),
	})
	require.NoError(t, err)

	got, err := q.ConsumeOAuthStateWithScopes(context.Background(), ConsumeOAuthStateWithScopesParams{
		State:       "oauth-state-scoped",
		ContextHash: "ctx-hash-scoped",
	})
	require.NoError(t, err)
	assert.Equal(t, want, got.RequestedScopes)

	_, err = q.ConsumeOAuthStateWithScopes(context.Background(), ConsumeOAuthStateWithScopesParams{
		State:       "oauth-state-scoped",
		ContextHash: "ctx-hash-scoped",
	})
	require.ErrorIs(t, err, pgx.ErrNoRows)
}

func TestConsumeOAuthState_ContextMismatchReturnsZero(t *testing.T) {
	q, _ := newQueries(t)

	_, err := q.CreateOAuthState(context.Background(), CreateOAuthStateParams{
		State:       "oauth-state-mismatch",
		ContextHash: "ctx-hash-expected",
		ExpiresAt:   time.Now().UTC().Add(10 * time.Minute),
	})
	require.NoError(t, err)

	rows, err := q.ConsumeOAuthState(context.Background(), ConsumeOAuthStateParams{
		State:       "oauth-state-mismatch",
		ContextHash: "ctx-hash-wrong",
	})
	require.NoError(t, err)
	assert.Equal(t, int64(0), rows)
}

func TestConsumeOAuthState_ExpiredReturnsZero(t *testing.T) {
	q, pool := newQueries(t)

	_, err := q.CreateOAuthState(context.Background(), CreateOAuthStateParams{
		State:       "oauth-state-expired",
		ContextHash: "ctx-hash-expired",
		ExpiresAt:   time.Now().UTC().Add(10 * time.Minute),
	})
	require.NoError(t, err)

	mustExec(
		t,
		pool,
		`UPDATE oauth_states SET expires_at = NOW() - interval '1 minute' WHERE state_key = $1`,
		"oauth-state-expired",
	)

	rows, err := q.ConsumeOAuthState(context.Background(), ConsumeOAuthStateParams{
		State:       "oauth-state-expired",
		ContextHash: "ctx-hash-expired",
	})
	require.NoError(t, err)
	assert.Equal(t, int64(0), rows)
}

func TestDeleteExpiredOAuthStates(t *testing.T) {
	q, pool := newQueries(t)

	_, err := q.CreateOAuthState(context.Background(), CreateOAuthStateParams{
		State:       "oauth-state-stale",
		ContextHash: "ctx-hash-stale",
		ExpiresAt:   time.Now().UTC().Add(10 * time.Minute),
	})
	require.NoError(t, err)
	_, err = q.CreateOAuthState(context.Background(), CreateOAuthStateParams{
		State:       "oauth-state-fresh",
		ContextHash: "ctx-hash-fresh",
		ExpiresAt:   time.Now().UTC().Add(10 * time.Minute),
	})
	require.NoError(t, err)

	mustExec(
		t,
		pool,
		`UPDATE oauth_states SET expires_at = NOW() - interval '1 minute' WHERE state_key = $1`,
		"oauth-state-stale",
	)

	err = q.DeleteExpiredOAuthStates(context.Background())
	require.NoError(t, err)

	var count int
	err = pool.QueryRow(
		context.Background(),
		`SELECT COUNT(*) FROM oauth_states`,
	).Scan(&count)
	require.NoError(t, err)
	assert.Equal(t, 1, count)

	rows, err := q.ConsumeOAuthState(context.Background(), ConsumeOAuthStateParams{
		State:       "oauth-state-fresh",
		ContextHash: "ctx-hash-fresh",
	})
	require.NoError(t, err)
	assert.Equal(t, int64(1), rows)
}

func TestUpsertEmailAddress_PrimaryUniqueness(t *testing.T) {
	q, pool := newQueries(t)
	userID := mustCreateUser(t, pool, "email-user")

	first, err := q.UpsertEmailAddress(context.Background(), UpsertEmailAddressParams{
		UserID:      userID,
		Email:       "one@example.com",
		LowerEmail:  "one@example.com",
		IsActivated: true,
		IsPrimary:   true,
	})
	require.NoError(t, err)
	assert.True(t, first.IsPrimary)

	second, err := q.UpsertEmailAddress(context.Background(), UpsertEmailAddressParams{
		UserID:      userID,
		Email:       "two@example.com",
		LowerEmail:  "two@example.com",
		IsActivated: false,
		IsPrimary:   true,
	})
	require.NoError(t, err)
	assert.True(t, second.IsPrimary)

	var primaryCount int64
	err = pool.QueryRow(
		context.Background(),
		`SELECT COUNT(*) FROM email_addresses WHERE user_id = $1 AND is_primary = TRUE`,
		userID,
	).Scan(&primaryCount)
	require.NoError(t, err)
	assert.Equal(t, int64(1), primaryCount)

	var primaryEmail string
	err = pool.QueryRow(
		context.Background(),
		`SELECT email FROM email_addresses WHERE user_id = $1 AND is_primary = TRUE`,
		userID,
	).Scan(&primaryEmail)
	require.NoError(t, err)
	assert.Equal(t, "two@example.com", primaryEmail)
}

func TestEmailAddresses_AtMostOnePrimaryPerUser_DBEnforced(t *testing.T) {
	_, pool := newQueries(t)
	userID := mustCreateUser(t, pool, "primary-db-constraint-user")

	mustExec(
		t,
		pool,
		`INSERT INTO email_addresses (user_id, email, lower_email, is_activated, is_primary)
		 VALUES ($1, 'one-primary@example.com', 'one-primary@example.com', TRUE, TRUE)`,
		userID,
	)

	_, err := pool.Exec(
		context.Background(),
		`INSERT INTO email_addresses (user_id, email, lower_email, is_activated, is_primary)
		 VALUES ($1, 'two-primary@example.com', 'two-primary@example.com', TRUE, TRUE)`,
		userID,
	)
	require.Error(t, err)
}

func TestSessionLifecycleQueries(t *testing.T) {
	q, pool := newQueries(t)
	userID := mustCreateUser(t, pool, "session-lifecycle-user")

	firstKey := "1c046df9-a0f0-4f3d-ab7a-ac81ce96ea5a"
	secondKey := "49addf97-8941-4f7e-bf36-f64d9a4ce4b5"

	_, err := q.CreateAuthSession(context.Background(), CreateAuthSessionParams{
		SessionKey: firstKey,
		UserID:     userID,
		Username:   "session-lifecycle-user",
		IsAdmin:    false,
		ExpiresAt:  time.Now().UTC().Add(24 * time.Hour),
	})
	require.NoError(t, err)

	_, err = q.CreateAuthSession(context.Background(), CreateAuthSessionParams{
		SessionKey: secondKey,
		UserID:     userID,
		Username:   "session-lifecycle-user",
		IsAdmin:    false,
		ExpiresAt:  time.Now().UTC().Add(12 * time.Hour),
	})
	require.NoError(t, err)

	sessions, err := q.ListUserSessions(context.Background(), userID)
	require.NoError(t, err)
	assert.Len(t, sessions, 2)

	err = q.UpdateSessionExpiry(context.Background(), UpdateSessionExpiryParams{
		SessionKey: secondKey,
		ExpiresAt:  time.Now().UTC().Add(48 * time.Hour),
	})
	require.NoError(t, err)

	mustExec(
		t,
		pool,
		`UPDATE auth_sessions SET expires_at = NOW() - interval '1 hour' WHERE session_key = $1`,
		firstKey,
	)
	err = q.DeleteExpiredSessions(context.Background())
	require.NoError(t, err)

	sessions, err = q.ListUserSessions(context.Background(), userID)
	require.NoError(t, err)
	assert.Len(t, sessions, 1)

	_, err = q.DeleteUserSessions(context.Background(), userID)
	require.NoError(t, err)

	sessions, err = q.ListUserSessions(context.Background(), userID)
	require.NoError(t, err)
	assert.Len(t, sessions, 0)
}

func TestAccessTokenQueries(t *testing.T) {
	q, pool := newQueries(t)
	userID := mustCreateUser(t, pool, "access-token-user")

	token, err := q.CreateAccessToken(context.Background(), CreateAccessTokenParams{
		UserID:         userID,
		Name:           "ci",
		TokenHash:      "token-hash-1",
		TokenLastEight: "89abcdef",
		Scopes:         "read:repository,write:repository",
	})
	require.NoError(t, err)
	assert.Equal(t, userID, token.UserID)

	tokens, err := q.ListUserAccessTokens(context.Background(), userID)
	require.NoError(t, err)
	require.Len(t, tokens, 1)
	assert.Equal(t, token.ID, tokens[0].ID)

	fetched, err := q.GetAccessTokenByID(context.Background(), token.ID)
	require.NoError(t, err)
	assert.Equal(t, "ci", fetched.Name)

	err = q.UpdateAccessTokenLastUsed(context.Background(), token.ID)
	require.NoError(t, err)

	fetched, err = q.GetAccessTokenByID(context.Background(), token.ID)
	require.NoError(t, err)
	assert.True(t, fetched.LastUsedAt.Valid)

	err = q.DeleteAccessToken(context.Background(), DeleteAccessTokenParams{
		ID:     token.ID,
		UserID: userID,
	})
	require.NoError(t, err)

	_, err = q.GetAccessTokenByID(context.Background(), token.ID)
	require.Error(t, err)
	assert.ErrorIs(t, err, pgx.ErrNoRows)

	otherUserID := mustCreateUser(t, pool, "access-token-other-user")
	token2, err := q.CreateAccessToken(context.Background(), CreateAccessTokenParams{
		UserID:         otherUserID,
		Name:           "other",
		TokenHash:      "token-hash-2",
		TokenLastEight: "01234567",
		Scopes:         "read:user",
	})
	require.NoError(t, err)

	err = q.DeleteAccessToken(context.Background(), DeleteAccessTokenParams{
		ID:     token2.ID,
		UserID: userID,
	})
	require.NoError(t, err)
	existing, err := q.GetAccessTokenByID(context.Background(), token2.ID)
	require.NoError(t, err)
	assert.Equal(t, otherUserID, existing.UserID)
}

func TestEmailAndVerificationQueries(t *testing.T) {
	q, pool := newQueries(t)
	userID := mustCreateUser(t, pool, "email-query-user")

	first, err := q.UpsertEmailAddress(context.Background(), UpsertEmailAddressParams{
		UserID:      userID,
		Email:       "first@example.com",
		LowerEmail:  "first@example.com",
		IsActivated: false,
		IsPrimary:   true,
	})
	require.NoError(t, err)

	second, err := q.UpsertEmailAddress(context.Background(), UpsertEmailAddressParams{
		UserID:      userID,
		Email:       "second@example.com",
		LowerEmail:  "second@example.com",
		IsActivated: false,
		IsPrimary:   false,
	})
	require.NoError(t, err)

	emails, err := q.ListUserEmails(context.Background(), userID)
	require.NoError(t, err)
	require.Len(t, emails, 2)
	assert.Equal(t, first.ID, emails[0].ID)

	primary, err := q.GetPrimaryEmail(context.Background(), userID)
	require.NoError(t, err)
	assert.Equal(t, first.ID, primary.ID)

	err = q.ActivateEmail(context.Background(), ActivateEmailParams{
		ID:     second.ID,
		UserID: userID,
	})
	require.NoError(t, err)
	secondFetched, err := q.GetEmailByID(context.Background(), second.ID)
	require.NoError(t, err)
	assert.True(t, secondFetched.IsActivated)

	verification, err := q.CreateEmailVerificationToken(context.Background(), CreateEmailVerificationTokenParams{
		UserID:    userID,
		Email:     "second@example.com",
		TokenHash: "verify-token-hash-1",
		TokenType: "verify",
		ExpiresAt: time.Now().UTC().Add(2 * time.Hour),
	})
	require.NoError(t, err)

	rows, err := q.ConsumeEmailVerificationToken(context.Background(), "verify-token-hash-1")
	require.NoError(t, err)
	assert.Equal(t, int64(1), rows)

	rows, err = q.ConsumeEmailVerificationToken(context.Background(), "verify-token-hash-1")
	require.NoError(t, err)
	assert.Equal(t, int64(0), rows)

	mustExec(
		t,
		pool,
		`UPDATE email_verification_tokens SET expires_at = NOW() - interval '1 hour' WHERE id = $1`,
		verification.ID,
	)
	err = q.DeleteExpiredVerificationTokens(context.Background())
	require.NoError(t, err)

	err = q.DeleteEmail(context.Background(), DeleteEmailParams{
		ID:     second.ID,
		UserID: userID,
	})
	require.NoError(t, err)

	_, err = q.GetEmailByID(context.Background(), second.ID)
	require.Error(t, err)
	assert.ErrorIs(t, err, pgx.ErrNoRows)
}

func TestNonceAndOAuthQueries(t *testing.T) {
	q, pool := newQueries(t)
	userID := mustCreateUser(t, pool, "oauth-user")

	_, err := q.CreateAuthNonce(context.Background(), CreateAuthNonceParams{
		Nonce:     "nonce-expire-1",
		ExpiresAt: time.Now().UTC().Add(10 * time.Minute),
	})
	require.NoError(t, err)
	mustExec(
		t,
		pool,
		`UPDATE auth_nonces SET expires_at = NOW() - interval '1 hour' WHERE nonce_key = $1`,
		"nonce-expire-1",
	)
	err = q.DeleteExpiredNonces(context.Background())
	require.NoError(t, err)

	account, err := q.CreateOAuthAccount(context.Background(), CreateOAuthAccountParams{
		UserID:                userID,
		Provider:              "github",
		ProviderUserID:        "12345",
		AccessTokenEncrypted:  []byte("access-token"),
		RefreshTokenEncrypted: []byte("refresh-token"),
		ProfileData:           []byte(`{"login":"octocat"}`),
	})
	require.NoError(t, err)

	byProvider, err := q.GetOAuthAccountByProvider(context.Background(), GetOAuthAccountByProviderParams{
		Provider:       "github",
		ProviderUserID: "12345",
	})
	require.NoError(t, err)
	assert.Equal(t, account.ID, byProvider.ID)

	accounts, err := q.ListUserOAuthAccounts(context.Background(), userID)
	require.NoError(t, err)
	require.Len(t, accounts, 1)

	err = q.DeleteOAuthAccount(context.Background(), DeleteOAuthAccountParams{
		ID:     account.ID,
		UserID: userID,
	})
	require.NoError(t, err)

	accounts, err = q.ListUserOAuthAccounts(context.Background(), userID)
	require.NoError(t, err)
	assert.Len(t, accounts, 0)
}

func TestRefreshAuthSession(t *testing.T) {
	q, pool := newQueries(t)
	userID := mustCreateUser(t, pool, "refresh-session-user")

	created, err := q.CreateAuthSession(context.Background(), CreateAuthSessionParams{
		SessionKey: "5f1f58f6-e2b5-4548-bf31-12f0131ec1f8",
		UserID:     userID,
		Username:   "refresh-session-user",
		IsAdmin:    false,
		ExpiresAt:  time.Now().UTC().Add(6 * time.Hour),
	})
	require.NoError(t, err)

	newExpiry := time.Now().UTC().Add(72 * time.Hour)
	refreshed, err := q.RefreshAuthSession(context.Background(), RefreshAuthSessionParams{
		SessionKey: created.SessionKey,
		ExpiresAt:  newExpiry,
	})
	require.NoError(t, err)
	assert.Equal(t, created.SessionKey, refreshed.SessionKey)
	assert.WithinDuration(t, newExpiry, refreshed.ExpiresAt, time.Second)
	assert.True(t, refreshed.UpdatedAt.After(created.UpdatedAt) || refreshed.UpdatedAt.Equal(created.UpdatedAt))
}

func TestGetOAuthAccountByProviderUserID(t *testing.T) {
	q, pool := newQueries(t)
	userID := mustCreateUser(t, pool, "oauth-provider-user")

	created, err := q.CreateOAuthAccount(context.Background(), CreateOAuthAccountParams{
		UserID:                userID,
		Provider:              "github",
		ProviderUserID:        "provider-user-42",
		AccessTokenEncrypted:  []byte("access-1"),
		RefreshTokenEncrypted: []byte("refresh-1"),
		ProfileData:           []byte(`{"login":"provider-user"}`),
	})
	require.NoError(t, err)

	found, err := q.GetOAuthAccountByProviderUserID(context.Background(), GetOAuthAccountByProviderUserIDParams{
		Provider:       "github",
		ProviderUserID: "provider-user-42",
	})
	require.NoError(t, err)
	assert.Equal(t, created.ID, found.ID)
	assert.Equal(t, created.UserID, found.UserID)
}

func TestUpsertOAuthAccount(t *testing.T) {
	q, pool := newQueries(t)
	userID := mustCreateUser(t, pool, "oauth-upsert-user")

	first, err := q.UpsertOAuthAccount(context.Background(), UpsertOAuthAccountParams{
		UserID:                userID,
		Provider:              "github",
		ProviderUserID:        "oauth-upsert-id",
		AccessTokenEncrypted:  []byte("enc-access-1"),
		RefreshTokenEncrypted: []byte("enc-refresh-1"),
		ProfileData:           []byte(`{"login":"first-login"}`),
	})
	require.NoError(t, err)
	assert.Equal(t, userID, first.UserID)

	second, err := q.UpsertOAuthAccount(context.Background(), UpsertOAuthAccountParams{
		UserID:                userID,
		Provider:              "github",
		ProviderUserID:        "oauth-upsert-id",
		AccessTokenEncrypted:  []byte("enc-access-2"),
		RefreshTokenEncrypted: []byte("enc-refresh-2"),
		ProfileData:           []byte(`{"login":"second-login"}`),
	})
	require.NoError(t, err)
	assert.Equal(t, first.ID, second.ID)
	assert.Equal(t, []byte("enc-access-2"), second.AccessTokenEncrypted)
	assert.Equal(t, []byte("enc-refresh-2"), second.RefreshTokenEncrypted)
	assert.JSONEq(t, `{"login":"second-login"}`, string(second.ProfileData))
}

func TestListAccessTokensByUserID(t *testing.T) {
	q, pool := newQueries(t)
	userID := mustCreateUser(t, pool, "list-token-user")

	created, err := q.CreateAccessToken(context.Background(), CreateAccessTokenParams{
		UserID:         userID,
		Name:           "ci",
		TokenHash:      "token-hash-list-1",
		TokenLastEight: "1234abcd",
		Scopes:         "read:repository",
	})
	require.NoError(t, err)

	tokens, err := q.ListAccessTokensByUserID(context.Background(), userID)
	require.NoError(t, err)
	require.Len(t, tokens, 1)
	assert.Equal(t, created.ID, tokens[0].ID)
}

func TestDeleteAccessTokenByIDAndUserID(t *testing.T) {
	q, pool := newQueries(t)
	userID := mustCreateUser(t, pool, "delete-token-user")

	token, err := q.CreateAccessToken(context.Background(), CreateAccessTokenParams{
		UserID:         userID,
		Name:           "delete-me",
		TokenHash:      "token-hash-delete-1",
		TokenLastEight: "89abcdef",
		Scopes:         "write:user",
	})
	require.NoError(t, err)

	rows, err := q.DeleteAccessTokenByIDAndUserID(context.Background(), DeleteAccessTokenByIDAndUserIDParams{
		ID:     token.ID,
		UserID: userID,
	})
	require.NoError(t, err)
	assert.Equal(t, int64(1), rows)

	_, err = q.GetAccessTokenByID(context.Background(), token.ID)
	require.Error(t, err)
	assert.ErrorIs(t, err, pgx.ErrNoRows)

	rows, err = q.DeleteAccessTokenByIDAndUserID(context.Background(), DeleteAccessTokenByIDAndUserIDParams{
		ID:     token.ID,
		UserID: userID,
	})
	require.NoError(t, err)
	assert.Equal(t, int64(0), rows)
}
