package compose

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
)

// A member's app on an install, route by route, through the production auth
// loader, member boundary and memberCommands on real PostgreSQL: the owner,
// Ben (Maintainer) and Alice (Member) reach every route a member's J1 8, J2
// and J4 paths call; Alice is refused merge and member management by role;
// a person off the roster, a suspended member and a member's token reach
// none of them; and a route outside the member table stays the owner's.
func TestMemberRoutesAuthorizeByRolePostgres(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx := t.Context()
	q := db.New(pool)
	user := func(login string) db.User {
		u, err := q.CreateUser(ctx, db.CreateUserParams{Username: login, LowerUsername: login, DisplayName: login})
		require.NoError(t, err)
		return u
	}
	owner, ben, alice, carol, dave := user("maya"), user("ben"), user("alice"), user("carol"), user("dave")
	_, err := pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, owner.ID)
	require.NoError(t, err)
	repo, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: owner.ID, Valid: true}, Name: "demo", LowerName: "demo", DefaultBookmark: "main"})
	require.NoError(t, err)
	binding := fmt.Sprintf(`{"owner_login":"maya","repository_name":"demo","repository_id":%d}`, repo.ID)
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "github.repository", Value: []byte(binding)}))
	// The owner's access was checked, so the boundary treats them as verified.
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "owner.access", Value: []byte(binding[:len(binding)-1] + `,"last_access_check_at":"2026-10-05T10:00:00Z"}`)}))
	for _, row := range []struct {
		user       db.User
		permission string
		suspended  bool
	}{{owner, "admin", false}, {ben, "admin", false}, {alice, "write", false}, {dave, "write", true}} {
		_, err = pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission,suspended_at) VALUES($1,$2,$3,CASE WHEN $4::boolean THEN now() END)`, repo.ID, row.user.ID, row.permission, row.suspended)
		require.NoError(t, err)
	}
	session := func(u db.User) string {
		key := u.Username + "-cookie"
		digest := sha256.Sum256([]byte(key))
		_, err := q.CreateAuthSession(ctx, db.CreateAuthSessionParams{UserID: u.ID, Username: u.Username, SessionKey: hex.EncodeToString(digest[:]), ExpiresAt: time.Now().Add(time.Hour)})
		require.NoError(t, err)
		return key
	}
	mintToken := func(u db.User) string {
		raw := fmt.Sprintf("smithers_%040x", u.ID)
		sum := sha256.Sum256([]byte(raw))
		hash := hex.EncodeToString(sum[:])
		_, err = q.CreateAccessToken(ctx, db.CreateAccessTokenParams{UserID: u.ID, Name: "cli", TokenHash: hash, TokenLastEight: hash[len(hash)-8:],
			Scopes: "read:user", ExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(time.Hour), Valid: true}})
		require.NoError(t, err)
		return raw
	}
	raw := mintToken(alice)
	ownerToken := mintToken(owner)
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Auth.SessionCookieName = "session"
	router := chi.NewRouter()
	router.Use(authLoader(q, cfg.Auth))
	router.Use(memberCommands(q))
	served := func(w http.ResponseWriter, r *http.Request) {
		command := middleware.InstallMemberCommand(r.Method, r.URL.Path)
		if command != "" && command != "self" {
			// A same-command service entry reuses the middleware decision even
			// without a second database lookup.
			_, err := services.Authorize(r.Context(), nil, command)
			require.NoError(t, err)
		}
		w.WriteHeader(http.StatusOK)
	}
	routes := []struct{ method, path string }{
		{"GET", "/api/install"}, {"GET", "/api/user/repos"},
		{"GET", "/api/repos/maya/demo/mythical"}, {"GET", "/api/repos/maya/demo/mythical/events"}, {"GET", "/api/repos/maya/demo/mythical/items/T1"},
		{"GET", "/api/github/sync"}, {"POST", "/api/github/sync"}, {"GET", "/api/live"},
		{"GET", "/api/user/orgs"}, {"GET", "/api/user/workspaces"}, {"POST", "/api/telemetry/errors"},
		{"POST", "/api/agent/turn"}, {"POST", "/api/agent/turn/cancel"}, {"POST", "/api/agent/turn/replay"}, {"POST", "/api/agent/turn/retire"},
		{"GET", "/api/agent/conversations"}, {"POST", "/api/agent/conversations/replay"},
		{"GET", "/api/issues"}, {"GET", "/api/issues/2"},
		{"GET", "/api/todos"}, {"GET", "/api/todos/1"}, {"POST", "/api/todos"}, {"POST", "/api/todos/1"}, {"POST", "/api/todos/1/answer"},
		{"GET", "/api/members"}, {"POST", "/api/todos/1/merge"}, {"POST", "/api/members"}, {"PATCH", "/api/members/alice"}, {"DELETE", "/api/members/alice"},
		// Outside the member table: the owner's alone.
		{"POST", "/api/install/setup/models"}, {"GET", "/api/user/tokens"}, {"POST", "/api/agent/turn/erase"},
	}
	for _, route := range routes {
		router.MethodFunc(route.method, route.path, served)
	}
	ownerOnly := map[string]bool{"POST /api/install/setup/models": true, "GET /api/user/tokens": true, "POST /api/agent/turn/erase": true}
	maintainerOnly := map[string]bool{"POST /api/todos/1/merge": true, "POST /api/members": true, "PATCH /api/members/alice": true, "DELETE /api/members/alice": true}
	call := func(method, path, cookie, bearer string) (int, map[string]any) {
		req := httptest.NewRequest(method, path, nil)
		if cookie != "" {
			req.AddCookie(&http.Cookie{Name: "session", Value: cookie})
		}
		if bearer != "" {
			req.Header.Set("Authorization", "Bearer "+bearer)
		}
		res := httptest.NewRecorder()
		router.ServeHTTP(res, req)
		var envelope map[string]any
		_ = json.Unmarshal(res.Body.Bytes(), &envelope)
		return res.Code, envelope
	}
	cookies := map[string]string{"owner": session(owner), "maintainer": session(ben), "member": session(alice), "off roster": session(carol), "suspended": session(dave)}
	for _, who := range []string{"owner", "maintainer", "member", "off roster", "suspended", "member token"} {
		for _, route := range routes {
			key := route.method + " " + route.path
			want := http.StatusOK
			switch {
			case who == "owner":
			case ownerOnly[key], who == "off roster", who == "suspended", who == "member token":
				want = http.StatusForbidden
			case who == "member" && maintainerOnly[key]:
				want = http.StatusForbidden
			}
			var status int
			var envelope map[string]any
			if who == "member token" {
				status, envelope = call(route.method, route.path, "", raw)
			} else {
				status, envelope = call(route.method, route.path, cookies[who], "")
			}
			require.Equal(t, want, status, "%s %s %v", who, key, envelope)
			if want == http.StatusForbidden && who == "member" && maintainerOnly[key] {
				require.Equal(t, map[string]any{"class": "permission", "code": "permission", "message": "Only a maintainer can do this"}, envelope, key)
			}
			if want == http.StatusForbidden && who == "member token" && !ownerOnly[key] {
				require.Equal(t, "Sign in with a browser session", envelope["message"], key)
			}
		}
	}
	// Owner tokens cannot bypass authorization on a mapped command.
	status, envelope := call("GET", "/api/todos", "", ownerToken)
	require.Equal(t, http.StatusForbidden, status)
	require.Equal(t, "permission", envelope["class"])
	// Suspending Ben refuses his very next request.
	_, err = pool.Exec(ctx, `UPDATE collaborators SET suspended_at=now() WHERE user_id=$1`, ben.ID)
	require.NoError(t, err)
	status, _ = call("GET", "/api/install", cookies["maintainer"], "")
	require.Equal(t, http.StatusForbidden, status)
}
