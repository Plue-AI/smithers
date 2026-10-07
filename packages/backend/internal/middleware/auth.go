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
func allowWorkspaceRestrictedToken(w http.ResponseWriter, r *http.Request, info *AuthInfo, install ...bool) bool {
	refuse := func(message string) {
		verdict := errors.Forbidden(message)
		if len(install) > 0 && install[0] {
			verdict = errors.New(errors.CodePermission, message)
		}
		errors.WriteError(w, verdict)
	}
	workspaceID := info.WorkspaceRestriction()
	if workspaceID == "" || !strings.HasPrefix(r.URL.Path, "/api/") {
		return true
	}
	own := func(pattern *regexp.Regexp) bool {
		m := pattern.FindStringSubmatch(r.URL.Path)
		return m != nil && strings.EqualFold(m[1], workspaceID)
	}
	// Install commands resolve their stored subject in Authorize. The hosted
	// route guards below remain for hosted callers and unmapped protocol doors;
	// they must not make a second install command-policy decision.
	if len(install) > 0 && install[0] {
		command := InstallMemberCommand(r.Method, r.URL.EscapedPath())
		if command != "" && command != "self" && command != "public" {
			return true
		}
	}
	if ParseTokenWorkspaceChildrenCredential(info.RawScopes) {
		if ((r.Method == http.MethodGet || r.Method == http.MethodPost) && own(workspaceChildrenPath)) ||
			(r.Method == http.MethodPost && own(workspaceChildStopPath)) {
			return true
		}
		refuse("workspace children credentials may only manage their own workspace's children")
		return false
	}
	if r.Method == http.MethodPost && own(workspaceHeadReportPath) {
		return true
	}
	refuse("workspace credentials may only report their own workspace head")
	return false
}

// terminalProfileRoutes are the routes a stage-1 terminal credential
// (TerminalProfileS1, spec §8.11.1) may call: its person's identity, the
// eligible reads, wiki reads, and the TODO doors whose handlers authorize
// the rest (services.Authorize): answer and steer on its own branch's TODO
// only, and new/amend requests, which require confirmation in the app.
// Every other route refuses it with 403 permission before any handler runs.
var terminalProfileRoutes = []struct {
	method string
	path   *regexp.Regexp
}{
	// The person-only scorecard policy supplies the typed never/permission refusal.
	{http.MethodGet, regexp.MustCompile(`^/api/install/scorecard$`)},
	{http.MethodGet, regexp.MustCompile(`^/api/user$`)},
	{http.MethodGet, regexp.MustCompile(`^/api/user/repos$`)},
	{http.MethodGet, regexp.MustCompile(`^/api/stack$`)},
	{http.MethodGet, regexp.MustCompile(`^/api/todos(/[0-9]+(/events|/attempts/[0-9]+/logs/[0-9a-f]{64})?)?$`)},
	{http.MethodPost, regexp.MustCompile(`^/api/todos(/[0-9]+(/answer)?)?$`)},
	{http.MethodPatch, regexp.MustCompile(`^/api/todos/[0-9]+$`)},
	{http.MethodGet, regexp.MustCompile(`^/api/repos/[^/]+/[^/]+$`)},
	{http.MethodGet, regexp.MustCompile(`^/api/repos/[^/]+/[^/]+/mythical(/events|/items/[^/]+)?$`)},
	{http.MethodGet, wikiReadPath},
	{http.MethodGet, regexp.MustCompile(`^/api/branches/[^/]+/files(/.*)?$`)},
	{http.MethodGet, regexp.MustCompile(`^/api/branches/[^/]+$`)},
	{http.MethodGet, regexp.MustCompile(`^/api/branches/[^/]+/diff$`)},
	{http.MethodGet, regexp.MustCompile(`^/api/repos/[^/]+/[^/]+/workspaces/[^/]+/files(/content)?$`)},
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

// CarriedDeadCredential reports whether the request presented a session
// cookie AuthLoader found dead and let continue anonymously.
func CarriedDeadCredential(ctx context.Context) bool { return carriedDeadSession(ctx) }

// UnauthenticatedMessage is the message of a 401 unauthenticated refusal
// for the request: "Sign in again" when it presented a session cookie
// AuthLoader found dead (spec §5.2.1a), so every refusal of a dead
// credential reads the same wherever it is written; "Sign in" when it
// presented no credential.
func UnauthenticatedMessage(ctx context.Context) string {
	if carriedDeadSession(ctx) {
		return deadCredentialMessage
	}
	return "Sign in"
}

const deadCredentialMessage = "Sign in again"

// writeDeadCredential answers a request that carried a session cookie or
// bearer token the server no longer honours: unknown, expired, revoked, or
// held by a suspended or removed member (spec §5.2.1). It depends on the
// credential alone, so it reads the same for every resource.
func writeDeadCredential(w http.ResponseWriter) {
	errors.WriteError(w, errors.New(errors.CodeUnauthenticated, deadCredentialMessage))
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
			cookieSecure := cfg.CookieSecure
			if origin, ok := EffectiveOriginFromContext(r.Context()); ok {
				cookieSecure = strings.HasPrefix(origin, "https://")
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
					if config.IsSingleOwner(cfg) {
						writeDeadCredential(w)
						return
					}
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
				if config.IsSingleOwner(cfg) && !BindInstallCredential(authInfo) {
					writeDeadCredential(w)
					return
				}
				if !authorizeInstallationOwner(w, r, authInfo, ownerBoundary) {
					return
				}
				if !allowWorkspaceRestrictedToken(w, r, authInfo, config.IsSingleOwner(cfg)) {
					return
				}
				if !allowTerminalProfileToken(w, r, authInfo) {
					return
				}
				if !allowCodingFileCredential(w, r, authInfo) {
					return
				}
				if _, delegated := authInfo.Delegation(); delegated {
					authInfo.ViaHint = r.Header.Get("Smithers-Via")
				}
				// Scorecard is person-session only; rejected reads mutate no token row.
				if authInfo.TokenSource == TokenSourcePersonalAccessToken && InstallMemberCommand(r.Method, r.URL.EscapedPath()) != "install.scorecard" {
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
					// Scorecard reads (including policy refusals) never renew a session.
					var refreshedSession *db.AuthSession
					sessionExpiresAt := session.ExpiresAt
					var refreshErr error
					if InstallMemberCommand(r.Method, r.URL.EscapedPath()) != "install.scorecard" {
						refreshedSession, sessionExpiresAt, refreshErr = refreshLoadedSession(ctx, queries, session, now, sessionDuration, sessionRefreshWindow)
					}
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
							SetCSRFCookie(w, token, cookieSecure, refreshedSession.ExpiresAt, csrfSameSite(r))
						} else {
							slog.Error("failed to mint refreshed csrf token", "error", err)
						}
					} else if csrfCookie, err := r.Cookie(CSRFCookieName); err != nil || csrfCookie.Value == "" {
						// Self-heal: a valid session with no (or empty) CSRF cookie —
						// e.g. a persistent session cookie that outlived a
						// session-scoped CSRF cookie set before this fix — mints one
						// so the client can resume making mutating requests.
						if token, err := NewCSRFToken(); err == nil {
							SetCSRFCookie(w, token, cookieSecure, sessionExpiresAt, csrfSameSite(r))
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
	{http.MethodGet, "approvals.list", regexp.MustCompile(`^/api/repos/[^/]+/[^/]+/approvals$`)},
	{http.MethodGet, "approvals.list", regexp.MustCompile(`^/api/repos/[^/]+/[^/]+/approvals/[^/]+$`)},
	{http.MethodPost, "approval.decide", regexp.MustCompile(`^/api/repos/[^/]+/[^/]+/approvals/[^/]+/decide$`)},
	{http.MethodPut, "settings", regexp.MustCompile(`^/api/install$`)},
	{http.MethodPost, "settings", regexp.MustCompile(`^/api/install/quiesce$`)},
	{http.MethodDelete, "settings", regexp.MustCompile(`^/api/install/quiesce$`)},
	{http.MethodGet, "install.read", regexp.MustCompile(`^/api/install/metrics$`)},
	{http.MethodPut, "model.assign", regexp.MustCompile(`^/api/model/default$`)},
	{http.MethodGet, "settings", regexp.MustCompile(`^/api/repo-connection$`)},
	{http.MethodPost, "settings", regexp.MustCompile(`^/api/repo-connection$`)},
	{http.MethodDelete, "settings", regexp.MustCompile(`^/api/repo-connection$`)},
	{http.MethodPost, "terminal", regexp.MustCompile(`^/api/terminals$`)},
	// Non-command authentication and bootstrap protocols retain their own
	// proof checks; declaring public here does not bypass the credential loader.
	{http.MethodGet, "public", regexp.MustCompile(`^/api/(?:health|feature-flags|meta/failure-codes|bootstrap|build-cache/healthz)$`)},
	{http.MethodHead, "public", regexp.MustCompile(`^/api/(?:bootstrap|build-cache/healthz)$`)},
	{http.MethodGet, "public", regexp.MustCompile(`^/api/auth/(?:github(?:/callback|/cli(?:/consent)?)?|auth0/(?:authorize|callback))$`)},
	{http.MethodPost, "public", regexp.MustCompile(`^/api/auth/github/(?:cli/consent|token-exchange)$`)},
	{http.MethodGet, "public", regexp.MustCompile(`^/api/oauth2/authorize$`)},
	{http.MethodPost, "public", regexp.MustCompile(`^/api/oauth2/(?:authorize|token|revoke)$`)},
	{http.MethodGet, "public", regexp.MustCompile(`^/api/user/emails/verify-token$`)},
	{http.MethodPost, "public", regexp.MustCompile(`^/api/user/emails/verify-token$`)},
	// Retained repository aliases use the same literal read command as the
	// numbered issue door. Execution credentials have no list-all grant.
	{http.MethodGet, "issue.read", regexp.MustCompile(`^/api/repos/[^/]+/[^/]+/(?:issue-views|labels(?:/[^/]+)?|issues(?:/state-events(?:/stream)?|/[0-9]+(?:/comments|/labels|/events)?)?)$`)},
	{http.MethodGet, "repo.read", regexp.MustCompile(`^/api/repos/[^/]+/[^/]+(?:/home|/topics)?$`)},
	{http.MethodGet, "repo.read", regexp.MustCompile(`^/api/repos/[^/]+/[^/]+/caches(?:/stats)?$`)},
	{http.MethodGet, "run.view", regexp.MustCompile(`^/api/repos/[^/]+/[^/]+/workflow/runs/[0-9]+/artifacts(?:/[^/]+)?$`)},
	{http.MethodGet, "repo.read", regexp.MustCompile(`^/api/user/workflow-runs/active-count$`)},
	{http.MethodGet, "public", regexp.MustCompile(`^/api/public/repos$`)},
	{http.MethodGet, "run.view", regexp.MustCompile(`^/api/repos/[^/]+/[^/]+/(?:actions/)?runs/[0-9]+/artifacts(?:/[^/]+/download)?$`)},
	{http.MethodGet, "external.read", regexp.MustCompile(`^/api/external/sessions$`)},
	{http.MethodGet, "runs.list", regexp.MustCompile(`^/api/repos/[^/]+/[^/]+/agent/sessions$`)},
	{http.MethodGet, "run.view", regexp.MustCompile(`^/api/repos/[^/]+/[^/]+/agent/sessions/[^/]+$`)},
	{http.MethodGet, "runs.events", regexp.MustCompile(`^/api/repos/[^/]+/[^/]+/agent/sessions/[^/]+/messages$`)},
	// The relay resolves its body command before workspace lookup or dispatch.
	{http.MethodPost, "flow.relay", regexp.MustCompile(`^/api/workflow/rpc$`)},
	{http.MethodPost, "box.resume", regexp.MustCompile(`^/api/workflow/provision$`)},
	{http.MethodPost, "order.ok", regexp.MustCompile(`^/api/stack/attention/[^/]+$`)},
	{http.MethodGet, "public", regexp.MustCompile(`^/api/status$`)},
	{http.MethodGet, "install.read", regexp.MustCompile(`^/api/admin/system/health$`)},
	{http.MethodGet, "terminal.watch", regexp.MustCompile(`^/api/repos/[^/]+/[^/]+/workspace/sessions/[^/]+/terminal$`)},
	{http.MethodGet, "self", regexp.MustCompile(`^/api/user$`)},
	{http.MethodGet, "self.read", regexp.MustCompile(`^/api/notifications(?:/(?:list|events(?:/stream)?|preferences))?$`)},
	{http.MethodGet, "self.read", regexp.MustCompile(`^/api/user/(?:emails|connections|settings/(?:notifications|signup))$`)},
	{http.MethodGet, "self.read", regexp.MustCompile(`^/api/users/[^/]+(?:/(?:activity|repos))?$`)},
	{http.MethodGet, "self.read", regexp.MustCompile(`^/api/user/keys(?:/[0-9]+)?$`)},
	{http.MethodGet, "self", regexp.MustCompile(`^/api/confirmations$`)},
	{http.MethodPost, "self", regexp.MustCompile(`^/api/confirmations(?:/[^/]+/(?:approve|deny))?$`)},
	{http.MethodPost, "self", regexp.MustCompile(`^/api/auth/logout$`)},
	{http.MethodPost, "self", regexp.MustCompile(`^/api/user/tokens$`)},
	{http.MethodPost, "self", regexp.MustCompile(`^/api/user/keys$`)},
	{http.MethodDelete, "self", regexp.MustCompile(`^/api/user/keys/[0-9]+$`)},
	{http.MethodGet, "self", regexp.MustCompile(`^/api/user/(tokens|sessions)$`)},
	{http.MethodDelete, "self", regexp.MustCompile(`^/api/user/(tokens|sessions)/[^/]+$`)},
	{http.MethodPost, "self.read", regexp.MustCompile(`^/api/(auth/sse-ticket|v1/sse/ticket)$`)},
	// The app's reads on an install, as a member's browser makes them on
	// J1 8, J2 and J4: setup state, the person's own organizations and
	// workspaces, the repository and its stack, the GitHub sync, the live
	// channel and the app's error reports.
	{http.MethodGet, "install.read", regexp.MustCompile(`^/api/install$`)},
	{http.MethodPost, "settings.setup", regexp.MustCompile(`^/api/install/setup/(address|app|sign_in|repository|models|source|machine)$`)},
	{http.MethodGet, "install.scorecard", regexp.MustCompile(`^/api/install/scorecard$`)},
	{http.MethodGet, "agents.read", regexp.MustCompile(`^/api/agents(?:/[^/]+)?$`)},
	{http.MethodGet, "agents.read", regexp.MustCompile(`^/api/model/(catalog|default)$`)},
	{http.MethodPost, "settings.model-key", regexp.MustCompile(`^/api/model/credential$`)},
	{http.MethodGet, "settings.model-key", regexp.MustCompile(`^/api/model/credential/receipt$`)},
	{http.MethodPost, "model.test", regexp.MustCompile(`^/api/model/test$`)},
	{http.MethodPut, "model.assign", regexp.MustCompile(`^/api/agents/[^/]+/model$`)},
	{http.MethodGet, "self.read", regexp.MustCompile(`^/api/user/(orgs|workspaces)$`)},
	{http.MethodGet, "repo.read", regexp.MustCompile(`^/api/user/(?:repos|readable-repos)$`)},
	{http.MethodGet, "repo.read", regexp.MustCompile(`^/api/repos/[^/]+/[^/]+/mythical(/events|/items/[^/]+)?$`)},
	{http.MethodGet, "wiki.read", wikiReadPath},
	{http.MethodPost, "wiki.create", regexp.MustCompile(`^/api/repos/[^/]+/[^/]+/wiki$`)},
	{http.MethodPatch, "wiki.edit", regexp.MustCompile(`^/api/repos/[^/]+/[^/]+/wiki/[^/]+$`)},
	{http.MethodPut, "wiki.edit", regexp.MustCompile(`^/api/repos/[^/]+/[^/]+/wiki/attachments/[^/]+$`)},
	{http.MethodDelete, "wiki.delete", regexp.MustCompile(`^/api/repos/[^/]+/[^/]+/wiki/[^/]+$`)},
	// Retained PR history uses the catalog view commands.
	{http.MethodGet, "prs.list", regexp.MustCompile(`^/api/repos/[^/]+/[^/]+/landings$`)},
	{http.MethodGet, "prs.view", regexp.MustCompile(`^/api/repos/[^/]+/[^/]+/landings/[0-9]+(?:/(?:changes|comments|conflicts|reviews|diff))?$`)},
	// Retained repository history reads are the same catalog repository read.
	// Their commit selectors are not a bound execution branch: run and machine
	// credentials must use the separately scoped branch/file doors.
	{http.MethodGet, "repo.read", regexp.MustCompile(`^/api/repos/[^/]+/[^/]+/(?:bookmarks|changes(?:/count|/[^/]+(?:/(?:walkthrough|findings|diff|files|conflicts|operations))?)?|operations|status)$`)},
	{http.MethodGet, "repo.read", regexp.MustCompile(`^/api/repos/[^/]+/[^/]+/(?:user-refs|lfs/objects|commits/[^/]+/statuses)$`)},
	{http.MethodGet, "repo.read", regexp.MustCompile(`^/api/repos/[^/]+/[^/]+/file/[^/]+/.+$`)},
	{http.MethodGet, "repo.read", regexp.MustCompile(`^/api/repos/[^/]+/[^/]+/(?:git/refs|contents(?:/.+)?)$`)},
	// Existing persisted coding-run messages remain readable by repository members.
	{http.MethodGet, "repo.read", regexp.MustCompile(`^/api/repos/[^/]+/[^/]+/agent/sessions/[^/]+/stream$`)},
	{http.MethodGet, "sync.read", regexp.MustCompile(`^/api/github/sync$`)},
	{http.MethodPost, "sync.retry", regexp.MustCompile(`^/api/github/sync$`)},
	{http.MethodGet, "live", regexp.MustCompile(`^/api/live$`)},
	{http.MethodPost, "telemetry.report", regexp.MustCompile(`^/api/telemetry/errors$`)},
	// The app agent answers a member as that member, in their own
	// conversations.
	{http.MethodPost, "agent.turn", regexp.MustCompile(`^/api/agent/turn(/replay)?$`)},
	// Tool-free issue drafting uses the same packaged model host and member gate.
	{http.MethodPost, "agent.turn", regexp.MustCompile(`^/api/model/stream$`)},
	{http.MethodGet, "agent.turn", regexp.MustCompile(`^/api/agent/conversations$`)},
	{http.MethodGet, "agent.turn", regexp.MustCompile(`^/api/conversations/[^/]+$`)},
	{http.MethodPost, "agent.turn", regexp.MustCompile(`^/api/conversations/[^/]+/prompt$`)},
	{http.MethodPost, "agent.turn", regexp.MustCompile(`^/api/conversations/[^/]+/turns/[^/]+/stop$`)},
	{http.MethodPatch, "agent.turn", regexp.MustCompile(`^/api/conversations/[^/]+/turns/[^/]+$`)},
	{http.MethodDelete, "agent.turn", regexp.MustCompile(`^/api/conversations/[^/]+/turns/[^/]+$`)},
	{http.MethodGet, "agent.turn", regexp.MustCompile(`^/api/conversations/[^/]+/view-state$`)},
	{http.MethodPut, "agent.turn", regexp.MustCompile(`^/api/conversations/[^/]+/view-state$`)},
	{http.MethodPost, "agent.turn", regexp.MustCompile(`^/api/agent/conversations/replay$`)},
	{http.MethodGet, "search", regexp.MustCompile(`^/api/search/(repositories|issues|users|code)$`)},
	// The issue list card and the issue card (J2 1 and 2).
	{http.MethodGet, "issue.read", regexp.MustCompile(`^/api/issues$`)},
	{http.MethodPost, "review", regexp.MustCompile(`^/api/reviews$`)},
	{http.MethodGet, "repo.read", regexp.MustCompile(`^/api/reviews/[^/]+$`)},
	{http.MethodGet, "issue.read", regexp.MustCompile(`^/api/issues/[0-9]+$`)},
	{http.MethodGet, "todo.read", regexp.MustCompile(`^/api/(todos|stack)$`)},
	{http.MethodGet, "todo.read", regexp.MustCompile(`^/api/todos/[0-9]+(/events|/attempts/[0-9]+/logs/[0-9a-f]{64})?$`)},
	{http.MethodPost, "todo.new", regexp.MustCompile(`^/api/todos$`)},
	{http.MethodPost, "todo.control", regexp.MustCompile(`^/api/todos/[0-9]+$`)},
	{http.MethodPatch, "todo.amend", regexp.MustCompile(`^/api/todos/[0-9]+$`)},
	{http.MethodPost, "todo.answer", regexp.MustCompile(`^/api/todos/[0-9]+/answer$`)},
	{http.MethodPost, "todo.preapprove", regexp.MustCompile(`^/api/todos/[0-9]+/preapproval$`)},
	{http.MethodDelete, "todo.unapprove", regexp.MustCompile(`^/api/todos/[0-9]+/preapproval$`)},
	{http.MethodPost, "merge", regexp.MustCompile(`^/api/todos/[^/]+/merge$`)},
	{http.MethodPost, "merge", regexp.MustCompile(`^/api/repos/[^/]+/[^/]+/mythical/items/[^/]+/merge$`)},
	{http.MethodGet, "proposals.read", regexp.MustCompile(`^/api/proposals$`)},
	{http.MethodPost, "learning.accept", regexp.MustCompile(`^/api/proposals/[^/]+/accept$`)},
	{http.MethodPost, "learning.dismiss", regexp.MustCompile(`^/api/proposals/[^/]+/dismiss$`)},
	{http.MethodGet, "flows.read", regexp.MustCompile(`^/api/flows(/[^/]+|/runs/[^/]+)?$`)},
	{http.MethodPost, "flow.run", regexp.MustCompile(`^/api/flows(/[^/]+/run)?$`)},
	{http.MethodPost, "background.retry", regexp.MustCompile(`^/api/runs/[0-9]+$`)},
	{http.MethodGet, "flows.read", regexp.MustCompile(`^/api/runs/[0-9]+/background-status$`)},
	{http.MethodPost, "agent.edit", regexp.MustCompile(`^/api/agents/[^/]+/edit$`)},
	{http.MethodPost, "flow.edit", regexp.MustCompile(`^/api/flows/[^/]+/edit$`)},
	{http.MethodGet, "branch.read", regexp.MustCompile(`^/api/branches/[^/]+/files/.+$`)},
	{http.MethodPost, "file.restore", regexp.MustCompile(`^/api/branches/[^/]+/files/.+$`)},
	{http.MethodGet, "repo.read", regexp.MustCompile(`^/api/repos/[^/]+/[^/]+/workspace-snapshots(?:/[^/]+)?$`)},
	{http.MethodGet, "branches.read", regexp.MustCompile(`^/api/repos/[^/]+/[^/]+/workspaces$`)},
	{http.MethodGet, "branches.read", regexp.MustCompile(`^/api/branches$`)},
	{http.MethodGet, "ssh", regexp.MustCompile(`^/api/ssh$`)},
	{http.MethodGet, "ssh", regexp.MustCompile(`^/api/repos/[^/]+/[^/]+/(workspaces|workspace/sessions)/[^/]+/ssh$`)},
	{http.MethodGet, "branch.read", regexp.MustCompile(`^/api/branches/[^/]+$`)},
	// The body resolves bring-in or discard-foreign before the shared decision.
	{http.MethodPost, "branch.control", regexp.MustCompile(`^/api/branches/[^/]+$`)},
	{http.MethodGet, "branch.read", regexp.MustCompile(`^/api/branches/[^/]+/diff$`)},
	{http.MethodGet, "branch.read", regexp.MustCompile(`^/api/branches/[^/]+/files$`)},
	{http.MethodGet, "branch.read", regexp.MustCompile(`^/api/repos/[^/]+/[^/]+/workspaces/[^/]+/files(/content)?$`)},
	{http.MethodGet, "branch.read", regexp.MustCompile(`^/api/repos/[^/]+/[^/]+/workspaces/[^/]+$`)},
	// File co-edit has its own actor policy; the service binds the validated batch.
	{http.MethodPut, "flow.source-coedit", regexp.MustCompile(`^/api/repos/[^/]+/[^/]+/workspaces/[^/]+/files/content$`)},
	{http.MethodPost, "branch.fork", regexp.MustCompile(`^/api/branches$`)},
	{http.MethodPost, "branch.add-to-stack", regexp.MustCompile(`^/api/branches/[^/]+/add-to-stack$`)},
	{http.MethodPost, "branch.join", regexp.MustCompile(`^/api/repos/[^/]+/[^/]+/workspaces$`)},
	// All retained workflow aliases resolve the same concrete catalog action.
	{http.MethodGet, "flows.read", regexp.MustCompile(`^/api/repos/[^/]+/[^/]+/workflows(?:/[0-9]+)?$`)},
	{http.MethodGet, "runs.list", regexp.MustCompile(`^/api/repos/[^/]+/[^/]+/(?:workflows/[0-9]+/runs|(?:workflows/|actions/)?runs)$`)},
	{http.MethodGet, "run.view", regexp.MustCompile(`^/api/repos/[^/]+/[^/]+/(?:workflows/|actions/)?runs/[0-9]+(?:/status(?:/stream)?)?$`)},
	{http.MethodGet, "runs.steps", regexp.MustCompile(`^/api/repos/[^/]+/[^/]+/(?:workflows/|actions/)?runs/[0-9]+/(?:steps|nodes/[^/]+)$`)},
	{http.MethodGet, "runs.events", regexp.MustCompile(`^/api/repos/[^/]+/[^/]+/(?:workflows/)?runs/[0-9]+/events$`)},
	{http.MethodGet, "runs.logs", regexp.MustCompile(`^/api/repos/[^/]+/[^/]+/runs/[0-9]+/logs$`)},

	{http.MethodPost, "flow.run", regexp.MustCompile(`^/api/repos/[^/]+/[^/]+/(invoke|workflows/[^/]+/dispatch(?:es)?)$`)},
	{http.MethodPost, "flow.run.stop", regexp.MustCompile(`^/api/repos/[^/]+/[^/]+/(?:workflows/|actions/)?runs/[0-9]+/cancel$`)},
	{http.MethodPost, "runs.rerun", regexp.MustCompile(`^/api/repos/[^/]+/[^/]+/(?:workflows/|actions/)?runs/[0-9]+/rerun$`)},
	{http.MethodPost, "runs.resume", regexp.MustCompile(`^/api/repos/[^/]+/[^/]+/(?:workflows/)?runs/[0-9]+/resume$`)},
	{http.MethodGet, "workspace.provider-pool", regexp.MustCompile(`^/provider-pool/routes$`)},
	{http.MethodPost, "workspace.provider-pool", regexp.MustCompile(`^/provider-pool/(?:anthropic/v1/messages|chatgpt/codex/responses)$`)},
	{http.MethodPost, "stack.candidate", regexp.MustCompile(`^/api/repos/[^/]+/[^/]+/workspaces/[^/]+/stack/candidate$`)},
	{http.MethodPost, "stack.propose", regexp.MustCompile(`^/api/repos/[^/]+/[^/]+/workspaces/[^/]+/stack/propose$`)},
	{http.MethodPut, "stack.candidate", regexp.MustCompile(`^/api/repos/[^/]+/[^/]+/mythical/lanes$`)},
	{http.MethodPost, "workspace.head", workspaceHeadReportPath},
	{http.MethodGet, "workspace.children.list", regexp.MustCompile(`^/api/repos/[^/]+/[^/]+/workspaces/[^/]+/children$`)},
	{http.MethodPost, "workspace.children.spawn", regexp.MustCompile(`^/api/repos/[^/]+/[^/]+/workspaces/[^/]+/children$`)},
	{http.MethodPost, "workspace.children.stop", regexp.MustCompile(`^/api/repos/[^/]+/[^/]+/workspaces/[^/]+/children/[^/]+/stop$`)},
	// Retained review doors use their literal catalog actions; the service
	// consumes the same bound decision when entered from this router.
	{http.MethodPost, "review.ack", regexp.MustCompile(`^/api/repos/[^/]+/[^/]+/landings/[0-9]+/threads/[0-9]+/ack$`)},
	{http.MethodPost, "review.done", regexp.MustCompile(`^/api/repos/[^/]+/[^/]+/landings/[0-9]+/threads/[0-9]+/done$`)},
	{http.MethodPost, "review.reopen", regexp.MustCompile(`^/api/repos/[^/]+/[^/]+/landings/[0-9]+/threads/[0-9]+/reopen$`)},
	{http.MethodPatch, "approval.deny", regexp.MustCompile(`^/api/repos/[^/]+/[^/]+/landings/[0-9]+/reviews/[0-9]+$`)},
	{http.MethodGet, "members.list", regexp.MustCompile(`^/api/members$`)},
	{http.MethodPost, "members.write", regexp.MustCompile(`^/api/members$`)},
	{http.MethodPatch, "members.write", regexp.MustCompile(`^/api/members/[^/]+$`)},
	{http.MethodDelete, "members.write", regexp.MustCompile(`^/api/members/[^/]+$`)},
	// Provider account management is the owner's person-only Secrets surface.
	// The pool's machine grant is separate and never admits these routes.
	{http.MethodGet, "settings", regexp.MustCompile(`^/api/user/provider-connections(?:/[^/]+)?$`)},
	{http.MethodPost, "settings", regexp.MustCompile(`^/api/user/provider-connections$`)},
	{http.MethodPut, "settings", regexp.MustCompile(`^/api/user/provider-connections/order$`)},
	{http.MethodPost, "settings", regexp.MustCompile(`^/api/user/provider-connections/codex/device(?:/[^/]+)?$`)},
	{http.MethodDelete, "settings", regexp.MustCompile(`^/api/user/provider-connections/[^/]+$`)},
	{http.MethodPost, "settings", regexp.MustCompile(`^/api/user/provider-connections/[^/]+/refresh$`)},
	{http.MethodPost, "secrets.scope", regexp.MustCompile(`^/api/user/provider-connections/[^/]+/grants$`)},
	{http.MethodDelete, "secrets.scope", regexp.MustCompile(`^/api/user/provider-connections/[^/]+/grants/[0-9]+$`)},
	// Maintainers add, replace and delete the repository's secrets
	// (mvp.md §6.15, M-05; spec §5.2): a person-only command, so the
	// owner's delegated credentials are refused here too. Org secrets stay
	// the owner's.
	{http.MethodGet, "secrets.read", regexp.MustCompile(`^/api/repos/[^/]+/[^/]+/(secrets|agent-environment)$`)},
	{http.MethodPut, "secrets.write", regexp.MustCompile(`^/api/repos/[^/]+/[^/]+/agent-environment(?:/secrets/[^/]+)?$`)},
	{http.MethodDelete, "secrets.write", regexp.MustCompile(`^/api/repos/[^/]+/[^/]+/agent-environment/secrets/[^/]+$`)},
	{http.MethodGet, "secrets.read", regexp.MustCompile(`^/api/secrets$`)},
	{http.MethodPut, "secrets.write", regexp.MustCompile(`^/api/secrets$`)},
	{http.MethodDelete, "secrets.write", regexp.MustCompile(`^/api/secrets$`)},
	{http.MethodPatch, "secrets.write", regexp.MustCompile(`^/api/secrets/[^/]+$`)},
	{http.MethodDelete, "secrets.write", regexp.MustCompile(`^/api/secrets/[^/]+$`)},
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
	if err := boundary.AuthorizeMember(installationAuthorizationContext(r, authInfo.IsTokenAuth), authInfo.User.ID); err != nil {
		errors.WriteError(w, err)
		return false
	}
	return true
}

// installationAuthorizationContext applies the same route admission to cookies and SSE tickets.
func installationAuthorizationContext(r *http.Request, memberBound ...bool) context.Context {
	ctx := r.Context()
	if len(memberBound) > 0 && memberBound[0] {
		ctx = identity.WithMemberBoundCredential(ctx)
	}
	// GitHub returns the browser to /setup/github/* before the repository step
	// verifies the owner, so those returns are setup routes too.
	if r.URL.Path == "/api/install" || strings.HasPrefix(r.URL.Path, "/api/install/setup/") || strings.HasPrefix(r.URL.Path, "/api/github-app/") || r.URL.Path == "/api/auth/github" || r.URL.Path == "/api/auth/github/callback" || r.URL.Path == "/api/auth/logout" || r.URL.Path == "/setup/github/callback" || r.URL.Path == "/setup/github/installed" {
		ctx = identity.WithSetupScope(ctx)
	}
	if InstallMemberCommand(r.Method, r.URL.EscapedPath()) != "" {
		ctx = identity.WithMemberRoute(ctx)
	}
	return ctx
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
		if !LegacyRawSessionKey(sessionKey) {
			return nil, nil, nil
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

// LegacyRawSessionKey reports whether a presented session cookie may name a
// legacy row filed under the raw key. Every cookie may except a 64-hex
// string: a stored SHA-256 digest is never a raw key, or a database dump
// would work as cookies and hashing at rest would protect nothing. Logout
// (services.AuthService.Logout) revokes by the same rule, so anything auth
// accepts, logout revokes.
func LegacyRawSessionKey(sessionKey string) bool {
	if len(sessionKey) != sha256.Size*2 {
		return true
	}
	_, err := hex.DecodeString(sessionKey)
	return err != nil
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
		if lookup, ok := ctx.Value(terminalTokenLookupKey{}).(TerminalTokenLookup); ok && lookup != nil {
			info, err := lookup(ctx, tokenHash)
			if err != nil || info != nil {
				return info, err
			}
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

func csrfSameSite(r *http.Request) http.SameSite {
	if _, ok := EffectiveOriginFromContext(r.Context()); ok {
		return http.SameSiteLaxMode
	}
	return http.SameSiteStrictMode
}
