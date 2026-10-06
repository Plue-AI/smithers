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
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

// A person's Take over through the install router with real PostgreSQL,
// authentication, CSRF, role policy and production control service.
func TestTodoTakeoverComposedInstall(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx := context.Background()
	q := db.New(pool)
	create := func(login string) db.User {
		user, err := q.CreateUser(ctx, db.CreateUserParams{Username: login, LowerUsername: login, DisplayName: login})
		require.NoError(t, err)
		_, err = pool.Exec(ctx, `UPDATE users SET is_active=true WHERE id=$1`, user.ID)
		require.NoError(t, err)
		return user
	}
	maya, ben, alice, eve := create("maya"), create("ben"), create("alice"), create("eve")
	var repo int64
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO repositories(user_id,name,lower_name) VALUES ($1,'app','app') RETURNING id`, maya.ID).Scan(&repo))
	_, err := pool.Exec(ctx, `INSERT INTO self_host_owners(singleton,user_id) VALUES (true,$1)`, maya.ID)
	require.NoError(t, err)
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "github.repository", Value: []byte(fmt.Sprintf(`{"owner_login":"maya","repository_name":"app","repository_id":%d}`, repo))}))
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "owner.access", Value: []byte(fmt.Sprintf(`{"owner_login":"maya","repository_name":"app","repository_id":%d,"last_access_check_at":"2026-10-05T10:00:00Z"}`, repo))}))
	for _, member := range []struct {
		user       db.User
		permission string
	}{{maya, "admin"}, {ben, "admin"}, {alice, "write"}, {eve, "write"}} {
		_, err = pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission) VALUES ($1,$2,$3)`, repo, member.user.ID, member.permission)
		require.NoError(t, err)
	}
	_, err = q.RequestMythicalBootstrap(ctx, repo, maya.ID, 1, false)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE mythical_stacks SET state='active' WHERE repository_id=$1`, repo)
	require.NoError(t, err)
	for _, n := range []int64{3, 4} {
		item, _, insertErr := q.InsertMythicalItem(ctx, db.MythicalItem{RepositoryID: repo, State: "queued", Checks: []byte(`{"todo":true}`)})
		require.NoError(t, insertErr)
		state := "queued"
		if n == 4 {
			state = "running"
		}
		_, err = pool.Exec(ctx, `UPDATE mythical_items SET source='todo',number=$2,state=$3,owner_id=$4,title='Retry webhooks',stack_position=$2,attempt=1,request_run_id='run-1',revisions='[{"text":"PROMPT-A","acceptance":[],"by":{"kind":"person","login":"eve","name":"eve","avatar_url":"https://example.com/eve.png","color_index":0},"at":"2026-10-05T00:00:00Z"}]' WHERE id=$1`, item.ID, n, state, eve.ID)
		require.NoError(t, err)
	}
	session := func(user db.User) string {
		raw := "takeover-" + user.Username
		hash := sha256.Sum256([]byte(raw))
		_, err := pool.Exec(ctx, `INSERT INTO auth_sessions(session_key,user_id,username,expires_at) VALUES ($1,$2,$3,NOW()+interval '1 hour')`, hex.EncodeToString(hash[:]), user.ID, user.Username)
		require.NoError(t, err)
		return raw
	}
	cookies := map[string]string{"ben": session(ben), "alice": session(alice), "maya": session(maya)}
	delegated := "smithers_0000000000000000000000000000000000003466"
	digest := sha256.Sum256([]byte(delegated))
	hash := hex.EncodeToString(digest[:])
	branch, err := q.CreateWorkspace(ctx, db.CreateWorkspaceParams{RepositoryID: repo, UserID: ben.ID, Name: "takeover-terminal", Kind: "agent", Status: "running", TargetBookmark: "mythical", EnvironmentSource: "repository"})
	require.NoError(t, err)
	subject, err := q.CreateWorkspaceSession(ctx, db.CreateWorkspaceSessionParams{WorkspaceID: branch.ID, RepositoryID: repo, UserID: ben.ID, Cols: 80, Rows: 24})
	require.NoError(t, err)
	_, err = q.CreateAccessToken(ctx, db.CreateAccessTokenParams{UserID: ben.ID, Name: "takeover-terminal", TokenHash: hash, TokenLastEight: hash[len(hash)-8:],
		Scopes:       strings.Join(append([]string{"read:repository", "read:user", middleware.RepositoryRestrictionScope(repo)}, middleware.DelegationScopes(middleware.Delegation{Via: "terminal", Branch: branch.ID, Profile: middleware.TerminalProfileS1, Session: subject.ID})...), ","),
		SystemIssued: true, ExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(time.Hour), Valid: true}})
	require.NoError(t, err)
	external := "smithers_0000000000000000000000000000000000003491"
	externalDigest := sha256.Sum256([]byte(external))
	externalHash := hex.EncodeToString(externalDigest[:])
	_, err = q.CreateAccessToken(ctx, db.CreateAccessTokenParams{UserID: ben.ID, Name: "takeover-codex", TokenHash: externalHash, TokenLastEight: externalHash[len(externalHash)-8:],
		Scopes:       strings.Join(append([]string{"write:repository", "read:user"}, middleware.DelegationScopes(middleware.Delegation{Via: "codex"})...), ","),
		SystemIssued: true, ExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(time.Hour), Valid: true}})
	require.NoError(t, err)
	service := services.NewMythicalService(pool, nil)
	server := httptest.NewUnstartedServer(nil)
	origin := "http://" + server.Listener.Addr().String()
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Server.PublicURL = origin
	cfg.Server.AllowedOrigins = []string{origin}
	server.Config.Handler = todoMergeComposeRouter(cfg, q, pool, &routes.MythicalHandler{Service: service})
	server.Start()
	t.Cleanup(server.Close)
	call := func(login, method string, n int64, key string) (int, map[string]any) {
		t.Helper()
		req, err := http.NewRequest(method, fmt.Sprintf("%s/api/todos/%d", origin, n), strings.NewReader(`{"op":"takeover"}`))
		require.NoError(t, err)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Origin", origin)
		req.Header.Set("X-CSRF-Token", "takeover-csrf")
		req.Header.Set("Idempotency-Key", key)
		if login == "external" {
			req.Header.Set("Authorization", "Bearer "+external)
		} else if login == "delegated" {
			req.Header.Set("Authorization", "Bearer "+delegated)
		} else {
			req.AddCookie(&http.Cookie{Name: "smithers_session", Value: cookies[login]})
		}
		req.AddCookie(&http.Cookie{Name: middleware.CSRFCookieName, Value: "takeover-csrf"})
		res, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		defer res.Body.Close()
		var body map[string]any
		require.NoError(t, json.NewDecoder(res.Body).Decode(&body))
		return res.StatusCode, body
	}
	status, _ := call("ben", "POST", 3, "active-owner")
	require.Equal(t, 409, status)
	_, err = pool.Exec(ctx, `DELETE FROM collaborators WHERE repository_id=$1 AND user_id=$2`, repo, eve.ID)
	require.NoError(t, err)
	status, body := call("alice", "POST", 3, "member-refused")
	require.Equal(t, 403, status)
	require.Equal(t, "permission", body["code"])
	status, body = call("delegated", "POST", 3, "delegated-refused")
	require.Equal(t, 403, status)
	require.Equal(t, "permission", body["code"])
	require.Equal(t, "permission", body["class"])
	status, body = call("external", "POST", 3, "external-refused")
	require.Equal(t, 403, status)
	require.Equal(t, "never", body["code"])
	require.Equal(t, "never", body["class"])
	for _, login := range []string{"ben", "alice", "maya"} {
		status, body = call(login, "GET", 3, "")
		require.Equal(t, 200, status)
		require.Equal(t, true, body["owner_removed"])
		require.Equal(t, "eve", body["owner"].(map[string]any)["login"])
	}
	before, err := q.GetMythicalItemByNumber(ctx, repo, 3)
	require.NoError(t, err)
	for _, n := range []int64{3, 4} {
		for i := 0; i < 2; i++ {
			status, _ = call("ben", "POST", n, fmt.Sprintf("takeover-%d", n))
			require.Equal(t, 202, status)
		}
		after, err := q.GetMythicalItemByNumber(ctx, repo, n)
		require.NoError(t, err)
		require.Equal(t, ben.ID, after.OwnerID.Int64)
		require.Equal(t, int64(n), after.StackPosition.Int64)
		require.Equal(t, int32(1), after.Attempt)
		require.Equal(t, "run-1", after.RequestRunID)
		if n == 3 {
			require.JSONEq(t, string(before.Revisions), string(after.Revisions))
		}
		for _, login := range []string{"ben", "alice", "maya"} {
			status, body = call(login, "GET", n, "")
			require.Equal(t, 200, status)
			require.Equal(t, "ben", body["owner"].(map[string]any)["login"])
		}
	}
	var facts int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_requests WHERE operation='todo.owner_changed'`).Scan(&facts))
	require.Equal(t, 2, facts)
}
