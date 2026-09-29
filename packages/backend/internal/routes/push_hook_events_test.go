package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// memPushEvents stands in for repo_push_events: a delivery_id it already
// holds inserts nothing.
type memPushEvents struct {
	mu   sync.Mutex
	rows []db.InsertRepoPushEventParams
	err  error
}

func (m *memPushEvents) InsertRepoPushEvent(_ context.Context, arg db.InsertRepoPushEventParams) (int64, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.err != nil {
		return 0, m.err
	}
	for _, row := range m.rows {
		if row.DeliveryID == arg.DeliveryID {
			return 0, nil
		}
	}
	m.rows = append(m.rows, arg)
	return 1, nil
}

func (m *memPushEvents) snapshot() []db.InsertRepoPushEventParams {
	m.mu.Lock()
	defer m.mu.Unlock()
	return append([]db.InsertRepoPushEventParams(nil), m.rows...)
}

func pushEventFromInsert(id int64, row db.InsertRepoPushEventParams) db.RepoPushEvent {
	return db.RepoPushEvent{
		ID:           id,
		DeliveryID:   row.DeliveryID,
		RepositoryID: row.RepositoryID,
		Owner:        row.Owner,
		Repo:         row.Repo,
		RefName:      row.RefName,
		BeforeSha:    row.BeforeSha,
		CommitSha:    row.CommitSha,
		PusherID:     row.PusherID,
		PusherLogin:  row.PusherLogin,

		PusherCredential: row.PusherCredential,
	}
}

// postAndProcess sends a callback through PostPushEvent and then processes
// every event it stored, as services.RepoPushEventWorker would.
func postAndProcess(t *testing.T, h *InternalPushHookHandler, rec *httptest.ResponseRecorder, req *http.Request) {
	t.Helper()
	store, ok := h.Events.(*memPushEvents)
	if !ok {
		store = &memPushEvents{}
		h.Events = store
	}
	before := len(store.snapshot())
	h.PostPushEvent(rec, req)
	for i, row := range store.snapshot()[before:] {
		_ = h.ProcessRepoPushEvent(context.Background(), pushEventFromInsert(int64(before+i+1), row), nil)
	}
}

func postPushEvent(h *InternalPushHookHandler, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, "/internal/repo-host/push-events", strings.NewReader(body))
	rec := httptest.NewRecorder()
	h.PostPushEvent(rec, req)
	return rec
}

// The callback records the event and returns; no side effect runs inside
// the request, so an API restart after the 204 cannot lose one.
func TestPostPushEvent_RecordsEventWithoutRunningSideEffects(t *testing.T) {
	t.Parallel()

	store := &memPushEvents{}
	dispatcher := &mockPushHookDispatcher{}
	runner := &mockPushHookWorkflowRunner{calls: make(chan dispatchCallRecord, 1)}
	h := &InternalPushHookHandler{RepoResolver: &mockPushHookRepoResolver{}, Dispatcher: dispatcher, WorkflowRun: runner, Events: store}
	body, err := json.Marshal(PushHookEventRequest{
		DeliveryID: "d-1", RepositoryID: 101, Owner: "alice", Repo: "demo", Ref: "refs/heads/main",
		BeforeSHA: "aaa", CommitSHA: "bbb", PusherID: 42, PusherLogin: "bob",
	})
	require.NoError(t, err)

	rec := postPushEvent(h, string(body))

	require.Equal(t, http.StatusNoContent, rec.Code)
	assert.Equal(t, []db.InsertRepoPushEventParams{{
		DeliveryID: "d-1", RepositoryID: 101, Owner: "alice", Repo: "demo", RefName: "refs/heads/main",
		BeforeSha: "aaa", CommitSha: "bbb", PusherID: 42, PusherLogin: "bob",
	}}, store.snapshot())
	assert.Empty(t, dispatcher.dispatchedType, "webhooks run in the worker, not the callback")
	assert.Empty(t, runner.calls, "workflow dispatch runs in the worker, not the callback")
}

// repo-host redelivers after a timeout the API may have already processed.
// The second delivery is acknowledged but stores nothing.
func TestPostPushEvent_DuplicateDeliveryIsAcknowledgedOnce(t *testing.T) {
	t.Parallel()

	store := &memPushEvents{}
	h := &InternalPushHookHandler{RepoResolver: &mockPushHookRepoResolver{}, Events: store}
	body := `{"delivery_id":"d-1","repository_id":101,"owner":"alice","repo":"demo","ref_name":"refs/heads/main","commit_sha":"abc"}`

	require.Equal(t, http.StatusNoContent, postPushEvent(h, body).Code)
	require.Equal(t, http.StatusNoContent, postPushEvent(h, body).Code)
	assert.Len(t, store.snapshot(), 1)
}

// A failed insert must not be acknowledged: repo-host keeps the event in its
// outbox only while the callback fails.
func TestPostPushEvent_StoreFailureIsNotAcknowledged(t *testing.T) {
	t.Parallel()

	h := &InternalPushHookHandler{RepoResolver: &mockPushHookRepoResolver{}, Events: &memPushEvents{err: errors.New("db down")}}
	rec := postPushEvent(h, `{"delivery_id":"d-1","repository_id":101,"owner":"alice","repo":"demo"}`)
	require.Equal(t, http.StatusInternalServerError, rec.Code)
	assert.NotContains(t, rec.Body.String(), "db down")
}

func TestPostPushEvent_MissingDeliveryIDStillRecordsEvent(t *testing.T) {
	t.Parallel()

	store := &memPushEvents{}
	h := &InternalPushHookHandler{RepoResolver: &mockPushHookRepoResolver{}, Events: store}
	body := `{"repository_id":101,"owner":"alice","repo":"demo","ref_name":"refs/heads/main"}`
	require.Equal(t, http.StatusNoContent, postPushEvent(h, body).Code)
	require.Equal(t, http.StatusNoContent, postPushEvent(h, body).Code)
	rows := store.snapshot()
	require.Len(t, rows, 2, "without a delivery id each callback is a distinct event")
	assert.True(t, strings.HasPrefix(rows[0].DeliveryID, "legacy-"))
	assert.NotEqual(t, rows[0].DeliveryID, rows[1].DeliveryID)
}

// A retry after a partial failure runs only the failed steps: workflows that
// already dispatched are not dispatched again.
func TestProcessRepoPushEvent_RetryRunsOnlyFailedSteps(t *testing.T) {
	t.Parallel()

	dispatcher := &mockPushHookDispatcher{}
	var dispatches int
	var mu sync.Mutex
	runner := &mockPushHookWorkflowRunner{dispatchFn: func(context.Context, services.DispatchForEventInput) ([]services.WorkflowRunResult, error) {
		mu.Lock()
		dispatches++
		mu.Unlock()
		return nil, nil
	}}
	indexErr := errors.New("index down")
	indexer := &mockPushHookSearchIndexer{err: indexErr}
	h := &InternalPushHookHandler{
		RepoResolver: &mockPushHookRepoResolver{},
		Dispatcher:   dispatcher,
		WorkflowRun:  runner,
		SearchIndex:  indexer,
	}
	event := db.RepoPushEvent{ID: 1, RepositoryID: 101, Owner: "alice", Repo: "demo", RefName: "refs/heads/main", CommitSha: "abc"}

	var marked []string
	markStep := func(_ context.Context, step string) error {
		mu.Lock()
		marked = append(marked, step)
		mu.Unlock()
		return nil
	}
	err := h.ProcessRepoPushEvent(context.Background(), event, markStep)
	require.ErrorIs(t, err, indexErr)
	assert.ElementsMatch(t, []string{PushStepWebhooks, PushStepWorkflows}, marked)
	assert.Equal(t, 1, dispatches)

	// The worker re-claims the row with the steps it recorded.
	event.StepsDone = marked
	indexer.err = nil
	dispatcher.dispatchedType = ""
	marked = nil
	require.NoError(t, h.ProcessRepoPushEvent(context.Background(), event, markStep))
	assert.Equal(t, []string{PushStepSearchIndex}, marked)
	assert.Equal(t, 1, dispatches, "a retried event must not dispatch workflows twice")
	assert.Empty(t, dispatcher.dispatchedType, "a retried event must not enqueue webhooks twice")
}

// A step whose completion cannot be recorded counts as failed so the worker
// retries rather than finishing an event it cannot prove ran.
func TestProcessRepoPushEvent_UnrecordedStepFailsEvent(t *testing.T) {
	t.Parallel()

	h := &InternalPushHookHandler{RepoResolver: &mockPushHookRepoResolver{}, Dispatcher: &mockPushHookDispatcher{}}
	err := h.ProcessRepoPushEvent(context.Background(), db.RepoPushEvent{RepositoryID: 101, Owner: "alice", Repo: "demo"},
		func(context.Context, string) error { return errors.New("claim lost") })
	require.ErrorContains(t, err, "claim lost")
}

func TestPushHookEventRequestDecodesRepoHostPayload(t *testing.T) {
	t.Parallel()

	var req PushHookEventRequest
	require.NoError(t, json.NewDecoder(bytes.NewBufferString(`{"delivery_id":"d","repository_id":101,"owner":"o","repo":"r","ref_name":"refs/heads/x","before_sha":"a","commit_sha":"b","pusher_id":3,"pusher_login":"l"}`)).Decode(&req))
	assert.Equal(t, PushHookEventRequest{DeliveryID: "d", RepositoryID: 101, Owner: "o", Repo: "r", Ref: "refs/heads/x", BeforeSHA: "a", CommitSHA: "b", PusherID: 3, PusherLogin: "l"}, req)
}
