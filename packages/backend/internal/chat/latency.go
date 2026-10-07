package chat

import (
	"encoding/json"
	"sync"
	"time"

	"github.com/prometheus/client_golang/prometheus"
)

// These are server durability cross-checks, not renderer performance values.
// Only admission and commits observed by this process share a monotonic clock.
const maxLatencyTurns = 4096
const maxLatencyPending = 1024
const latencyRetention = time.Hour

type latencyReceipt struct {
	at                        time.Time
	text, card, done, success bool
}

type latencyTurn struct {
	start      time.Time
	latest     time.Time
	next       int64
	text, card bool
	pending    map[int64]latencyReceipt
}

type turnLatencies struct {
	mu      sync.Mutex
	turns   map[string]*latencyTurn
	seconds *prometheus.HistogramVec
	omitted *prometheus.CounterVec
}

func newTurnLatencies() *turnLatencies {
	return &turnLatencies{
		turns: make(map[string]*latencyTurn),
		seconds: prometheus.NewHistogramVec(prometheus.HistogramOpts{
			Name:    "smithers_chat_durable_latency_seconds",
			Help:    "Same-process monotonic time from durable admission to first durable text or a completed answer with source cards; not browser render latency.",
			Buckets: []float64{.1, .25, .5, 1, 1.5, 2, 4, 8, 16, 32, 64},
		}, []string{"stage"}),
		omitted: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "smithers_chat_latency_observations_omitted_total",
			Help: "Server latency spans omitted because their bounded process-local observation window expired or filled.",
		}, []string{"reason"}),
	}
}

func (m *turnLatencies) admitted(id string, at time.Time) {
	if m == nil {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	for key, turn := range m.turns {
		if at.Sub(turn.start) >= latencyRetention {
			delete(m.turns, key)
			m.omitted.WithLabelValues("expired").Inc()
		}
	}
	if _, exists := m.turns[id]; exists {
		return
	}
	if len(m.turns) >= maxLatencyTurns {
		m.omitted.WithLabelValues("capacity").Inc()
		return
	}
	m.turns[id] = &latencyTurn{start: at, next: 1, pending: make(map[int64]latencyReceipt)}
}

func (m *turnLatencies) stopped(id string) {
	if m == nil {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.turns, id)
}

func (m *turnLatencies) committed(id string, batch Batch, at time.Time) {
	if m == nil {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	turn := m.turns[id]
	// Recovery or another replica cannot inherit this process's stopwatch.
	if turn == nil || batch.Batch < turn.next {
		return
	}
	if _, exists := turn.pending[batch.Batch]; exists {
		return
	}
	if len(turn.pending) >= maxLatencyPending {
		delete(m.turns, id)
		m.omitted.WithLabelValues("capacity").Inc()
		return
	}
	if at.Sub(turn.start) < 0 || at.Sub(turn.start) >= latencyRetention {
		delete(m.turns, id)
		m.omitted.WithLabelValues("expired").Inc()
		return
	}
	receipt := latencyReceipt{at: at}
	for _, raw := range batch.Frames {
		var frame struct {
			Type, Kind, Text, Phase, Reason, Error string
			Card                                   struct{ Kind string }
			Result                                 struct{ Context []struct{ Kind string } }
		}
		if json.Unmarshal(raw, &frame) != nil {
			continue
		} // store validation precedes this observer
		switch frame.Type {
		case "delta":
			receipt.text = receipt.text || frame.Kind == "text" && frame.Text != ""
		case "card":
			receipt.card = receipt.card || frame.Card.Kind == "file" || frame.Card.Kind == "wiki"
		case "context.preflight":
			if frame.Phase != "started" {
				for _, item := range frame.Result.Context {
					receipt.card = receipt.card || item.Kind == "file" || item.Kind == "page"
				}
			}
		case "done":
			receipt.done = true
			receipt.success = frame.Error == "" && (frame.Reason == "" || frame.Reason == "stop")
		}
	}
	turn.pending[batch.Batch] = receipt
	// DB commits serialize, but the observer goroutines can arrive out of order.
	for {
		value, exists := turn.pending[turn.next]
		if !exists {
			return
		}
		delete(turn.pending, turn.next)
		turn.next++
		if value.at.After(turn.latest) {
			turn.latest = value.at
		}
		elapsed := turn.latest.Sub(turn.start).Seconds()
		if value.text && !turn.text {
			m.seconds.WithLabelValues("first_token").Observe(elapsed)
			turn.text = true
		}
		turn.card = turn.card || value.card
		if value.done {
			if value.success && turn.text && turn.card {
				m.seconds.WithLabelValues("answer_with_cards").Observe(elapsed)
			}
			delete(m.turns, id)
			return
		}
	}
}
