package routes

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/sse"
	"github.com/smithersai/smithers/packages/backend/testkit/testdb"
)

// ---- mock service ----

type mockWorkflowRunRouteService struct {
	getWorkflowRunFn        func(ctx context.Context, repoID, runID int64) (db.WorkflowRun, error)
	listWorkflowStepsFn     func(ctx context.Context, runID int64) ([]db.WorkflowStep, error)
	listWorkflowLogsSinceFn func(ctx context.Context, runID, afterID int64, limit int32) ([]db.WorkflowLog, error)
}

func (m *mockWorkflowRunRouteService) GetWorkflowRun(ctx context.Context, repoID, runID int64) (db.WorkflowRun, error) {
	if m.getWorkflowRunFn != nil {
		return m.getWorkflowRunFn(ctx, repoID, runID)
	}
	return db.WorkflowRun{}, nil
}

func (m *mockWorkflowRunRouteService) ListWorkflowSteps(ctx context.Context, runID int64) ([]db.WorkflowStep, error) {
	if m.listWorkflowStepsFn != nil {
		return m.listWorkflowStepsFn(ctx, runID)
	}
	return nil, nil
}

func (m *mockWorkflowRunRouteService) ListWorkflowLogsSince(ctx context.Context, runID, afterID int64, limit int32) ([]db.WorkflowLog, error) {
	if m.listWorkflowLogsSinceFn != nil {
		return m.listWorkflowLogsSinceFn(ctx, runID, afterID, limit)
	}
	return nil, nil
}

// ---- WorkflowRunLogsStream Tests ----

func TestWorkflowRunLogsStream_RequiresAuth(t *testing.T) {
	t.Parallel()

	h := &WorkflowRunHandler{Service: &mockWorkflowRunRouteService{}}
	req := httptest.NewRequest(http.MethodGet, "/api/repos/owner/repo/runs/1/logs", nil)
	rec := httptest.NewRecorder()
	h.WorkflowRunLogsStream(rec, req)
	require.Equal(t, http.StatusUnauthorized, rec.Code)
}

func TestWorkflowRunLogsStream_InvalidRunID(t *testing.T) {
	t.Parallel()

	h := &WorkflowRunHandler{Service: &mockWorkflowRunRouteService{}}
	req := httptest.NewRequest(http.MethodGet, "/api/repos/owner/repo/runs/abc/logs", nil)
	req = withRouteParams(req, map[string]string{"id": "abc"})
	req = withAuth(req, 1, "alice")
	rec := httptest.NewRecorder()
	h.WorkflowRunLogsStream(rec, req)
	require.Equal(t, http.StatusBadRequest, rec.Code)
}

func TestWorkflowRunLogsStream_RunNotFound(t *testing.T) {
	t.Parallel()

	svc := &mockWorkflowRunRouteService{
		getWorkflowRunFn: func(_ context.Context, _, _ int64) (db.WorkflowRun, error) {
			return db.WorkflowRun{}, pkgerrors.NotFound("run not found")
		},
	}

	h := &WorkflowRunHandler{Service: svc}
	req := httptest.NewRequest(http.MethodGet, "/api/repos/owner/repo/runs/999/logs", nil)
	req = withRouteParams(req, map[string]string{"id": "999"})
	req = withRepoInContext(req, &db.Repository{ID: 1, Name: "repo"})
	req = withAuth(req, 1, "alice")
	rec := httptest.NewRecorder()
	h.WorkflowRunLogsStream(rec, req)
	require.Equal(t, http.StatusNotFound, rec.Code)
}

func TestWorkflowRunLogsStream_NonFlusher_Returns500(t *testing.T) {
	t.Parallel()

	h := &WorkflowRunHandler{Service: &mockWorkflowRunRouteService{}}
	req := httptest.NewRequest(http.MethodGet, "/api/repos/owner/repo/runs/1/logs", nil)
	req = withRouteParams(req, map[string]string{"id": "1"})
	req = withAuth(req, 1, "alice")
	// Use a response writer that does NOT implement http.Flusher.
	rec := &nonFlusherWriter{ResponseWriter: httptest.NewRecorder()}
	h.WorkflowRunLogsStream(rec, req)
	require.Equal(t, http.StatusInternalServerError, rec.ResponseWriter.(*httptest.ResponseRecorder).Code)
}

func TestWorkflowRunLogsStream_NilPool_Returns500(t *testing.T) {
	t.Parallel()

	svc := &mockWorkflowRunRouteService{
		getWorkflowRunFn: func(_ context.Context, _, _ int64) (db.WorkflowRun, error) {
			return db.WorkflowRun{ID: 1, RepositoryID: 1}, nil
		},
	}

	h := &WorkflowRunHandler{Service: svc, Broker: nil}
	req := httptest.NewRequest(http.MethodGet, "/api/repos/owner/repo/runs/1/logs", nil)
	req = withRouteParams(req, map[string]string{"id": "1"})
	req = withRepoInContext(req, &db.Repository{ID: 1, Name: "repo"})
	req = withAuth(req, 1, "alice")
	rec := httptest.NewRecorder()
	h.WorkflowRunLogsStream(rec, req)
	require.Equal(t, http.StatusInternalServerError, rec.Code)
}

func TestWorkflowRunLogsStream_InvalidLastEventID_IgnoredGracefully(t *testing.T) {
	t.Parallel()

	svc := &mockWorkflowRunRouteService{
		getWorkflowRunFn: func(_ context.Context, _, _ int64) (db.WorkflowRun, error) {
			return db.WorkflowRun{ID: 1, RepositoryID: 1}, nil
		},
	}

	h := &WorkflowRunHandler{Service: svc, Broker: nil}
	req := httptest.NewRequest(http.MethodGet, "/api/repos/owner/repo/runs/1/logs", nil)
	req.Header.Set("Last-Event-ID", "not-a-number")
	req = withRouteParams(req, map[string]string{"id": "1"})
	req = withRepoInContext(req, &db.Repository{ID: 1, Name: "repo"})
	req = withAuth(req, 1, "alice")
	rec := httptest.NewRecorder()
	h.WorkflowRunLogsStream(rec, req)
	// Pool==nil → 500 (the invalid header was gracefully ignored)
	require.Equal(t, http.StatusInternalServerError, rec.Code)
}

// workflowLogStreamStore is an in-memory run whose log rows can be appended
// while a stream is open.
type workflowLogStreamStore struct {
	mu        sync.Mutex
	logs      []db.WorkflowLog
	afterIDs  []int64
	stepIDs   []int64
	runExists bool
}

func (s *workflowLogStreamStore) append(rows ...db.WorkflowLog) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.logs = append(s.logs, rows...)
}

func (s *workflowLogStreamStore) GetWorkflowLogStreamHead(context.Context, int64) (int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var head int64
	for _, row := range s.logs {
		head = max(head, row.ID)
	}
	return head, nil
}

func (s *workflowLogStreamStore) GetWorkflowRun(_ context.Context, repoID, runID int64) (db.WorkflowRun, error) {
	if !s.runExists {
		return db.WorkflowRun{}, pkgerrors.NotFound("run not found")
	}
	return db.WorkflowRun{ID: runID, RepositoryID: repoID}, nil
}

func (s *workflowLogStreamStore) ListWorkflowSteps(context.Context, int64) ([]db.WorkflowStep, error) {
	steps := make([]db.WorkflowStep, 0, len(s.stepIDs))
	for _, id := range s.stepIDs {
		steps = append(steps, db.WorkflowStep{ID: id})
	}
	return steps, nil
}

func (s *workflowLogStreamStore) ListWorkflowLogsSince(_ context.Context, runID, afterID int64, limit int32) ([]db.WorkflowLog, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.afterIDs = append(s.afterIDs, afterID)
	var page []db.WorkflowLog
	for _, row := range s.logs {
		if row.WorkflowRunID == runID && row.ID > afterID && len(page) < int(limit) {
			page = append(page, row)
		}
	}
	return page, nil
}

// openWorkflowLogStream serves the production WorkflowRunLogsStream handler
// behind a broker on a real PostgreSQL LISTEN/NOTIFY connection and opens a
// client stream for run 42.
func openWorkflowLogStream(t *testing.T, store *workflowLogStreamStore, lastEventID string) (*pgxpool.Pool, *bufio.Reader, *http.Response) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	t.Cleanup(cancel)
	pool, err := pgxpool.New(ctx, testdb.New(t).URL)
	require.NoError(t, err)
	t.Cleanup(pool.Close)
	broker := sse.NewBroker(pool)
	require.NoError(t, broker.Start(ctx))
	t.Cleanup(broker.Stop)

	h := &WorkflowRunHandler{Service: store, Broker: broker}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r = withRouteParams(r, map[string]string{"id": "42"})
		r = withRepoInContext(r, &db.Repository{ID: 1, Name: "repo"})
		h.WorkflowRunLogsStream(w, withAuth(r, 7, "alice"))
	}))
	t.Cleanup(server.Close)

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, server.URL, nil)
	require.NoError(t, err)
	if lastEventID != "" {
		req.Header.Set("Last-Event-ID", lastEventID)
	}
	resp, err := server.Client().Do(req)
	require.NoError(t, err)
	t.Cleanup(func() { _ = resp.Body.Close() })
	return pool, bufio.NewReader(resp.Body), resp
}

// readSSEFrame returns the lines of the next SSE frame, without the blank
// terminator.
func readSSEFrame(t *testing.T, reader *bufio.Reader) []string {
	t.Helper()
	var lines []string
	for {
		line, err := reader.ReadString('\n')
		require.NoError(t, err)
		line = strings.TrimSuffix(line, "\n")
		if line == "" {
			return lines
		}
		lines = append(lines, line)
	}
}

func requireWorkflowLogFrame(t *testing.T, frame []string, id int64, content string) {
	t.Helper()
	require.Len(t, frame, 3, "frame: %v", frame)
	assert.Equal(t, fmt.Sprintf("id: %d", id), frame[0])
	assert.Equal(t, "event: log", frame[1])
	require.True(t, strings.HasPrefix(frame[2], "data: "), frame[2])
	var data map[string]any
	require.NoError(t, json.Unmarshal([]byte(strings.TrimPrefix(frame[2], "data: ")), &data))
	assert.Equal(t, float64(id), data["log_id"])
	assert.Equal(t, content, data["content"])
	assert.Equal(t, content, data["entry"])
}

func TestWorkflowRunLogsStream_SendsSSEFormat(t *testing.T) {
	t.Parallel()

	store := &workflowLogStreamStore{runExists: true, stepIDs: []int64{5}}
	pool, reader, resp := openWorkflowLogStream(t, store, "")

	require.Equal(t, http.StatusOK, resp.StatusCode)
	assert.Equal(t, "text/event-stream", resp.Header.Get("Content-Type"))
	assert.Equal(t, "no-cache", resp.Header.Get("Cache-Control"))
	assert.Equal(t, "keep-alive", resp.Header.Get("Connection"))
	require.Equal(t, []string{": connected"}, readSSEFrame(t, reader))

	// A row appended after connect reaches the open stream on its NOTIFY.
	store.append(db.WorkflowLog{ID: 1, WorkflowRunID: 42, WorkflowStepID: 5, Sequence: 1, Stream: "stdout", Entry: "hello"})
	_, err := pool.Exec(context.Background(), `SELECT pg_notify('workflow_step_logs_5', '{"log_id":1}')`)
	require.NoError(t, err)

	requireWorkflowLogFrame(t, readSSEFrame(t, reader), 1, "hello")
}

func TestWorkflowRunLogsStream_ReplaysMissedLogsOnReconnect(t *testing.T) {
	t.Parallel()

	store := &workflowLogStreamStore{runExists: true, stepIDs: []int64{5}}
	store.append(
		db.WorkflowLog{ID: 10, WorkflowRunID: 42, WorkflowStepID: 5, Sequence: 1, Stream: "stdout", Entry: "already seen"},
		db.WorkflowLog{ID: 11, WorkflowRunID: 42, WorkflowStepID: 5, Sequence: 2, Stream: "stdout", Entry: "missed log 1"},
		db.WorkflowLog{ID: 12, WorkflowRunID: 42, WorkflowStepID: 5, Sequence: 3, Stream: "stdout", Entry: "missed log 2"},
		db.WorkflowLog{ID: 13, WorkflowRunID: 99, WorkflowStepID: 8, Sequence: 1, Stream: "stdout", Entry: "other run"},
	)
	_, reader, resp := openWorkflowLogStream(t, store, "10")

	require.Equal(t, http.StatusOK, resp.StatusCode)
	require.Equal(t, []string{": connected"}, readSSEFrame(t, reader))
	requireWorkflowLogFrame(t, readSSEFrame(t, reader), 11, "missed log 1")
	requireWorkflowLogFrame(t, readSSEFrame(t, reader), 12, "missed log 2")

	store.mu.Lock()
	defer store.mu.Unlock()
	require.NotEmpty(t, store.afterIDs)
	assert.Equal(t, int64(10), store.afterIDs[0], "replay must resume strictly after Last-Event-ID")
}

// ---- Helper Functions ----

func withRepoInContext(req *http.Request, repo *db.Repository) *http.Request {
	ctx := middleware.ContextWithRepoContext(req.Context(), &middleware.RepoContext{
		Repository: repo,
		Owner:      "owner",
	}, middleware.PermissionRead)
	return req.WithContext(ctx)
}

func TestNormalizeWorkflowRunLogPayload_RawNotifyPayload(t *testing.T) {
	t.Parallel()

	got, ok := normalizeWorkflowRunLogPayload(`{"log_id":42,"workflow_step_id":7,"sequence":3,"stream":"stdout","entry":"hello"}`)
	require.True(t, ok)
	assert.Equal(t, int64(42), got.LogID)
	assert.Equal(t, int64(7), got.Step)
	assert.Equal(t, int64(3), got.Line)
	assert.Equal(t, "hello", got.Content)
	assert.Equal(t, "stdout", got.Stream)
}

func TestNormalizeWorkflowRunLogPayload_AlreadyNormalized(t *testing.T) {
	t.Parallel()

	got, ok := normalizeWorkflowRunLogPayload(`{"log_id":42,"step":7,"line":3,"content":"hello"}`)
	require.True(t, ok)
	assert.Equal(t, int64(42), got.LogID)
	assert.Equal(t, int64(7), got.Step)
	assert.Equal(t, int64(3), got.Line)
	assert.Equal(t, "hello", got.Content)
}

func TestNormalizeWorkflowRunLogPayload_InvalidJSON_ReturnsFalse(t *testing.T) {
	t.Parallel()
	_, ok := normalizeWorkflowRunLogPayload(`not json at all`)
	assert.False(t, ok)
}

func (m *mockWorkflowRunRouteService) GetWorkflowLogStreamHead(context.Context, int64) (int64, error) {
	return 0, nil
}
