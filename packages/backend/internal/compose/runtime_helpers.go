package compose

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/go-chi/cors"

	"github.com/smithersai/smithers/packages/backend/internal/auth"
	"github.com/smithersai/smithers/packages/backend/internal/blob"
	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/email"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/observability"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/internal/sse"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
)

var apiCSRFBypassPaths = []string{
	// OAuth2 token exchange and revocation are anonymous/client-auth protocol
	// endpoints. They do not accept browser session credentials.
	"/api/oauth2/token",
	"/api/oauth2/revoke",
	// The authorize consent decision is a plain HTML form POST (it cannot
	// set the X-CSRF-Token header). It carries its own dedicated single-use
	// double-submit nonce (smithers_oauth2_authorize_csrf) enforced by
	// OAuth2Handler.PostAuthorizeDecision.
	"/api/oauth2/authorize",
}

// apiCSRFExemptRoutes are route patterns mounted outside apiCSRFMiddleware by
// design. The route coverage contract accepts them; they are not a runtime
// bypass, because ExcludePaths matches literal paths only.
var apiCSRFExemptRoutes = []string{
	// A box coding host's repository-job callbacks authenticate with its
	// flowhost binding ID and control credential. They read no session
	// cookie. Name them for the route coverage contract.
	"/api/gateways/{hostID}/repository-jobs/{job}",
	"/api/gateways/{hostID}/repository-jobs/{job}/trials/{requestID}",
	"/api/gateways/{hostID}/repository-jobs/{job}/comments/{step}",
	"/api/gateways/{hostID}/repository-jobs/{job}/manual/{requestID}",
	"/api/gateways/{hostID}/repository-jobs/ci/check-receipts/{requestID}",
}

func apiCSRFMiddleware(next http.Handler) http.Handler {
	return middleware.ExcludePaths(middleware.CSRF, apiCSRFBypassPaths...)(next)
}

type workspaceSessionQuotaRequest struct {
	WorkspaceID string `json:"workspace_id"`
}

// workspaceSessionWorkspaceLoader loads the workspace row a session create
// targets, so the quota middleware can tell a pure attach (workspace already
// running) from a request that will resume/reprovision a VM.
type workspaceSessionWorkspaceLoader interface {
	GetWorkspace(ctx context.Context, id string) (db.Workspace, error)
}

// workspaceSessionSandboxQuota gates POST /workspace/sessions:
//   - no workspace_id: the service reuses or creates the repo's primary
//     workspace → createQuotas (the per-user workspace-count cap fires in the
//     service on the create path, ticket 0105).
//   - workspace_id of a workspace already RUNNING with a VM: pure attach,
//     provisions nothing → no sandbox quotas (gating attaches on the
//     concurrent-sandbox count caused the 2026-07-08 "all terminals dead"
//     prod outage).
//   - workspace_id of anything else (suspended/stopped/failed/unknown): the
//     session path resumes or reprovisions a VM, so it must clear the same
//     quota stack as the dedicated /workspaces/{id}/resume route — skipping
//     on any non-empty workspace_id let users resume suspended sandboxes past
//     the caps (issue #20).
func workspaceSessionSandboxQuota(store workspaceSessionWorkspaceLoader, createQuotas, resumeQuotas []func(http.Handler) http.Handler) func(http.Handler) http.Handler {
	chain := func(next http.Handler, quotas []func(http.Handler) http.Handler) http.Handler {
		h := next
		for i := len(quotas) - 1; i >= 0; i-- {
			h = quotas[i](h)
		}
		return h
	}
	return func(next http.Handler) http.Handler {
		createHandler := chain(next, createQuotas)
		resumeHandler := chain(next, resumeQuotas)
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			workspaceID := workspaceSessionTargetWorkspaceID(r)
			if workspaceID == "" {
				createHandler.ServeHTTP(w, r)
				return
			}
			if store != nil {
				if workspace, err := store.GetWorkspace(r.Context(), workspaceID); err == nil &&
					workspace.Status == "running" && strings.TrimSpace(workspace.VmID) != "" {
					next.ServeHTTP(w, r)
					return
				}
			}
			resumeHandler.ServeHTTP(w, r)
		})
	}
}

// workspaceSessionTargetWorkspaceID extracts the workspace_id a session-create
// request targets ("" when absent or unreadable). The body is restored for the
// downstream handler.
func workspaceSessionTargetWorkspaceID(r *http.Request) string {
	if r == nil || r.Body == nil {
		return ""
	}
	body, err := io.ReadAll(r.Body)
	if err != nil {
		r.Body = io.NopCloser(bytes.NewReader(nil))
		return ""
	}
	_ = r.Body.Close()
	r.Body = io.NopCloser(bytes.NewReader(body))
	if len(bytes.TrimSpace(body)) == 0 {
		return ""
	}
	var req workspaceSessionQuotaRequest
	if err := json.Unmarshal(body, &req); err != nil {
		return ""
	}
	return strings.TrimSpace(req.WorkspaceID)
}

type inFlightRequestTracker struct {
	closing               atomic.Bool
	mu                    sync.Mutex
	cancels               map[uint64]*trackedRequest
	nextID                uint64
	active                atomic.Int64
	completed             atomic.Int64
	shutdownActive        atomic.Int64
	shutdownCompletedBase atomic.Int64
}

type trackedRequest struct {
	cancel context.CancelFunc
	forced bool // Set under mu before cancellation reaches the handler.
}

func newInFlightRequestTracker() *inFlightRequestTracker {
	return &inFlightRequestTracker{}
}

func (t *inFlightRequestTracker) Wrap(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if t.closing.Load() {
			http.Error(w, "server shutting down", http.StatusServiceUnavailable)
			return
		}
		ctx, cancel := context.WithCancel(r.Context())
		t.mu.Lock()
		if t.closing.Load() {
			t.mu.Unlock()
			cancel()
			http.Error(w, "server shutting down", http.StatusServiceUnavailable)
			return
		}
		if t.cancels == nil {
			t.cancels = make(map[uint64]*trackedRequest)
		}
		t.nextID++
		id := t.nextID
		request := &trackedRequest{cancel: cancel}
		t.cancels[id] = request
		t.active.Add(1)
		t.mu.Unlock()
		defer func() {
			t.mu.Lock()
			delete(t.cancels, id)
			if !request.forced {
				t.completed.Add(1)
			}
			t.active.Add(-1)
			t.mu.Unlock()
			cancel()
		}()
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func (t *inFlightRequestTracker) BeginShutdown() int64 {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.closing.Store(true)
	t.shutdownCompletedBase.Store(t.completed.Load())
	active := t.active.Load()
	t.shutdownActive.Store(active)
	return active
}

// WaitForDrain is used when a deployment mounts our handler on its own HTTP
// server. There is no internal http.Server listener to drain in that mode.
func (t *inFlightRequestTracker) WaitForDrain(ctx context.Context) error {
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	for t.active.Load() != 0 {
		select {
		case <-ctx.Done():
			t.cancelActive()
			grace, stop := context.WithTimeout(context.Background(), time.Second)
			defer stop()
			for t.active.Load() != 0 {
				select {
				case <-grace.Done():
					return ctx.Err()
				case <-ticker.C:
				}
			}
			return ctx.Err()
		case <-ticker.C:
		}
	}
	return nil
}

func (t *inFlightRequestTracker) cancelActive() {
	t.mu.Lock()
	defer t.mu.Unlock()
	for _, request := range t.cancels {
		request.forced = true
		request.cancel()
	}
}

func (t *inFlightRequestTracker) Snapshot() (drained, killed, activeRemaining int64) {
	initial := t.shutdownActive.Load()
	completedAfterShutdown := t.completed.Load() - t.shutdownCompletedBase.Load()
	if completedAfterShutdown < 0 {
		completedAfterShutdown = 0
	}
	if completedAfterShutdown > initial {
		completedAfterShutdown = initial
	}
	drained = completedAfterShutdown
	killed = initial - drained
	activeRemaining = t.active.Load()
	return drained, killed, activeRemaining
}

// perUserConcurrentSandboxCap bounds how many active sandbox VMs a single
// user may hold at once. Enforced by the PerUserConcurrentSandboxes
// middleware on workspace routes.
//
// Sizing: the original cap of 3 self-DoSed terminals the moment a second repo
// was open (2026-07-08 prod outage: every workspace/sessions create 429'd,
// when each opened repo also held a gateway VM). 10 keeps a real bound on
// Microsandbox spend while leaving headroom for a handful of concurrently
// open repos. A plan with a larger finite limit replaces it (see
// sandboxPlanAdmission).
const perUserConcurrentSandboxCap = 10

// sandboxPlanAdmission lets a plan whose concurrent-sandbox limit exceeds
// perUserConcurrentSandboxCap start sandboxes up to its own limit (Max: 64).
// The plan check still refuses at the plan limit. Unlimited billing keeps the
// default cap as its only per-user bound.
func sandboxPlanAdmission(policy services.BillingPolicy) middleware.SandboxPlanAdmission {
	if policy == nil {
		return nil
	}
	return func(ctx context.Context, userID int64) (bool, error) {
		if err := policy.AuthorizeSandboxStart(ctx, userID); err != nil {
			return false, err
		}
		entitlement, err := policy.SandboxEntitlement(ctx, userID)
		if err != nil {
			return false, err
		}
		limit, finite := entitlement.ConcurrentLimit()
		return finite && limit > perUserConcurrentSandboxCap, nil
	}
}

// appTimelineMaxRequestBodySize bounds app-timeline write bodies. Rewrites
// carry the whole dump (service-capped at 4 MiB of payload); JSON escaping
// can inflate past the global 1 MB default, so the timeline mount uses this
// larger cap.
const appTimelineMaxRequestBodySize int64 = 6 << 20

// joinedBackgroundWorker gives shutdown a concrete completion boundary for a
// worker that must finish cancellation cleanup before shared dependencies (in
// particular the database pool) are closed.
type joinedBackgroundWorker struct {
	done <-chan struct{}
}

func startJoinedBackgroundWorker(run func()) *joinedBackgroundWorker {
	done := make(chan struct{})
	go func() {
		defer close(done)
		run()
	}()
	return &joinedBackgroundWorker{done: done}
}

func (w *joinedBackgroundWorker) Wait(ctx context.Context) error {
	if w == nil || w.done == nil {
		return nil
	}
	select {
	case <-w.done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// exitFn is the process-exit hook used only by main(). Tests override it to
// record the requested exit code instead of terminating the test binary.
var exitFn = os.Exit

// Startup seams. Each var defaults to the real construction path so the shipped
// binary behaves identically; tests override them to reach otherwise-unreachable
// or externally-dependent branches. See the run()-harness tests.
var (
	netListen         = net.Listen
	onListen          = func(net.Listener) {}
	otelInit          = observability.Init
	shutdownTimeoutFn = serverShutdownTimeout
	startSSEBroker    = (*sse.Broker).Start
	newEmailTransport = initEmailTransport
	newSecretCodec    = func(keys config.WebhookConfig) (*webhook.AESGCMSecretCodec, error) {
		return webhook.NewSecretCodec(keys.SecretEncryptionKey, keys.PreviousKeys()...)
	}
	newBlobStore = initializeBlobStore
)

// flagParseError wraps a flag-parsing failure so exitCodeFor can preserve the
// historical flag.ExitOnError exit code of 2 while run() still returns an error.
type flagParseError struct{ err error }

func (e *flagParseError) Error() string { return e.err.Error() }
func (e *flagParseError) Unwrap() error { return e.err }

// exitCodeFor maps a run() error to a process exit code. Flag-parse failures
// exit 2 (matching flag.ExitOnError's os.Exit(2)); every other failure exits 1.
func exitCodeFor(err error) int {
	var fpe *flagParseError
	if errors.As(err, &fpe) {
		return 2
	}
	return 1
}

func apiAllowedOrigins(cfg *config.Config) []string {
	if cfg == nil {
		return nil
	}

	if len(cfg.Server.AllowedOrigins) > 0 {
		// An explicitly configured but invalid allowlist fails closed. Startup
		// validation reports the bad value; unit-built routers must not silently
		// fall back to a different trusted origin meanwhile.
		return normalizeAllowedOrigins(cfg.Server.AllowedOrigins)
	}

	baseURL := config.PublicOrigin(cfg)

	origin, err := config.CanonicalOrigin(baseURL)
	if err != nil {
		slog.Warn("invalid public API origin for CORS allowlist", "base_url", baseURL, "error", err)
		return nil
	}

	return []string{origin}
}

func normalizeAllowedOrigins(values []string) []string {
	var origins []string
	seen := make(map[string]struct{})
	for _, value := range values {
		for _, raw := range strings.Split(value, ",") {
			raw = strings.TrimSpace(raw)
			if raw == "" {
				continue
			}
			origin, err := config.CanonicalOrigin(raw)
			if err != nil {
				slog.Warn("invalid server.allowed_origins entry for API CORS origin allowlist", "origin", raw, "error", err)
				continue
			}
			key := strings.ToLower(origin)
			if _, ok := seen[key]; ok {
				continue
			}
			seen[key] = struct{}{}
			origins = append(origins, origin)
		}
	}
	return origins
}

func buildRateLimitRejectObserver(metrics *routes.SmithersMetrics) middleware.RateLimitRejectObserver {
	if metrics == nil || metrics.RateLimitRejectionsTotal == nil {
		return nil
	}
	return func(scope string) {
		metrics.RateLimitRejectionsTotal.WithLabelValues(scope).Inc()
	}
}

func buildAuthProviders(cfg config.AuthConfig, credentials auth.GitHubOAuthCredentialSource, budget *services.BudgetTracker) (services.KeyAuthVerifier, services.GitHubAuthClient, error) {
	keyAuthVerifier := auth.NewKeyAuthVerifier()
	var githubClient services.GitHubAuthClient
	if credentials != nil {
		githubClient = auth.NewGitHubClient(
			credentials,
			cfg.GitHubRedirectURL,
			cfg.GitHubOAuthBaseURL,
			cfg.GitHubAPIBaseURL,
			auth.WithGitHubBudget(budget),
		)
	}

	return keyAuthVerifier, githubClient, nil
}

var apiJSONTimeout = 30 * time.Second

func selectBlobStore(ctx context.Context, cfg config.BlobConfig, provided blob.Store) (blob.Store, io.Closer, time.Duration, error) {
	if provided == nil {
		return newBlobStore(ctx, cfg)
	}
	expiry, err := blob.ParseSignedURLExpiry(cfg.SignedURLExpiry)
	if err != nil {
		return nil, nil, 0, err
	}
	return provided, nil, expiry, nil
}

const defaultLFSVerifyJSONTimeout = 10 * time.Minute
const lfsVerifyWriteTimeoutHeadroom = 5 * time.Second

// lfsVerifyTimeout is deliberately much longer than the ordinary JSON API
// budget: verification streams and hashes the complete object from blob
// storage. When the HTTP server has a finite write timeout, do not pretend the
// middleware can outlive it.
func lfsVerifyTimeout(cfg *config.Config) time.Duration {
	if cfg != nil && cfg.Server.WriteTimeoutSecs > 0 {
		serverWriteTimeout := time.Duration(cfg.Server.WriteTimeoutSecs) * time.Second
		headroom := lfsVerifyWriteTimeoutHeadroom
		if serverWriteTimeout <= 2*headroom {
			headroom = serverWriteTimeout / 2
		}
		middlewareBudget := serverWriteTimeout - headroom
		if middlewareBudget < defaultLFSVerifyJSONTimeout {
			return middlewareBudget
		}
	}
	return defaultLFSVerifyJSONTimeout
}

func buildHTTPServer(cfg *config.Config, handler http.Handler) *http.Server {
	return &http.Server{
		Addr:         cfg.Server.Addr,
		Handler:      handler,
		ReadTimeout:  time.Duration(cfg.Server.ReadTimeoutSecs) * time.Second,
		WriteTimeout: time.Duration(cfg.Server.WriteTimeoutSecs) * time.Second,
	}
}

func serverShutdownTimeout(cfg config.ServerConfig) (time.Duration, error) {
	timeout, err := time.ParseDuration(strings.TrimSpace(cfg.ShutdownTimeout))
	if err != nil {
		return 0, fmt.Errorf("server.shutdown_timeout is invalid: %w", err)
	}
	if timeout <= 0 {
		return 0, fmt.Errorf("server.shutdown_timeout must be > 0")
	}
	return timeout, nil
}

// initializeBlobStore creates the durable single-owner filesystem adapter.
// Hosted cloud storage is injected explicitly through the public app config.
func initializeBlobStore(_ context.Context, cfg config.BlobConfig) (blob.Store, io.Closer, time.Duration, error) {
	// Parse expiry first (needed for both adapters).
	expiry, err := blob.ParseSignedURLExpiry(cfg.SignedURLExpiry)
	if err != nil {
		return nil, nil, 0, fmt.Errorf("invalid signed URL expiry: %w", err)
	}

	baseURL := strings.TrimSpace(cfg.TransferBaseURL)
	if baseURL == "" {
		baseURL = "http://localhost:4000"
	}
	store, err := blob.NewFilesystemStore(blob.FilesystemConfig{
		Root:          cfg.DataDir,
		PublicBaseURL: baseURL,
		SigningKey:    []byte(cfg.TransferSigningKey),
		MaxBytes:      cfg.MaxBytes,
		ReserveBytes:  cfg.ReserveBytes,
	})
	if err != nil {
		return nil, nil, 0, fmt.Errorf("initialize filesystem blob store: %w", err)
	}
	return store, store, expiry, nil
}

// selectAgentLogStore preserves the host's transcript adapter. Local storage
// keeps transcripts in the same durable root as its filesystem blobs.
func selectAgentLogStore(store blob.Store, provided services.AgentLogStore) (services.AgentLogStore, error) {
	if provided != nil {
		return provided, nil
	}
	if filesystem, ok := store.(*blob.FilesystemStore); ok {
		return blob.NewFilesystemAgentLogStore(filesystem), nil
	}
	return nil, errors.New("an injected blob adapter requires an injected agent-log adapter")
}

func mountBlobTransferHandler(next http.Handler, store blob.Store, cfg *config.Config) http.Handler {
	transfers, ok := store.(blob.TransferHandlerProvider)
	if !ok {
		return next
	}
	mux := http.NewServeMux()
	mux.Handle("/api/blob-transfer/", cors.Handler(apiCORSOptions(cfg))(transfers.TransferHandler()))
	mux.Handle("/", next)
	return mux
}

func apiCORSOptions(cfg *config.Config) cors.Options {
	allowedOrigins := apiAllowedOrigins(cfg)
	return cors.Options{
		AllowOriginFunc: func(_ *http.Request, origin string) bool {
			for _, allowedOrigin := range allowedOrigins {
				if strings.EqualFold(origin, allowedOrigin) {
					return true
				}
			}
			return false
		},
		AllowedMethods:   []string{"GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"},
		AllowedHeaders:   []string{"Accept", "Authorization", "Content-Type", "X-CSRF-Token", "X-Smithers-Bootstrap-Token"},
		ExposedHeaders:   []string{"Link", "Retry-After", "X-RateLimit-Limit", "X-RateLimit-Remaining", "X-RateLimit-Reset"},
		AllowCredentials: true,
		MaxAge:           300,
	}
}

// initEmailTransport creates an email transport from config using the factory.
// SMTP is the only public email transport.
func initEmailTransport(cfg config.EmailConfig) (email.Transport, error) {
	return email.NewTransport(email.TransportConfig{
		SMTP: email.SMTPConfig{
			Host: cfg.SMTPHost,
			Port: cfg.SMTPPort,
			User: cfg.SMTPUser,
			Pass: cfg.SMTPPass,
			From: cfg.SMTPFrom,
		},
	})
}
