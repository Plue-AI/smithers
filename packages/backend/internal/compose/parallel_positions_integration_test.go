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

	"github.com/google/uuid"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/microsandbox"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

func TestParallelSchedulerPositionsInstallBoundary(t *testing.T) {
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
	runtime := new(microsandbox.Runtime)
	service := services.NewMythicalService(pool, nil)
	service.SetInstallParallel(&services.InstallCapacityService{Queries: q, Profile: microsandbox.HostProfile{MemoryBytes: 32 << 30, PerfCores: 10, DiskFreeBytes: 400 << 30}})
	service.SetOrchestration(nil, nil, services.NewWorkspaceMythicalLanes(services.NewWorkspaceService(q, services.WithWorkspaceRuntime(runtime))))
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
	holders := map[int]string{}
	for n, title := range []string{"T1", "T2", "T3", "T4", "T5"} {
		code, body := call("POST", "/api/todos", fmt.Sprintf(`{"title":%q,"prompt":"Add a line","place":{"mode":"append"}}`, title), title)
		require.Equal(t, 202, code, body)
		if n >= 2 {
			continue
		}
		id := uuid.NewString()
		_, err = pool.Exec(ctx, `INSERT INTO workspaces(id,repository_id,user_id,status,target_bookmark) VALUES($1,$2,$3,'pending',$4)`, id, repo, owner.ID, fmt.Sprintf("smithers/todo-%d", n+1))
		require.NoError(t, err)
		_, err = pool.Exec(ctx, `UPDATE mythical_items SET workspace_id=$1 WHERE repository_id=$2 AND number=$3`, id, repo, n+1)
		require.NoError(t, err)
		holders[n+1] = "workspace:" + id
	}
	// Asynchronous provisioning arrived in the opposite order to the stack.
	for _, n := range []int{2, 1} {
		_, err = runtime.Request("todo", holders[n], holders[n], "machine")
		require.NoError(t, err)
	}
	_, err = runtime.Request("person", "workspace:ben", "Ben", "machine")
	require.NoError(t, err)
	position := func(n, expected int) {
		code, card := call("GET", fmt.Sprintf("/api/todos/%d", n), "", "")
		require.Equal(t, 200, code, card)
		require.Equal(t, map[string]any{"reason": "machine", "position": float64(expected)}, card["queue"])
	}
	position(1, 2)
	position(2, 3)
	position(3, 4)
	position(4, 5)
	position(5, 6)
	code, body := call("POST", "/api/todos/2", `{"op":"move","direction":"up"}`, "move-T2")
	require.Equal(t, 202, code, body)
	position(2, 2)
	position(1, 3)
	require.False(t, runtime.CancelAdmission("workspace:ben", "Ben", time.Now()))
	position(2, 1)
	position(1, 2)
	position(3, 3)
	position(4, 4)
	position(5, 5)
	code, body = call("POST", "/api/todos/3", `{"op":"drop"}`, "drop-T3")
	require.Equal(t, 202, code, body)
	position(4, 3)
	position(5, 4)
	// Demand includes the full stack, even beyond Home's 500-card page.
	// Fixture insertion is supplemental; the assertion uses the install route.
	_, err = pool.Exec(ctx, `INSERT INTO mythical_items(repository_id,source,state,title,owner_id,revisions)
 SELECT $1,'todo','queued','Backlog '||n,$2,'[]'::jsonb FROM generate_series(6,505) n ORDER BY n`, repo, owner.ID)
	require.NoError(t, err)
	position(505, 504)
	position(1, 2)
	require.Zero(t, runtime.InUse(), "projection/reorder never grants or boots a VM")
}
