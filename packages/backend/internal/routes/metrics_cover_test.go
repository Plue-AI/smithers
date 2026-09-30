package routes

import (
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/testutil"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func metricsCovScrape(t *testing.T, m *SmithersMetrics) string {
	t.Helper()

	req := httptest.NewRequest(http.MethodGet, "/metrics", nil)
	rec := httptest.NewRecorder()
	m.Handler().ServeHTTP(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	body, err := io.ReadAll(rec.Body)
	require.NoError(t, err)
	return string(body)
}

func TestMetrics_Cov_NilReceiverNoops(t *testing.T) {
	var m *SmithersMetrics
	custom := prometheus.NewGauge(prometheus.GaugeOpts{
		Name: "smithers_cov_nil_receiver_custom",
		Help: "Coverage-only custom collector.",
	})

	require.NotPanics(t, func() {
		m.MustRegister(custom)
		m.ObserveCanaryWebhookReceipt(time.Unix(1700000000, 0))
		m.ObserveDBQueryDuration("select", 0.01)
		m.ObserveRepoHostOperationDuration("clone", 0.02)
		m.SetDBConnectionsActive(1)
		m.SetDBConnectionsMax(2)
		m.SetActiveAgentSessions(7)
		m.ObserveWorkflowRunCompletion("success", 8)
		m.ObserveWebhookDeliveryAttempt("retry")
		m.ObserveWebhookDeliveryTerminal("failed")
		m.ObserveSandboxAPIRequest("GET", "/vms", 0.03)
		m.IncSandboxAPIErrors("/vms", "500")
		m.ObserveSandboxVMCreate("runner", "success", 0.04)
		m.AddSandboxActiveVMs("runner", 1)
		m.ObserveSandboxVMSuspend(0.05)
		m.ObserveHTTPGitOperation("upload-pack", "ok", 0.06)
		m.ObserveOAuth2TokenOperation("issue")
		m.IncValidationRejection("repo", "name")
		m.IncWebSocketOriginRejection()
		m.ObserveAgentSessionCompletion("completed")
		m.ObserveAgentSessionTimeout()
		m.ObserveRunnerCacheHit("hit")
		m.ObserveLandingOperation("land")
		m.SetLandingQueueDepth(9)
		m.SetCodeSearchBacklog(1, 2)
		m.ObserveAuthOperation("github", "success")
		m.ObserveWorkspaceLifecycle("resume", "success")
		m.ObserveMirrorAttempt("success")
		m.ObserveMirrorFailure("fetch", "timeout")
		m.ObserveMirrorDuration("clone", 0.07)
		m.ObserveMirrorCloneBytes(1024)
		m.ObserveMirrorCloneDuration(0.08)
		m.ObserveBranchCreate("created")
		m.SetActiveAgentSessionOldestAgeSeconds(10)
		observeMirrorPoll(m)()
	})

	empty := &SmithersMetrics{}
	require.NotPanics(t, func() {
		empty.ObserveCanaryWebhookReceipt(time.Unix(1700000001, 0))
	})
}

func TestMetrics_Cov_ConvenienceRecordersExposeAndRecordMetrics(t *testing.T) {
	m := NewSmithersMetrics()
	custom := prometheus.NewGauge(prometheus.GaugeOpts{
		Name: "smithers_cov_custom_registered",
		Help: "Coverage-only custom collector.",
	})

	m.MustRegister(custom)
	custom.Set(42)

	assert.Same(t, m.HTTPRequestsTotal, m.RequestsTotal())
	assert.Same(t, m.HTTPRequestDurationSeconds, m.RequestDurationSeconds())
	assert.Same(t, m.HTTP.ValidationRejectionsTotal, m.ValidationRejectionsTotal())

	receivedAt := time.Unix(1700000000, 0)
	m.ObserveCanaryWebhookReceipt(receivedAt)
	m.RequestsTotal().WithLabelValues("GET", "/cov", "204").Inc()
	m.RequestDurationSeconds().WithLabelValues("GET", "/cov").Observe(0.25)
	m.ObserveDBQueryDuration("cov_select", 0.03)
	m.ObserveRepoHostOperationDuration("cov_clone", 0.04)
	m.SetDBConnectionsActive(2)
	m.SetDBConnectionsMax(9)
	m.SetActiveAgentSessions(7)
	m.ObserveWorkflowRunCompletion("cov_success", 8)
	m.ObserveWebhookDeliveryAttempt("cov_retry")
	m.ObserveWebhookDeliveryTerminal("cov_dead")
	m.ObserveSandboxAPIRequest("POST", "/cov", 0.11)
	m.IncSandboxAPIErrors("/cov", "E_COV")
	m.ObserveSandboxVMCreate("covvm", "ready", 0.12)
	m.AddSandboxActiveVMs("covvm", 2)
	m.ObserveSandboxVMSuspend(0.13)
	m.ObserveHTTPGitOperation("upload-pack", "ok", 0.14)
	m.ObserveOAuth2TokenOperation("cov_issue")
	m.IncValidationRejection("Repo", "name")
	m.IncWebSocketOriginRejection()
	m.ObserveAgentSessionCompletion("cov_done")
	m.ObserveAgentSessionTimeout()
	m.ObserveRunnerCacheHit("hit")
	m.ObserveLandingOperation("cov_land")
	m.SetLandingQueueDepth(13)
	m.ObserveAuthOperation("oauth", "cov_success")
	m.ObserveWorkspaceLifecycle("resume", "cov_success")
	m.ObserveMirrorAttempt("success")
	m.ObserveMirrorFailure("fetch", "timeout")
	m.ObserveMirrorDuration("clone", 0.15)
	m.ObserveMirrorCloneBytes(2048)
	m.ObserveMirrorCloneDuration(0.16)
	m.ObserveBranchCreate("created")
	m.SetActiveAgentSessionOldestAgeSeconds(21)
	observeMirrorPoll(m)()

	assert.Equal(t, float64(42), testutil.ToFloat64(custom))
	assert.Equal(t, float64(receivedAt.Unix()), testutil.ToFloat64(m.CanaryWebhookLastReceivedTimestampSeconds))
	assert.Equal(t, float64(1), testutil.ToFloat64(m.RequestsTotal().WithLabelValues("GET", "/cov", "204")))
	assert.Equal(t, float64(2), testutil.ToFloat64(m.HTTP.DBConnectionsActive))
	assert.Equal(t, float64(9), testutil.ToFloat64(m.HTTP.DBConnectionsMax))
	assert.Equal(t, float64(7), testutil.ToFloat64(m.Workflow.ActiveAgentSessions))
	assert.Equal(t, float64(1), testutil.ToFloat64(m.Workflow.RunsTotal.WithLabelValues("cov_success")))
	assert.Equal(t, float64(1), testutil.ToFloat64(m.Webhook.DeliveryAttemptsTotal.WithLabelValues("cov_retry")))
	assert.Equal(t, float64(1), testutil.ToFloat64(m.Webhook.DeliveryTerminalOutcomesTotal.WithLabelValues("cov_dead")))
	assert.Equal(t, float64(1), testutil.ToFloat64(m.Sandbox.APIErrorsTotal.WithLabelValues("/cov", "E_COV")))
	assert.Equal(t, float64(1), testutil.ToFloat64(m.Sandbox.VMCreateTotal.WithLabelValues("covvm", "ready")))
	assert.Equal(t, float64(2), testutil.ToFloat64(m.Sandbox.ActiveVMs.WithLabelValues("covvm")))
	assert.Equal(t, float64(1), testutil.ToFloat64(m.HTTP.GitOperationsTotal.WithLabelValues("upload-pack", "ok")))
	assert.Equal(t, float64(1), testutil.ToFloat64(m.HTTP.OAuth2TokenOperationsTotal.WithLabelValues("cov_issue")))
	assert.Equal(t, float64(1), testutil.ToFloat64(m.HTTP.ValidationRejectionsTotal.WithLabelValues("Repo", "name")))
	assert.Equal(t, float64(1), testutil.ToFloat64(m.HTTP.ValidationRejectionsTotal.WithLabelValues("WebSocket", "origin")))
	assert.Equal(t, float64(1), testutil.ToFloat64(m.Workflow.AgentSessionsCompletedTotal.WithLabelValues("cov_done")))
	assert.Equal(t, float64(1), testutil.ToFloat64(m.Workflow.AgentSessionTimeoutsTotal))
	assert.Equal(t, float64(1), testutil.ToFloat64(m.Workflow.RunnerCacheHitTotal.WithLabelValues("hit")))
	assert.Equal(t, float64(1), testutil.ToFloat64(m.HTTP.LandingOperationsTotal.WithLabelValues("cov_land")))
	assert.Equal(t, float64(13), testutil.ToFloat64(m.HTTP.LandingQueueDepth))
	assert.Equal(t, float64(1), testutil.ToFloat64(m.HTTP.AuthOperationsTotal.WithLabelValues("oauth", "cov_success")))
	assert.Equal(t, float64(1), testutil.ToFloat64(m.HTTP.WorkspaceLifecycleTotal.WithLabelValues("resume", "cov_success")))
	assert.Equal(t, float64(1), testutil.ToFloat64(m.MirrorAttemptsTotal.WithLabelValues("success")))
	assert.Equal(t, float64(1), testutil.ToFloat64(m.MirrorFailuresTotal.WithLabelValues("fetch", "timeout")))
	assert.Equal(t, float64(1), testutil.ToFloat64(m.BranchCreateTotal.WithLabelValues("created")))
	assert.Equal(t, float64(21), testutil.ToFloat64(m.Workflow.ActiveAgentSessionOldestAgeSeconds))

	output := metricsCovScrape(t, m)
	assert.Contains(t, output, "smithers_cov_custom_registered 42")
	assert.Contains(t, output, `smithers_http_request_duration_seconds_count{method="GET",path="/cov"} 1`)
	assert.Contains(t, output, `smithers_db_query_duration_seconds_count{query="cov_select"} 1`)
	assert.Contains(t, output, `smithers_repo_host_client_operation_duration_seconds_count{operation="cov_clone"} 1`)
	assert.Contains(t, output, `smithers_workflow_duration_seconds_sum{status="cov_success"} 8`)
	assert.Contains(t, output, `smithers_microsandbox_api_request_duration_seconds_count{endpoint="/cov",method="POST"} 1`)
	assert.Contains(t, output, `smithers_microsandbox_vm_create_duration_seconds_count{type="covvm"} 1`)
	assert.Contains(t, output, `smithers_microsandbox_vm_suspend_duration_seconds_count 1`)
	assert.Contains(t, output, `smithers_http_git_operation_duration_seconds_count{command="upload-pack"} 1`)
	assert.Contains(t, output, `smithers_mirror_duration_seconds_count{phase="clone"} 1`)
	assert.Contains(t, output, "smithers_mirror_clone_bytes_count 1")
	assert.Contains(t, output, "smithers_mirror_clone_duration_seconds_count 1")
	assert.Contains(t, output, "smithers_mirror_poll_latency_seconds_count 1")
}
