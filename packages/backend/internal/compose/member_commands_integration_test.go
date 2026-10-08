package compose

import (
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
// off-roster and suspended people are refused. Member tokens reach only
// scoped reads and questions; person-only commands stay refused, and
// unmapped routes refuse every credential.
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
	downgradeAfterDecision := false
	served := func(w http.ResponseWriter, r *http.Request) {
		if downgradeAfterDecision {
			_, err := pool.Exec(ctx, `UPDATE collaborators SET permission='write' WHERE user_id=$1`, ben.ID)
			require.NoError(t, err)
		}
		command := middleware.InstallMemberCommand(r.Method, r.URL.Path)
		if command == "todo.control" {
			command = "todo.steer"
		}
		if command != "" && command != "self" {
			// A same-command service entry reuses the middleware decision even
			// without a second database lookup.
			var subjects []services.InstallSubject
			if services.InstallExecutionCredential(r.Context()) {
				var subject services.InstallSubject
				var err error
				if command == "stack.candidate" {
					var input services.MythicalLaneSubmission
					require.NoError(t, json.NewDecoder(r.Body).Decode(&input))
					subject, err = services.ResolveInstallCandidateSubject(r.Context(), q, repo.ID, input)
				} else {
					subject, err = services.ResolveInstallExecutionSubject(r.Context(), q, repo.ID)
				}
				require.NoError(t, err)
				subjects = []services.InstallSubject{subject}
			}
			_, err := services.Authorize(r.Context(), nil, command, subjects...)
			require.NoError(t, err)
		}
		w.WriteHeader(http.StatusOK)
	}
	routes := []struct{ method, path string }{
		{"GET", "/api/install"}, {"GET", "/api/user/repos"},
		{"GET", "/api/repos/maya/demo/mythical"}, {"GET", "/api/repos/maya/demo/mythical/events"}, {"GET", "/api/repos/maya/demo/mythical/items/T1"},
		{"GET", "/api/github/sync"}, {"POST", "/api/github/sync"}, {"GET", "/api/live"},
		{"GET", "/api/user/tokens"}, {"GET", "/api/user/orgs"}, {"GET", "/api/user/workspaces"}, {"POST", "/api/telemetry/errors"},
		{"POST", "/api/conversations/1/prompt"}, {"POST", "/api/agent/turn/replay"},
		{"GET", "/api/agent/conversations"}, {"POST", "/api/agent/conversations/replay"},
		{"GET", "/api/issues"}, {"GET", "/api/issues/2"},
		{"GET", "/api/todos"}, {"GET", "/api/todos/1"}, {"POST", "/api/todos"}, {"POST", "/api/todos/1"}, {"POST", "/api/todos/1/answer"},
		{"GET", "/api/members"}, {"POST", "/api/todos/1/merge"}, {"POST", "/api/members"}, {"PATCH", "/api/members/alice"}, {"DELETE", "/api/members/alice"},
		// Setup is owner-only; turn erasure has its own member-level command.
		{"POST", "/api/install/setup/models"}, {"POST", "/api/agent/turn/erase"},
	}
	for _, route := range routes {
		router.MethodFunc(route.method, route.path, served)
	}
	router.Put("/api/repos/maya/demo/mythical/lanes", served)
	router.Post("/api/unmapped/command", served)
	ownerOnly := map[string]bool{"GET /api/install": true, "POST /api/install/setup/models": true}
	maintainerOnly := map[string]bool{"POST /api/todos/1/merge": true, "POST /api/members": true, "PATCH /api/members/alice": true, "DELETE /api/members/alice": true}
	call := func(method, path, cookie, bearer string, supplied ...string) (int, map[string]any) {
		var body *strings.Reader
		body = strings.NewReader("{}")
		if method == "POST" && path == "/api/todos/1" {
			body = strings.NewReader(`{"op":"steer","text":"Continue"}`)
		}
		if len(supplied) == 1 {
			body = strings.NewReader(supplied[0])
		}
		req := httptest.NewRequest(method, path, body)
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
			// Every mapped route rejects a dead member before command policy.
			case who == "suspended":
				want = http.StatusUnauthorized
			case who == "member token" && (key == "GET /api/user/orgs" || key == "GET /api/user/workspaces" || key == "POST /api/telemetry/errors" || key == "GET /api/agent/conversations" || key == "POST /api/agent/conversations/replay" || key == "POST /api/conversations/1/prompt" || key == "POST /api/agent/turn/replay" || key == "POST /api/agent/turn/erase"):
				want = http.StatusOK
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
				message := "Insufficient credential scope"
				if key == "GET /api/user/tokens" {
					message = "Not available"
				}
				require.Equal(t, message, envelope["message"], key)
			}
		}
	}
	// Owner tokens cannot bypass authorization on a mapped command.
	status, envelope := call("GET", "/api/todos", "", ownerToken)
	require.Equal(t, http.StatusForbidden, status)
	require.Equal(t, "permission", envelope["class"])
	// Give the owner token explicit repository scope before repository reads.
	_, err = pool.Exec(ctx, `UPDATE access_tokens SET scopes='read:user,read:repository' WHERE user_id=$1`, owner.ID)
	require.NoError(t, err)
	// The credential binder normalizes a scoped legacy CLI token to delegation.
	status, _ = call("POST", "/api/conversations/1/prompt", "", ownerToken)
	require.Equal(t, http.StatusOK, status)
	status, _ = call("GET", "/api/repos/maya/demo/mythical", "", ownerToken)
	require.Equal(t, http.StatusOK, status)
	// Unbound system-issued credentials inherit no owner read authority.
	_, err = pool.Exec(ctx, `UPDATE access_tokens SET system_issued=true WHERE user_id=$1`, owner.ID)
	require.NoError(t, err)
	status, _ = call("GET", "/api/repos/maya/demo/mythical", "", ownerToken)
	require.Equal(t, http.StatusForbidden, status)
	for _, path := range []string{"/api/conversations/1/prompt", "/api/todos/1/merge"} {
		status, _ = call("POST", path, "", ownerToken)
		require.Equal(t, http.StatusForbidden, status, path)
	}
	// The real provisioned landing shape retains its scoped stack read, but
	// never gains chat, merge or any other person command.
	landingScopes := strings.Join(append([]string{"write:repository", middleware.RepositoryRestrictionScope(repo.ID), middleware.LandingWorkspaceScope("11111111-1111-4111-a111-111111111111"), middleware.AgentSessionRestrictionScope("current-run")}, middleware.PathRestrictionScopes([]string{"**"})...), ",")
	_, err = pool.Exec(ctx, `UPDATE access_tokens SET scopes=$2 WHERE user_id=$1`, owner.ID, landingScopes)
	require.NoError(t, err)
	// Scope strings alone cannot manufacture an execution subject. The real
	// provisioned credential needs its stored lane, sponsored attempt and run.
	status, _ = call("GET", "/api/repos/maya/demo/mythical", "", ownerToken)
	require.Equal(t, http.StatusForbidden, status)
	// Unbound writes are refused before interpreting a candidate payload.
	status, envelope = call("PUT", "/api/repos/maya/demo/mythical/lanes", "", ownerToken, `{not-json`)
	require.Equal(t, http.StatusForbidden, status, envelope)
	require.Equal(t, "permission", envelope["code"])
	_, err = pool.Exec(ctx, `INSERT INTO workspaces(id,repository_id,user_id,name)
 VALUES('11111111-1111-4111-a111-111111111111',$1,$2,'delivery')`, repo.ID, owner.ID)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO mythical_stacks(repository_id,actor_user_id,state) VALUES($1,$2,'active')`, repo.ID, owner.ID)
	require.NoError(t, err)
	var itemID string
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO mythical_items(repository_id,source,state,number,stack_position,title,workspace_id,request_run_id,owner_id,attempt,base_commit)
 VALUES($1,'todo','delivering',1,1,'Delivery','11111111-1111-4111-a111-111111111111','current-run',$2,1,'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa') RETURNING id::text`, repo.ID, owner.ID).Scan(&itemID))
	_, err = pool.Exec(ctx, `INSERT INTO mythical_lanes(workspace_id,repository_id,item_id,name)
 VALUES('11111111-1111-4111-a111-111111111111',$1,$2,'delivery')`, repo.ID, itemID)
	require.NoError(t, err)
	status, _ = call("GET", "/api/repos/maya/demo/mythical", "", ownerToken)
	require.Equal(t, http.StatusOK, status)
	for _, path := range []string{"/api/conversations/1/prompt", "/api/todos/1/merge"} {
		status, _ = call("POST", path, "", ownerToken)
		require.Equal(t, http.StatusForbidden, status, path)
	}
	const submission = `{"workspaceId":"11111111-1111-4111-a111-111111111111","base":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","source":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","requestRunId":"current-run","summary":"Delivery"}`
	status, _ = call("PUT", "/api/repos/maya/demo/mythical/lanes", "", ownerToken, submission)
	require.Equal(t, http.StatusOK, status)
	for _, body := range []string{strings.Replace(submission, "11111111-1111-4111-a111-111111111111", "22222222-2222-4222-a222-222222222222", 1), strings.Replace(submission, "current-run", "other-run", 1)} {
		status, _ = call("PUT", "/api/repos/maya/demo/mythical/lanes", "", ownerToken, body)
		require.Equal(t, http.StatusForbidden, status, body)
	}
	for _, invalid := range []struct{ body, code string }{{`{}`, "bad_request"}, {submission + `{}`, "invalid_candidate"}} {
		status, envelope = call("PUT", "/api/repos/maya/demo/mythical/lanes", "", ownerToken, invalid.body)
		require.Equal(t, http.StatusBadRequest, status, invalid.body)
		require.Equal(t, "user", envelope["class"])
		require.Equal(t, invalid.code, envelope["code"])
	}
	for _, path := range []string{"/api/repos/maya/demo/mythical/wiki", "/api/user/tokens"} {
		status, _ = call("PUT", path, "", ownerToken, submission)
		require.Equal(t, http.StatusForbidden, status, path)
	}
	for _, scopes := range []string{
		strings.Replace(landingScopes, middleware.RepositoryRestrictionScope(repo.ID), middleware.RepositoryRestrictionScope(repo.ID+1), 1),
		strings.Replace(landingScopes, "write:repository", "read:user", 1),
		strings.Replace(landingScopes, middleware.PathRestrictionScopes([]string{"**"})[0], middleware.PathRestrictionScopes([]string{"docs"})[0], 1),
	} {
		_, err = pool.Exec(ctx, `UPDATE access_tokens SET scopes=$2 WHERE user_id=$1`, owner.ID, scopes)
		require.NoError(t, err)
		status, _ = call("GET", "/api/repos/maya/demo/mythical", "", ownerToken)
		require.Equal(t, http.StatusForbidden, status, scopes)
		status, _ = call("PUT", "/api/repos/maya/demo/mythical/lanes", "", ownerToken, submission)
		require.Equal(t, http.StatusForbidden, status, scopes)
	}
	// No unbound credential, even one minted for the owner, inherits the
	// owner's legacy route fallback. Refuse before the mounted handler.
	for _, scopes := range []string{"write:repository,read:user", "write:repository,read:user,credential:sync", "write:repository,read:user,via:codex"} {
		_, err = pool.Exec(ctx, `UPDATE access_tokens SET scopes=$2,system_issued=true WHERE user_id=$1`, owner.ID, scopes)
		require.NoError(t, err)
		status, denied := call("POST", "/api/unmapped/command", "", ownerToken)
		require.Equal(t, 403, status, denied)
		require.Equal(t, "permission", denied["class"])
		require.Equal(t, "permission", denied["code"])
	}
	// An ordinary role downgrade after the request's bound decision does
	// not change that in-flight decision. The next request sees the new role.
	downgradeAfterDecision = true
	status, _ = call("POST", "/api/members", cookies["maintainer"], "")
	require.Equal(t, http.StatusOK, status)
	downgradeAfterDecision = false
	status, envelope = call("POST", "/api/members", cookies["maintainer"], "")
	require.Equal(t, http.StatusForbidden, status)
	require.Equal(t, "permission", envelope["code"])
	_, err = pool.Exec(ctx, `UPDATE collaborators SET permission='admin' WHERE user_id=$1`, ben.ID)
	require.NoError(t, err)
	// Suspending Ben refuses his very next request.
	_, err = pool.Exec(ctx, `UPDATE collaborators SET suspended_at=now() WHERE user_id=$1`, ben.ID)
	require.NoError(t, err)
	status, envelope = call("GET", "/api/install", cookies["maintainer"], "")
	require.Equal(t, http.StatusUnauthorized, status)
	require.Equal(t, "unauthenticated", envelope["code"])
}
