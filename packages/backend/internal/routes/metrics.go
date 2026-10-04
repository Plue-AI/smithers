package routes

import (
	"net/http"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// SmithersMetrics holds all Prometheus metric definitions for the Smithers API.
// Metric names follow the spec in docs/specs/infra.md §8.1:
// smithers_{subsystem}_{name}_{unit}
//
// Metrics are organized into domain-specific sub-structs. Direct field access
// on SmithersMetrics (e.g. m.HTTPRequestsTotal) is preserved for backward
// compatibility; each field delegates to the corresponding sub-struct field.
type SmithersMetrics struct {
	// HTTP holds HTTP request, SSE, DB query, and git-over-HTTP metrics.
	HTTP *HTTPMetrics

	// Workflow holds runner pool, task queue, workflow run, and agent session metrics.
	Workflow *WorkflowMetrics

	// Webhook holds webhook delivery metrics.
	Webhook *WebhookMetrics

	// Sandbox holds Microsandbox VM lifecycle and API metrics.
	// The field name is retained for older service interfaces.
	Sandbox *SandboxLegacyMetrics

	// --- Backward-compatible field aliases (delegate to sub-structs) ---

	// HTTPRequestsTotal counts all HTTP requests by method, path, and status code.
	HTTPRequestsTotal *prometheus.CounterVec

	// HTTPRequestDurationSeconds records request latency as a histogram.
	HTTPRequestDurationSeconds *prometheus.HistogramVec

	// ActiveAgentSessions tracks the number of currently open AI agent sessions.
	ActiveAgentSessions prometheus.Gauge

	// WorkflowRunsTotal counts completed workflow runs by status.
	WorkflowRunsTotal *prometheus.CounterVec

	// WorkflowDurationSeconds records workflow execution time.
	WorkflowDurationSeconds *prometheus.HistogramVec

	// WebhookDeliveryAttemptsTotal counts webhook delivery attempts by outcome.
	WebhookDeliveryAttemptsTotal *prometheus.CounterVec

	// WebhookDeliveryTerminalOutcomesTotal counts terminal webhook delivery outcomes.
	WebhookDeliveryTerminalOutcomesTotal *prometheus.CounterVec

	// RepoHostOperationDurationSeconds records repo-host RPC latency.
	RepoHostOperationDurationSeconds *prometheus.HistogramVec

	// DBQueryDurationSeconds records database query latency.
	DBQueryDurationSeconds *prometheus.HistogramVec

	// SSEActiveConnections tracks open SSE streaming connections.
	SSEActiveConnections prometheus.Gauge

	// DBConnectionsActive tracks the number of currently acquired database connections.
	DBConnectionsActive prometheus.Gauge

	// DBConnectionsMax tracks the maximum pool size for database connections.
	DBConnectionsMax prometheus.Gauge

	// ClientErrorsTotal counts client-reported errors by client and error type.
	ClientErrorsTotal *prometheus.CounterVec

	// SandboxVMCreateDurationSeconds records Microsandbox VM creation latency.
	SandboxVMCreateDurationSeconds *prometheus.HistogramVec

	// SandboxVMCreateTotal counts Microsandbox VM create attempts by type and outcome.
	SandboxVMCreateTotal *prometheus.CounterVec

	// SandboxActiveVMs tracks the number of active Microsandbox VMs by type.
	SandboxActiveVMs *prometheus.GaugeVec

	// SandboxVMSuspendDurationSeconds records Microsandbox suspend/resume latency.
	SandboxVMSuspendDurationSeconds prometheus.Histogram

	// SandboxAPIRequestDurationSeconds records Microsandbox API request latency.
	SandboxAPIRequestDurationSeconds *prometheus.HistogramVec

	// SandboxAPIErrorsTotal counts Microsandbox API errors by endpoint and code.
	SandboxAPIErrorsTotal *prometheus.CounterVec

	// HTTPGitOperationsTotal counts HTTP smart git operations by command and result.
	HTTPGitOperationsTotal *prometheus.CounterVec

	// HTTPGitOperationDurationSeconds records the duration of HTTP smart git operations.
	HTTPGitOperationDurationSeconds *prometheus.HistogramVec

	// AgentSessionsCompletedTotal counts completed agent sessions by status.
	AgentSessionsCompletedTotal *prometheus.CounterVec

	// AgentSessionTimeoutsTotal counts agent session timeouts.
	AgentSessionTimeoutsTotal prometheus.Counter

	// ActiveAgentSessionOldestAgeSeconds tracks the age of the oldest active agent session.
	ActiveAgentSessionOldestAgeSeconds prometheus.Gauge

	// RunnerCacheHitTotal counts runner cache lookups by result (hit/miss).
	RunnerCacheHitTotal *prometheus.CounterVec

	// LandingOperationsTotal counts landing operations by operation type.
	LandingOperationsTotal *prometheus.CounterVec

	// LandingQueueDepth tracks the depth of the landing queue.
	LandingQueueDepth prometheus.Gauge

	// AuthOperationsTotal counts authentication operations by method and result.
	AuthOperationsTotal *prometheus.CounterVec

	// WorkspaceLifecycleTotal counts workspace lifecycle events by action and result.
	WorkspaceLifecycleTotal *prometheus.CounterVec

	// WorkspaceSessionProvisionTotal counts workspace-session provisioning outcomes.
	WorkspaceSessionProvisionTotal *prometheus.CounterVec

	// WorkspaceSessionProvisionDurationSeconds records workspace-session provisioning latency.
	WorkspaceSessionProvisionDurationSeconds *prometheus.HistogramVec

	// WorkspaceTerminalAttachTotal counts terminal WebSocket attach outcomes.
	WorkspaceTerminalAttachTotal *prometheus.CounterVec
	TerminalInputDroppedTotal    prometheus.Counter

	// WorkspaceLSPAttachTotal counts language-server WebSocket attach outcomes (#505).
	WorkspaceLSPAttachTotal *prometheus.CounterVec

	MirrorAttemptsTotal        *prometheus.CounterVec
	MirrorFailuresTotal        *prometheus.CounterVec
	MirrorDurationSeconds      *prometheus.HistogramVec
	MirrorCloneBytes           prometheus.Histogram
	MirrorCloneDurationSeconds prometheus.Histogram
	MirrorPollLatencySeconds   prometheus.Histogram
	BranchCreateTotal          *prometheus.CounterVec

	// --- Ticket 0132: per-surface rate-limit observability. ---

	// RateLimitRejectionsTotal counts 429 rejections by scope. Scopes:
	// workspace_terminal_open, workspace_terminal_active, approval_decide.
	// Hit type (open-rate vs active-cap) is encoded in the scope suffix
	// rather than a separate label, matching the label convention for
	// existing rate-limit metrics.
	RateLimitRejectionsTotal *prometheus.CounterVec

	// WorkspaceTerminalActiveConnections gauges open terminal WebSockets
	// per user.
	WorkspaceTerminalActiveConnections *prometheus.GaugeVec

	// CanaryWebhookLastReceivedTimestampSeconds records the last accepted
	// production canary webhook receipt as a Unix timestamp.
	CanaryWebhookLastReceivedTimestampSeconds prometheus.Gauge

	// registry is the Prometheus registry for this instance.
	registry *prometheus.Registry
}

// NewSmithersMetrics creates a new SmithersMetrics instance and registers all metrics
// with a fresh Prometheus registry (not the default global registry, so tests
// don't interfere with each other).
func NewSmithersMetrics() *SmithersMetrics {
	reg := prometheus.NewRegistry()

	httpM := NewHTTPMetrics(reg)
	workflowM := NewWorkflowMetrics(reg)
	webhookM := NewWebhookMetrics(reg)
	sandboxM := NewSandboxLegacyMetrics(reg)

	// Ticket 0132: rate-limit metrics. These live on SmithersMetrics
	// (rather than in a sub-struct) because only two routes + one
	// middleware consume them and grouping would add indirection.
	rateLimitRejections := prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "smithers_rate_limit_rejections_total",
			Help: "Total HTTP 429 rejections by scope (ticket 0132).",
		},
		[]string{"scope"},
	)
	terminalActiveGauge := prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "smithers_workspace_terminal_active_connections",
			Help: "Open terminal WebSocket connections per user.",
		},
		[]string{"user_id"},
	)
	mirrorAttempts := prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "smithers_mirror_attempts_total",
		Help: "Total github-to-jjhub mirror attempts by result.",
	}, []string{"result"})
	mirrorFailures := prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "smithers_mirror_failures_total",
		Help: "Total github-to-jjhub mirror failures by stage and reason.",
	}, []string{"stage", "reason"})
	mirrorDuration := prometheus.NewHistogramVec(prometheus.HistogramOpts{
		Name:    "smithers_mirror_duration_seconds",
		Help:    "Duration of github-to-jjhub mirror phases in seconds.",
		Buckets: prometheus.DefBuckets,
	}, []string{"phase"})
	mirrorCloneBytes := prometheus.NewHistogram(prometheus.HistogramOpts{
		Name:    "smithers_mirror_clone_bytes",
		Help:    "Approximate bytes cloned during github-to-jjhub mirror.",
		Buckets: []float64{1024, 10240, 102400, 1048576, 10485760, 104857600, 1073741824},
	})
	mirrorCloneDuration := prometheus.NewHistogram(prometheus.HistogramOpts{
		Name:    "smithers_mirror_clone_duration_seconds",
		Help:    "Duration of the GitHub clone phase for inbound mirrors.",
		Buckets: prometheus.DefBuckets,
	})
	mirrorPollLatency := prometheus.NewHistogram(prometheus.HistogramOpts{
		Name:    "smithers_mirror_poll_latency_seconds",
		Help:    "Latency of mirror import status polling.",
		Buckets: prometheus.DefBuckets,
	})
	branchCreate := prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "smithers_branch_create_total",
		Help: "Total bookmark creation attempts by result.",
	}, []string{"result"})
	workspaceSessionProvision := prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "smithers_workspace_session_provision_total",
		Help: "Total workspace-session provisioning outcomes by status.",
	}, []string{"status"})
	workspaceSessionProvisionDuration := prometheus.NewHistogramVec(prometheus.HistogramOpts{
		Name:    "smithers_workspace_session_provision_duration_seconds",
		Help:    "Duration of workspace-session provisioning in seconds.",
		Buckets: []float64{0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60, 120, 300, 600},
	}, []string{"status"})
	terminalInputDropped := prometheus.NewCounter(prometheus.CounterOpts{Name: "smithers_terminal_input_dropped_total", Help: "Terminal input frames dropped from read-only attachments."})
	workspaceTerminalAttach := prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "smithers_workspace_terminal_attach_total",
		Help: "Total workspace terminal WebSocket attach attempts by result.",
	}, []string{"result"})
	workspaceLSPAttach := prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "smithers_workspace_lsp_attach_total",
		Help: "Total workspace language-server WebSocket attach attempts by result.",
	}, []string{"result"})
	for _, status := range []string{"deferred", "failed", "success"} {
		workspaceSessionProvision.WithLabelValues(status)
		workspaceSessionProvisionDuration.WithLabelValues(status)
	}
	for _, result := range []string{
		"accept_error",
		"attach_error",
		"backend_error",
		"session_error",
		"session_failed",
		"session_pending",
		"session_stopped",
		"ssh_info_error",
		"success",
	} {
		workspaceTerminalAttach.WithLabelValues(result)
	}
	canaryWebhookLastReceived := prometheus.NewGauge(prometheus.GaugeOpts{
		Name: "smithers_canary_webhook_last_received_timestamp_seconds",
		Help: "Unix timestamp of the last accepted production canary webhook receipt.",
	})
	reg.MustRegister(
		rateLimitRejections,
		terminalActiveGauge,
		mirrorAttempts,
		mirrorFailures,
		mirrorDuration,
		mirrorCloneBytes,
		mirrorCloneDuration,
		mirrorPollLatency,
		branchCreate,
		workspaceSessionProvision,
		workspaceSessionProvisionDuration,
		workspaceTerminalAttach,
		terminalInputDropped,
		workspaceLSPAttach,
		canaryWebhookLastReceived,
	)

	return &SmithersMetrics{
		RateLimitRejectionsTotal:                  rateLimitRejections,
		WorkspaceTerminalActiveConnections:        terminalActiveGauge,
		MirrorAttemptsTotal:                       mirrorAttempts,
		MirrorFailuresTotal:                       mirrorFailures,
		MirrorDurationSeconds:                     mirrorDuration,
		MirrorCloneBytes:                          mirrorCloneBytes,
		MirrorCloneDurationSeconds:                mirrorCloneDuration,
		MirrorPollLatencySeconds:                  mirrorPollLatency,
		BranchCreateTotal:                         branchCreate,
		WorkspaceSessionProvisionTotal:            workspaceSessionProvision,
		WorkspaceSessionProvisionDurationSeconds:  workspaceSessionProvisionDuration,
		WorkspaceTerminalAttachTotal:              workspaceTerminalAttach,
		TerminalInputDroppedTotal:                 terminalInputDropped,
		WorkspaceLSPAttachTotal:                   workspaceLSPAttach,
		CanaryWebhookLastReceivedTimestampSeconds: canaryWebhookLastReceived,

		// Sub-structs
		HTTP:     httpM,
		Workflow: workflowM,
		Webhook:  webhookM,
		Sandbox:  sandboxM,

		// Backward-compatible aliases — point to the same prometheus collectors
		// that live inside the sub-structs.
		HTTPRequestsTotal:                httpM.RequestsTotal,
		HTTPRequestDurationSeconds:       httpM.RequestDurationSeconds,
		SSEActiveConnections:             httpM.SSEActiveConnections,
		DBQueryDurationSeconds:           httpM.DBQueryDurationSeconds,
		DBConnectionsActive:              httpM.DBConnectionsActive,
		DBConnectionsMax:                 httpM.DBConnectionsMax,
		ClientErrorsTotal:                httpM.ClientErrorsTotal,
		RepoHostOperationDurationSeconds: httpM.RepoHostOperationDurationSeconds,
		HTTPGitOperationsTotal:           httpM.GitOperationsTotal,
		HTTPGitOperationDurationSeconds:  httpM.GitOperationDurationSeconds,

		ActiveAgentSessions:     workflowM.ActiveAgentSessions,
		WorkflowRunsTotal:       workflowM.RunsTotal,
		WorkflowDurationSeconds: workflowM.DurationSeconds,

		WebhookDeliveryAttemptsTotal:         webhookM.DeliveryAttemptsTotal,
		WebhookDeliveryTerminalOutcomesTotal: webhookM.DeliveryTerminalOutcomesTotal,

		SandboxVMCreateDurationSeconds:   sandboxM.VMCreateDurationSeconds,
		SandboxVMCreateTotal:             sandboxM.VMCreateTotal,
		SandboxActiveVMs:                 sandboxM.ActiveVMs,
		SandboxVMSuspendDurationSeconds:  sandboxM.VMSuspendDurationSeconds,
		SandboxAPIRequestDurationSeconds: sandboxM.APIRequestDurationSeconds,
		SandboxAPIErrorsTotal:            sandboxM.APIErrorsTotal,

		AgentSessionsCompletedTotal:        workflowM.AgentSessionsCompletedTotal,
		AgentSessionTimeoutsTotal:          workflowM.AgentSessionTimeoutsTotal,
		ActiveAgentSessionOldestAgeSeconds: workflowM.ActiveAgentSessionOldestAgeSeconds,
		RunnerCacheHitTotal:                workflowM.RunnerCacheHitTotal,

		LandingOperationsTotal:  httpM.LandingOperationsTotal,
		LandingQueueDepth:       httpM.LandingQueueDepth,
		AuthOperationsTotal:     httpM.AuthOperationsTotal,
		WorkspaceLifecycleTotal: httpM.WorkspaceLifecycleTotal,

		registry: reg,
	}
}

// Handler returns the HTTP handler for the /metrics endpoint.
// It serves Prometheus text format (text/plain; version=0.0.4).
func (m *SmithersMetrics) Handler() http.Handler {
	return promhttp.HandlerFor(m.registry, promhttp.HandlerOpts{
		EnableOpenMetrics: false,
	})
}

// MustRegister registers additional collectors on the isolated Smithers registry.
func (m *SmithersMetrics) MustRegister(collectors ...prometheus.Collector) {
	if m == nil {
		return
	}
	m.registry.MustRegister(collectors...)
}

// Register adds deployment-owned collectors to the isolated Smithers registry
// and reports a conflicting or invalid collector instead of panicking.
func (m *SmithersMetrics) Register(collectors ...prometheus.Collector) error {
	for _, collector := range collectors {
		if err := m.registry.Register(collector); err != nil {
			return err
		}
	}
	return nil
}

// ObserveCanaryWebhookReceipt records a validated canary webhook delivery.
func (m *SmithersMetrics) ObserveCanaryWebhookReceipt(receivedAt time.Time) {
	if m == nil || m.CanaryWebhookLastReceivedTimestampSeconds == nil {
		return
	}
	m.CanaryWebhookLastReceivedTimestampSeconds.Set(float64(receivedAt.UTC().Unix()))
}

// RequestsTotal satisfies the middleware.HTTPMetricsRecorder interface.
// Returns the CounterVec for smithers_http_requests_total.
func (m *SmithersMetrics) RequestsTotal() *prometheus.CounterVec {
	return m.HTTP.RequestsTotal
}

// RequestDurationSeconds satisfies the middleware.HTTPMetricsRecorder interface.
// Returns the HistogramVec for smithers_http_request_duration_seconds.
func (m *SmithersMetrics) RequestDurationSeconds() *prometheus.HistogramVec {
	return m.HTTP.RequestDurationSeconds
}

// ObserveDBQueryDuration records the duration of a database query execution.
func (m *SmithersMetrics) ObserveDBQueryDuration(query string, seconds float64) {
	if m == nil {
		return
	}
	m.HTTP.DBQueryDurationSeconds.WithLabelValues(query).Observe(seconds)
}

// ObserveRepoHostOperationDuration records the duration of a repo-host operation.
func (m *SmithersMetrics) ObserveRepoHostOperationDuration(operation string, seconds float64) {
	if m == nil {
		return
	}
	m.HTTP.RepoHostOperationDurationSeconds.WithLabelValues(operation).Observe(seconds)
}

// SetDBConnectionsActive updates the gauge for currently acquired database connections.
func (m *SmithersMetrics) SetDBConnectionsActive(n float64) {
	if m == nil {
		return
	}
	m.HTTP.DBConnectionsActive.Set(n)
}

// SetDBConnectionsMax updates the gauge for the maximum database pool size.
func (m *SmithersMetrics) SetDBConnectionsMax(n float64) {
	if m == nil {
		return
	}
	m.HTTP.DBConnectionsMax.Set(n)
}

// SetActiveAgentSessions updates the gauge for active agent sessions.
func (m *SmithersMetrics) SetActiveAgentSessions(n float64) {
	if m == nil {
		return
	}
	m.Workflow.ActiveAgentSessions.Set(n)
}

// ObserveWorkflowRunCompletion records a terminal workflow run outcome.
func (m *SmithersMetrics) ObserveWorkflowRunCompletion(status string, seconds float64) {
	if m == nil {
		return
	}
	m.Workflow.RunsTotal.WithLabelValues(status).Inc()
	m.Workflow.DurationSeconds.WithLabelValues(status).Observe(seconds)
}

// ObserveWebhookDeliveryAttempt records a webhook delivery attempt outcome.
func (m *SmithersMetrics) ObserveWebhookDeliveryAttempt(outcome string) {
	if m == nil {
		return
	}
	m.Webhook.DeliveryAttemptsTotal.WithLabelValues(outcome).Inc()
}

// ObserveWebhookDeliveryTerminal records a terminal webhook delivery outcome.
func (m *SmithersMetrics) ObserveWebhookDeliveryTerminal(outcome string) {
	if m == nil {
		return
	}
	m.Webhook.DeliveryTerminalOutcomesTotal.WithLabelValues(outcome).Inc()
}

// ObserveSandboxAPIRequest records the duration of a Microsandbox API request.
func (m *SmithersMetrics) ObserveSandboxAPIRequest(method, endpoint string, seconds float64) {
	if m == nil {
		return
	}
	m.Sandbox.APIRequestDurationSeconds.WithLabelValues(method, endpoint).Observe(seconds)
}

// IncSandboxAPIErrors increments the Microsandbox API error counter.
func (m *SmithersMetrics) IncSandboxAPIErrors(endpoint, errorCode string) {
	if m == nil {
		return
	}
	m.Sandbox.APIErrorsTotal.WithLabelValues(endpoint, errorCode).Inc()
}

// ObserveSandboxVMCreate records a Microsandbox VM creation outcome.
func (m *SmithersMetrics) ObserveSandboxVMCreate(vmType, status string, seconds float64) {
	if m == nil {
		return
	}
	m.Sandbox.VMCreateDurationSeconds.WithLabelValues(vmType).Observe(seconds)
	m.Sandbox.VMCreateTotal.WithLabelValues(vmType, status).Inc()
}

// AddSandboxActiveVMs adjusts the active Microsandbox VM gauge.
func (m *SmithersMetrics) AddSandboxActiveVMs(vmType string, delta float64) {
	if m == nil {
		return
	}
	m.Sandbox.ActiveVMs.WithLabelValues(vmType).Add(delta)
}

// AddAgentSecretDelivery counts agent-session secrets by delivery path
// (services.SecretDeliveryMetricsRecorder).
func (m *SmithersMetrics) AddAgentSecretDelivery(path string, count int) {
	if m == nil || m.Sandbox == nil || count <= 0 {
		return
	}
	m.Sandbox.AgentSecretDeliveryTotal.WithLabelValues(path).Add(float64(count))
}

// AddSandboxHoursMeteringError counts one owner the daily sandbox-hours sweep
// could not meter (services.SandboxHoursMeteringRecorder).
func (m *SmithersMetrics) AddSandboxHoursMeteringError() {
	if m == nil || m.Sandbox == nil {
		return
	}
	m.Sandbox.HoursMeteringErrorsTotal.Inc()
}

// ObserveSandboxVMSuspend records Microsandbox suspend/resume latency.
func (m *SmithersMetrics) ObserveSandboxVMSuspend(seconds float64) {
	if m == nil {
		return
	}
	m.Sandbox.VMSuspendDurationSeconds.Observe(seconds)
}

// ObserveWorkspaceSessionProvision records a workspace-session provisioning outcome.
func (m *SmithersMetrics) ObserveWorkspaceSessionProvision(status string, seconds float64) {
	if m == nil {
		return
	}
	m.WorkspaceSessionProvisionTotal.WithLabelValues(status).Inc()
	m.WorkspaceSessionProvisionDurationSeconds.WithLabelValues(status).Observe(seconds)
}

// ObserveWorkspaceTerminalAttach records a terminal attach outcome.
func (m *SmithersMetrics) ObserveWorkspaceTerminalAttach(result string) {
	if m == nil {
		return
	}
	m.WorkspaceTerminalAttachTotal.WithLabelValues(result).Inc()
}

// ObserveWorkspaceLSPAttach records a language-server attach outcome (#505).
func (m *SmithersMetrics) ObserveWorkspaceLSPAttach(result string) {
	if m == nil || m.WorkspaceLSPAttachTotal == nil {
		return
	}
	m.WorkspaceLSPAttachTotal.WithLabelValues(result).Inc()
}

// ObserveHTTPGitOperation records an HTTP smart git operation's outcome and duration.
func (m *SmithersMetrics) ObserveHTTPGitOperation(command, result string, seconds float64) {
	if m == nil {
		return
	}
	m.HTTP.GitOperationsTotal.WithLabelValues(command, result).Inc()
	m.HTTP.GitOperationDurationSeconds.WithLabelValues(command).Observe(seconds)
}

// ObserveOAuth2TokenOperation records an OAuth2 token operation
// (issue, refresh, revoke, revoke_all).
func (m *SmithersMetrics) ObserveOAuth2TokenOperation(operation string) {
	if m == nil {
		return
	}
	m.HTTP.OAuth2TokenOperationsTotal.WithLabelValues(operation).Inc()
}

// IncValidationRejection records a request validation rejection.
func (m *SmithersMetrics) IncValidationRejection(resource, field string) {
	if m == nil {
		return
	}
	m.HTTP.ValidationRejectionsTotal.WithLabelValues(resource, field).Inc()
}

// IncWebSocketOriginRejection records a WebSocket origin rejection.
// Counted as a validation rejection with resource "WebSocket" and field "origin".
func (m *SmithersMetrics) IncWebSocketOriginRejection() {
	if m == nil {
		return
	}
	m.HTTP.ValidationRejectionsTotal.WithLabelValues("WebSocket", "origin").Inc()
}

// ValidationRejectionsTotal returns the validation rejections counter for tests.
func (m *SmithersMetrics) ValidationRejectionsTotal() *prometheus.CounterVec {
	return m.HTTP.ValidationRejectionsTotal
}

// ObserveAgentSessionCompletion records a completed agent session by status.
func (m *SmithersMetrics) ObserveAgentSessionCompletion(status string) {
	if m == nil {
		return
	}
	m.Workflow.AgentSessionsCompletedTotal.WithLabelValues(status).Inc()
}

// ObserveAgentSessionTimeout records an agent session that timed out.
func (m *SmithersMetrics) ObserveAgentSessionTimeout() {
	if m == nil {
		return
	}
	m.Workflow.AgentSessionTimeoutsTotal.Inc()
}

// ObserveRunnerCacheHit records a runner cache hit or miss by result label.
func (m *SmithersMetrics) ObserveRunnerCacheHit(result string) {
	if m == nil {
		return
	}
	m.Workflow.RunnerCacheHitTotal.WithLabelValues(result).Inc()
}

// ObserveLandingOperation records a landing operation by operation type.
func (m *SmithersMetrics) ObserveLandingOperation(operation string) {
	if m == nil {
		return
	}
	m.HTTP.LandingOperationsTotal.WithLabelValues(operation).Inc()
}

// SetLandingQueueDepth updates the gauge for the landing queue depth.
func (m *SmithersMetrics) SetLandingQueueDepth(n int) {
	if m == nil {
		return
	}
	m.HTTP.LandingQueueDepth.Set(float64(n))
}

// SetCodeSearchBacklog updates the code-search backlog gauges.
func (m *SmithersMetrics) SetCodeSearchBacklog(repositories int, oldestAgeSeconds float64) {
	if m == nil {
		return
	}
	m.HTTP.CodeSearchBacklogRepositories.Set(float64(repositories))
	m.HTTP.CodeSearchBacklogOldestAgeSeconds.Set(oldestAgeSeconds)
}

// ObserveAuthOperation records an authentication operation by method and result.
func (m *SmithersMetrics) ObserveAuthOperation(method, result string) {
	if m == nil {
		return
	}
	m.HTTP.AuthOperationsTotal.WithLabelValues(method, result).Inc()
}

// ObserveWorkspaceLifecycle records a workspace lifecycle event by action and result.
func (m *SmithersMetrics) ObserveWorkspaceLifecycle(action, result string) {
	if m == nil {
		return
	}
	m.HTTP.WorkspaceLifecycleTotal.WithLabelValues(action, result).Inc()
}

func (m *SmithersMetrics) ObserveMirrorAttempt(result string) {
	if m == nil {
		return
	}
	m.MirrorAttemptsTotal.WithLabelValues(result).Inc()
}

func (m *SmithersMetrics) ObserveMirrorFailure(stage, reason string) {
	if m == nil {
		return
	}
	m.MirrorFailuresTotal.WithLabelValues(stage, reason).Inc()
}

func (m *SmithersMetrics) ObserveMirrorDuration(phase string, seconds float64) {
	if m == nil {
		return
	}
	m.MirrorDurationSeconds.WithLabelValues(phase).Observe(seconds)
}

func (m *SmithersMetrics) ObserveMirrorCloneBytes(bytes float64) {
	if m == nil {
		return
	}
	m.MirrorCloneBytes.Observe(bytes)
}

func (m *SmithersMetrics) ObserveMirrorCloneDuration(seconds float64) {
	if m == nil {
		return
	}
	m.MirrorCloneDurationSeconds.Observe(seconds)
}

func (m *SmithersMetrics) ObserveBranchCreate(result string) {
	if m == nil {
		return
	}
	m.BranchCreateTotal.WithLabelValues(result).Inc()
}

func observeMirrorPoll(m *SmithersMetrics) func() {
	started := prometheus.NewTimer(prometheus.ObserverFunc(func(seconds float64) {
		if m != nil {
			m.MirrorPollLatencySeconds.Observe(seconds)
		}
	}))
	return func() {
		_ = started.ObserveDuration()
	}
}

// SetActiveAgentSessionOldestAgeSeconds updates the gauge for the oldest active agent session age.
func (m *SmithersMetrics) SetActiveAgentSessionOldestAgeSeconds(n float64) {
	if m == nil {
		return
	}
	m.Workflow.ActiveAgentSessionOldestAgeSeconds.Set(n)
}
