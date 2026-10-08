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

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

// Placement through the install router, auth, CSRF, catalog dispatch and the
// canonical service, with migrated PostgreSQL. No worker or guest is launched.
func TestTodoBranchNamesComposedInstall(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx := t.Context()
	q := db.New(pool)
	owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "maya", LowerUsername: "maya"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE users SET is_active=true WHERE id=$1`, owner.ID)
	require.NoError(t, err)
	var repo int64
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO repositories(user_id,name,lower_name) VALUES($1,'app','app') RETURNING id`, owner.ID).Scan(&repo))
	_, err = pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, owner.ID)
	require.NoError(t, err)
	for _, key := range []string{"github.repository", "owner.access"} {
		require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: key, Value: []byte(fmt.Sprintf(`{"owner_login":"maya","repository_name":"app","repository_id":%d,"last_access_check_at":"2026-10-05T10:00:00Z"}`, repo))}))
	}
	_, err = pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,'admin')`, repo, owner.ID)
	require.NoError(t, err)
	_, err = q.RequestMythicalBootstrap(ctx, repo, owner.ID, 1, false)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE mythical_stacks SET state='active' WHERE repository_id=$1`, repo)
	require.NoError(t, err)
	sum := sha256.Sum256([]byte("placement-session"))
	_, err = q.CreateAuthSession(ctx, db.CreateAuthSessionParams{UserID: owner.ID, Username: owner.Username, SessionKey: hex.EncodeToString(sum[:]), ExpiresAt: time.Now().Add(time.Hour)})
	require.NoError(t, err)
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Auth.SessionCookieName = "smithers_session"
	cfg.Server.PublicURL = "http://127.0.0.1:4000"
	cfg.Server.AllowedOrigins = []string{cfg.Server.PublicURL}
	service := services.NewMythicalService(pool, nil)
	router := todoMergeComposeRouter(cfg, q, pool, &routes.MythicalHandler{Service: service})
	bearerToken := ""
	browserCookie := "placement-session"
	call := func(method, path, body, key string) (int, map[string]any) {
		t.Helper()
		req := httptest.NewRequest(method, cfg.Server.PublicURL+path, strings.NewReader(body))
		req.RemoteAddr = "127.0.0.1:51900"
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Origin", cfg.Server.PublicURL)
		req.Header.Set("Idempotency-Key", key)
		req.Header.Set("X-CSRF-Token", "placement-csrf")
		req.AddCookie(&http.Cookie{Name: middleware.CSRFCookieName, Value: "placement-csrf"})
		if bearerToken == "" {
			req.AddCookie(&http.Cookie{Name: cfg.Auth.SessionCookieName, Value: browserCookie})
		} else {
			req.Header.Set("Authorization", "Bearer "+bearerToken)
		}
		res := httptest.NewRecorder()
		router.ServeHTTP(res, req)
		var result map[string]any
		require.NoError(t, json.Unmarshal(res.Body.Bytes(), &result), res.Body.String())
		return res.Code, result
	}
	t.Run("duplicate titles reserve distinct stable branch names", func(t *testing.T) {
		bearerToken = ""
		browserCookie = "placement-session"
		for i, name := range []string{"smithers/retry-webhooks", "smithers/retry-webhooks-2"} {
			key := fmt.Sprintf("branch-name-%d", i)
			code, body := call("POST", "/api/todos", `{"title":"Retry webhooks","prompt":"Add retries"}`, key)
			require.Equal(t, 202, code, body)
			item, err := q.GetMythicalItemByNumber(ctx, repo, int64(1+i))
			require.NoError(t, err)
			var checks map[string]any
			require.NoError(t, json.Unmarshal(item.Checks, &checks))
			require.Equal(t, name, checks["branch"], "creation reserves the branch before publication")
			workspace, err := q.CreateWorkspace(ctx, db.CreateWorkspaceParams{RepositoryID: repo, UserID: owner.ID,
				Name: "TODO internal lane", Kind: "agent", Status: "stopped", TargetBookmark: "mythical", EnvironmentSource: "main"})
			require.NoError(t, err)
			_, _, err = q.BindMythicalLane(ctx, db.MythicalLane{WorkspaceID: workspace.ID, RepositoryID: repo, ItemID: item.ID, Name: "coding"})
			require.NoError(t, err)
			_, err = pool.Exec(ctx, `UPDATE mythical_items SET workspace_id=$2, title='Edited title' WHERE id=$1`, item.ID, workspace.ID)
			require.NoError(t, err)
			code, card := call("GET", fmt.Sprintf("/api/todos/%d", 1+i), "", "")
			require.Equal(t, 200, code, card)
			require.Equal(t, name, card["branch"].(map[string]any)["name"])
			branchName, err := services.BranchName(ctx, q, workspace)
			require.NoError(t, err)
			require.Equal(t, name, branchName, "both cards retain the name after a title edit")
			code, replay := call("POST", "/api/todos", `{"title":"Retry webhooks","prompt":"Add retries"}`, key)
			require.Equal(t, 202, code, replay)
		}
	})

	t.Run("isolated verification preserves the open branch and cleanup capacity", func(t *testing.T) {
		item, err := q.GetMythicalItemByNumber(ctx, repo, 1)
		require.NoError(t, err)
		original, err := q.GetMythicalTodoBranchWorkspace(ctx, item)
		require.NoError(t, err)
		makeLane := func(name string, age int) string {
			w, err := q.CreateWorkspace(ctx, db.CreateWorkspaceParams{RepositoryID: repo, UserID: owner.ID, Name: name, Kind: "agent", Status: "stopped", TargetBookmark: "mythical", EnvironmentSource: "main"})
			require.NoError(t, err)
			_, _, err = q.BindMythicalLane(ctx, db.MythicalLane{WorkspaceID: w.ID, RepositoryID: repo, ItemID: item.ID, Name: name})
			require.NoError(t, err)
			_, err = pool.Exec(ctx, `UPDATE mythical_lanes SET created_at=NOW()-make_interval(mins=>$2) WHERE workspace_id=$1`, w.ID, age)
			require.NoError(t, err)
			return w.ID
		}
		obsolete := makeLane("TODO 1 attempt 0 g1", 5)
		verification := makeLane("TODO 1 verify 2", 1)
		_, err = pool.Exec(ctx, `UPDATE mythical_lanes SET created_at=NOW()-interval '3 minutes' WHERE workspace_id=$1`, original.ID)
		require.NoError(t, err)
		_, err = pool.Exec(ctx, `UPDATE mythical_items SET workspace_id=$2,state='verifying',flow_digest=$3 WHERE id=$1`, item.ID, verification, strings.Repeat("b", 64))
		require.NoError(t, err)
		code, card := call("GET", "/api/todos/1", "", "")
		require.Equal(t, 200, code, card)
		require.Equal(t, original.ID, card["branch"].(map[string]any)["id"])
		require.Equal(t, "smithers/retry-webhooks", card["branch"].(map[string]any)["name"])
		eligible, err := q.ListRetirableMythicalLanes(ctx, repo, 2*time.Minute, 1)
		require.NoError(t, err)
		require.Len(t, eligible, 1, "retained branches must not consume the sweep limit")
		require.Equal(t, obsolete, eligible[0].WorkspaceID)
		_, err = pool.Exec(ctx, `UPDATE mythical_items SET state='landed' WHERE id=$1`, item.ID)
		require.NoError(t, err)
		eligible, err = q.ListRetirableMythicalLanes(ctx, repo, 2*time.Minute, 8)
		require.NoError(t, err)
		var ids []string
		for _, lane := range eligible {
			ids = append(ids, lane.WorkspaceID)
		}
		require.Contains(t, ids, original.ID, "a person's completed merge permits normal branch retirement")
	})

}
