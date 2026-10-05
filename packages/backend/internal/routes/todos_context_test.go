package routes

import (
	"context"
	"encoding/json"
	"fmt"
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

func TestTodoCreateQuotedContextHTTP(t *testing.T) {
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

	quoted := "--- a/flows/todo/flow.ts\n+++ b/flows/todo/flow.ts\n+make test"
	value := map[string]any{"title": "Flow edit", "prompt": "Change flows/todo/flow.ts: make test", "context": quoted}
	encoded, err := json.Marshal(value)
	require.NoError(t, err)
	for range 2 {
		status, envelope := post(string(encoded), "quoted")
		require.Equal(t, http.StatusAccepted, status, envelope)
		require.Equal(t, float64(1), envelope["n"])
	}
	item, err := q.GetMythicalItemByNumber(ctx, repo, 1)
	require.NoError(t, err)
	var revisions []map[string]any
	require.NoError(t, json.Unmarshal(item.Revisions, &revisions))
	require.Equal(t, quoted, revisions[0]["context"])
	value["context"] = quoted + "\n+different"
	encoded, err = json.Marshal(value)
	require.NoError(t, err)
	status, envelope := post(string(encoded), "quoted")
	require.Equal(t, 409, status, envelope)
	require.Equal(t, "idempotency_mismatch", envelope["code"])
	for i, bad := range []string{`{"title":"x","prompt":"x","context":1}`, `{"title":"x","prompt":"x","seed_patch":"bad"}`, `{"title":"x","prompt":"x","context":"x"} {}`} {
		status, _ = post(bad, fmt.Sprint("bad", i))
		require.Equal(t, 400, status)
	}
	value["context"] = strings.Repeat("x", 32769)
	encoded, err = json.Marshal(value)
	require.NoError(t, err)
	status, _ = post(string(encoded), "large")
	require.Equal(t, 400, status)
	var count int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM mythical_items WHERE repository_id=$1`, repo).Scan(&count))
	require.Equal(t, 1, count)
}
