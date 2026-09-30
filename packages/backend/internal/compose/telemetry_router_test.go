package compose

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/prometheus/client_golang/prometheus/testutil"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
)

// telemetryTestBody is a valid POST /api/telemetry/errors request body.
const telemetryTestBody = `{"client":"web","version":"1.0","error":{"message":"x","stack":"","type":"TypeError"},"context":{}}`

// TestServerRouter_TelemetryGatedByFeatureFlag covers issue #323: the
// telemetry ingestion route must be gated on
// feature_flags.client_error_reporting so operators can disable client error
// ingestion entirely. When the flag is off, the route must 403 before the
// handler runs (proven by the counter staying at zero); when the flag is on,
// the existing 204 + metrics-increment behavior is preserved.
func TestServerRouter_TelemetryGatedByFeatureFlag(t *testing.T) {
	t.Parallel()

	t.Run("flag off: 403 and not ingested", func(t *testing.T) {
		t.Parallel()

		metrics := routes.NewSmithersMetrics()
		cfg := testConfigAllFlagsOn()
		cfg.FeatureFlags.ClientErrorReporting = false

		router := telemetryRouterForTest(cfg, metrics)

		req := httptest.NewRequest(http.MethodPost, "/api/telemetry/errors", strings.NewReader(telemetryTestBody))
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()

		router.ServeHTTP(rec, req)

		require.Equal(t, http.StatusForbidden, rec.Code)
		assert.Contains(t, rec.Body.String(), "feature not available")
		assert.Equal(t, float64(0), testutil.ToFloat64(metrics.ClientErrorsTotal.WithLabelValues("web", "TypeError")))
	})

	t.Run("flag on: 204 and ingested", func(t *testing.T) {
		t.Parallel()

		metrics := routes.NewSmithersMetrics()
		cfg := testConfigAllFlagsOn()
		cfg.FeatureFlags.ClientErrorReporting = true

		router := telemetryRouterForTest(cfg, metrics)

		req := httptest.NewRequest(http.MethodPost, "/api/telemetry/errors", strings.NewReader(telemetryTestBody))
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()

		router.ServeHTTP(rec, req)

		require.Equal(t, http.StatusNoContent, rec.Code)
		assert.Equal(t, float64(1), testutil.ToFloat64(metrics.ClientErrorsTotal.WithLabelValues("web", "TypeError")))
	})
}

func telemetryRouterForTest(cfg *config.Config, metrics *routes.SmithersMetrics) http.Handler {
	return buildRouterCompat(
		cfg,
		nil, // queries
		nil, // pool
		&routes.RepoHandler{},
		&routes.AuthHandler{},
		&routes.UserHandler{},
		&routes.SSHKeyHandler{},
		&routes.LabelHandler{},

		&routes.OrgHandler{},
		&routes.LandingHandler{},
		&routes.SearchHandler{Service: &mockRouterSearchService{}},
		&routes.IssueHandler{},
		nil, // wikiService
		&routes.GitSmartHandler{Service: &mockRouterGitService{}},
		nil, // adminRunnerHandler
		nil, // adminUserHandler
		nil, // adminOrgHandler
		nil, // adminSystemHealthHandler
		nil, // adminGitHubAppHandler
		nil, // adminAuditHandler
		nil, // webhookHandler
		nil, // secretHandler
		nil, // variableHandler
		nil, // commitStatusHandler
		nil, // lfsHandler
		nil, // jjVCSHandler
		nil, // agentInternalHandler
		nil, // agentSessionHandler
		nil, // agentSessionStreamHandler
		nil, // pushHookHandler
		nil, // workflowHandler
		nil, // workspaceHandler
		nil, // workspaceInternalHandler
		nil, // workspaceTerminalHandler
		&routes.TelemetryHandler{Metrics: metrics},
		nil, // featureFlagHandler
		nil, // oauth2Handler
		metrics,
	)
}

func TestServerRouter_TelemetrySelectsWorkerQuotaAndIngests(t *testing.T) {
	t.Parallel()
	cfg := testConfigAllFlagsOn()
	cfg.Auth.WorkerExchangeToken = "telemetry-worker-fixture"
	metrics := routes.NewSmithersMetrics()
	router := telemetryRouterForTest(cfg, metrics)
	post := func(bearer string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, "/api/telemetry/errors", strings.NewReader(telemetryTestBody))
		req.RemoteAddr = "203.0.113.119:9000"
		req.Header.Set("Content-Type", "application/json")
		if bearer != "" {
			req.Header.Set("Authorization", bearer)
		}
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		return rec
	}

	// The router fixture has no DB store: headers establish selected policy;
	// middleware tests exercise token consumption/isolation with a real bucket stub.
	require.Equal(t, "10", post("").Header().Get("X-RateLimit-Limit"))
	for i := 0; i < 40; i++ {
		rec := post("Bearer " + cfg.Auth.WorkerExchangeToken)
		require.Equal(t, http.StatusNoContent, rec.Code)
		require.Equal(t, "120", rec.Header().Get("X-RateLimit-Limit"))
	}
	invalid := post("Bearer wrong-secret")
	require.Equal(t, http.StatusUnauthorized, invalid.Code)
	require.Contains(t, invalid.Header().Get("WWW-Authenticate"), `error="invalid_token"`)
	require.Empty(t, invalid.Header().Get("X-RateLimit-Limit"), "auth rejects the credential before the endpoint limiter")
	require.Equal(t, float64(41), testutil.ToFloat64(metrics.ClientErrorsTotal.WithLabelValues("web", "TypeError")))
}
