// Package middleware — per-repo and per-user quota rate limiters (ticket 17).
//
// These middlewares enforce the Smithers product quotas:
//   - Per-repo: stack submits 30/hr, workflow runs 60/hr.
//   - Per-caller per-repo: API requests 1000/hr.
//   - Per-user: connected repos 10 (count), concurrent workflow runs 5 (count),
//     concurrent sandboxes 3 (count).
//
// Sandbox runtime is metered per user by BillingService.AuthorizeSandboxStart, not here.
//
// The token-bucket store here is intentionally process-local (in-memory). Each
// API replica enforces its own quota; this is acceptable for the MVP because
// per-replica caps are low relative to true ceilings, and we'd rather fail
// open than block legitimate traffic on a Redis hop. If we need cross-replica
// accuracy we'll move this into Postgres (mirroring SearchRateLimitStore).
package middleware

import (
	"context"
	stderrors "errors"
	"math"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/prometheus/client_golang/prometheus"

	"github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// Clock is a swappable time source so tests can drive the bucket
// deterministically. Default is time.Now().UTC().
type Clock interface {
	Now() time.Time
}

type realClock struct{}

func (realClock) Now() time.Time { return time.Now().UTC() }

// TokenBucketStore is an in-memory token-bucket rate limiter keyed by string.
// Bucket capacity and refill rate are supplied per-Take call so a single store
// can back many independent quotas.
type TokenBucketStore struct {
	mu          sync.Mutex
	buckets     map[string]*bucketEntry
	clock       Clock
	nextCleanup time.Time
}

type bucketEntry struct {
	tokens     float64
	lastRefill time.Time
	expiresAt  time.Time
}

const quotaBucketCleanupFrequency = time.Minute

// NewTokenBucketStore returns a store using time.Now() for time.
func NewTokenBucketStore() *TokenBucketStore {
	return NewTokenBucketStoreWithClock(realClock{})
}

// NewTokenBucketStoreWithClock returns a store backed by the supplied clock.
func NewTokenBucketStoreWithClock(clock Clock) *TokenBucketStore {
	if clock == nil {
		clock = realClock{}
	}
	return &TokenBucketStore{
		buckets: make(map[string]*bucketEntry),
		clock:   clock,
	}
}

// Take consumes one token from the bucket identified by key. capacity is the
// bucket size; refillPer is the duration over which capacity refills (so 30
// requests per hour → capacity=30, refillPer=time.Hour). Returns whether the
// caller may proceed and, if not, how long to wait before retrying.
//
//nolint:revive // ctx kept for interface symmetry; in-memory store ignores it.
func (s *TokenBucketStore) Take(_ context.Context, key string, capacity int, refillPer time.Duration) (allowed bool, retryAfter time.Duration) {
	if capacity <= 0 || refillPer <= 0 {
		return true, 0
	}
	refillPerSecond := float64(capacity) / refillPer.Seconds()

	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.clock.Now()

	if !now.Before(s.nextCleanup) {
		for key, entry := range s.buckets {
			if !now.Before(entry.expiresAt) {
				delete(s.buckets, key)
			}
		}
		s.nextCleanup = now.Add(quotaBucketCleanupFrequency)
	}

	entry, ok := s.buckets[key]
	if !ok {
		entry = &bucketEntry{tokens: float64(capacity), lastRefill: now}
		s.buckets[key] = entry
	} else {
		elapsed := now.Sub(entry.lastRefill).Seconds()
		if elapsed > 0 {
			entry.tokens += elapsed * refillPerSecond
			if entry.tokens > float64(capacity) {
				entry.tokens = float64(capacity)
			}
			entry.lastRefill = now
		}
	}
	// After an entire idle refill window the bucket is full, so forgetting it
	// cannot restore spent capacity. Keep longer-window debts until then.
	// Lazy cleanup avoids retaining every missing repo/workspace route forever.
	entry.expiresAt = now.Add(refillPer)

	if entry.tokens >= 1 {
		entry.tokens--
		return true, 0
	}

	// Not enough tokens — compute time until one has refilled.
	secondsUntil := (1 - entry.tokens) / refillPerSecond
	return false, time.Duration(math.Ceil(secondsUntil) * float64(time.Second))
}

// rateLimitExceededResponse writes a refused request as the one error
// envelope plue answers with.
//
// It used to spell the wait `retry_after_seconds`, a key that appeared on no
// other plue response and that nothing outside this file's own tests ever
// read, while every other paced failure spells it `retry_after`. The window is
// computed here from the bucket's refill rate, so it overrides the registry's
// default pacing for rate_limit_exceeded — which is what RetryAfter on the
// call site is for.
func rateLimitExceededResponse(w http.ResponseWriter, retryAfter time.Duration) {
	seconds := int(math.Ceil(retryAfter.Seconds()))
	if seconds < 1 {
		seconds = 1
	}
	w.Header().Set("Retry-After", strconv.Itoa(seconds))
	refusal := errors.New(errors.CodeRateLimitExceeded, "rate limit exceeded")
	refusal.RetryAfter = seconds
	errors.WriteError(w, refusal)
}

// repoBucketKey builds a stable per-repo key. We prefer RepoContext when it is
// available so already-resolved route params use the same canonical identity.
func repoBucketKey(r *http.Request, scope string) string {
	owner := ""
	repo := ""
	if rc := RepoContextFromContext(r.Context()); rc != nil && rc.Repository != nil {
		owner = rc.Owner
		repo = rc.Repository.LowerName
	}
	if owner == "" || repo == "" {
		owner = chi.URLParam(r, "owner")
		repo = chi.URLParam(r, "repo")
	}
	// Repo identity is case-insensitive (repositories resolve via lower_name), so
	// the bucket key MUST canonicalize case. Otherwise a client can multiply every
	// per-repo quota by permuting the case of the owner/repo path segments, since
	// each casing lands in a distinct token bucket for the same repository.
	return scope + "|repo:" + strings.ToLower(strings.TrimSpace(owner)) + "/" + strings.ToLower(strings.TrimSpace(repo))
}

// PerRepoStackSubmits enforces 30 stack-submit (landing-request) POSTs per
// hour per repo. Apply this around POST routes that create new landing
// requests / stack submissions.
func PerRepoStackSubmits(store *TokenBucketStore) func(http.Handler) http.Handler {
	const (
		capacity = 30
		window   = time.Hour
		scope    = "repo_stack_submits"
	)
	return perRepoBucketMiddleware(store, scope, capacity, window)
}

// PerRepoWorkflowRuns enforces 60 workflow-run dispatches per hour per repo.
func PerRepoWorkflowRuns(store *TokenBucketStore) func(http.Handler) http.Handler {
	const (
		capacity = 60
		window   = time.Hour
		scope    = "repo_workflow_runs"
	)
	return perRepoBucketMiddleware(store, scope, capacity, window)
}

// PerRepoAPIRequests enforces 1000 generic API requests per hour per caller
// per repo. Apply at the /api/repos/{owner}/{repo}/* group level.
//
// The bucket is keyed by caller (user id, or the client address for anonymous
// callers) as well as by repo. A repo-only key let any reader of a public repo
// spend its whole budget and lock the repository's API for every other user,
// the owner included.
func PerRepoAPIRequests(store *TokenBucketStore) func(http.Handler) http.Handler {
	const (
		capacity = 1000
		window   = time.Hour
		scope    = "repo_api_requests"
	)
	return perRepoBucketMiddlewareKeyed(store, capacity, window, func(r *http.Request) string {
		return repoBucketKey(r, scope) + "|" + searchRateLimitKey(r)
	})
}

// RequireWorkspaceDesktopAccess checks write access before the desktop rate
// bucket is charged. The checker uses the same workspace access rule as the
// desktop service, including explicit write shares.
func RequireWorkspaceDesktopAccess(check func(context.Context, string, int64, int64) error) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			user := UserFromContext(r.Context())
			repo := RepoContextFromContext(r.Context())
			if check == nil || user == nil || repo == nil || repo.Repository == nil {
				errors.WriteError(w, errors.Internal("workspace access check unavailable"))
				return
			}
			if err := check(r.Context(), chi.URLParam(r, "id"), repo.Repository.ID, user.ID); err != nil {
				var apiErr *errors.APIError
				if stderrors.As(err, &apiErr) {
					errors.WriteError(w, apiErr)
				} else {
					errors.WriteError(w, errors.Internal("check workspace access: "+err.Error()))
				}
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// PerWorkspaceDesktopControl enforces 1800 desktop observe/input requests per
// hour per caller and workspace — an agent driving a box at roughly one action
// every two seconds, sustained. It deliberately replaces (not
// supplements) the 1000/hr PerRepoAPIRequests bucket on these two routes: a
// single drive session would otherwise exhaust a repo's whole API budget.
// Per API pod, like every bucket in this file; the global 5000/hr per-user
// limit still applies above it.
func PerWorkspaceDesktopControl(store *TokenBucketStore) func(http.Handler) http.Handler {
	const (
		capacity = 1800
		window   = time.Hour
		scope    = "workspace_desktop_control"
	)
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if store == nil {
				next.ServeHTTP(w, r)
				return
			}
			// workspaces.id is UUID-typed. PostgreSQL accepts case differences,
			// optional braces and omitted/additional hyphens for the same UUID.
			// Access has already been checked by RequireWorkspaceDesktopAccess.
			id := strings.Trim(strings.ToLower(strings.TrimSpace(chi.URLParam(r, "id"))), "{}")
			key := scope + "|workspace:" + strings.ReplaceAll(id, "-", "") + "|" + searchRateLimitKey(r)
			allowed, retryAfter := store.Take(r.Context(), key, capacity, window)
			if !allowed {
				rateLimitExceededResponse(w, retryAfter)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

func perRepoBucketMiddleware(store *TokenBucketStore, scope string, capacity int, window time.Duration) func(http.Handler) http.Handler {
	return perRepoBucketMiddlewareKeyed(store, capacity, window, func(r *http.Request) string {
		return repoBucketKey(r, scope)
	})
}

func perRepoBucketMiddlewareKeyed(store *TokenBucketStore, capacity int, window time.Duration, bucketKey func(*http.Request) string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if store == nil {
				next.ServeHTTP(w, r)
				return
			}
			allowed, retryAfter := store.Take(r.Context(), bucketKey(r), capacity, window)
			if !allowed {
				rateLimitExceededResponse(w, retryAfter)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// --- Per-user concurrency caps (count-based, not token-bucket). ----------

// ConnectedRepoCounter returns the number of repos currently connected to the
// given user.
type ConnectedRepoCounter interface {
	CountConnectedReposForUser(ctx context.Context, userID int64) (int, error)
}

// ConcurrentWorkflowRunCounter returns the number of in-flight workflow runs
// owned by the given user.
type ConcurrentWorkflowRunCounter interface {
	CountActiveWorkflowRunsForUser(ctx context.Context, userID int64) (int, error)
}

// ConcurrentSandboxCounter returns the number of active (running) sandboxes
// owned by the given user.
type ConcurrentSandboxCounter interface {
	CountActiveSandboxesForUser(ctx context.Context, userID int64) (int, error)
}

// PerUserConnectedRepos blocks connect/import requests once the user already
// has 10 repos. Returns 422 with quota_exceeded code when over the cap; this
// is a hard cap not a rate-limit, so 429 is overloaded — we use it anyway for
// a uniform client experience matching the ticket's "11 → error" criterion.
func PerUserConnectedRepos(counter ConnectedRepoCounter, max int) func(http.Handler) http.Handler {
	if max <= 0 {
		max = 10
	}
	return userCountCapMiddleware(func(ctx context.Context, userID int64) (int, error) {
		if counter == nil {
			return 0, nil
		}
		return counter.CountConnectedReposForUser(ctx, userID)
	}, max, "connected_repos", "connected repos limit reached")
}

// PerUserConcurrentWorkflowRuns blocks new workflow runs once the user
// already has `max` in-flight (default 5).
func PerUserConcurrentWorkflowRuns(counter ConcurrentWorkflowRunCounter, max int) func(http.Handler) http.Handler {
	if max <= 0 {
		max = 5
	}
	return userCountCapMiddleware(func(ctx context.Context, userID int64) (int, error) {
		if counter == nil {
			return 0, nil
		}
		return counter.CountActiveWorkflowRunsForUser(ctx, userID)
	}, max, "concurrent_workflow_runs", "concurrent workflow runs limit reached")
}

// QuotaCounterErrors counts per-user cap checks that failed open because the
// active-count query errored, by cap scope. compose registers it on the
// Smithers registry.
var QuotaCounterErrors = prometheus.NewCounterVec(prometheus.CounterOpts{
	Name: "smithers_quota_counter_errors_total",
	Help: "Per-user cap checks that failed open because counting active resources failed, by scope.",
}, []string{"scope"})

// PerUserConcurrentSandboxes blocks new sandbox creation once the user
// already has `max` active (default 3).
func PerUserConcurrentSandboxes(counter ConcurrentSandboxCounter, max int, beforeRefusal ...func(context.Context, int64) error) func(http.Handler) http.Handler {
	if max <= 0 {
		max = 3
	}
	return userCountCapMiddleware(func(ctx context.Context, userID int64) (int, error) {
		if counter == nil {
			return 0, nil
		}
		return counter.CountActiveSandboxesForUser(ctx, userID)
	}, max, "concurrent_sandboxes", "concurrent sandboxes limit reached", beforeRefusal...)
}

func userCountCapMiddleware(count func(ctx context.Context, userID int64) (int, error), max int, scope, message string, beforeRefusal ...func(context.Context, int64) error) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			user := UserFromContext(r.Context())
			if user == nil {
				// Unauthenticated callers can't hit a per-user cap; let auth
				// middleware reject them downstream.
				next.ServeHTTP(w, r)
				return
			}
			current, err := count(r.Context(), user.ID)
			if err != nil {
				// Fail open on counter errors — this is a safety guard, not a
				// security boundary, and we'd rather not 500 on a transient
				// DB blip. Report it: a counter that keeps failing disables
				// the cap for every user, and that must show in logs and
				// /metrics.
				QuotaCounterErrors.WithLabelValues(scope).Inc()
				LoggerFromContext(r.Context()).Error("per-user cap counter failed; allowing request",
					"scope", scope,
					"user_id", user.ID,
					"request_id", RequestIDFromContext(r.Context()),
					"error", err,
				)
				next.ServeHTTP(w, r)
				return
			}
			if current >= max {
				// A plan refusal takes precedence over the infrastructure cap. Normal
				// requests defer plan admission to the service, which can distinguish
				// reusing a running workspace from starting a new VM.
				for _, authorize := range beforeRefusal {
					if authorize == nil {
						continue
					}
					if err := authorize(r.Context(), user.ID); err != nil {
						var apiErr *errors.APIError
						if !stderrors.As(err, &apiErr) {
							apiErr = errors.Internal("sandbox plan authorization failed")
						}
						errors.WriteError(w, apiErr)
						return
					}
				}
				limit := max
				remaining := 0
				w.Header().Set("Retry-After", "60")
				errors.WriteError(w, &errors.APIError{
					Status:     http.StatusTooManyRequests,
					Code:       errors.CodeQuotaExceeded,
					Message:    message,
					Limit:      &limit,
					Remaining:  &remaining,
					RetryAfter: 60,
				})
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}
