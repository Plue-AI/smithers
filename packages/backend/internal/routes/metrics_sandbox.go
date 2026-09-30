package routes

import "github.com/prometheus/client_golang/prometheus"

// SandboxLegacyMetrics holds Prometheus metrics for Microsandbox VM lifecycle,
// API request instrumentation, and error tracking. The Go field name remains
// for compatibility with older service interfaces; metric names use
// smithers_microsandbox_* because the backing provider is Microsandbox.
type SandboxLegacyMetrics struct {
	// VMCreateDurationSeconds records Microsandbox VM creation latency.
	VMCreateDurationSeconds *prometheus.HistogramVec

	// VMCreateTotal counts Microsandbox VM create attempts by type and outcome.
	VMCreateTotal *prometheus.CounterVec

	// ActiveVMs tracks the number of active Microsandbox VMs by type.
	ActiveVMs *prometheus.GaugeVec

	// VMSuspendDurationSeconds records Microsandbox suspend/resume latency.
	VMSuspendDurationSeconds prometheus.Histogram

	// APIRequestDurationSeconds records Microsandbox API request latency.
	APIRequestDurationSeconds *prometheus.HistogramVec

	// APIErrorsTotal counts Microsandbox API errors by endpoint and code.
	APIErrorsTotal *prometheus.CounterVec

	// AgentSecretDeliveryTotal counts agent-session secrets by delivery path:
	// "egress_proxy" (guest holds a placeholder, the per-sandbox proxy swaps
	// it) or "legacy_env" (plaintext in the guest environment). The legacy
	// series is the number that has to reach zero.
	AgentSecretDeliveryTotal *prometheus.CounterVec

	// HoursMeteringErrorsTotal counts owners whose sandbox-hours metering the
	// running-workspace sweep could not read; their workspaces kept running.
	HoursMeteringErrorsTotal prometheus.Counter
}

// NewSandboxLegacyMetrics creates a new SandboxLegacyMetrics instance and registers all
// metrics with the provided Prometheus registerer. Pass nil to skip registration.
func NewSandboxLegacyMetrics(reg prometheus.Registerer) *SandboxLegacyMetrics {
	m := &SandboxLegacyMetrics{
		VMCreateDurationSeconds: prometheus.NewHistogramVec(
			prometheus.HistogramOpts{
				Name:    "smithers_microsandbox_vm_create_duration_seconds",
				Help:    "Duration of Microsandbox VM creation requests in seconds.",
				Buckets: []float64{0.1, 0.25, 0.5, 1, 2, 5, 10, 30},
			},
			[]string{"type"},
		),
		VMCreateTotal: prometheus.NewCounterVec(
			prometheus.CounterOpts{
				Name: "smithers_microsandbox_vm_create_total",
				Help: "Total number of Microsandbox VM create attempts, labeled by type and status.",
			},
			[]string{"type", "status"},
		),
		ActiveVMs: prometheus.NewGaugeVec(
			prometheus.GaugeOpts{
				Name: "smithers_microsandbox_active_vms",
				Help: "Number of active Microsandbox VMs by workload type.",
			},
			[]string{"type"},
		),
		VMSuspendDurationSeconds: prometheus.NewHistogram(
			prometheus.HistogramOpts{
				Name:    "smithers_microsandbox_vm_suspend_duration_seconds",
				Help:    "Duration of Microsandbox VM suspend or resume operations in seconds.",
				Buckets: []float64{0.05, 0.1, 0.25, 0.5, 1, 2, 5},
			},
		),
		APIRequestDurationSeconds: prometheus.NewHistogramVec(
			prometheus.HistogramOpts{
				Name:    "smithers_microsandbox_api_request_duration_seconds",
				Help:    "Duration of Microsandbox API requests in seconds.",
				Buckets: prometheus.DefBuckets,
			},
			[]string{"method", "endpoint"},
		),
		APIErrorsTotal: prometheus.NewCounterVec(
			prometheus.CounterOpts{
				Name: "smithers_microsandbox_api_errors_total",
				Help: "Total number of Microsandbox API errors by endpoint and error code.",
			},
			[]string{"endpoint", "error_code"},
		),
		AgentSecretDeliveryTotal: prometheus.NewCounterVec(
			prometheus.CounterOpts{
				Name: "smithers_agent_secret_delivery_total",
				Help: "Agent-session secrets by delivery path: egress_proxy (placeholder in guest, swapped by the per-sandbox proxy) or legacy_env (plaintext in the guest environment).",
			},
			[]string{"path"},
		),
		HoursMeteringErrorsTotal: prometheus.NewCounter(
			prometheus.CounterOpts{
				Name: "smithers_sandbox_hours_metering_errors_total",
				Help: "Owners whose sandbox-hours metering the daily-cap sweep could not read; their running workspaces were left running.",
			},
		),
	}

	if reg != nil {
		reg.MustRegister(
			m.VMCreateDurationSeconds,
			m.VMCreateTotal,
			m.ActiveVMs,
			m.VMSuspendDurationSeconds,
			m.APIRequestDurationSeconds,
			m.APIErrorsTotal,
			m.AgentSecretDeliveryTotal,
			m.HoursMeteringErrorsTotal,
		)
	}

	return m
}
