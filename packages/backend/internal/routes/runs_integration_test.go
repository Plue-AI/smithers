package routes

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

func TestRunsHTTPRoleDismissAndReload(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	q := db.New(pool)
	ctx := context.Background()
	person := func(login string) int64 {
		var id int64
		require.NoError(t, pool.QueryRow(ctx, `INSERT INTO users(username,lower_username) VALUES($1,$1) RETURNING id`, login).Scan(&id))
		return id
	}
	owner, maintainer, member, stranger := person("maya"), person("ben"), person("alice"), person("carol")
	var repo int64
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO repositories(user_id,name,lower_name) VALUES($1,'app','app') RETURNING id`, owner).Scan(&repo))
	_, err := pool.Exec(ctx, `INSERT INTO self_host_owners(singleton,user_id) VALUES(true,$1)`, owner)
	require.NoError(t, err)
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "github.repository", Value: []byte(`{"owner_login":"maya","repository_name":"app"}`)}))
	for user, permission := range map[int64]string{maintainer: "admin", member: "write"} {
		_, err = pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,$3)`, repo, user, permission)
		require.NoError(t, err)
	}
	_, err = q.EnsureFlowLoad(ctx, repo)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE flow_loads SET generation=3,state='idle',attempt=3,error='import failed' WHERE repository_id=$1`, repo)
	require.NoError(t, err)
	mythical := services.NewMythicalService(pool, nil)
	mythical.SetFlowLoad(true)
	h := &RunsHandler{Queries: q, Service: &services.BackgroundRunService{Queries: q, Mythical: mythical}}
	router := chi.NewRouter()
	router.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			user, _ := strconv.ParseInt(r.Header.Get("Test-Person"), 10, 64)
			if user > 0 {
				info := &middleware.AuthInfo{User: &db.User{ID: user}, SessionHash: "test-browser-session"}
				if r.Header.Get("Test-Token") == "yes" {
					info.IsTokenAuth = true
				}
				r = r.WithContext(middleware.ContextWithAuthInfo(r.Context(), info))
			}
			next.ServeHTTP(w, r)
		})
	})
	router.Get("/api/runs", h.List)
	router.Get("/api/runs/{id}", h.Get)
	router.Post("/api/runs/{id}", h.Control)
	server := httptest.NewServer(router)
	defer server.Close()
	call := func(user int64, method, path, body string, token bool) (int, string) {
		t.Helper()
		req, err := http.NewRequest(method, server.URL+path, strings.NewReader(body))
		require.NoError(t, err)
		req.Header.Set("Test-Person", fmt.Sprint(user))
		if token {
			req.Header.Set("Test-Token", "yes")
		}
		resp, err := server.Client().Do(req)
		require.NoError(t, err)
		defer resp.Body.Close()
		data, err := io.ReadAll(resp.Body)
		require.NoError(t, err)
		return resp.StatusCode, string(data)
	}
	for _, user := range []int64{owner, maintainer, member} {
		code, body := call(user, "GET", "/api/runs", "", false)
		require.Equal(t, 200, code, body)
		require.Contains(t, body, "flow-load:3")
	}
	for _, op := range []string{"retry", "dismiss"} {
		for _, user := range []int64{member, stranger} {
			code, body := call(user, "POST", "/api/runs/flow-load:3", `{"op":"`+op+`"}`, false)
			require.Equal(t, 403, code, body)
		}
	}
	code, body := call(owner, "POST", "/api/runs/flow-load:3", `{"op":"retry"}`, true)
	require.Equal(t, 403, code, body)
	code, body = call(maintainer, "POST", "/api/runs/flow-load:3", `{"op":"dismiss"}`, false)
	require.Equal(t, 202, code, body)
	code, body = call(owner, "POST", "/api/runs/flow-load:3", `{"op":"dismiss"}`, false)
	require.Equal(t, 202, code, body)
	var by int64
	var at bool
	require.NoError(t, pool.QueryRow(ctx, `SELECT dismissed_by,dismissed_at IS NOT NULL FROM flow_loads WHERE repository_id=$1`, repo).Scan(&by, &at))
	require.Equal(t, maintainer, by)
	require.True(t, at)
	for _, user := range []int64{owner, maintainer, member} {
		code, body := call(user, "GET", "/api/runs", "", false)
		require.Equal(t, 200, code, body)
		require.JSONEq(t, `[]`, body)
	}
	code, body = call(owner, "POST", "/api/runs/flow-load:3", `{"op":"retry"}`, false)
	require.Equal(t, 409, code, body)
	code, body = call(owner, "POST", "/api/runs/flow-load:2", `{"op":"dismiss"}`, false)
	require.Equal(t, 409, code, body)
	code, body = call(owner, "GET", "/api/runs/flow-load:2", "", false)
	require.Equal(t, 404, code, body)
	// Retry on a new failure persists one receipt despite duplicate requests.
	_, err = pool.Exec(ctx, `UPDATE flow_loads SET generation=4 WHERE repository_id=$1`, repo)
	require.NoError(t, err)
	for range 2 {
		code, body = call(owner, "POST", "/api/runs/flow-load:4", `{"op":"retry"}`, false)
		require.Equal(t, 202, code, body)
	}
	code, body = call(member, "GET", "/api/runs/flow-load:4", "", false)
	require.Equal(t, 200, code, body)
	require.Contains(t, body, "queued")
}
