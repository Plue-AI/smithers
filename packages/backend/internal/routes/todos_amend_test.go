package routes

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
)

// PATCH /api/todos/{n} (Amend Tn, spec §10.2.2; mvp.md J7.1, §6.15) with the
// production handler and service on real PostgreSQL. The owner, a
// Maintainer and a Member each amend a working TODO: each gets the next
// revision, and its text reaches the TODO's live run as one steer message;
// the same press again is the same revision and sends nothing; nobody off
// the roster and no token gets past authorization; malformed requests are
// 400 before authorization; a dropped TODO is 409 todo_closed.
func TestTodoAmendRouteByRole(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx := context.Background()
	q := db.New(pool)
	person := func(login string) int64 {
		var id int64
		require.NoError(t, pool.QueryRow(ctx, `INSERT INTO users(username,lower_username,display_name) VALUES ($1,$2,$3) RETURNING id`, login, login, strings.ToUpper(login[:1])+login[1:]).Scan(&id))
		return id
	}
	owner, ben, alice, carol := person("maya"), person("ben"), person("alice"), person("carol")
	var repo int64
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO repositories(user_id,name,lower_name) VALUES ($1,'app','app') RETURNING id`, owner).Scan(&repo))
	_, err := pool.Exec(ctx, `INSERT INTO self_host_owners(singleton,user_id) VALUES (true,$1)`, owner)
	require.NoError(t, err)
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "github.repository", Value: []byte(fmt.Sprintf(`{"owner_login":"maya","repository_name":"app","repository_id":%d}`, repo))}))
	for _, row := range []struct {
		user       int64
		permission string
	}{{owner, "admin"}, {ben, "admin"}, {alice, "write"}} {
		_, err = pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission) VALUES ($1,$2,$3)`, repo, row.user, row.permission)
		require.NoError(t, err)
	}
	_, err = q.RequestMythicalBootstrap(ctx, repo, owner, 1, false)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE mythical_stacks SET state='active' WHERE repository_id=$1`, repo)
	require.NoError(t, err)
	// T3 is working: its coding run is attached and live.
	item, _, err := q.InsertMythicalItem(ctx, db.MythicalItem{RepositoryID: repo, State: "running", Checks: []byte(`{"todo":true,"run_launched":true,"run_attached":true}`)})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE mythical_items SET source='todo', number=3, request_run_id='run-1', attempt=1, title='Retry webhooks', owner_id=$2,
		revisions='[{"text":"Retry failed webhooks","acceptance":["a failed webhook is retried"],"by":{"kind":"person","login":"maya","name":"Maya","avatar_url":"","color_index":0},"at":"2026-10-05T08:00:00Z"}]'
		WHERE id=$1`, item.ID, owner)
	require.NoError(t, err)

	service := services.NewMythicalService(pool, nil)
	signals := &answerSignals{}
	service.SetLauncher(signals)
	handler := &TodoHandler{Queries: q, Service: service}
	router := chi.NewRouter()
	router.Get("/api/todos/{n}", handler.Get)
	router.Patch("/api/todos/{n}", handler.Amend)
	session := func(user int64, login string) *middleware.AuthInfo {
		digest := sha256.Sum256([]byte(login + "-cookie"))
		key := hex.EncodeToString(digest[:])
		_, err := q.CreateAuthSession(ctx, db.CreateAuthSessionParams{UserID: user, Username: login, SessionKey: key, ExpiresAt: time.Now().Add(time.Hour)})
		require.NoError(t, err)
		return &middleware.AuthInfo{User: &db.User{ID: user, Username: login}, SessionHash: key}
	}
	sessions := map[string]*middleware.AuthInfo{"owner": session(owner, "maya"), "maintainer": session(ben, "ben"), "member": session(alice, "alice"),
		"off roster": session(carol, "carol"), "token": {User: &db.User{ID: alice}, IsTokenAuth: true, TokenSource: middleware.TokenSourcePersonalAccessToken}}
	call := func(method, path, body, key string, info *middleware.AuthInfo) (int, map[string]any) {
		t.Helper()
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		if key != "" {
			req.Header.Set("Idempotency-Key", key)
		}
		req = req.WithContext(middleware.ContextWithAuthInfo(ctx, info))
		response := httptest.NewRecorder()
		router.ServeHTTP(response, req)
		var envelope map[string]any
		_ = json.Unmarshal(response.Body.Bytes(), &envelope)
		return response.Code, envelope
	}
	amendment := func(who string) string {
		return `{"prompt":"Also log each retry (` + who + `)","acceptance":["each retry is logged"]}`
	}

	rev := 1
	for _, who := range []string{"owner", "maintainer", "member", "off roster", "token"} {
		status, envelope := call(http.MethodPatch, "/api/todos/3", amendment(who), "amend-"+who, sessions[who])
		if who == "off roster" || who == "token" {
			require.Equal(t, http.StatusForbidden, status, who)
			require.Equal(t, "permission", envelope["code"], who)
			continue
		}
		rev++
		require.Equal(t, http.StatusAccepted, status, "%s %v", who, envelope)
		require.Equal(t, map[string]any{"state": "accepted", "n": float64(3), "rev": float64(rev)}, envelope, who)
	}
	// The same press again is the same revision; another amendment under its key is 409.
	status, envelope := call(http.MethodPatch, "/api/todos/3", amendment("member"), "amend-member", sessions["member"])
	require.Equal(t, http.StatusAccepted, status, envelope)
	require.Equal(t, float64(4), envelope["rev"])
	status, envelope = call(http.MethodPatch, "/api/todos/3", amendment("someone else"), "amend-member", sessions["member"])
	require.Equal(t, http.StatusConflict, status, envelope)
	require.Equal(t, "idempotency_mismatch", envelope["code"])

	sent := signals.sent()
	require.Len(t, sent, 3, "one steer message per amendment")
	for i, who := range []string{"owner", "maintainer", "member"} {
		require.Equal(t, "run-1", sent[i].RunID)
		require.Equal(t, fmt.Sprintf("Amendment (revision %d):\nAlso log each retry (%s)\n\nAcceptance:\n- each retry is logged", i+2, who), sent[i].Steer.Body)
	}
	status, card := call(http.MethodGet, "/api/todos/3", "", "", sessions["member"])
	require.Equal(t, http.StatusOK, status, card)
	revisions := card["prompt_revisions"].([]any)
	require.Len(t, revisions, 4)
	require.Equal(t, "Retry failed webhooks", revisions[0].(map[string]any)["text"])
	last := revisions[3].(map[string]any)
	require.Equal(t, "amend", last["reason"])
	require.Equal(t, float64(4), last["n"])
	require.Equal(t, "alice", last["by"].(map[string]any)["login"])
	require.Empty(t, card["steers"])
	require.Equal(t, "working", card["state"])
	var items int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM mythical_items WHERE repository_id=$1`, repo).Scan(&items))
	require.Equal(t, 1, items, "Amend makes no TODO")

	// An amendment is read before it is authorized: malformed ones are 400.
	for _, tc := range []struct{ path, body, key, code string }{
		{"0", `{"prompt":"x"}`, "key", "invalid_todo"},
		{"x", `{"prompt":"x"}`, "key", "invalid_todo"},
		{"3", `{`, "key", "invalid_amendment"},
		{"3", `{"prompt":"x","title":"Renamed"}`, "key", "invalid_amendment"},
		{"3", `{"prompt":"x"} {}`, "key", "invalid_amendment"},
		{"3", `{"prompt":"x","acceptance":"one line"}`, "key", "invalid_amendment"},
		{"3", strings.Repeat(" ", 128<<10) + `{"prompt":"x"}`, "key", "invalid_amendment"},
		{"3", `{"prompt":"x"}`, "", "idempotency_key_required"},
		{"3", `{"prompt":" "}`, "key", "invalid_amendment"},
		{"3", `{"prompt":"x","acceptance":[""]}`, "key", "invalid_amendment"},
		{"3", `{"prompt":"` + strings.Repeat("x", 24<<10+1) + `"}`, "key", "invalid_amendment"},
	} {
		status, envelope := call(http.MethodPatch, "/api/todos/"+tc.path, tc.body, tc.key, sessions["member"])
		require.Equal(t, http.StatusBadRequest, status, tc.body[:min(len(tc.body), 100)])
		require.Equal(t, tc.code, envelope["code"], tc.body[:min(len(tc.body), 100)])
	}
	status, envelope = call(http.MethodPatch, "/api/todos/99", `{"prompt":"x"}`, "amend-missing", sessions["member"])
	require.Equal(t, http.StatusNotFound, status, envelope)
	require.Equal(t, "todo_not_found", envelope["code"])
	_, err = pool.Exec(ctx, `UPDATE mythical_items SET state='cancelled' WHERE id=$1`, item.ID)
	require.NoError(t, err)
	status, envelope = call(http.MethodPatch, "/api/todos/3", `{"prompt":"too late"}`, "amend-dropped", sessions["owner"])
	require.Equal(t, http.StatusConflict, status, envelope)
	require.Equal(t, map[string]any{"code": "todo_closed", "class": "conflict", "message": "TODO is closed"}, envelope)
	require.Len(t, signals.sent(), 3, "no refusal signals the run")
}
