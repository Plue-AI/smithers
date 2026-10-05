// Package services: shared GitHub API budget admission.
// The install observes upstream resource limits and stream pauses; hosted
// deployments retain their existing token-bucket policy.
package services

import (
	"crypto/sha256"
	"fmt"
	"math"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// GitHubInstallationHourlyBudget is GitHub's documented per-installation
// rate-limit budget for app-authenticated requests.
const GitHubInstallationHourlyBudget = 5000

// BudgetTracker shares process-local admission among GitHub clients. The
// install constructor selects response-header accounting; the hosted
// constructor retains its existing per-installation rolling token bucket.
type BudgetTracker struct {
	mu              sync.Mutex
	buckets         map[int64]*budgetEntry
	capacity        int
	window          time.Duration
	now             func() time.Time
	headers         bool
	resources       map[string]GitHubRateLimit
	pauses          map[string]time.Time
	streamResources map[string]string
	tokenPrincipals map[[32]byte]gitHubTokenPrincipal
}

type budgetEntry struct {
	tokens     float64
	lastRefill time.Time
}

// GitHubRateLimit is a point-in-time view of an installation's locally
// tracked GitHub API budget. ResetAt is when the bucket will be full again.
type GitHubRateLimit struct {
	Limit     int
	Remaining int
	ResetAt   time.Time
}

// NewBudgetTracker returns a tracker with the default 5000/hour budget.
func NewBudgetTracker() *BudgetTracker {
	return NewBudgetTrackerWithLimits(GitHubInstallationHourlyBudget, time.Hour)
}

// NewBudgetTrackerWithLimits is the configurable constructor (for tests).
func NewBudgetTrackerWithLimits(capacity int, window time.Duration) *BudgetTracker {
	if capacity <= 0 {
		capacity = GitHubInstallationHourlyBudget
	}
	if window <= 0 {
		window = time.Hour
	}
	return &BudgetTracker{
		buckets:  make(map[int64]*budgetEntry),
		capacity: capacity,
		window:   window,
		now:      func() time.Time { return time.Now().UTC() },
	}
}

// Allow returns true if the given installation has at least one request of
// budget remaining and consumes it. Returns false (and the duration until one
// request refills) if the bucket is empty.
func (t *BudgetTracker) Allow(installationID int64) (allowed bool, retryAfter time.Duration) {
	allowed, retryAfter, _ = t.AllowWithStatus(installationID)
	return allowed, retryAfter
}

// AllowWithStatus consumes one request from an installation's budget and
// returns the resulting budget snapshot. When the request is refused,
// retryAfter is the duration until one request refills; ResetAt in the
// snapshot stays the time the bucket is full again.
//
// The bucket is per process: N API replicas together allow N times the
// budget. GitHub's own 403/429 still bounds the installation.
func (t *BudgetTracker) AllowWithStatus(installationID int64) (allowed bool, retryAfter time.Duration, status GitHubRateLimit) {
	if t == nil {
		return true, 0, GitHubRateLimit{}
	}
	t.mu.Lock()
	defer t.mu.Unlock()

	now := t.now().UTC()
	if t.headers {
		receipt := t.resources[fmt.Sprintf("installation:%d/core", installationID)]
		if receipt.Limit == 0 || !now.Before(receipt.ResetAt) {
			return true, 0, GitHubRateLimit{}
		}
		if receipt.Remaining == 0 {
			return false, receipt.ResetAt.Sub(now), receipt
		}
		return true, 0, receipt
	}
	entry := t.refillLocked(installationID, now)

	if entry.tokens >= 1 {
		entry.tokens -= 1
		return true, 0, t.statusLocked(entry.tokens, now)
	}

	status = t.statusLocked(entry.tokens, now)
	refillPerSecond := float64(t.capacity) / t.window.Seconds()
	retryAfter = time.Duration(math.Ceil((1-entry.tokens)/refillPerSecond)) * time.Second
	if retryAfter <= 0 {
		retryAfter = time.Second
	}
	return false, retryAfter, status
}

// Remaining returns the current approximate remaining budget for an
// installation. Useful for observability / metrics.
func (t *BudgetTracker) Remaining(installationID int64) int {
	return t.Status(installationID).Remaining
}

// Status returns the current limit, remaining requests, and full reset time
// for an installation without consuming budget.
func (t *BudgetTracker) Status(installationID int64) GitHubRateLimit {
	if t == nil {
		return GitHubRateLimit{}
	}
	t.mu.Lock()
	defer t.mu.Unlock()

	now := t.now().UTC()
	if t.headers {
		receipt := t.resources[fmt.Sprintf("installation:%d/core", installationID)]
		if !now.Before(receipt.ResetAt) {
			return GitHubRateLimit{}
		}
		return receipt
	}
	_, ok := t.buckets[installationID]
	if !ok {
		return GitHubRateLimit{
			Limit:     t.capacity,
			Remaining: t.capacity,
			ResetAt:   now.Add(t.window),
		}
	}
	entry := t.refillLocked(installationID, now)
	return t.statusLocked(entry.tokens, now)
}

func (t *BudgetTracker) refillLocked(installationID int64, now time.Time) *budgetEntry {
	refillPerSecond := float64(t.capacity) / t.window.Seconds()
	entry, ok := t.buckets[installationID]
	if !ok {
		entry = &budgetEntry{tokens: float64(t.capacity), lastRefill: now}
		t.buckets[installationID] = entry
		return entry
	}

	elapsed := now.Sub(entry.lastRefill).Seconds()
	if elapsed > 0 {
		entry.tokens += elapsed * refillPerSecond
		if entry.tokens > float64(t.capacity) {
			entry.tokens = float64(t.capacity)
		}
		entry.lastRefill = now
	}
	return entry
}

func (t *BudgetTracker) statusLocked(tokens float64, now time.Time) GitHubRateLimit {
	if tokens < 0 {
		tokens = 0
	}
	if tokens > float64(t.capacity) {
		tokens = float64(t.capacity)
	}

	secondsUntilFull := (float64(t.capacity) - tokens) / (float64(t.capacity) / t.window.Seconds())
	resetAfter := time.Duration(math.Ceil(secondsUntilFull)) * time.Second
	if resetAfter <= 0 {
		resetAfter = t.window
	}
	return GitHubRateLimit{
		Limit:     t.capacity,
		Remaining: int(tokens),
		ResetAt:   now.Add(resetAfter),
	}
}

// GitHubRetryAt is the single rate-limit header parser. Retry-After takes
// precedence over the primary reset, including GitHub's HTTP-date form.
// Missing or malformed headers still yield a positive retry delay.
func GitHubRetryAt(header http.Header, now time.Time) time.Time {
	value := strings.TrimSpace(header.Get("Retry-After"))
	if seconds, err := strconv.ParseInt(value, 10, 64); err == nil && seconds > 0 {
		// Bound the conversion, not the upstream pause: a huge value must not wrap.
		if seconds > int64((1<<63-1)/int64(time.Second)) {
			return now.Add(time.Duration(1<<63 - 1))
		}
		return now.Add(time.Duration(seconds) * time.Second)
	}
	if at, err := http.ParseTime(value); err == nil && at.After(now) {
		return at
	}
	if reset, err := strconv.ParseInt(strings.TrimSpace(header.Get("X-RateLimit-Reset")), 10, 64); err == nil && reset > now.Unix() {
		return time.Unix(reset, 0).UTC()
	}
	return now.Add(time.Second)
}

// gitHubRateLimitError classifies both primary and secondary refusals. It
// consumes only response status/headers, never GitHub's untrusted error body.
// Non-rate-limit statuses remain available to callers (for example a missing
// optional object is still a 404, rather than a failed request).
func gitHubRateLimitError(status int, header http.Header, now time.Time) *pkgerrors.APIError {
	if status != http.StatusTooManyRequests && (status != http.StatusForbidden ||
		(strings.TrimSpace(header.Get("Retry-After")) == "" && strings.TrimSpace(header.Get("X-RateLimit-Remaining")) != "0")) {
		return nil
	}
	retryAt := GitHubRetryAt(header, now).UTC()
	err := pkgerrors.New(pkgerrors.CodeGitHubRateLimited, "GitHub rate limit reached")
	err.RetryAt = &retryAt
	err.RetryAfter = int(math.Ceil(retryAt.Sub(now).Seconds()))
	return err
}

// GitHubRateLimitHeaders returns only complete, valid primary-limit receipts.
// An incomplete receipt must never invent remaining capacity.
func GitHubRateLimitHeaders(header http.Header) (string, GitHubRateLimit, bool) {
	resource := strings.TrimSpace(header.Get("X-RateLimit-Resource"))
	if resource == "" {
		resource = "core"
	}
	limit, e1 := strconv.Atoi(header.Get("X-RateLimit-Limit"))
	remaining, e2 := strconv.Atoi(header.Get("X-RateLimit-Remaining"))
	reset, e3 := strconv.ParseInt(header.Get("X-RateLimit-Reset"), 10, 64)
	if e1 != nil || e2 != nil || e3 != nil || limit <= 0 || remaining < 0 || remaining > limit || reset <= 0 {
		return resource, GitHubRateLimit{}, false
	}
	return resource, GitHubRateLimit{Limit: limit, Remaining: remaining, ResetAt: time.Unix(reset, 0).UTC()}, true
}

// NewGitHubResponseBudgetTracker selects upstream accounting for the install.
// Hosted deployments retain their existing token bucket; install calls have no
// hourly request-count cap and no linear refill between GitHub resets.
func NewGitHubResponseBudgetTracker() *BudgetTracker {
	t := NewBudgetTracker()
	t.headers = true
	t.resources = make(map[string]GitHubRateLimit)
	t.pauses = make(map[string]time.Time)
	t.streamResources = make(map[string]string)
	t.tokenPrincipals = make(map[[32]byte]gitHubTokenPrincipal)
	return t
}

type gitHubTokenPrincipal struct {
	key     string
	expires time.Time
}

func (t *BudgetTracker) registerToken(token string, installationID int64, expires time.Time) {
	t.registerCredential(token, fmt.Sprintf("installation:%d", installationID), expires)
}

// Called only by the credential source after signing with its loaded App key.
// Incoming JWT claims never supply trusted accounting identity.
func (t *BudgetTracker) registerAppToken(token string, appID int64, expires time.Time) {
	t.registerCredential(token, fmt.Sprintf("app:%d", appID), expires)
}

func (t *BudgetTracker) registerCredential(token, principal string, expires time.Time) {
	if t == nil || !t.headers {
		return
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	now := t.now()
	for digest, known := range t.tokenPrincipals {
		if !known.expires.After(now) {
			delete(t.tokenPrincipals, digest)
		}
	}
	if token != "" && expires.After(now) {
		t.tokenPrincipals[sha256.Sum256([]byte("Bearer "+token))] = gitHubTokenPrincipal{principal, expires}
	}
}

// StreamCadence changes only the low-priority streams, until the resource reset.
func (t *BudgetTracker) StreamCadence(installationID int64, stream string, base time.Duration) time.Duration {
	if t == nil || !t.headers {
		return base
	}
	if stream != "issues" && stream != "issue-events" && stream != "permissions" {
		return base
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	resource := "core"
	key := fmt.Sprintf("installation:%d", installationID)
	if value := t.streamResources[key+"/"+stream]; value != "" {
		resource = value
	}
	receipt, ok := t.resources[key+"/"+resource]
	if ok && t.now().Before(receipt.ResetAt) && float64(receipt.Remaining) < float64(receipt.Limit)*0.2 {
		return 2 * base
	}
	return base
}

// StreamRetryAt exposes shared admission to the existing pollers, so a paused
// stream does not attempt even token minting. Expired receipts do not pause it.
func (t *BudgetTracker) StreamRetryAt(installationID int64, stream string) time.Time {
	if t == nil || !t.headers {
		return time.Time{}
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	key := fmt.Sprintf("installation:%d", installationID)
	resource := t.streamResources[key+"/"+stream]
	if resource == "" {
		resource = "core"
	}
	retryAt := t.pauses[key+"/"+stream]
	if receipt, ok := t.resources[key+"/"+resource]; ok && receipt.Remaining == 0 && receipt.ResetAt.After(retryAt) {
		retryAt = receipt.ResetAt
	}
	if !retryAt.After(t.now()) {
		return time.Time{}
	}
	return retryAt
}

// WrapClient shares admission/accounting across existing callers without
// changing their authentication, body handling or retry policy.
func (t *BudgetTracker) WrapClient(client *http.Client) *http.Client {
	if t == nil || !t.headers {
		return client
	}
	copy := *client
	base := copy.Transport
	if base == nil {
		base = http.DefaultTransport
	}
	copy.Transport = &gitHubBudgetTransport{tracker: t, base: base}
	return &copy
}

type gitHubBudgetTransport struct {
	tracker *BudgetTracker
	base    http.RoundTripper
}

func (b *gitHubBudgetTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	t := b.tracker
	digest := sha256.Sum256([]byte(req.Header.Get("Authorization")))
	stream := gitHubBudgetStream(req.URL.Path)
	t.mu.Lock()
	principal := fmt.Sprintf("credential:%x", digest)
	if known, ok := t.tokenPrincipals[digest]; ok {
		if known.expires.After(t.now()) {
			principal = known.key
		} else {
			delete(t.tokenPrincipals, digest)
		}
	}
	// Token minting is accounted before the token exists, using its installation.
	parts := strings.Split(strings.Trim(req.URL.Path, "/"), "/")
	if len(parts) == 4 && parts[0] == "app" && parts[1] == "installations" && parts[3] == "access_tokens" {
		if id, err := strconv.ParseInt(parts[2], 10, 64); err == nil && id > 0 {
			principal = fmt.Sprintf("installation:%d", id)
		}
	}
	streamKey := principal + "/" + stream
	resource := t.streamResources[streamKey]
	if resource == "" {
		resource = "core"
		if req.URL.Path == "/graphql" {
			resource = "graphql"
		}
		if strings.HasPrefix(req.URL.Path, "/search/") {
			resource = "search"
		}
	}
	resourceKey := principal + "/" + resource
	now := t.now().UTC()
	retryAt := t.pauses[streamKey]
	receipt, known := t.resources[resourceKey]
	if known && !now.Before(receipt.ResetAt) {
		delete(t.resources, resourceKey)
		known = false
	}
	if known && receipt.Remaining == 0 && receipt.ResetAt.After(retryAt) {
		retryAt = receipt.ResetAt
	}
	if retryAt.After(now) {
		t.mu.Unlock()
		// A local refusal is a response, so existing HTTP callers retain their
		// status/error handling and cannot accidentally retry an ambiguous write.
		header := make(http.Header)
		header.Set("Retry-After", strconv.FormatInt(int64(math.Ceil(retryAt.Sub(now).Seconds())), 10))
		return &http.Response{StatusCode: 429, Status: "429 Too Many Requests", Header: header, Body: http.NoBody, Request: req}, nil
	}
	// Reserve against observed headroom while requests are in flight. The
	// response below replaces this reservation, and 304 never adds a debit.
	if known {
		receipt.Remaining--
		t.resources[resourceKey] = receipt
	}
	t.mu.Unlock()
	resp, err := b.base.RoundTrip(req)
	t.mu.Lock()
	defer t.mu.Unlock()
	if err != nil {
		return nil, err
	} // conservative reservation; no invented refund
	if receivedResource, received, valid := GitHubRateLimitHeaders(resp.Header); valid {
		key := principal + "/" + receivedResource
		if known && receivedResource != resource {
			current := t.resources[resourceKey]
			if current.ResetAt.Equal(receipt.ResetAt) {
				current.Remaining = min(current.Remaining+1, current.Limit)
				t.resources[resourceKey] = current
			}
		}
		previous, exists := t.resources[key]
		// Out-of-order responses must not restore already spent capacity.
		if exists && previous.ResetAt.Equal(received.ResetAt) {
			ceiling := previous.Remaining
			if resp.StatusCode == http.StatusNotModified && known {
				ceiling++
			}
			if received.Remaining > ceiling {
				received.Remaining = ceiling
			}
		}
		if !exists || !previous.ResetAt.After(received.ResetAt) {
			t.resources[key] = received
		}
		t.streamResources[streamKey] = receivedResource
	} else if resp.StatusCode == http.StatusNotModified && known {
		current := t.resources[resourceKey]
		if current.ResetAt.Equal(receipt.ResetAt) {
			current.Remaining++
			t.resources[resourceKey] = current
		}
	}
	if (resp.StatusCode == 403 || resp.StatusCode == 429) && strings.TrimSpace(resp.Header.Get("Retry-After")) != "" {
		at := GitHubRetryAt(resp.Header, t.now().UTC())
		if at.After(t.pauses[streamKey]) {
			t.pauses[streamKey] = at
		}
	}
	return resp, nil
}

func gitHubBudgetStream(path string) string {
	parts := strings.Split(strings.Trim(path, "/"), "/")
	if len(parts) >= 4 && parts[0] == "repos" {
		suffix := strings.Join(parts[3:], "/")
		switch {
		case suffix == "issues/events":
			return "issue-events"
		case suffix == "issues/comments":
			return "conversation-comments"
		case suffix == "pulls/comments":
			return "review-comments"
		case strings.HasPrefix(suffix, "collaborators/"):
			return "permissions"
		case parts[3] == "issues":
			return "issues"
		case parts[3] == "pulls":
			return "pulls"
		case parts[3] == "commits":
			return "checks"
		}
	}
	return path
}
