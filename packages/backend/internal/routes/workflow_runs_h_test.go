package routes

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/sse"
)

func TestWorkflowRuns_H_StreamConfigBranches(t *testing.T) {
	oldServe := serveWorkflowRunBrokerSSE
	t.Cleanup(func() { serveWorkflowRunBrokerSSE = oldServe })

	var gotCfg sse.BrokerStreamConfig
	serveWorkflowRunBrokerSSE = func(w http.ResponseWriter, r *http.Request, cfg sse.BrokerStreamConfig) {
		gotCfg = cfg
		cfg.OnConnect(w, r, httptest.NewRecorder())
		w.WriteHeader(http.StatusAccepted)
	}

	h := &WorkflowRunHandler{
		Service: &mockWorkflowRunRouteService{
			getWorkflowRunFn: func(context.Context, int64, int64) (db.WorkflowRun, error) {
				return db.WorkflowRun{ID: 77, RepositoryID: 101}, nil
			},
			listWorkflowStepsFn: func(context.Context, int64) ([]db.WorkflowStep, error) {
				return []db.WorkflowStep{{ID: 1}, {ID: 2}}, nil
			},
			listWorkflowLogsSinceFn: func(_ context.Context, _ int64, after int64, _ int32) ([]db.WorkflowLog, error) {
				var page []db.WorkflowLog
				for _, row := range []db.WorkflowLog{{ID: 5, WorkflowStepID: 1, Sequence: 1, Entry: "seen"}, {ID: 6, WorkflowStepID: 1, Sequence: 2, Entry: "replayed"}} {
					if row.ID > after {
						page = append(page, row)
					}
				}
				return page, nil
			},
		},
		Broker:  &sse.Broker{},
		Metrics: &SmithersMetrics{SSEActiveConnections: prometheus.NewGauge(prometheus.GaugeOpts{Name: "workflow_runs_h_active"})},
	}
	req := httptest.NewRequest(http.MethodGet, "/api/repos/owner/repo/runs/77/logs", nil)
	req.Header.Set("Last-Event-ID", "5")
	req = withRouteParams(req, map[string]string{"id": "77"})
	req = withRepoInContext(req, &db.Repository{ID: 101, Name: "repo"})
	req = withAuth(req, 7, "alice")
	rec := httptest.NewRecorder()

	h.WorkflowRunLogsStream(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	assert.True(t, reflect.DeepEqual([]string{"workflow_step_logs_1", "workflow_step_logs_2", "workflow_run_77"}, gotCfg.Channels))
	assert.Equal(t, int64(7), gotCfg.UserID)
	assert.Equal(t, "log", gotCfg.EventType)
	assert.NotNil(t, gotCfg.ActiveConnections)
	assert.Contains(t, rec.Body.String(), "id: 6")
}

func TestWorkflowRuns_H_ReplayRemainingBranches(t *testing.T) {
	t.Run("empty last event id returns", func(t *testing.T) {
		h := &WorkflowRunHandler{Service: &mockWorkflowRunRouteService{}}
		rec := httptest.NewRecorder()

		h.replayWorkflowLogs(1)(rec, httptest.NewRequest(http.MethodGet, "/logs", nil), rec)

		assert.Empty(t, rec.Body.String())
		assert.False(t, rec.Flushed)
	})

	t.Run("service error emits retryable replay failure", func(t *testing.T) {
		h := &WorkflowRunHandler{Service: &mockWorkflowRunRouteService{
			listWorkflowLogsSinceFn: func(context.Context, int64, int64, int32) ([]db.WorkflowLog, error) {
				return nil, errors.New("logs unavailable")
			},
		}}
		req := httptest.NewRequest(http.MethodGet, "/logs", nil)
		req.Header.Set("Last-Event-ID", "9")
		rec := httptest.NewRecorder()

		h.replayWorkflowLogs(1)(rec, req, rec)

		assert.Contains(t, rec.Body.String(), "event: stream.error")
		assert.NotContains(t, rec.Body.String(), "id:")
		assert.True(t, rec.Flushed)
	})

	t.Run("marshal error reports failure without cursor advance", func(t *testing.T) {
		oldMarshal := marshalWorkflowRunReplayPayload
		t.Cleanup(func() { marshalWorkflowRunReplayPayload = oldMarshal })
		marshalWorkflowRunReplayPayload = func(any) ([]byte, error) {
			return nil, errors.New("marshal failed")
		}
		h := &WorkflowRunHandler{Service: &mockWorkflowRunRouteService{
			listWorkflowLogsSinceFn: func(context.Context, int64, int64, int32) ([]db.WorkflowLog, error) {
				return []db.WorkflowLog{{ID: 10, WorkflowStepID: 2, Sequence: 3, Entry: "hidden"}}, nil
			},
		}}
		req := httptest.NewRequest(http.MethodGet, "/logs", nil)
		req.Header.Set("Last-Event-ID", "9")
		rec := httptest.NewRecorder()

		h.replayWorkflowLogs(1)(rec, req, rec)

		assert.Contains(t, strings.TrimSpace(rec.Body.String()), "event: stream.error")
		assert.NotContains(t, rec.Body.String(), "id:")
		assert.True(t, rec.Flushed)
	})
}

// A row appended after the client connected must reach the stream on the next
// wake — the NOTIFY the runner path now publishes on both the step channel and
// the run channel, or the durable repair poll behind it. Cloud CI run 11717
// task 107860 streamed nothing but `: connected` for fifteen minutes because
// no row was appended until 12:51:49; this pins the other half of that
// contract, that an appended row is emitted without a reconnect.
func TestWorkflowRunLogsStream_EmitsRowsAppendedAfterConnect(t *testing.T) {
	oldServe := serveWorkflowRunBrokerSSE
	t.Cleanup(func() { serveWorkflowRunBrokerSSE = oldServe })

	var appended []db.WorkflowLog
	var gotCfg sse.BrokerStreamConfig
	serveWorkflowRunBrokerSSE = func(w http.ResponseWriter, r *http.Request, cfg sse.BrokerStreamConfig) {
		gotCfg = cfg
		flusher, ok := w.(http.Flusher)
		require.True(t, ok)
		// Connect on an empty run: the head is 0 and nothing is emitted, which
		// is the `: connected`-only state the run card sat in.
		cfg.OnConnect(w, r, flusher)
		require.Empty(t, w.(*httptest.ResponseRecorder).Body.String())

		appended = append(appended,
			db.WorkflowLog{ID: 1, WorkflowStepID: 5, Sequence: 1, Stream: "stdout", Entry: "cargo build\n"},
			db.WorkflowLog{ID: 2, WorkflowStepID: 5, Sequence: 2, Stream: "system", Entry: "::gate native\n"},
		)
		// One wake, whether from NOTIFY or the repair poll.
		cfg.Durable.OnConnect(w, r, flusher)
		// A second wake with nothing new must not replay what was already sent.
		cfg.Durable.OnConnect(w, r, flusher)
	}

	h := &WorkflowRunHandler{
		Service: &mockWorkflowRunRouteService{
			getWorkflowRunFn: func(context.Context, int64, int64) (db.WorkflowRun, error) {
				return db.WorkflowRun{ID: 11717, RepositoryID: 101}, nil
			},
			listWorkflowStepsFn: func(context.Context, int64) ([]db.WorkflowStep, error) {
				return []db.WorkflowStep{{ID: 5}}, nil
			},
			listWorkflowLogsSinceFn: func(_ context.Context, _ int64, afterID int64, _ int32) ([]db.WorkflowLog, error) {
				var page []db.WorkflowLog
				for _, row := range appended {
					if row.ID > afterID {
						page = append(page, row)
					}
				}
				return page, nil
			},
		},
		Broker: &sse.Broker{},
	}

	req := httptest.NewRequest(http.MethodGet, "/api/repos/owner/repo/runs/11717/logs", nil)
	req = withRouteParams(req, map[string]string{"id": "11717"})
	req = withRepoInContext(req, &db.Repository{ID: 101, Name: "repo"})
	req = withAuth(req, 7, "alice")
	rec := httptest.NewRecorder()

	h.WorkflowRunLogsStream(rec, req)

	body := rec.Body.String()
	assert.Equal(t, []string{"workflow_step_logs_5", "workflow_run_11717"}, gotCfg.Channels,
		"the run channel must be listened on so a late-created step still wakes this client")
	assert.Contains(t, body, "id: 1")
	assert.Contains(t, body, "cargo build")
	assert.Contains(t, body, "::gate native")
	assert.Equal(t, 1, strings.Count(body, "id: 2\n"), "a wake with nothing new must not replay")
	assert.Less(t, strings.Index(body, "cargo build"), strings.Index(body, "::gate native"),
		"rows must be emitted in append order")
}
