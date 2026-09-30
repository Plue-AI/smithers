package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/revocation"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/internal/sse"
)

// ---- mock service ----

type mockAgentSessionStreamService struct {
	getSessionForRepoFn   func(ctx context.Context, sessionID string, repoID int64) error
	listMessagesAfterIDFn func(ctx context.Context, sessionID string, afterID int64, limit int) ([]services.AgentMessageResponse, error)
}

func (m *mockAgentSessionStreamService) GetSessionForRepo(ctx context.Context, sessionID string, repoID int64) error {
	if m.getSessionForRepoFn != nil {
		return m.getSessionForRepoFn(ctx, sessionID, repoID)
	}
	return nil
}

func (m *mockAgentSessionStreamService) ListMessagesAfterID(ctx context.Context, sessionID string, afterID int64, limit int) ([]services.AgentMessageResponse, error) {
	if m.listMessagesAfterIDFn != nil {
		return m.listMessagesAfterIDFn(ctx, sessionID, afterID, limit)
	}
	return nil, nil
}

// ---- helpers ----

// testAgentSessionID is a valid agent session UUID for route tests.
const testAgentSessionID = "0b8f5f7e-2c1a-4d3e-9f10-1a2b3c4d5e6f"

func withRepoCtx(req *http.Request, repoID int64, owner, name string) *http.Request {
	repository := &db.Repository{ID: repoID, Name: name, LowerName: name}
	ctx := middleware.ContextWithRepoContext(req.Context(), &middleware.RepoContext{
		Owner:      owner,
		Repository: repository,
	}, middleware.PermissionRead)
	return req.WithContext(ctx)
}

// ---- AgentSessionStream Tests ----

func TestAgentSessionStream_RequiresAuth(t *testing.T) {
	t.Parallel()

	h := &AgentSessionStreamHandler{Service: &mockAgentSessionStreamService{}}
	req := httptest.NewRequest(http.MethodGet, "/api/repos/owner/repo/agent/sessions/abc-123/stream", nil)
	rec := httptest.NewRecorder()
	h.AgentSessionStream(rec, req)
	require.Equal(t, http.StatusUnauthorized, rec.Code)
}

func TestAgentSessionStream_MissingSessionID(t *testing.T) {
	t.Parallel()

	h := &AgentSessionStreamHandler{Service: &mockAgentSessionStreamService{}}
	req := httptest.NewRequest(http.MethodGet, "/api/repos/owner/repo/agent/sessions//stream", nil)
	req = withRouteParams(req, map[string]string{"id": ""})
	req = withAuth(req, 1, "alice")
	rec := httptest.NewRecorder()
	h.AgentSessionStream(rec, req)
	require.Equal(t, http.StatusBadRequest, rec.Code)
}

func TestAgentSessionStream_MissingRepoContext(t *testing.T) {
	t.Parallel()

	h := &AgentSessionStreamHandler{Service: &mockAgentSessionStreamService{}}
	req := httptest.NewRequest(http.MethodGet, "/api/repos/owner/repo/agent/sessions/abc-123/stream", nil)
	req = withRouteParams(req, map[string]string{"id": testAgentSessionID})
	req = withAuth(req, 1, "alice")
	rec := httptest.NewRecorder()
	h.AgentSessionStream(rec, req)
	require.Equal(t, http.StatusInternalServerError, rec.Code)
}

func TestAgentSessionStream_SessionNotFound(t *testing.T) {
	t.Parallel()

	svc := &mockAgentSessionStreamService{
		getSessionForRepoFn: func(_ context.Context, _ string, _ int64) error {
			return pkgerrors.NotFound("agent session not found")
		},
	}
	h := &AgentSessionStreamHandler{Service: svc}
	req := httptest.NewRequest(http.MethodGet, "/api/repos/owner/repo/agent/sessions/abc-123/stream", nil)
	req = withRouteParams(req, map[string]string{"id": testAgentSessionID})
	req = withAuth(req, 1, "alice")
	req = withRepoCtx(req, 101, "owner", "repo")
	rec := httptest.NewRecorder()
	h.AgentSessionStream(rec, req)
	require.Equal(t, http.StatusNotFound, rec.Code)
}

func TestAgentSessionStream_NilBroker_Returns500(t *testing.T) {
	t.Parallel()

	h := &AgentSessionStreamHandler{
		Service: &mockAgentSessionStreamService{},
		Broker:  nil,
	}
	req := httptest.NewRequest(http.MethodGet, "/api/repos/owner/repo/agent/sessions/abc-123/stream", nil)
	req = withRouteParams(req, map[string]string{"id": testAgentSessionID})
	req = withAuth(req, 1, "alice")
	req = withRepoCtx(req, 101, "owner", "repo")
	rec := httptest.NewRecorder()
	h.AgentSessionStream(rec, req)
	require.Equal(t, http.StatusInternalServerError, rec.Code)
}

func TestAgentSessionStream_NonFlusher_Returns500(t *testing.T) {
	t.Parallel()

	h := &AgentSessionStreamHandler{Service: &mockAgentSessionStreamService{}}
	req := httptest.NewRequest(http.MethodGet, "/api/repos/owner/repo/agent/sessions/abc-123/stream", nil)
	req = withRouteParams(req, map[string]string{"id": testAgentSessionID})
	req = withAuth(req, 1, "alice")
	req = withRepoCtx(req, 101, "owner", "repo")
	rec := &nonFlusherWriter{ResponseWriter: httptest.NewRecorder()}
	h.AgentSessionStream(rec, req)
	require.Equal(t, http.StatusInternalServerError, rec.ResponseWriter.(*httptest.ResponseRecorder).Code)
}

func TestAgentSessionStream_NilService_Returns500(t *testing.T) {
	t.Parallel()

	// A handler wired without Service must fail closed: it cannot prove the
	// session belongs to the repository, so it must not open a stream.
	h := &AgentSessionStreamHandler{Broker: &sse.Broker{}}
	req := httptest.NewRequest(http.MethodGet, "/api/repos/owner/repo/agent/sessions/x/stream", nil)
	req = withRouteParams(req, map[string]string{"id": testAgentSessionID})
	req = withAuth(req, 1, "alice")
	req = withRepoCtx(req, 101, "owner", "repo")
	rec := httptest.NewRecorder()
	h.AgentSessionStream(rec, req)
	require.Equal(t, http.StatusInternalServerError, rec.Code)
}

func TestAgentSessionStream_InvalidSessionID_Returns400(t *testing.T) {
	t.Parallel()

	svc := &mockAgentSessionStreamService{
		getSessionForRepoFn: func(context.Context, string, int64) error {
			t.Error("GetSessionForRepo must not run for a non-UUID session id")
			return nil
		},
	}
	h := &AgentSessionStreamHandler{Service: svc, Broker: &sse.Broker{}}
	req := httptest.NewRequest(http.MethodGet, "/api/repos/owner/repo/agent/sessions/x/stream", nil)
	req = withRouteParams(req, map[string]string{"id": "abc; drop"})
	req = withAuth(req, 1, "alice")
	req = withRepoCtx(req, 101, "owner", "repo")
	rec := httptest.NewRecorder()
	h.AgentSessionStream(rec, req)
	require.Equal(t, http.StatusBadRequest, rec.Code)
}

// ---- Replay / Last-Event-ID Tests ----

// serveAgentSessionReplay runs AgentSessionStream with the broker seam
// replaced by the durable catch-up the real broker performs on connect.
// It swaps a package variable, so callers must not run in parallel.
func serveAgentSessionReplay(t *testing.T, svc AgentSessionStreamService, lastEventID string) *httptest.ResponseRecorder {
	t.Helper()
	oldServe := serveAgentSessionBrokerSSE
	t.Cleanup(func() { serveAgentSessionBrokerSSE = oldServe })
	serveAgentSessionBrokerSSE = func(w http.ResponseWriter, r *http.Request, cfg sse.BrokerStreamConfig) {
		cfg.OnConnect(w, r, w.(http.Flusher))
	}

	h := &AgentSessionStreamHandler{Service: svc, Broker: &sse.Broker{}}
	req := httptest.NewRequest(http.MethodGet, "/api/repos/owner/repo/agent/sessions/x/stream", nil)
	req.Header.Set("Last-Event-ID", lastEventID)
	req = withRouteParams(req, map[string]string{"id": testAgentSessionID})
	req = withAuth(req, 1, "alice")
	req = withRepoCtx(req, 101, "owner", "repo")
	rec := httptest.NewRecorder()
	h.AgentSessionStream(rec, req)
	return rec
}

func TestAgentSessionStream_ReplayCallsListMessagesAfterID(t *testing.T) {

	var capturedSessionID string
	var capturedAfterID int64
	var capturedLimit int

	svc := &mockAgentSessionStreamService{
		listMessagesAfterIDFn: func(_ context.Context, sessionID string, afterID int64, limit int) ([]services.AgentMessageResponse, error) {
			capturedSessionID = sessionID
			capturedAfterID = afterID
			capturedLimit = limit
			rows := []services.AgentMessageResponse{
				{ID: 100, SessionID: "abc-123", Role: "user", Sequence: 4},
				{
					ID:        101,
					SessionID: "abc-123",
					Role:      "assistant",
					Sequence:  5,
					Parts:     []services.AgentPartResponse{{PartIndex: 0, Type: "text", Content: map[string]any{"text": "hello"}}},
					CreatedAt: time.Date(2026, 3, 15, 0, 0, 0, 0, time.UTC),
				},
				{
					ID:        102,
					SessionID: "abc-123",
					Role:      "user",
					Sequence:  6,
					Parts:     []services.AgentPartResponse{{PartIndex: 0, Type: "text", Content: map[string]any{"text": "world"}}},
					CreatedAt: time.Date(2026, 3, 15, 0, 0, 1, 0, time.UTC),
				},
			}
			var page []services.AgentMessageResponse
			for _, row := range rows {
				if row.ID > afterID && len(page) < limit {
					page = append(page, row)
				}
			}
			return page, nil
		},
	}

	rec := serveAgentSessionReplay(t, svc, "100")

	assert.Equal(t, testAgentSessionID, capturedSessionID)
	assert.Equal(t, int64(100), capturedAfterID)
	assert.Equal(t, 1000, capturedLimit)
	assert.True(t, rec.Flushed)
	body := rec.Body.String()
	assert.Contains(t, body, "id: 101\n")
	assert.Contains(t, body, "event: agent.session\n")
	assert.Contains(t, body, `"action":"message"`)
	assert.Contains(t, body, `"message":{`)
	assert.Contains(t, body, `"hello"`)
	assert.Contains(t, body, "id: 102\n")
	assert.Contains(t, body, `"world"`)
}

// ---- extractAgentEventID tests ----

func TestExtractAgentEventID_WithID(t *testing.T) {
	t.Parallel()

	got := extractAgentEventID(`{"id":42,"session_id":"abc-123"}`)
	assert.Equal(t, "42", got)
}

func TestExtractAgentEventID_WithSequence(t *testing.T) {
	t.Parallel()

	got := extractAgentEventID(`{"sequence":7,"content":"hello"}`)
	assert.Equal(t, "7", got)
}

func TestExtractAgentEventID_IDPreferredOverSequence(t *testing.T) {
	t.Parallel()

	got := extractAgentEventID(`{"id":10,"sequence":7}`)
	assert.Equal(t, "10", got)
}

func TestExtractAgentEventID_WithMessageID(t *testing.T) {
	t.Parallel()

	got := extractAgentEventID(`{"action":"message","message":{"id":42,"sequence":7}}`)
	assert.Equal(t, "42", got)
}

func TestExtractAgentEventID_WithMessageSequence(t *testing.T) {
	t.Parallel()

	got := extractAgentEventID(`{"action":"message","message":{"sequence":7}}`)
	assert.Equal(t, "7", got)
}

func TestExtractAgentEventID_NoIDField(t *testing.T) {
	t.Parallel()

	got := extractAgentEventID(`{"content":"hello"}`)
	assert.Equal(t, "", got)
}

func TestExtractAgentEventID_InvalidJSON(t *testing.T) {
	t.Parallel()

	got := extractAgentEventID(`not json`)
	assert.Equal(t, "", got)
}

func TestExtractAgentEventID_EmptyString(t *testing.T) {
	t.Parallel()

	got := extractAgentEventID(``)
	assert.Equal(t, "", got)
}

// ---- Service-level replay tests ----
// These verify the ListMessagesAfterID service method behavior.

func TestListMessagesAfterID_ServiceNilStore(t *testing.T) {
	t.Parallel()

	svc := services.NewAgentService(nil)
	_, err := svc.ListMessagesAfterID(context.Background(), "abc-123", 0, 10)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "agent store not configured")
}

func TestListMessagesAfterID_ClampsLimit(t *testing.T) {
	t.Parallel()

	var capturedLimit int32
	q := &stubAgentQuerier{
		listMessagesAfterIDFn: func(_ context.Context, arg db.ListAgentMessagesAfterIDParams) ([]db.AgentMessage, error) {
			capturedLimit = arg.MaxResults
			return nil, nil
		},
	}

	svc := services.NewAgentService(q)

	// Exceeds max -> clamped to 1000.
	_, err := svc.ListMessagesAfterID(context.Background(), "abc-123", 0, 5000)
	require.NoError(t, err)
	assert.Equal(t, int32(1000), capturedLimit)

	// Zero -> clamped to 1000.
	_, err = svc.ListMessagesAfterID(context.Background(), "abc-123", 0, 0)
	require.NoError(t, err)
	assert.Equal(t, int32(1000), capturedLimit)

	// Negative -> clamped to 1000.
	_, err = svc.ListMessagesAfterID(context.Background(), "abc-123", 0, -1)
	require.NoError(t, err)
	assert.Equal(t, int32(1000), capturedLimit)

	// Valid -> passed through.
	_, err = svc.ListMessagesAfterID(context.Background(), "abc-123", 0, 50)
	require.NoError(t, err)
	assert.Equal(t, int32(50), capturedLimit)
}

func TestListMessagesAfterID_ReturnsMessagesWithParts(t *testing.T) {
	t.Parallel()

	q := &stubAgentQuerier{
		listMessagesAfterIDFn: func(_ context.Context, arg db.ListAgentMessagesAfterIDParams) ([]db.AgentMessage, error) {
			require.Equal(t, "sess-1", arg.SessionID)
			require.Equal(t, int64(10), arg.AfterID)
			return []db.AgentMessage{
				{ID: 11, SessionID: "sess-1", Role: "assistant", Sequence: 5, CreatedAt: time.Date(2026, 3, 15, 0, 0, 0, 0, time.UTC)},
				{ID: 12, SessionID: "sess-1", Role: "user", Sequence: 6, CreatedAt: time.Date(2026, 3, 15, 0, 0, 1, 0, time.UTC)},
			}, nil
		},
		listAgentMessagePartsFn: func(_ context.Context, messageID int64) ([]db.AgentPart, error) {
			if messageID == 11 {
				return []db.AgentPart{
					{ID: 1, MessageID: 11, PartIndex: 0, PartType: "text", Content: []byte(`{"text":"hello"}`)},
				}, nil
			}
			return []db.AgentPart{
				{ID: 2, MessageID: 12, PartIndex: 0, PartType: "text", Content: []byte(`{"text":"world"}`)},
			}, nil
		},
	}

	svc := services.NewAgentService(q)
	msgs, err := svc.ListMessagesAfterID(context.Background(), "sess-1", 10, 100)
	require.NoError(t, err)
	require.Len(t, msgs, 2)

	assert.Equal(t, int64(11), msgs[0].ID)
	assert.Equal(t, "assistant", msgs[0].Role)
	require.Len(t, msgs[0].Parts, 1)
	assert.Equal(t, "text", msgs[0].Parts[0].Type)

	assert.Equal(t, int64(12), msgs[1].ID)
	assert.Equal(t, "user", msgs[1].Role)
	require.Len(t, msgs[1].Parts, 1)
}

func TestListMessagesAfterID_EmptyResult(t *testing.T) {
	t.Parallel()

	q := &stubAgentQuerier{
		listMessagesAfterIDFn: func(_ context.Context, _ db.ListAgentMessagesAfterIDParams) ([]db.AgentMessage, error) {
			return nil, nil
		},
	}

	svc := services.NewAgentService(q)
	msgs, err := svc.ListMessagesAfterID(context.Background(), "sess-1", 999, 100)
	require.NoError(t, err)
	assert.Empty(t, msgs)
}

// ---- ReplayFormatting: verify the SSE wire format of replayed events ----

func TestReplaySSEFormat(t *testing.T) {
	t.Parallel()

	// Build a message response that would come from the service.
	msgs := []services.AgentMessageResponse{
		{
			ID:        42,
			SessionID: "abc-123",
			Role:      "assistant",
			Sequence:  1,
			Parts:     []services.AgentPartResponse{{PartIndex: 0, Type: "text", Content: map[string]any{"text": "replayed"}}},
			CreatedAt: time.Date(2026, 3, 15, 0, 0, 0, 0, time.UTC),
		},
	}

	// Simulate what the handler does during replay.
	var sb strings.Builder
	for _, m := range msgs {
		payload, err := json.Marshal(services.AgentSessionMessageEvent(m))
		require.NoError(t, err)
		evt := sse.Event{
			ID:   strconv.FormatInt(m.ID, 10),
			Type: "agent.session",
			Data: string(payload),
		}
		sb.WriteString(sse.FormatEvent(evt))
	}

	output := sb.String()
	assert.Contains(t, output, "id: 42\n")
	assert.Contains(t, output, "event: agent.session\n")
	assert.Contains(t, output, `"action":"message"`)
	assert.Contains(t, output, `"message":{`)
	assert.Contains(t, output, `"replayed"`)
}

// ---- stub querier for service-level tests ----

// stubAgentQuerier is a minimal stub satisfying services.AgentQuerier for unit tests.
// Only the methods needed by ListMessagesAfterID are wired; all others panic.
type stubAgentQuerier struct {
	listMessagesAfterIDFn   func(ctx context.Context, arg db.ListAgentMessagesAfterIDParams) ([]db.AgentMessage, error)
	listAgentMessagePartsFn func(ctx context.Context, messageID int64) ([]db.AgentPart, error)
}

func (s *stubAgentQuerier) CreateAgentSession(_ context.Context, _ db.CreateAgentSessionParams) (db.AgentSession, error) {
	panic("not implemented")
}
func (s *stubAgentQuerier) GetAgentSession(_ context.Context, _ string) (db.AgentSession, error) {
	panic("not implemented")
}
func (s *stubAgentQuerier) GetAgentSessionWithMessageCount(_ context.Context, _ string) (db.GetAgentSessionWithMessageCountRow, error) {
	panic("not implemented")
}
func (s *stubAgentQuerier) ListAgentSessionsByRepo(_ context.Context, _ db.ListAgentSessionsByRepoParams) ([]db.AgentSession, error) {
	panic("not implemented")
}
func (s *stubAgentQuerier) ListAgentSessionsByRepoWithMessageCount(_ context.Context, _ db.ListAgentSessionsByRepoWithMessageCountParams) ([]db.ListAgentSessionsByRepoWithMessageCountRow, error) {
	panic("not implemented")
}
func (s *stubAgentQuerier) CountAgentSessionsByRepo(_ context.Context, _ int64) (int64, error) {
	panic("not implemented")
}
func (s *stubAgentQuerier) CountAgentMessagesBySession(_ context.Context, _ string) (int64, error) {
	panic("not implemented")
}
func (s *stubAgentQuerier) DeleteAgentSession(_ context.Context, _ db.DeleteAgentSessionParams) error {
	panic("not implemented")
}
func (s *stubAgentQuerier) CreateAgentMessage(_ context.Context, _ db.CreateAgentMessageParams) (db.AgentMessage, error) {
	panic("not implemented")
}
func (s *stubAgentQuerier) GetNextAgentMessageSequence(_ context.Context, _ string) (int32, error) {
	panic("not implemented")
}
func (s *stubAgentQuerier) CreateAgentPart(_ context.Context, _ db.CreateAgentPartParams) (db.AgentPart, error) {
	panic("not implemented")
}
func (s *stubAgentQuerier) ListAgentMessages(_ context.Context, _ db.ListAgentMessagesParams) ([]db.AgentMessage, error) {
	panic("not implemented")
}
func (s *stubAgentQuerier) ListAgentMessagesAfterID(ctx context.Context, arg db.ListAgentMessagesAfterIDParams) ([]db.AgentMessage, error) {
	if s.listMessagesAfterIDFn != nil {
		return s.listMessagesAfterIDFn(ctx, arg)
	}
	return nil, nil
}
func (s *stubAgentQuerier) ListAgentMessageParts(ctx context.Context, messageID int64) ([]db.AgentPart, error) {
	if s.listAgentMessagePartsFn != nil {
		return s.listAgentMessagePartsFn(ctx, messageID)
	}
	return nil, nil
}
func (s *stubAgentQuerier) NotifyAgentMessage(_ context.Context, _ db.NotifyAgentMessageParams) error {
	panic("not implemented")
}
func (s *stubAgentQuerier) NotifyAgentSession(_ context.Context, _ db.NotifyAgentSessionParams) error {
	panic("not implemented")
}
func (s *stubAgentQuerier) GetAgentSessionWorkflowRunID(_ context.Context, _ string) (pgtype.Int8, error) {
	panic("not implemented")
}

// ---- Revocation principal ----

// TestAgentSessionStream_PrincipalCarriesRepositoryOrganization proves the
// stream config handed to the SSE server names the organization that owns the
// repository, so an org_member_removed event ends the removed member's stream.
func TestAgentSessionStream_PrincipalCarriesRepositoryOrganization(t *testing.T) {
	oldServe := serveAgentSessionBrokerSSE
	t.Cleanup(func() { serveAgentSessionBrokerSSE = oldServe })
	previous := currentRevocationSource()
	SetRevocationSource(revocation.NewBus(nil, nil))
	t.Cleanup(func() { SetRevocationSource(previous) })

	var gotCfg sse.BrokerStreamConfig
	serveAgentSessionBrokerSSE = func(w http.ResponseWriter, r *http.Request, cfg sse.BrokerStreamConfig) {
		gotCfg = cfg
		w.WriteHeader(http.StatusOK)
	}

	h := &AgentSessionStreamHandler{Service: &mockAgentSessionStreamService{}, Broker: &sse.Broker{}}
	req := httptest.NewRequest(http.MethodGet, "/api/repos/acme/repo/agent/sessions/abc-123/stream", nil)
	req = withRouteParams(req, map[string]string{"id": testAgentSessionID})
	req = withAuth(req, 7, "alice")
	req = withOrgRepoCtx(req, 101, 55)
	rec := httptest.NewRecorder()

	h.AgentSessionStream(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	require.NotNil(t, gotCfg.Revocations)
	require.Equal(t, revocation.Principal{
		UserID:         7,
		RepositoryID:   101,
		OrganizationID: 55,
		SessionID:      testAgentSessionID,
	}, gotCfg.Principal)
}

func (m *mockAgentSessionStreamService) GetAgentMessageStreamHead(context.Context, string) (int64, error) {
	return 0, nil
}
