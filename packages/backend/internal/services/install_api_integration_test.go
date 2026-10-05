package services

import (
	"context"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/identity"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
)

// routeVisit is what one install route saw of a host-run command's read.
type routeVisit struct {
	method, path string
	userID       int64
	token        bool
	scopes       string
}

// recordingRoutes is the install routes seam: the TODO routes' own
// authorization is exercised through the production router in compose; here
// only which credential reaches a route, and how its answer returns, is
// under test.
type recordingRoutes struct {
	mu     sync.Mutex
	visits []routeVisit
}

func (r *recordingRoutes) ServeHTTP(w http.ResponseWriter, request *http.Request) {
	info := middleware.AuthInfoFromContext(request.Context())
	visit := routeVisit{method: request.Method, path: request.URL.Path}
	if info != nil && info.User != nil {
		visit.userID, visit.token, visit.scopes = info.User.ID, info.IsTokenAuth, info.RawScopes
	}
	r.mu.Lock()
	r.visits = append(r.visits, visit)
	r.mu.Unlock()
	switch request.URL.Path {
	case "/api/todos":
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`[{"n":1,"title":"Add a greeting"}]` + "\n"))
	case "/api/todos/1":
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"status":403,"code":"permission","class":"permission","message":"Install owner session required"}`))
	case "/api/plain":
		_, _ = w.Write([]byte("not json"))
	case "/api/wait":
		// Answers only once the caller is gone.
		<-request.Context().Done()
		w.WriteHeader(http.StatusServiceUnavailable)
	case "/api/big":
		chunk := []byte(strings.Repeat(" ", 1<<20))
		for range 5 {
			_, _ = w.Write(chunk)
		}
	default:
		http.NotFound(w, request)
	}
}

func (r *recordingRoutes) seen() []routeVisit {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]routeVisit(nil), r.visits...)
}

type installAPIFixture struct {
	pool          *pgxpool.Pool
	api           InstallAPI
	routes        *recordingRoutes
	owner, member db.User
}

func newInstallAPIFixture(t *testing.T) *installAPIFixture {
	t.Helper()
	pool, _ := postgresfixture.NewProductDatabase(t)
	q := db.New(pool)
	user := func(name string) db.User {
		created, err := q.CreateUser(t.Context(), db.CreateUserParams{Username: name, LowerUsername: name})
		require.NoError(t, err)
		return created
	}
	f := &installAPIFixture{pool: pool, routes: &recordingRoutes{}, owner: user("acme"), member: user("maya")}
	_, err := pool.Exec(t.Context(), `INSERT INTO self_host_owners(user_id) VALUES($1)`, f.owner.ID)
	require.NoError(t, err)
	f.api = InstallAPI{Pool: pool, Members: everyMember{}, Routes: f.routes}
	return f
}

func TestInstallAPINamesTheAuthorOnlyForTheirLiveBrowserSession(t *testing.T) {
	f := newInstallAPIFixture(t)
	ctx := context.Background()
	never := pgtype.Timestamptz{}
	author, err := f.api.Author(ctx, turnSession(t, f.pool, f.owner, time.Now().Add(time.Hour)), f.owner.ID)
	require.NoError(t, err)
	require.Equal(t, "acme", author)
	author, err = f.api.Author(ctx, turnSession(t, f.pool, f.member, time.Now().Add(time.Hour)), f.member.ID)
	require.NoError(t, err)
	require.Equal(t, "maya", author)

	refused := func(credential middleware.Credential, userID int64, why string) {
		t.Helper()
		author, err := f.api.Author(ctx, credential, userID)
		require.ErrorIs(t, err, ErrAPIForbidden, why)
		require.Empty(t, author, why)
	}
	// The TODO routes refuse every token, so no token's turn is offered their commands.
	for _, scopes := range []string{"write:user", "read:repository,write:user", "write:repository,read:repository,write:user"} {
		credential, _ := turnToken(t, f.pool, f.owner, scopes, false, never)
		refused(credential, f.owner.ID, "a person's token with "+scopes)
	}
	runToken, _ := turnToken(t, f.pool, f.owner, "read:repository,write:user", true, never)
	refused(runToken, f.owner.ID, "an agent run's token")
	refused(turnSession(t, f.pool, f.owner, time.Now().Add(-time.Minute)), f.owner.ID, "an expired session")
	refused(middleware.Credential{}, f.owner.ID, "no credential")
	refused(middleware.Credential{SessionHash: strings.Repeat("0", 64)}, f.owner.ID, "an unknown session")
	refused(turnSession(t, f.pool, f.owner, time.Now().Add(time.Hour)), f.member.ID, "another account's session")

	// Signing out ends it; so does a suspended, disabled or deleted account.
	browser := turnSession(t, f.pool, f.owner, time.Now().Add(time.Hour))
	require.NoError(t, db.New(f.pool).DeleteAuthSession(ctx, browser.SessionHash))
	refused(browser, f.owner.ID, "a signed-out session")
	member := turnSession(t, f.pool, f.member, time.Now().Add(time.Hour))
	for _, state := range []string{"prohibit_login=true", "is_active=false", "deleted_at=now()"} {
		_, err := f.pool.Exec(ctx, `UPDATE users SET `+state+` WHERE id=$1`, f.member.ID)
		require.NoError(t, err)
		refused(member, f.member.ID, state)
		_, err = f.pool.Exec(ctx, `UPDATE users SET prohibit_login=false,is_active=true,deleted_at=NULL WHERE id=$1`, f.member.ID)
		require.NoError(t, err)
	}
	author, err = f.api.Author(ctx, member, f.member.ID)
	require.NoError(t, err)
	require.Equal(t, "maya", author)
	require.Empty(t, f.routes.seen(), "naming the author reads no route")
}

func TestInstallAPIReadsARouteAsTheAdmittingCredential(t *testing.T) {
	f := newInstallAPIFixture(t)
	ctx := context.Background()
	owner := turnSession(t, f.pool, f.owner, time.Now().Add(time.Hour))
	answer, err := f.api.Call(ctx, owner, f.owner.ID, http.MethodGet, "/api/todos")
	require.NoError(t, err)
	require.Equal(t, APIAnswer{Status: http.StatusOK, Body: []byte(`[{"n":1,"title":"Add a greeting"}]`)}, answer)
	// The route answers for itself, refusals included.
	answer, err = f.api.Call(ctx, owner, f.owner.ID, http.MethodGet, "/api/todos/1")
	require.NoError(t, err)
	require.Equal(t, http.StatusForbidden, answer.Status)
	require.JSONEq(t, `{"status":403,"code":"permission","class":"permission","message":"Install owner session required"}`, string(answer.Body))
	// A body that is not JSON, or longer than the bound, is no answer.
	for path, status := range map[string]int{"/api/plain": http.StatusOK, "/api/big": http.StatusOK, "/api/missing": http.StatusNotFound} {
		answer, err = f.api.Call(ctx, owner, f.owner.ID, http.MethodGet, path)
		require.NoError(t, err, path)
		require.Equal(t, APIAnswer{Status: status, Body: []byte("null")}, answer, path)
	}
	// A token reaches the route with its own authority and no more: the
	// route sees the token and its scopes.
	reader, _ := turnToken(t, f.pool, f.owner, "read:repository,write:user", false, pgtype.Timestamptz{})
	_, err = f.api.Call(ctx, reader, f.owner.ID, http.MethodGet, "/api/todos")
	require.NoError(t, err)
	visits := f.routes.seen()
	require.Len(t, visits, 6)
	for _, visit := range visits[:5] {
		require.Equal(t, http.MethodGet, visit.method)
		require.Equal(t, f.owner.ID, visit.userID)
		require.False(t, visit.token)
	}
	require.Equal(t, routeVisit{method: http.MethodGet, path: "/api/todos", userID: f.owner.ID, token: true, scopes: "read:repository,write:user"}, visits[5])
	// The read ends with its caller: a turn that ends stops its command's read.
	caller, cancel := context.WithCancel(ctx)
	time.AfterFunc(50*time.Millisecond, cancel)
	answer, err = f.api.Call(caller, owner, f.owner.ID, http.MethodGet, "/api/wait")
	require.NoError(t, err)
	require.Equal(t, http.StatusServiceUnavailable, answer.Status)
}

func TestInstallAPIRefusesWritesAndGoneCredentialsBeforeAnyRoute(t *testing.T) {
	f := newInstallAPIFixture(t)
	ctx := context.Background()
	owner := turnSession(t, f.pool, f.owner, time.Now().Add(time.Hour))
	// Every write a command asks for is the person's: no method but GET, and
	// no path outside the API, reaches a route.
	for _, call := range []struct{ method, path string }{
		{http.MethodPost, "/api/todos"}, {http.MethodPatch, "/api/todos/1"}, {http.MethodDelete, "/api/todos/1"},
		{"get", "/api/todos"}, {http.MethodGet, "/internal/chat/api"}, {http.MethodGet, "api/todos"}, {http.MethodGet, ""},
		{http.MethodGet, "/api/todos\x7f"},
	} {
		_, err := f.api.Call(ctx, owner, f.owner.ID, call.method, call.path)
		require.ErrorIs(t, err, ErrAPICallRefused, "%s %q", call.method, call.path)
	}
	// A credential that no longer acts for the author reads nothing.
	other := turnSession(t, f.pool, f.member, time.Now().Add(time.Hour))
	require.NoError(t, db.New(f.pool).DeleteAuthSession(ctx, owner.SessionHash))
	for _, refused := range []struct {
		credential middleware.Credential
		userID     int64
	}{{owner, f.owner.ID}, {other, f.owner.ID}, {middleware.Credential{TokenHash: "a", SessionHash: "b"}, f.owner.ID}} {
		_, err := f.api.Call(ctx, refused.credential, refused.userID, http.MethodGet, "/api/todos")
		require.ErrorIs(t, err, ErrAPIForbidden)
	}
	require.Empty(t, f.routes.seen())
	// Without routes nothing is read.
	f.api.Routes = nil
	_, err := f.api.Call(ctx, other, f.member.ID, http.MethodGet, "/api/todos")
	require.ErrorIs(t, err, ErrAPICallRefused)
}

// The installation's member boundary, the one AuthLoader applies, also
// bounds every command: an owner whose GitHub access is unverified, or
// anyone but the owner, reads nothing and is offered nothing.
func TestInstallAPIIsBoundedByTheInstallationMembers(t *testing.T) {
	f := newInstallAPIFixture(t)
	ctx := context.Background()
	f.api.Members = identity.NewMemberBoundary(db.New(f.pool))
	owner, member := turnSession(t, f.pool, f.owner, time.Now().Add(time.Hour)), turnSession(t, f.pool, f.member, time.Now().Add(time.Hour))
	_, err := f.api.Author(ctx, owner, f.owner.ID)
	require.ErrorIs(t, err, ErrAPIForbidden, "owner_unverified")
	_, err = f.api.Call(ctx, owner, f.owner.ID, http.MethodGet, "/api/todos")
	require.ErrorIs(t, err, ErrAPIForbidden, "owner_unverified")
	q := db.New(f.pool)
	for key, value := range map[string]string{
		"github.repository": `{"owner_login":"acme","repository_name":"app","repository_id":42}`,
		"owner.access":      `{"last_access_check_at":"` + time.Now().UTC().Format(time.RFC3339Nano) + `","owner_login":"acme","repository_name":"app","repository_id":42}`,
	} {
		require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: key, Value: []byte(value)}))
	}
	author, err := f.api.Author(ctx, owner, f.owner.ID)
	require.NoError(t, err)
	require.Equal(t, "acme", author)
	_, err = f.api.Call(ctx, owner, f.owner.ID, http.MethodGet, "/api/todos")
	require.NoError(t, err)
	_, err = f.api.Author(ctx, member, f.member.ID)
	require.ErrorIs(t, err, ErrAPIForbidden, "a member who is not the installation's owner")
	_, err = f.api.Call(ctx, member, f.member.ID, http.MethodGet, "/api/todos")
	require.ErrorIs(t, err, ErrAPIForbidden, "a member who is not the installation's owner")
	require.Len(t, f.routes.seen(), 1)
	// Without a boundary nothing is read or offered.
	f.api.Members = nil
	_, err = f.api.Author(ctx, owner, f.owner.ID)
	require.ErrorIs(t, err, ErrAPIForbidden)
	_, err = f.api.Call(ctx, owner, f.owner.ID, http.MethodGet, "/api/todos")
	require.ErrorIs(t, err, ErrAPIForbidden)
}
