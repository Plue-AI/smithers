package services_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/smithersai/smithers/packages/backend/db/product"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/smithersai/smithers/packages/backend/testkit/testdb"
	"github.com/stretchr/testify/require"
)

// Replaces the retired CLI/GitHub-issue creation loop with the install HTTP
// boundary. Authentication is injected at its middleware boundary; owner,
// repository binding, transactions, numbering and replay use real PostgreSQL.
func TestTodoInstallHTTPRealPostgres(t *testing.T) {
	ctx := context.Background()
	database := testdb.New(t)
	pool, err := postgresfixture.Open(ctx, database.URL, 0)
	require.NoError(t, err)
	defer pool.Close()
	require.NoError(t, product.Apply(ctx, pool))
	_, err = pool.Exec(ctx, `INSERT INTO users(id,username,lower_username) VALUES(9001,'owner','owner'),(9002,'other','other');
 INSERT INTO self_host_owners(singleton,user_id) VALUES(true,9001);
 INSERT INTO repositories(id,user_id,name,lower_name) VALUES(9001,9001,'repo','repo');
 INSERT INTO install_settings(key,value) VALUES('github.repository','{"owner_login":"owner","repository_name":"repo"}');
 INSERT INTO mythical_stacks(repository_id,actor_user_id,state) VALUES(9001,9001,'active');`)
	require.NoError(t, err)
	service := services.NewMythicalService(pool, nil)
	handler := &routes.TodoHandler{Queries: db.New(pool), Service: service}
	router := chi.NewRouter()
	router.Post("/api/todos", handler.Create)
	router.Get("/api/todos", handler.List)
	router.Get("/api/todos/{n}", handler.Get)
	request := func(method, path, body, key string, info *middleware.AuthInfo) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, path, strings.NewReader(body))
		r.Header.Set("Idempotency-Key", key)
		r = r.WithContext(middleware.ContextWithAuthInfo(r.Context(), info))
		w := httptest.NewRecorder()
		router.ServeHTTP(w, r)
		return w
	}
	owner := &middleware.AuthInfo{User: &db.User{ID: 9001}, SessionHash: "owner-session"}
	for _, info := range []*middleware.AuthInfo{nil, {User: &db.User{ID: 9002}, SessionHash: "other-session"}, {User: &db.User{ID: 9001}, IsTokenAuth: true}, {User: &db.User{ID: 9001}, IsTokenAuth: true, TokenSystemIssued: true}} {
		w := request("POST", "/api/todos", `{"title":"One","prompt":"Change README"}`, "key", info)
		require.Equal(t, http.StatusForbidden, w.Code, w.Body.String())
		require.Contains(t, w.Body.String(), `"class":"permission"`)
	}
	for _, body := range []string{`{}`, `{"title":"One","prompt":"Change README","extra":true}`, `{} {}`} {
		w := request("POST", "/api/todos", body, "key", owner)
		require.Equal(t, 400, w.Code, w.Body.String())
	}
	body := `{"title":"One","prompt":"Change README","place":"append"}`
	w := request("POST", "/api/todos", body, "", owner)
	require.Equal(t, 400, w.Code)
	w = request("POST", "/api/todos", body, "key", owner)
	require.Equal(t, 202, w.Code, w.Body.String())
	require.JSONEq(t, `{"state":"accepted","n":1,"rev":1}`, w.Body.String())
	w = request("POST", "/api/todos", body, "key", owner)
	require.Equal(t, 202, w.Code)
	w = request("POST", "/api/todos", `{"title":"Other","prompt":"Other"}`, "key", owner)
	require.Equal(t, 409, w.Code)
	require.Contains(t, w.Body.String(), "idempotency_mismatch")
	w = request("GET", "/api/todos/1", "", "", owner)
	require.Equal(t, 200, w.Code, w.Body.String())
	var card map[string]any
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &card))
	require.Equal(t, "queued", card["state"])
	require.Equal(t, "One", card["title"])
	require.NotContains(t, card, "branch")
	revisions := card["prompt_revisions"].([]any)
	require.Equal(t, "Change README", revisions[0].(map[string]any)["text"])
	w = request("GET", "/api/todos", "", "", owner)
	require.Equal(t, 200, w.Code)
	var cards []any
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &cards))
	require.Len(t, cards, 1)
	w = request("GET", "/api/todos/2", "", "", owner)
	require.Equal(t, 404, w.Code)
	w = request("GET", "/api/todos/no", "", "", owner)
	require.Equal(t, 400, w.Code)
}
