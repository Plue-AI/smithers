package microsandbox

import (
	"time"

	"github.com/prometheus/client_golang/prometheus"
)

// machineMetrics reads the same holders that admission grants. It never
// creates demand or retains a second queue, and labels contain no identities.
type machineMetrics struct {
	runtime  *Runtime
	queue    *prometheus.Desc
	wakes    *prometheus.CounterVec
	duration *prometheus.HistogramVec
}

// MachineMetrics is registered by the install in its existing owner-only
// registry. The collector also works before the first admission request.
func (r *Runtime) MachineMetrics() prometheus.Collector {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.metrics == nil {
		r.metrics = &machineMetrics{
			runtime:  r,
			queue:    prometheus.NewDesc("smithers_machine_queue_depth", "Waiting machine holders by their highest-priority class.", []string{"class"}, nil),
			wakes:    prometheus.NewCounterVec(prometheus.CounterOpts{Name: "smithers_machine_wake_total", Help: "Machine boot attempts by kind and outcome; existing awake machines are excluded."}, []string{"kind", "outcome"}),
			duration: prometheus.NewHistogramVec(prometheus.HistogramOpts{Name: "smithers_machine_wake_duration_seconds", Help: "Machine boot time after admission; cold wakes include layer preparation.", Buckets: []float64{.1, .25, .5, 1, 2, 5, 10, 30, 60, 120, 300, 600}}, []string{"kind", "outcome"}),
		}
	}
	return r.metrics
}

func (m *machineMetrics) Describe(ch chan<- *prometheus.Desc) {
	ch <- m.queue
	m.wakes.Describe(ch)
	m.duration.Describe(ch)
}

func (m *machineMetrics) Collect(ch chan<- prometheus.Metric) {
	depths := [3]int{}
	m.runtime.mu.Lock()
	for _, holder := range m.runtime.admission {
		priority := 3
		for _, row := range holder.rows {
			if row.State == "waiting" {
				priority = min(priority, admissionPriority(row.Class))
			}
		}
		if priority < 3 {
			depths[priority]++
		}
	}
	m.runtime.mu.Unlock()
	for i, class := range []string{"person", "todo", "background"} {
		ch <- prometheus.MustNewConstMetric(m.queue, prometheus.GaugeValue, float64(depths[i]), class)
	}
	m.wakes.Collect(ch)
	m.duration.Collect(ch)
}

type machineWakeStarted struct{}

func (r *Runtime) observeMachineWake(kind string, started time.Time, err error) {
	m := r.MachineMetrics().(*machineMetrics)
	outcome := "success"
	if err != nil {
		outcome = "failure"
	}
	m.wakes.WithLabelValues(kind, outcome).Inc()
	m.duration.WithLabelValues(kind, outcome).Observe(time.Since(started).Seconds())
}
