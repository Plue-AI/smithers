package services

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// SSETicketTTL is the default time-to-live for SSE tickets.
const SSETicketTTL = 30 * time.Second

// Compile-time check: *db.Queries satisfies SSETicketQuerier.
var _ SSETicketQuerier = (*db.Queries)(nil)

// SSETicketQuerier defines the database operations needed by SSETicketService.
type SSETicketQuerier interface {
	CreateSSETicket(ctx context.Context, arg db.CreateSSETicketParams) (db.SseTicket, error)
	ConsumeSSETicket(ctx context.Context, ticketHash string) (db.SseTicket, error)
	GetUserByID(ctx context.Context, id int64) (db.User, error)
	GetAuthInfoByTokenHash(ctx context.Context, tokenHash string) (db.GetAuthInfoByTokenHashRow, error)
	GetOAuth2AccessTokenByHash(ctx context.Context, tokenHash string) (db.Oauth2AccessToken, error)
	GetAuthSessionBySessionKey(ctx context.Context, sessionKey string) (db.AuthSession, error)
	LegacyAuthSessionLive(ctx context.Context, sessionDigest string) (bool, error)
}

// SSETicketService manages short-lived, single-use tickets for SSE authentication.
type SSETicketService struct {
	Queries SSETicketQuerier
	TTL     time.Duration
}

// NewSSETicketService creates a new SSETicketService with the default TTL.
func NewSSETicketService(queries SSETicketQuerier) *SSETicketService {
	return &SSETicketService{
		Queries: queries,
		TTL:     SSETicketTTL,
	}
}

// sseTicketGrant is the credential grant embedded in tickets minted by
// token-authenticated callers or by an identified browser session. It rides inside the raw ticket string, so it
// is integrity-bound by the SHA-256 hash stored in the database: any
// tampering changes the hash and the lookup fails.
type sseTicketGrant struct {
	TokenAuth bool   `json:"token_auth"`
	Scopes    string `json:"scopes"`
	TokenHash string `json:"token_hash,omitempty"`
	// SessionHash binds a session-minted ticket to its browser session so
	// logging out ends the stream the ticket opened.
	SessionHash string `json:"session_hash,omitempty"`
}

// SSETicketResult is the short-lived ticket and its database expiry.
type SSETicketResult struct {
	Ticket    string    `json:"ticket"`
	ExpiresAt time.Time `json:"expires_at"`
}

// CreateTicket generates a short-lived, single-use ticket for the given user.
// The raw ticket is returned to the caller; the database stores only its
// SHA-256 hash. Tickets minted by fine-grained tokens (tokenAuth) embed the
// minting token's hash and raw scope string so ticket auth retains its revocation
// identity and scope restrictions instead of escalating to session access.
// credentialHash is the minting token's hash, or for a session-minted ticket
// the SHA-256 of the browser session key.
func (s *SSETicketService) CreateTicket(ctx context.Context, userID int64, tokenAuth bool, rawScopes, credentialHash string) (SSETicketResult, error) {
	credentialHash = strings.TrimSpace(credentialHash)
	if tokenAuth && credentialHash == "" {
		return SSETicketResult{}, pkgerrors.Unauthorized("source token identity required for SSE ticket")
	}
	raw := make([]byte, 32)
	if _, err := io.ReadFull(rand.Reader, raw); err != nil {
		return SSETicketResult{}, pkgerrors.Internal("failed to generate SSE ticket").WithCause(err)
	}

	ticket := hex.EncodeToString(raw)
	var grant *sseTicketGrant
	switch {
	case tokenAuth:
		grant = &sseTicketGrant{TokenAuth: true, Scopes: strings.TrimSpace(rawScopes), TokenHash: credentialHash}
	case credentialHash != "":
		grant = &sseTicketGrant{SessionHash: credentialHash}
	}
	if grant != nil {
		encoded, err := json.Marshal(grant)
		if err != nil {
			return SSETicketResult{}, pkgerrors.Internal("failed to generate SSE ticket").WithCause(err)
		}
		ticket += "." + base64.RawURLEncoding.EncodeToString(encoded)
	}

	hash := sha256.Sum256([]byte(ticket))
	ticketHash := hex.EncodeToString(hash[:])

	ttl := s.TTL
	if ttl <= 0 {
		ttl = SSETicketTTL
	}

	row, err := s.Queries.CreateSSETicket(ctx, db.CreateSSETicketParams{
		TicketHash: ticketHash,
		UserID:     userID,
		ExpiresAt:  time.Now().UTC().Add(ttl),
	})
	if err != nil {
		return SSETicketResult{}, pkgerrors.Internal("failed to create SSE ticket").WithCause(err)
	}

	return SSETicketResult{Ticket: ticket, ExpiresAt: row.ExpiresAt}, nil
}

// ValidateTicket atomically consumes a ticket and returns the associated
// principal (user plus the scope grant of the credential that minted it).
// The ticket parameter is the raw (unhashed) ticket value.
// Returns an error if the ticket is invalid, expired, or already used.
func (s *SSETicketService) ValidateTicket(ctx context.Context, rawTicket string) (*middleware.SSETicketPrincipal, error) {
	if rawTicket == "" {
		return nil, pkgerrors.Unauthorized("invalid SSE ticket")
	}

	hash := sha256.Sum256([]byte(rawTicket))
	ticketHash := hex.EncodeToString(hash[:])

	ticket, err := s.Queries.ConsumeSSETicket(ctx, ticketHash)
	if err != nil {
		if err == pgx.ErrNoRows {
			return nil, pkgerrors.Unauthorized("invalid or expired SSE ticket")
		}
		return nil, pkgerrors.Internal("failed to validate SSE ticket").WithCause(err)
	}

	principal := &middleware.SSETicketPrincipal{}
	if _, suffix, ok := strings.Cut(rawTicket, "."); ok {
		payload, err := base64.RawURLEncoding.DecodeString(suffix)
		if err != nil {
			return nil, pkgerrors.Unauthorized("invalid SSE ticket")
		}
		var grant sseTicketGrant
		if err := json.Unmarshal(payload, &grant); err != nil {
			return nil, pkgerrors.Unauthorized("invalid SSE ticket")
		}
		principal.IsTokenAuth = grant.TokenAuth
		principal.RawScopes = grant.Scopes
		principal.TokenHash = grant.TokenHash
		principal.SessionHash = grant.SessionHash
	}

	if principal.IsTokenAuth {
		if err := s.validateSourceToken(ctx, ticket.UserID, principal.TokenHash, principal.RawScopes); err != nil {
			return nil, err
		}
	}
	if principal.SessionHash != "" {
		if err := s.validateSourceSession(ctx, ticket.UserID, principal.SessionHash); err != nil {
			return nil, err
		}
	}

	user, err := s.Queries.GetUserByID(ctx, ticket.UserID)
	if err != nil {
		if err == pgx.ErrNoRows {
			return nil, pkgerrors.Unauthorized("user not found")
		}
		return nil, pkgerrors.Internal(fmt.Sprintf("failed to load user for SSE ticket: %v", err))
	}

	if user.ProhibitLogin || (principal.IsTokenAuth && !user.IsActive) {
		return nil, pkgerrors.Forbidden("account is suspended")
	}

	principal.User = &user
	return principal, nil
}

// validateSourceToken uses the same expiry-filtered queries as AuthLoader.
// Reject changed grants instead of substituting current scopes, which could
// broaden the ticket or discard its embedded repository/path restrictions.
func (s *SSETicketService) validateSourceToken(ctx context.Context, userID int64, tokenHash, scopes string) error {
	if tokenHash == "" {
		// Old token grants cannot be checked for revocation; clients must mint again.
		return pkgerrors.Unauthorized("source token identity missing from SSE ticket")
	}
	pat, err := s.Queries.GetAuthInfoByTokenHash(ctx, tokenHash)
	if err == nil {
		if pat.ID != userID || strings.TrimSpace(pat.TokenScopes) != scopes {
			return pkgerrors.Unauthorized("SSE ticket source token grant changed")
		}
		return nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return pkgerrors.Internal("failed to validate SSE ticket source token")
	}
	oauth, err := s.Queries.GetOAuth2AccessTokenByHash(ctx, tokenHash)
	if errors.Is(err, pgx.ErrNoRows) {
		return pkgerrors.Unauthorized("SSE ticket source token was revoked or expired")
	}
	if err != nil {
		return pkgerrors.Internal("failed to validate SSE ticket source token").WithCause(err)
	}
	if oauth.UserID != userID || strings.Join(oauth.Scopes, ",") != scopes {
		return pkgerrors.Unauthorized("SSE ticket source token grant changed")
	}
	return nil
}

// validateSourceSession refuses a ticket whose minting browser session has
// since ended. A process that started after the logout has no cached
// revocation, so the durable session row is the authority.
func (s *SSETicketService) validateSourceSession(ctx context.Context, userID int64, sessionHash string) error {
	session, err := s.Queries.GetAuthSessionBySessionKey(ctx, sessionHash)
	switch {
	case err == nil:
		if session.UserID != userID || !session.ExpiresAt.After(time.Now()) {
			return pkgerrors.Unauthorized("invalid or expired SSE ticket")
		}
		return nil
	case !errors.Is(err, pgx.ErrNoRows):
		return pkgerrors.Internal("failed to validate SSE ticket").WithCause(err)
	}
	live, err := s.Queries.LegacyAuthSessionLive(ctx, sessionHash)
	if err != nil {
		return pkgerrors.Internal("failed to validate SSE ticket").WithCause(err)
	}
	if !live {
		return pkgerrors.Unauthorized("invalid or expired SSE ticket")
	}
	return nil
}
