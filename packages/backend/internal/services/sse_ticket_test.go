package services

import (
	"context"
	cryptorand "crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

type failingSSETicketRandomReader struct{}

func (failingSSETicketRandomReader) Read([]byte) (int, error) {
	return 0, errors.New("entropy unavailable")
}

type partialFailingSSETicketRandomReader struct {
	readOnce bool
}

func (r *partialFailingSSETicketRandomReader) Read(p []byte) (int, error) {
	if r.readOnce {
		return 0, errors.New("entropy unavailable after partial read")
	}
	r.readOnce = true
	copy(p, []byte("partial!"))
	return 8, nil
}

type mockSSETicketQuerier struct {
	createSSETicketFn            func(ctx context.Context, arg db.CreateSSETicketParams) (db.SseTicket, error)
	consumeSSETicketFn           func(ctx context.Context, ticketHash string) (db.SseTicket, error)
	getUserByIDFn                func(ctx context.Context, id int64) (db.User, error)
	getAuthInfoByTokenHashFn     func(ctx context.Context, tokenHash string) (db.GetAuthInfoByTokenHashRow, error)
	getOAuth2AccessTokenByHashFn func(ctx context.Context, tokenHash string) (db.Oauth2AccessToken, error)
	sessions                     map[string]db.AuthSession
	legacySessions               map[string]bool
	sessionErr                   error
}

func (m *mockSSETicketQuerier) GetAuthSessionBySessionKey(_ context.Context, key string) (db.AuthSession, error) {
	if m.sessionErr != nil {
		return db.AuthSession{}, m.sessionErr
	}
	if session, ok := m.sessions[key]; ok {
		return session, nil
	}
	return db.AuthSession{}, pgx.ErrNoRows
}

func (m *mockSSETicketQuerier) LegacyAuthSessionLive(_ context.Context, digest string) (bool, error) {
	return m.legacySessions[digest], nil
}

func (m *mockSSETicketQuerier) CreateSSETicket(ctx context.Context, arg db.CreateSSETicketParams) (db.SseTicket, error) {
	if m.createSSETicketFn != nil {
		return m.createSSETicketFn(ctx, arg)
	}
	return db.SseTicket{
		TicketHash: arg.TicketHash,
		UserID:     arg.UserID,
		ExpiresAt:  arg.ExpiresAt,
		CreatedAt:  time.Now(),
	}, nil
}

func (m *mockSSETicketQuerier) ConsumeSSETicket(ctx context.Context, ticketHash string) (db.SseTicket, error) {
	if m.consumeSSETicketFn != nil {
		return m.consumeSSETicketFn(ctx, ticketHash)
	}
	return db.SseTicket{}, pgx.ErrNoRows
}

func (m *mockSSETicketQuerier) GetUserByID(ctx context.Context, id int64) (db.User, error) {
	if m.getUserByIDFn != nil {
		return m.getUserByIDFn(ctx, id)
	}
	return db.User{}, pgx.ErrNoRows
}

func (m *mockSSETicketQuerier) GetAuthInfoByTokenHash(ctx context.Context, tokenHash string) (db.GetAuthInfoByTokenHashRow, error) {
	if m.getAuthInfoByTokenHashFn != nil {
		return m.getAuthInfoByTokenHashFn(ctx, tokenHash)
	}
	return db.GetAuthInfoByTokenHashRow{}, pgx.ErrNoRows
}

func (m *mockSSETicketQuerier) GetFirstPartyOAuth2AccessTokenByHash(ctx context.Context, tokenHash string) (db.Oauth2AccessToken, error) {
	if m.getOAuth2AccessTokenByHashFn != nil {
		return m.getOAuth2AccessTokenByHashFn(ctx, tokenHash)
	}
	return db.Oauth2AccessToken{}, pgx.ErrNoRows
}

func TestSSETicketService_CreateTicket_Success(t *testing.T) {
	t.Parallel()

	var capturedParams db.CreateSSETicketParams
	q := &mockSSETicketQuerier{
		createSSETicketFn: func(_ context.Context, arg db.CreateSSETicketParams) (db.SseTicket, error) {
			capturedParams = arg
			return db.SseTicket{
				TicketHash: arg.TicketHash,
				UserID:     arg.UserID,
				ExpiresAt:  arg.ExpiresAt,
				CreatedAt:  time.Now(),
			}, nil
		},
	}

	svc := NewSSETicketService(q)
	issued, err := svc.CreateTicket(context.Background(), 42, false, "", "")
	require.NoError(t, err)

	// Ticket should be 64 hex chars (32 bytes).
	assert.Len(t, issued.Ticket, 64)
	assert.Equal(t, capturedParams.ExpiresAt, issued.ExpiresAt)

	// The stored hash should be SHA-256 of the raw ticket.
	expectedHash := sha256.Sum256([]byte(issued.Ticket))
	assert.Equal(t, hex.EncodeToString(expectedHash[:]), capturedParams.TicketHash)

	// User ID should match.
	assert.Equal(t, int64(42), capturedParams.UserID)

	// Expiry should be roughly 30 seconds from now.
	assert.WithinDuration(t, time.Now().Add(30*time.Second), capturedParams.ExpiresAt, 2*time.Second)
}

func TestSSETicketService_CreateTicket_DBError(t *testing.T) {
	t.Parallel()

	q := &mockSSETicketQuerier{
		createSSETicketFn: func(context.Context, db.CreateSSETicketParams) (db.SseTicket, error) {
			return db.SseTicket{}, assert.AnError
		},
	}

	svc := NewSSETicketService(q)
	issued, err := svc.CreateTicket(context.Background(), 42, false, "", "")
	require.Error(t, err)
	assert.Empty(t, issued)
	assert.Contains(t, err.Error(), "failed to create SSE ticket")
}

func TestSSETicketService_CreateTicket_RandomFailureDoesNotInsert(t *testing.T) {
	oldReader := cryptorand.Reader
	cryptorand.Reader = failingSSETicketRandomReader{}
	t.Cleanup(func() { cryptorand.Reader = oldReader })

	createCalled := false
	q := &mockSSETicketQuerier{
		createSSETicketFn: func(context.Context, db.CreateSSETicketParams) (db.SseTicket, error) {
			createCalled = true
			return db.SseTicket{}, nil
		},
	}

	svc := NewSSETicketService(q)
	issued, err := svc.CreateTicket(context.Background(), 42, false, "", "")
	require.Error(t, err)
	assert.Empty(t, issued)
	assert.False(t, createCalled, "CreateTicket must fail closed before inserting predictable ticket bytes")
	assert.Contains(t, err.Error(), "failed to generate SSE ticket")
}

func TestSSETicketService_CreateTicket_PartialRandomReadDoesNotInsert(t *testing.T) {
	oldReader := cryptorand.Reader
	cryptorand.Reader = &partialFailingSSETicketRandomReader{}
	t.Cleanup(func() { cryptorand.Reader = oldReader })

	createCalled := false
	q := &mockSSETicketQuerier{
		createSSETicketFn: func(context.Context, db.CreateSSETicketParams) (db.SseTicket, error) {
			createCalled = true
			return db.SseTicket{}, nil
		},
	}

	svc := NewSSETicketService(q)
	issued, err := svc.CreateTicket(context.Background(), 42, false, "", "")
	require.Error(t, err)
	assert.Empty(t, issued)
	assert.False(t, createCalled, "CreateTicket must fail closed before inserting partially predictable ticket bytes")
	assert.Contains(t, err.Error(), "failed to generate SSE ticket")
}

func TestSSETicketService_ValidateTicket_Success(t *testing.T) {
	t.Parallel()

	rawTicket := "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890"
	expectedHash := sha256.Sum256([]byte(rawTicket))
	expectedHashStr := hex.EncodeToString(expectedHash[:])

	q := &mockSSETicketQuerier{
		consumeSSETicketFn: func(_ context.Context, ticketHash string) (db.SseTicket, error) {
			assert.Equal(t, expectedHashStr, ticketHash)
			return db.SseTicket{
				TicketHash: ticketHash,
				UserID:     42,
				ExpiresAt:  time.Now().Add(10 * time.Second),
				UsedAt:     pgtype.Timestamptz{Time: time.Now(), Valid: true},
			}, nil
		},
		getUserByIDFn: func(_ context.Context, id int64) (db.User, error) {
			assert.Equal(t, int64(42), id)
			return db.User{
				ID:       42,
				Username: "alice",
				IsActive: true,
			}, nil
		},
	}

	svc := NewSSETicketService(q)
	principal, err := svc.ValidateTicket(context.Background(), rawTicket)
	require.NoError(t, err)
	assert.Equal(t, int64(42), principal.User.ID)
	assert.Equal(t, "alice", principal.User.Username)
	assert.False(t, principal.IsTokenAuth)
	assert.Empty(t, principal.RawScopes)
}

func newSSETicketRoundTripQuerier() *mockSSETicketQuerier {
	store := map[string]db.SseTicket{}
	return &mockSSETicketQuerier{
		getAuthInfoByTokenHashFn: func(_ context.Context, tokenHash string) (db.GetAuthInfoByTokenHashRow, error) {
			if tokenHash == "pat-hash" {
				return db.GetAuthInfoByTokenHashRow{ID: 42, Username: "alice", IsActive: true, TokenID: 7, TokenScopes: "read:user"}, nil
			}
			return db.GetAuthInfoByTokenHashRow{}, pgx.ErrNoRows
		},
		createSSETicketFn: func(_ context.Context, arg db.CreateSSETicketParams) (db.SseTicket, error) {
			row := db.SseTicket{TicketHash: arg.TicketHash, UserID: arg.UserID, ExpiresAt: arg.ExpiresAt}
			store[arg.TicketHash] = row
			return row, nil
		},
		consumeSSETicketFn: func(_ context.Context, ticketHash string) (db.SseTicket, error) {
			row, ok := store[ticketHash]
			if !ok {
				return db.SseTicket{}, pgx.ErrNoRows
			}
			delete(store, ticketHash)
			return row, nil
		},
		getUserByIDFn: func(_ context.Context, id int64) (db.User, error) {
			return db.User{ID: id, Username: "alice", IsActive: true}, nil
		},
	}
}

func TestSSETicketService_TokenMintedTicketRoundTripsScopes(t *testing.T) {
	t.Parallel()

	svc := NewSSETicketService(newSSETicketRoundTripQuerier())
	issued, err := svc.CreateTicket(context.Background(), 42, true, "read:user", "pat-hash")
	require.NoError(t, err)

	// A token-minted ticket must retain the minting token's scope grant.
	principal, err := svc.ValidateTicket(context.Background(), issued.Ticket)
	require.NoError(t, err)
	assert.True(t, principal.IsTokenAuth)
	assert.Equal(t, "read:user", principal.RawScopes)
	assert.Equal(t, int64(42), principal.User.ID)
}

func TestSSETicketService_TokenMintedTicketRoundTripsTokenHash(t *testing.T) {
	t.Parallel()

	q := newSSETicketRoundTripQuerier()
	var lookedUp []string
	base := q.getAuthInfoByTokenHashFn
	q.getAuthInfoByTokenHashFn = func(ctx context.Context, tokenHash string) (db.GetAuthInfoByTokenHashRow, error) {
		lookedUp = append(lookedUp, tokenHash)
		return base(ctx, tokenHash)
	}
	svc := NewSSETicketService(q)
	issued, err := svc.CreateTicket(context.Background(), 42, true, "read:user", " pat-hash ")
	require.NoError(t, err)

	// The revocation identity of the minting credential rides inside the
	// ticket and comes back on the principal, so the stream it opens is
	// matched by a token_revoked event carrying that hash.
	principal, err := svc.ValidateTicket(context.Background(), issued.Ticket)
	require.NoError(t, err)
	assert.Equal(t, "pat-hash", principal.TokenHash)
	assert.Equal(t, []string{"pat-hash"}, lookedUp, "redemption must re-check the minting credential")
}

func TestSSETicketService_SessionMintedTicketCarriesOnlySessionHash(t *testing.T) {
	t.Parallel()

	q := newSSETicketRoundTripQuerier()
	q.getAuthInfoByTokenHashFn = func(context.Context, string) (db.GetAuthInfoByTokenHashRow, error) {
		t.Fatal("session tickets must not look up a token")
		return db.GetAuthInfoByTokenHashRow{}, nil
	}
	q.sessions = map[string]db.AuthSession{"session-hash": {SessionKey: "session-hash", UserID: 42, ExpiresAt: time.Now().Add(time.Hour)}}
	svc := NewSSETicketService(q)
	issued, err := svc.CreateTicket(context.Background(), 42, false, "", " session-hash ")
	require.NoError(t, err)

	principal, err := svc.ValidateTicket(context.Background(), issued.Ticket)
	require.NoError(t, err)
	assert.False(t, principal.IsTokenAuth)
	assert.Empty(t, principal.TokenHash, "a session ticket must not become token auth")
	assert.Empty(t, principal.RawScopes)
	assert.Equal(t, "session-hash", principal.SessionHash, "logout must be able to end the stream this ticket opens")
}

func TestSSETicketService_UnidentifiedSessionTicketCarriesNoGrant(t *testing.T) {
	t.Parallel()

	svc := NewSSETicketService(newSSETicketRoundTripQuerier())
	issued, err := svc.CreateTicket(context.Background(), 42, false, "", "")
	require.NoError(t, err)
	assert.NotContains(t, issued.Ticket, ".")
	principal, err := svc.ValidateTicket(context.Background(), issued.Ticket)
	require.NoError(t, err)
	assert.Empty(t, principal.SessionHash)
}

func TestSSETicketService_TamperedTokenHashRejected(t *testing.T) {
	t.Parallel()

	svc := NewSSETicketService(newSSETicketRoundTripQuerier())
	issued, err := svc.CreateTicket(context.Background(), 42, true, "read:user", "pat-hash")
	require.NoError(t, err)

	// Rebinding the ticket to another credential changes the stored hash, so
	// a stream cannot be detached from the credential that minted it.
	base, _, ok := strings.Cut(issued.Ticket, ".")
	require.True(t, ok)
	forged := base + "." + base64.RawURLEncoding.EncodeToString([]byte(`{"token_auth":true,"scopes":"read:user","token_hash":"someone-elses-hash"}`))
	principal, err := svc.ValidateTicket(context.Background(), forged)
	require.Error(t, err)
	assert.Nil(t, principal)

	// Dropping the hash entirely is also a different ticket.
	unbound := base + "." + base64.RawURLEncoding.EncodeToString([]byte(`{"token_auth":true,"scopes":"read:user"}`))
	principal, err = svc.ValidateTicket(context.Background(), unbound)
	require.Error(t, err)
	assert.Nil(t, principal)
}

func TestSSETicketService_RedemptionRefusedWhenSourceTokenIsGone(t *testing.T) {
	t.Parallel()

	q := newSSETicketRoundTripQuerier()
	svc := NewSSETicketService(q)
	issued, err := svc.CreateTicket(context.Background(), 42, true, "read:user", "pat-hash")
	require.NoError(t, err)

	// The PAT row is deleted between minting and redemption.
	q.getAuthInfoByTokenHashFn = func(context.Context, string) (db.GetAuthInfoByTokenHashRow, error) {
		return db.GetAuthInfoByTokenHashRow{}, pgx.ErrNoRows
	}
	principal, err := svc.ValidateTicket(context.Background(), issued.Ticket)
	require.Error(t, err)
	assert.Nil(t, principal)
	apiErr, ok := err.(*pkgerrors.APIError)
	require.True(t, ok, "err = %#v", err)
	assert.Equal(t, http.StatusUnauthorized, apiErr.Status)
	assert.Contains(t, err.Error(), "revoked")
}

func TestSSETicketService_RedemptionRefusesChangedTokenScopes(t *testing.T) {
	t.Parallel()

	q := newSSETicketRoundTripQuerier()
	svc := NewSSETicketService(q)
	issued, err := svc.CreateTicket(context.Background(), 42, true, "read:user,write:repository", "pat-hash")
	require.NoError(t, err)

	// Narrowing the credential invalidates outstanding tickets. Never substitute
	// live scopes into the embedded grant, which could also broaden it.
	principal, err := svc.ValidateTicket(context.Background(), issued.Ticket)
	require.Error(t, err)
	assert.Nil(t, principal)
}

func TestSSETicketService_RedemptionFallsBackToOAuth2Token(t *testing.T) {
	t.Parallel()

	q := newSSETicketRoundTripQuerier()
	q.getOAuth2AccessTokenByHashFn = func(_ context.Context, tokenHash string) (db.Oauth2AccessToken, error) {
		if tokenHash != "oauth-hash" {
			return db.Oauth2AccessToken{}, pgx.ErrNoRows
		}
		return db.Oauth2AccessToken{ID: 9, UserID: 42, Scopes: []string{"read:user"}}, nil
	}
	svc := NewSSETicketService(q)
	issued, err := svc.CreateTicket(context.Background(), 42, true, "read:user", "oauth-hash")
	require.NoError(t, err)

	principal, err := svc.ValidateTicket(context.Background(), issued.Ticket)
	require.NoError(t, err)
	assert.Equal(t, "oauth-hash", principal.TokenHash)
	assert.Equal(t, "read:user", principal.RawScopes)
}

func TestSSETicketService_RedemptionRefusesTokenOfAnotherUser(t *testing.T) {
	t.Parallel()

	q := newSSETicketRoundTripQuerier()
	svc := NewSSETicketService(q)
	// User 43 mints a ticket while presenting user 42's token hash in the grant
	// (only reachable through a bug upstream); the live row disagrees.
	issued, err := svc.CreateTicket(context.Background(), 43, true, "read:user", "pat-hash")
	require.NoError(t, err)

	principal, err := svc.ValidateTicket(context.Background(), issued.Ticket)
	require.Error(t, err)
	assert.Nil(t, principal)
}

func TestSSETicketService_LegacyGrantWithoutTokenHashIsRefused(t *testing.T) {
	t.Parallel()
	q := newSSETicketRoundTripQuerier()
	// Simulate an old, valid database record whose protected grant lacks identity.
	raw := "legacy." + base64.RawURLEncoding.EncodeToString([]byte(`{"token_auth":true,"scopes":"read:user"}`))
	hash := sha256.Sum256([]byte(raw))
	_, err := q.CreateSSETicket(context.Background(), db.CreateSSETicketParams{TicketHash: hex.EncodeToString(hash[:]), UserID: 42, ExpiresAt: time.Now().Add(SSETicketTTL)})
	require.NoError(t, err)
	principal, err := NewSSETicketService(q).ValidateTicket(context.Background(), raw)
	require.Error(t, err)
	assert.Nil(t, principal)
}

func TestSSETicketService_CreateTokenTicketRequiresTokenHash(t *testing.T) {
	t.Parallel()
	_, err := NewSSETicketService(newSSETicketRoundTripQuerier()).CreateTicket(context.Background(), 42, true, "read:user", " ")
	require.Error(t, err)
}

func TestSSETicketService_TamperedGrantRejected(t *testing.T) {
	t.Parallel()

	svc := NewSSETicketService(newSSETicketRoundTripQuerier())
	issued, err := svc.CreateTicket(context.Background(), 42, true, "read:user", "pat-hash")
	require.NoError(t, err)

	// Stripping the scope grant changes the hash, so the lookup must fail:
	// the grant is integrity-bound and cannot be dropped to escalate.
	base, _, ok := strings.Cut(issued.Ticket, ".")
	require.True(t, ok)
	principal, err := svc.ValidateTicket(context.Background(), base)
	require.Error(t, err)
	assert.Nil(t, principal)

	// Swapping in a broader grant also changes the hash.
	forged := base + "." + base64.RawURLEncoding.EncodeToString([]byte(`{"token_auth":true,"scopes":"all"}`))
	principal, err = svc.ValidateTicket(context.Background(), forged)
	require.Error(t, err)
	assert.Nil(t, principal)
}

func TestSSETicketService_ValidateTicket_Expired(t *testing.T) {
	t.Parallel()

	// ConsumeSSETicket returns ErrNoRows for expired tickets
	// (the WHERE clause filters on expires_at > NOW()).
	q := &mockSSETicketQuerier{
		consumeSSETicketFn: func(context.Context, string) (db.SseTicket, error) {
			return db.SseTicket{}, pgx.ErrNoRows
		},
	}

	svc := NewSSETicketService(q)
	user, err := svc.ValidateTicket(context.Background(), "someticket")
	require.Error(t, err)
	assert.Nil(t, user)
	assert.Contains(t, err.Error(), "invalid or expired SSE ticket")
}

func TestSSETicketService_ValidateTicket_AlreadyUsed(t *testing.T) {
	t.Parallel()

	// ConsumeSSETicket returns ErrNoRows for already-used tickets
	// (the WHERE clause filters on used_at IS NULL).
	q := &mockSSETicketQuerier{
		consumeSSETicketFn: func(context.Context, string) (db.SseTicket, error) {
			return db.SseTicket{}, pgx.ErrNoRows
		},
	}

	svc := NewSSETicketService(q)
	user, err := svc.ValidateTicket(context.Background(), "someticket")
	require.Error(t, err)
	assert.Nil(t, user)
	assert.Contains(t, err.Error(), "invalid or expired SSE ticket")
}

func TestSSETicketService_ValidateTicket_NotFound(t *testing.T) {
	t.Parallel()

	q := &mockSSETicketQuerier{
		consumeSSETicketFn: func(context.Context, string) (db.SseTicket, error) {
			return db.SseTicket{}, pgx.ErrNoRows
		},
	}

	svc := NewSSETicketService(q)
	user, err := svc.ValidateTicket(context.Background(), "nonexistent")
	require.Error(t, err)
	assert.Nil(t, user)
	assert.Contains(t, err.Error(), "invalid or expired SSE ticket")
}

func TestSSETicketService_ValidateTicket_UserNotFound(t *testing.T) {
	t.Parallel()

	q := &mockSSETicketQuerier{
		consumeSSETicketFn: func(context.Context, string) (db.SseTicket, error) {
			return db.SseTicket{
				TicketHash: "hash",
				UserID:     999,
				ExpiresAt:  time.Now().Add(10 * time.Second),
			}, nil
		},
		getUserByIDFn: func(context.Context, int64) (db.User, error) {
			return db.User{}, pgx.ErrNoRows
		},
	}

	svc := NewSSETicketService(q)
	user, err := svc.ValidateTicket(context.Background(), "someticket")
	require.Error(t, err)
	assert.Nil(t, user)
	assert.Contains(t, err.Error(), "user not found")
}

func TestSSETicketService_ValidateTicket_UserSuspended(t *testing.T) {
	t.Parallel()

	q := &mockSSETicketQuerier{
		consumeSSETicketFn: func(context.Context, string) (db.SseTicket, error) {
			return db.SseTicket{
				TicketHash: "hash",
				UserID:     42,
				ExpiresAt:  time.Now().Add(10 * time.Second),
			}, nil
		},
		getUserByIDFn: func(context.Context, int64) (db.User, error) {
			return db.User{
				ID:            42,
				Username:      "banned",
				ProhibitLogin: true,
			}, nil
		},
	}

	svc := NewSSETicketService(q)
	user, err := svc.ValidateTicket(context.Background(), "someticket")
	require.Error(t, err)
	assert.Nil(t, user)
	assert.Contains(t, err.Error(), "account is suspended")
}

func TestSSETicketService_ValidateTicket_EmptyTicket(t *testing.T) {
	t.Parallel()

	q := &mockSSETicketQuerier{}
	svc := NewSSETicketService(q)
	user, err := svc.ValidateTicket(context.Background(), "")
	require.Error(t, err)
	assert.Nil(t, user)
	assert.Contains(t, err.Error(), "invalid SSE ticket")
}

func TestSSETicketService_ValidateTicket_DBError(t *testing.T) {
	t.Parallel()

	q := &mockSSETicketQuerier{
		consumeSSETicketFn: func(context.Context, string) (db.SseTicket, error) {
			return db.SseTicket{}, assert.AnError
		},
	}

	svc := NewSSETicketService(q)
	user, err := svc.ValidateTicket(context.Background(), "someticket")
	require.Error(t, err)
	assert.Nil(t, user)
	assert.Contains(t, err.Error(), "failed to validate SSE ticket")
}

func TestSSETicketService_HashedAtRest(t *testing.T) {
	t.Parallel()

	var storedHash string
	q := &mockSSETicketQuerier{
		createSSETicketFn: func(_ context.Context, arg db.CreateSSETicketParams) (db.SseTicket, error) {
			storedHash = arg.TicketHash
			return db.SseTicket{
				TicketHash: arg.TicketHash,
				UserID:     arg.UserID,
			}, nil
		},
	}

	svc := NewSSETicketService(q)
	issued, err := svc.CreateTicket(context.Background(), 1, false, "", "")
	require.NoError(t, err)
	rawTicket := issued.Ticket

	// The stored hash must NOT equal the raw ticket.
	assert.NotEqual(t, rawTicket, storedHash)

	// The stored hash must equal SHA-256(rawTicket).
	expected := sha256.Sum256([]byte(rawTicket))
	assert.Equal(t, hex.EncodeToString(expected[:]), storedHash)
}

func TestSSETicketService_SessionTicketRequiresLiveSourceSession(t *testing.T) {
	t.Parallel()
	live := time.Now().Add(time.Hour)
	cases := []struct {
		name     string
		sessions map[string]db.AuthSession
		legacy   map[string]bool
		err      error
		wantOK   bool
	}{
		{"current session", map[string]db.AuthSession{"h": {UserID: 42, ExpiresAt: live}}, nil, nil, true},
		{"legacy raw-keyed session", nil, map[string]bool{"h": true}, nil, true},
		{"logged out", nil, nil, nil, false},
		{"expired", map[string]db.AuthSession{"h": {UserID: 42, ExpiresAt: time.Now().Add(-time.Minute)}}, nil, nil, false},
		{"another user's session", map[string]db.AuthSession{"h": {UserID: 43, ExpiresAt: live}}, nil, nil, false},
		{"store unavailable", nil, nil, errors.New("db down"), false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			q := newSSETicketRoundTripQuerier()
			svc := NewSSETicketService(q)
			issued, err := svc.CreateTicket(context.Background(), 42, false, "", "h")
			require.NoError(t, err)
			q.sessions, q.legacySessions, q.sessionErr = tc.sessions, tc.legacy, tc.err
			principal, err := svc.ValidateTicket(context.Background(), issued.Ticket)
			if tc.wantOK {
				require.NoError(t, err)
				assert.Equal(t, "h", principal.SessionHash)
				return
			}
			require.Error(t, err)
			assert.Nil(t, principal)
		})
	}
}
