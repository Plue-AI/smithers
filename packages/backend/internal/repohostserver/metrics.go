package repohostserver

import (
	"net/http"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

var operationLabels = []string{
	"InitRepo",
	"DeleteRepo",
	"ImportRefs",
	"ProxyReceivePack",
	"ProxyUploadPack",
	"InfoRefs",
	"InitWikiRepo",
	"InitDocsRepo",
	"CommitWikiPage",
	"CommitDoc",
	"GetWikiPageContent",
	"GetDocContent",
	"ListWikiPageHistory",
	"ListDocHistory",
	"DeleteWikiPage",
	"DeleteDoc",
	"ListBookmarks",
	"CreateBookmark",
	"GetBookmark",
	"SetDefaultBookmark",
	"DeleteBookmark",
	"ListChanges",
	"GetChange",
	"GetChangeDiff",
	"GetChangeFiles",
	"ListFilesAtChange",
	"GetChangeConflicts",
	"GetFileAtChange",
	"LandChanges",
	"ListOperations",
	"CreateSnapshot",
	"StagedProvisionInfoRefs",
	"StagedProvisionReceivePack",
	"ReadWorkspaceSource",
	"PrepareLandAppend",
	"ProjectWikiRevision",
}

type Metrics struct {
	registry          *prometheus.Registry
	operationDuration *prometheus.HistogramVec
	serviceUp         prometheus.Gauge
	serviceHealth     prometheus.Gauge
	pushHookDelivery  *prometheus.CounterVec
	pushHookPending   prometheus.Gauge
	staleGitLocks     prometheus.Counter
}

func NewMetrics() (*Metrics, error) {
	return newMetrics(prometheus.NewRegistry())
}

func newMetrics(registry *prometheus.Registry) (*Metrics, error) {
	operationDuration := prometheus.NewHistogramVec(
		prometheus.HistogramOpts{
			Name: "smithers_repo_host_operation_duration_seconds",
			Help: "Repo-host operation duration in seconds.",
		},
		[]string{"operation"},
	)
	serviceUp := prometheus.NewGauge(prometheus.GaugeOpts{
		Name: "smithers_repo_host_service_up",
		Help: "Whether the repo-host process is running (1 = up).",
	})
	serviceHealth := prometheus.NewGauge(prometheus.GaugeOpts{
		Name: "smithers_repo_host_service_health",
		Help: "Latest repo-host health status (1 = healthy).",
	})

	pushHookDelivery := prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "smithers_repo_host_push_hook_deliveries_total",
		Help: "Push-hook delivery attempts by result (ok, not_found, retry, expired).",
	}, []string{"result"})
	pushHookPending := prometheus.NewGauge(prometheus.GaugeOpts{
		Name: "smithers_repo_host_push_hook_outbox_pending",
		Help: "Push events persisted in the outbox and not yet acknowledged by the API.",
	})

	staleGitLocks := prometheus.NewCounter(prometheus.CounterOpts{
		Name: "smithers_repo_host_stale_git_locks_removed_total",
		Help: "Git lock files a crashed writer left behind, removed under the repository lock.",
	})

	for _, label := range operationLabels {
		operationDuration.WithLabelValues(label)
	}
	for _, result := range []string{pushHookResultOK, pushHookResultNotFound, pushHookResultRetry, pushHookResultExpired} {
		pushHookDelivery.WithLabelValues(result)
	}

	if err := registry.Register(operationDuration); err != nil {
		return nil, err
	}
	if err := registry.Register(serviceUp); err != nil {
		return nil, err
	}
	if err := registry.Register(serviceHealth); err != nil {
		return nil, err
	}
	if err := registry.Register(pushHookDelivery); err != nil {
		return nil, err
	}
	if err := registry.Register(pushHookPending); err != nil {
		return nil, err
	}
	if err := registry.Register(staleGitLocks); err != nil {
		return nil, err
	}

	serviceUp.Set(1)

	return &Metrics{
		registry:          registry,
		operationDuration: operationDuration,
		serviceUp:         serviceUp,
		serviceHealth:     serviceHealth,
		pushHookDelivery:  pushHookDelivery,
		pushHookPending:   pushHookPending,
		staleGitLocks:     staleGitLocks,
	}, nil
}

func (m *Metrics) Handler() http.Handler {
	return promhttp.HandlerFor(m.registry, promhttp.HandlerOpts{})
}

func (m *Metrics) StartOperation(operation string) func() {
	timer := prometheus.NewTimer(m.operationDuration.WithLabelValues(operation))
	return func() {
		timer.ObserveDuration()
	}
}

func (m *Metrics) SetServiceHealth(healthy bool) {
	if healthy {
		m.serviceHealth.Set(1)
		return
	}
	m.serviceHealth.Set(0)
}

// RecordPushHookDelivery counts one push-hook delivery attempt by result.
func (m *Metrics) RecordPushHookDelivery(result string) {
	m.pushHookDelivery.WithLabelValues(result).Inc()
}

// SetPushHookOutboxPending reports how many push events await delivery.
func (m *Metrics) SetPushHookOutboxPending(count int) {
	m.pushHookPending.Set(float64(count))
}
