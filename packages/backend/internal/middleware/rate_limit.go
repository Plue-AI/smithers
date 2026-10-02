package middleware

import (
	"context"
	"crypto/subtle"
	"log/slog"
	"math"
	"net"
	"net/http"
	"net/netip"
	"os"
	"reflect"
	"strconv"
	"strings"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

const (
	searchRateLimitScope    = "search"
	authRateLimitScope      = "auth"
	sseTicketRateLimitScope = "sse_ticket"
	// authWorkerRateLimitScope buckets trusted Cloudflare-Worker
	// server-to-server auth calls (shared-bearer authenticated) separately
	// from the strict anonymous "auth" scope. All Worker traffic egresses
	// from a handful of shared IPs, so it must not compete with (or be
	// starved by) the per-IP anonymous auth bucket.
	authWorkerRateLimitScope = "auth_worker"
	// authInteractiveRateLimitScope buckets the browser-interactive OAuth
	// routes (GitHub / Auth0 start + callback). One connect attempt burns
	// two tokens (start + callback), so these get a looser limit than the
	// strict "auth" scope used for credential-bearing endpoints.
	authInteractiveRateLimitScope = "auth_interactive"
)

// SearchRateLimitStore consumes tokens from Postgres-backed buckets. Expired
// bucket rows are pruned by the periodic auth cleaner (cleanup.AuthCleaner),
// never on the request path.
type SearchRateLimitStore interface {
	ConsumeSearchRateLimitToken(ctx context.Context, arg db.ConsumeSearchRateLimitTokenParams) (db.ConsumeSearchRateLimitTokenRow, error)
}

// RateLimitRejectObserver is called whenever a request is rejected with 429
// by the token-bucket middleware. Used by ticket-0132 per-surface metrics.
type RateLimitRejectObserver func(scope string)

type rateLimiter struct {
	store           SearchRateLimitStore
	scope           string
	limit           int
	window          time.Duration
	refillPerSecond float64
	nowFn           func() time.Time
	onReject        RateLimitRejectObserver
	// failClosed rejects requests with 503 when the token store errors,
	// instead of letting them through. Set for brute-force-sensitive auth
	// scopes; throughput scopes deliberately fail open for availability.
	failClosed bool
	// keyFn overrides the principal key; nil means searchRateLimitKey.
	keyFn func(*http.Request) string
}

// SearchRateLimit enforces the search limit: 30 requests/minute.
func SearchRateLimit(store SearchRateLimitStore) func(http.Handler) http.Handler {
	return NewSearchRateLimit(store, 30, time.Minute)
}

func NewSearchRateLimit(store SearchRateLimitStore, limit int, window time.Duration) func(http.Handler) http.Handler {
	return newRateLimit(store, searchRateLimitScope, limit, window, 30, time.Minute)
}

// AuthRateLimit enforces auth endpoint limit: 5 requests/minute.
func AuthRateLimit(store SearchRateLimitStore) func(http.Handler) http.Handler {
	return NewAuthRateLimit(store, 5, time.Minute)
}

func NewAuthRateLimit(store SearchRateLimitStore, limit int, window time.Duration) func(http.Handler) http.Handler {
	return newRateLimit(store, authRateLimitScope, limit, window, 5, time.Minute)
}

// SSETicketRateLimit permits authenticated stream and socket connections to
// reconnect without consuming the credential-attempt bucket. RequireAuth must
// run first so the 60/minute bucket belongs to the authenticated user.
func SSETicketRateLimit(store SearchRateLimitStore) func(http.Handler) http.Handler {
	return newRateLimit(store, sseTicketRateLimitScope, 60, time.Minute, 60, time.Minute)
}

// InteractiveAuthRateLimit enforces the interactive OAuth flow limit:
// 20 requests/minute per IP (scope "auth_interactive"). Used for the
// browser-facing GitHub/Auth0 start + callback routes, where a single
// sign-in attempt consumes two tokens and users legitimately retry.
func InteractiveAuthRateLimit(store SearchRateLimitStore) func(http.Handler) http.Handler {
	return NewInteractiveAuthRateLimit(store, 20, time.Minute)
}

// NewInteractiveAuthRateLimit creates an interactive-OAuth rate limiter with
// configurable limits (defaults: 20/minute).
func NewInteractiveAuthRateLimit(store SearchRateLimitStore, limit int, window time.Duration) func(http.Handler) http.Handler {
	return newRateLimit(store, authInteractiveRateLimitScope, limit, window, 20, time.Minute)
}

// SharedBearerAwareAuthRateLimit rate-limits an auth endpoint that is fronted
// by RequireSharedBearerToken (e.g. the Worker-only GitHub-token exchange).
//
// Requests presenting the correct shared bearer token are routed to a
// dedicated, more generous "auth_worker" bucket (workerLimit/window): the
// trusted Cloudflare Worker funnels one call per user login through a handful
// of shared egress IPs and must not starve in — or drain — the anonymous
// per-IP "auth" bucket. Every other request (missing/malformed/wrong bearer,
// or no expectedToken configured) falls through to the strict AuthRateLimit
// bucket (scope "auth", 5/minute), exactly as before.
//
// This middleware only selects a rate-limit bucket; it never authenticates.
// RequireSharedBearerToken must still run after it as the real gate.
func SharedBearerAwareAuthRateLimit(store SearchRateLimitStore, expectedToken string, workerLimit int, window time.Duration) func(http.Handler) http.Handler {
	workerLimiter := newRateLimit(store, authWorkerRateLimitScope, workerLimit, window, 120, time.Minute)
	strictLimiter := AuthRateLimit(store)

	return func(next http.Handler) http.Handler {
		workerNext := workerLimiter(next)
		strictNext := strictLimiter(next)
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if requestBearsSharedToken(r, expectedToken) {
				workerNext.ServeHTTP(w, r)
				return
			}
			strictNext.ServeHTTP(w, r)
		})
	}
}

// requestBearsSharedToken extracts the Authorization Bearer token exactly
// like RequireSharedBearerToken and compares it with the expected shared
// token in constant time. An empty expectedToken never matches (fail safe).
func requestBearsSharedToken(r *http.Request, expectedToken string) bool {
	if expectedToken == "" {
		return false
	}

	authHeader := r.Header.Get("Authorization")
	if authHeader == "" {
		return false
	}

	parts := strings.SplitN(authHeader, " ", 2)
	if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") {
		return false
	}

	return subtle.ConstantTimeCompare([]byte(parts[1]), []byte(expectedToken)) == 1
}

func newRateLimit(store SearchRateLimitStore, scope string, limit int, window time.Duration, defaultLimit int, defaultWindow time.Duration) func(http.Handler) http.Handler {
	return newRateLimitWithObserver(store, scope, limit, window, defaultLimit, defaultWindow, nil)
}

// newRateLimitWithKey builds a limiter whose principal key is derived by
// keyFn instead of the user-or-address default.
func newRateLimitWithKey(store SearchRateLimitStore, scope string, limit int, window time.Duration, defaultLimit int, defaultWindow time.Duration, keyFn func(*http.Request) string) func(http.Handler) http.Handler {
	limiter := newLimiter(store, scope, limit, window, defaultLimit, defaultWindow, nil)
	limiter.keyFn = keyFn
	return limiter.middleware
}

func newRateLimitWithObserver(
	store SearchRateLimitStore,
	scope string,
	limit int,
	window time.Duration,
	defaultLimit int,
	defaultWindow time.Duration,
	onReject RateLimitRejectObserver,
) func(http.Handler) http.Handler {
	return newLimiter(store, scope, limit, window, defaultLimit, defaultWindow, onReject).middleware
}

func newLimiter(
	store SearchRateLimitStore,
	scope string,
	limit int,
	window time.Duration,
	defaultLimit int,
	defaultWindow time.Duration,
	onReject RateLimitRejectObserver,
) *rateLimiter {
	if limit <= 0 {
		limit = defaultLimit
	}
	if window <= 0 {
		window = defaultWindow
	}
	if isNilSearchRateLimitStore(store) {
		store = nil
	}

	failClosed := scope == authRateLimitScope ||
		scope == authWorkerRateLimitScope ||
		scope == authInteractiveRateLimitScope ||
		scope == sseTicketRateLimitScope

	limiter := &rateLimiter{
		store:           store,
		scope:           scope,
		limit:           limit,
		window:          window,
		refillPerSecond: float64(limit) / window.Seconds(),
		onReject:        onReject,
		failClosed:      failClosed,
		nowFn: func() time.Time {
			return time.Now().UTC()
		},
	}

	return limiter
}

func (l *rateLimiter) middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		now := l.nowFn()
		if l.store == nil {
			l.writeHeaders(w, l.limit, l.limit, now.Add(l.window))
			next.ServeHTTP(w, r)
			return
		}

		principalKey := searchRateLimitKey(r)
		if l.keyFn != nil {
			principalKey = l.keyFn(r)
		}

		row, err := l.store.ConsumeSearchRateLimitToken(r.Context(), db.ConsumeSearchRateLimitTokenParams{
			Scope:           l.scope,
			PrincipalKey:    principalKey,
			Capacity:        float64(l.limit),
			RefillPerSecond: l.refillPerSecond,
			NowAt:           now,
		})
		if err != nil {
			if l.failClosed {
				slog.Error("rate limit store error; failing closed",
					"scope", l.scope,
					"path", r.URL.Path,
					"error", err,
				)
				// The pacing rides in the BODY as well as the header: the
				// Worker in front of plue does not forward upstream headers,
				// so a call site that only set the header told the Worker
				// nothing. rate_limiter_unavailable carries RetryAfter 1 in
				// the registry, so New fills both.
				w.Header().Set("Retry-After", "1")
				errors.WriteError(w, errors.New(errors.CodeRateLimiterUnavailable,
					"rate limiter unavailable"))
				return
			}
			slog.Warn("rate limit store error; failing open",
				"scope", l.scope,
				"path", r.URL.Path,
				"error", err,
			)
			l.writeHeaders(w, l.limit, l.limit, now.Add(l.window))
			next.ServeHTTP(w, r)
			return
		}

		remaining := int(math.Floor(row.RemainingTokens))
		if remaining < 0 {
			remaining = 0
		}
		resetAt := now
		if row.RemainingTokens < 1 {
			secondsUntilNextToken := (1 - row.RemainingTokens) / l.refillPerSecond
			if secondsUntilNextToken < 0 {
				secondsUntilNextToken = 0
			}
			resetAt = now.Add(time.Duration(secondsUntilNextToken * float64(time.Second)))
		}
		l.writeHeaders(w, l.limit, remaining, resetAt)

		if !row.Allowed {
			slog.Warn("rate limit exceeded",
				"scope", l.scope,
				"principal_key", principalKey,
				"path", r.URL.Path,
				"method", r.Method,
			)
			if l.onReject != nil {
				l.onReject(l.scope)
			}
			retryAfter := l.retryAfterSeconds(now, resetAt)
			w.Header().Set("Retry-After", strconv.Itoa(retryAfter))
			limit := l.limit
			zero := 0
			errors.WriteError(w, &errors.APIError{
				Status:     http.StatusTooManyRequests,
				Code:       errors.CodeRateLimitExceeded,
				Message:    "rate limit exceeded",
				Limit:      &limit,
				Remaining:  &zero,
				RetryAfter: retryAfter,
			})
			return
		}

		next.ServeHTTP(w, r)
	})
}

func (l *rateLimiter) writeHeaders(w http.ResponseWriter, limit, remaining int, resetAt time.Time) {
	w.Header().Set("X-RateLimit-Limit", strconv.Itoa(limit))
	w.Header().Set("X-RateLimit-Remaining", strconv.Itoa(remaining))
	w.Header().Set("X-RateLimit-Reset", strconv.FormatInt(resetAt.Unix(), 10))
}

func (l *rateLimiter) retryAfterSeconds(now, resetAt time.Time) int {
	if !resetAt.After(now) {
		return 0
	}
	return int(math.Ceil(resetAt.Sub(now).Seconds()))
}

func searchRateLimitKey(r *http.Request) string {
	if user := UserFromContext(r.Context()); user != nil {
		// Platform sync work shares one bounded principal across rotations,
		// separate from the person whose repository it synchronizes.
		if AuthInfoFromContext(r.Context()).CredentialKind() == CredentialSync {
			return "sync:user:" + strconv.FormatInt(user.ID, 10)
		}
		return "user:" + strconv.FormatInt(user.ID, 10)
	}

	remoteAddr := strings.TrimSpace(r.RemoteAddr)
	if remoteAddr == "" {
		return "ip:unknown"
	}

	host, _, err := net.SplitHostPort(remoteAddr)
	if err != nil || host == "" {
		host = remoteAddr
	}
	return "ip:" + canonicalRateLimitIP(host)
}

// canonicalRateLimitIP keys an IPv6 client by its /64. One subscriber controls
// at least a /64, so a per-address key lets it take a fresh bucket for every
// request. IPv4 (including IPv4-mapped IPv6) stays per address.
func canonicalRateLimitIP(host string) string {
	addr, err := netip.ParseAddr(host)
	if err != nil {
		return host
	}
	addr = addr.Unmap()
	if addr.Is4() {
		return addr.String()
	}
	prefix, err := addr.WithZone("").Prefix(64)
	if err != nil {
		return addr.String()
	}
	return prefix.String()
}

func isNilSearchRateLimitStore(store SearchRateLimitStore) bool {
	if store == nil {
		return true
	}
	v := reflect.ValueOf(store)
	return v.Kind() == reflect.Pointer && v.IsNil()
}

const (
	apiRateLimitScope               = "api"
	emailVerificationRateLimitScope = "email_verify"
	telemetryRateLimitScope         = "telemetry"
	workspaceTerminalOpenScope      = "workspace_terminal_open"
	approvalDecideScope             = "approval_decide"
	agentMessagePostScope           = "agent_message_post"
	devtoolsSnapshotPostScope       = "devtools_snapshot_post"
	workflowDispatchScope           = "workflow_dispatch"
	appTimelineWriteScope           = "app_timeline_write"
)

// AppTimelineWriteRateLimit enforces the per-user app-timeline write rate
// (event appends, rewrites, snapshots, member changes). Default 240/min:
// timeline appends ride every machine event, so the bucket must absorb a
// busy interactive session while still stopping a runaway sync loop.
func AppTimelineWriteRateLimit(store SearchRateLimitStore, limit int) func(http.Handler) http.Handler {
	return newRateLimit(store, appTimelineWriteScope, limit, time.Minute, 240, time.Minute)
}

// EmailVerificationRateLimit enforces verification email rate limit: 5 requests/hour per user.
func EmailVerificationRateLimit(store SearchRateLimitStore) func(http.Handler) http.Handler {
	return NewEmailVerificationRateLimit(store, 5, time.Hour)
}

// NewEmailVerificationRateLimit creates an email verification rate limiter with configurable limits.
func NewEmailVerificationRateLimit(store SearchRateLimitStore, limit int, window time.Duration) func(http.Handler) http.Handler {
	return newRateLimit(store, emailVerificationRateLimitScope, limit, window, 5, time.Hour)
}

// GlobalAPIRateLimit enforces global API rate limits:
// 5000 requests/hour for authenticated users, 600 requests/hour for anonymous.
// The anonymous limit was raised from 60/hour (refill 1/min): an app tab whose
// session degraded to anonymous polls faster than 1 req/min and would pin the
// bucket at zero forever.
//
// Designated canary principals (the production e2e account) draw from a
// dedicated high-capacity bucket so full-suite verification runs cannot
// exhaust the ordinary authenticated quota. Env-configured like
// SMITHERS_AGENT_TOKEN in RequireAgentToken:
// SMITHERS_RATE_LIMIT_CANARY_API_USER_IDS is a CSV of user IDs and
// SMITHERS_RATE_LIMIT_CANARY_API_PER_HOUR the bucket capacity (default 50000).
func GlobalAPIRateLimit(store SearchRateLimitStore) func(http.Handler) http.Handler {
	canaryUserIDs, canaryLimit := canaryAPIRateLimitFromEnv()
	return NewGlobalAPIRateLimitWithCanary(store, 5000, 600, time.Hour, canaryUserIDs, canaryLimit)
}

// NewGlobalAPIRateLimit creates a global API rate limiter with configurable limits.
// authLimit is the per-user limit for authenticated requests.
// anonLimit is the per-IP limit for anonymous requests.
func NewGlobalAPIRateLimit(store SearchRateLimitStore, authLimit, anonLimit int, window time.Duration) func(http.Handler) http.Handler {
	return NewGlobalAPIRateLimitWithCanary(store, authLimit, anonLimit, window, nil, 0)
}

// NewGlobalAPIRateLimitWithCanary is NewGlobalAPIRateLimit plus a canary
// override: authenticated principals whose ID is in canaryUserIDs draw from a
// bucket of canaryLimit per window instead of authLimit. The canary bucket
// shares the "api" scope, so the same durable store row simply carries the
// larger capacity (ConsumeSearchRateLimitToken clamps refills to the
// middleware capacity, which is exactly the canary limit for those rows).
func NewGlobalAPIRateLimitWithCanary(
	store SearchRateLimitStore,
	authLimit, anonLimit int,
	window time.Duration,
	canaryUserIDs []int64,
	canaryLimit int,
) func(http.Handler) http.Handler {
	if authLimit <= 0 {
		authLimit = 5000
	}
	if anonLimit <= 0 {
		anonLimit = 600
	}
	if window <= 0 {
		window = time.Hour
	}
	if isNilSearchRateLimitStore(store) {
		store = nil
	}

	authLimiter := &rateLimiter{
		store:           store,
		scope:           apiRateLimitScope,
		limit:           authLimit,
		window:          window,
		refillPerSecond: float64(authLimit) / window.Seconds(),
		nowFn:           func() time.Time { return time.Now().UTC() },
	}

	anonLimiter := &rateLimiter{
		store:           store,
		scope:           apiRateLimitScope,
		limit:           anonLimit,
		window:          window,
		refillPerSecond: float64(anonLimit) / window.Seconds(),
		nowFn:           func() time.Time { return time.Now().UTC() },
	}

	var canaryLimiter *rateLimiter
	canaryIDs := make(map[int64]bool, len(canaryUserIDs))
	if len(canaryUserIDs) > 0 {
		if canaryLimit <= 0 {
			canaryLimit = 50000
		}
		for _, id := range canaryUserIDs {
			canaryIDs[id] = true
		}
		canaryLimiter = &rateLimiter{
			store:           store,
			scope:           apiRateLimitScope,
			limit:           canaryLimit,
			window:          window,
			refillPerSecond: float64(canaryLimit) / window.Seconds(),
			nowFn:           func() time.Time { return time.Now().UTC() },
		}
	}

	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			user := UserFromContext(r.Context())
			switch {
			case user != nil && canaryLimiter != nil && canaryIDs[user.ID]:
				canaryLimiter.middleware(next).ServeHTTP(w, r)
			case user != nil:
				authLimiter.middleware(next).ServeHTTP(w, r)
			default:
				anonLimiter.middleware(next).ServeHTTP(w, r)
			}
		})
	}
}

// canaryAPIRateLimitFromEnv reads the canary allowlist and capacity from the
// environment. Invalid CSV entries are skipped with a warning rather than
// failing closed: a typo in one entry must not strip rate limiting (or
// service) from everyone else.
func canaryAPIRateLimitFromEnv() ([]int64, int) {
	raw := strings.TrimSpace(os.Getenv("SMITHERS_RATE_LIMIT_CANARY_API_USER_IDS"))
	if raw == "" {
		return nil, 0
	}
	var ids []int64
	for _, part := range strings.Split(raw, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		id, err := strconv.ParseInt(part, 10, 64)
		if err != nil || id <= 0 {
			slog.Warn("ignoring invalid canary API rate limit user id", "entry", part)
			continue
		}
		ids = append(ids, id)
	}

	limit := 0
	if rawLimit := strings.TrimSpace(os.Getenv("SMITHERS_RATE_LIMIT_CANARY_API_PER_HOUR")); rawLimit != "" {
		parsed, err := strconv.Atoi(rawLimit)
		if err != nil || parsed <= 0 {
			slog.Warn("ignoring invalid canary API rate limit capacity", "entry", rawLimit)
		} else {
			limit = parsed
		}
	}
	return ids, limit
}

// TelemetryRateLimit enforces telemetry endpoint limit: 10 requests/minute per IP.
func TelemetryRateLimit(store SearchRateLimitStore) func(http.Handler) http.Handler {
	return newRateLimit(store, telemetryRateLimitScope, 10, time.Minute, 10, time.Minute)
}

// SharedBearerAwareTelemetryRateLimit gives first-party Worker exports their
// own 120/minute bucket. Aggregated Worker egress must be able to cross the
// 30/minute frontend alert threshold without sharing login capacity. Missing,
// malformed, wrong, and unconfigured tokens retain the public 10/minute limit.
func SharedBearerAwareTelemetryRateLimit(store SearchRateLimitStore, expectedToken string) func(http.Handler) http.Handler {
	workerLimiter := newRateLimit(store, "telemetry_worker", 120, time.Minute, 120, time.Minute)
	publicLimiter := TelemetryRateLimit(store)
	return func(next http.Handler) http.Handler {
		workerNext, publicNext := workerLimiter(next), publicLimiter(next)
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if requestBearsSharedToken(r, expectedToken) {
				workerNext.ServeHTTP(w, r)
				return
			}
			publicNext.ServeHTTP(w, r)
		})
	}
}

// --- Ticket 0132 scopes: dedicated limiters for remote-client surfaces. ---
//
// These scopes are intentionally per-authenticated-user (NOT per-IP). Mobile
// clients NAT behind shared IPs and resume connections in bursts, so per-IP
// bucketing would trip on normal app resume behavior. `searchRateLimitKey`
// already prefers the user ID when available and falls back to IP, which is
// the correct behavior for unauthenticated edge cases (they should not hit
// these routes, but fail-safe to per-IP).
//
// Defaults are deliberately loose enough that a single client reconnecting
// repeatedly over a lossy network will not trip them.
const (
	// WorkspaceTerminalOpenRateLimitScope gates new terminal WebSocket upgrades.
	WorkspaceTerminalOpenRateLimitScope = "workspace_terminal_open"

	// ApprovalDecideRateLimitScope gates approval decide POSTs per user.
	ApprovalDecideRateLimitScope = "approval_decide"
)

// WorkspaceTerminalOpenRateLimit enforces the per-user terminal WebSocket open
// rate. Default 20/min; tune via SMITHERS_RATE_LIMIT_TERMINAL_OPEN_PER_MIN.
// This fires BEFORE the expensive SSH dial — see workspace_terminal.go.
func WorkspaceTerminalOpenRateLimit(store SearchRateLimitStore, limit int) func(http.Handler) http.Handler {
	return WorkspaceTerminalOpenRateLimitWithObserver(store, limit, nil)
}

// WorkspaceTerminalOpenRateLimitWithObserver is WorkspaceTerminalOpenRateLimit
// with an optional rejection observer callback for per-scope metrics.
func WorkspaceTerminalOpenRateLimitWithObserver(
	store SearchRateLimitStore,
	limit int,
	onReject RateLimitRejectObserver,
) func(http.Handler) http.Handler {
	return newRateLimitWithObserver(store, WorkspaceTerminalOpenRateLimitScope, limit, time.Minute, 20, time.Minute, onReject)
}

// ApprovalDecideRateLimit enforces the per-user POST /approvals/{id}/decide
// rate. Default 30/min; tune via SMITHERS_RATE_LIMIT_APPROVAL_DECIDE_PER_MIN.
// Approval decisions are logically idempotent, but this bucket protects
// audit logs and downstream notifications from spam.
func ApprovalDecideRateLimit(store SearchRateLimitStore, limit int) func(http.Handler) http.Handler {
	return ApprovalDecideRateLimitWithObserver(store, limit, nil)
}

// ApprovalDecideRateLimitWithObserver is ApprovalDecideRateLimit with an
// optional rejection observer callback for per-scope metrics.
func ApprovalDecideRateLimitWithObserver(
	store SearchRateLimitStore,
	limit int,
	onReject RateLimitRejectObserver,
) func(http.Handler) http.Handler {
	return newRateLimitWithObserver(store, ApprovalDecideRateLimitScope, limit, time.Minute, 30, time.Minute, onReject)
}

// AgentMessagePostRateLimit enforces agent message posts per user.
func AgentMessagePostRateLimit(store SearchRateLimitStore, limit int) func(http.Handler) http.Handler {
	return newRateLimit(store, agentMessagePostScope, limit, time.Minute, 20, time.Minute)
}

// DevtoolsSnapshotPostRateLimit enforces devtools snapshot posts per user.
func DevtoolsSnapshotPostRateLimit(store SearchRateLimitStore, limit int) func(http.Handler) http.Handler {
	return newRateLimit(store, devtoolsSnapshotPostScope, limit, time.Minute, 20, time.Minute)
}

// WorkflowDispatchRateLimit enforces workflow dispatch posts per user.
func WorkflowDispatchRateLimit(store SearchRateLimitStore, limit int) func(http.Handler) http.Handler {
	return newRateLimit(store, workflowDispatchScope, limit, time.Minute, 10, time.Minute)
}

func matchesExcludedPath(path, excludedPath string) bool {
	excludedPath = strings.TrimSpace(excludedPath)
	if excludedPath == "" {
		return false
	}

	if strings.HasSuffix(excludedPath, "/") {
		trimmed := strings.TrimSuffix(excludedPath, "/")
		return path == trimmed || strings.HasPrefix(path, excludedPath)
	}

	return path == excludedPath
}

// ExcludePaths wraps a middleware so it is skipped only for matching routes,
// not for arbitrary substring matches elsewhere in the path. Each entry is a
// literal request path, or a prefix when it ends in "/". It panics on a chi
// route pattern ("{param}" or "*"), which could never match a request path.
func ExcludePaths(mw func(http.Handler) http.Handler, excludedPaths ...string) func(http.Handler) http.Handler {
	for _, excludedPath := range excludedPaths {
		if strings.ContainsAny(excludedPath, "{*") {
			panic("middleware.ExcludePaths: route pattern " + excludedPath + " never matches a request path; list literal paths or a trailing-slash prefix")
		}
	}
	return func(next http.Handler) http.Handler {
		wrapped := mw(next)
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			for _, excludedPath := range excludedPaths {
				if matchesExcludedPath(r.URL.Path, excludedPath) {
					next.ServeHTTP(w, r)
					return
				}
			}
			wrapped.ServeHTTP(w, r)
		})
	}
}
