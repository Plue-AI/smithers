package services

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	stdErrors "errors"
	"fmt"
	"log/slog"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	smitherscrypto "github.com/smithersai/smithers/packages/backend/internal/pkg/crypto"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/revocation"
)

type VerifyKeyAuthResult struct {
	User       db.User   `json:"user"`
	SessionKey string    `json:"session_key"`
	ExpiresAt  time.Time `json:"expires_at"`
}

type OAuthCallbackResult struct {
	AdminCLI    *AdminCLIRequest `json:"-"`
	User        db.User          `json:"user"`
	SessionKey  string           `json:"session_key"`
	ExpiresAt   time.Time        `json:"expires_at"`
	RedirectURL string           `json:"redirect_url"`
	TokenScopes []string         `json:"-"`
}

type TokenSummary struct {
	ID             int64      `json:"id"`
	Name           string     `json:"name"`
	TokenLastEight string     `json:"token_last_eight"`
	Scopes         []string   `json:"scopes"`
	ExpiresAt      *time.Time `json:"expires_at,omitempty"`
}

type CreateTokenRequest struct {
	Name      string     `json:"name"`
	Scopes    []string   `json:"scopes"`
	ExpiresAt *time.Time `json:"expires_at,omitempty"`
}

type CreateTokenResult struct {
	TokenSummary
	Token string `json:"token"`
}

type GitHubTokenResult struct {
	AccessToken string `json:"access_token"`
	// RefreshToken is the GitHub App user-to-server refresh token. It is present
	// when the App has "Expire user authorization tokens" enabled; it is used to
	// mint a fresh access token after the ~8h access token expires.
	RefreshToken string `json:"refresh_token"`
	// ExpiresIn / RefreshTokenExpiresIn are the lifetimes (seconds) GitHub
	// reports for the access token and refresh token respectively; zero when the
	// App does not expire tokens.
	ExpiresIn             int64 `json:"expires_in"`
	RefreshTokenExpiresIn int64 `json:"refresh_token_expires_in"`
}

type GitHubUserProfile struct {
	ID        int64  `json:"id"`
	Login     string `json:"login"`
	Name      string `json:"name"`
	AvatarURL string `json:"avatar_url"`
}

type GitHubEmail struct {
	Email    string `json:"email"`
	Primary  bool   `json:"primary"`
	Verified bool   `json:"verified"`
}

type KeyAuthVerifier interface {
	Verify(message, signature, expectedDomain string) (walletAddress string, nonce string, err error)
}

type GitHubClient interface {
	ExchangeCode(ctx context.Context, code string) (GitHubTokenResult, error)
	FetchUser(ctx context.Context, accessToken string) (GitHubUserProfile, error)
	FetchEmails(ctx context.Context, accessToken string) ([]GitHubEmail, error)
}

type GitHubAuthClient interface {
	GitHubClient
	AuthorizationURL(state string) string
}

// Auth0Client extends GitHubClient with the ability to build an authorization URL.
type Auth0Client interface {
	GitHubAuthClient
}

type AuthQuerier interface {
	CreateOAuthState(ctx context.Context, arg db.CreateOAuthStateParams) (db.OauthState, error)
	ConsumeOAuthState(ctx context.Context, arg db.ConsumeOAuthStateParams) (int64, error)
	ConsumeOAuthStateWithScopes(ctx context.Context, arg db.ConsumeOAuthStateWithScopesParams) ([]string, error)
	CreateAuthNonce(ctx context.Context, arg db.CreateAuthNonceParams) (db.AuthNonce, error)
	ConsumeAuthNonce(ctx context.Context, arg db.ConsumeAuthNonceParams) (int64, error)
	GetUserByWalletAddress(ctx context.Context, walletAddress pgtype.Text) (db.User, error)
	CreateUserWithWallet(ctx context.Context, arg db.CreateUserWithWalletParams) (db.User, error)
	CreateAuthSession(ctx context.Context, arg db.CreateAuthSessionParams) (db.AuthSession, error)
	GetOAuthAccountByProviderUserID(ctx context.Context, arg db.GetOAuthAccountByProviderUserIDParams) (db.OauthAccount, error)
	GetUserByID(ctx context.Context, id int64) (db.User, error)
	CreateUser(ctx context.Context, arg db.CreateUserParams) (db.User, error)
	UpsertOAuthAccount(ctx context.Context, arg db.UpsertOAuthAccountParams) (db.OauthAccount, error)
	UpsertEmailAddress(ctx context.Context, arg db.UpsertEmailAddressParams) (db.UpsertEmailAddressRow, error)
	DeleteAuthSession(ctx context.Context, sessionKey string) error
	ListUserSessions(ctx context.Context, userID int64) ([]db.AuthSession, error)
	ListAccessTokensByUserID(ctx context.Context, userID int64) ([]db.AccessToken, error)
	CreateAccessToken(ctx context.Context, arg db.CreateAccessTokenParams) (db.AccessToken, error)
	DeleteAccessTokenByIDAndUserID(ctx context.Context, arg db.DeleteAccessTokenByIDAndUserIDParams) (int64, error)
}

type oauthAccountPreserveRefreshQuerier interface {
	UpsertOAuthAccountPreserveRefresh(ctx context.Context, arg db.UpsertOAuthAccountPreserveRefreshParams) (db.OauthAccount, error)
}

type oauthAccountTokenCASQuerier interface {
	RotateOAuthAccountTokensCAS(ctx context.Context, arg db.RotateOAuthAccountTokensCASParams) (int64, error)
	ClearOAuthAccountRefreshTokenCAS(ctx context.Context, arg db.ClearOAuthAccountRefreshTokenCASParams) (int64, error)
}

// oauthAccountTokenHealQuerier is feature-detected (not folded into
// oauthAccountTokenCASQuerier) so existing fakes that predate the heal path keep
// compiling and simply opt out of healing.
type oauthAccountTokenHealQuerier interface {
	RotateOAuthAccountTokensByAccessCAS(ctx context.Context, arg db.RotateOAuthAccountTokensByAccessCASParams) (int64, error)
}

type AuthService struct {
	metrics         AuthMetricsObserver
	revocations     revocation.Publisher
	queries         AuthQuerier
	cfg             config.AuthConfig
	keyAuthVerifier KeyAuthVerifier
	githubClient    GitHubClient
	auth0Client     Auth0Client
	now             func() time.Time
	generateNonce   func() string
	generateSession func() string
	generateState   func() string
	// githubRefreshLocks serializes GitHub token refreshes PER USER. GitHub App
	// refresh tokens are single-use (rotated on each exchange), so two concurrent
	// 401s must not both spend the stored refresh token. Entries are refcounted
	// and evicted on release, so the map tracks concurrently-refreshing users
	// instead of growing with every user that ever refreshed. Zero-value usable,
	// no constructor wiring needed.
	githubRefreshLocks userLockRegistry
	// githubRefreshLocker extends that serialization across replicas. Optional;
	// see WithAuthGitHubRefreshLocker.
	githubRefreshLocker GitHubRefreshLocker
}

// userLockRegistry hands out per-key mutexes that are dropped from the map as
// soon as the last holder releases them (refcounted eviction).
type userLockRegistry struct {
	mu    sync.Mutex
	locks map[int64]*refCountedLock
}

type refCountedLock struct {
	mu   sync.Mutex
	refs int
}

// acquire blocks until the per-key lock is held. Every acquire must be paired
// with exactly one release for the same key.
func (r *userLockRegistry) acquire(key int64) {
	r.mu.Lock()
	if r.locks == nil {
		r.locks = make(map[int64]*refCountedLock)
	}
	lock := r.locks[key]
	if lock == nil {
		lock = &refCountedLock{}
		r.locks[key] = lock
	}
	lock.refs++
	r.mu.Unlock()

	lock.mu.Lock()
}

// release unlocks the per-key lock and evicts the map entry once no goroutine
// holds or awaits it.
func (r *userLockRegistry) release(key int64) {
	r.mu.Lock()
	lock := r.locks[key]
	lock.refs--
	if lock.refs == 0 {
		delete(r.locks, key)
	}
	r.mu.Unlock()

	lock.mu.Unlock()
}

var (
	authRandRead    = rand.Read
	authJSONMarshal = json.Marshal
	authEncrypt     = smitherscrypto.Encrypt
)

// ErrGitHubRefreshTokenInvalid is returned by a GitHubClient's RefreshToken when
// GitHub definitively rejects the refresh token itself (e.g. `bad_refresh_token`
// — the grant was revoked or the refresh token already consumed). The caller
// clears the stored refresh token so it stops retrying a dead credential.
var ErrGitHubRefreshTokenInvalid = stdErrors.New("github refresh token is invalid")

// ErrGitHubTokenRejected is wrapped by a GitHubClient's FetchUser and
// FetchEmails when GitHub answers 401 or 403: the caller's access token is
// expired, revoked, or lacks scope. resolveOAuthUser maps it to 401 so a bad
// client credential is not reported as a server bug.
var ErrGitHubTokenRejected = stdErrors.New("github access token was rejected")

const (
	defaultAuth0RedirectURL = "http://localhost:4000/api/auth/auth0/callback"
	defaultAuth0Connection  = "github"
	defaultAccessTokenTTL   = 90 * 24 * time.Hour
	// multiWorkerTokenNamePrefix marks per-session worker PATs minted via the
	// GitHub token exchange (multi's worker names them "multi-worker" or
	// "multi-worker-<session>"). These always self-expire.
	multiWorkerTokenNamePrefix = "multi-worker"
	// maxExchangeTokenTTL caps (and, for multi-worker tokens, defaults)
	// the lifetime of exchange-minted PATs.
	maxExchangeTokenTTL = 8 * 24 * time.Hour
	// githubTokenRefreshSkew is how long BEFORE the recorded expiry a stored
	// GitHub access token is treated as already dead, so we refresh proactively
	// instead of spending a doomed API call to learn it expired. Five minutes
	// covers clock drift plus a slow in-flight request.
	githubTokenRefreshSkew = 5 * time.Minute
)

type AuthMetricsObserver interface{ ObserveAuthOperation(method, result string) }

type AuthServiceOption func(*AuthService)

func WithAuthMetrics(metrics AuthMetricsObserver) AuthServiceOption {
	return func(s *AuthService) { s.metrics = metrics }
}

func (s *AuthService) observeLogin(method string, err error) {
	if s.metrics == nil {
		return
	}
	result := "success"
	if err != nil {
		result = "failure"
		var apiErr *pkgerrors.APIError
		if stdErrors.As(err, &apiErr) && apiErr.Status == 403 {
			result = "denied"
		}
	}
	s.metrics.ObserveAuthOperation(method, result)
}

// WithAuthGitHubRefreshLocker installs the CROSS-REPLICA serializer for GitHub
// token refreshes. The in-process githubRefreshLocks only serializes goroutines
// inside ONE pod; with several API replicas, concurrent 401s on different pods
// would each spend the same single-use refresh token. Optional: when nil the
// service keeps the in-process lock plus the CAS/heal recovery below, which
// still converges on the correct row — it just wastes a doomed GitHub call.
func WithAuthGitHubRefreshLocker(locker GitHubRefreshLocker) AuthServiceOption {
	return func(s *AuthService) { s.githubRefreshLocker = locker }
}

// GitHubRefreshLocker serializes a per-account critical section across every API
// replica. providerUserID (not the numeric user id) is the key because it is what
// the oauth_accounts CAS statements match on.
type GitHubRefreshLocker interface {
	WithUserRefreshLock(ctx context.Context, provider, providerUserID string, fn func(context.Context) error) error
}

func NewAuthService(q AuthQuerier, cfg config.AuthConfig, keyAuthVerifier KeyAuthVerifier, githubClient GitHubClient, opts ...AuthServiceOption) *AuthService {
	s := &AuthService{
		queries:         q,
		cfg:             cfg,
		keyAuthVerifier: keyAuthVerifier,
		githubClient:    githubClient,
		now:             func() time.Time { return time.Now().UTC() },
		generateNonce:   func() string { return randomHex(16) },
		generateSession: func() string {
			return randomUUID()
		},
		generateState: func() string { return randomHex(16) },
	}
	for _, opt := range opts {
		if opt != nil {
			opt(s)
		}
	}
	return s
}

// SetAuth0Client sets the Auth0 client for Auth0 OAuth flows.
// This is called during server startup when Auth0 credentials are configured.
func (s *AuthService) SetAuth0Client(client Auth0Client) {
	s.auth0Client = client
}

func (s *AuthService) CreateKeyAuthNonce(ctx context.Context) (string, error) {
	nonce := s.generateNonce()
	_, err := s.queries.CreateAuthNonce(ctx, db.CreateAuthNonceParams{
		Nonce:     nonce,
		ExpiresAt: s.now().Add(10 * time.Minute),
	})
	if err != nil {
		return "", pkgerrors.Internal("failed to create auth nonce").WithCause(err)
	}
	return nonce, nil
}

func (s *AuthService) VerifyKeyAuth(ctx context.Context, message, signature string) (result VerifyKeyAuthResult, retErr error) {
	defer func() { s.observeLogin("key", retErr) }()
	if config.IsSingleOwner(s.cfg) {
		return VerifyKeyAuthResult{}, pkgerrors.NotFound("key authentication is not available in single-owner mode")
	}
	if s.keyAuthVerifier == nil {
		return VerifyKeyAuthResult{}, pkgerrors.Internal("key auth verifier is not configured")
	}

	expectedDomain := s.keyAuthExpectedDomain()
	if expectedDomain == "" {
		return VerifyKeyAuthResult{}, pkgerrors.Internal("key auth domain is not configured")
	}

	walletAddress, nonce, err := s.keyAuthVerifier.Verify(message, signature, expectedDomain)
	if err != nil {
		return VerifyKeyAuthResult{}, pkgerrors.Unauthorized("invalid signature")
	}

	rows, err := s.queries.ConsumeAuthNonce(ctx, db.ConsumeAuthNonceParams{
		Nonce:         nonce,
		WalletAddress: pgtype.Text{String: walletAddress, Valid: walletAddress != ""},
	})
	if err != nil {
		return VerifyKeyAuthResult{}, pkgerrors.Internal("failed to consume auth nonce").WithCause(err)
	}
	if rows == 0 {
		return VerifyKeyAuthResult{}, pkgerrors.Unauthorized("invalid or expired nonce")
	}

	walletText := pgtype.Text{String: walletAddress, Valid: walletAddress != ""}
	user, err := s.queries.GetUserByWalletAddress(ctx, walletText)
	if err != nil {
		if !stdErrors.Is(err, pgx.ErrNoRows) {
			return VerifyKeyAuthResult{}, pkgerrors.Internal("failed to find wallet user")
		}

		candidates := walletUsernameCandidates(walletAddress)
		for i, username := range candidates {
			user, err = s.queries.CreateUserWithWallet(ctx, db.CreateUserWithWalletParams{
				Username:      username,
				LowerUsername: strings.ToLower(username),
				DisplayName:   username,
				WalletAddress: walletText,
			})
			if err == nil {
				break
			}
			// A username collision means a DIFFERENT wallet already claimed
			// this derived name (addresses can share a suffix); retry with the
			// next higher-entropy candidate instead of blocking signup.
			if isUsernameUniqueViolation(err) && i < len(candidates)-1 {
				continue
			}
			if isUniqueViolation(err) {
				if isUsernameUniqueViolation(err) {
					return VerifyKeyAuthResult{}, pkgerrors.Conflict("wallet-derived username is already in use")
				}
				return VerifyKeyAuthResult{}, pkgerrors.Conflict("wallet address is already in use")
			}
			return VerifyKeyAuthResult{}, pkgerrors.Internal("failed to create wallet user").WithCause(err)
		}
	}

	if user.ProhibitLogin {
		return VerifyKeyAuthResult{}, pkgerrors.Forbidden("account is suspended")
	}

	rawSessionKey, session, err := s.createSession(ctx, user)
	if err != nil {
		return VerifyKeyAuthResult{}, pkgerrors.Internal("failed to create session").WithCause(err)
	}

	return VerifyKeyAuthResult{
		User:       user,
		SessionKey: rawSessionKey,
		ExpiresAt:  session.ExpiresAt,
	}, nil
}

func (s *AuthService) StartGitHubOAuth(ctx context.Context, stateVerifier string) (string, error) {
	// GitHub connect/sign-in always goes DIRECT to the GitHub App now — WorkOS is
	// removed. (Routing through WorkOS made it reject the worker's rewritten
	// redirect_uri: "This is not a valid redirect URI".)
	return s.startGitHubOAuthDirect(ctx, stateVerifier, nil)
}

// StartGitHubOAuthWithScopes starts the first-party CLI/browser OAuth flow and
// records its requested personal-access-token scopes in the one-time state.
// An omitted scopes query preserves the legacy CLI scope set.
func (s *AuthService) StartGitHubOAuthWithScopes(ctx context.Context, stateVerifier, rawScopes string) (string, error) {
	scopes, err := normalizeAndValidateCLIOAuthScopes(rawScopes)
	if err != nil {
		return "", err
	}
	return s.startGitHubOAuthDirect(ctx, stateVerifier, scopes)
}

func (s *AuthService) startGitHubOAuthDirect(ctx context.Context, stateVerifier string, requestedScopes []string) (string, error) {
	githubAuthClient, ok := s.githubClient.(GitHubAuthClient)
	if !ok {
		return "", pkgerrors.Internal("github oauth is not configured")
	}
	if strings.TrimSpace(stateVerifier) == "" {
		return "", pkgerrors.BadRequest("invalid oauth state")
	}

	state := s.generateState()
	_, err := s.queries.CreateOAuthState(ctx, db.CreateOAuthStateParams{
		State:           state,
		ContextHash:     hashOAuthStateVerifier(stateVerifier),
		RequestedScopes: requestedScopes,
		ExpiresAt:       s.now().Add(10 * time.Minute),
	})
	if err != nil {
		return "", pkgerrors.Internal("failed to create oauth state").WithCause(err)
	}

	return githubAuthClient.AuthorizationURL(state), nil
}

// StartAuth0OAuth initiates the Auth0 OAuth flow. It creates a state verifier,
// stores it in the database, and returns an Auth0 authorization URL.
func (s *AuthService) StartAuth0OAuth(ctx context.Context, stateVerifier string) (string, error) {
	if s.auth0Client == nil {
		return "", pkgerrors.Internal("auth0 oauth is not configured")
	}
	if strings.TrimSpace(stateVerifier) == "" {
		return "", pkgerrors.BadRequest("invalid oauth state")
	}

	state := s.generateState()
	_, err := s.queries.CreateOAuthState(ctx, db.CreateOAuthStateParams{
		State:       state,
		ContextHash: hashOAuthStateVerifier(stateVerifier),
		ExpiresAt:   s.now().Add(10 * time.Minute),
	})
	if err != nil {
		return "", pkgerrors.Internal("failed to create oauth state").WithCause(err)
	}

	authURL := s.auth0Client.AuthorizationURL(state)
	return authURL, nil
}

func (s *AuthService) CompleteGitHubOAuth(ctx context.Context, code, state, stateVerifier string) (result OAuthCallbackResult, retErr error) {
	defer func() { s.observeLogin("github", retErr) }()
	if s.githubClient == nil {
		return OAuthCallbackResult{}, pkgerrors.Internal("github oauth is not configured")
	}
	// The provider label is intentionally kept as "workos" for backward
	// compatibility: existing oauth_accounts rows (and the GetOAuthAccountByProviderUserID
	// lookup) were written under that label, so changing it would orphan those
	// accounts and force re-onboarding. The WorkOS service itself is gone — this
	// is just the historical row key.
	return s.completeOAuthWithClient(ctx, s.githubClient, "workos", code, state, stateVerifier)
}

// CompleteAuth0OAuth completes the Auth0 OAuth flow. It uses the Auth0 client
// (which implements GitHubClient) for code exchange and profile fetching,
// then delegates to the same user-creation/session logic as CompleteGitHubOAuth.
func (s *AuthService) CompleteAuth0OAuth(ctx context.Context, code, state, stateVerifier string) (OAuthCallbackResult, error) {
	if s.auth0Client == nil {
		return OAuthCallbackResult{}, pkgerrors.Internal("auth0 oauth is not configured")
	}
	return s.completeOAuthWithClient(ctx, s.auth0Client, "auth0", code, state, stateVerifier)
}

// completeOAuthWithClient is the shared implementation for completing any OAuth flow.
// It validates state, exchanges the code via the given client, fetches the user profile
// and emails, creates or loads the user, and creates a session.
func (s *AuthService) completeOAuthWithClient(ctx context.Context, client GitHubClient, provider string, code, state, stateVerifier string) (OAuthCallbackResult, error) {
	if strings.HasPrefix(state, adminCLIConsentPrefix) {
		return OAuthCallbackResult{}, pkgerrors.BadRequest("invalid oauth state")
	}
	if strings.TrimSpace(code) == "" {
		return OAuthCallbackResult{}, pkgerrors.BadRequest("invalid oauth code")
	}
	if strings.TrimSpace(state) == "" {
		return OAuthCallbackResult{}, pkgerrors.BadRequest("invalid oauth state")
	}
	if strings.TrimSpace(stateVerifier) == "" {
		return OAuthCallbackResult{}, pkgerrors.Unauthorized("invalid oauth state")
	}

	requestedScopes, err := s.queries.ConsumeOAuthStateWithScopes(ctx, db.ConsumeOAuthStateWithScopesParams{
		State:       state,
		ContextHash: hashOAuthStateVerifier(stateVerifier),
	})
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return OAuthCallbackResult{}, pkgerrors.Unauthorized("invalid oauth state")
		}
		return OAuthCallbackResult{}, pkgerrors.Internal("failed to consume oauth state").WithCause(err)
	}
	if len(requestedScopes) == 0 {
		requestedScopes = defaultCLIOAuthScopes()
	}

	adminCLI, err := decodeAdminCLIRequest(requestedScopes)
	if err != nil {
		return OAuthCallbackResult{}, err
	}
	tokenResult, err := client.ExchangeCode(ctx, code)
	if err != nil {
		return OAuthCallbackResult{}, pkgerrors.BadRequest("failed to exchange oauth code")
	}

	user, err := s.resolveOAuthUser(ctx, client, provider, tokenResult.AccessToken, tokenResult.RefreshToken, tokenResult.ExpiresIn)
	if err != nil {
		return OAuthCallbackResult{}, err
	}

	if adminCLI != nil {
		return OAuthCallbackResult{User: user, AdminCLI: adminCLI}, nil
	}

	rawSessionKey, session, err := s.createSession(ctx, user)
	if err != nil {
		return OAuthCallbackResult{}, pkgerrors.Internal("failed to create session").WithCause(err)
	}

	return OAuthCallbackResult{
		User:        user,
		SessionKey:  rawSessionKey,
		ExpiresAt:   session.ExpiresAt,
		RedirectURL: "/",
		TokenScopes: requestedScopes,
	}, nil
}

// resolveOAuthUser verifies an OAuth access token against the provider by
// fetching the profile and emails with it (identity always comes from the
// provider's API, never from the caller's claim), finds or creates the local
// user, and upserts the oauth_accounts row (encrypted token) plus the primary email address.
// It is shared by the browser OAuth callback flow and the trusted worker
// token-exchange flow.
func (s *AuthService) resolveOAuthUser(ctx context.Context, client GitHubClient, provider, accessToken, refreshToken string, expiresIn int64) (db.User, error) {
	profile, err := client.FetchUser(ctx, accessToken)
	if err != nil {
		return db.User{}, oauthFetchError("profile", err)
	}

	emails, err := client.FetchEmails(ctx, accessToken)
	if err != nil {
		return db.User{}, oauthFetchError("emails", err)
	}

	providerUserID := fmt.Sprintf("%d", profile.ID)
	account, err := s.queries.GetOAuthAccountByProviderUserID(ctx, db.GetOAuthAccountByProviderUserIDParams{
		Provider:       provider,
		ProviderUserID: providerUserID,
	})

	var user db.User
	if err == nil {
		// Validate that the stored access token is still decryptable before proceeding.
		// If a non-empty ciphertext is present but fails to decrypt, abort rather than
		// silently overwriting with the new token — this surfaces key-rotation issues early.
		if len(account.AccessTokenEncrypted) > 0 {
			if _, decryptErr := s.DecryptOAuthAccessToken(account.AccessTokenEncrypted); decryptErr != nil {
				return db.User{}, pkgerrors.Internal("failed to decrypt existing oauth access token").WithCause(decryptErr)
			}
		}
		user, err = s.queries.GetUserByID(ctx, account.UserID)
		if err != nil {
			return db.User{}, pkgerrors.Internal("failed to load oauth user").WithCause(err)
		}
		if config.IsSingleOwner(s.cfg) {
			localQueries, localErr := s.localIdentityQueries()
			if localErr != nil {
				return db.User{}, localErr
			}
			owner, ownerErr := localQueries.GetSelfHostOwner(ctx)
			if ownerErr != nil || owner.ID != user.ID {
				return db.User{}, pkgerrors.Forbidden("external identity is not linked to the installation owner")
			}
			user = owner
		}
	} else {
		if !stdErrors.Is(err, pgx.ErrNoRows) {
			return db.User{}, pkgerrors.Internal("failed to query oauth account")
		}
		if config.IsSingleOwner(s.cfg) {
			// Never infer that a previously unseen external identity owns this
			// installation. Provider/repository connections are authorized by an
			// existing owner session through their dedicated routes; they are not
			// an alternate self-host account-provisioning path.
			return db.User{}, pkgerrors.Forbidden("external identity is not linked to the installation owner")
		} else {
			// Only a GitHub-verified address may become users.email: an
			// unverified one would squat the real owner's address on
			// uq_users_lower_email and block their signup.
			email := pickVerifiedEmail(emails)
			emailText := pgtype.Text{String: email, Valid: email != ""}
			user, err = s.queries.CreateUser(ctx, db.CreateUserParams{
				Username:      profile.Login,
				LowerUsername: strings.ToLower(profile.Login),
				Email:         emailText,
				LowerEmail:    pgtype.Text{String: strings.ToLower(email), Valid: email != ""},
				DisplayName:   firstNonEmpty(profile.Name, profile.Login),
			})
			if err != nil {
				if isUniqueViolation(err) {
					if isUsernameUniqueViolation(err) {
						return db.User{}, pkgerrors.Conflict("username is already in use")
					}
					return db.User{}, pkgerrors.Conflict("email address is already in use")
				}
				return db.User{}, pkgerrors.Internal("failed to create oauth user").WithCause(err)
			}
		}
	}

	if user.ProhibitLogin {
		return db.User{}, pkgerrors.Forbidden("account is suspended")
	}

	profileData, err := authJSONMarshal(profile)
	if err != nil {
		return db.User{}, pkgerrors.Internal("failed to encode oauth profile").WithCause(err)
	}

	secret := strings.TrimSpace(s.cfg.SessionSecret)
	if secret == "" {
		return db.User{}, pkgerrors.Internal("oauth token encryption failed: missing session secret")
	}
	key := smitherscrypto.DeriveKey(secret)
	encryptedToken, err := authEncrypt(key, []byte(accessToken))
	if err != nil {
		return db.User{}, pkgerrors.Internal("oauth token encryption failed: " + err.Error())
	}

	if trimmed := strings.TrimSpace(refreshToken); trimmed != "" {
		// encryptErr is named apart from err so the upsert below assigns the
		// outer err that the shared error check reads; a shadowed err here
		// silently dropped every UpsertOAuthAccount failure.
		refreshTokenEncrypted, encryptErr := authEncrypt(key, []byte(trimmed))
		if encryptErr != nil {
			return db.User{}, pkgerrors.Internal("oauth token encryption failed: " + encryptErr.Error())
		}
		_, err = s.queries.UpsertOAuthAccount(ctx, db.UpsertOAuthAccountParams{
			UserID:                user.ID,
			Provider:              provider,
			ProviderUserID:        providerUserID,
			AccessTokenEncrypted:  encryptedToken,
			RefreshTokenEncrypted: refreshTokenEncrypted,
			ExpiresAt:             githubTokenExpiry(s.now(), expiresIn),
			ProfileData:           profileData,
		})
	} else {
		preserveQueries, ok := s.queries.(oauthAccountPreserveRefreshQuerier)
		if !ok {
			return db.User{}, pkgerrors.Internal("oauth preserve-refresh query is not configured")
		}
		_, err = preserveQueries.UpsertOAuthAccountPreserveRefresh(ctx, db.UpsertOAuthAccountPreserveRefreshParams{
			UserID:               user.ID,
			Provider:             provider,
			ProviderUserID:       providerUserID,
			AccessTokenEncrypted: encryptedToken,
			ExpiresAt:            githubTokenExpiry(s.now(), expiresIn),
			ProfileData:          profileData,
		})
	}
	if err != nil {
		return db.User{}, pkgerrors.Internal("failed to upsert oauth account").WithCause(err)
	}

	if email := pickVerifiedEmail(emails); email != "" {
		if _, upsertErr := s.queries.UpsertEmailAddress(ctx, db.UpsertEmailAddressParams{
			UserID:      user.ID,
			Email:       email,
			LowerEmail:  strings.ToLower(email),
			IsActivated: true,
			IsPrimary:   true,
		}); upsertErr != nil {
			slog.Warn("oauth login could not record verified email", "user_id", user.ID, "error", upsertErr)
		}
	}

	return user, nil
}

// ExchangeGitHubTokenResult is the result of a trusted worker exchanging a
// GitHub access token for a Plue personal access token.
type ExchangeGitHubTokenResult struct {
	User      db.User
	Token     string
	TokenID   int64
	ExpiresAt *time.Time
}

// resolveExchangeTokenExpiry computes the expires_at for an exchange-minted
// PAT. An explicit ttl_seconds always wins (capped at maxExchangeTokenTTL);
// multi-worker-prefixed tokens default to maxExchangeTokenTTL so per-session
// tokens self-expire; other names keep the standard PAT default (nil here —
// CreateToken applies defaultAccessTokenTTL).
func (s *AuthService) resolveExchangeTokenExpiry(name string, ttlSeconds *int64) (*time.Time, error) {
	var ttl time.Duration
	switch {
	case ttlSeconds != nil:
		if *ttlSeconds <= 0 {
			return nil, pkgerrors.BadRequest("ttl_seconds must be a positive number of seconds")
		}
		if *ttlSeconds >= int64(maxExchangeTokenTTL/time.Second) {
			ttl = maxExchangeTokenTTL
		} else {
			ttl = time.Duration(*ttlSeconds) * time.Second
		}
	case strings.HasPrefix(name, multiWorkerTokenNamePrefix):
		ttl = maxExchangeTokenTTL
	default:
		return nil, nil
	}
	expiresAt := s.now().Add(ttl)
	return &expiresAt, nil
}

// ExchangeGitHubToken verifies a GitHub access token by fetching the user's
// profile/emails from GitHub, resolves (or creates) the corresponding local
// user with the exact same rules as the browser OAuth flow, then rotates the
// named personal access token: any existing token with the same name is
// deleted and a fresh one is minted (the plaintext is only known at mint
// time, so rotation — not reuse — is the correct dedupe).
//
// ttlSeconds optionally bounds the minted token's lifetime (capped at 8 days);
// multi-worker-prefixed names get the 8-day expiry even when ttlSeconds is
// absent, so per-session worker tokens always self-expire.
//
// githubRefreshToken is the GitHub refresh token minted alongside the access
// token during THIS login. When non-empty it is persisted (encrypted) in the
// same oauth_accounts field the browser OAuth callback uses, so a later
// RefreshUserGitHubToken can renew the ~8h GitHub App access token instead of
// 401'ing forever. When empty the behavior is exactly as before: any refresh
// token a prior browser login stored is preserved.
//
// githubTokenExpiresIn is GitHub's expires_in (seconds) for that access token, if
// the caller knows it. Zero means "unknown" and stores a NULL expiry, which keeps
// the account on reactive-on-401 refresh — correct, just one wasted call per
// cycle. The first server-side refresh backfills a real expiry regardless, so
// accounts self-upgrade to proactive refresh without any caller change.
func (s *AuthService) ExchangeGitHubToken(ctx context.Context, githubAccessToken, tokenName, githubRefreshToken string, githubTokenExpiresIn int64, ttlSeconds *int64) (result ExchangeGitHubTokenResult, retErr error) {
	defer func() { s.observeLogin("github", retErr) }()
	if s.githubClient == nil {
		return ExchangeGitHubTokenResult{}, pkgerrors.Internal("github oauth is not configured")
	}
	if strings.TrimSpace(githubAccessToken) == "" {
		return ExchangeGitHubTokenResult{}, pkgerrors.BadRequest("github access token is required")
	}
	name := strings.TrimSpace(tokenName)
	if name == "" {
		name = multiWorkerTokenNamePrefix
	}

	expiresAt, err := s.resolveExchangeTokenExpiry(name, ttlSeconds)
	if err != nil {
		return ExchangeGitHubTokenResult{}, err
	}

	// Provider label is intentionally "workos" — the historical row key for
	// GitHub-backed oauth_accounts (see the comment at CompleteGitHubOAuth).
	// A non-empty githubRefreshToken (freshly minted this login) is newer by
	// construction and overwrites any stored one; an empty one preserves
	// whatever a prior browser OAuth login already stored (today's behavior).
	user, err := s.resolveOAuthUser(ctx, s.githubClient, "workos", githubAccessToken, githubRefreshToken, githubTokenExpiresIn)
	if err != nil {
		return ExchangeGitHubTokenResult{}, err
	}

	// Rotate mint-first: create the replacement token BEFORE deleting the old
	// one(s), so a failed mint leaves the previous token (still sealed in other
	// sessions) valid instead of stranding the user with no credential at all.
	exchangeScopes := []string{"repo", "user", "org"}
	if config.IsSingleOwner(s.cfg) {
		exchangeScopes = []string{"repo", "user", "workspace", "approval", "agent"}
	}
	created, err := s.CreateToken(ctx, user.ID, CreateTokenRequest{
		Name:      name,
		Scopes:    exchangeScopes,
		ExpiresAt: expiresAt,
	})
	if err != nil {
		return ExchangeGitHubTokenResult{}, err
	}

	existing, err := s.queries.ListAccessTokensByUserID(ctx, user.ID)
	if err != nil {
		return ExchangeGitHubTokenResult{}, pkgerrors.Internal("failed to list access tokens").WithCause(err)
	}
	// Delete only same-name tokens STRICTLY OLDER than the one just minted.
	// Because IDs are BIGSERIAL, two concurrent exchanges (a retried request,
	// two tabs) converge to last-writer-wins: the newest mint always survives
	// instead of the racers cross-deleting each other's fresh token and both
	// returning a credential whose row was already hard-deleted. Works across
	// API replicas where an in-process mutex could not.
	for _, token := range existing {
		if token.Name != name || token.ID >= created.ID {
			continue
		}
		rows, err := s.queries.DeleteAccessTokenByIDAndUserID(ctx, db.DeleteAccessTokenByIDAndUserIDParams{
			ID:     token.ID,
			UserID: user.ID,
		})
		if err != nil {
			return ExchangeGitHubTokenResult{}, pkgerrors.Internal("failed to rotate access token").WithCause(err)
		}
		if rows == 0 {
			continue
		}
		revocation.PublishBestEffort(ctx, s.revocations, revocation.Event{
			Kind:      revocation.KindTokenRevoked,
			UserID:    user.ID,
			TokenID:   token.ID,
			TokenHash: token.TokenHash,
			Reason:    "token rotated",
			ActorID:   user.ID,
		})
	}

	return ExchangeGitHubTokenResult{
		User:      user,
		Token:     created.Token,
		TokenID:   created.ID,
		ExpiresAt: created.ExpiresAt,
	}, nil
}

func (s *AuthService) Logout(ctx context.Context, sessionKey string) error {
	if strings.TrimSpace(sessionKey) == "" {
		return nil
	}
	if !isValidUUID(sessionKey) {
		return nil // Invalid session key format — treat as "session not found" (no-op)
	}
	// The browser has already dropped its cookie and cannot retry, so the
	// session is deleted even when recording the revocation fails; that
	// failure is still reported.
	publishErr := s.publishSessionRevoked(ctx, sessionRevokedEvent(sessionStorageKey(sessionKey), 0, "logout"))
	// Sessions minted after keys were hashed at rest are keyed by their
	// digest; rows minted before stay raw-keyed until they expire. Delete
	// both forms so logout is immediate for either generation.
	if err := s.queries.DeleteAuthSession(ctx, sessionStorageKey(sessionKey)); err != nil {
		return err
	}
	if err := s.queries.DeleteAuthSession(ctx, sessionKey); err != nil {
		return err
	}
	return publishErr
}

func sessionRevokedEvent(sessionHash string, userID int64, reason string) revocation.Event {
	return revocation.Event{
		Kind:      revocation.KindBrowserSessionRevoked,
		UserID:    userID,
		TokenHash: sessionHash,
		Reason:    reason,
		ActorID:   userID,
	}
}

// publishSessionRevoked records the revocation before the session row is
// deleted. Once recorded, the bus cache refuses the session on every new
// stream while the deletion completes.
func (s *AuthService) publishSessionRevoked(ctx context.Context, event revocation.Event) error {
	if s.revocations == nil {
		return nil
	}
	if err := s.revocations.Publish(ctx, event); err != nil {
		return pkgerrors.Internal("failed to revoke session").WithCause(err)
	}
	return nil
}

// sessionStorageKey derives the value persisted in auth_sessions.session_key
// from the raw session key handed to the client. The session key doubles as
// the live session bearer credential (it is the session cookie's value — see
// internal/middleware/auth.go loadSessionAuth), so only its SHA-256 digest is
// stored, matching the recipe every other Smithers credential class already
// uses (PATs, OAuth2 tokens, SSE tickets): a read-only database
// compromise must not yield every active login.
func sessionStorageKey(rawSessionKey string) string {
	sum := sha256.Sum256([]byte(rawSessionKey))
	return hex.EncodeToString(sum[:])
}

func (s *AuthService) ListUserSessions(ctx context.Context, userID int64) ([]db.AuthSession, error) {
	return s.queries.ListUserSessions(ctx, userID)
}

// SessionPublicID derives a stable, non-secret identifier for an auth session
// from its secret session key. The session key doubles as the live session
// bearer credential (it is the value of the session cookie — see
// internal/middleware/auth.go loadSessionAuth), so it must never be returned in
// API responses. SHA-256 is preimage-resistant, so the public id can be safely
// listed, logged, and displayed while remaining a stable handle for revocation.
func SessionPublicID(sessionKey string) string {
	sum := sha256.Sum256([]byte(sessionKey))
	return hex.EncodeToString(sum[:])
}

func (s *AuthService) RevokeUserSession(ctx context.Context, userID int64, sessionID string) error {
	sessionID = strings.TrimSpace(sessionID)
	if sessionID == "" {
		return pkgerrors.NotFound("session not found")
	}

	sessions, err := s.queries.ListUserSessions(ctx, userID)
	if err != nil {
		return err
	}

	for _, session := range sessions {
		if SessionPublicID(session.SessionKey) == sessionID {
			if err := s.publishSessionRevoked(ctx, sessionRevokedEvent(storedSessionHash(session.SessionKey), userID, "session deleted")); err != nil {
				return err
			}
			return s.queries.DeleteAuthSession(ctx, session.SessionKey)
		}
	}
	return pkgerrors.NotFound("session not found")
}

// storedSessionHash maps an auth_sessions.session_key to the SHA-256 of the
// raw key: current rows already store that digest, legacy rows store the raw
// UUID key.
func storedSessionHash(storedKey string) string {
	if isValidUUID(storedKey) {
		return sessionStorageKey(storedKey)
	}
	return storedKey
}

// isValidUUID checks if a string is a valid UUID format (8-4-4-4-12 hex digits).
func isValidUUID(s string) bool {
	if len(s) != 36 {
		return false
	}
	for i, ch := range s {
		switch i {
		case 8, 13, 18, 23:
			if ch != '-' {
				return false
			}
		default:
			if (ch < '0' || ch > '9') && (ch < 'a' || ch > 'f') && (ch < 'A' || ch > 'F') {
				return false
			}
		}
	}
	return true
}

func (s *AuthService) ListTokens(ctx context.Context, userID int64) ([]TokenSummary, error) {
	tokens, err := s.queries.ListAccessTokensByUserID(ctx, userID)
	if err != nil {
		return nil, err
	}

	result := make([]TokenSummary, 0, len(tokens))
	for _, token := range tokens {
		result = append(result, TokenSummary{
			ID:             token.ID,
			Name:           token.Name,
			TokenLastEight: token.TokenLastEight,
			Scopes:         splitScopes(token.Scopes),
			ExpiresAt:      timePtrFromTimestamptz(token.ExpiresAt),
		})
	}
	return result, nil
}

func (s *AuthService) CreateToken(ctx context.Context, userID int64, req CreateTokenRequest) (CreateTokenResult, error) {
	name, nameErr := validateCreateTokenName(req.Name)
	if nameErr != nil {
		return CreateTokenResult{}, nameErr
	}

	normalizedScopes, scopeErr := normalizeAndValidateRequestedScopes(req.Scopes)
	if scopeErr != nil {
		return CreateTokenResult{}, scopeErr
	}

	expiresAt, expiresErr := s.resolveCreateTokenExpiresAt(req.ExpiresAt)
	if expiresErr != nil {
		return CreateTokenResult{}, expiresErr
	}

	if containsPrivilegedScope(normalizedScopes) {
		user, err := s.queries.GetUserByID(ctx, userID)
		if err != nil {
			return CreateTokenResult{}, pkgerrors.Internal("failed to resolve user").WithCause(err)
		}
		if !user.IsAdmin {
			return CreateTokenResult{}, pkgerrors.Forbidden("insufficient privileges for requested token scopes")
		}
	}

	rawToken := "smithers_" + randomHex(20)
	hash := sha256.Sum256([]byte(rawToken))
	tokenHash := hex.EncodeToString(hash[:])
	tokenLastEight := tokenHash[len(tokenHash)-8:]

	created, err := s.queries.CreateAccessToken(ctx, db.CreateAccessTokenParams{
		UserID:         userID,
		Name:           name,
		TokenHash:      tokenHash,
		TokenLastEight: tokenLastEight,
		Scopes:         strings.Join(normalizedScopes, ","),
		ExpiresAt:      pgtype.Timestamptz{Time: expiresAt, Valid: true},
	})
	if err != nil {
		return CreateTokenResult{}, err
	}

	return CreateTokenResult{
		TokenSummary: TokenSummary{
			ID:             created.ID,
			Name:           created.Name,
			TokenLastEight: created.TokenLastEight,
			Scopes:         splitScopes(created.Scopes),
			ExpiresAt:      timePtrFromTimestamptz(created.ExpiresAt),
		},
		Token: rawToken,
	}, nil
}

func (s *AuthService) DeleteToken(ctx context.Context, userID, tokenID int64) error {
	// Capture the hash before the row is gone: live streams and terminals
	// authorized by this token are matched on it.
	var tokenHash string
	if reader, ok := s.queries.(accessTokenHashReader); ok {
		if row, err := reader.GetAccessTokenHashByID(ctx, tokenID); err == nil && row.UserID == userID {
			tokenHash = row.TokenHash
		}
	}
	rows, err := s.queries.DeleteAccessTokenByIDAndUserID(ctx, db.DeleteAccessTokenByIDAndUserIDParams{
		ID:     tokenID,
		UserID: userID,
	})
	if err != nil {
		return err
	}
	if rows == 0 {
		return pkgerrors.NotFound("token not found")
	}
	revocation.PublishBestEffort(ctx, s.revocations, revocation.Event{
		Kind:      revocation.KindTokenRevoked,
		UserID:    userID,
		TokenID:   tokenID,
		TokenHash: tokenHash,
		Reason:    "token deleted",
		ActorID:   userID,
	})
	return nil
}

func (s *AuthService) sessionDuration() time.Duration {
	duration, err := time.ParseDuration(s.cfg.SessionDuration)
	if err != nil || duration <= 0 {
		return 720 * time.Hour
	}
	return duration
}

// createSession is the one session-minting seam for local credentials and
// optional external providers. The browser receives the raw random key while
// PostgreSQL stores only its digest.
func (s *AuthService) createSession(ctx context.Context, user db.User) (string, db.AuthSession, error) {
	rawSessionKey := s.generateSession()
	session, err := s.queries.CreateAuthSession(ctx, db.CreateAuthSessionParams{
		SessionKey: sessionStorageKey(rawSessionKey),
		UserID:     user.ID,
		Username:   user.Username,
		IsAdmin:    user.IsAdmin,
		ExpiresAt:  s.now().Add(s.sessionDuration()),
	})
	return rawSessionKey, session, err
}

func splitScopes(raw string) []string {
	if strings.TrimSpace(raw) == "" {
		return []string{}
	}

	// Same dual-separator rule as middleware.ParseTokenScopes: legacy rows
	// are space-joined, current rows comma-joined.
	parts := strings.FieldsFunc(raw, func(r rune) bool { return r == ',' || unicode.IsSpace(r) })
	result := make([]string, 0, len(parts))
	for _, part := range parts {
		scope := strings.TrimSpace(part)
		if scope == "" {
			continue
		}
		result = append(result, scope)
	}
	return result
}

func validateCreateTokenName(name string) (string, *pkgerrors.APIError) {
	trimmed := strings.TrimSpace(name)
	if trimmed == "" {
		return "", pkgerrors.ValidationFailed(pkgerrors.FieldError{
			Resource: "AccessToken",
			Field:    "name",
			Code:     "missing_field",
		})
	}
	return trimmed, nil
}

func (s *AuthService) resolveCreateTokenExpiresAt(requested *time.Time) (time.Time, *pkgerrors.APIError) {
	now := s.now()
	if requested == nil {
		return now.Add(defaultAccessTokenTTL), nil
	}
	expiresAt := requested.UTC()
	if !expiresAt.After(now) {
		return time.Time{}, pkgerrors.ValidationFailed(pkgerrors.FieldError{
			Resource: "AccessToken",
			Field:    "expires_at",
			Code:     "invalid",
		})
	}
	return expiresAt, nil
}

func timePtrFromTimestamptz(value pgtype.Timestamptz) *time.Time {
	if !value.Valid {
		return nil
	}
	t := value.Time.UTC()
	return &t
}

func normalizeAndValidateRequestedScopes(scopes []string) ([]string, *pkgerrors.APIError) {
	if len(scopes) == 0 {
		return nil, pkgerrors.ValidationFailed(pkgerrors.FieldError{
			Resource: "AccessToken",
			Field:    "scopes",
			Code:     "missing_field",
		})
	}

	seen := make(map[string]struct{}, len(scopes))
	normalized := make([]string, 0, len(scopes))
	validationErrors := make([]pkgerrors.FieldError, 0)

	for idx, rawScope := range scopes {
		scope := middleware.NormalizeTokenScope(rawScope)
		if scope == "" {
			validationErrors = append(validationErrors, pkgerrors.FieldError{
				Resource: "AccessToken",
				Field:    fmt.Sprintf("scopes[%d]", idx),
				Code:     "invalid",
			})
			continue
		}

		canonical := string(scope)
		if _, ok := seen[canonical]; ok {
			continue
		}
		seen[canonical] = struct{}{}
		normalized = append(normalized, canonical)
	}

	if len(validationErrors) > 0 {
		return nil, pkgerrors.ValidationFailed(validationErrors...)
	}

	sort.Strings(normalized)
	return normalized, nil
}

func defaultCLIOAuthScopes() []string {
	return []string{
		string(middleware.ScopeWriteOrganization),
		string(middleware.ScopeWriteRepository),
		string(middleware.ScopeWriteUser),
	}
}

// normalizeAndValidateCLIOAuthScopes bounds first-party CLI/browser login to
// ordinary user capabilities. Administrative wildcard scopes must still be
// created through the privileged token-management path, never a login URL.
func normalizeAndValidateCLIOAuthScopes(raw string) ([]string, *pkgerrors.APIError) {
	if strings.TrimSpace(raw) == "" {
		return defaultCLIOAuthScopes(), nil
	}

	scopes, err := normalizeAndValidateRequestedScopes(strings.Split(raw, ","))
	if err != nil {
		return nil, err
	}
	for _, scope := range scopes {
		switch middleware.TokenScope(scope) {
		case middleware.ScopeReadRepository, middleware.ScopeWriteRepository,
			middleware.ScopeReadOrganization, middleware.ScopeWriteOrganization,
			middleware.ScopeReadUser, middleware.ScopeWriteUser,
			middleware.ScopeReadWorkspace, middleware.ScopeWriteWorkspace,
			middleware.ScopeReadApproval, middleware.ScopeWriteApproval,
			middleware.ScopeReadAgent, middleware.ScopeWriteAgent:
			continue
		default:
			return nil, pkgerrors.ValidationFailed(pkgerrors.FieldError{
				Resource: "AccessToken",
				Field:    "scopes",
				Code:     "invalid",
			})
		}
	}
	return scopes, nil
}

func containsPrivilegedScope(scopes []string) bool {
	for _, scope := range scopes {
		if scope == string(middleware.ScopeAdmin) ||
			scope == string(middleware.ScopeReadAdmin) ||
			scope == string(middleware.ScopeWriteAdmin) ||
			scope == string(middleware.ScopeAll) {
			return true
		}
	}
	return false
}

// oauthFetchError maps a GitHub profile or emails fetch failure to an API
// error: a rejected token is the caller's 401, anything else is a 500 that
// keeps the cause for the server log.
func oauthFetchError(what string, err error) error {
	if stdErrors.Is(err, ErrGitHubTokenRejected) {
		return pkgerrors.Unauthorized("github access token was rejected")
	}
	return pkgerrors.Internal("failed to fetch oauth " + what + ": " + err.Error())
}

// pickVerifiedEmail returns a GitHub-verified email (primary first) or "" when
// none is verified. Every caller that trusts an address (users.email,
// activated email rows) uses it: an unverified
// address would let an attacker claim or squat an email they do not own.
func pickVerifiedEmail(emails []GitHubEmail) string {
	for _, email := range emails {
		if email.Primary && email.Verified {
			return email.Email
		}
	}
	for _, email := range emails {
		if email.Verified {
			return email.Email
		}
	}
	return ""
}

// walletUsernameCandidates returns deterministic username candidates for a new
// wallet user in increasing-entropy order: the last 8 hex characters of the
// address, then the last 16, then the full address. Later candidates are only
// tried when an earlier one is already taken by a different wallet, so two
// addresses sharing a suffix can never permanently block each other's signup.
func walletUsernameCandidates(walletAddress string) []string {
	normalized := strings.TrimPrefix(strings.ToLower(strings.TrimSpace(walletAddress)), "0x")
	if normalized == "" {
		return []string{"wallet-" + randomHex(4)}
	}
	var candidates []string
	for _, n := range []int{8, 16} {
		if len(normalized) > n {
			candidates = append(candidates, "wallet-"+normalized[len(normalized)-n:])
		}
	}
	return append(candidates, "wallet-"+normalized)
}

// isUsernameUniqueViolation reports whether err is a unique violation on a
// user name or the shared user/organization namespace (as opposed to the
// wallet-address unique index, which means the wallet itself is registered).
func isUsernameUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	if !stdErrors.As(err, &pgErr) || pgErr.Code != "23505" {
		return false
	}
	return pgErr.ConstraintName == "users_username_key" ||
		pgErr.ConstraintName == "users_lower_username_key" ||
		pgErr.ConstraintName == "owner_namespaces_pkey"
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

func (s *AuthService) keyAuthExpectedDomain() string {
	return strings.TrimSpace(s.cfg.KeyAuthDomain)
}

func (s *AuthService) DecryptOAuthAccessToken(ciphertext []byte) (string, error) {
	if len(ciphertext) == 0 {
		return "", pkgerrors.Internal("failed to decrypt oauth access token")
	}

	key := smitherscrypto.DeriveKey(strings.TrimSpace(s.cfg.SessionSecret))
	plaintext, err := smitherscrypto.Decrypt(key, ciphertext)
	if err != nil {
		return "", pkgerrors.Internal("failed to decrypt oauth access token").WithCause(err)
	}

	return string(plaintext), nil
}

func oauthAccountTokensChanged(current, previous db.OauthAccount) bool {
	return !bytes.Equal(current.AccessTokenEncrypted, previous.AccessTokenEncrypted) ||
		!bytes.Equal(current.RefreshTokenEncrypted, previous.RefreshTokenEncrypted)
}

func (s *AuthService) oauthAccessTokenFromAccount(account db.OauthAccount) (string, error) {
	token, err := s.DecryptOAuthAccessToken(account.AccessTokenEncrypted)
	if err != nil {
		return "", err
	}
	if token = strings.TrimSpace(token); token != "" {
		return token, nil
	}
	return "", pkgerrors.Unauthorized("github oauth token was rejected")
}

func (s *AuthService) currentOAuthAccessToken(ctx context.Context, account db.OauthAccount) (string, error) {
	current, err := s.queries.GetOAuthAccountByProviderUserID(ctx, db.GetOAuthAccountByProviderUserIDParams{
		Provider:       account.Provider,
		ProviderUserID: account.ProviderUserID,
	})
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return "", pkgerrors.Unauthorized("github oauth token was rejected")
		}
		return "", pkgerrors.Internal("failed to query oauth account").WithCause(err)
	}
	return s.oauthAccessTokenFromAccount(current)
}

// RefreshUserGitHubToken exchanges the account's stored GitHub refresh token for
// a fresh user-to-server access token, re-encrypts and persists the rotated
// access+refresh tokens with the SAME key, and returns the new access token. It
// is the reactive remedy for the ~8h GitHub App access-token expiry: callers
// invoke it once after a 401/403 and retry.
//
// When the account has no stored refresh token (the common case for sessions
// minted before refresh tokens were persisted), or the configured client cannot
// refresh, it returns the credential-gone error unchanged so callers fall back
// to today's serve-last-good / honest-401 behavior — never a refresh loop.
func (s *AuthService) RefreshUserGitHubToken(ctx context.Context, account db.OauthAccount) (string, error) {
	if s == nil || s.githubClient == nil {
		return "", pkgerrors.Unauthorized("github oauth token was rejected")
	}
	// No stored refresh token at all: nothing can renew this credential, so say
	// so in a way the client can act on instead of retrying a dead 401 forever.
	if len(account.RefreshTokenEncrypted) == 0 {
		return "", pkgerrors.GitHubReconnectRequired("github oauth token was rejected")
	}
	// Not every GitHubClient implementation can refresh (e.g. Auth0). Feature
	// -detect via a narrow interface so we don't widen GitHubClient / all mocks.
	refresher, ok := s.githubClient.(interface {
		RefreshToken(ctx context.Context, refreshToken string) (GitHubTokenResult, error)
	})
	if !ok {
		return "", pkgerrors.Unauthorized("github oauth token was rejected")
	}
	casQueries, ok := s.queries.(oauthAccountTokenCASQuerier)
	if !ok {
		return "", pkgerrors.Internal("oauth token CAS queries are not configured")
	}

	// Two layers of serialization, because GitHub rotates the refresh token on
	// every exchange and rejects the previous one:
	//   1. the in-process lock collapses concurrent goroutines in THIS replica;
	//   2. the optional cluster locker collapses concurrent replicas.
	// Without (2) the CAS + heal path below still converges on the correct row.
	s.githubRefreshLocks.acquire(account.UserID)
	defer s.githubRefreshLocks.release(account.UserID)

	if s.githubRefreshLocker == nil {
		return s.refreshUserGitHubTokenLocked(ctx, account, refresher, casQueries)
	}
	var token string
	if err := s.githubRefreshLocker.WithUserRefreshLock(ctx, account.Provider, account.ProviderUserID, func(ctx context.Context) error {
		var innerErr error
		token, innerErr = s.refreshUserGitHubTokenLocked(ctx, account, refresher, casQueries)
		return innerErr
	}); err != nil {
		return "", err
	}
	return token, nil
}

// refreshUserGitHubTokenLocked is the refresh critical section. Callers MUST hold
// the per-user lock(s); it assumes it is the only in-flight refresh for account.
func (s *AuthService) refreshUserGitHubTokenLocked(
	ctx context.Context,
	account db.OauthAccount,
	refresher interface {
		RefreshToken(ctx context.Context, refreshToken string) (GitHubTokenResult, error)
	},
	casQueries oauthAccountTokenCASQuerier,
) (string, error) {
	// Under the lock, re-read the row: if a concurrent 401 already rotated the
	// token while we waited, return ITS fresh access token instead of spending our
	// now-consumed (single-use) refresh token — which GitHub would reject with
	// bad_refresh_token, spuriously surfacing "reconnect" for the losing request.
	if current, rerr := s.queries.GetOAuthAccountByProviderUserID(ctx, db.GetOAuthAccountByProviderUserIDParams{
		Provider:       account.Provider,
		ProviderUserID: account.ProviderUserID,
	}); rerr == nil && oauthAccountTokensChanged(current, account) {
		if fresh, derr := s.oauthAccessTokenFromAccount(current); derr == nil {
			return fresh, nil
		}
		account = current // couldn't decrypt — at least refresh from the freshest row
	}

	refreshToken, err := s.DecryptOAuthAccessToken(account.RefreshTokenEncrypted)
	if err != nil {
		return "", err
	}
	if strings.TrimSpace(refreshToken) == "" {
		return "", pkgerrors.Unauthorized("github oauth token was rejected")
	}

	result, err := refresher.RefreshToken(ctx, refreshToken)
	if err != nil {
		// A definitively-invalid refresh token (revoked/consumed grant) will never
		// succeed — clear the stored ciphertext so future 401s short-circuit on the
		// empty-refresh-token guard instead of refreshing on every request forever.
		if stdErrors.Is(err, ErrGitHubRefreshTokenInvalid) {
			current, rerr := s.queries.GetOAuthAccountByProviderUserID(ctx, db.GetOAuthAccountByProviderUserIDParams{
				Provider:       account.Provider,
				ProviderUserID: account.ProviderUserID,
			})
			if rerr != nil {
				if stdErrors.Is(rerr, pgx.ErrNoRows) {
					return "", pkgerrors.Unauthorized("github oauth token was rejected")
				}
				return "", pkgerrors.Internal("failed to query oauth account").WithCause(rerr)
			}
			if oauthAccountTokensChanged(current, account) {
				return s.oauthAccessTokenFromAccount(current)
			}
			rows, cerr := casQueries.ClearOAuthAccountRefreshTokenCAS(ctx, db.ClearOAuthAccountRefreshTokenCASParams{
				Provider:                 account.Provider,
				ProviderUserID:           account.ProviderUserID,
				OldAccessTokenEncrypted:  account.AccessTokenEncrypted,
				OldRefreshTokenEncrypted: account.RefreshTokenEncrypted,
			})
			if cerr != nil {
				slog.Warn("github oauth dead refresh-token clear failed", "user_id", account.UserID, "error", cerr)
			} else if rows == 0 {
				return s.currentOAuthAccessToken(ctx, account)
			}
			// The grant itself is gone (revoked, or the refresh token was already
			// consumed and never rotated back). No amount of retrying fixes this —
			// only a human re-authorizing the GitHub App does.
			return "", pkgerrors.GitHubReconnectRequired("github oauth token was rejected")
		}
		return "", pkgerrors.Unauthorized("github oauth token was rejected")
	}
	newAccess := strings.TrimSpace(result.AccessToken)
	if newAccess == "" {
		return "", pkgerrors.Unauthorized("github oauth token was rejected")
	}

	secret := strings.TrimSpace(s.cfg.SessionSecret)
	if secret == "" {
		return "", pkgerrors.Internal("oauth token encryption failed: missing session secret")
	}
	key := smitherscrypto.DeriveKey(secret)
	encryptedAccess, err := authEncrypt(key, []byte(newAccess))
	if err != nil {
		return "", pkgerrors.Internal("oauth token encryption failed: " + err.Error())
	}

	// GitHub rotates the refresh token on every refresh; persist the new one
	// when returned, otherwise keep the existing ciphertext.
	encryptedRefresh := account.RefreshTokenEncrypted
	if newRefresh := strings.TrimSpace(result.RefreshToken); newRefresh != "" {
		encryptedRefresh, err = authEncrypt(key, []byte(newRefresh))
		if err != nil {
			return "", pkgerrors.Internal("oauth token encryption failed: " + err.Error())
		}
	}

	// Record when the NEW access token dies so the next caller can refresh
	// proactively instead of paying a doomed 401 first. GitHub omits expires_in
	// when the App does not have expiring user tokens enabled; leave the column
	// NULL in that case so we degrade to today's reactive-on-401 behavior rather
	// than inventing an expiry we cannot justify.
	expiresAt := githubTokenExpiry(s.now(), result.ExpiresIn)

	rows, err := casQueries.RotateOAuthAccountTokensCAS(ctx, db.RotateOAuthAccountTokensCASParams{
		AccessTokenEncrypted:     encryptedAccess,
		RefreshTokenEncrypted:    encryptedRefresh,
		ExpiresAt:                expiresAt,
		Provider:                 account.Provider,
		ProviderUserID:           account.ProviderUserID,
		OldAccessTokenEncrypted:  account.AccessTokenEncrypted,
		OldRefreshTokenEncrypted: account.RefreshTokenEncrypted,
	})
	if err != nil {
		// The refresh SUCCEEDED and consumed+rotated the single-use refresh token,
		// but the rotation could not be persisted — so the refresh chain is now DEAD
		// until the user re-connects (the next refresh sends the already-spent token
		// and fails). Let THIS request proceed with the new access token, but surface
		// the failed write loudly so the canary/alerting catches it.
		slog.Error("github oauth token refresh persist failed — refresh chain dead until re-auth",
			"user_id", account.UserID, "error", err)
	} else if rows == 0 {
		// Nobody matched our compare-and-swap. Two very different causes:
		//
		//  (a) a concurrent refresh WON and rotated the row — its access token is
		//      as good as ours, so use it (and do not fight over the row); or
		//  (b) a concurrent LOSER got bad_refresh_token for the token WE just
		//      consumed and cleared refresh_token_encrypted to NULL before our
		//      write landed. Access is then still the OLD ciphertext. Accepting
		//      that row would throw away the freshly minted refresh token and
		//      strand the account in "reconnect" with a perfectly healthy grant.
		//
		// Distinguish by the access column and, for (b), re-assert our pair.
		if healed, ok := s.healClearedRefreshRotation(ctx, account, encryptedAccess, encryptedRefresh, expiresAt); ok {
			return healed, nil
		}
		return s.currentOAuthAccessToken(ctx, account)
	}
	return newAccess, nil
}

// healClearedRefreshRotation repairs cause (b) above: our rotation lost its CAS
// only because a concurrent loser NULLed the refresh column, not because anyone
// published a newer access token. We hold the newest credential by construction
// (GitHub just minted it for us), so re-assert it keyed on the access column
// alone. Reports false when the row moved on for any other reason, leaving the
// caller's "use the winner's token" path intact.
func (s *AuthService) healClearedRefreshRotation(
	ctx context.Context,
	account db.OauthAccount,
	encryptedAccess, encryptedRefresh []byte,
	expiresAt pgtype.Timestamptz,
) (string, bool) {
	if len(encryptedRefresh) == 0 {
		return "", false
	}
	healQueries, ok := s.queries.(oauthAccountTokenHealQuerier)
	if !ok {
		return "", false
	}
	current, err := s.queries.GetOAuthAccountByProviderUserID(ctx, db.GetOAuthAccountByProviderUserIDParams{
		Provider:       account.Provider,
		ProviderUserID: account.ProviderUserID,
	})
	if err != nil {
		return "", false
	}
	// Someone published a different access token: they won fairly, defer to them.
	if !bytes.Equal(current.AccessTokenEncrypted, account.AccessTokenEncrypted) {
		return "", false
	}
	rows, err := healQueries.RotateOAuthAccountTokensByAccessCAS(ctx, db.RotateOAuthAccountTokensByAccessCASParams{
		AccessTokenEncrypted:    encryptedAccess,
		RefreshTokenEncrypted:   encryptedRefresh,
		ExpiresAt:               expiresAt,
		Provider:                account.Provider,
		ProviderUserID:          account.ProviderUserID,
		OldAccessTokenEncrypted: account.AccessTokenEncrypted,
	})
	if err != nil || rows == 0 {
		return "", false
	}
	slog.Warn("github oauth refresh rotation healed a concurrently-cleared refresh token",
		"user_id", account.UserID)
	token, err := s.DecryptOAuthAccessToken(encryptedAccess)
	if err != nil {
		return "", false
	}
	if token = strings.TrimSpace(token); token == "" {
		return "", false
	}
	return token, true
}

// githubTokenExpiry converts GitHub's expires_in (seconds) into an absolute
// timestamp. A non-positive value means GitHub did not tell us — represented as
// a NULL timestamptz, never a fabricated deadline.
func githubTokenExpiry(now time.Time, expiresIn int64) pgtype.Timestamptz {
	if expiresIn <= 0 {
		return pgtype.Timestamptz{}
	}
	return pgtype.Timestamptz{Time: now.Add(time.Duration(expiresIn) * time.Second).UTC(), Valid: true}
}

// githubAccessTokenNeedsRefresh reports whether a stored access token is close
// enough to its recorded expiry to renew BEFORE using it. Rows written before
// expiry was persisted carry a NULL expires_at and deliberately report false, so
// they keep today's reactive-on-401 behavior instead of refreshing blindly.
func githubAccessTokenNeedsRefresh(now time.Time, account db.OauthAccount) bool {
	if !account.ExpiresAt.Valid || account.ExpiresAt.Time.IsZero() {
		return false
	}
	if len(account.RefreshTokenEncrypted) == 0 {
		return false
	}
	return !now.Before(account.ExpiresAt.Time.Add(-githubTokenRefreshSkew))
}

// githubAccessTokenExpired reports whether the recorded expiry has actually
// passed (no skew). Inside the skew window the stored token still works, so a
// failed proactive refresh there must not be surfaced as an error.
func githubAccessTokenExpired(now time.Time, account db.OauthAccount) bool {
	if !account.ExpiresAt.Valid || account.ExpiresAt.Time.IsZero() {
		return false
	}
	return !now.Before(account.ExpiresAt.Time)
}

// RefreshUserGitHubTokenIfExpiring renews the account's access token BEFORE it is
// spent, when the persisted expiry says it is dead or nearly so, and returns the
// token the caller should actually use. This is what turns the ~8h expiry from a
// user-visible failure into a no-op: without it the first request after expiry
// always burns a doomed GitHub call, and any caller that cannot classify its
// failure as a 401 (notably `git clone` with the token in the credential env)
// simply fails.
//
// It is intentionally conservative. Accounts with no persisted expiry are left
// alone. A refresh that fails while the current token is still inside the skew
// window (i.e. not actually expired yet) keeps the existing token, because that
// token demonstrably still works and GitHub — not our clock — is the authority.
func (s *AuthService) RefreshUserGitHubTokenIfExpiring(ctx context.Context, account db.OauthAccount, currentToken string) (string, error) {
	if s == nil {
		return currentToken, nil
	}
	now := s.now()
	if !githubAccessTokenNeedsRefresh(now, account) {
		return currentToken, nil
	}
	refreshed, err := s.RefreshUserGitHubToken(ctx, account)
	if err != nil {
		if strings.TrimSpace(currentToken) != "" && !githubAccessTokenExpired(now, account) {
			return currentToken, nil
		}
		return "", err
	}
	return refreshed, nil
}

func hashOAuthStateVerifier(verifier string) string {
	sum := sha256.Sum256([]byte(strings.TrimSpace(verifier)))
	return hex.EncodeToString(sum[:])
}

func randomHex(bytesLen int) string {
	buf := make([]byte, bytesLen)
	if _, err := authRandRead(buf); err != nil {
		// A failed crypto/rand.Read means the system PRNG is broken.
		// Continuing with zeroed or partially-filled bytes would produce
		// predictable nonces, session keys, and OAuth state tokens — a
		// critical security vulnerability. Panic so the process is
		// restarted rather than silently issuing predictable credentials.
		panic(fmt.Sprintf("crypto/rand unavailable: %v", err))
	}
	return hex.EncodeToString(buf)
}

func randomUUID() string {
	buf := make([]byte, 16)
	if _, err := authRandRead(buf); err != nil {
		// Same rationale as randomHex: a broken PRNG must never produce
		// a predictable session key. Panic so the process restarts.
		panic(fmt.Sprintf("crypto/rand unavailable: %v", err))
	}

	buf[6] = (buf[6] & 0x0f) | 0x40
	buf[8] = (buf[8] & 0x3f) | 0x80

	return hex.EncodeToString(buf[0:4]) + "-" +
		hex.EncodeToString(buf[4:6]) + "-" +
		hex.EncodeToString(buf[6:8]) + "-" +
		hex.EncodeToString(buf[8:10]) + "-" +
		hex.EncodeToString(buf[10:16])
}
