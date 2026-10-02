package services

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"net/url"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/revocation"
)

// OAuth2 token durations.
const (
	oauth2AuthCodeTTL     = 10 * time.Minute
	oauth2AccessTokenTTL  = 1 * time.Hour
	oauth2RefreshTokenTTL = 90 * 24 * time.Hour // 90 days
)

// OAuth2Querier defines the database operations needed by OAuth2Service.
type OAuth2Querier interface {
	GetOAuth2ApplicationByClientID(ctx context.Context, clientID string) (db.Oauth2Application, error)

	CreateOAuth2AuthorizationCode(ctx context.Context, arg db.CreateOAuth2AuthorizationCodeParams) error
	GetOAuth2AuthorizationCodeByHash(ctx context.Context, codeHash string) (db.Oauth2AuthorizationCode, error)
	ConsumeOAuth2AuthorizationCode(ctx context.Context, codeHash string) (db.Oauth2AuthorizationCode, error)

	CreateOAuth2AccessToken(ctx context.Context, arg db.CreateOAuth2AccessTokenParams) (db.Oauth2AccessToken, error)
	GetOAuth2AccessTokenByHash(ctx context.Context, tokenHash string) (db.Oauth2AccessToken, error)
	DeleteOAuth2AccessTokenByHash(ctx context.Context, tokenHash string) (int64, error)
	DeleteOAuth2AccessTokensByAppAndUser(ctx context.Context, arg db.DeleteOAuth2AccessTokensByAppAndUserParams) error

	CreateOAuth2RefreshToken(ctx context.Context, arg db.CreateOAuth2RefreshTokenParams) (db.Oauth2RefreshToken, error)
	GetOAuth2RefreshTokenByHash(ctx context.Context, tokenHash string) (db.Oauth2RefreshToken, error)
	ConsumeOAuth2RefreshToken(ctx context.Context, tokenHash string) (db.Oauth2RefreshToken, error)
	DeleteOAuth2RefreshTokenByHash(ctx context.Context, tokenHash string) (int64, error)
	DeleteOAuth2RefreshTokensByAppAndUser(ctx context.Context, arg db.DeleteOAuth2RefreshTokensByAppAndUserParams) error

	GetUserByID(ctx context.Context, id int64) (db.User, error)
}

// FirstPartyClientID is the public OAuth2 client_id used by Smithers's own
// gui (macOS) and iOS apps. It is registered by a seed migration and the
// constant is checked by the authorize handler to decide whether the client
// may be authorized at all: today only this first-party client is accepted,
// and browser sessions still confirm through the CSRF-bound consent page
// before a code is minted (see OAuth2Handler.GetAuthorize).
const FirstPartyClientID = "smithers_first_party_apps"

// OAuth2ApplicationResponse is the API response for an OAuth2 application.
// It deliberately omits the client_secret_hash.
type OAuth2ApplicationResponse struct {
	ID           int64     `json:"id"`
	ClientID     string    `json:"client_id"`
	Name         string    `json:"name"`
	RedirectURIs []string  `json:"redirect_uris"`
	Scopes       []string  `json:"scopes"`
	Confidential bool      `json:"confidential"`
	CreatedAt    time.Time `json:"created_at"`
	UpdatedAt    time.Time `json:"updated_at"`
}

// OAuth2TokenResponse is the standard OAuth2 token endpoint response.
type OAuth2TokenResponse struct {
	AccessToken  string `json:"access_token"`
	TokenType    string `json:"token_type"`
	ExpiresIn    int64  `json:"expires_in"`
	RefreshToken string `json:"refresh_token,omitempty"`
	Scope        string `json:"scope,omitempty"`
}

// OAuth2AuthorizeResult contains the authorization code to be returned to the client.
type OAuth2AuthorizeResult struct {
	Code        string `json:"code"`
	RedirectURI string `json:"redirect_uri"`
}

// OAuth2Service handles OAuth2 provider operations.
type OAuth2Service struct {
	queries     OAuth2Querier
	revocations revocation.Publisher
	now         func() time.Time
	// inTx runs fn in one transaction and commits only when fn returns nil.
	// Nil runs fn directly on queries (unit tests without a pool).
	inTx func(ctx context.Context, fn func(q OAuth2Querier) error) error
}

// NewOAuth2Service creates a new OAuth2Service instance.
func NewOAuth2Service(q OAuth2Querier) *OAuth2Service {
	return &OAuth2Service{
		queries: q,
		now:     func() time.Time { return time.Now().UTC() },
	}
}

// NewOAuth2ServiceWithPool returns an OAuth2Service whose one-time grant
// redemptions (authorization code, refresh token) consume the grant and write
// the new token pair in one transaction, so a failed insert never spends the
// grant.
func NewOAuth2ServiceWithPool(q OAuth2Querier, pool *pgxpool.Pool) *OAuth2Service {
	s := NewOAuth2Service(q)
	if pool == nil {
		return s
	}
	s.inTx = func(ctx context.Context, fn func(q OAuth2Querier) error) error {
		tx, err := pool.Begin(ctx)
		if err != nil {
			return pkgerrors.Internal("failed to begin token transaction").WithCause(err)
		}
		defer func() { _ = tx.Rollback(ctx) }()
		if err := fn(db.New(tx)); err != nil {
			return err
		}
		if err := tx.Commit(ctx); err != nil {
			return pkgerrors.Internal("failed to commit token transaction").WithCause(err)
		}
		return nil
	}
	return s
}

func (s *OAuth2Service) transact(ctx context.Context, fn func(q OAuth2Querier) error) error {
	if s.inTx == nil {
		return fn(s.queries)
	}
	return s.inTx(ctx, fn)
}

// GetApplicationByClientID returns the public-safe OAuth2 application for a
// given client_id. Used by the browser-native authorize handler to resolve
// the client (including its registered redirect URIs and scopes) WITHOUT
// requiring the caller to be authenticated — the authorize endpoint is
// intentionally callable by unauthenticated browsers so they can discover
// the consent/IdP page before they have a Smithers session.
func (s *OAuth2Service) GetApplicationByClientID(ctx context.Context, clientID string) (OAuth2ApplicationResponse, error) {
	app, err := s.queries.GetOAuth2ApplicationByClientID(ctx, clientID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return OAuth2ApplicationResponse{}, pkgerrors.NotFound("oauth2 application not found")
		}
		return OAuth2ApplicationResponse{}, pkgerrors.Internal("failed to get oauth2 application").WithCause(err)
	}
	return toOAuth2ApplicationResponse(app), nil
}

// IsValidRegisteredRedirectURI is a thin wrapper around isValidRedirectURI
// exposed for use by the authorize route handler (which needs to validate
// the redirect_uri BEFORE redirecting to upstream IdP, so we never bounce
// the user to an attacker-controlled URI on error per RFC 6749 §4.1.2.1).
func (s *OAuth2Service) IsValidRegisteredRedirectURI(ctx context.Context, clientID, redirectURI string) (bool, error) {
	app, err := s.queries.GetOAuth2ApplicationByClientID(ctx, clientID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return false, pkgerrors.NotFound("oauth2 application not found")
		}
		return false, pkgerrors.Internal("failed to get oauth2 application").WithCause(err)
	}
	return isValidRedirectURI(app.RedirectUris, redirectURI), nil
}

// Authorize generates an authorization code for the given OAuth2 application.
// This is called when the user approves the authorization request.
//
// callerScopes is the set of scopes granted to the caller's current auth
// credential (e.g. a PAT or first-party OAuth2 token). Pass nil to indicate
// a session-authenticated caller whose scopes are unrestricted. The effective
// scopes stored in the authorization code are:
//
//	requested_scopes ∩ app_registered_scopes ∩ caller_scopes (when non-nil)
func (s *OAuth2Service) Authorize(ctx context.Context, userID int64, clientID, redirectURI, scope, codeChallenge, codeChallengeMethod string, callerScopes []string) (OAuth2AuthorizeResult, error) {
	return s.AuthorizeGrant(ctx, OAuth2AuthorizeInput{
		UserID:              userID,
		ClientID:            clientID,
		RedirectURI:         redirectURI,
		Scope:               scope,
		CodeChallenge:       codeChallenge,
		CodeChallengeMethod: codeChallengeMethod,
		CallerScopes:        callerScopes,
	})
}

// OAuth2AuthorizeInput is the authorize request as the service sees it.
type OAuth2AuthorizeInput struct {
	UserID              int64
	ClientID            string
	RedirectURI         string
	Scope               string
	CodeChallenge       string
	CodeChallengeMethod string
	// CallerScopes is nil for a session caller (unrestricted) and a non-nil
	// slice for a token caller (the grant is bounded to those scopes).
	CallerScopes []string
	// SourceAccessTokenID is the personal access token that authorized the
	// grant, 0 for browser-session consent. The code and every token minted
	// from it record the source and die with it.
	SourceAccessTokenID int64
}

// grantSource is the personal access token a grant descends from.
type grantSource struct {
	ID        int64
	ExpiresAt pgtype.Timestamptz
}

func (g grantSource) param() pgtype.Int8 {
	if g.ID <= 0 {
		return pgtype.Int8{}
	}
	return pgtype.Int8{Int64: g.ID, Valid: true}
}

// sourceAccessTokenReader locks the original credential through grant issuance.
// A recorded source must never silently become an independent session grant.
type sourceAccessTokenReader interface {
	GetAccessTokenForOAuthGrant(context.Context, int64) (db.AccessToken, error)
}

var _ sourceAccessTokenReader = (*db.Queries)(nil)

func (s *OAuth2Service) resolveGrantSource(ctx context.Context, q OAuth2Querier, sourceID pgtype.Int8, userID int64) (grantSource, error) {
	if !sourceID.Valid {
		return grantSource{}, nil
	}
	if sourceID.Int64 <= 0 {
		return grantSource{}, pkgerrors.BadRequest("invalid grant source")
	}
	reader, ok := q.(sourceAccessTokenReader)
	if !ok {
		return grantSource{}, pkgerrors.Internal("grant source validation unavailable")
	}
	token, err := reader.GetAccessTokenForOAuthGrant(ctx, sourceID.Int64)
	if errors.Is(err, pgx.ErrNoRows) {
		return grantSource{}, pkgerrors.BadRequest("grant must be reauthorized: its source token was revoked")
	}
	if err != nil {
		return grantSource{}, pkgerrors.Internal("failed to load grant source token").WithCause(err)
	}
	if token.UserID != userID || token.SystemIssued {
		return grantSource{}, pkgerrors.Forbidden("source token cannot authorize oauth2 grants")
	}
	if token.ExpiresAt.Valid && !token.ExpiresAt.Time.After(s.now()) {
		return grantSource{}, pkgerrors.BadRequest("grant must be reauthorized: its source token expired")
	}
	return grantSource{ID: token.ID, ExpiresAt: token.ExpiresAt}, nil
}

func (s *OAuth2Service) AuthorizeGrant(ctx context.Context, in OAuth2AuthorizeInput) (OAuth2AuthorizeResult, error) {
	userID, clientID, redirectURI, scope := in.UserID, in.ClientID, in.RedirectURI, in.Scope
	codeChallenge, codeChallengeMethod, callerScopes := in.CodeChallenge, in.CodeChallengeMethod, in.CallerScopes
	if clientID != FirstPartyClientID {
		return OAuth2AuthorizeResult{}, pkgerrors.Unauthorized("invalid client_id")
	}
	app, err := s.queries.GetOAuth2ApplicationByClientID(ctx, clientID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return OAuth2AuthorizeResult{}, pkgerrors.NotFound("oauth2 application not found")
		}
		return OAuth2AuthorizeResult{}, pkgerrors.Internal("failed to get oauth2 application").WithCause(err)
	}

	// Validate redirect_uri is registered.
	if !isValidRedirectURI(app.RedirectUris, redirectURI) {
		return OAuth2AuthorizeResult{}, pkgerrors.BadRequest("invalid redirect_uri")
	}

	// Build the set of scopes allowed for this app registration.
	normalizedAppScopes := make(map[string]struct{}, len(app.Scopes))
	for _, registeredScope := range app.Scopes {
		normalizedScope := middleware.NormalizeTokenScope(registeredScope)
		if normalizedScope == "" {
			continue
		}
		normalizedAppScopes[string(normalizedScope)] = struct{}{}
	}

	// Build the set of scopes allowed for the calling credential, if
	// restricted. A nil callerScopes means the caller has a session (no token
	// scope bound) and is treated as unrestricted.
	var normalizedCallerScopes map[string]struct{}
	if callerScopes != nil {
		normalizedCallerScopes = make(map[string]struct{}, len(callerScopes))
		for _, cs := range callerScopes {
			ns := middleware.NormalizeTokenScope(cs)
			if ns == "" {
				continue
			}
			normalizedCallerScopes[string(ns)] = struct{}{}
		}
	}

	// Parse requested scopes.
	requestedScopes := parseScopeString(scope)
	if len(requestedScopes) == 0 {
		requestedScopes = app.Scopes
	}
	normalizedRequestedScopes := make([]string, 0, len(requestedScopes))
	seenRequestedScopes := make(map[string]struct{}, len(requestedScopes))
	for _, requestedScope := range requestedScopes {
		normalizedScope := middleware.NormalizeTokenScope(requestedScope)
		if normalizedScope == "" {
			return OAuth2AuthorizeResult{}, pkgerrors.BadRequest("requested scope exceeds application registered scopes")
		}
		canonicalScope := string(normalizedScope)
		// Bound to app's registered scopes.
		if _, ok := normalizedAppScopes[canonicalScope]; !ok {
			return OAuth2AuthorizeResult{}, pkgerrors.BadRequest("requested scope exceeds application registered scopes")
		}
		// Bound to caller's token scopes (when the caller is token-authenticated).
		if normalizedCallerScopes != nil {
			if _, ok := normalizedCallerScopes[canonicalScope]; !ok {
				return OAuth2AuthorizeResult{}, pkgerrors.BadRequest("requested scope exceeds caller's granted scopes")
			}
		}
		if _, seen := seenRequestedScopes[canonicalScope]; seen {
			continue
		}
		seenRequestedScopes[canonicalScope] = struct{}{}
		normalizedRequestedScopes = append(normalizedRequestedScopes, canonicalScope)
	}
	requestedScopes = normalizedRequestedScopes

	// Validate PKCE parameters.
	codeChallenge = strings.TrimSpace(codeChallenge)
	codeChallengeMethod = strings.TrimSpace(codeChallengeMethod)
	if codeChallengeMethod != "" && codeChallenge == "" {
		return OAuth2AuthorizeResult{}, pkgerrors.BadRequest("code_challenge is required when code_challenge_method is set")
	}
	if codeChallenge != "" && codeChallengeMethod != "S256" {
		return OAuth2AuthorizeResult{}, pkgerrors.BadRequest("code_challenge_method must be S256")
	}
	if !app.Confidential && codeChallenge == "" {
		return OAuth2AuthorizeResult{}, pkgerrors.BadRequest("code_challenge is required for public clients")
	}

	// Generate authorization code.
	code := generateOAuth2Code()
	codeHash := hashOAuth2Secret(code)

	err = s.transact(ctx, func(q OAuth2Querier) error {
		source, err := s.resolveGrantSource(ctx, q, grantSource{ID: in.SourceAccessTokenID}.param(), userID)
		if err != nil {
			return err
		}
		expiresAt := s.now().Add(oauth2AuthCodeTTL)
		if source.ExpiresAt.Valid && source.ExpiresAt.Time.Before(expiresAt) {
			expiresAt = source.ExpiresAt.Time
		}
		err = q.CreateOAuth2AuthorizationCode(ctx, db.CreateOAuth2AuthorizationCodeParams{
			CodeHash:            codeHash,
			AppID:               app.ID,
			UserID:              userID,
			Scopes:              requestedScopes,
			RedirectUri:         redirectURI,
			CodeChallenge:       codeChallenge,
			CodeChallengeMethod: codeChallengeMethod,
			ExpiresAt:           expiresAt,
			SourceAccessTokenID: source.param(),
		})
		if err != nil {
			return pkgerrors.Internal("failed to create authorization code").WithCause(err)
		}
		return nil
	})
	if err != nil {
		return OAuth2AuthorizeResult{}, err
	}

	return OAuth2AuthorizeResult{
		Code:        code,
		RedirectURI: redirectURI,
	}, nil
}

// ExchangeCode exchanges an authorization code for an access token and refresh token.
func (s *OAuth2Service) ExchangeCode(ctx context.Context, clientID, clientSecret, code, redirectURI, codeVerifier string) (OAuth2TokenResponse, error) {
	if clientID != FirstPartyClientID {
		return OAuth2TokenResponse{}, pkgerrors.Unauthorized("invalid client_id")
	}
	// Validate client credentials.
	app, err := s.queries.GetOAuth2ApplicationByClientID(ctx, clientID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return OAuth2TokenResponse{}, pkgerrors.Unauthorized("invalid client_id")
		}
		return OAuth2TokenResponse{}, pkgerrors.Internal("failed to get oauth2 application").WithCause(err)
	}

	// Verify client secret for confidential clients.
	if app.Confidential {
		expectedHash := hashOAuth2Secret(clientSecret)
		if subtle.ConstantTimeCompare([]byte(expectedHash), []byte(app.ClientSecretHash)) != 1 {
			return OAuth2TokenResponse{}, pkgerrors.Unauthorized("invalid client_secret")
		}
	}

	// Load the authorization code WITHOUT consuming it. Validation must run
	// before the one-time code is marked used: otherwise an attacker who
	// observed the code (but not the PKCE verifier or client secret) could
	// burn it with a failed redemption attempt, denying the legitimate
	// client its exchange.
	codeHash := hashOAuth2Secret(code)
	authCode, err := s.queries.GetOAuth2AuthorizationCodeByHash(ctx, codeHash)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return OAuth2TokenResponse{}, pkgerrors.BadRequest("invalid or expired authorization code")
		}
		return OAuth2TokenResponse{}, pkgerrors.Internal("failed to validate authorization code").WithCause(err)
	}

	// Validate the code belongs to this application.
	if authCode.AppID != app.ID {
		return OAuth2TokenResponse{}, pkgerrors.BadRequest("authorization code does not belong to this application")
	}

	// Validate redirect_uri matches.
	if authCode.RedirectUri != redirectURI {
		return OAuth2TokenResponse{}, pkgerrors.BadRequest("redirect_uri mismatch")
	}

	if !app.Confidential {
		if authCode.CodeChallenge == "" || authCode.CodeChallengeMethod != "S256" {
			return OAuth2TokenResponse{}, pkgerrors.BadRequest("public clients require PKCE")
		}
	}

	// Validate PKCE code verifier if challenge was set.
	if authCode.CodeChallenge != "" {
		if authCode.CodeChallengeMethod != "S256" {
			return OAuth2TokenResponse{}, pkgerrors.BadRequest("code_challenge_method must be S256")
		}
		if codeVerifier == "" {
			return OAuth2TokenResponse{}, pkgerrors.BadRequest("code_verifier is required")
		}
		if !verifyPKCE(authCode.CodeChallenge, authCode.CodeChallengeMethod, codeVerifier) {
			return OAuth2TokenResponse{}, pkgerrors.BadRequest("invalid code_verifier")
		}
	}

	// Consume the code only after every check passed. The consume query's
	// used_at IS NULL guard keeps single-use atomic: if two fully-valid
	// redemptions race, exactly one wins and the other gets ErrNoRows.
	var resp OAuth2TokenResponse
	err = s.transact(ctx, func(q OAuth2Querier) error {
		// Lock the source before its child grant, matching cascade-delete lock order.
		source, err := s.resolveGrantSource(ctx, q, authCode.SourceAccessTokenID, authCode.UserID)
		if err != nil {
			return err
		}
		consumed, err := q.ConsumeOAuth2AuthorizationCode(ctx, codeHash)
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return pkgerrors.BadRequest("invalid or expired authorization code")
			}
			return pkgerrors.Internal("failed to consume authorization code").WithCause(err)
		}
		resp, err = s.issueTokenPair(ctx, q, app.ID, consumed.UserID, consumed.Scopes, source)
		return err
	})
	if err != nil {
		return OAuth2TokenResponse{}, err
	}
	return resp, nil
}

// RefreshToken exchanges a refresh token for a new access token and refresh token pair.
func (s *OAuth2Service) RefreshToken(ctx context.Context, clientID, clientSecret, refreshToken string) (OAuth2TokenResponse, error) {
	if clientID != FirstPartyClientID {
		return OAuth2TokenResponse{}, pkgerrors.Unauthorized("invalid client_id")
	}
	// Validate client credentials.
	app, err := s.queries.GetOAuth2ApplicationByClientID(ctx, clientID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return OAuth2TokenResponse{}, pkgerrors.Unauthorized("invalid client_id")
		}
		return OAuth2TokenResponse{}, pkgerrors.Internal("failed to get oauth2 application").WithCause(err)
	}

	// Verify client secret for confidential clients.
	if app.Confidential {
		expectedHash := hashOAuth2Secret(clientSecret)
		if subtle.ConstantTimeCompare([]byte(expectedHash), []byte(app.ClientSecretHash)) != 1 {
			return OAuth2TokenResponse{}, pkgerrors.Unauthorized("invalid client_secret")
		}
	}

	tokenHash := hashOAuth2Secret(refreshToken)
	// Validate ownership before consuming so one OAuth application cannot burn
	// another application's refresh token by presenting it with the wrong client_id.
	token, err := s.queries.GetOAuth2RefreshTokenByHash(ctx, tokenHash)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return OAuth2TokenResponse{}, pkgerrors.BadRequest("invalid or expired refresh token")
		}
		return OAuth2TokenResponse{}, pkgerrors.Internal("failed to validate refresh token").WithCause(err)
	}
	if token.AppID != app.ID {
		return OAuth2TokenResponse{}, pkgerrors.BadRequest("refresh token does not belong to this application")
	}

	// Consume the refresh token atomically so concurrent refresh attempts
	// cannot replay it, and in the same transaction as the new pair so a
	// failed insert leaves the old token usable.
	var resp OAuth2TokenResponse
	err = s.transact(ctx, func(q OAuth2Querier) error {
		// Lock the source before its child grant, matching cascade-delete lock order.
		source, err := s.resolveGrantSource(ctx, q, token.SourceAccessTokenID, token.UserID)
		if err != nil {
			return err
		}
		oldToken, err := q.ConsumeOAuth2RefreshToken(ctx, tokenHash)
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return pkgerrors.BadRequest("invalid or expired refresh token")
			}
			return pkgerrors.Internal("failed to validate refresh token").WithCause(err)
		}
		if oldToken.Scopes == nil {
			return pkgerrors.BadRequest("refresh token must be reauthorized")
		}

		// Intersect the token's stored scopes with the app's current
		// registered scopes. If an app's scope registration was narrowed
		// after the original grant, rotation cannot re-issue scopes that are
		// no longer allowed. The new token may be same-or-narrower, never
		// broader.
		effectiveScopes := scopeIntersection(oldToken.Scopes, app.Scopes)
		resp, err = s.issueTokenPair(ctx, q, app.ID, oldToken.UserID, effectiveScopes, source)
		return err
	})
	if err != nil {
		return OAuth2TokenResponse{}, err
	}
	return resp, nil
}

// RevokeToken revokes an access token or refresh token.
//
// The caller MUST identify itself as an OAuth2 client and ownership is
// always enforced: the token must have been issued to that client (RFC 7009
// §2.1 — "the authorization server first validates the client credentials
// ... and then verifies whether the token was issued to the client making
// the revocation request"). A token value alone is never sufficient to
// revoke it; that would let anyone who observed a token log the user out of
// the integration without authenticating as the issuing client.
//
// For confidential clients, clientSecret MUST match the registered secret.
// For public clients (confidential=false), clientSecret is ignored and
// ownership is enforced by matching client_id against the token's app_id
// only. This is a known trade-off documented in the PR: a stolen public-
// client access token could be revoked by any attacker who knows the well-
// known public client_id, but revoke is not a privileged action (it only
// destroys access), so the attack surface is limited to denial-of-service.
//
// Per RFC 7009 §2.2, revocation of an unknown token is NOT an error: the
// response is still 200. We preserve that behavior for both the "token
// not found" and "token not owned by this client" cases so an attacker
// cannot probe token-to-client mappings by observing error codes.
func (s *OAuth2Service) RevokeToken(ctx context.Context, clientID, clientSecret, token string) error {
	tokenHash := hashOAuth2Secret(token)

	// Resolve and authenticate the requesting client (RFC 7009 §2.1).
	if strings.TrimSpace(clientID) == "" {
		return pkgerrors.Unauthorized("client_id is required")
	}
	requestingApp, err := s.queries.GetOAuth2ApplicationByClientID(ctx, clientID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return pkgerrors.Unauthorized("invalid client_id")
		}
		return pkgerrors.Internal("failed to revoke token").WithCause(err)
	}
	if requestingApp.Confidential {
		expectedHash := hashOAuth2Secret(clientSecret)
		if subtle.ConstantTimeCompare([]byte(expectedHash), []byte(requestingApp.ClientSecretHash)) != 1 {
			return pkgerrors.Unauthorized("invalid client_secret")
		}
	}

	// Try access token first. Load-then-delete so we can enforce ownership.
	accessToken, err := s.queries.GetOAuth2AccessTokenByHash(ctx, tokenHash)
	if err == nil {
		// Ownership check: the token must have been issued to the requesting
		// client. Silently succeed on mismatch (RFC 7009 §2.2 — avoid
		// probing).
		if accessToken.AppID != requestingApp.ID {
			return nil
		}
		if _, delErr := s.queries.DeleteOAuth2AccessTokenByHash(ctx, tokenHash); delErr != nil {
			return pkgerrors.Internal("failed to revoke token").WithCause(delErr)
		}
		revocation.PublishBestEffort(ctx, s.revocations, revocation.Event{
			Kind:      revocation.KindTokenRevoked,
			UserID:    accessToken.UserID,
			TokenID:   accessToken.ID,
			TokenHash: tokenHash,
			Reason:    "oauth2 access token revoked",
		})
		return nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return pkgerrors.Internal("failed to revoke token")
	}

	// Try refresh token.
	refreshToken, err := s.queries.GetOAuth2RefreshTokenByHash(ctx, tokenHash)
	if err == nil {
		if refreshToken.AppID != requestingApp.ID {
			return nil
		}
		if _, delErr := s.queries.DeleteOAuth2RefreshTokenByHash(ctx, tokenHash); delErr != nil {
			return pkgerrors.Internal("failed to revoke token").WithCause(delErr)
		}
		return nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return pkgerrors.Internal("failed to revoke token")
	}

	// Per RFC 7009 §2.2, revocation of an invalid token is not an error.
	return nil
}

// RevokeAllByAppAndUser deletes every access token and refresh token issued
// to the given OAuth2 application for the given user.
func (s *OAuth2Service) RevokeAllByAppAndUser(ctx context.Context, appID, userID int64) error {
	if err := s.queries.DeleteOAuth2RefreshTokensByAppAndUser(ctx, db.DeleteOAuth2RefreshTokensByAppAndUserParams{
		AppID:  appID,
		UserID: userID,
	}); err != nil {
		return pkgerrors.Internal("failed to revoke tokens").WithCause(err)
	}

	if err := s.queries.DeleteOAuth2AccessTokensByAppAndUser(ctx, db.DeleteOAuth2AccessTokensByAppAndUserParams{
		AppID:  appID,
		UserID: userID,
	}); err != nil {
		return pkgerrors.Internal("failed to revoke tokens").WithCause(err)
	}

	return nil
}

// issueTokenPair creates a new access token and refresh token pair.
func (s *OAuth2Service) issueTokenPair(ctx context.Context, q OAuth2Querier, appID, userID int64, scopes []string, source grantSource) (OAuth2TokenResponse, error) {
	now := s.now()
	accessExpiry, refreshExpiry := now.Add(oauth2AccessTokenTTL), now.Add(oauth2RefreshTokenTTL)
	if source.ExpiresAt.Valid {
		if source.ExpiresAt.Time.Before(accessExpiry) {
			accessExpiry = source.ExpiresAt.Time
		}
		if source.ExpiresAt.Time.Before(refreshExpiry) {
			refreshExpiry = source.ExpiresAt.Time
		}
	}
	if scopes == nil {
		scopes = []string{}
	}

	// Generate access token.
	accessTokenValue := generateOAuth2Token()
	accessToken := "smithers_oat_" + accessTokenValue
	accessTokenHash := hashOAuth2Secret(accessToken)

	_, err := q.CreateOAuth2AccessToken(ctx, db.CreateOAuth2AccessTokenParams{
		TokenHash:           accessTokenHash,
		AppID:               appID,
		UserID:              userID,
		Scopes:              scopes,
		ExpiresAt:           accessExpiry,
		SourceAccessTokenID: source.param(),
	})
	if err != nil {
		return OAuth2TokenResponse{}, pkgerrors.Internal("failed to create access token").WithCause(err)
	}

	// Generate refresh token.
	refreshTokenValue := generateOAuth2Token()
	newRefreshToken := "smithers_ort_" + refreshTokenValue
	refreshTokenHash := hashOAuth2Secret(newRefreshToken)

	_, err = q.CreateOAuth2RefreshToken(ctx, db.CreateOAuth2RefreshTokenParams{
		TokenHash:           refreshTokenHash,
		AppID:               appID,
		UserID:              userID,
		Scopes:              scopes,
		ExpiresAt:           refreshExpiry,
		SourceAccessTokenID: source.param(),
	})
	if err != nil {
		return OAuth2TokenResponse{}, pkgerrors.Internal("failed to create refresh token").WithCause(err)
	}

	return OAuth2TokenResponse{
		AccessToken:  accessToken,
		TokenType:    "bearer",
		ExpiresIn:    int64(accessExpiry.Sub(now).Seconds()),
		RefreshToken: newRefreshToken,
		Scope:        strings.Join(scopes, " "),
	}, nil
}

// toOAuth2ApplicationResponse converts a db model to an API response (omitting secret hash).
func toOAuth2ApplicationResponse(app db.Oauth2Application) OAuth2ApplicationResponse {
	redirectURIs := app.RedirectUris
	if redirectURIs == nil {
		redirectURIs = []string{}
	}
	scopes := app.Scopes
	if scopes == nil {
		scopes = []string{}
	}
	return OAuth2ApplicationResponse{
		ID:           app.ID,
		ClientID:     app.ClientID,
		Name:         app.Name,
		RedirectURIs: redirectURIs,
		Scopes:       scopes,
		Confidential: app.Confidential,
		CreatedAt:    app.CreatedAt,
		UpdatedAt:    app.UpdatedAt,
	}
}

// isValidRedirectURI checks if the given URI is in the list of registered redirect URIs.
//
// Native-app loopback redirects (RFC 8252 §7.3) are matched with port-agnostic
// comparison: a registered entry of "http://127.0.0.1/callback" or
// "http://[::1]/callback" matches any port on the same host+path. This is
// required because native apps pick a random ephemeral port at runtime.
// For all other schemes (https, custom URL schemes like smithers://) we do
// exact-string comparison — no substring / prefix matching.
func isValidRedirectURI(registered []string, uri string) bool {
	for _, r := range registered {
		if r == uri {
			return true
		}
		if isLoopbackMatch(r, uri) {
			return true
		}
	}
	return false
}

// isLoopbackMatch implements RFC 8252 §7.3 loopback port-agnostic matching.
// Only valid for http://127.0.0.1 and http://[::1] — never for https or
// non-loopback hosts, and never for custom URL schemes.
func isLoopbackMatch(registered, presented string) bool {
	reg, err := url.Parse(registered)
	if err != nil {
		return false
	}
	pres, err := url.Parse(presented)
	if err != nil {
		return false
	}
	if reg.Scheme != "http" || pres.Scheme != "http" {
		return false
	}
	regHost := reg.Hostname()
	presHost := pres.Hostname()
	if regHost != presHost {
		return false
	}
	if regHost != "127.0.0.1" && regHost != "::1" {
		return false
	}
	if reg.Path != pres.Path {
		return false
	}
	if reg.RawQuery != pres.RawQuery {
		return false
	}
	return true
}

// scopeIntersection returns the canonical scopes that appear in both granted
// and allowed, after normalizing each entry. Scopes in granted that are not
// in allowed are silently dropped (never cause an error — the caller is still
// valid, just operating with a narrower effective set).
func scopeIntersection(granted, allowed []string) []string {
	normalizedAllowed := make(map[string]struct{}, len(allowed))
	for _, s := range allowed {
		ns := middleware.NormalizeTokenScope(s)
		if ns == "" {
			continue
		}
		normalizedAllowed[string(ns)] = struct{}{}
	}

	result := make([]string, 0, len(granted))
	seen := make(map[string]struct{}, len(granted))
	for _, s := range granted {
		ns := middleware.NormalizeTokenScope(s)
		if ns == "" {
			continue
		}
		canonical := string(ns)
		if _, ok := normalizedAllowed[canonical]; !ok {
			continue
		}
		if _, alreadySeen := seen[canonical]; alreadySeen {
			continue
		}
		seen[canonical] = struct{}{}
		result = append(result, canonical)
	}
	return result
}

// parseScopeString splits a space-separated scope string into a slice.
func parseScopeString(scope string) []string {
	trimmed := strings.TrimSpace(scope)
	if trimmed == "" {
		return nil
	}
	parts := strings.Fields(trimmed)
	result := make([]string, 0, len(parts))
	for _, p := range parts {
		if s := strings.TrimSpace(p); s != "" {
			result = append(result, s)
		}
	}
	return result
}

// verifyPKCE validates a PKCE code_verifier against the stored code_challenge.
func verifyPKCE(challenge, method, verifier string) bool {
	if method != "S256" {
		return false
	}

	hash := sha256.Sum256([]byte(verifier))
	computed := base64.RawURLEncoding.EncodeToString(hash[:])
	return subtle.ConstantTimeCompare([]byte(computed), []byte(challenge)) == 1
}

// generateOAuth2Code generates an authorization code.
func generateOAuth2Code() string {
	return randomHex(32)
}

// generateOAuth2Token generates a token value.
func generateOAuth2Token() string {
	return randomHex(32)
}

// hashOAuth2Secret hashes a secret using SHA-256.
func hashOAuth2Secret(secret string) string {
	hash := sha256.Sum256([]byte(secret))
	return hex.EncodeToString(hash[:])
}
