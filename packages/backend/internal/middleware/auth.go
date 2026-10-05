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

// terminalProfileRoutes are the routes a stage-1 terminal credential
// (TerminalProfileS1, spec §8.11.1) may call: its person's identity, the
// eligible reads, wiki reads, and the TODO doors whose handlers authorize
// the rest (services.Authorize): answer and steer on its own branch's TODO
// only, and todo.new, which a delegated credential confirms in the app.
// Every other route refuses it with 403 permission before any handler runs.
var terminalProfileRoutes = []struct {
	method string
	path   *regexp.Regexp
}{
	{http.MethodGet, regexp.MustCompile(`^/api/user$`)},
	{http.MethodGet, regexp.MustCompile(`^/api/user/repos$`)},
	{http.MethodGet, regexp.MustCompile(`^/api/todos(/[0-9]+)?$`)},
	{http.MethodPost, regexp.MustCompile(`^/api/todos(/[0-9]+(/answer)?)?$`)},
	{http.MethodGet, regexp.MustCompile(`^/api/repos/[^/]+/[^/]+$`)},
	{http.MethodGet, regexp.MustCompile(`^/api/repos/[^/]+/[^/]+/mythical(/events|/items/[^/]+)?$`)},
	{http.MethodGet, wikiReadPath},
}

// wikiReadPath is every wiki read: the page list, search, navigation, a
// page, its document, updates, revisions, history and stream.
var wikiReadPath = regexp.MustCompile(`^/api/repos/[^/]+/[^/]+/wiki(/[^/]+)*$`)

// allowTerminalProfileToken confines a stage-1 terminal credential to
// terminalProfileRoutes. It writes the 403 itself and returns false when
// refused.
func allowTerminalProfileToken(w http.ResponseWriter, r *http.Request, info *AuthInfo) bool {
	if _, ok := info.TerminalDelegation(); !ok {
		return true
	}
	for _, route := range terminalProfileRoutes {
		if route.method == r.Method && route.path.MatchString(r.URL.Path) {
			return true
		}
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusForbidden)
	_, _ = w.Write([]byte(`{"class":"permission","code":"permission","message":"A terminal's credential cannot do this"}` + "\n"))
	return false
}

// RequireAuth ensures a previous auth middleware attached a user to context.
// A request whose session cookie AuthLoader found dead is refused as a dead
// credential, not as one that carried none.
func RequireAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if UserFromContext(r.Context()) == nil {
			if carriedDeadSession(r.Context()) {
				writeDeadCredential(w)
				return
			}
			errors.WriteError(w, errors.Unauthorized("authentication required"))
			return
		}
		next.ServeHTTP(w, r)
	})
}

// deadSessionKey marks a request whose session cookie names no live session.
type deadSessionKey struct{}

func carriedDeadSession(ctx context.Context) bool {
	dead, _ := ctx.Value(deadSessionKey{}).(bool)
	return dead
}

// writeDeadCredential answers a request that carried a session cookie or
// bearer token the server no longer honours: unknown, expired, revoked, or
// held by a suspended or removed member (spec §5.2.1). It depends on the
// credential alone, so it reads the same for every resource.
func writeDeadCredential(w http.ResponseWriter) {
	errors.WriteError(w, errors.New(errors.CodeUnauthenticated, "Sign in again"))
}

// repositoryRoutePath matches every route that resolves a repository from
// its path: the API's /api/repos/{owner}/{repo} tree and the Git LFS batch
// alias. Anonymous callers get 404 there for a private repository, so a dead
// cookie must be refused before the repository is resolved, or its answer
// would tell an existing repository from a missing one.
var repositoryRoutePath = regexp.MustCompile(`^/api/repos/[^/]+/[^/]+(/|$)|^/[^/]+/[^/]+\.git/info/lfs/`)

// AuthLoader loads session/cookie or token auth information if available.
// Requests without a user credential continue anonymously. A presented
// bearer token that resolves to no live token returns 401 unauthenticated.
// A session cookie that names no live session (unknown, expired, signed out,
// or a suspended or removed member's) returns 401 unauthenticated on
// repository routes, before any repository lookup; elsewhere it continues
// anonymously, marked dead so RequireAuth refuses it the same way, which
// keeps sign-in and public pages working behind a stale cookie. A request
// carrying an SSE ticket is left to the ticket gate. Route-specific LFS,
// Worker, OAuth client, and build-cache credentials pass to their own gates.
// Suspended owners return 403; a credential store outage returns 503.
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
	var ownerBoundary identity.MemberAuthorizer
	if config.IsSingleOwner(cfg) {
		if len(boundaries) > 0 {
			ownerBoundary = boundaries[0]
		} else if ownerQueries, ok := queries.(identity.OwnerQuerier); ok {
			ownerBoundary = identity.NewMemberBoundary(ownerQueries)
		} else {
			ownerBoundary = identity.NewMemberBoundary(nil)
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
					writeDeadCredential(w)
					return
				}
				if !authorizeInstallationOwner(w, r, authInfo, ownerBoundary) {
					return
				}
				if !allowWorkspaceRestrictedToken(w, r, authInfo) {
					return
				}
				if !allowTerminalProfileToken(w, r, authInfo) {
					return
				}
				if _, delegated := authInfo.Delegation(); delegated {
					authInfo.ViaHint = r.Header.Get("Smithers-Via")
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
					if !authorizeInstallationOwner(w, r, authInfo, ownerBoundary) {
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
				// The cookie is not cleared: a late 401 would delete the fresh
				// cookie a concurrent sign-in just set, and sign-in overwrites
				// this one anyway.
				if r.URL.Query().Get("ticket") == "" && repositoryRoutePath.MatchString(r.URL.Path) {
					writeDeadCredential(w)
					return
				}
				r = r.WithContext(context.WithValue(ctx, deadSessionKey{}, true))
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

// installMemberRoutes are the routes a roster member may call on an
// install, each with the command it runs: the install authorizes that
// command by the person's role for every member request
// (services.Authorize; "self" is the person's own session). Every other
// route is the owner's alone, so a new route ships closed to members.
var installMemberRoutes = []struct {
	method, command string
	path            *regexp.Regexp
}{
	{http.MethodGet, "self", regexp.MustCompile(`^/api/user$`)},
	{http.MethodPost, "self", regexp.MustCompile(`^/api/auth/logout$`)},
	// The app's reads on an install, as a member's browser makes them on
	// J1 8, J2 and J4: setup state, the person's own organizations and
	// workspaces, the repository and its stack, the GitHub sync, the live
	// channel and the app's error reports.
	{http.MethodGet, "install.read", regexp.MustCompile(`^/api/install$`)},
	{http.MethodGet, "self.read", regexp.MustCompile(`^/api/user/(orgs|workspaces)$`)},
	{http.MethodGet, "repo.read", regexp.MustCompile(`^/api/user/repos$`)},
	{http.MethodGet, "repo.read", regexp.MustCompile(`^/api/repos/[^/]+/[^/]+/mythical(/events|/items/[^/]+)?$`)},
	{http.MethodGet, "wiki.read", wikiReadPath},
	{http.MethodGet, "sync.read", regexp.MustCompile(`^/api/github/sync$`)},
	{http.MethodPost, "sync.retry", regexp.MustCompile(`^/api/github/sync$`)},
	{http.MethodGet, "live", regexp.MustCompile(`^/api/live$`)},
	{http.MethodPost, "telemetry.report", regexp.MustCompile(`^/api/telemetry/errors$`)},
	// The app agent answers a member as that member, in their own
	// conversations.
	{http.MethodPost, "agent.turn", regexp.MustCompile(`^/api/agent/turn(/cancel|/replay|/retire)?$`)},
	{http.MethodGet, "agent.turn", regexp.MustCompile(`^/api/agent/conversations$`)},
	{http.MethodPost, "agent.turn", regexp.MustCompile(`^/api/agent/conversations/replay$`)},
	// The issue list card and the issue card (J2 1 and 2).
	{http.MethodGet, "issue.read", regexp.MustCompile(`^/api/issues$`)},
	{http.MethodGet, "issue.read", regexp.MustCompile(`^/api/issues/[0-9]+$`)},
	{http.MethodGet, "todo.read", regexp.MustCompile(`^/api/todos$`)},
	{http.MethodGet, "todo.read", regexp.MustCompile(`^/api/todos/[0-9]+$`)},
	{http.MethodPost, "todo.new", regexp.MustCompile(`^/api/todos$`)},
	{http.MethodPost, "todo.control", regexp.MustCompile(`^/api/todos/[0-9]+$`)},
	{http.MethodPatch, "todo.amend", regexp.MustCompile(`^/api/todos/[0-9]+$`)},
	{http.MethodPost, "todo.answer", regexp.MustCompile(`^/api/todos/[0-9]+/answer$`)},
	{http.MethodPost, "merge", regexp.MustCompile(`^/api/todos/[0-9]+/merge$`)},
	{http.MethodGet, "flows.read", regexp.MustCompile(`^/api/flows$`)},
	{http.MethodGet, "branches.read", regexp.MustCompile(`^/api/branches(/[^/]+)?$`)},
	{http.MethodPost, "branch.fork", regexp.MustCompile(`^/api/branches$`)},
	{http.MethodGet, "members.list", regexp.MustCompile(`^/api/members$`)},
	{http.MethodPost, "members.write", regexp.MustCompile(`^/api/members$`)},
	{http.MethodPatch, "members.write", regexp.MustCompile(`^/api/members/[^/]+$`)},
	{http.MethodDelete, "members.write", regexp.MustCompile(`^/api/members/[^/]+$`)},
	// Maintainers add, replace and delete the repository's secrets
	// (mvp.md §6.15, M-05; spec §5.2): a person-only command, so the
	// owner's delegated credentials are refused here too. Org secrets stay
	// the owner's.
	{http.MethodPost, "secrets.write", regexp.MustCompile(`^/api/repos/[^/]+/[^/]+/secrets$`)},
	{http.MethodPatch, "secrets.write", regexp.MustCompile(`^/api/repos/[^/]+/[^/]+/secrets/[^/]+$`)},
	{http.MethodDelete, "secrets.write", regexp.MustCompile(`^/api/repos/[^/]+/[^/]+/secrets/[^/]+$`)},
}

// InstallMemberCommand is the command a roster member's request to method
// and path runs, or "" for a route only the install owner may call.
func InstallMemberCommand(method, path string) string {
	for _, route := range installMemberRoutes {
		if route.method == method && route.path.MatchString(path) {
			return route.command
		}
	}
	return ""
}

func authorizeInstallationOwner(w http.ResponseWriter, r *http.Request, authInfo *AuthInfo, boundary identity.MemberAuthorizer) bool {
	if boundary == nil || authInfo == nil || authInfo.User == nil {
		return true
	}
	ctx := r.Context()
	// GitHub returns the browser to /setup/github/* before the repository step
	// verifies the owner, so those returns are setup routes too.
	if r.URL.Path == "/api/install" || strings.HasPrefix(r.URL.Path, "/api/install/setup/") || strings.HasPrefix(r.URL.Path, "/api/github-app/") || r.URL.Path == "/api/auth/github" || r.URL.Path == "/api/auth/github/callback" || r.URL.Path == "/api/auth/logout" || r.URL.Path == "/setup/github/callback" || r.URL.Path == "/setup/github/installed" {
		ctx = identity.WithSetupScope(ctx)
	}
	if InstallMemberCommand(r.Method, r.URL.Path) != "" {
		ctx = identity.WithMemberRoute(ctx)
	}
	if err := boundary.AuthorizeMember(ctx, authInfo.User.ID); err != nil {
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
	info, err := sessionAuthInfo(ctx, queries, session, sessionStorageKey(sessionKey), now)
	if info == nil || err != nil {
		return nil, nil, err
	}
	return info, &session, nil
}

// sessionAuthInfo is a found session's authentication: nil when it has
// expired or its account is not enabled, an error only when the store could
// not answer.
func sessionAuthInfo(ctx context.Context, queries AuthLoaderQuerier, session db.AuthSession, storageKey string, now time.Time) (*AuthInfo, error) {
	if !session.ExpiresAt.After(now) {
		return nil, nil
	}
	user, err := queries.GetUserByID(ctx, session.UserID)
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	// Same "enabled" predicate as token auth and the
	// publish_user_access_change trigger.
	if !user.IsActive || user.ProhibitLogin || user.DeletedAt.Valid {
		return nil, nil
	}
	return &AuthInfo{
		User:        &user,
		IsTokenAuth: false,
		SessionHash: storageKey,
		Scopes:      ScopeSet{},
	}, nil
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
