package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

// POST /api/todos takes Make TODO's issue fields through the production
// handler and service with real PostgreSQL. Without GitHub the issue cannot
// be read, so the commit is refused as unavailable and nothing is written;
// a malformed reference is the person's to fix. The admitted TODO itself is
// proved in services (TestTodoFromIssueCommitsTheDraftAsTheIssueTodo).
func TestTodoCreateTakesTheIssueFields(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx := context.Background()
	var owner, repo int64
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO users(username,lower_username) VALUES ('issue-owner','issue-owner') RETURNING id`).Scan(&owner))
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO repositories(user_id,name,lower_name) VALUES ($1,'issue-repo','issue-repo') RETURNING id`, owner).Scan(&repo))
	_, err := pool.Exec(ctx, `INSERT INTO self_host_owners(singleton,user_id) VALUES (true,$1)`, owner)
	require.NoError(t, err)
	q := db.New(pool)
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "github.repository", Value: []byte(`{"owner_login":"issue-owner","repository_name":"issue-repo"}`)}))
	_, err = q.RequestMythicalBootstrap(ctx, repo, owner, 1, false)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE mythical_stacks SET state='active' WHERE repository_id=$1`, repo)
	require.NoError(t, err)
	router := chi.NewRouter()
	router.Post("/api/todos", (&TodoHandler{Queries: q, Service: services.NewMythicalService(pool, nil)}).Create)
	session := &middleware.AuthInfo{User: &db.User{ID: owner}, SessionHash: "browser-session"}
	post := func(body, key string) (int, map[string]any) {
		t.Helper()
		req := httptest.NewRequest(http.MethodPost, "/api/todos", strings.NewReader(body))
		req.Header.Set("Idempotency-Key", key)
		req = req.WithContext(middleware.ContextWithAuthInfo(ctx, session))
		response := httptest.NewRecorder()
		router.ServeHTTP(response, req)
		var envelope map[string]any
		require.NoError(t, json.Unmarshal(response.Body.Bytes(), &envelope), response.Body.String())
		return response.Code, envelope
	}
	digest := strings.Repeat("ab", 32)
	for _, tc := range []struct {
		name, body, code string
		status           int
	}{
		{"issue, digest and fixes", `{"title":"Retry webhooks","prompt":"Retry 5 times","issue":7,"issue_digest":"` + digest + `","fixes":true,"place":{"mode":"append"}}`, "github_unavailable", 503},
		{"issue and digest, fixes absent", `{"title":"Retry webhooks","prompt":"Retry 5 times","issue":7,"issue_digest":"` + digest + `"}`, "github_unavailable", 503},
		{"digest without issue", `{"title":"Retry webhooks","prompt":"Retry 5 times","issue_digest":"` + digest + `"}`, "invalid_todo", 400},
		{"issue without digest", `{"title":"Retry webhooks","prompt":"Retry 5 times","issue":7}`, "invalid_todo", 400},
		{"fixes without issue", `{"title":"Retry webhooks","prompt":"Retry 5 times","fixes":false}`, "invalid_todo", 400},
		{"issue zero", `{"title":"Retry webhooks","prompt":"Retry 5 times","issue":0,"issue_digest":"` + digest + `"}`, "invalid_todo", 400},
		{"issue as text", `{"title":"Retry webhooks","prompt":"Retry 5 times","issue":"7","issue_digest":"` + digest + `"}`, "invalid_todo", 400},
	} {
		t.Run(tc.name, func(t *testing.T) {
			status, envelope := post(tc.body, "key-"+tc.name)
			require.Equal(t, tc.status, status, envelope)
			require.Equal(t, tc.code, envelope["code"])
		})
	}
	var items int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM mythical_items WHERE repository_id=$1`, repo).Scan(&items))
	require.Zero(t, items, "no refused commit files a TODO")
	status, envelope := post(`{"title":"Plain","prompt":"No issue"}`, "plain")
	require.Equal(t, http.StatusAccepted, status, envelope)
	require.Equal(t, map[string]any{"state": "accepted", "n": float64(1), "rev": float64(1)}, envelope)
}
