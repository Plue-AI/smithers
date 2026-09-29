package db

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestAuthSQL_H_EmailVerificationSessionTokenAndOAuthRoundTrip(t *testing.T) {
	ctx := context.Background()
	q, pool := newQueries(t)
	userID := mustCreateUser(t, pool, uniqueTestUsername(t))

	firstEmail, err := q.UpsertEmailAddress(ctx, UpsertEmailAddressParams{
		UserID: userID, IsPrimary: true, Email: "first-auth-h@example.com", LowerEmail: "first-auth-h@example.com", IsActivated: false,
	})
	require.NoError(t, err)
	secondEmail, err := q.UpsertEmailAddress(ctx, UpsertEmailAddressParams{
		UserID: userID, IsPrimary: true, Email: "second-auth-h@example.com", LowerEmail: "second-auth-h@example.com", IsActivated: true,
	})
	require.NoError(t, err)
	assert.True(t, secondEmail.IsPrimary)

	primary, err := q.GetPrimaryEmail(ctx, userID)
	require.NoError(t, err)
	assert.Equal(t, secondEmail.ID, primary.ID)
	gotFirst, err := q.GetEmailByID(ctx, firstEmail.ID)
	require.NoError(t, err)
	assert.False(t, gotFirst.IsPrimary)

	emails, err := q.ListUserEmails(ctx, userID)
	require.NoError(t, err)
	require.Len(t, emails, 2)
	assert.Equal(t, secondEmail.ID, emails[0].ID)

	// Re-upsert the current primary with IsPrimary:false to test demotion.
	updatedSecond, err := q.UpsertEmailAddress(ctx, UpsertEmailAddressParams{
		UserID: userID, IsPrimary: false, Email: "SECOND-AUTH-H@example.com", LowerEmail: "second-auth-h@example.com", IsActivated: true,
	})
	require.NoError(t, err)
	assert.Equal(t, secondEmail.ID, updatedSecond.ID)
	assert.Equal(t, "SECOND-AUTH-H@example.com", updatedSecond.Email)

	verifyHash := "verify-" + randSlug(t)
	verification, err := q.CreateEmailVerificationToken(ctx, CreateEmailVerificationTokenParams{
		UserID: userID, Email: updatedSecond.Email, TokenHash: verifyHash, TokenType: "verify", ExpiresAt: time.Now().Add(time.Hour),
	})
	require.NoError(t, err)
	assert.Equal(t, userID, verification.UserID)
	rows, err := q.ConsumeEmailVerificationToken(ctx, verifyHash)
	require.NoError(t, err)
	assert.Equal(t, int64(1), rows)
	rows, err = q.ConsumeEmailVerificationToken(ctx, verifyHash)
	require.NoError(t, err)
	assert.Zero(t, rows)

	expiredVerifyHash := "verify-exp-" + randSlug(t)
	_, err = q.CreateEmailVerificationToken(ctx, CreateEmailVerificationTokenParams{
		UserID: userID, Email: updatedSecond.Email, TokenHash: expiredVerifyHash, TokenType: "reset", ExpiresAt: time.Now().Add(-time.Hour),
	})
	require.NoError(t, err)
	rows, err = q.ConsumeEmailVerificationToken(ctx, expiredVerifyHash)
	require.NoError(t, err)
	assert.Zero(t, rows)
	require.NoError(t, q.DeleteExpiredVerificationTokens(ctx))

	sessionKey := uuid.NewString()
	_, err = q.CreateAuthSession(ctx, CreateAuthSessionParams{
		SessionKey: sessionKey, UserID: userID, Username: "auth-h-user", IsAdmin: false, ExpiresAt: time.Now().Add(time.Hour),
	})
	require.NoError(t, err)
	newExpiry := time.Now().Add(2 * time.Hour)
	require.NoError(t, q.UpdateSessionExpiry(ctx, UpdateSessionExpiryParams{ExpiresAt: newExpiry, SessionKey: sessionKey}))
	require.NoError(t, q.DeleteAuthSession(ctx, sessionKey))
	_, err = q.GetAuthSessionBySessionKey(ctx, sessionKey)
	require.ErrorIs(t, err, pgx.ErrNoRows)

	expiredSessionKey := uuid.NewString()
	_, err = q.CreateAuthSession(ctx, CreateAuthSessionParams{
		SessionKey: expiredSessionKey, UserID: userID, Username: "auth-h-user", IsAdmin: false, ExpiresAt: time.Now().Add(-time.Hour),
	})
	require.NoError(t, err)
	require.NoError(t, q.DeleteExpiredSessions(ctx))
	_, err = q.GetAuthSessionBySessionKey(ctx, expiredSessionKey)
	require.ErrorIs(t, err, pgx.ErrNoRows)

	activeSessionKey := uuid.NewString()
	_, err = q.CreateAuthSession(ctx, CreateAuthSessionParams{
		SessionKey: activeSessionKey, UserID: userID, Username: "auth-h-user", IsAdmin: false, ExpiresAt: time.Now().Add(time.Hour),
	})
	require.NoError(t, err)
	require.NoError(t, q.DeleteUserSessions(ctx, userID))
	_, err = q.GetAuthSessionBySessionKey(ctx, activeSessionKey)
	require.ErrorIs(t, err, pgx.ErrNoRows)

	nonce := "nonce-" + randSlug(t)
	_, err = q.CreateAuthNonce(ctx, CreateAuthNonceParams{Nonce: nonce, ExpiresAt: time.Now().Add(time.Hour)})
	require.NoError(t, err)
	rows, err = q.ConsumeAuthNonce(ctx, ConsumeAuthNonceParams{
		Nonce: nonce, WalletAddress: pgtype.Text{String: "0x1234567890123456789012345678901234567890", Valid: true},
	})
	require.NoError(t, err)
	assert.Equal(t, int64(1), rows)
	rows, err = q.ConsumeAuthNonce(ctx, ConsumeAuthNonceParams{Nonce: nonce})
	require.NoError(t, err)
	assert.Zero(t, rows)

	expiredState, err := q.CreateOAuthState(ctx, CreateOAuthStateParams{
		State: "state-" + randSlug(t), ContextHash: "ctx-" + randSlug(t), ExpiresAt: time.Now().Add(-time.Hour),
	})
	require.NoError(t, err)
	require.NoError(t, q.DeleteExpiredOAuthStates(ctx))
	rows, err = q.ConsumeOAuthState(ctx, ConsumeOAuthStateParams{State: expiredState.StateKey, ContextHash: expiredState.ContextHash})
	require.NoError(t, err)
	assert.Zero(t, rows)

	tokenOne, err := q.CreateAccessToken(ctx, CreateAccessTokenParams{
		UserID: userID, Name: "ci-one", TokenHash: "pat-one-" + randSlug(t), TokenLastEight: "11111111", Scopes: "read",
	})
	require.NoError(t, err)
	tokenTwo, err := q.CreateAccessToken(ctx, CreateAccessTokenParams{
		UserID: userID, Name: "ci-two", TokenHash: "pat-two-" + randSlug(t), TokenLastEight: "22222222", Scopes: "write",
	})
	require.NoError(t, err)
	byID, err := q.ListAccessTokensByUserID(ctx, userID)
	require.NoError(t, err)
	require.Len(t, byID, 2)
	userTokens, err := q.ListUserAccessTokens(ctx, userID)
	require.NoError(t, err)
	require.Len(t, userTokens, 2)
	require.NoError(t, q.UpdateAccessTokenLastUsed(ctx, tokenOne.ID))
	used, err := q.GetAccessTokenByID(ctx, tokenOne.ID)
	require.NoError(t, err)
	assert.True(t, used.LastUsedAt.Valid)
	assert.NotEqual(t, tokenOne.ID, tokenTwo.ID)

	account, err := q.UpsertOAuthAccount(ctx, UpsertOAuthAccountParams{
		UserID: userID, Provider: "github", ProviderUserID: "auth-h-" + randSlug(t),
		AccessTokenEncrypted: []byte("access-1"), RefreshTokenEncrypted: []byte("refresh-1"), ProfileData: []byte(`{"login":"auth-h"}`),
	})
	require.NoError(t, err)
	account, err = q.UpsertOAuthAccountPreserveRefresh(ctx, UpsertOAuthAccountPreserveRefreshParams{
		UserID: userID, Provider: account.Provider, ProviderUserID: account.ProviderUserID,
		AccessTokenEncrypted: []byte("access-2"), ProfileData: []byte(`{"login":"auth-h-updated"}`),
	})
	require.NoError(t, err)
	assert.Equal(t, []byte("refresh-1"), account.RefreshTokenEncrypted)
	accounts, err := q.ListUserOAuthAccounts(ctx, userID)
	require.NoError(t, err)
	require.Len(t, accounts, 1)

	cleared, err := q.ClearOAuthAccountRefreshTokenCAS(ctx, ClearOAuthAccountRefreshTokenCASParams{
		Provider: account.Provider, ProviderUserID: account.ProviderUserID,
		OldAccessTokenEncrypted: []byte("access-2"), OldRefreshTokenEncrypted: []byte("refresh-1"),
	})
	require.NoError(t, err)
	assert.Equal(t, int64(1), cleared)
	cleared, err = q.ClearOAuthAccountRefreshTokenCAS(ctx, ClearOAuthAccountRefreshTokenCASParams{
		Provider: account.Provider, ProviderUserID: account.ProviderUserID,
		OldAccessTokenEncrypted: []byte("access-2"), OldRefreshTokenEncrypted: []byte("refresh-1"),
	})
	require.NoError(t, err)
	assert.Zero(t, cleared)
	accounts, err = q.ListUserOAuthAccounts(ctx, userID)
	require.NoError(t, err)
	require.Len(t, accounts, 1)
	assert.Nil(t, accounts[0].RefreshTokenEncrypted)

	require.NoError(t, q.DeleteEmail(ctx, DeleteEmailParams{ID: firstEmail.ID, UserID: userID}))
	_, err = q.GetEmailByID(ctx, firstEmail.ID)
	require.ErrorIs(t, err, pgx.ErrNoRows)
}

func TestAuthSQL_H_ReupsertCurrentPrimary(t *testing.T) {
	ctx := context.Background()
	q, pool := newQueries(t)
	userID := mustCreateUser(t, pool, uniqueTestUsername(t))

	first, err := q.UpsertEmailAddress(ctx, UpsertEmailAddressParams{
		UserID: userID, IsPrimary: true, Email: "alice@example.com", LowerEmail: "alice@example.com", IsActivated: false,
	})
	require.NoError(t, err)

	// A normal retry must not update the same row twice in one statement.
	retried, err := q.UpsertEmailAddress(ctx, UpsertEmailAddressParams{
		UserID: userID, IsPrimary: true, Email: "alice@example.com", LowerEmail: "alice@example.com", IsActivated: false,
	})
	require.NoError(t, err)
	assert.Equal(t, first.ID, retried.ID)
	assert.True(t, retried.IsPrimary)

	primary, err := q.GetPrimaryEmail(ctx, userID)
	require.NoError(t, err)
	assert.Equal(t, first.ID, primary.ID)
	emails, err := q.ListUserEmails(ctx, userID)
	require.NoError(t, err)
	require.Len(t, emails, 1)
}

func TestAuthSQL_H_VerifyExistingPrimary(t *testing.T) {
	ctx := context.Background()
	q, pool := newQueries(t)
	userID := mustCreateUser(t, pool, uniqueTestUsername(t))
	first, err := q.UpsertEmailAddress(ctx, UpsertEmailAddressParams{
		UserID: userID, IsPrimary: true, Email: "alice@example.com", LowerEmail: "alice@example.com", IsActivated: false,
	})
	require.NoError(t, err)

	// A verified OAuth email must activate the existing primary row.
	verified, err := q.UpsertEmailAddress(ctx, UpsertEmailAddressParams{
		UserID: userID, IsPrimary: true, Email: "ALICE@example.com", LowerEmail: "alice@example.com", IsActivated: true,
	})
	require.NoError(t, err)
	assert.Equal(t, first.ID, verified.ID)
	assert.True(t, verified.IsPrimary)
	assert.True(t, verified.IsActivated)
	assert.Equal(t, "ALICE@example.com", verified.Email)

	primary, err := q.GetPrimaryEmail(ctx, userID)
	require.NoError(t, err)
	assert.Equal(t, first.ID, primary.ID)
	assert.True(t, primary.IsActivated)
	emails, err := q.ListUserEmails(ctx, userID)
	require.NoError(t, err)
	require.Len(t, emails, 1)
}

func TestAuthSQL_H_MissingRowsEmptyListsAndConstraintErrors(t *testing.T) {
	ctx := context.Background()
	q, pool := newQueries(t)
	userID := mustCreateUser(t, pool, uniqueTestUsername(t))
	otherUserID := mustCreateUser(t, pool, uniqueTestUsername(t))

	_, err := q.GetEmailByID(ctx, 999999999)
	require.ErrorIs(t, err, pgx.ErrNoRows)
	_, err = q.GetPrimaryEmail(ctx, userID)
	require.ErrorIs(t, err, pgx.ErrNoRows)
	tokens, err := q.ListAccessTokensByUserID(ctx, userID)
	require.NoError(t, err)
	assert.Empty(t, tokens)
	userTokens, err := q.ListUserAccessTokens(ctx, userID)
	require.NoError(t, err)
	assert.Empty(t, userTokens)
	emails, err := q.ListUserEmails(ctx, userID)
	require.NoError(t, err)
	assert.Empty(t, emails)
	accounts, err := q.ListUserOAuthAccounts(ctx, userID)
	require.NoError(t, err)
	assert.Empty(t, accounts)

	_, err = q.UpsertEmailAddress(ctx, UpsertEmailAddressParams{
		UserID: userID, IsPrimary: false, Email: "shared-auth-h@example.com", LowerEmail: "shared-auth-h@example.com", IsActivated: true,
	})
	require.NoError(t, err)
	mustExpectQueryError(t, pool, func(spQ *Queries) error {
		_, err := spQ.UpsertEmailAddress(ctx, UpsertEmailAddressParams{
			UserID: otherUserID, IsPrimary: false, Email: "Shared-Auth-H@example.com", LowerEmail: "shared-auth-h@example.com", IsActivated: true,
		})
		return err
	})
	mustExpectQueryError(t, pool, func(spQ *Queries) error {
		_, err := spQ.CreateEmailVerificationToken(ctx, CreateEmailVerificationTokenParams{
			UserID: userID, Email: "bad-auth-h@example.com", TokenHash: "bad-verify-" + randSlug(t), TokenType: "bad", ExpiresAt: time.Now().Add(time.Hour),
		})
		return err
	})
	mustExpectQueryError(t, pool, func(spQ *Queries) error {
		_, err := spQ.UpsertOAuthAccount(ctx, UpsertOAuthAccountParams{
			UserID: userID, Provider: "github", ProviderUserID: "bad-json-" + randSlug(t),
			AccessTokenEncrypted: []byte("access"), RefreshTokenEncrypted: []byte("refresh"), ProfileData: []byte(`[1]`),
		})
		return err
	})
}

func TestAuthSQL_H_ManyErrorBranches(t *testing.T) {
	sentinel := errors.New("auth h rows failed")
	cases := []struct {
		name string
		call func(*Queries) error
	}{
		{"ListAccessTokensByUserID", func(q *Queries) error { _, err := q.ListAccessTokensByUserID(context.Background(), 1); return err }},
		{"ListUserAccessTokens", func(q *Queries) error { _, err := q.ListUserAccessTokens(context.Background(), 1); return err }},
		{"ListUserEmails", func(q *Queries) error { _, err := q.ListUserEmails(context.Background(), 1); return err }},
		{"ListUserOAuthAccounts", func(q *Queries) error { _, err := q.ListUserOAuthAccounts(context.Background(), 1); return err }},
	}

	for _, tc := range cases {
		t.Run(tc.name+"_query", func(t *testing.T) {
			err := tc.call(New(authSQLHDB{queryErr: sentinel}))
			require.ErrorIs(t, err, sentinel)
		})
		t.Run(tc.name+"_scan", func(t *testing.T) {
			err := tc.call(New(authSQLHDB{rows: &authSQLHRows{next: true, scanErr: sentinel}}))
			require.ErrorIs(t, err, sentinel)
		})
		t.Run(tc.name+"_rows_err", func(t *testing.T) {
			err := tc.call(New(authSQLHDB{rows: &authSQLHRows{err: sentinel}}))
			require.ErrorIs(t, err, sentinel)
		})
	}
}

func TestAuthSQL_H_ExecErrorBranches(t *testing.T) {
	sentinel := errors.New("auth h exec failed")
	q := New(authSQLHDB{execErr: sentinel})

	cases := []struct {
		name string
		call func() error
	}{
		{"ClearOAuthAccountRefreshTokenCAS", func() error {
			_, err := q.ClearOAuthAccountRefreshTokenCAS(context.Background(), ClearOAuthAccountRefreshTokenCASParams{Provider: "github", ProviderUserID: "u"})
			return err
		}},
		{"ConsumeAuthNonce", func() error {
			_, err := q.ConsumeAuthNonce(context.Background(), ConsumeAuthNonceParams{Nonce: "n"})
			return err
		}},
		{"ConsumeEmailVerificationToken", func() error {
			_, err := q.ConsumeEmailVerificationToken(context.Background(), "h")
			return err
		}},
		{"DeleteAuthSession", func() error { return q.DeleteAuthSession(context.Background(), uuid.Nil.String()) }},
		{"DeleteEmail", func() error { return q.DeleteEmail(context.Background(), DeleteEmailParams{ID: 1, UserID: 1}) }},
		{"DeleteExpiredOAuthStates", func() error { return q.DeleteExpiredOAuthStates(context.Background()) }},
		{"DeleteExpiredSessions", func() error { return q.DeleteExpiredSessions(context.Background()) }},
		{"DeleteExpiredVerificationTokens", func() error { return q.DeleteExpiredVerificationTokens(context.Background()) }},
		{"DeleteUserSessions", func() error { return q.DeleteUserSessions(context.Background(), 1) }},
		{"UpdateAccessTokenLastUsed", func() error { return q.UpdateAccessTokenLastUsed(context.Background(), 1) }},
		{"UpdateSessionExpiry", func() error {
			return q.UpdateSessionExpiry(context.Background(), UpdateSessionExpiryParams{ExpiresAt: time.Now(), SessionKey: uuid.Nil.String()})
		}},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			require.ErrorIs(t, tc.call(), sentinel)
		})
	}
}

func TestAuthSQL_H_QueryRowErrorBranches(t *testing.T) {
	sentinel := errors.New("auth h row failed")
	q := New(authSQLHDB{row: authSQLHRow{err: sentinel}})

	_, err := q.CreateEmailVerificationToken(context.Background(), CreateEmailVerificationTokenParams{})
	require.ErrorIs(t, err, sentinel)
	_, err = q.GetEmailByID(context.Background(), 1)
	require.ErrorIs(t, err, sentinel)
	_, err = q.GetPrimaryEmail(context.Background(), 1)
	require.ErrorIs(t, err, sentinel)
	_, err = q.UpsertEmailAddress(context.Background(), UpsertEmailAddressParams{})
	require.ErrorIs(t, err, sentinel)
	_, err = q.UpsertOAuthAccount(context.Background(), UpsertOAuthAccountParams{})
	require.ErrorIs(t, err, sentinel)
	_, err = q.UpsertOAuthAccountPreserveRefresh(context.Background(), UpsertOAuthAccountPreserveRefreshParams{})
	require.ErrorIs(t, err, sentinel)
}

type authSQLHDB struct {
	execErr  error
	queryErr error
	rows     pgx.Rows
	row      pgx.Row
}

func (db authSQLHDB) Exec(context.Context, string, ...interface{}) (pgconn.CommandTag, error) {
	return pgconn.CommandTag{}, db.execErr
}

func (db authSQLHDB) Query(context.Context, string, ...interface{}) (pgx.Rows, error) {
	if db.queryErr != nil {
		return nil, db.queryErr
	}
	if db.rows != nil {
		return db.rows, nil
	}
	return &authSQLHRows{}, nil
}

func (db authSQLHDB) QueryRow(context.Context, string, ...interface{}) pgx.Row {
	if db.row != nil {
		return db.row
	}
	return authSQLHRow{err: errors.New("auth h row failed")}
}

type authSQLHRow struct {
	err error
}

func (r authSQLHRow) Scan(...any) error {
	return r.err
}

type authSQLHRows struct {
	next    bool
	scanErr error
	err     error
}

func (r *authSQLHRows) Close() {}

func (r *authSQLHRows) Err() error {
	return r.err
}

func (r *authSQLHRows) CommandTag() pgconn.CommandTag {
	return pgconn.CommandTag{}
}

func (r *authSQLHRows) FieldDescriptions() []pgconn.FieldDescription {
	return nil
}

func (r *authSQLHRows) Next() bool {
	if r.next {
		r.next = false
		return true
	}
	return false
}

func (r *authSQLHRows) Scan(...any) error {
	if r.scanErr != nil {
		return r.scanErr
	}
	return errors.New("auth h scan unexpectedly succeeded")
}

func (r *authSQLHRows) Values() ([]any, error) {
	return nil, r.err
}

func (r *authSQLHRows) RawValues() [][]byte {
	return nil
}

func (r *authSQLHRows) Conn() *pgx.Conn {
	return nil
}
