package compose

import (
	"bytes"
	"context"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"

	"github.com/smithersai/smithers/packages/backend/internal/blob"
	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/email"
	"github.com/smithersai/smithers/packages/backend/internal/sse"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
)

// ---------------------------------------------------------------------------
// Test seam plumbing
// ---------------------------------------------------------------------------

// swapVar assigns v to *target for the duration of the test and restores the
// previous value via t.Cleanup. Keeps the shipped defaults authoritative.
func swapVar[T any](t *testing.T, target *T, v T) {
	t.Helper()
	prev := *target
	*target = v
	t.Cleanup(func() { *target = prev })
}

// syncBuffer is a mutex-guarded bytes.Buffer. run() hands it to slog as the
// stderr writer; worker goroutines may briefly log after run() returns, so all
// access is serialized.
type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

// ---------------------------------------------------------------------------
// DB fixture
// ---------------------------------------------------------------------------

// composeTestDatabase is this test binary's own product database.
var composeTestDatabase postgresfixture.Suite

func TestMain(m *testing.M) {
	os.Exit(composeTestDatabase.Run(m))
}

// testDatabaseURL returns the package's product database, skipping the test
// (or failing it when database tests are required) without a server.
func testDatabaseURL(t *testing.T) string {
	t.Helper()
	return composeTestDatabase.URL(t)
}

// ---------------------------------------------------------------------------
// run() drivers
// ---------------------------------------------------------------------------

func baseRunEnv(t *testing.T) map[string]string {
	t.Helper()
	return map[string]string{
		"SMITHERS_DATABASE_URL":                  testDatabaseURL(t),
		"SMITHERS_BLOB_DATA_DIR":                 t.TempDir(),
		"SMITHERS_AUTH_MODE":                     "selfhost",
		"SMITHERS_AUTH_SESSION_SECRET":           "test-secret",
		"SMITHERS_LFS_SIGNING_SECRET":            "test-lfs-signing-secret",
		"SMITHERS_WEBHOOK_SECRET_ENCRYPTION_KEY": "test-webhook-key",
		"SMITHERS_REPO_HOST_AUTH_TOKEN":          "repo-token",
		"SMITHERS_PUSH_HOOK_CALLBACK_TOKEN":      "push-callback-token",
		"SMITHERS_SERVER_ADDR":                   "127.0.0.1:0",
		"SMITHERS_PUBLIC_URL":                    "http://127.0.0.1:4000",
		"SMITHERS_FEATURE_FLAGS_WORKFLOWS":       "false",
		"SMITHERS_FEATURE_FLAGS_SANDBOXES":       "false",
		"SMITHERS_FEATURE_FLAGS_WORKSPACES":      "false",
	}
}

func applyEnv(t *testing.T, env map[string]string) {
	t.Helper()
	for k, v := range env {
		t.Setenv(k, v)
	}
}

func preserveSlog(t *testing.T) {
	t.Helper()
	prev := slog.Default()
	t.Cleanup(func() { slog.SetDefault(prev) })
}

// stubSSEBroker replaces the real (*sse.Broker).Start with a no-op success so
// tests never spin up the broker's dispatch goroutine. This both keeps run()
// tests fast and avoids a pre-existing broker Stop()/pool.Close() race that can
// panic when run() returns quickly after the broker has started. The run()
// call site (and its nil-error branch) is still covered; only the sse package's
// own Start body — irrelevant to cmd/server coverage — is skipped.
func stubSSEBroker(t *testing.T) {
	t.Helper()
	swapVar(t, &startSSEBroker, func(*sse.Broker, context.Context) error { return nil })
}

// runAsync launches run() in a background goroutine with a cancelable context
// (canceled on cleanup so any leaked shutdown goroutine exits). It does not
// touch the onListen seam — callers wire it as needed.
func runAsync(t *testing.T, env map[string]string, args ...string) (chan error, *syncBuffer, context.CancelFunc) {
	t.Helper()
	applyEnv(t, env)
	preserveSlog(t)
	stubSSEBroker(t)

	logs := &syncBuffer{}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)

	errCh := make(chan error, 1)
	go func() { errCh <- run(ctx, args, io.Discard, logs) }()
	return errCh, logs, cancel
}

type runHarness struct {
	t      *testing.T
	ln     net.Listener
	errCh  chan error
	cancel context.CancelFunc
	logs   *syncBuffer
}

// startRun starts a full server, waits until it is listening (via the onListen
// seam), and returns a harness for driving requests and shutdown.
func startRun(t *testing.T, env map[string]string, args ...string) *runHarness {
	t.Helper()
	lnCh := make(chan net.Listener, 1)
	swapVar(t, &onListen, func(ln net.Listener) { lnCh <- ln })

	errCh, logs, cancel := runAsync(t, env, args...)

	select {
	case ln := <-lnCh:
		return &runHarness{t: t, ln: ln, errCh: errCh, cancel: cancel, logs: logs}
	case err := <-errCh:
		t.Fatalf("run returned before listening: %v\nlogs:\n%s", err, logs.String())
	case <-time.After(15 * time.Second):
		t.Fatalf("run did not start listening within 15s\nlogs:\n%s", logs.String())
	}
	return nil
}

func (h *runHarness) addr() string { return h.ln.Addr().String() }

func (h *runHarness) get(path string) (*http.Response, error) {
	client := &http.Client{Timeout: 5 * time.Second}
	return client.Get("http://" + h.addr() + path)
}

// shutdownAndWaitNil cancels the context to drive the graceful-shutdown path
// and requires run() to return nil within 20s.
func (h *runHarness) shutdownAndWaitNil() {
	h.t.Helper()
	h.cancel()
	select {
	case err := <-h.errCh:
		require.NoError(h.t, err, "run should return nil after graceful shutdown\nlogs:\n%s", h.logs.String())
	case <-time.After(20 * time.Second):
		h.t.Fatalf("run did not return after shutdown within 20s\nlogs:\n%s", h.logs.String())
	}
}

func (h *runHarness) waitErr() error {
	h.t.Helper()
	select {
	case err := <-h.errCh:
		return err
	case <-time.After(20 * time.Second):
		h.t.Fatalf("run did not return within 20s\nlogs:\n%s", h.logs.String())
	}
	return nil
}

// ---------------------------------------------------------------------------
// main() wrapper
// ---------------------------------------------------------------------------

func TestMainWrapper_ExitCodes(t *testing.T) {
	preserveSlog(t)

	// Config-load failure -> exit code 1.
	var code int
	swapVar(t, &exitFn, func(c int) { code = c })
	swapVar(t, &os.Args, []string{"smithers-server", "-config", "/nonexistent-cmdserver.yaml"})
	code = -1
	main()
	assert.Equal(t, 1, code, "config error should exit 1")

	// Bad flag -> exit code 2 (flag-parse sentinel).
	swapVar(t, &os.Args, []string{"smithers-server", "-bogus-flag"})
	code = -1
	main()
	assert.Equal(t, 2, code, "flag parse error should exit 2")
}

// ---------------------------------------------------------------------------
// run() error paths (fail before Serve; called synchronously)
// ---------------------------------------------------------------------------

func TestRun_FlagParseError(t *testing.T) {
	preserveSlog(t)
	stderr := &syncBuffer{}
	err := run(context.Background(), []string{"-bogus-flag"}, io.Discard, stderr)
	require.Error(t, err)
	var fpe *flagParseError
	require.True(t, errors.As(err, &fpe), "expected flagParseError")
	assert.Equal(t, 2, exitCodeFor(err))
	assert.Contains(t, stderr.String(), "flag provided but not defined")
}

func TestRun_ConfigLoadError(t *testing.T) {
	preserveSlog(t)
	stderr := &syncBuffer{}
	err := run(context.Background(), []string{"-config", "/nonexistent-cmdserver.yaml"}, io.Discard, stderr)
	require.Error(t, err)
	assert.Equal(t, 1, exitCodeFor(err))
	assert.Contains(t, stderr.String(), "failed to load config")
}

func TestRun_InvalidStartupConfig(t *testing.T) {
	preserveSlog(t)
	// Empty database URL fails ValidateServerStartup.
	t.Setenv("SMITHERS_AUTH_MODE", "selfhost")
	t.Setenv("SMITHERS_DATABASE_URL", "")
	t.Setenv("SMITHERS_AUTH_SESSION_SECRET", "s")
	t.Setenv("SMITHERS_WEBHOOK_SECRET_ENCRYPTION_KEY", "k")
	t.Setenv("SMITHERS_REPO_HOST_AUTH_TOKEN", "tok")
	stderr := &syncBuffer{}
	err := run(context.Background(), nil, io.Discard, stderr)
	require.Error(t, err)
	assert.Contains(t, stderr.String(), "invalid startup config")
}

func TestRun_InvalidShutdownTimeout(t *testing.T) {
	preserveSlog(t)
	applyEnv(t, baseRunEnv(t))
	// config.ValidateServerStartup already rejects an unparseable
	// shutdown_timeout, so run()'s own re-parse error branch is only reachable
	// via the seam. Swap it to force the error and cover lines 172-176.
	swapVar(t, &shutdownTimeoutFn, func(config.ServerConfig) (time.Duration, error) {
		return 0, errors.New("bad shutdown timeout")
	})
	stderr := &syncBuffer{}
	err := run(context.Background(), nil, io.Discard, stderr)
	require.Error(t, err)
	assert.Contains(t, stderr.String(), "invalid server shutdown timeout")
}

func TestRun_DBConnectError(t *testing.T) {
	preserveSlog(t)
	env := baseRunEnv(t)
	env["SMITHERS_DATABASE_URL"] = "postgres://x@127.0.0.1:1/x?sslmode=disable&connect_timeout=1"
	applyEnv(t, env)
	stderr := &syncBuffer{}
	err := run(context.Background(), nil, io.Discard, stderr)
	require.Error(t, err)
	assert.Contains(t, stderr.String(), "failed to connect to database")
}

func TestRun_OtelInitFailureFailsStartup(t *testing.T) {
	preserveSlog(t)
	// An exporter that is configured but cannot be built is a misconfiguration:
	// startup must fail instead of running silently without traces.
	swapVar(t, &otelInit, func(context.Context, config.ObservabilityConfig) (*sdktrace.TracerProvider, error) {
		return nil, errors.New("otel down")
	})
	env := baseRunEnv(t)
	env["SMITHERS_DATABASE_URL"] = "postgres://x@127.0.0.1:1/x?sslmode=disable&connect_timeout=1"
	applyEnv(t, env)
	stderr := &syncBuffer{}
	err := run(context.Background(), nil, io.Discard, stderr)
	require.ErrorContains(t, err, "otel down")
	assert.NotContains(t, stderr.String(), "failed to connect to database")
}

func TestRun_SSEBrokerStartError(t *testing.T) {
	preserveSlog(t)
	applyEnv(t, baseRunEnv(t))
	swapVar(t, &startSSEBroker, func(*sse.Broker, context.Context) error {
		return errors.New("broker boom")
	})
	stderr := &syncBuffer{}
	err := run(context.Background(), nil, io.Discard, stderr)
	require.Error(t, err)
	assert.Contains(t, stderr.String(), "failed to start SSE broker")
}

func TestRun_AuthProviderConfigError(t *testing.T) {
	preserveSlog(t)
	env := baseRunEnv(t)
	env["SMITHERS_AUTH_GITHUB_CLIENT_ID"] = "only-id" // secret missing -> invalid
	applyEnv(t, env)
	stubSSEBroker(t)
	stderr := &syncBuffer{}
	err := run(context.Background(), nil, io.Discard, stderr)
	require.ErrorContains(t, err, "auth.github_client_id and auth.github_client_secret must be configured together")
	assert.Contains(t, stderr.String(), "invalid startup config")
}

func TestRun_EmailTransportError(t *testing.T) {
	preserveSlog(t)
	applyEnv(t, baseRunEnv(t))
	stubSSEBroker(t)
	swapVar(t, &newEmailTransport, func(config.EmailConfig) (email.Transport, error) {
		return nil, errors.New("email boom")
	})
	stderr := &syncBuffer{}
	err := run(context.Background(), nil, io.Discard, stderr)
	require.Error(t, err)
	assert.Contains(t, stderr.String(), "failed to initialize email transport")
}

func TestRun_SecretCodecError(t *testing.T) {
	preserveSlog(t)
	applyEnv(t, baseRunEnv(t))
	stubSSEBroker(t)
	swapVar(t, &newSecretCodec, func(config.WebhookConfig) (*webhook.AESGCMSecretCodec, error) {
		return nil, errors.New("codec boom")
	})
	stderr := &syncBuffer{}
	err := run(context.Background(), nil, io.Discard, stderr)
	require.Error(t, err)
	assert.Contains(t, stderr.String(), "failed to initialize webhook secret codec")
}

func TestRun_BlobStoreInitError(t *testing.T) {
	preserveSlog(t)
	env := baseRunEnv(t)
	env["SMITHERS_BLOB_SIGNED_URL_EXPIRY"] = "bogus"
	applyEnv(t, env)
	stubSSEBroker(t)
	stderr := &syncBuffer{}
	err := run(context.Background(), nil, io.Discard, stderr)
	require.Error(t, err)
	assert.Contains(t, stderr.String(), "failed to initialize blob store")
}

func TestRun_WorkflowCacheTTLError(t *testing.T) {
	preserveSlog(t)
	env := baseRunEnv(t)
	env["SMITHERS_BLOB_WORKFLOW_CACHE_TTL"] = "bogus"
	applyEnv(t, env)
	stubSSEBroker(t)
	stderr := &syncBuffer{}
	err := run(context.Background(), nil, io.Discard, stderr)
	require.Error(t, err)
	assert.Contains(t, stderr.String(), "invalid blob.workflow_cache_ttl")
}

func TestRun_BlobStoreNotWorkflowCacheStore(t *testing.T) {
	preserveSlog(t)
	applyEnv(t, baseRunEnv(t))
	stubSSEBroker(t)
	// nil blob.Store fails the WorkflowCacheStore type assertion (the only
	// reachable failure, since the interface is a subset of blob.Store).
	swapVar(t, &newBlobStore, func(context.Context, config.BlobConfig) (blob.Store, io.Closer, time.Duration, error) {
		return nil, nil, 5 * time.Minute, nil
	})
	stderr := &syncBuffer{}
	err := run(context.Background(), nil, io.Discard, stderr)
	require.Error(t, err)
	assert.Contains(t, stderr.String(), "blob store does not implement workflow cache storage requirements")
}

func TestRun_AuthCleanupIntervalError(t *testing.T) {
	preserveSlog(t)
	env := baseRunEnv(t)
	env["SMITHERS_CLEANUP_AUTH_INTERVAL"] = "bogus"
	applyEnv(t, env)
	stubSSEBroker(t)
	stderr := &syncBuffer{}
	err := run(context.Background(), nil, io.Discard, stderr)
	require.Error(t, err)
	assert.Contains(t, stderr.String(), "invalid cleanup.auth_interval")
}

func TestRun_WorkflowCacheCleanupIntervalError(t *testing.T) {
	preserveSlog(t)
	env := baseRunEnv(t)
	env["SMITHERS_CLEANUP_WORKFLOW_CACHE_INTERVAL"] = "bogus"
	applyEnv(t, env)
	stubSSEBroker(t)
	stderr := &syncBuffer{}
	err := run(context.Background(), nil, io.Discard, stderr)
	require.Error(t, err)
	assert.Contains(t, stderr.String(), "invalid cleanup.workflow_cache_interval")
}

// ---------------------------------------------------------------------------
// run() listener error paths (fail at/after Serve; driven async)
// ---------------------------------------------------------------------------

func TestRun_ListenError(t *testing.T) {
	preserveSlog(t)
	// Pre-bind a port and point the server at it so net.Listen fails.
	pre, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	defer pre.Close()

	env := baseRunEnv(t)
	env["SMITHERS_SERVER_ADDR"] = pre.Addr().String()
	errCh, logs, _ := runAsync(t, env)

	select {
	case err := <-errCh:
		require.Error(t, err)
		assert.Contains(t, logs.String(), "server error")
	case <-time.After(20 * time.Second):
		t.Fatalf("run did not return on listen error\nlogs:\n%s", logs.String())
	}
}

func TestRun_ServeError(t *testing.T) {
	preserveSlog(t)
	// Close the listener as soon as it is captured so srv.Serve returns a
	// non-ErrServerClosed error.
	swapVar(t, &onListen, func(ln net.Listener) { _ = ln.Close() })
	errCh, logs, _ := runAsync(t, baseRunEnv(t))

	select {
	case err := <-errCh:
		require.Error(t, err)
		assert.Contains(t, logs.String(), "server error")
	case <-time.After(20 * time.Second):
		t.Fatalf("run did not return on serve error\nlogs:\n%s", logs.String())
	}
}

// ---------------------------------------------------------------------------
// run() happy paths (serve + graceful shutdown)
// ---------------------------------------------------------------------------

func TestRun_ServesAndShutsDownGracefully(t *testing.T) {
	preserveSlog(t)
	h := startRun(t, baseRunEnv(t))

	resp, err := h.get("/health")
	require.NoError(t, err)
	assert.Equal(t, http.StatusOK, resp.StatusCode)
	_ = resp.Body.Close()

	h.shutdownAndWaitNil()

	out := h.logs.String()
	assert.Contains(t, out, "API server listening")
	assert.Contains(t, out, "shutting down")
	assert.Contains(t, out, "in-flight requests at SIGTERM")
}

// failingShutdownExporter is a span exporter whose Shutdown errors, exercising
// the tp != nil deferred-Shutdown Warn branch.
type failingShutdownExporter struct{}

func (failingShutdownExporter) ExportSpans(context.Context, []sdktrace.ReadOnlySpan) error {
	return nil
}
func (failingShutdownExporter) Shutdown(context.Context) error {
	return errors.New("exporter shutdown boom")
}

func TestRun_FullyConfigured(t *testing.T) {
	preserveSlog(t)
	env := baseRunEnv(t)
	// Full shared startup uses the local blob adapter supplied by baseRunEnv.
	// A cloud bucket requires a deployment-provided adapter.
	// Microsandbox sandbox clients (constructor-only).
	env["SMITHERS_MICROSANDBOX_CONTROL_URL"] = "https://sandbox.example.com"
	env["SMITHERS_MICROSANDBOX_API_KEY"] = "sk-test"
	// Auth0 configured, GitHub unset -> upstream authorize detour.
	env["SMITHERS_AUTH_AUTH0_DOMAIN"] = "example.us.auth0.com"
	env["SMITHERS_AUTH_AUTH0_CLIENT_ID"] = "auth0-id"
	env["SMITHERS_AUTH_AUTH0_CLIENT_SECRET"] = "auth0-secret"
	// Retired first-party Linear credentials (D-11) are ignored.
	env["SMITHERS_AUTH_LINEAR_CLIENT_ID"] = "lin-id"
	env["SMITHERS_AUTH_LINEAR_CLIENT_SECRET"] = "lin-secret"
	// Alert remediation worker (registry loads from embedded JSON).
	env["SMITHERS_ALERT_REMEDIATION_REPOSITORY_ID"] = "1"
	// E2E dev auto-authorize.
	env["SMITHERS_ENABLE_E2E_TEST_ROUTES"] = "true"
	// API base URL /api suffix trim.
	// Custom active storage set.
	env["ACTIVE_STORAGE_SET"] = "custom"
	// Email SMTP transport + explicit From.
	env["SMITHERS_EMAIL_SMTP_HOST"] = "smtp.example.com"
	env["SMITHERS_EMAIL_FROM"] = "noreply@example.com"

	// Real TracerProvider whose exporter Shutdown errors: covers the tp != nil
	// deferred-Shutdown path and its Shutdown-error Warn. A synchronous
	// (SimpleSpanProcessor via WithSyncer) processor returns the exporter's
	// Shutdown error directly and spawns no background goroutine.
	swapVar(t, &otelInit, func(context.Context, config.ObservabilityConfig) (*sdktrace.TracerProvider, error) {
		tp := sdktrace.NewTracerProvider(sdktrace.WithSyncer(failingShutdownExporter{}))
		return tp, nil
	})

	h := startRun(t, env)
	resp, err := h.get("/health")
	require.NoError(t, err)
	assert.Equal(t, http.StatusOK, resp.StatusCode)
	_ = resp.Body.Close()
	h.shutdownAndWaitNil()
	assert.Contains(t, h.logs.String(), "error shutting down tracer provider")
}

func TestRun_LocalLegacyWorkflowsFailClosed(t *testing.T) {
	env := baseRunEnv(t)
	env["SMITHERS_FEATURE_FLAGS_WORKFLOWS"] = "true"
	applyEnv(t, env)
	err := run(context.Background(), nil, io.Discard, io.Discard)
	require.ErrorContains(t, err, "legacy workflow triggers are unavailable in single-owner mode")
}

func TestRun_ShutdownTimeoutWarn(t *testing.T) {
	preserveSlog(t)
	env := baseRunEnv(t)
	env["SMITHERS_SERVER_SHUTDOWN_TIMEOUT"] = "100ms"
	h := startRun(t, env)

	// Open a raw TCP connection and write a half-finished HTTP request so the
	// connection is non-idle when srv.Shutdown runs -> DeadlineExceeded.
	conn, err := net.Dial("tcp", h.addr())
	require.NoError(t, err)
	defer conn.Close()
	_, _ = conn.Write([]byte("GET /health HTTP/1.1\r\nHost: x\r\n"))
	// Give the server a moment to accept + begin reading the request.
	time.Sleep(50 * time.Millisecond)

	h.cancel()
	require.ErrorIs(t, h.waitErr(), context.DeadlineExceeded)
	assert.Contains(t, h.logs.String(), "context deadline exceeded")
}
