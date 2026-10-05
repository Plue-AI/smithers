package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
)

// answerSignals stands in for the stack's Flow dispatcher: launches are not
// under test, and each admitted signal is recorded.
type answerSignals struct {
	mu      sync.Mutex
	signals []flowdispatch.SignalRequest
}

func (s *answerSignals) AdmitInTx(context.Context, pgx.Tx, flowdispatch.LaunchRequest) (jobs.RequestReceipt, error) {
	return jobs.RequestReceipt{}, nil
}

func (s *answerSignals) SignalInTx(_ context.Context, _ pgx.Tx, request flowdispatch.SignalRequest) (jobs.RequestReceipt, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.signals = append(s.signals, request)
	return jobs.RequestReceipt{}, nil
}

func (s *answerSignals) sent() []flowdispatch.SignalRequest {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]flowdispatch.SignalRequest(nil), s.signals...)
}

// POST /api/todos/{n}/answer with the production handler and service on real
// PostgreSQL: only the install owner's browser session answers; the first
// answer settles the question (202) and signals the run that asked; a later
// different answer is 409 {answered_by}; the card then shows the answer.
func TestTodoAnswerHTTP(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx := context.Background()
	var owner, member, repo int64
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO users(username,lower_username,display_name) VALUES ('answer-owner','answer-owner','Answer Owner') RETURNING id`).Scan(&owner))
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO users(username,lower_username) VALUES ('answer-member','answer-member') RETURNING id`).Scan(&member))
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO repositories(user_id,name,lower_name) VALUES ($1,'answer-repo','answer-repo') RETURNING id`, owner).Scan(&repo))
	_, err := pool.Exec(ctx, `INSERT INTO self_host_owners(singleton,user_id) VALUES (true,$1)`, owner)
	require.NoError(t, err)
	q := db.New(pool)
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "github.repository", Value: []byte(`{"owner_login":"answer-owner","repository_name":"answer-repo"}`)}))
	checks := `{"todo":true,"run_launched":true,"run_attached":true,"waits":[{"id":"q-0123456789abcdef","kind":"question","prompt":"Backoff or a fixed delay?","since":"2026-10-05T08:00:00Z",
		"signal":{"scope":{"TenantID":"repository:1","PrincipalID":"user:1"},"target":{"TenantID":"repository:1","PrincipalID":"user:1","WorkspaceID":"w-1","BindingKind":"mythical-item","BindingID":"i-1"},"flow":"todo","run":"run-1","name":"coding-clarification"}}]}`
	item, _, err := q.InsertMythicalItem(ctx, db.MythicalItem{RepositoryID: repo, State: "running", Checks: []byte(checks)})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE mythical_items SET source='todo', number=3, request_run_id='run-1', attempt=1, title='Retry webhooks' WHERE id=$1`, item.ID)
	require.NoError(t, err)

	service := services.NewMythicalService(pool, nil)
	signals := &answerSignals{}
	service.SetLauncher(signals)
	router := chi.NewRouter()
	handler := &TodoHandler{Queries: q, Service: service}
	router.Post("/api/todos/{n}/answer", handler.Answer)
	router.Get("/api/todos/{n}", handler.Get)
	ownerSession := &middleware.AuthInfo{User: &db.User{ID: owner}, SessionHash: "owner-session"}
	call := func(method, path, body string, info *middleware.AuthInfo) (int, map[string]any) {
		t.Helper()
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		req = req.WithContext(middleware.ContextWithAuthInfo(ctx, info))
		response := httptest.NewRecorder()
		router.ServeHTTP(response, req)
		var envelope map[string]any
		require.NoError(t, json.Unmarshal(response.Body.Bytes(), &envelope), response.Body.String())
		return response.Code, envelope
	}
	answer := `{"wait":"q-0123456789abcdef","answer":"Use backoff"}`

	status, card := call(http.MethodGet, "/api/todos/3", "", ownerSession)
	require.Equal(t, 200, status)
	require.Equal(t, "needs_you", card["state"])
	require.Len(t, card["waits"], 1)

	for _, tc := range []struct {
		name, path, body, code string
		status                 int
		info                   *middleware.AuthInfo
	}{
		{"member session", "3", answer, "permission", 403, &middleware.AuthInfo{User: &db.User{ID: member}, SessionHash: "member-session"}},
		{"token", "3", answer, "permission", 403, &middleware.AuthInfo{User: &db.User{ID: owner}, IsTokenAuth: true, TokenSource: middleware.TokenSourcePersonalAccessToken}},
		{"invalid number", "x", answer, "invalid_todo", 400, ownerSession},
		{"unknown field", "3", `{"wait":"q-0123456789abcdef","answer":"Use backoff","by":"someone"}`, "invalid_answer", 400, ownerSession},
		{"steer is not an answer", "3", `{"op":"steer","steer":"Use backoff"}`, "invalid_answer", 400, ownerSession},
		{"no answer", "3", `{"wait":"q-0123456789abcdef"}`, "invalid_answer", 400, ownerSession},
		{"two documents", "3", answer + answer, "invalid_answer", 400, ownerSession},
		{"unknown question", "3", `{"wait":"q-ffffffffffffffff","answer":"Use backoff"}`, "wait_not_found", 404, ownerSession},
		{"unknown TODO", "4", answer, "todo_not_found", 404, ownerSession},
	} {
		t.Run(tc.name, func(t *testing.T) {
			status, envelope := call(http.MethodPost, "/api/todos/"+tc.path+"/answer", tc.body, tc.info)
			require.Equal(t, tc.status, status, envelope)
			require.Equal(t, tc.code, envelope["code"])
		})
	}
	require.Empty(t, signals.sent(), "no refusal signals the run")

	status, envelope := call(http.MethodPost, "/api/todos/3/answer", answer, ownerSession)
	require.Equal(t, 202, status, envelope)
	require.Equal(t, map[string]any{"state": "accepted"}, envelope)
	status, envelope = call(http.MethodPost, "/api/todos/3/answer", answer, ownerSession)
	require.Equal(t, 202, status, "the same answer again is the same answer")
	status, envelope = call(http.MethodPost, "/api/todos/3/answer", `{"wait":"q-0123456789abcdef","answer":"Use a fixed delay"}`, ownerSession)
	require.Equal(t, 409, status)
	require.Equal(t, map[string]any{"code": "answered", "class": "conflict", "message": "answer-owner answered", "answered_by": "answer-owner"}, envelope)

	sent := signals.sent()
	require.Len(t, sent, 1)
	require.Equal(t, "run-1", sent[0].RunID)
	require.Equal(t, "coding-clarification", sent[0].Name)
	require.JSONEq(t, `"Use backoff"`, string(sent[0].Payload))

	status, card = call(http.MethodGet, "/api/todos/3", "", ownerSession)
	require.Equal(t, 200, status)
	require.Equal(t, "working", card["state"])
	require.Equal(t, []any{}, card["waits"])
	first := card["first_answer"].(map[string]any)
	require.Equal(t, "Use backoff", first["text"])
	require.Equal(t, map[string]any{"kind": "person", "login": "answer-owner", "name": "Answer Owner", "avatar_url": first["by"].(map[string]any)["avatar_url"], "color_index": float64(0)}, first["by"])
	stored, err := q.GetMythicalItem(ctx, pgtype.UUID{Bytes: item.ID.Bytes, Valid: true})
	require.NoError(t, err)
	require.Equal(t, "running", stored.State, "an answer changes only the question")
}
