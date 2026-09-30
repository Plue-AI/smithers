package routes_test

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/routes"
)

// ---------------------------------------------------------------------------
// SmithersMetrics unit tests
// Tests for the Prometheus metrics definitions and /metrics endpoint handler.
// Reference: docs/specs/infra.md §8.1
// ---------------------------------------------------------------------------

// TestSmithersMetrics_NewCreatesIsolatedRegistry verifies that NewSmithersMetrics
// creates a fresh isolated registry (not the global Prometheus registry),
// which prevents test interference.
func TestSmithersMetrics_NewCreatesIsolatedRegistry(t *testing.T) {
	t.Parallel()

	m1 := routes.NewSmithersMetrics()
	m2 := routes.NewSmithersMetrics()

	// Both should be able to serve without panicking (isolated registries)
	req := httptest.NewRequest(http.MethodGet, "/metrics", nil)
	rec1 := httptest.NewRecorder()
	rec2 := httptest.NewRecorder()

	m1.Handler().ServeHTTP(rec1, req)
	m2.Handler().ServeHTTP(rec2, req)

	assert.Equal(t, http.StatusOK, rec1.Code)
	assert.Equal(t, http.StatusOK, rec2.Code)
}

// TestSmithersMetrics_HandlerReturnsPrometheusTextFormat verifies the /metrics
// handler returns Prometheus text format with the correct content type.
func TestSmithersMetrics_HandlerReturnsPrometheusTextFormat(t *testing.T) {
	t.Parallel()

	m := routes.NewSmithersMetrics()
	req := httptest.NewRequest(http.MethodGet, "/metrics", nil)
	rec := httptest.NewRecorder()

	m.Handler().ServeHTTP(rec, req)

	assert.Equal(t, http.StatusOK, rec.Code)
	ct := rec.Header().Get("Content-Type")
	assert.Contains(t, ct, "text/plain", "Prometheus text format must use text/plain content type")
}

// TestSmithersMetrics_AllRequiredMetricsPresent verifies all 10 spec-required
// metrics (from infra.md §8.1) are registered. Gauges appear even at zero;
// counters/histograms only appear after being observed, so we seed each one.
func TestSmithersMetrics_AllRequiredMetricsPresent(t *testing.T) {
	t.Parallel()

	m := routes.NewSmithersMetrics()

	// Seed counters/histograms so Prometheus includes them in the output.
	// Gauges are emitted at zero automatically.
	m.HTTPRequestsTotal.WithLabelValues("GET", "/probe", "200").Inc()
	m.HTTPRequestDurationSeconds.WithLabelValues("GET", "/probe").Observe(0.001)
	m.ObserveAgentSessionCompletion("completed")
	m.ObserveAgentSessionTimeout()
	m.WorkflowRunsTotal.WithLabelValues("success").Inc()
	m.WorkflowDurationSeconds.WithLabelValues("success").Observe(1.0)
	m.RepoHostOperationDurationSeconds.WithLabelValues("fetch").Observe(0.05)
	m.DBQueryDurationSeconds.WithLabelValues("probe").Observe(0.001)

	req := httptest.NewRequest(http.MethodGet, "/metrics", nil)
	rec := httptest.NewRecorder()
	m.Handler().ServeHTTP(rec, req)

	body, err := io.ReadAll(rec.Body)
	require.NoError(t, err)
	output := string(body)

	// Spec metrics plus queue backlog gauges must appear in /metrics output.
	requiredMetrics := []string{
		"smithers_http_requests_total",
		"smithers_http_request_duration_seconds",
		"smithers_active_agent_sessions",
		"smithers_agent_session_timeouts_total",
		"smithers_agent_sessions_completed_total",
		"smithers_workflow_runs_total",
		"smithers_workflow_duration_seconds",
		"smithers_repo_host_client_operation_duration_seconds",
		"smithers_db_query_duration_seconds",
		"smithers_sse_active_connections",
	}

	for _, metricName := range requiredMetrics {
		assert.Contains(t, output, metricName,
			"metric %q must appear in /metrics output", metricName)
	}
}

// TestSmithersMetrics_HTTPRequestsTotal_IncrementAndRead verifies the HTTP request
// counter can be incremented and the value appears in /metrics output.
func TestSmithersMetrics_HTTPRequestsTotal_IncrementAndRead(t *testing.T) {
	t.Parallel()

	m := routes.NewSmithersMetrics()

	// Record some requests
	m.HTTPRequestsTotal.WithLabelValues("GET", "/api/repos", "200").Inc()
	m.HTTPRequestsTotal.WithLabelValues("GET", "/api/repos", "200").Inc()
	m.HTTPRequestsTotal.WithLabelValues("POST", "/api/repos", "201").Inc()

	req := httptest.NewRequest(http.MethodGet, "/metrics", nil)
	rec := httptest.NewRecorder()
	m.Handler().ServeHTTP(rec, req)

	body, err := io.ReadAll(rec.Body)
	require.NoError(t, err)
	output := string(body)

	// Should contain our incremented counter
	assert.Contains(t, output, `smithers_http_requests_total{method="GET",path="/api/repos",status="200"} 2`,
		"counter must reflect incremented values")
	assert.Contains(t, output, `smithers_http_requests_total{method="POST",path="/api/repos",status="201"} 1`,
		"counter must reflect different label sets")
}

// TestSmithersMetrics_Gauges_SetAndRead verifies gauge metrics can be set and read.
func TestSmithersMetrics_Gauges_SetAndRead(t *testing.T) {
	t.Parallel()

	m := routes.NewSmithersMetrics()

	// Set gauge values
	m.ActiveAgentSessions.Set(3)
	m.ActiveAgentSessionOldestAgeSeconds.Set(1805)
	m.SSEActiveConnections.Set(5)

	req := httptest.NewRequest(http.MethodGet, "/metrics", nil)
	rec := httptest.NewRecorder()
	m.Handler().ServeHTTP(rec, req)

	body, err := io.ReadAll(rec.Body)
	require.NoError(t, err)
	output := string(body)

	assert.Contains(t, output, "smithers_active_agent_sessions 3",
		"active agent sessions gauge must reflect set value")
	assert.Contains(t, output, "smithers_active_agent_session_oldest_age_seconds 1805",
		"oldest active agent session age gauge must reflect set value")
	assert.Contains(t, output, "smithers_sse_active_connections 5",
		"SSE active connections gauge must reflect set value")
}

// TestSmithersMetrics_WorkflowRunsTotal_LabeledByStatus verifies that workflow run
// counter correctly differentiates between status labels.
func TestSmithersMetrics_WorkflowRunsTotal_LabeledByStatus(t *testing.T) {
	t.Parallel()

	m := routes.NewSmithersMetrics()

	m.WorkflowRunsTotal.WithLabelValues("success").Add(7)
	m.WorkflowRunsTotal.WithLabelValues("failure").Add(2)

	req := httptest.NewRequest(http.MethodGet, "/metrics", nil)
	rec := httptest.NewRecorder()
	m.Handler().ServeHTTP(rec, req)

	body, err := io.ReadAll(rec.Body)
	require.NoError(t, err)
	output := string(body)

	assert.Contains(t, output, `smithers_workflow_runs_total{status="success"} 7`)
	assert.Contains(t, output, `smithers_workflow_runs_total{status="failure"} 2`)
}

// TestSmithersMetrics_HistogramBuckets_CustomWorkflowBuckets verifies the workflow
// duration histogram uses the custom buckets defined in the spec (0.5s to 600s).
func TestSmithersMetrics_HistogramBuckets_CustomWorkflowBuckets(t *testing.T) {
	t.Parallel()

	m := routes.NewSmithersMetrics()

	// Seed the histogram so it appears in the output.
	m.WorkflowDurationSeconds.WithLabelValues("success").Observe(1.0)

	req := httptest.NewRequest(http.MethodGet, "/metrics", nil)
	rec := httptest.NewRecorder()
	m.Handler().ServeHTTP(rec, req)

	body, err := io.ReadAll(rec.Body)
	require.NoError(t, err)
	output := string(body)

	// The workflow duration histogram should have HELP and TYPE lines
	assert.Contains(t, output, "# HELP smithers_workflow_duration_seconds")
	assert.Contains(t, output, "# TYPE smithers_workflow_duration_seconds histogram")
	// Verify the custom bucket boundaries from the spec: .5, 1, 5, 10, 30, 60, 120, 300, 600
	assert.Contains(t, output, `le="0.5"`, "must have 0.5s bucket")
	assert.Contains(t, output, `le="600"`, "must have 600s bucket")
}

func TestSmithersMetrics_ObserveWorkflowRunCompletion(t *testing.T) {
	t.Parallel()

	m := routes.NewSmithersMetrics()
	m.ObserveWorkflowRunCompletion("success", 12.5)

	req := httptest.NewRequest(http.MethodGet, "/metrics", nil)
	rec := httptest.NewRecorder()
	m.Handler().ServeHTTP(rec, req)

	body, err := io.ReadAll(rec.Body)
	require.NoError(t, err)
	output := string(body)

	assert.Contains(t, output, `smithers_workflow_runs_total{status="success"} 1`)
	assert.Contains(t, output, `smithers_workflow_duration_seconds_sum{status="success"} 12.5`)
}

func TestSmithersMetrics_ObserveAgentSessionMetrics(t *testing.T) {
	t.Parallel()

	m := routes.NewSmithersMetrics()
	m.ObserveAgentSessionCompletion("completed")
	m.ObserveAgentSessionCompletion("timed_out")
	m.ObserveAgentSessionTimeout()

	req := httptest.NewRequest(http.MethodGet, "/metrics", nil)
	rec := httptest.NewRecorder()
	m.Handler().ServeHTTP(rec, req)

	body, err := io.ReadAll(rec.Body)
	require.NoError(t, err)
	output := string(body)

	assert.Contains(t, output, `smithers_agent_sessions_completed_total{status="completed"} 1`)
	assert.Contains(t, output, `smithers_agent_sessions_completed_total{status="timed_out"} 1`)
	assert.Contains(t, output, `smithers_agent_session_timeouts_total 1`)
}

func TestSmithersMetrics_AgentSessionCompletionMetricPresentWhenIdle(t *testing.T) {
	t.Parallel()

	m := routes.NewSmithersMetrics()

	req := httptest.NewRequest(http.MethodGet, "/metrics", nil)
	rec := httptest.NewRecorder()
	m.Handler().ServeHTTP(rec, req)

	body, err := io.ReadAll(rec.Body)
	require.NoError(t, err)
	output := string(body)

	assert.Contains(t, output, "# HELP smithers_agent_sessions_completed_total")
	assert.Contains(t, output, "# TYPE smithers_agent_sessions_completed_total counter")
	assert.Contains(t, output, `smithers_agent_sessions_completed_total{status="completed"} 0`)
	assert.Contains(t, output, `smithers_agent_sessions_completed_total{status="failed"} 0`)
	assert.Contains(t, output, `smithers_agent_sessions_completed_total{status="cancelled"} 0`)
	assert.Contains(t, output, `smithers_agent_sessions_completed_total{status="timed_out"} 0`)
}

func TestSmithersMetrics_ObserveWebhookDeliveryMetrics(t *testing.T) {
	t.Parallel()

	m := routes.NewSmithersMetrics()
	m.ObserveWebhookDeliveryAttempt("success")
	m.ObserveWebhookDeliveryAttempt("retry")
	m.ObserveWebhookDeliveryAttempt("failed")
	m.ObserveWebhookDeliveryTerminal("success")
	m.ObserveWebhookDeliveryTerminal("disabled")

	req := httptest.NewRequest(http.MethodGet, "/metrics", nil)
	rec := httptest.NewRecorder()
	m.Handler().ServeHTTP(rec, req)

	body, err := io.ReadAll(rec.Body)
	require.NoError(t, err)
	output := string(body)

	assert.Contains(t, output, `smithers_webhook_delivery_attempts_total{outcome="success"} 1`)
	assert.Contains(t, output, `smithers_webhook_delivery_attempts_total{outcome="retry"} 1`)
	assert.Contains(t, output, `smithers_webhook_delivery_attempts_total{outcome="failed"} 1`)
	assert.Contains(t, output, `smithers_webhook_delivery_terminal_outcomes_total{outcome="success"} 1`)
	assert.Contains(t, output, `smithers_webhook_delivery_terminal_outcomes_total{outcome="disabled"} 1`)
}

func TestSmithersMetrics_ObserveRunnerCacheHit(t *testing.T) {
	t.Parallel()

	m := routes.NewSmithersMetrics()
	m.ObserveRunnerCacheHit("hit")
	m.ObserveRunnerCacheHit("miss")
	m.ObserveRunnerCacheHit("hit")

	req := httptest.NewRequest(http.MethodGet, "/metrics", nil)
	rec := httptest.NewRecorder()
	m.Handler().ServeHTTP(rec, req)

	body, err := io.ReadAll(rec.Body)
	require.NoError(t, err)
	output := string(body)

	assert.Contains(t, output, `smithers_runner_cache_hit_total{result="hit"} 2`)
	assert.Contains(t, output, `smithers_runner_cache_hit_total{result="miss"} 1`)
}

func TestSmithersMetrics_ObserveOAuth2TokenOperation(t *testing.T) {
	t.Parallel()

	m := routes.NewSmithersMetrics()
	m.ObserveOAuth2TokenOperation("issue")
	m.ObserveOAuth2TokenOperation("refresh")
	m.ObserveOAuth2TokenOperation("revoke")
	m.ObserveOAuth2TokenOperation("revoke_all")

	req := httptest.NewRequest(http.MethodGet, "/metrics", nil)
	rec := httptest.NewRecorder()
	m.Handler().ServeHTTP(rec, req)

	body, err := io.ReadAll(rec.Body)
	require.NoError(t, err)
	output := string(body)

	assert.Contains(t, output, `smithers_oauth2_token_operations_total{operation="issue"} 1`)
	assert.Contains(t, output, `smithers_oauth2_token_operations_total{operation="refresh"} 1`)
	assert.Contains(t, output, `smithers_oauth2_token_operations_total{operation="revoke"} 1`)
	assert.Contains(t, output, `smithers_oauth2_token_operations_total{operation="revoke_all"} 1`)
}

func TestSmithersMetrics_ObserveCrossCuttingOperations(t *testing.T) {
	t.Parallel()

	m := routes.NewSmithersMetrics()
	m.ObserveLandingOperation("land")
	m.SetLandingQueueDepth(4)
	m.SetCodeSearchBacklog(3, 120.5)
	m.ObserveAuthOperation("github_oauth", "success")
	m.ObserveAuthOperation("siwe", "failure")
	m.ObserveWorkspaceLifecycle("create", "success")
	m.ObserveWorkspaceLifecycle("delete", "error")

	req := httptest.NewRequest(http.MethodGet, "/metrics", nil)
	rec := httptest.NewRecorder()
	m.Handler().ServeHTTP(rec, req)

	body, err := io.ReadAll(rec.Body)
	require.NoError(t, err)
	output := string(body)

	assert.Contains(t, output, `smithers_landing_operations_total{operation="land"} 1`)
	assert.Contains(t, output, "smithers_landing_queue_depth 4")
	assert.Contains(t, output, "smithers_code_search_backlog_repositories 3")
	assert.Contains(t, output, "smithers_code_search_backlog_oldest_age_seconds 120.5")
	assert.Contains(t, output, `smithers_auth_operations_total{method="github_oauth",result="success"} 1`)
	assert.Contains(t, output, `smithers_auth_operations_total{method="siwe",result="failure"} 1`)
	assert.Contains(t, output, `smithers_workspace_lifecycle_total{action="create",result="success"} 1`)
	assert.Contains(t, output, `smithers_workspace_lifecycle_total{action="delete",result="error"} 1`)
}

// TestSmithersMetrics_MetricNamesFollowConvention verifies all metric names use the
// required "smithers_" prefix as per the naming convention in infra.md §8.1.
func TestSmithersMetrics_MetricNamesFollowConvention(t *testing.T) {
	t.Parallel()

	m := routes.NewSmithersMetrics()
	req := httptest.NewRequest(http.MethodGet, "/metrics", nil)
	rec := httptest.NewRecorder()
	m.Handler().ServeHTTP(rec, req)

	body, err := io.ReadAll(rec.Body)
	require.NoError(t, err)
	output := string(body)

	// Extract HELP lines to find metric names
	lines := strings.Split(output, "\n")
	for _, line := range lines {
		if strings.HasPrefix(line, "# HELP ") {
			metricName := strings.Fields(line)[2]
			assert.True(t, strings.HasPrefix(metricName, "smithers_"),
				"metric %q must be prefixed with 'smithers_'", metricName)
		}
	}
}

// TestSmithersMetrics_HandlerAcceptsGETOnly documents that the /metrics handler
// serves GET requests (standard Prometheus scrape behavior).
func TestSmithersMetrics_HandlerAcceptsGET(t *testing.T) {
	t.Parallel()

	m := routes.NewSmithersMetrics()
	req := httptest.NewRequest(http.MethodGet, "/metrics", nil)
	rec := httptest.NewRecorder()

	m.Handler().ServeHTTP(rec, req)

	assert.Equal(t, http.StatusOK, rec.Code)
}

// TestSmithersMetrics_DBQueryDuration_LabeledByQuery verifies the DB query duration
// histogram correctly records per-query latency.
func TestSmithersMetrics_DBQueryDuration_LabeledByQuery(t *testing.T) {
	t.Parallel()

	m := routes.NewSmithersMetrics()

	// Observe some query durations
	m.DBQueryDurationSeconds.WithLabelValues("GetUserByID").Observe(0.001)
	m.DBQueryDurationSeconds.WithLabelValues("ListRepos").Observe(0.005)

	req := httptest.NewRequest(http.MethodGet, "/metrics", nil)
	rec := httptest.NewRecorder()
	m.Handler().ServeHTTP(rec, req)

	body, err := io.ReadAll(rec.Body)
	require.NoError(t, err)
	output := string(body)

	// Should have histogram entries for both queries
	assert.Contains(t, output, `query="GetUserByID"`)
	assert.Contains(t, output, `query="ListRepos"`)
}

// TestSmithersMetrics_RepoHostOperationDuration_LabeledByOperation verifies the
// repo-host operation duration histogram is labeled by operation type.
func TestSmithersMetrics_RepoHostOperationDuration_LabeledByOperation(t *testing.T) {
	t.Parallel()

	m := routes.NewSmithersMetrics()

	m.RepoHostOperationDurationSeconds.WithLabelValues("clone").Observe(0.5)
	m.RepoHostOperationDurationSeconds.WithLabelValues("fetch").Observe(0.1)

	req := httptest.NewRequest(http.MethodGet, "/metrics", nil)
	rec := httptest.NewRecorder()
	m.Handler().ServeHTTP(rec, req)

	body, err := io.ReadAll(rec.Body)
	require.NoError(t, err)
	output := string(body)

	assert.Contains(t, output, `operation="clone"`)
	assert.Contains(t, output, `operation="fetch"`)
}

// TestSmithersMetrics_ObserveDBQueryDuration_Method verifies the convenience
// method for observing DB query duration records correctly.
func TestSmithersMetrics_ObserveDBQueryDuration_Method(t *testing.T) {
	t.Parallel()

	m := routes.NewSmithersMetrics()

	// Use the method (not direct histogram access).
	m.ObserveDBQueryDuration("SELECT", 0.003)
	m.ObserveDBQueryDuration("INSERT", 0.007)

	req := httptest.NewRequest(http.MethodGet, "/metrics", nil)
	rec := httptest.NewRecorder()
	m.Handler().ServeHTTP(rec, req)

	body, err := io.ReadAll(rec.Body)
	require.NoError(t, err)
	output := string(body)

	assert.Contains(t, output, `query="SELECT"`)
	assert.Contains(t, output, `query="INSERT"`)
	assert.Contains(t, output, `smithers_db_query_duration_seconds_count{query="SELECT"} 1`)
	assert.Contains(t, output, `smithers_db_query_duration_seconds_count{query="INSERT"} 1`)
}

// TestSmithersMetrics_ObserveRepoHostOperationDuration_Method verifies the convenience
// method for observing repo-host operation duration records correctly.
func TestSmithersMetrics_ObserveRepoHostOperationDuration_Method(t *testing.T) {
	t.Parallel()

	m := routes.NewSmithersMetrics()

	m.ObserveRepoHostOperationDuration("list_changes", 0.025)
	m.ObserveRepoHostOperationDuration("get_diff", 0.100)

	req := httptest.NewRequest(http.MethodGet, "/metrics", nil)
	rec := httptest.NewRecorder()
	m.Handler().ServeHTTP(rec, req)

	body, err := io.ReadAll(rec.Body)
	require.NoError(t, err)
	output := string(body)

	assert.Contains(t, output, `operation="list_changes"`)
	assert.Contains(t, output, `operation="get_diff"`)
}

// TestSmithersMetrics_MetricsEndpoint_ContainsHELPAndTYPELines verifies that every metric
// in the /metrics output has corresponding # HELP and # TYPE lines, as required
// by the Prometheus exposition format spec.
func TestSmithersMetrics_MetricsEndpoint_ContainsHELPAndTYPELines(t *testing.T) {
	t.Parallel()

	m := routes.NewSmithersMetrics()

	// Seed all counters and histograms to ensure they appear.
	m.HTTPRequestsTotal.WithLabelValues("GET", "/health", "200").Inc()
	m.HTTPRequestDurationSeconds.WithLabelValues("GET", "/health").Observe(0.001)
	m.ObserveAgentSessionCompletion("failed")
	m.ObserveAgentSessionTimeout()
	m.WorkflowRunsTotal.WithLabelValues("success").Inc()
	m.WorkflowDurationSeconds.WithLabelValues("success").Observe(1.0)
	m.RepoHostOperationDurationSeconds.WithLabelValues("list").Observe(0.01)
	m.DBQueryDurationSeconds.WithLabelValues("SELECT").Observe(0.002)

	req := httptest.NewRequest(http.MethodGet, "/metrics", nil)
	rec := httptest.NewRecorder()
	m.Handler().ServeHTTP(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)

	body, err := io.ReadAll(rec.Body)
	require.NoError(t, err)
	output := string(body)

	// Every required metric must have a HELP line.
	requiredMetrics := []string{
		"smithers_http_requests_total",
		"smithers_http_request_duration_seconds",
		"smithers_active_agent_sessions",
		"smithers_agent_session_timeouts_total",
		"smithers_agent_sessions_completed_total",
		"smithers_workflow_runs_total",
		"smithers_workflow_duration_seconds",
		"smithers_repo_host_client_operation_duration_seconds",
		"smithers_db_query_duration_seconds",
		"smithers_sse_active_connections",
	}

	for _, metricName := range requiredMetrics {
		assert.Contains(t, output, "# HELP "+metricName,
			"metric %q must have a # HELP line", metricName)
		assert.Contains(t, output, "# TYPE "+metricName,
			"metric %q must have a # TYPE line", metricName)
	}
}
