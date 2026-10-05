package compose

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
)

// todoCalls records what reached the TODO service, and as whom.
type todoCalls struct {
	mu    sync.Mutex
	calls []string
}

func (c *todoCalls) record(format string, args ...any) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.calls = append(c.calls, fmt.Sprintf(format, args...))
}

func (c *todoCalls) take() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	calls := c.calls
	c.calls = nil
	return calls
}

func (c *todoCalls) FileTodo(_ context.Context, _, user int64, input services.MythicalTodoInput) (services.MythicalItemView, error) {
	c.record("file %d %s", user, input.Title)
	return services.MythicalItemView{Number: 9}, nil
}
func (c *todoCalls) Todo(context.Context, int64, int64) (map[string]any, error) {
	return map[string]any{}, nil
}
func (c *todoCalls) Todos(context.Context, int64) ([]map[string]any, error) { return nil, nil }
func (c *todoCalls) MergeTodo(_ context.Context, _, user, n int64, _ services.MythicalMergeInput) (services.MythicalItemView, error) {
	c.record("merge %d T%d", user, n)
	return services.MythicalItemView{}, nil
}
func (c *todoCalls) AnswerTodo(_ context.Context, _, user, n int64, input services.TodoAnswerInput) error {
	c.record("answer %d T%d %s", user, n, input.Answer)
	return nil
}
func (c *todoCalls) ControlTodo(_ context.Context, n int64, input services.TodoControlInput) (services.TodoControlReceipt, error) {
	c.record("control %d T%d %q", input.Actor, n, input.Op)
	return services.TodoControlReceipt{State: "requested"}, nil
}
func (c *todoCalls) AmendTodo(_ context.Context, n int64, input services.TodoAmendInput) (services.TodoAmendReceipt, error) {
	c.record("amend %d T%d %s", input.Actor, n, input.Prompt)
	return services.TodoAmendReceipt{State: "accepted", N: n, Rev: 2}, nil
}

// J6 3b and the scope refusals (T-ACC-04, spec §5.3.2a and §8.11.1) through
// the production auth loader, member boundary, memberCommands and TODO
// handler on real PostgreSQL: a stage-1 terminal's delegated credential, the
// owner's, maintainer Ben's or member Alice's, answers and steers only the
// TODO on its own branch, as its member; its todo.new is 403 confirm_in_app
// with nothing filed; every other TODO action and route is 403 permission;
// forged attribution headers change no decision; and a suspended member's
// terminal is refused like their browser.
func TestTerminalCredentialTodoActionsPostgres(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx := t.Context()
	q := db.New(pool)
	user := func(login string) db.User {
		u, err := q.CreateUser(ctx, db.CreateUserParams{Username: login, LowerUsername: login, DisplayName: login})
		require.NoError(t, err)
		return u
	}
	owner, ben, alice := user("maya"), user("ben"), user("alice")
	_, err := pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, owner.ID)
	require.NoError(t, err)
	repo, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: owner.ID, Valid: true}, Name: "demo", LowerName: "demo", DefaultBookmark: "main"})
	require.NoError(t, err)
	binding := fmt.Sprintf(`{"owner_login":"maya","repository_name":"demo","repository_id":%d}`, repo.ID)
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "github.repository", Value: []byte(binding)}))
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "owner.access", Value: []byte(binding[:len(binding)-1] + `,"last_access_check_at":"2026-10-05T10:00:00Z"}`)}))
	for _, row := range []struct {
		user       db.User
		permission string
	}{{owner, "admin"}, {ben, "admin"}, {alice, "write"}} {
		_, err = pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,$3)`, repo.ID, row.user.ID, row.permission)
		require.NoError(t, err)
	}
	// T1 and T2 each work on a branch of their own; T3 has none yet.
	branches := []string{"5a1b0000-0000-4000-8000-0000000000b1", "5a1b0000-0000-4000-8000-0000000000b2", ""}
	for _, branch := range branches {
		_, err = pool.Exec(ctx, `INSERT INTO mythical_items(repository_id, source, workspace_id) VALUES($1, 'todo', $2)`, repo.ID, branch)
		require.NoError(t, err)
	}
	// A terminal's credential as signInWorkspaceTerminal mints it.
	minted := 0
	terminal := func(u db.User, branch string) string {
		minted++
		raw := fmt.Sprintf("smithers_%040x", 0x7e000+minted)
		sum := sha256.Sum256([]byte(raw))
		hash := hex.EncodeToString(sum[:])
		scopes := strings.Join(append([]string{"read:repository", "read:user", middleware.RepositoryRestrictionScope(repo.ID)},
			middleware.DelegationScopes(middleware.Delegation{Via: "terminal", Branch: branch, Profile: middleware.TerminalProfileS1, Session: u.Username + "-session"})...), ",")
		_, err := q.CreateAccessToken(ctx, db.CreateAccessTokenParams{UserID: u.ID, Name: fmt.Sprintf("terminal-session-%d", minted), TokenHash: hash, TokenLastEight: hash[len(hash)-8:],
			Scopes: scopes, SystemIssued: true, ExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(time.Hour), Valid: true}})
		require.NoError(t, err)
		return raw
	}
	session := func(u db.User) string {
		key := u.Username + "-cookie"
		digest := sha256.Sum256([]byte(key))
		_, err := q.CreateAuthSession(ctx, db.CreateAuthSessionParams{UserID: u.ID, Username: u.Username, SessionKey: hex.EncodeToString(digest[:]), ExpiresAt: time.Now().Add(time.Hour)})
		require.NoError(t, err)
		return key
	}
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Auth.SessionCookieName = "session"
	calls := &todoCalls{}
	todos := &routes.TodoHandler{Queries: q, Service: calls}
	router := chi.NewRouter()
	router.Use(authLoader(q, cfg.Auth))
	router.Use(memberCommands(q))
	router.Post("/api/todos", todos.Create)
	router.Get("/api/todos/{n}", todos.Get)
	router.Post("/api/todos/{n}", todos.Control)
	router.Patch("/api/todos/{n}", todos.Amend)
	router.Post("/api/todos/{n}/answer", todos.Answer)
	router.Post("/api/todos/{n}/merge", todos.Merge)
	served := func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) }
	for _, route := range []struct{ method, path string }{{"GET", "/api/user"}, {"GET", "/api/repos/maya/demo/wiki"}, {"GET", "/api/install"},
		{"GET", "/api/members"}, {"POST", "/api/members"}, {"POST", "/api/agent/turn"}, {"POST", "/api/repos/maya/demo/workspace/sessions"}} {
		router.MethodFunc(route.method, route.path, served)
	}
	call := func(method, path, body string, header http.Header) (int, map[string]any) {
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		req.Header = header.Clone()
		req.Header.Set("Content-Type", "application/json")
		res := httptest.NewRecorder()
		router.ServeHTTP(res, req)
		var envelope map[string]any
		_ = json.Unmarshal(res.Body.Bytes(), &envelope)
		return res.Code, envelope
	}
	bearer := func(token string) http.Header {
		return http.Header{"Authorization": {"Bearer " + token}, "Idempotency-Key": {"k-" + token[len(token)-6:]}, "Smithers-Via": {"claude-code"}}
	}
	permission := map[string]any{"class": "permission", "code": "permission", "message": "A terminal's credential cannot do this"}
	otherBranch := map[string]any{"class": "permission", "code": "permission", "message": "A terminal acts only on its own branch's TODO"}
	confirm := map[string]any{"class": "permission", "code": "confirm_in_app", "message": "Confirm in the app"}
	answer := `{"wait":"q-0123456789abcdef","answer":"Use backoff"}`
	steer := `{"op":"steer","text":"use the retry helper"}`
	for _, holder := range []db.User{owner, ben, alice} {
		t.Run(holder.Username, func(t *testing.T) {
			// The terminal is on T2's branch.
			header := bearer(terminal(holder, branches[1]))
			for _, admitted := range []struct{ method, path, body, call string }{
				{"GET", "/api/user", "", ""},
				{"GET", "/api/todos/1", "", ""},
				{"GET", "/api/repos/maya/demo/wiki", "", ""},
				{"POST", "/api/todos/2/answer", answer, fmt.Sprintf("answer %d T2 Use backoff", holder.ID)},
				{"POST", "/api/todos/2", steer, fmt.Sprintf(`control %d T2 ""`, holder.ID)},
			} {
				status, envelope := call(admitted.method, admitted.path, admitted.body, header)
				require.Contains(t, []int{http.StatusOK, http.StatusAccepted}, status, "%s %s %v", admitted.method, admitted.path, envelope)
				var want []string
				if admitted.call != "" {
					want = []string{admitted.call}
				}
				require.Equal(t, want, calls.take(), "%s %s", admitted.method, admitted.path)
			}
			for _, refused := range []struct {
				method, path, body string
				envelope           map[string]any
			}{
				// Another branch's TODO, and a TODO with no branch or none at all.
				{"POST", "/api/todos/1/answer", answer, otherBranch},
				{"POST", "/api/todos/1", steer, otherBranch},
				{"POST", "/api/todos/3/answer", answer, otherBranch},
				{"POST", "/api/todos/40", steer, otherBranch},
				// Its own TODO's other controls, and Merge.
				{"POST", "/api/todos/2", `{"op":"drop"}`, permission},
				{"POST", "/api/todos/2", `{"op":"stop"}`, permission},
				{"POST", "/api/todos/2", `{"op":"retry","steer":"again"}`, permission},
				{"POST", "/api/todos/2/merge", `{"reviewed_head_sha":"` + strings.Repeat("a", 40) + `"}`, permission},
				// Amend is the person's, confirmed in the app for a delegated caller.
				{"PATCH", "/api/todos/2", `{"prompt":"Also log each retry."}`, permission},
				// A delegated TODO is confirmed in the app, which S1 does not serve.
				{"POST", "/api/todos", `{"title":"Follow-up","prompt":"Add a farewell","place":{"mode":"append"}}`, confirm},
				// Routes outside the profile.
				{"GET", "/api/install", "", permission},
				{"GET", "/api/members", "", permission},
				{"POST", "/api/members", `{"login":"carol"}`, permission},
				{"POST", "/api/agent/turn", `{}`, permission},
				// The owner's alone: the member boundary refuses a member first.
				{"POST", "/api/repos/maya/demo/workspace/sessions", `{}`, permission},
			} {
				status, envelope := call(refused.method, refused.path, refused.body, header)
				require.Equal(t, http.StatusForbidden, status, "%s %s %v", refused.method, refused.path, envelope)
				if holder.ID != owner.ID && refused.path == "/api/repos/maya/demo/workspace/sessions" {
					refused.envelope = envelope
					require.Equal(t, "credential does not belong to the installation owner", envelope["message"])
				}
				require.Equal(t, refused.envelope, envelope, "%s %s", refused.method, refused.path)
				// Forged attribution and actor headers change no decision.
				forged := header.Clone()
				for name, value := range map[string]string{"Smithers-Via": "browser", "Smithers-Actor": "maya", "Smithers-Profile": "full", "Smithers-Branch": branches[0], "X-Forwarded-User": "maya"} {
					forged.Set(name, value)
				}
				status, envelope = call(refused.method, refused.path, refused.body, forged)
				require.Equal(t, http.StatusForbidden, status, "forged %s %s %v", refused.method, refused.path, envelope)
				require.Equal(t, refused.envelope, envelope, "forged %s %s", refused.method, refused.path)
				require.Empty(t, calls.take(), "%s %s reached the service", refused.method, refused.path)
			}
		})
	}
	// The person's own browser session files a TODO directly; only the
	// delegated credential confirms in the app.
	status, envelope := call("POST", "/api/todos", `{"title":"Follow-up","prompt":"Add a farewell","place":{"mode":"append"}}`,
		http.Header{"Cookie": {"session=" + session(ben)}, "Idempotency-Key": {"ben-browser"}})
	require.Equal(t, http.StatusAccepted, status, "%v", envelope)
	require.Equal(t, []string{fmt.Sprintf("file %d Follow-up", ben.ID)}, calls.take())
	// and amends one as themselves.
	status, envelope = call("PATCH", "/api/todos/2", `{"prompt":"Also log each retry.","acceptance":["retries are logged"]}`,
		http.Header{"Cookie": {"session=" + session(ben)}, "Idempotency-Key": {"ben-amend"}})
	require.Equal(t, http.StatusAccepted, status, "%v", envelope)
	require.Equal(t, map[string]any{"state": "accepted", "n": float64(2), "rev": float64(2)}, envelope)
	require.Equal(t, []string{fmt.Sprintf("amend %d T2 Also log each retry.", ben.ID)}, calls.take())
	// A suspended member's terminal is refused like their browser.
	_, err = pool.Exec(ctx, `UPDATE collaborators SET suspended_at=now() WHERE user_id=$1`, alice.ID)
	require.NoError(t, err)
	status, _ = call("POST", "/api/todos/2/answer", answer, bearer(terminal(alice, branches[1])))
	require.Equal(t, http.StatusForbidden, status)
	require.Empty(t, calls.take())
}
