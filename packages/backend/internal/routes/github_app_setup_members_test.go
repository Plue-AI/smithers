package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
)

// A claimed install's state is read by its owner and by roster members'
// browser sessions (install.read): Ben (Maintainer) and Alice (Member) read
// it; a person off the roster, a suspended member and a member's token do
// not. Changing it stays the owner's (Begin and the setup steps).
func TestGitHubAppSetupStatusAdmitsRosterMembers(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx := context.Background()
	q := db.New(pool)
	person := func(login string) int64 {
		var id int64
		require.NoError(t, pool.QueryRow(ctx, `INSERT INTO users(username,lower_username) VALUES ($1,$1) RETURNING id`, login).Scan(&id))
		return id
	}
	owner, ben, alice, carol, dave := person("maya"), person("ben"), person("alice"), person("carol"), person("dave")
	var repo int64
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO repositories(user_id,name,lower_name) VALUES ($1,'demo','demo') RETURNING id`, owner).Scan(&repo))
	_, err := pool.Exec(ctx, `INSERT INTO self_host_owners(singleton,user_id) VALUES (true,$1)`, owner)
	require.NoError(t, err)
	binding, _ := json.Marshal(map[string]any{"owner_login": "maya", "repository_name": "demo", "repository_id": repo})
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "github.repository", Value: binding}))
	for _, row := range []struct {
		user       int64
		permission string
		suspended  bool
	}{{owner, "admin", false}, {ben, "admin", false}, {alice, "write", false}, {dave, "write", true}} {
		_, err = pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission,suspended_at) VALUES ($1,$2,$3,CASE WHEN $4::boolean THEN now() END)`, repo, row.user, row.permission, row.suspended)
		require.NoError(t, err)
	}
	store := &githubAppSetupTestCredentials{loadError: services.ErrGitHubAppNotConfigured}
	h := &GitHubAppSetupHandler{Owners: q, Roster: q, Store: store, Sessions: setupSessionStub{}, Origins: middleware.FixedOrigins("http://localhost:4000")}
	for _, tc := range []struct {
		who    string
		info   *middleware.AuthInfo
		status int
	}{
		{"owner", &middleware.AuthInfo{User: &db.User{ID: owner}, SessionHash: "owner-session"}, http.StatusOK},
		{"maintainer", &middleware.AuthInfo{User: &db.User{ID: ben}, SessionHash: "ben-session"}, http.StatusOK},
		{"member", &middleware.AuthInfo{User: &db.User{ID: alice}, SessionHash: "alice-session"}, http.StatusOK},
		{"off roster", &middleware.AuthInfo{User: &db.User{ID: carol}, SessionHash: "carol-session"}, http.StatusForbidden},
		{"suspended", &middleware.AuthInfo{User: &db.User{ID: dave}, SessionHash: "dave-session"}, http.StatusForbidden},
		{"member token", &middleware.AuthInfo{User: &db.User{ID: alice}, IsTokenAuth: true, TokenSource: middleware.TokenSourcePersonalAccessToken}, http.StatusForbidden},
	} {
		r := httptest.NewRequest(http.MethodGet, "http://localhost:4000/api/install", nil)
		r.RemoteAddr = "127.0.0.1:1234"
		r = r.WithContext(middleware.ContextWithAuthInfo(r.Context(), tc.info))
		w := httptest.NewRecorder()
		h.Status(w, r)
		require.Equal(t, tc.status, w.Code, "%s %s", tc.who, w.Body.String())
		if tc.status == http.StatusOK {
			require.JSONEq(t, `{"github_app":{"configured":false,"installed":false}}`, w.Body.String(), tc.who)
		} else {
			require.Contains(t, w.Body.String(), `"code":"permission"`, tc.who)
		}
	}
	require.Equal(t, 3, store.loads, "only the owner and roster members read the install")
	// Without the roster the install's state stays the owner's.
	h.Roster = nil
	r := httptest.NewRequest(http.MethodGet, "http://localhost:4000/api/install", nil)
	r.RemoteAddr = "127.0.0.1:1234"
	r = r.WithContext(middleware.ContextWithAuthInfo(r.Context(), &middleware.AuthInfo{User: &db.User{ID: alice}, SessionHash: "alice-session"}))
	w := httptest.NewRecorder()
	h.Status(w, r)
	require.Equal(t, http.StatusForbidden, w.Code, w.Body.String())
}
