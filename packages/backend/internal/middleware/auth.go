package middleware

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	stdErrors "errors"
	"log/slog"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/smithersai/smithers/packages/backend/internal/buildcache"
	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/identity"
	"github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

type contextKey string

// UserContextKey is the context key for storing the authenticated user.
// Exported for use in tests.
const UserContextKey contextKey = "user"

// UserFromContext retrieves the authenticated user from the request context.
// AuthInfo is the canonical auth context used by scope-aware middleware.
// The legacy UserContextKey fallback is kept for compatibility with handlers
// that still read only the user value directly.
func UserFromContext(ctx context.Context) *db.User {
	if authInfo := AuthInfoFromContext(ctx); authInfo != nil && authInfo.User != nil {
		return authInfo.User
	}
	u, _ := ctx.Value(UserContextKey).(*db.User)
	return u
}

// AuthLoaderQuerier defines the database operations needed by AuthLoader.
type AuthLoaderQuerier interface {
	GetAuthSessionBySessionKey(ctx context.Context, sessionKey string) (db.AuthSession, error)
	RefreshAuthSession(ctx context.Context, arg db.RefreshAuthSessionParams) (db.AuthSession, error)
	GetAuthInfoByTokenHash(ctx context.Context, tokenHash string) (db.GetAuthInfoByTokenHashRow, error)
	GetFirstPartyOAuth2AccessTokenByHash(ctx context.Context, tokenHash string) (db.Oauth2AccessToken, error)
	UpdateAccessTokenLastUsed(ctx context.Context, id int64) error
	GetUserByID(ctx context.Context, id int64) (db.User, error)
}

// workspaceHeadReportPath matches the one API route a workspace-restricted
// token may call: POST /api/repos/{owner}/{repo}/workspaces/{id}/head.
var workspaceHeadReportPath = regexp.MustCompile(`^/api/repos/[^/]+/[^/]+/workspaces/([^/]+)/head$`)

// workspaceChildrenPath and workspaceChildStopPath are the routes a
// workspace's children credential may call: list and spawn its children, and
// stop one of them.
var (
	workspaceChildrenPath  = regexp.MustCompile(`^/api/repos/[^/]+/[^/]+/workspaces/([^/]+)/children$`)
	workspaceChildStopPath = regexp.MustCompile(`^/api/repos/[^/]+/[^/]+/workspaces/([^/]+)/children/[^/]+/stop$`)
)

// allowWorkspaceRestrictedToken confines a workspace-bound token (RFD-004) to
// its own workspace: the head reporter's token to the head report route, and
// the children credential to the children routes. Git smart HTTP lives
// outside /api and applies its own ref policy. It writes the 403 itself and
// returns false when refused.
func allowWorkspaceRestrictedToken(w http.ResponseWriter, r *http.Request, info *AuthInfo) bool {
	workspaceID := info.WorkspaceRestriction()
	if workspaceID == "" || !strings.HasPrefix(r.URL.Path, "/api/") {
		return true
	}
	own := func(pattern *regexp.Regexp) bool {
		m := pattern.FindStringSubmatch(r.URL.Path)
		return m != nil && strings.EqualFold(m[1], workspaceID)
	}
	if ParseTokenWorkspaceChildrenCredential(info.RawScopes) {
		if ((r.Method == http.MethodGet || r.Method == http.MethodPost) && own(workspaceChildrenPath)) ||
			(r.Method == http.MethodPost && own(workspaceChildStopPath)) {
			return true
		}
		errors.WriteError(w, errors.Forbidden("workspace children credentials may only manage their own workspace's children"))
		return false
	}
	if r.Method == http.MethodPost && own(workspaceHeadReportPath) {
		return true
	}
	errors.WriteError(w, errors.Forbidden("workspace credentials may only report their own workspace head"))
	return false
}

// RequireAuth ensures a previous auth middleware attached a user to context.
func RequireAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if UserFromContext(r.Context()) == nil {
			errors.WriteError(w, errors.Unauthorized("authentication required"))
			return
		}
		next.ServeHTTP(w, r)
	})
}

// AuthLoader loads session/cookie or token auth information if available.
// Requests without a user credential, or with a session cookie that names no
// live session, continue anonymously. Presented user credentials with an
// unrecognized format or no matching token return 401. Route-specific LFS,
// Worker, OAuth client, and build-cache credentials pass to their own gates.
// Suspended users and, on the install, non-members return 403; a credential
// store outage returns 503.
func AuthLoader(queries AuthLoaderQuerier, cfg config.AuthConfig, boundaries ...identity.MemberAuthorizer) func(http.Handler) http.Handler {
	sessionCookieName := strings.TrimSpace(cfg.SessionCookieName)
	if sessionCookieName == "" {
		sessionCookieName = "smithers_session"
	}

	sessionDuration, err := time.ParseDuration(cfg.SessionDuration)
	if err != nil || sessionDuration <= 0 {
		sessionDuration = 720 * time.Hour
	}

	sessionRefreshWindow, err := time.ParseDuration(cfg.SessionRefreshWindow)
	if err != nil || sessionRefreshWindow < 0 {
		sessionRefreshWindow = 168 * time.Hour
	}

	cookieSecure := cfg.CookieSecure
	var memberBoundary identity.MemberAuthorizer
	if config.IsSingleOwner(cfg) {
		if len(boundaries) > 0 {
			memberBoundary = boundaries[0]
		} else if memberQueries, ok := queries.(identity.MemberQuerier); ok {
			memberBoundary = identity.NewMemberBoundary(memberQueries)
		} else {
			memberBoundary = identity.NewMemberBoundary(nil)
		}
	}

	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if authorizationDelegated(r, cfg.WorkerExchangeToken) {
				next.ServeHTTP(w, r)
				return
			}
			ctx := r.Context()
			now := time.Now().UTC()

			token := ExtractToken(r)
			if token == "" && len(r.Header.Values("Authorization")) > 0 {
				writeInvalidToken(w, "unrecognized token")
				return
			}
			if token != "" {
				authInfo, err := loadTokenAuth(ctx, queries, token)
				switch {
				case stdErrors.Is(err, errAccountSuspended):
					errors.WriteError(w, errors.Forbidden("account is suspended"))
					return
				case err != nil:
					writeAuthStoreUnavailable(w, r, "token_lookup", err)
					return
				case authInfo == nil:
					// A presented credential that resolves to nothing is a bad
					// credential, not an anonymous request: answering as anonymous
					// turns an expired token into 404s on private repositories.
					errors.WriteError(w, errors.Unauthorized("invalid or expired token"))
					return
				}
				if !authorizeInstallMember(w, r, authInfo, memberBoundary) {
					return
				}
				if !allowWorkspaceRestrictedToken(w, r, authInfo) {
					return
				}
				if authInfo.TokenSource == TokenSourcePersonalAccessToken {
					if err := queries.UpdateAccessTokenLastUsed(ctx, authInfo.TokenID); err != nil {
						recordAuthLoaderFailure(r, "token_last_used", err)
					}
				}
				next.ServeHTTP(w, r.WithContext(ContextWithAuthInfo(ctx, authInfo)))
				return
			}

			if cookie, err := r.Cookie(sessionCookieName); err == nil && cookie.Value != "" {
				authInfo, session, err := loadSessionAuth(ctx, queries, cookie.Value, now)
				if err != nil {
					writeAuthStoreUnavailable(w, r, "session_lookup", err)
					return
				}
				if authInfo != nil {
					if !authorizeInstallMember(w, r, authInfo, memberBoundary) {
						return
					}
					refreshedSession, sessionExpiresAt, refreshErr := refreshLoadedSession(ctx, queries, session, now, sessionDuration, sessionRefreshWindow)
					if refreshErr != nil {
						recordAuthLoaderFailure(r, "session_refresh", refreshErr)
					}
					if refreshedSession != nil {
						http.SetCookie(w, &http.Cookie{
							Name: sessionCookieName,
							// Refresh extends expiry only; re-set the RAW key the
							// client presented. The row's session_key is now a
							// storage digest (see sessionStorageKey), so echoing
							// refreshedSession.SessionKey here would log the user
							// out on their next request.
							Value:    cookie.Value,
							Path:     "/",
							HttpOnly: true,
							Secure:   cookieSecure,
							SameSite: http.SameSiteLaxMode,
							Expires:  refreshedSession.ExpiresAt,
							MaxAge:   int(time.Until(refreshedSession.ExpiresAt).Seconds()),
						})
						// The CSRF cookie must stay in lockstep with the session
						// cookie's lifetime, otherwise it silently expires first and
						// blocks every mutation for a still-logged-in user (#207).
						if token, err := NewCSRFToken(); err == nil {
							SetCSRFCookie(w, token, cookieSecure, refreshedSession.ExpiresAt)
						} else {
							slog.Error("failed to mint refreshed csrf token", "error", err)
						}
					} else if csrfCookie, err := r.Cookie(CSRFCookieName); err != nil || csrfCookie.Value == "" {
						// Self-heal: a valid session with no (or empty) CSRF cookie —
						// e.g. a persistent session cookie that outlived a
						// session-scoped CSRF cookie set before this fix — mints one
						// so the client can resume making mutating requests.
						if token, err := NewCSRFToken(); err == nil {
							SetCSRFCookie(w, token, cookieSecure, sessionExpiresAt)
						} else {
							slog.Error("failed to mint csrf token", "error", err)
						}
					}
					next.ServeHTTP(w, r.WithContext(ContextWithAuthInfo(ctx, authInfo)))
					return
				}
			}

			next.ServeHTTP(w, r)
		})
	}
}

var delegatedLFSAPIPath = regexp.MustCompile(`^/api/repos/[^/]+/[^/]+/lfs/(objects/batch|verify)$`)
var delegatedLFSGitPath = regexp.MustCompile(`^/[^/]+/[^/]+\.git/info/lfs/objects/batch$`)
var delegatedBuildCachePath = regexp.MustCompile(`^/api/repos/[^/]+/[^/]+/build-cache(/|$)`)

// authorizationDelegated preserves credentials that a later, route-specific
// gate verifies. Only these exact routes may bypass user-token parsing.
func authorizationDelegated(r *http.Request, workerExchangeToken string) bool {
	parts := strings.Fields(r.Header.Get("Authorization"))
	if len(parts) != 2 {
		return false
	}
	path := r.URL.Path
	switch strings.ToLower(parts[0]) {
	case "lfs":
		return delegatedLFSAPIPath.MatchString(path) || delegatedLFSGitPath.MatchString(path)
	case "basic":
		return path == "/api/oauth2/token" || path == "/api/oauth2/revoke"
	case "bearer":
		workerRoute := path == "/api/auth/github/token-exchange" || path == "/api/telemetry/errors"
		return (workerRoute && subtle.ConstantTimeCompare([]byte(parts[1]), []byte(workerExchangeToken)) == 1) ||
			(delegatedBuildCachePath.MatchString(path) && buildcache.IsReadToken(parts[1]))
	default:
		return false
	}
}

func writeInvalidToken(w http.ResponseWriter, message string) {
	w.Header().Set("WWW-Authenticate", `Bearer error="invalid_token"`)
	errors.WriteError(w, errors.New(errors.CodeInvalidToken, message))
}

func authorizeInstallMember(w http.ResponseWriter, r *http.Request, authInfo *AuthInfo, boundary identity.MemberAuthorizer) bool {
	if boundary == nil || authInfo == nil || authInfo.User == nil {
		return true
	}
	if err := boundary.AuthorizeMember(r.Context(), authInfo.User.ID); err != nil {
		errors.WriteError(w, err)
		return false
	}
	return true
}

// loadSessionAuth resolves a session cookie. It returns (nil, nil, nil) when
// the cookie names no live session, and a non-nil error only when the store
// could not answer, so the caller can tell a logged-out user from an outage.
func loadSessionAuth(
	ctx context.Context,
	queries AuthLoaderQuerier,
	sessionKey string,
	now time.Time,
) (*AuthInfo, *db.AuthSession, error) {
	// Sessions minted after keys were hashed at rest are filed under the
	// key's SHA-256 digest (see services.sessionStorageKey); rows minted
	// before stay raw-keyed until they expire. Try the digest first so the
	// steady-state cost is one lookup; only a miss there falls back to the
	// legacy raw key — a real database error never triggers a second query.
	session, err := queries.GetAuthSessionBySessionKey(ctx, sessionStorageKey(sessionKey))
	if err != nil {
		if !stdErrors.Is(err, pgx.ErrNoRows) {
			return nil, nil, err
		}
		// Never interpret a stored SHA-256 digest as a legacy bearer key.
		// Legacy keys are UUIDs; allowing the digest here makes hashing at
		// rest ineffective because a database dump can be used as cookies.
		if len(sessionKey) == sha256.Size*2 {
			if _, err := hex.DecodeString(sessionKey); err == nil {
				return nil, nil, nil
			}
		}
		session, err = queries.GetAuthSessionBySessionKey(ctx, sessionKey)
		if err != nil {
			if stdErrors.Is(err, pgx.ErrNoRows) {
				return nil, nil, nil
			}
			return nil, nil, err
		}
	}
	if !session.ExpiresAt.After(now) {
		return nil, nil, nil
	}

	user, err := queries.GetUserByID(ctx, session.UserID)
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return nil, nil, nil
		}
		return nil, nil, err
	}
	// Same "enabled" predicate as token auth and the
	// publish_user_access_change trigger.
	if !user.IsActive || user.ProhibitLogin || user.DeletedAt.Valid {
		return nil, nil, nil
	}

	return &AuthInfo{
		User:        &user,
		IsTokenAuth: false,
		SessionHash: sessionStorageKey(sessionKey),
		Scopes:      ScopeSet{},
	}, &session, nil
}

func refreshLoadedSession(
	ctx context.Context,
	queries AuthLoaderQuerier,
	session *db.AuthSession,
	now time.Time,
	sessionDuration time.Duration,
	sessionRefreshWindow time.Duration,
) (*db.AuthSession, time.Time, error) {
	if session == nil {
		return nil, time.Time{}, nil
	}
	effectiveExpiresAt := session.ExpiresAt
	if session.ExpiresAt.Sub(now) > sessionRefreshWindow {
		return nil, effectiveExpiresAt, nil
	}
	updated, err := queries.RefreshAuthSession(ctx, db.RefreshAuthSessionParams{
		SessionKey: session.SessionKey,
		ExpiresAt:  now.Add(sessionDuration),
	})
	if err != nil {
		return nil, effectiveExpiresAt, err
	}
	return &updated, updated.ExpiresAt, nil
}

func loadTokenAuth(ctx context.Context, queries AuthLoaderQuerier, token string) (*AuthInfo, error) {
	hash := sha256.Sum256([]byte(token))
	tokenHash := hex.EncodeToString(hash[:])
	return loadTokenAuthByHash(ctx, queries, tokenHash)
}

// sessionStorageKey derives the auth_sessions.session_key storage form of a
// raw session key. It mirrors services.sessionStorageKey; keep both in lockstep
// (middleware cannot import services, which already imports middleware).
func sessionStorageKey(rawSessionKey string) string {
	sum := sha256.Sum256([]byte(rawSessionKey))
	return hex.EncodeToString(sum[:])
}

// errAccountSuspended marks a credential that resolves to a user whose login
// is prohibited.
var errAccountSuspended = stdErrors.New("account is suspended")

// loadTokenAuthByHash resolves a token hash. It returns (nil, nil) when no
// live token matches, errAccountSuspended for a suspended owner, and any
// other error only when the store could not answer.
func loadTokenAuthByHash(ctx context.Context, queries AuthLoaderQuerier, tokenHash string) (*AuthInfo, error) {
	authRow, err := queries.GetAuthInfoByTokenHash(ctx, tokenHash)
	if err != nil {
		if !stdErrors.Is(err, pgx.ErrNoRows) {
			return nil, err
		}
		return loadOAuth2TokenAuth(ctx, queries, tokenHash)
	}

	user := authRowToUser(authRow)
	if user.ProhibitLogin {
		return nil, errAccountSuspended
	}

	return &AuthInfo{
		User:              &user,
		TokenID:           authRow.TokenID,
		TokenSystemIssued: authRow.TokenSystemIssued,
		TokenHash:         tokenHash,
		RawScopes:         authRow.TokenScopes,
		Scopes:            ParseTokenScopes(authRow.TokenScopes),
		IsTokenAuth:       true,
		TokenSource:       TokenSourcePersonalAccessToken,
	}, nil
}

func loadOAuth2TokenAuth(ctx context.Context, queries AuthLoaderQuerier, tokenHash string) (*AuthInfo, error) {
	info, err := loadOAuth2AccessToken(ctx, queries, tokenHash)
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	return info, nil
}

func loadOAuth2AccessToken(ctx context.Context, queries interface {
	GetFirstPartyOAuth2AccessTokenByHash(ctx context.Context, tokenHash string) (db.Oauth2AccessToken, error)
	GetUserByID(ctx context.Context, id int64) (db.User, error)
}, tokenHash string) (*AuthInfo, error) {
	token, err := queries.GetFirstPartyOAuth2AccessTokenByHash(ctx, tokenHash)
	if err != nil {
		return nil, err
	}

	user, err := queries.GetUserByID(ctx, token.UserID)
	if err != nil {
		return nil, err
	}
	if !user.IsActive || user.ProhibitLogin {
		return nil, pgx.ErrNoRows
	}

	rawScopes := strings.Join(token.Scopes, ",")
	return &AuthInfo{
		User:        &user,
		TokenID:     token.ID,
		TokenHash:   tokenHash,
		OAuth2AppID: token.AppID,
		RawScopes:   rawScopes,
		Scopes:      ParseTokenScopes(rawScopes),
		IsTokenAuth: true,
		TokenSource: TokenSourceOAuth2AccessToken,
	}, nil
}

// ExtractToken extracts the API token from the Authorization header.
// Query-string auth is intentionally unsupported so tokens never leak into
// request URLs, browser history, or intermediary logs.
func ExtractToken(r *http.Request) string {
	auth := r.Header.Get("Authorization")
	if auth != "" {
		parts := strings.Fields(auth)
		if len(parts) == 2 {
			switch strings.ToLower(parts[0]) {
			case "token", "bearer":
				if isValidTokenFormat(parts[1]) {
					return parts[1]
				}
			}
		}

		if username, password, ok := r.BasicAuth(); ok && username != "" && isValidTokenFormat(password) {
			return password
		}
	}

	return ""
}

func isValidTokenFormat(token string) bool {
	switch {
	case strings.HasPrefix(token, "smithers_flowhost_"):
		// Flow host model credentials are not user tokens.
		return false
	case strings.HasPrefix(token, "smithers_oat_"):
		return hasHexTail(strings.TrimPrefix(token, "smithers_oat_"), 64)
	case strings.HasPrefix(token, "smithers_"):
		return hasHexTail(strings.TrimPrefix(token, "smithers_"), 40)
	default:
		return false
	}
}

func hasHexTail(tail string, expectedLen int) bool {
	if len(tail) != expectedLen {
		return false
	}
	for _, ch := range tail {
		if (ch < '0' || ch > '9') && (ch < 'a' || ch > 'f') {
			return false
		}
	}
	return true
}

func authRowToUser(authRow db.GetAuthInfoByTokenHashRow) db.User {
	return db.User{
		ID:            authRow.ID,
		Username:      authRow.Username,
		LowerUsername: authRow.LowerUsername,
		Email:         authRow.Email,
		LowerEmail:    authRow.LowerEmail,
		DisplayName:   authRow.DisplayName,
		Bio:           authRow.Bio,
		AvatarUrl:     authRow.AvatarUrl,
		WalletAddress: authRow.WalletAddress,
		UserType:      authRow.UserType,
		IsActive:      authRow.IsActive,
		IsAdmin:       authRow.IsAdmin,
		ProhibitLogin: authRow.ProhibitLogin,
		DeletedAt:     authRow.DeletedAt,
		LastLoginAt:   authRow.LastLoginAt,
		CreatedAt:     authRow.CreatedAt,
		UpdatedAt:     authRow.UpdatedAt,
	}
}
