package routes

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/db/product"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/smithersai/smithers/packages/backend/testkit/testdb"
)

// countingTransport counts every outbound HTTP request the process makes
// through the default client while it is installed.
type countingTransport struct {
	next  http.RoundTripper
	calls atomic.Int64
	hosts chan string
}

func (c *countingTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	c.calls.Add(1)
	select {
	case c.hosts <- request.URL.Host:
	default:
	}
	return c.next.RoundTrip(request)
}

// todoRoutesFixture is the TODO routes over real PostgreSQL, mounted with
// the product router's middleware: auth, the repository resolver, the
// repository context and its permission gate.
type todoRoutesFixture struct {
	t      *testing.T
	pool   *pgxpool.Pool
	server *httptest.Server
	userID int64
	repoID int64
}

func newTodoRoutesFixture(t *testing.T) *todoRoutesFixture {
	t.Helper()
	database := testdb.New(t)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	pool, err := postgresfixture.Open(ctx, database.URL, 0)
	require.NoError(t, err)
	t.Cleanup(pool.Close)
	require.NoError(t, product.Apply(ctx, pool))
	f := &todoRoutesFixture{t: t, pool: pool}
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO users(username, lower_username) VALUES ('ben', 'ben') RETURNING id`).Scan(&f.userID))
	_, err = pool.Exec(ctx, `INSERT INTO members(user_id, login, role) VALUES ($1, 'ben', 'owner')`, f.userID)
	require.NoError(t, err)
	f.repoID = f.repository("app")

	queries := db.New(pool)
	todos := &TodoHandler{Service: services.NewMythicalService(pool, nil).Todos()}
	signIn := func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if id, err := strconv.ParseInt(r.Header.Get("X-Test-User"), 10, 64); err == nil {
				user, err := queries.GetUserByID(r.Context(), id)
				require.NoError(t, err)
				r = r.WithContext(middleware.ContextWithAuthInfo(r.Context(), &middleware.AuthInfo{User: &user}))
			}
			next.ServeHTTP(w, r)
		})
	}
	read := []func(http.Handler) http.Handler{middleware.RequireAuth, middleware.RequireScope(middleware.ScopeReadRepository)}
	write := []func(http.Handler) http.Handler{middleware.RequireAuth, middleware.RequireScope(middleware.ScopeWriteRepository)}
	loadRead := []func(http.Handler) http.Handler{middleware.LoadRepoContext(queries), middleware.RequireRepoPermission(middleware.PermissionRead)}
	loadWrite := []func(http.Handler) http.Handler{middleware.LoadRepoContext(queries), middleware.RequireRepoPermission(middleware.PermissionWrite)}
	router := chi.NewRouter()
	router.Use(signIn)
	router.Route("/api", func(r chi.Router) {
		r.With(append(append(read, todos.ResolveStackRepository), loadRead...)...).Get("/todos", todos.List)
		r.With(append(append(write, todos.ResolveStackRepository), loadWrite...)...).Post("/todos", todos.Create)
		r.With(append(append(read, todos.ResolveStackRepository), loadRead...)...).Get("/todos/{n}", todos.Get)
		r.With(append(append(read, todos.ResolveBranchRepository), loadRead...)...).Get("/branches/{b}/activity", todos.BranchActivity)
	})
	f.server = httptest.NewServer(router)
	t.Cleanup(f.server.Close)
	return f
}

func (f *todoRoutesFixture) repository(name string) int64 {
	f.t.Helper()
	var id int64
	require.NoError(f.t, f.pool.QueryRow(context.Background(), `INSERT INTO repositories(user_id, name, lower_name, default_bookmark)
		VALUES ($1, $2, $2, 'main') RETURNING id`, f.userID, name).Scan(&id))
	_, err := f.pool.Exec(context.Background(), `INSERT INTO mythical_stacks(repository_id, actor_user_id, state) VALUES ($1, $2, 'active')`, id, f.userID)
	require.NoError(f.t, err)
	return id
}

// do sends one request as user (0: anonymous) with an optional
// Idempotency-Key, and answers the status and decoded body.
func (f *todoRoutesFixture) do(method, path string, user int64, key, body string) (int, map[string]any) {
	f.t.Helper()
	request, err := http.NewRequest(method, f.server.URL+path, strings.NewReader(body))
	require.NoError(f.t, err)
	if user != 0 {
		request.Header.Set("X-Test-User", strconv.FormatInt(user, 10))
	}
	if key != "" {
		request.Header.Set("Idempotency-Key", key)
	}
	request.Header.Set("Content-Type", "application/json")
	// The test's own requests go around the counted default transport.
	response, err := (&http.Client{Transport: &http.Transport{}}).Do(request)
	require.NoError(f.t, err)
	defer func() { _ = response.Body.Close() }()
	raw, err := io.ReadAll(response.Body)
	require.NoError(f.t, err)
	var decoded map[string]any
	if len(raw) > 0 {
		require.NoError(f.t, json.Unmarshal(raw, &decoded), string(raw))
	}
	return response.StatusCode, decoded
}

// POST /api/todos answers 202 requested; a repeated Idempotency-Key answers
// the first TODO and makes no second one; and no request leaves the
// process: a TODO made in Smithers files nothing on GitHub (spec §6.2).
func TestTodoRoutesCreateIsIdempotentAndCallsNoGitHub(t *testing.T) {
	f := newTodoRoutesFixture(t)
	counting := &countingTransport{next: http.DefaultTransport, hosts: make(chan string, 8)}
	previous := http.DefaultTransport
	http.DefaultTransport = counting
	t.Cleanup(func() { http.DefaultTransport = previous })

	status, body := f.do(http.MethodPost, "/api/todos", f.userID, "", `{"title":"Add the footer link"}`)
	assert.Equal(t, http.StatusBadRequest, status)
	assert.Equal(t, "idempotency_key_required", body["code"])

	status, first := f.do(http.MethodPost, "/api/todos", f.userID, "k-1", `{"title":"Add the footer link","prompt":"Make it findable."}`)
	require.Equal(t, http.StatusAccepted, status, first)
	assert.Equal(t, "requested", first["state"])
	todo := first["todo"].(map[string]any)
	assert.Equal(t, float64(1), todo["n"])
	assert.Equal(t, "queued", todo["state"])
	assert.Equal(t, "smithers/add-the-footer-link", todo["branch"].(map[string]any)["name"])

	status, again := f.do(http.MethodPost, "/api/todos", f.userID, "k-1", `{"title":"Add the footer link","prompt":"Make it findable."}`)
	require.Equal(t, http.StatusAccepted, status, again)
	assert.Equal(t, first["todo"].(map[string]any)["n"], again["todo"].(map[string]any)["n"], "the repeat answers the first TODO")
	var count int
	require.NoError(t, f.pool.QueryRow(context.Background(), `SELECT count(*) FROM todos`).Scan(&count))
	assert.Equal(t, 1, count)

	status, conflict := f.do(http.MethodPost, "/api/todos", f.userID, "k-1", `{"title":"Something else"}`)
	assert.Equal(t, http.StatusConflict, status)
	assert.Equal(t, "idempotency_conflict", conflict["code"])

	status, invalid := f.do(http.MethodPost, "/api/todos", f.userID, "k-2", `{"title":"t","place":"before T1"}`)
	assert.Equal(t, http.StatusUnprocessableEntity, status, invalid)
	status, _ = f.do(http.MethodPost, "/api/todos", f.userID, "k-3", `{"title":"t","labels":["x"]}`)
	assert.Equal(t, http.StatusBadRequest, status, "an unknown field is refused")
	status, _ = f.do(http.MethodPost, "/api/todos", 0, "k-4", `{"title":"t"}`)
	assert.Equal(t, http.StatusUnauthorized, status)

	assert.Zero(t, counting.calls.Load(), "no outbound request (GitHub or other) was made")
}

func TestTodoRoutesReadTheStack(t *testing.T) {
	f := newTodoRoutesFixture(t)
	for i, title := range []string{"Fix the login", "Add dark mode"} {
		status, body := f.do(http.MethodPost, "/api/todos", f.userID, "k"+strconv.Itoa(i), `{"title":"`+title+`"}`)
		require.Equal(t, http.StatusAccepted, status, body)
	}
	status, list := f.do(http.MethodGet, "/api/todos", f.userID, "", "")
	require.Equal(t, http.StatusOK, status, list)
	todos := list["todos"].([]any)
	require.Len(t, todos, 2)
	assert.Equal(t, "Fix the login", todos[0].(map[string]any)["title"])
	assert.Equal(t, float64(2), todos[1].(map[string]any)["place"])

	for _, ref := range []string{"2", "T2", "t2"} {
		status, card := f.do(http.MethodGet, "/api/todos/"+ref, f.userID, "", "")
		require.Equal(t, http.StatusOK, status, card)
		assert.Equal(t, "Add dark mode", card["title"])
		require.Len(t, card["revisions"], 1)
		assert.Equal(t, "Add dark mode", card["revisions"].([]any)[0].(map[string]any)["prompt"], "the prompt defaults to the title")
	}
	for ref, want := range map[string]int{"9": http.StatusNotFound, "x": http.StatusBadRequest, "T0": http.StatusBadRequest} {
		status, _ := f.do(http.MethodGet, "/api/todos/"+ref, f.userID, "", "")
		assert.Equal(t, want, status, ref)
	}

	branch := todos[0].(map[string]any)["branch"].(map[string]any)["id"].(string)
	status, activity := f.do(http.MethodGet, "/api/branches/"+branch+"/activity", f.userID, "", "")
	require.Equal(t, http.StatusOK, status, activity)
	assert.Empty(t, activity["entries"])
	status, _ = f.do(http.MethodGet, "/api/branches/00000000-0000-4000-8000-000000000000/activity", f.userID, "", "")
	assert.Equal(t, http.StatusNotFound, status)

	// A second stack: the routes ask which repository, and number it apart.
	other := f.repository("other")
	status, ambiguous := f.do(http.MethodGet, "/api/todos", f.userID, "", "")
	assert.Equal(t, http.StatusBadRequest, status, ambiguous)
	status, made := f.do(http.MethodPost, "/api/todos?repo=ben/other", f.userID, "k9", `{"title":"Elsewhere"}`)
	require.Equal(t, http.StatusAccepted, status, made)
	assert.Equal(t, float64(1), made["todo"].(map[string]any)["n"], "each repository counts from T1")
	status, theirs := f.do(http.MethodGet, "/api/todos/T1?repo=ben/other", f.userID, "", "")
	require.Equal(t, http.StatusOK, status, theirs)
	assert.Equal(t, "Elsewhere", theirs["title"])
	status, _ = f.do(http.MethodGet, "/api/todos?repo=nobody", f.userID, "", "")
	assert.Equal(t, http.StatusBadRequest, status)
	_ = other
}

// A signed-in user who is no member of the install makes no TODO, even
// with write access to the repository.
func TestTodoRoutesOnlyMembersMakeTodos(t *testing.T) {
	f := newTodoRoutesFixture(t)
	_, err := f.pool.Exec(context.Background(), `UPDATE members SET removed_at = now() WHERE user_id = $1`, f.userID)
	require.NoError(t, err)
	status, body := f.do(http.MethodPost, "/api/todos", f.userID, "k", `{"title":"t"}`)
	assert.Equal(t, http.StatusForbidden, status, body)
	var count int
	require.NoError(t, f.pool.QueryRow(context.Background(), `SELECT count(*) FROM todos`).Scan(&count))
	assert.Zero(t, count)
}
