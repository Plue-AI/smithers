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

// Every TODO route with the production handler and service on real
// PostgreSQL, for each role on the install's roster (mvp.md §6.15, M-05):
// the owner, a Maintainer (collaborators admin), a Member (write), a person
// off the roster, a suspended member and a removed one, plus a token. Members
// read, create and answer; only the owner and maintainers get past Merge's
// authorization; nobody else gets past any route's.
func TestTodoRoutesAuthorizeByRole(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx := context.Background()
	q := db.New(pool)
	person := func(login string) int64 {
		var id int64
		require.NoError(t, pool.QueryRow(ctx, `INSERT INTO users(username,lower_username,display_name) VALUES ($1,$2,$3) RETURNING id`, login, login, strings.ToUpper(login[:1])+login[1:]).Scan(&id))
		return id
	}
	owner, ben, alice, carol, dave, erin := person("maya"), person("ben"), person("alice"), person("carol"), person("dave"), person("erin")
	var repo int64
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO repositories(user_id,name,lower_name) VALUES ($1,'app','app') RETURNING id`, owner).Scan(&repo))
	_, err := pool.Exec(ctx, `INSERT INTO self_host_owners(singleton,user_id) VALUES (true,$1)`, owner)
	require.NoError(t, err)
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "github.repository", Value: []byte(fmt.Sprintf(`{"owner_login":"maya","repository_name":"app","repository_id":%d}`, repo))}))
	roster := []struct {
		user       int64
		permission string
		suspended  bool
	}{{owner, "admin", false}, {ben, "admin", false}, {alice, "write", false}, {dave, "write", true}, {erin, "write", false}}
	for _, row := range roster {
		_, err = pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission,suspended_at) VALUES ($1,$2,$3,CASE WHEN $4::boolean THEN now() END)`, repo, row.user, row.permission, row.suspended)
		require.NoError(t, err)
	}
	// Erin was removed: barred from signing in, as Members.Remove leaves her.
	_, err = pool.Exec(ctx, `UPDATE users SET prohibit_login=true WHERE id=$1`, erin)
	require.NoError(t, err)
	_, err = q.RequestMythicalBootstrap(ctx, repo, owner, 1, false)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE mythical_stacks SET state='active' WHERE repository_id=$1`, repo)
	require.NoError(t, err)
	checks := `{"todo":true,"run_launched":true,"run_attached":true,"waits":[{"id":"q-0123456789abcdef","kind":"question","prompt":"Backoff or a fixed delay?","since":"2026-10-05T08:00:00Z",
		"signal":{"scope":{"TenantID":"repository:1","PrincipalID":"user:1"},"target":{"TenantID":"repository:1","PrincipalID":"user:1","WorkspaceID":"w-1","BindingKind":"mythical-item","BindingID":"i-1"},"flow":"todo","run":"run-1","name":"coding-clarification"}}]}`
	item, _, err := q.InsertMythicalItem(ctx, db.MythicalItem{RepositoryID: repo, State: "running", Checks: []byte(checks)})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE mythical_items SET source='todo', number=3, request_run_id='run-1', attempt=1, title='Retry webhooks', owner_id=$2 WHERE id=$1`, item.ID, owner)
	require.NoError(t, err)

	service := services.NewMythicalService(pool, nil)
	signals := &answerSignals{}
	service.SetLauncher(signals)
	handler := &TodoHandler{Queries: q, Service: service}
	router := chi.NewRouter()
	router.Get("/api/todos", handler.List)
	router.Get("/api/todos/{n}", handler.Get)
	router.Post("/api/todos", handler.Create)
	router.Post("/api/todos/{n}", handler.Control)
	router.Patch("/api/todos/{n}", handler.Amend)
	router.Post("/api/todos/{n}/answer", handler.Answer)
	router.Post("/api/todos/{n}/merge", handler.Merge)
	// Each person holds a live browser session; Merge reads it back.
	session := func(user int64, login string) *middleware.AuthInfo {
		digest := sha256.Sum256([]byte(login + "-cookie"))
		key := hex.EncodeToString(digest[:])
		_, err := q.CreateAuthSession(ctx, db.CreateAuthSessionParams{UserID: user, Username: login, SessionKey: key, ExpiresAt: time.Now().Add(time.Hour)})
		require.NoError(t, err)
		return &middleware.AuthInfo{User: &db.User{ID: user, Username: login}, SessionHash: key}
	}
	sessions := map[string]*middleware.AuthInfo{"owner": session(owner, "maya"), "maintainer": session(ben, "ben"), "member": session(alice, "alice"),
		"off roster": session(carol, "carol"), "suspended": session(dave, "dave"), "removed": session(erin, "erin"),
		"token": {User: &db.User{ID: alice}, IsTokenAuth: true, TokenSource: middleware.TokenSourcePersonalAccessToken}}
	call := func(method, path, body, key string, info *middleware.AuthInfo) (int, map[string]any) {
		t.Helper()
		req := httptest.NewRequest(method, path, strings.NewReader(body))
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
	head := strings.Repeat("a", 40)
	// Merge of an unknown TODO: past authorization it is 404 todo_not_found,
	// read only after the approver's standing is checked.
	for _, tc := range []struct {
		who                   string
		list, read, create    int
		merge                 int
		mergeCode, createCode string
	}{
		{"owner", 200, 200, 202, 404, "todo_not_found", ""},
		{"maintainer", 200, 200, 202, 404, "todo_not_found", ""},
		{"member", 200, 200, 202, 403, "permission", ""},
		{"off roster", 403, 403, 403, 403, "permission", "permission"},
		{"suspended", 403, 403, 403, 403, "permission", "permission"},
		{"removed", 403, 403, 403, 403, "permission", "permission"},
		{"token", 403, 403, 403, 403, "permission", "permission"},
	} {
		t.Run(tc.who, func(t *testing.T) {
			info := sessions[tc.who]
			status, envelope := call(http.MethodGet, "/api/todos", "", "", info)
			require.Equal(t, tc.list, status, envelope)
			status, envelope = call(http.MethodGet, "/api/todos/3", "", "", info)
			require.Equal(t, tc.read, status, envelope)
			status, envelope = call(http.MethodPost, "/api/todos", `{"title":"By `+tc.who+`","prompt":"Add a greeting"}`, "create-"+tc.who, info)
			require.Equal(t, tc.create, status, envelope)
			if tc.createCode != "" {
				require.Equal(t, tc.createCode, envelope["code"])
				require.Equal(t, "permission", envelope["class"])
			}
			status, envelope = call(http.MethodPost, "/api/todos/99/merge", `{"reviewed_head_sha":"`+head+`"}`, "merge-"+tc.who, info)
			require.Equal(t, tc.merge, status, envelope)
			require.Equal(t, tc.mergeCode, envelope["code"])
			status, envelope = call(http.MethodPatch, "/api/todos/3", `{"prompt":"Revised prompt","acceptance":["One check"]}`, "amend-"+tc.who, info)
			if tc.read == http.StatusOK {
				require.Equal(t, http.StatusServiceUnavailable, status)
				require.Equal(t, "todo_control_unavailable", envelope["code"], "unqualified execution remains disabled")
			} else {
				require.Equal(t, http.StatusForbidden, status)
				require.Equal(t, "permission", envelope["code"])
			}
			// Every control, as the app sends it: a person on the roster gets
			// past authorization to the service, which refuses Retry of a
			// working TODO, answers Drop of an unknown TODO 404, refuses Move up
			// of the first one and keeps the controls it has no service for
			// dark; nobody else gets past authorization.
			for _, body := range []string{`{"op":"steer","text":"Keep the max at 5"}`, `{"steer":"Keep the max at 5"}`, `{"op":"stop"}`, `{"op":"resume"}`,
				`{"op":"retry"}`, `{"op":"retry","steer":"Use the retry helper"}`, `{"op":"retry-current-flow"}`, `{"op":"drop"}`, `{"op":"move","direction":"up"}`} {
				path := "/api/todos/3"
				if body == `{"op":"drop"}` {
					path = "/api/todos/99"
				}
				status, envelope = call(http.MethodPost, path, body, "control-"+tc.who, info)
				if tc.list == 200 && strings.HasPrefix(body, `{"op":"retry"`) {
					require.Equal(t, http.StatusConflict, status, body)
					require.Equal(t, map[string]any{"code": "conflict", "class": "conflict", "message": "TODO has not failed"}, envelope, body)
				} else if tc.list == 200 && body == `{"op":"drop"}` {
					require.Equal(t, http.StatusNotFound, status, body)
					require.Equal(t, "todo_not_found", envelope["code"], body)
				} else if tc.list == 200 && strings.HasPrefix(body, `{"op":"move"`) {
					require.Equal(t, http.StatusConflict, status, body)
					require.Equal(t, map[string]any{"code": "conflict", "class": "conflict", "message": "T3 is already first"}, envelope, body)
				} else if tc.list == 200 {
					require.Equal(t, http.StatusServiceUnavailable, status, body)
					require.Equal(t, map[string]any{"code": "todo_control_unavailable", "class": "infra", "message": "TODO controls are unavailable"}, envelope, body)
				} else {
					require.Equal(t, http.StatusForbidden, status, body)
					require.Equal(t, "permission", envelope["code"], body)
				}
			}
		})
	}
	// A control is read before it is authorized: malformed ones are 400.
	for _, tc := range []struct{ path, body, key, code string }{
		{"0", `{"op":"stop"}`, "key", "invalid_todo"},
		{"9223372036854775808", `{"op":"stop"}`, "key", "invalid_todo"},
		{"3", `{`, "key", "invalid_control"},
		{"3", `{"op":"stop","unexpected":true}`, "key", "invalid_control"},
		{"3", `{"op":"stop"} {}`, "key", "invalid_control"},
		{"3", `{"op":"stop"}`, "", "idempotency_key_required"},
		{"3", `{"op":"cancel"}`, "key", "invalid_control"},
		{"3", `{"op":"drop","steer":"no"}`, "key", "invalid_control"},
		{"3", `{"op":"drop","text":"no"}`, "key", "invalid_control"},
		{"3", `{"op":"steer","steer":"x","text":"x"}`, "key", "invalid_control"},
		{"3", `{"op":"steer"}`, "key", "invalid_steer"},
		{"3", `{"op":"steer","text":" "}`, "key", "invalid_steer"},
		{"3", `{"op":"move"}`, "key", "invalid_control"},
		{"3", `{"op":"move","direction":"left"}`, "key", "invalid_control"},
		{"3", `{"op":"move","direction":"up","steer":"x"}`, "key", "invalid_control"},
		{"3", `{"op":"stop","direction":"up"}`, "key", "invalid_control"},
		{"3", `{}`, "key", "invalid_steer"},
		{"3", `{"steer":"x","via":"smithers"}`, "key", "invalid_control"},
		{"3", strings.Repeat(" ", 64<<10) + `{}`, "key", "invalid_control"},
	} {
		status, envelope := call(http.MethodPost, "/api/todos/"+tc.path, tc.body, tc.key, sessions["member"])
		require.Equal(t, http.StatusBadRequest, status, tc.body[:min(len(tc.body), 100)])
		require.Equal(t, tc.code, envelope["code"], tc.body[:min(len(tc.body), 100)])
	}
	for _, tc := range []struct{ path, body, key, code string }{
		{"0", `{"prompt":"Revised"}`, "key", "invalid_todo"},
		{"3", `{"prompt":"Revised"}`, "", "invalid_idempotency_key"},
		{"3", `{"prompt":"Revised"}`, strings.Repeat("k", 257), "invalid_idempotency_key"},
		{"3", `{`, "key", "invalid_amendment"},
		{"3", `{"prompt":"Revised","acceptance":"check"}`, "key", "invalid_amendment"},
		{"3", `{"prompt":"Revised","actor":1}`, "key", "invalid_amendment"},
		{"3", `{"prompt":"Revised","repository":1}`, "key", "invalid_amendment"},
		{"3", `{"prompt":"Revised","via":"browser"}`, "key", "invalid_amendment"},
		{"3", `{"prompt":"Revised"} {}`, "key", "invalid_amendment"},
		{"3", `{"prompt":" "}`, "key", "invalid_amendment"},
		{"3", strings.Repeat(" ", 256<<10) + `{}`, "key", "invalid_amendment"},
	} {
		status, envelope := call(http.MethodPatch, "/api/todos/"+tc.path, tc.body, tc.key, sessions["member"])
		require.Equal(t, http.StatusBadRequest, status)
		require.Equal(t, tc.code, envelope["code"])
	}
	var amended int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_requests WHERE operation='todo.amended'`).Scan(&amended))
	require.Zero(t, amended, "disabled and refused requests cannot commit amendments")
	// Created TODOs carry their person: the first revision is by Alice.
	var by string
	require.NoError(t, pool.QueryRow(ctx, `SELECT revisions->0->'by'->>'login' FROM mythical_items WHERE title='By member'`).Scan(&by))
	require.Equal(t, "alice", by)
	var created int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM mythical_items WHERE title LIKE 'By %'`).Scan(&created))
	require.Equal(t, 3, created, "only the owner, the maintainer and the member file TODOs")

	// Any member answers; nobody off the roster does; the first answer wins.
	answer := `{"wait":"q-0123456789abcdef","answer":"Use backoff"}`
	for _, who := range []string{"off roster", "suspended", "removed", "token"} {
		status, envelope := call(http.MethodPost, "/api/todos/3/answer", answer, "", sessions[who])
		require.Equal(t, http.StatusForbidden, status, who)
		require.Equal(t, "permission", envelope["code"], who)
	}
	require.Empty(t, signals.sent(), "no refusal signals the run")
	status, envelope := call(http.MethodPost, "/api/todos/3/answer", answer, "", sessions["member"])
	require.Equal(t, http.StatusAccepted, status, envelope)
	status, envelope = call(http.MethodPost, "/api/todos/3/answer", `{"wait":"q-0123456789abcdef","answer":"Use a fixed delay"}`, "", sessions["maintainer"])
	require.Equal(t, http.StatusConflict, status, envelope)
	require.Equal(t, "alice", envelope["answered_by"])
	require.Len(t, signals.sent(), 1)

	// Any member drops a TODO (§6.15); the same press again is the same drop,
	// and another press on the dropped TODO is 409.
	status, envelope = call(http.MethodPost, "/api/todos/3", `{"op":"drop"}`, "drop-alice", sessions["member"])
	require.Equal(t, http.StatusAccepted, status, envelope)
	require.Equal(t, map[string]any{"state": "accepted"}, envelope)
	status, envelope = call(http.MethodPost, "/api/todos/3", `{"op":"drop"}`, "drop-alice", sessions["member"])
	require.Equal(t, http.StatusAccepted, status, envelope)
	status, envelope = call(http.MethodPost, "/api/todos/3", `{"op":"drop"}`, "drop-ben", sessions["maintainer"])
	require.Equal(t, http.StatusConflict, status, envelope)
	require.Equal(t, "TODO is settled", envelope["message"])
	status, envelope = call(http.MethodGet, "/api/todos/3", "", "", sessions["owner"])
	require.Equal(t, http.StatusOK, status, envelope)
	require.Equal(t, "dropped", envelope["state"])

	// A member removed now is refused on the very next request.
	_, err = pool.Exec(ctx, `UPDATE collaborators SET suspended_at=now() WHERE user_id=$1`, alice)
	require.NoError(t, err)
	status, _ = call(http.MethodGet, "/api/todos", "", "", sessions["member"])
	require.Equal(t, http.StatusForbidden, status)
}
