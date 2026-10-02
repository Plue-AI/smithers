package compose

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/prometheus/client_golang/prometheus/testutil"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
)

// ---------------------------------------------------------------------------
// run() config-YAML helper
// ---------------------------------------------------------------------------

// writeRunConfigYAML writes yaml to a temp config.yaml in t.TempDir() and
// returns the path. An explicit YAML file is the only way to set
// email.from/email.smtp_from to the empty string, because
// internal/config uses viper AutomaticEnv WITHOUT AllowEmptyEnv (an empty env
// var reads as unset, so the non-empty defaults win).
func writeRunConfigYAML(t *testing.T, yaml string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "config.yaml")
	require.NoError(t, os.WriteFile(path, []byte(yaml), 0o600))
	return path
}

// TestRun_EmailFromSMTPFallback covers the email sender fallback. The
// newSecretCodec seam returns an error after the sender is selected, before
// the server listens.
func TestRun_EmailFromSMTPFallback(t *testing.T) {
	preserveSlog(t)
	applyEnv(t, baseRunEnv(t))
	stubSSEBroker(t)
	swapVar(t, &newSecretCodec, func(config.WebhookConfig) (*webhook.AESGCMSecretCodec, error) {
		return nil, errors.New("stop here")
	})
	path := writeRunConfigYAML(t, "email:\n  from: \"\"\n  smtp_from: \"fallback@example.com\"\n")

	stderr := &syncBuffer{}
	err := run(context.Background(), []string{"-config", path}, io.Discard, stderr)
	require.Error(t, err)
	assert.Contains(t, stderr.String(), "failed to initialize webhook secret codec")
}

// ---------------------------------------------------------------------------
// workspaceSessionTargetWorkspaceID defensive arms
// ---------------------------------------------------------------------------

type errReader struct{}

func (errReader) Read([]byte) (int, error) { return 0, errors.New("read boom") }

func TestWorkspaceSessionTargetWorkspaceID_Defensive(t *testing.T) {
	t.Parallel()

	t.Run("nil request", func(t *testing.T) {
		t.Parallel()
		assert.Empty(t, workspaceSessionTargetWorkspaceID(nil))
	})
	t.Run("nil body", func(t *testing.T) {
		t.Parallel()
		assert.Empty(t, workspaceSessionTargetWorkspaceID(&http.Request{Body: nil}))
	})
	t.Run("read error", func(t *testing.T) {
		t.Parallel()
		r := &http.Request{Body: io.NopCloser(errReader{})}
		assert.Empty(t, workspaceSessionTargetWorkspaceID(r))
		// Body was replaced with an empty NopCloser.
		body, err := io.ReadAll(r.Body)
		require.NoError(t, err)
		assert.Empty(t, body)
	})
	t.Run("whitespace only", func(t *testing.T) {
		t.Parallel()
		r := &http.Request{Body: io.NopCloser(strings.NewReader("  \n"))}
		assert.Empty(t, workspaceSessionTargetWorkspaceID(r))
	})
	t.Run("invalid json", func(t *testing.T) {
		t.Parallel()
		r := &http.Request{Body: io.NopCloser(strings.NewReader("{"))}
		assert.Empty(t, workspaceSessionTargetWorkspaceID(r))
	})
}

// ---------------------------------------------------------------------------
// inFlightRequestTracker.Snapshot clamp branches (direct field access)
// ---------------------------------------------------------------------------

func TestInFlightRequestTracker_SnapshotClamps(t *testing.T) {
	t.Parallel()

	t.Run("negative completed clamps to zero", func(t *testing.T) {
		t.Parallel()
		tr := newInFlightRequestTracker()
		tr.completed.Add(5)
		tr.BeginShutdown() // shutdownCompletedBase = 5, shutdownActive = 0
		tr.completed.Store(3)
		drained, killed, activeRemaining := tr.Snapshot()
		assert.Equal(t, int64(0), drained)
		assert.Equal(t, int64(0), killed)
		assert.Equal(t, int64(0), activeRemaining)
	})
	t.Run("overshoot clamps to initial", func(t *testing.T) {
		t.Parallel()
		tr := newInFlightRequestTracker()
		tr.BeginShutdown() // shutdownCompletedBase = 0, shutdownActive = 0
		tr.completed.Add(2)
		drained, killed, _ := tr.Snapshot()
		assert.Equal(t, int64(0), drained)
		assert.Equal(t, int64(0), killed)
	})
}

// ---------------------------------------------------------------------------
// flagParseError.Error / Unwrap (errors.As never invokes them)
// ---------------------------------------------------------------------------

func TestFlagParseError_ErrorAndUnwrap(t *testing.T) {
	t.Parallel()
	inner := errors.New("boom")
	e := &flagParseError{inner}
	assert.Equal(t, "boom", e.Error())
	assert.Equal(t, inner, errors.Unwrap(e))
}

// ---------------------------------------------------------------------------
// buildRouter direct-construction tests
// ---------------------------------------------------------------------------

// sseIdentityRouterForTest builds a router with authHandler==nil AND queries==nil
// so sseTicketValidators stays empty and sseTicketAuth is the identity middleware
// (main.go:1226 `func(next) { return next }`). workflowHandler is non-nil so a
// group that r.Use(sseTicketAuth) is registered — chi composes the chain at
// registration time, executing the identity body.
func sseIdentityRouterForTest() http.Handler {
	return buildRouter(
		testConfigAllFlagsOn(),
		nil, // queries
		nil, // pool
		&routes.RepoHandler{},
		nil, // mirrorSyncHandler
		nil, // authHandler == nil -> identity sseTicketAuth
		&routes.UserHandler{},
		&routes.SSHKeyHandler{},
		nil, // deployKeyHandler
		&routes.LabelHandler{},

		&routes.OrgHandler{},
		&routes.LandingHandler{},
		nil, // buildCacheHandler
		nil, // stackHandler
		&routes.SearchHandler{Service: &mockRouterSearchService{}},
		&routes.IssueHandler{},
		nil, // wikiService
		&routes.GitSmartHandler{Service: &mockRouterGitService{}},
		nil,                       // notificationHandler
		nil,                       // adminRunnerHandler
		nil,                       // adminUserHandler
		nil,                       // adminOrgHandler
		nil,                       // adminSystemMetricsHandler
		nil,                       // adminGitHubAppHandler
		nil,                       // adminAuditHandler
		nil,                       // webhookHandler
		nil,                       // secretHandler
		nil,                       // providerConnectionHandler
		nil,                       // variableHandler
		nil,                       // billingHandler
		nil,                       // protectedBookmarkHandler
		nil,                       // commitStatusHandler
		nil,                       // lfsHandler
		nil,                       // jjVCSHandler
		nil,                       // agentInternalHandler
		nil,                       // agentSessionHandler
		nil,                       // agentSessionStreamHandler
		nil,                       // approvalsHandler
		nil,                       // branchLockHandler
		nil,                       // canaryReportHandler
		&routes.WorkflowHandler{}, // workflowHandler -> registers sseTicketAuth group
		nil,                       // workflowCacheHandler
		nil,                       // workflowArtifactHandler
		nil,                       // issueEventHandler
		nil,                       // workspaceHandler
		nil,                       // workspaceInternalHandler
		nil,                       // repositoryJobHandler
		nil,                       // gitHubProxyHandler
		nil,                       // gitHubRepoListHandler
		nil,                       // gitHubUserReposHandler
		nil,                       // gitHubSyncedReposHandler
		nil,                       // gitHubImportHandler
		nil,                       // workspaceTerminalHandler
		nil,                       // telemetryHandler
		nil,                       // featureFlagHandler
		nil,                       // oauth2Handler
		nil,                       // gitHubWebhookHandler
		nil,                       // smithersMetrics
	)
}

func TestBuildRouter_SSETicketAuthIdentityWhenNoValidators(t *testing.T) {
	t.Parallel()
	router := sseIdentityRouterForTest()
	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	require.Equal(t, http.StatusOK, rec.Code)
}

// featureGateRouterForTest builds a router whose gated route families have
// non-nil zero-value handlers but disabled feature flags, so a scope-authorized
// request reaches the FeatureFlagGate closure and gets 403.
func featureGateRouterForTest(cfg *config.Config) http.Handler {
	return buildRouter(
		cfg,
		nil, // queries
		nil, // pool
		&routes.RepoHandler{},
		nil, // mirrorSyncHandler
		&routes.AuthHandler{},
		&routes.UserHandler{},
		&routes.SSHKeyHandler{},
		nil, // deployKeyHandler
		&routes.LabelHandler{},

		&routes.OrgHandler{},
		&routes.LandingHandler{},
		nil, // buildCacheHandler
		nil, // stackHandler
		&routes.SearchHandler{Service: &mockRouterSearchService{}},
		&routes.IssueHandler{},
		nil, // wikiService
		&routes.GitSmartHandler{Service: &mockRouterGitService{}},
		nil,                                // notificationHandler
		nil,                                // adminRunnerHandler
		nil,                                // adminUserHandler
		nil,                                // adminOrgHandler
		nil,                                // adminSystemMetricsHandler
		nil,                                // adminGitHubAppHandler
		nil,                                // adminAuditHandler
		&routes.WebhookHandler{},           // webhookHandler
		&routes.SecretHandler{},            // secretHandler
		nil,                                // providerConnectionHandler
		nil,                                // variableHandler
		nil,                                // billingHandler
		&routes.ProtectedBookmarkHandler{}, // protectedBookmarkHandler
		nil,                                // commitStatusHandler
		nil,                                // lfsHandler
		nil,                                // jjVCSHandler
		nil,                                // agentInternalHandler
		nil,                                // agentSessionHandler
		nil,                                // agentSessionStreamHandler
		nil,                                // approvalsHandler
		nil,                                // branchLockHandler
		nil,                                // canaryReportHandler
		&routes.WorkflowHandler{Service: &mockRouterWorkflowService{}}, // workflowHandler
		nil, // workflowCacheHandler
		nil, // workflowArtifactHandler
		nil, // issueEventHandler
		nil, // workspaceHandler
		nil, // workspaceInternalHandler
		nil, // repositoryJobHandler
		nil, // gitHubProxyHandler
		nil, // gitHubRepoListHandler
		nil, // gitHubUserReposHandler
		nil, // gitHubSyncedReposHandler
		nil, // gitHubImportHandler
		nil, // workspaceTerminalHandler
		nil, // telemetryHandler
		nil, // featureFlagHandler
		nil, // oauth2Handler
		nil, // gitHubWebhookHandler
		nil, // smithersMetrics
	)
}

func TestServerRouter_FeatureFlagGateClosures(t *testing.T) {
	t.Parallel()

	cfg := testConfigAllFlagsOn()
	cfg.FeatureFlags.Issues = false
	cfg.FeatureFlags.Labels = false
	cfg.FeatureFlags.Releases = false
	cfg.FeatureFlags.Secrets = false
	cfg.FeatureFlags.ProtectedBookmarks = false
	cfg.FeatureFlags.WebhooksUser = false
	cfg.FeatureFlags.Workflows = false
	router := featureGateRouterForTest(cfg)

	type row struct {
		name        string
		method      string
		path        string
		scope       middleware.TokenScope
		contentType string
		body        io.Reader
	}
	rows := []row{
		{"issues", http.MethodPost, "/api/repos/alice/demo/issues", middleware.ScopeWriteRepository, "application/json", strings.NewReader("{}")},
		{"labels", http.MethodGet, "/api/repos/alice/demo/labels", middleware.ScopeReadRepository, "", nil},
		{"secrets", http.MethodGet, "/api/repos/alice/demo/secrets", middleware.ScopeWriteRepository, "", nil},
		{"protected-bookmarks", http.MethodGet, "/api/repos/alice/demo/protected-bookmarks", middleware.ScopeWriteRepository, "", nil},
		{"hooks", http.MethodGet, "/api/repos/alice/demo/hooks", middleware.ScopeWriteRepository, "", nil},
		{"workflows", http.MethodGet, "/api/repos/alice/demo/workflows", middleware.ScopeReadRepository, "", nil},
	}
	for _, tc := range rows {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(tc.method, tc.path, tc.body)
			if tc.contentType != "" {
				req.Header.Set("Content-Type", tc.contentType)
			}
			req = withRouterTokenAuth(req, tc.scope)
			rec := httptest.NewRecorder()
			router.ServeHTTP(rec, req)
			require.Equal(t, http.StatusForbidden, rec.Code, "body: %s", rec.Body.String())
			assert.Contains(t, rec.Body.String(), "feature not available")
		})
	}
}

// ---------------------------------------------------------------------------
// apiAllowedOrigins / normalizeAllowedOrigins
// ---------------------------------------------------------------------------

func TestAPIAllowedOrigins_NilConfigAndBadBaseURL(t *testing.T) {
	preserveSlog(t)
	assert.Nil(t, apiAllowedOrigins(nil))

	// BaseURL parses but has no scheme/host -> nil.
	cfg := &config.Config{}
	cfg.Server.PublicURL = "not-a-url"
	assert.Nil(t, apiAllowedOrigins(cfg))

	// BaseURL that fails url.Parse -> nil.
	cfg2 := &config.Config{}
	cfg2.Server.PublicURL = "http://[::bad"
	assert.Nil(t, apiAllowedOrigins(cfg2))
}

func TestNormalizeAllowedOrigins_SkipsEmptyInvalidAndDuplicates(t *testing.T) {
	preserveSlog(t)
	got := normalizeAllowedOrigins([]string{
		" , ",                   // empty entries
		"http://[::bad",         // url.Parse error
		"no-scheme-host",        // no scheme/host
		"https://a.example.com", // valid
		"HTTPS://A.EXAMPLE.COM,https://a.example.com", // duplicates (case-insensitive)
	})
	require.Len(t, got, 1)
	assert.Equal(t, "https://a.example.com", got[0])
}

// ---------------------------------------------------------------------------
// buildRateLimitRejectObserver closure
// ---------------------------------------------------------------------------

func TestBuildRateLimitRejectObserver_ClosureIncrements(t *testing.T) {
	t.Parallel()
	m := routes.NewSmithersMetrics()
	obs := buildRateLimitRejectObserver(m)
	require.NotNil(t, obs)
	obs("test_scope")
	assert.Equal(t, 1.0, testutil.ToFloat64(m.RateLimitRejectionsTotal.WithLabelValues("test_scope")))
}

// ---------------------------------------------------------------------------
// initEmailTransport from-fallbacks
// ---------------------------------------------------------------------------

func TestInitEmailTransport_FromFallbacks(t *testing.T) {
	t.Run("smtp from fallback", func(t *testing.T) {
		_, err := initEmailTransport(config.EmailConfig{From: "", SMTPHost: "smtp.example.com", SMTPFrom: "a@b"})
		require.NoError(t, err)
	})
}
