package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type mockAgentSessionRouteService struct {
	createSessionFn     func(ctx context.Context, input services.CreateAgentSessionInput) (services.AgentSessionResponse, error)
	getSessionFn        func(ctx context.Context, sessionID string) (services.AgentSessionResponse, error)
	getSessionForRepo   func(ctx context.Context, sessionID string, repoID int64) error
	listSessionsFn      func(ctx context.Context, repositoryID int64, page, perPage int) ([]services.AgentSessionResponse, int64, error)
	deleteSessionFn     func(ctx context.Context, sessionID string, userID int64) error
	appendMessageFn     func(ctx context.Context, sessionID, role string, parts []db.CreateAgentPartParams) (services.AgentMessageResponse, error)
	appendAndDispatchFn func(ctx context.Context, input services.DispatchAgentRunInput, parts []db.CreateAgentPartParams) (services.AgentMessageResponse, error)
	listMessagesFn      func(ctx context.Context, sessionID string, page, perPage int) ([]services.AgentMessageResponse, error)
	dispatchRunFn       func(ctx context.Context, input services.DispatchAgentRunInput) (services.DispatchAgentRunResult, error)
	ensureDispatchFn    func(ctx context.Context, sessionID string) error
}

func (m *mockAgentSessionRouteService) EnsureSessionDispatchable(ctx context.Context, sessionID string) error {
	if m.ensureDispatchFn != nil {
		return m.ensureDispatchFn(ctx, sessionID)
	}
	return nil
}

func (m *mockAgentSessionRouteService) CreateSession(ctx context.Context, input services.CreateAgentSessionInput) (services.AgentSessionResponse, error) {
	if m.createSessionFn != nil {
		return m.createSessionFn(ctx, input)
	}
	return services.AgentSessionResponse{}, nil
}

func (m *mockAgentSessionRouteService) GetSession(ctx context.Context, sessionID string) (services.AgentSessionResponse, error) {
	if m.getSessionFn != nil {
		return m.getSessionFn(ctx, sessionID)
	}
	// Default to the user ID used by withAuth(req, 7, ...) throughout these
	// tests so PostMessage's session-ownership check passes by default.
	return services.AgentSessionResponse{ID: sessionID, UserID: 7}, nil
}

func (m *mockAgentSessionRouteService) GetSessionForRepo(ctx context.Context, sessionID string, repoID int64) error {
	if m.getSessionForRepo != nil {
		return m.getSessionForRepo(ctx, sessionID, repoID)
	}
	return nil
}

func (m *mockAgentSessionRouteService) ListSessions(ctx context.Context, repositoryID int64, page, perPage int) ([]services.AgentSessionResponse, int64, error) {
	if m.listSessionsFn != nil {
		return m.listSessionsFn(ctx, repositoryID, page, perPage)
	}
	return nil, 0, nil
}

func (m *mockAgentSessionRouteService) AppendMessage(ctx context.Context, sessionID, role string, parts []db.CreateAgentPartParams) (services.AgentMessageResponse, error) {
	if m.appendMessageFn != nil {
		return m.appendMessageFn(ctx, sessionID, role, parts)
	}
	return services.AgentMessageResponse{}, nil
}

func (m *mockAgentSessionRouteService) AppendMessageAndDispatch(ctx context.Context, input services.DispatchAgentRunInput, parts []db.CreateAgentPartParams) (services.AgentMessageResponse, error) {
	if m.appendAndDispatchFn != nil {
		return m.appendAndDispatchFn(ctx, input, parts)
	}
	return services.AgentMessageResponse{}, nil
}

func (m *mockAgentSessionRouteService) ListMessages(ctx context.Context, sessionID string, page, perPage int) ([]services.AgentMessageResponse, error) {
	if m.listMessagesFn != nil {
		return m.listMessagesFn(ctx, sessionID, page, perPage)
	}
	return nil, nil
}

func (m *mockAgentSessionRouteService) DeleteSession(ctx context.Context, sessionID string, userID int64) error {
	if m.deleteSessionFn != nil {
		return m.deleteSessionFn(ctx, sessionID, userID)
	}
	return nil
}

func (m *mockAgentSessionRouteService) DispatchAgentRun(ctx context.Context, input services.DispatchAgentRunInput) (services.DispatchAgentRunResult, error) {
	if m.dispatchRunFn != nil {
		return m.dispatchRunFn(ctx, input)
	}
	return services.DispatchAgentRunResult{}, nil
}

func TestAgentSessionHandler_CreateSession_Success(t *testing.T) {
	t.Parallel()

	var got services.CreateAgentSessionInput
	handler := &AgentSessionHandler{
		Service: &mockAgentSessionRouteService{
			createSessionFn: func(_ context.Context, input services.CreateAgentSessionInput) (services.AgentSessionResponse, error) {
				got = input
				return services.AgentSessionResponse{
					ID:           "sess-123",
					RepositoryID: input.RepositoryID,
					UserID:       input.UserID,
					Title:        input.Title,
					Status:       "active",
					CreatedAt:    time.Now().UTC(),
					UpdatedAt:    time.Now().UTC(),
				}, nil
			},
		},
	}

	req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/agent/sessions", strings.NewReader(`{"title":"  triage  "}`))
	req = withAuth(req, 7, "alice")
	req = withRepoCtx(req, 101, "alice", "demo")
	rec := httptest.NewRecorder()

	handler.CreateSession(rec, req)

	require.Equal(t, http.StatusCreated, rec.Code)
	assert.Equal(t, int64(101), got.RepositoryID)
	assert.Equal(t, int64(7), got.UserID)
	assert.Equal(t, "triage", got.Title)
}

func TestAgentSessionHandler_ListSessions_SetsPaginationHeaders(t *testing.T) {
	t.Parallel()

	handler := &AgentSessionHandler{
		Service: &mockAgentSessionRouteService{
			listSessionsFn: func(_ context.Context, repositoryID int64, page, perPage int) ([]services.AgentSessionResponse, int64, error) {
				assert.Equal(t, int64(101), repositoryID)
				assert.Equal(t, 2, page)
				assert.Equal(t, 5, perPage)
				return []services.AgentSessionResponse{{ID: "sess-1"}}, 11, nil
			},
		},
	}

	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/agent/sessions?page=2&per_page=5", nil)
	req = withAuth(req, 7, "alice")
	req = withRepoCtx(req, 101, "alice", "demo")
	rec := httptest.NewRecorder()

	handler.ListSessions(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, "11", rec.Header().Get("X-Total-Count"))
	assert.Contains(t, rec.Header().Get("Link"), "page=1")
}

func TestAgentSessionHandler_GetSession_VerifiesRepoScope(t *testing.T) {
	t.Parallel()

	var validated bool
	handler := &AgentSessionHandler{
		Service: &mockAgentSessionRouteService{
			getSessionForRepo: func(_ context.Context, sessionID string, repoID int64) error {
				validated = true
				assert.Equal(t, "sess-123", sessionID)
				assert.Equal(t, int64(101), repoID)
				return nil
			},
			getSessionFn: func(_ context.Context, sessionID string) (services.AgentSessionResponse, error) {
				return services.AgentSessionResponse{ID: sessionID, Status: "active"}, nil
			},
		},
	}

	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/agent/sessions/sess-123", nil)
	req = withRouteParams(req, map[string]string{"id": "sess-123"})
	req = withAuth(req, 7, "alice")
	req = withRepoCtx(req, 101, "alice", "demo")
	rec := httptest.NewRecorder()

	handler.GetSession(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	assert.True(t, validated)
}

func TestAgentSessionHandler_PostMessage_UserDispatchesSandboxRun(t *testing.T) {
	t.Parallel()

	var gotParts []db.CreateAgentPartParams
	var gotDispatch services.DispatchAgentRunInput
	handler := &AgentSessionHandler{
		Service: &mockAgentSessionRouteService{
			getSessionForRepo: func(_ context.Context, sessionID string, repoID int64) error {
				assert.Equal(t, "sess-123", sessionID)
				assert.Equal(t, int64(101), repoID)
				return nil
			},
			appendAndDispatchFn: func(_ context.Context, input services.DispatchAgentRunInput, parts []db.CreateAgentPartParams) (services.AgentMessageResponse, error) {
				gotParts = parts
				gotDispatch = input
				return services.AgentMessageResponse{
					ID:        55,
					SessionID: input.SessionID,
					Role:      "user",
					Sequence:  0,
					Parts: []services.AgentPartResponse{
						{PartIndex: 0, Type: "text", Content: map[string]any{"value": "hello"}},
					},
					CreatedAt: time.Now().UTC(),
				}, nil
			},
			dispatchRunFn: func(_ context.Context, _ services.DispatchAgentRunInput) (services.DispatchAgentRunResult, error) {
				t.Error("HTTP acceptance must not execute an agent run")
				return services.DispatchAgentRunResult{}, nil
			},
		},
	}

	req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/agent/sessions/sess-123/messages", strings.NewReader(`{
		"role":"user",
		"parts":[{"type":"text","content":"hello"}],
		"changeset_id":71,
		"allowed_paths":["src/**","docs/*.md"]
	}`))
	req = withRouteParams(req, map[string]string{"id": "sess-123"})
	req = withAuth(req, 7, "alice")
	req = withRepoCtx(req, 101, "alice", "demo")
	rec := httptest.NewRecorder()

	handler.PostMessage(rec, req)

	require.Equal(t, http.StatusCreated, rec.Code)
	require.Len(t, gotParts, 1)
	assert.Equal(t, "text", gotParts[0].PartType)
	assert.JSONEq(t, `{"value":"hello"}`, string(gotParts[0].Content))
	assert.Equal(t, "sess-123", gotDispatch.SessionID)
	assert.Equal(t, int64(101), gotDispatch.RepositoryID)
	assert.Equal(t, int64(7), gotDispatch.UserID)
	assert.Zero(t, gotDispatch.TriggerMessageID, "service assigns the message ID during admission")
	assert.Equal(t, "alice", gotDispatch.MessageAuthor, "the authenticated poster, never parsed from the text")
	assert.Equal(t, "alice", gotDispatch.RepoOwner)
	assert.Equal(t, "demo", gotDispatch.RepoName)
	assert.Equal(t, int64(71), gotDispatch.ChangesetID)
	assert.Equal(t, []string{"src/**", "docs/*.md"}, gotDispatch.AllowedPaths)
}

func TestAgentSessionHandler_PostMessage_DispatchesCodexHTTPRuntime(t *testing.T) {
	t.Parallel()

	var gotDispatch services.DispatchAgentRunInput
	handler := &AgentSessionHandler{
		Service: &mockAgentSessionRouteService{
			getSessionForRepo: func(_ context.Context, sessionID string, repoID int64) error {
				return nil
			},
			appendAndDispatchFn: func(_ context.Context, input services.DispatchAgentRunInput, _ []db.CreateAgentPartParams) (services.AgentMessageResponse, error) {
				gotDispatch = input
				return services.AgentMessageResponse{ID: 55, SessionID: input.SessionID, Role: "user"}, nil
			},
			dispatchRunFn: func(_ context.Context, _ services.DispatchAgentRunInput) (services.DispatchAgentRunResult, error) {
				t.Error("HTTP acceptance must not execute an agent run")
				return services.DispatchAgentRunResult{}, nil
			},
		},
	}

	req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/agent/sessions/sess-123/messages", strings.NewReader(`{
		"role":"user",
		"parts":[{"type":"text","content":"hello"}],
		"agent_provider":"codex",
		"agent_transport":"http"
	}`))
	req = withRouteParams(req, map[string]string{"id": "sess-123"})
	req = withAuth(req, 7, "alice")
	req = withRepoCtx(req, 101, "alice", "demo")
	rec := httptest.NewRecorder()

	handler.PostMessage(rec, req)

	require.Equal(t, http.StatusCreated, rec.Code)
	assert.Equal(t, "codex", gotDispatch.AgentProvider)
	assert.Equal(t, "http", gotDispatch.AgentTransport)
}

func TestAgentSessionHandler_PostMessage_RejectsHTTPTransportWithoutCodex(t *testing.T) {
	t.Parallel()

	appended := false
	admitted := false
	handler := &AgentSessionHandler{
		Service: &mockAgentSessionRouteService{
			getSessionForRepo: func(_ context.Context, sessionID string, repoID int64) error {
				return nil
			},
			appendMessageFn: func(_ context.Context, sessionID, role string, parts []db.CreateAgentPartParams) (services.AgentMessageResponse, error) {
				appended = true
				return services.AgentMessageResponse{ID: 55, SessionID: sessionID, Role: role}, nil
			},
			appendAndDispatchFn: func(_ context.Context, _ services.DispatchAgentRunInput, _ []db.CreateAgentPartParams) (services.AgentMessageResponse, error) {
				admitted = true
				return services.AgentMessageResponse{}, nil
			},
		},
	}

	req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/agent/sessions/sess-123/messages", strings.NewReader(`{
		"role":"user",
		"parts":[{"type":"text","content":"hello"}],
		"agent_transport":"http"
	}`))
	req = withRouteParams(req, map[string]string{"id": "sess-123"})
	req = withAuth(req, 7, "alice")
	req = withRepoCtx(req, 101, "alice", "demo")
	rec := httptest.NewRecorder()

	handler.PostMessage(rec, req)

	require.Equal(t, http.StatusBadRequest, rec.Code)
	assert.False(t, appended)
	assert.False(t, admitted)
}

func TestAgentSessionHandler_PostMessage_TextShortcutDefaultsToAssistant(t *testing.T) {
	t.Parallel()

	var gotParts []db.CreateAgentPartParams
	admitted := false
	handler := &AgentSessionHandler{
		Service: &mockAgentSessionRouteService{
			getSessionForRepo: func(_ context.Context, sessionID string, repoID int64) error {
				assert.Equal(t, "sess-123", sessionID)
				assert.Equal(t, int64(101), repoID)
				return nil
			},
			appendMessageFn: func(_ context.Context, sessionID, role string, parts []db.CreateAgentPartParams) (services.AgentMessageResponse, error) {
				gotParts = parts
				assert.Equal(t, "sess-123", sessionID)
				assert.Equal(t, "assistant", role)
				return services.AgentMessageResponse{
					ID:        55,
					SessionID: sessionID,
					Role:      role,
					Sequence:  0,
					Parts: []services.AgentPartResponse{
						{PartIndex: 0, Type: "text", Content: map[string]any{"value": "hello"}},
					},
					CreatedAt: time.Now().UTC(),
				}, nil
			},
			appendAndDispatchFn: func(_ context.Context, _ services.DispatchAgentRunInput, _ []db.CreateAgentPartParams) (services.AgentMessageResponse, error) {
				admitted = true
				return services.AgentMessageResponse{}, nil
			},
		},
	}

	req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/agent/sessions/sess-123/messages", strings.NewReader(`{
		"text":"hello"
	}`))
	req = withRouteParams(req, map[string]string{"id": "sess-123"})
	req = withAuth(req, 7, "alice")
	req = withRepoCtx(req, 101, "alice", "demo")
	rec := httptest.NewRecorder()

	handler.PostMessage(rec, req)

	require.Equal(t, http.StatusCreated, rec.Code)
	require.Len(t, gotParts, 1)
	assert.Equal(t, "text", gotParts[0].PartType)
	assert.JSONEq(t, `{"value":"hello"}`, string(gotParts[0].Content))
	assert.False(t, admitted)
}

func TestAgentSessionHandler_PostMessage_AssistantDoesNotDispatch(t *testing.T) {
	t.Parallel()

	admitted := false
	handler := &AgentSessionHandler{
		Service: &mockAgentSessionRouteService{
			getSessionForRepo: func(_ context.Context, _ string, _ int64) error {
				return nil
			},
			appendMessageFn: func(_ context.Context, sessionID, role string, parts []db.CreateAgentPartParams) (services.AgentMessageResponse, error) {
				return services.AgentMessageResponse{ID: 55, SessionID: sessionID, Role: role}, nil
			},
			appendAndDispatchFn: func(_ context.Context, _ services.DispatchAgentRunInput, _ []db.CreateAgentPartParams) (services.AgentMessageResponse, error) {
				admitted = true
				return services.AgentMessageResponse{}, nil
			},
		},
	}

	req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/agent/sessions/sess-123/messages", strings.NewReader(`{
		"role":"assistant",
		"parts":[{"type":"text","content":{"value":"ack"}}]
	}`))
	req = withRouteParams(req, map[string]string{"id": "sess-123"})
	req = withAuth(req, 7, "alice")
	req = withRepoCtx(req, 101, "alice", "demo")
	rec := httptest.NewRecorder()

	handler.PostMessage(rec, req)

	require.Equal(t, http.StatusCreated, rec.Code)
	assert.False(t, admitted)
}

func TestAgentSessionHandler_PostMessage_RejectsInvalidRole(t *testing.T) {
	t.Parallel()

	handler := &AgentSessionHandler{
		Service: &mockAgentSessionRouteService{
			getSessionForRepo: func(_ context.Context, _ string, _ int64) error {
				return nil
			},
		},
	}

	req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/agent/sessions/sess-123/messages", strings.NewReader(`{
		"role":"narrator",
		"parts":[{"type":"text","content":"hello"}]
	}`))
	req = withRouteParams(req, map[string]string{"id": "sess-123"})
	req = withAuth(req, 7, "alice")
	req = withRepoCtx(req, 101, "alice", "demo")
	rec := httptest.NewRecorder()

	handler.PostMessage(rec, req)

	require.Equal(t, http.StatusBadRequest, rec.Code)
}

func TestAgentSessionHandler_ListMessages_Success(t *testing.T) {
	t.Parallel()

	handler := &AgentSessionHandler{
		Service: &mockAgentSessionRouteService{
			getSessionForRepo: func(_ context.Context, sessionID string, repoID int64) error {
				assert.Equal(t, "sess-123", sessionID)
				assert.Equal(t, int64(101), repoID)
				return nil
			},
			listMessagesFn: func(_ context.Context, sessionID string, page, perPage int) ([]services.AgentMessageResponse, error) {
				assert.Equal(t, "sess-123", sessionID)
				assert.Equal(t, 1, page)
				assert.Equal(t, 30, perPage)
				return []services.AgentMessageResponse{
					{ID: 1, SessionID: sessionID, Role: "user", Sequence: 0},
				}, nil
			},
		},
	}

	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/agent/sessions/sess-123/messages", nil)
	req = withRouteParams(req, map[string]string{"id": "sess-123"})
	req = withAuth(req, 7, "alice")
	req = withRepoCtx(req, 101, "alice", "demo")
	rec := httptest.NewRecorder()

	handler.ListMessages(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	var body []services.AgentMessageResponse
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	require.Len(t, body, 1)
	assert.Equal(t, int64(1), body[0].ID)
}

func TestNormalizeAgentMessageParts_RejectsInvalidPartType(t *testing.T) {
	t.Parallel()

	_, err := normalizeAgentMessageParts([]createAgentMessagePartRequest{
		{Type: "done", Content: json.RawMessage(`{"status":"completed"}`)},
	})

	require.Error(t, err)
	assert.Equal(t, http.StatusBadRequest, err.Status)
}

func TestAgentSessionHandler_PostMessage_AdmissionFailureDoesNotReturnCreated(t *testing.T) {
	t.Parallel()

	appendCalled := false
	admissionCalled := false
	handler := &AgentSessionHandler{Service: &mockAgentSessionRouteService{
		appendMessageFn: func(_ context.Context, _, _ string, _ []db.CreateAgentPartParams) (services.AgentMessageResponse, error) {
			appendCalled = true
			return services.AgentMessageResponse{ID: 55}, nil
		},
		appendAndDispatchFn: func(_ context.Context, input services.DispatchAgentRunInput, parts []db.CreateAgentPartParams) (services.AgentMessageResponse, error) {
			admissionCalled = true
			assert.Equal(t, "sess-123", input.SessionID)
			assert.Zero(t, input.TriggerMessageID)
			require.Len(t, parts, 1)
			return services.AgentMessageResponse{}, pkgerrors.Internal("admission unavailable")
		},
	}}

	req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/agent/sessions/sess-123/messages", strings.NewReader(`{"role":"user","parts":[{"type":"text","content":"hello"}]}`))
	req = withRouteParams(req, map[string]string{"id": "sess-123"})
	req = withAuth(req, 7, "alice")
	req = withRepoCtx(req, 101, "alice", "demo")
	rec := httptest.NewRecorder()

	handler.PostMessage(rec, req)

	require.True(t, admissionCalled)
	assert.False(t, appendCalled, "user message must use atomic admission")
	assert.Equal(t, http.StatusInternalServerError, rec.Code)
}

func TestAgentSessionHandler_PostMessage_AdmissionSuccessDoesNotExecute(t *testing.T) {
	t.Parallel()

	admissionCalled := false
	appendCalled := false
	executionCalled := false
	handler := &AgentSessionHandler{Service: &mockAgentSessionRouteService{
		appendMessageFn: func(_ context.Context, _, _ string, _ []db.CreateAgentPartParams) (services.AgentMessageResponse, error) {
			appendCalled = true
			return services.AgentMessageResponse{}, nil
		},
		appendAndDispatchFn: func(_ context.Context, input services.DispatchAgentRunInput, _ []db.CreateAgentPartParams) (services.AgentMessageResponse, error) {
			admissionCalled = true
			assert.Equal(t, "sess-123", input.SessionID)
			return services.AgentMessageResponse{ID: 55, SessionID: input.SessionID, Role: "user"}, nil
		},
		dispatchRunFn: func(_ context.Context, _ services.DispatchAgentRunInput) (services.DispatchAgentRunResult, error) {
			executionCalled = true
			return services.DispatchAgentRunResult{}, pkgerrors.Internal("execution unavailable")
		},
	}}

	req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/agent/sessions/sess-123/messages", strings.NewReader(`{"role":"user","parts":[{"type":"text","content":"hello"}]}`))
	req = withRouteParams(req, map[string]string{"id": "sess-123"})
	req = withAuth(req, 7, "alice")
	req = withRepoCtx(req, 101, "alice", "demo")
	rec := httptest.NewRecorder()

	handler.PostMessage(rec, req)

	require.True(t, admissionCalled)
	assert.False(t, appendCalled)
	assert.False(t, executionCalled)
	require.Equal(t, http.StatusCreated, rec.Code)
	var message services.AgentMessageResponse
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &message))
	assert.Equal(t, int64(55), message.ID)
}

func TestAgentSessionHandler_DeleteSession_Success(t *testing.T) {
	t.Parallel()

	var deletedSessionID string
	var deletedUserID int64
	handler := &AgentSessionHandler{
		Service: &mockAgentSessionRouteService{
			getSessionForRepo: func(_ context.Context, sessionID string, repoID int64) error {
				assert.Equal(t, "sess-123", sessionID)
				assert.Equal(t, int64(101), repoID)
				return nil
			},
			deleteSessionFn: func(_ context.Context, sessionID string, userID int64) error {
				deletedSessionID = sessionID
				deletedUserID = userID
				return nil
			},
		},
	}

	req := httptest.NewRequest(http.MethodDelete, "/api/repos/alice/demo/agent/sessions/sess-123", nil)
	req = withRouteParams(req, map[string]string{"id": "sess-123"})
	req = withAuth(req, 7, "alice")
	req = withRepoCtx(req, 101, "alice", "demo")
	rec := httptest.NewRecorder()

	handler.DeleteSession(rec, req)

	require.Equal(t, http.StatusNoContent, rec.Code)
	assert.Equal(t, "sess-123", deletedSessionID)
	assert.Equal(t, int64(7), deletedUserID)
}

func TestAgentSessionHandler_DeleteSession_RepoScopeMismatch(t *testing.T) {
	t.Parallel()

	handler := &AgentSessionHandler{
		Service: &mockAgentSessionRouteService{
			getSessionForRepo: func(_ context.Context, _ string, _ int64) error {
				return pkgerrors.NotFound("agent session not found")
			},
		},
	}

	req := httptest.NewRequest(http.MethodDelete, "/api/repos/alice/demo/agent/sessions/sess-123", nil)
	req = withRouteParams(req, map[string]string{"id": "sess-123"})
	req = withAuth(req, 7, "alice")
	req = withRepoCtx(req, 101, "alice", "demo")
	rec := httptest.NewRecorder()

	handler.DeleteSession(rec, req)

	require.Equal(t, http.StatusNotFound, rec.Code)
}

func TestAgentSessionHandler_DeleteSession_ServiceError(t *testing.T) {
	t.Parallel()

	handler := &AgentSessionHandler{
		Service: &mockAgentSessionRouteService{
			getSessionForRepo: func(_ context.Context, _ string, _ int64) error {
				return nil
			},
			deleteSessionFn: func(_ context.Context, _ string, _ int64) error {
				return pkgerrors.Forbidden("you do not own this agent session")
			},
		},
	}

	req := httptest.NewRequest(http.MethodDelete, "/api/repos/alice/demo/agent/sessions/sess-123", nil)
	req = withRouteParams(req, map[string]string{"id": "sess-123"})
	req = withAuth(req, 7, "alice")
	req = withRepoCtx(req, 101, "alice", "demo")
	rec := httptest.NewRecorder()

	handler.DeleteSession(rec, req)

	require.Equal(t, http.StatusForbidden, rec.Code)
}

func TestAgentSessionHandler_ListSessions_IncludesMessageCount(t *testing.T) {
	t.Parallel()

	handler := &AgentSessionHandler{
		Service: &mockAgentSessionRouteService{
			listSessionsFn: func(_ context.Context, repositoryID int64, page, perPage int) ([]services.AgentSessionResponse, int64, error) {
				return []services.AgentSessionResponse{
					{ID: "sess-1", Status: "completed", MessageCount: 42},
					{ID: "sess-2", Status: "active", MessageCount: 3},
				}, 2, nil
			},
		},
	}

	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/agent/sessions", nil)
	req = withAuth(req, 7, "alice")
	req = withRepoCtx(req, 101, "alice", "demo")
	rec := httptest.NewRecorder()

	handler.ListSessions(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	var body []services.AgentSessionResponse
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	require.Len(t, body, 2)
	assert.Equal(t, int64(42), body[0].MessageCount)
	assert.Equal(t, int64(3), body[1].MessageCount)
}

func TestAgentSessionHandler_GetSession_IncludesMessageCount(t *testing.T) {
	t.Parallel()

	handler := &AgentSessionHandler{
		Service: &mockAgentSessionRouteService{
			getSessionForRepo: func(_ context.Context, _ string, _ int64) error {
				return nil
			},
			getSessionFn: func(_ context.Context, sessionID string) (services.AgentSessionResponse, error) {
				return services.AgentSessionResponse{
					ID:           sessionID,
					Status:       "completed",
					MessageCount: 15,
				}, nil
			},
		},
	}

	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/agent/sessions/sess-123", nil)
	req = withRouteParams(req, map[string]string{"id": "sess-123"})
	req = withAuth(req, 7, "alice")
	req = withRepoCtx(req, 101, "alice", "demo")
	rec := httptest.NewRecorder()

	handler.GetSession(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	var body services.AgentSessionResponse
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	assert.Equal(t, int64(15), body.MessageCount)
	assert.Equal(t, "completed", body.Status)
}

// ---- Ticket 0114: delete-then-read route behavior ----

// TestAgentSessionHandler_DeleteThenGet_Returns404 simulates the client flow:
//  1. DELETE /api/repos/.../agent/sessions/{id} — succeeds (204).
//  2. GET    /api/repos/.../agent/sessions/{id} — returns 404 (tombstoned
//     rows are hidden by the WHERE deleted_at IS NULL filter in the
//     underlying query).
//
// The mock GetSessionForRepo flips from "session live" to "not found" after
// the DELETE, matching the real service behavior.
func TestAgentSessionHandler_DeleteThenGet_Returns404(t *testing.T) {
	t.Parallel()

	tombstoned := false
	svc := &mockAgentSessionRouteService{
		getSessionForRepo: func(_ context.Context, _ string, _ int64) error {
			if tombstoned {
				return pkgerrors.NotFound("agent session not found")
			}
			return nil
		},
		deleteSessionFn: func(_ context.Context, _ string, _ int64) error {
			tombstoned = true
			return nil
		},
		getSessionFn: func(_ context.Context, id string) (services.AgentSessionResponse, error) {
			return services.AgentSessionResponse{ID: id, Status: "active"}, nil
		},
	}
	handler := &AgentSessionHandler{Service: svc}

	// DELETE succeeds.
	delReq := httptest.NewRequest(http.MethodDelete, "/api/repos/alice/demo/agent/sessions/sess-abc", nil)
	delReq = withRouteParams(delReq, map[string]string{"id": "sess-abc"})
	delReq = withAuth(delReq, 7, "alice")
	delReq = withRepoCtx(delReq, 101, "alice", "demo")
	delRec := httptest.NewRecorder()
	handler.DeleteSession(delRec, delReq)
	require.Equal(t, http.StatusNoContent, delRec.Code)

	// Subsequent GET returns 404.
	getReq := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/agent/sessions/sess-abc", nil)
	getReq = withRouteParams(getReq, map[string]string{"id": "sess-abc"})
	getReq = withAuth(getReq, 7, "alice")
	getReq = withRepoCtx(getReq, 101, "alice", "demo")
	getRec := httptest.NewRecorder()
	handler.GetSession(getRec, getReq)
	require.Equal(t, http.StatusNotFound, getRec.Code,
		"a tombstoned session must not be returned via GET — the public API must never leak deleted_at")

	// And a re-DELETE returns 404 as well (idempotent surface).
	delReq2 := httptest.NewRequest(http.MethodDelete, "/api/repos/alice/demo/agent/sessions/sess-abc", nil)
	delReq2 = withRouteParams(delReq2, map[string]string{"id": "sess-abc"})
	delReq2 = withAuth(delReq2, 7, "alice")
	delReq2 = withRepoCtx(delReq2, 101, "alice", "demo")
	delRec2 := httptest.NewRecorder()
	handler.DeleteSession(delRec2, delReq2)
	require.Equal(t, http.StatusNotFound, delRec2.Code)
}

// TestAgentSessionHandler_DeleteThenList_Omits verifies that a tombstoned
// session is absent from the repo's session list response. The mock ListSessions
// flips to an empty slice after DELETE — mirroring the real query filter.
func TestAgentSessionHandler_DeleteThenList_Omits(t *testing.T) {
	t.Parallel()

	liveSessions := []services.AgentSessionResponse{
		{ID: "sess-abc", Status: "active", Title: "will be tombstoned"},
	}
	svc := &mockAgentSessionRouteService{
		getSessionForRepo: func(_ context.Context, _ string, _ int64) error { return nil },
		deleteSessionFn: func(_ context.Context, id string, _ int64) error {
			remaining := make([]services.AgentSessionResponse, 0, len(liveSessions))
			for _, s := range liveSessions {
				if s.ID != id {
					remaining = append(remaining, s)
				}
			}
			liveSessions = remaining
			return nil
		},
		listSessionsFn: func(_ context.Context, _ int64, _, _ int) ([]services.AgentSessionResponse, int64, error) {
			return liveSessions, int64(len(liveSessions)), nil
		},
	}
	handler := &AgentSessionHandler{Service: svc}

	// Pre-delete: list contains the session.
	listReq := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/agent/sessions", nil)
	listReq = withAuth(listReq, 7, "alice")
	listReq = withRepoCtx(listReq, 101, "alice", "demo")
	listRec := httptest.NewRecorder()
	handler.ListSessions(listRec, listReq)
	require.Equal(t, http.StatusOK, listRec.Code)
	var before []services.AgentSessionResponse
	require.NoError(t, json.Unmarshal(listRec.Body.Bytes(), &before))
	require.Len(t, before, 1)

	// DELETE.
	delReq := httptest.NewRequest(http.MethodDelete, "/api/repos/alice/demo/agent/sessions/sess-abc", nil)
	delReq = withRouteParams(delReq, map[string]string{"id": "sess-abc"})
	delReq = withAuth(delReq, 7, "alice")
	delReq = withRepoCtx(delReq, 101, "alice", "demo")
	delRec := httptest.NewRecorder()
	handler.DeleteSession(delRec, delReq)
	require.Equal(t, http.StatusNoContent, delRec.Code)

	// Post-delete: list is empty.
	listReq2 := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/agent/sessions", nil)
	listReq2 = withAuth(listReq2, 7, "alice")
	listReq2 = withRepoCtx(listReq2, 101, "alice", "demo")
	listRec2 := httptest.NewRecorder()
	handler.ListSessions(listRec2, listReq2)
	require.Equal(t, http.StatusOK, listRec2.Code)
	var after []services.AgentSessionResponse
	require.NoError(t, json.Unmarshal(listRec2.Body.Bytes(), &after))
	assert.Len(t, after, 0, "tombstoned sessions must not appear in the list response")
}

// Regression: PostMessage lacked the session-ownership check that
// DeleteSession enforces, letting any repo collaborator drive another
// user's agent session.
func TestAgentSessionHandler_PostMessage_ForbiddenWhenNotOwner(t *testing.T) {
	t.Parallel()

	appendCalled := false
	handler := &AgentSessionHandler{
		Service: &mockAgentSessionRouteService{
			getSessionFn: func(_ context.Context, id string) (services.AgentSessionResponse, error) {
				return services.AgentSessionResponse{ID: id, UserID: 999, Status: "active"}, nil
			},
			appendMessageFn: func(_ context.Context, _, _ string, _ []db.CreateAgentPartParams) (services.AgentMessageResponse, error) {
				appendCalled = true
				return services.AgentMessageResponse{}, nil
			},
		},
	}

	req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/agent/sessions/sess-123/messages", strings.NewReader(`{
		"role":"user",
		"parts":[{"type":"text","content":"hello"}]
	}`))
	req = withRouteParams(req, map[string]string{"id": "sess-123"})
	req = withAuth(req, 7, "alice")
	req = withRepoCtx(req, 101, "alice", "demo")
	rec := httptest.NewRecorder()

	handler.PostMessage(rec, req)

	require.Equal(t, http.StatusForbidden, rec.Code)
	assert.False(t, appendCalled, "message must not be appended to a session the caller does not own")
}

// Admission rejects a new user message while the session has an active run.
func TestAgentSessionHandler_PostMessage_ConflictWhenSessionHasActiveRun(t *testing.T) {
	t.Parallel()

	appendCalled := false
	admissionCalled := false
	handler := &AgentSessionHandler{
		Service: &mockAgentSessionRouteService{
			appendMessageFn: func(_ context.Context, _, _ string, _ []db.CreateAgentPartParams) (services.AgentMessageResponse, error) {
				appendCalled = true
				return services.AgentMessageResponse{}, nil
			},
			appendAndDispatchFn: func(_ context.Context, input services.DispatchAgentRunInput, _ []db.CreateAgentPartParams) (services.AgentMessageResponse, error) {
				admissionCalled = true
				assert.Equal(t, "sess-123", input.SessionID)
				return services.AgentMessageResponse{}, pkgerrors.Conflict("agent session already has an active run")
			},
		},
	}

	req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/agent/sessions/sess-123/messages", strings.NewReader(`{
		"role":"user",
		"parts":[{"type":"text","content":"hello"}]
	}`))
	req = withRouteParams(req, map[string]string{"id": "sess-123"})
	req = withAuth(req, 7, "alice")
	req = withRepoCtx(req, 101, "alice", "demo")
	rec := httptest.NewRecorder()

	handler.PostMessage(rec, req)

	require.Equal(t, http.StatusConflict, rec.Code)
	assert.False(t, appendCalled)
	assert.True(t, admissionCalled)
}
