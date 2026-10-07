package chat

import (
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	dto "github.com/prometheus/client_model/go"
	"github.com/stretchr/testify/require"
)

func latencyBatch(number int64, frames ...string) Batch {
	result := Batch{Batch: number}
	for _, value := range frames {
		result.Frames = append(result.Frames, json.RawMessage(value))
	}
	return result
}

func latencyHistogram(t *testing.T, m *turnLatencies, stage string) *dto.Histogram {
	t.Helper()
	r := prometheus.NewRegistry()
	r.MustRegister(m.seconds, m.omitted)
	families, err := r.Gather()
	require.NoError(t, err)
	for _, family := range families {
		if family.GetName() != "smithers_chat_durable_latency_seconds" {
			continue
		}
		for _, metric := range family.Metric {
			if metric.Label[0].GetValue() == stage {
				return metric.Histogram
			}
		}
	}
	return nil
}

func TestTurnLatenciesOrderDeduplicationAndRecovery(t *testing.T) {
	m := newTurnLatencies()
	start := time.Now()
	m.admitted("a", start)
	m.admitted("a", start.Add(time.Second)) // replay cannot reset admission
	m.committed("a", latencyBatch(2, `{"type":"done","reason":"stop"}`), start.Add(2*time.Second))
	m.committed("a", latencyBatch(2, `{"type":"done","reason":"stop"}`), start.Add(5*time.Second))
	require.Nil(t, latencyHistogram(t, m, "answer_with_cards"))
	first := latencyBatch(1, `{"type":"delta","kind":"reasoning","text":"thinking"}`, `{"type":"delta","kind":"text","text":"answer"}`, `{"type":"context.preflight","phase":"completed","result":{"context":[{"kind":"file"}]}}`)
	m.committed("a", first, start.Add(time.Second))
	m.committed("a", first, start.Add(3*time.Second))
	m.committed("recovered", first, start.Add(4*time.Second))
	for stage, expected := range map[string]float64{"first_token": 1, "answer_with_cards": 2} {
		h := latencyHistogram(t, m, stage)
		require.NotNil(t, h)
		require.Equal(t, uint64(1), h.GetSampleCount())
		require.Equal(t, expected, h.GetSampleSum())
	}
	require.Empty(t, m.turns)
}

func TestTurnLatenciesOnlySuccessfulSourceAnswers(t *testing.T) {
	for _, tc := range []struct {
		name, text, card, done string
		first, answer          bool
	}{
		{"file", "answer", `{"type":"card","card":{"kind":"file"}}`, `{"type":"done","reason":"stop"}`, true, true},
		{"wiki", "answer", `{"type":"card","card":{"kind":"wiki"}}`, `{"type":"done"}`, true, true},
		{"page", "answer", `{"type":"context.preflight","result":{"context":[{"kind":"page"}]}}`, `{"type":"done"}`, true, true},
		{"error", "answer", `{"type":"card","card":{"kind":"file"}}`, `{"type":"done","error":"provider failed"}`, true, false},
		{"cancelled", "answer", `{"type":"card","card":{"kind":"file"}}`, `{"type":"done","reason":"cancelled"}`, true, false},
		{"tool limit", "answer", `{"type":"card","card":{"kind":"file"}}`, `{"type":"done","reason":"tool_limit"}`, true, false},
		{"no text", "", `{"type":"card","card":{"kind":"file"}}`, `{"type":"done"}`, false, false},
		{"no source", "answer", `{"type":"card","card":{"kind":"approval"}}`, `{"type":"done"}`, true, false},
		{"unselected", "answer", `{"type":"context.preflight","phase":"started","result":{"context":[{"kind":"file"}]}}`, `{"type":"done"}`, true, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			m := newTurnLatencies()
			start := time.Now()
			m.admitted("a", start)
			m.committed("a", latencyBatch(1, fmt.Sprintf(`{"type":"delta","kind":"text","text":%q}`, tc.text), tc.card, tc.done), start.Add(time.Second))
			require.Equal(t, tc.first, latencyHistogram(t, m, "first_token") != nil)
			require.Equal(t, tc.answer, latencyHistogram(t, m, "answer_with_cards") != nil)
			require.Empty(t, m.turns)
		})
	}
}

func TestTurnLatenciesCancellationBoundsAndClockOrdering(t *testing.T) {
	m := newTurnLatencies()
	start := time.Now()
	first := latencyBatch(1, `{"type":"delta","kind":"text","text":"answer"}`, `{"type":"card","card":{"kind":"file"}}`)
	m.admitted("cancel", start)
	m.stopped("cancel")
	m.committed("cancel", first, start.Add(time.Second))
	require.Nil(t, latencyHistogram(t, m, "first_token"))
	m.admitted("ordered", start)
	m.committed("ordered", latencyBatch(2, `{"type":"done"}`), start.Add(time.Second))
	m.committed("ordered", first, start.Add(2*time.Second))
	require.Equal(t, float64(2), latencyHistogram(t, m, "answer_with_cards").GetSampleSum())
	for i := 0; i < maxLatencyTurns+1; i++ {
		m.admitted(fmt.Sprint(i), start)
	}
	require.Len(t, m.turns, maxLatencyTurns)
	require.NotContains(t, m.turns, fmt.Sprint(maxLatencyTurns))
	m.admitted("expired", start.Add(latencyRetention))
	require.Len(t, m.turns, 1)
	m.committed("expired", first, start.Add(latencyRetention-time.Second))
	require.Empty(t, m.turns)
	m.admitted("pending", start)
	for i := int64(2); i < maxLatencyPending+3; i++ {
		m.committed("pending", latencyBatch(i), start.Add(time.Second))
	}
	require.Empty(t, m.turns)
	var omitted dto.Metric
	require.NoError(t, m.omitted.WithLabelValues("capacity").Write(&omitted))
	require.Equal(t, float64(2), omitted.Counter.GetValue())
	require.NoError(t, m.omitted.WithLabelValues("expired").Write(&omitted))
	require.Equal(t, float64(maxLatencyTurns+1), omitted.Counter.GetValue())
	var absent *turnLatencies
	absent.admitted("a", start)
	absent.committed("a", first, start)
	absent.stopped("a")
}

func TestTurnLatenciesIgnoreEmptyAndMalformedFramesWithoutShiftingFirstText(t *testing.T) {
	m := newTurnLatencies()
	start := time.Now()
	m.admitted("a", start)
	m.committed("a", latencyBatch(1, `{"type":"delta","kind":"text","text":""}`, `{`), start.Add(time.Second))
	require.Nil(t, latencyHistogram(t, m, "first_token"))
	m.committed("a", latencyBatch(2, `{"type":"delta","kind":"text","text":"first"}`), start.Add(2*time.Second))
	m.committed("a", latencyBatch(3, `{"type":"delta","kind":"text","text":"later"}`, `{"type":"card","card":{"kind":"file"}}`, `{"type":"done"}`), start.Add(3*time.Second))
	require.Equal(t, uint64(1), latencyHistogram(t, m, "first_token").GetSampleCount())
	require.Equal(t, float64(2), latencyHistogram(t, m, "first_token").GetSampleSum())
	require.Equal(t, float64(3), latencyHistogram(t, m, "answer_with_cards").GetSampleSum())
}
