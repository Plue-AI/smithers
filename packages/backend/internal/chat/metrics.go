package chat

import (
	"errors"

	"github.com/prometheus/client_golang/prometheus"
)

// metrics is the chat runtime's saturation and failure record. Collectors
// returns it for the process registry.
type metrics struct {
	queued         prometheus.GaugeFunc
	running        prometheus.Gauge
	claims         prometheus.Counter
	failures       *prometheus.CounterVec
	recoveryErrors prometheus.Counter
	latencies      *turnLatencies
}

func newMetrics(queued func() float64) *metrics {
	return &metrics{
		latencies: newTurnLatencies(),
		queued: prometheus.NewGaugeFunc(prometheus.GaugeOpts{
			Name: "smithers_chat_turns_queued",
			Help: "Admitted chat turns waiting in this process's dispatch queue.",
		}, queued),
		running: prometheus.NewGauge(prometheus.GaugeOpts{
			Name: "smithers_chat_turns_running",
			Help: "Chat turns this process is producing now.",
		}),
		claims: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "smithers_chat_turn_claims_total",
			Help: "Producer claims granted to this process.",
		}),
		failures: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "smithers_chat_turn_failures_total",
			Help: "Chat turn producer failures by code.",
		}, []string{"code"}),
		recoveryErrors: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "smithers_chat_recovery_errors_total",
			Help: "Failed scans for recoverable chat turns.",
		}),
	}
}

func (m *metrics) collectors() []prometheus.Collector {
	return []prometheus.Collector{m.queued, m.running, m.claims, m.failures, m.recoveryErrors, m.latencies.seconds, m.latencies.omitted}
}

// errorCode names a store error for logs and metric labels.
func errorCode(err error) string {
	switch {
	case err == nil:
		return "ok"
	case errors.Is(err, ErrCorrupt):
		return "corrupt"
	case errors.Is(err, ErrProducerFenced):
		return "producer_fenced"
	case errors.Is(err, ErrProducerBusy):
		return "producer_busy"
	case errors.Is(err, ErrTerminal):
		return "terminal"
	case errors.Is(err, ErrRetired):
		return "retired"
	case errors.Is(err, ErrUncertain):
		return "uncertain"
	case errors.Is(err, ErrNotFound):
		return "not_found"
	case errors.Is(err, ErrForbidden):
		return "forbidden"
	case errors.Is(err, ErrLimit):
		return "limit"
	case errors.Is(err, ErrCursorConflict):
		return "cursor"
	case errors.Is(err, ErrInvalidRequest), errors.Is(err, ErrInvalidFrame):
		return "invalid"
	default:
		return "storage"
	}
}
