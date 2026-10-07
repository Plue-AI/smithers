package compose

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

// C-UI-10: an install without an isolated Flow host still serves HTTP, but
// confirming the documented invocation cannot create or execute a run.
func TestDebugAPIInvokeWithoutIsolationPostgres(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx, q := t.Context(), db.New(pool)
	owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "ben", LowerUsername: "ben"})
	require.NoError(t, err)
	repo := ciTestRepo(t, pool, owner.ID, "app")
	_, err = pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, owner.ID)
	require.NoError(t, err)
	binding := []byte(fmt.Sprintf(`{"owner_login":"ben","repository_name":"app","repository_id":%d,"last_access_check_at":"%s"}`, repo, time.Now().UTC().Format(time.RFC3339)))
	for _, key := range []string{"github.repository", "owner.access"} {
		require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: key, Value: binding}))
	}
	cookie := "debug-api-isolation-session"
	digest := sha256.Sum256([]byte(cookie))
	_, err = q.CreateAuthSession(ctx, db.CreateAuthSessionParams{UserID: owner.ID, Username: owner.Username, SessionKey: hex.EncodeToString(digest[:]), ExpiresAt: time.Now().Add(time.Hour)})
	require.NoError(t, err)
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode, cfg.Auth.SessionCookieName = "selfhost", "smithers_session"
	// This is the production absence configuration, not a fake launcher.
	composition, err := newFlowComposition(runOptions{}, cfg, pool, nil, nil, nil, nil, nil, nil, nil)
	require.NoError(t, err)
	require.Nil(t, composition, "no registry means no host launcher or dispatcher")
	invoked := services.NewInvokedFlowService(pool, services.NewRepositoryJobService(q, nil, pool), nil)
	server := httptest.NewUnstartedServer(nil)
	cfg.Server.PublicURL = "http://" + server.Listener.Addr().String()
	cfg.Server.AllowedOrigins = []string{cfg.Server.PublicURL}
	server.Config.Handler = buildWorkflowTriggerRouter(q, pool, &routes.WorkflowHandler{Service: services.NewWorkflowAPIService(q, services.NewWorkflowRunService(q), services.WithWorkflowAPIFlowInvoker(invoked))}, cfg)
	server.Start()
	t.Cleanup(server.Close)
	app := exec.CommandContext(ctx, "bun", "e2e/playwright/debug-api/missing-isolation.ts")
	app.Dir = "../../../../apps/app"
	app.Env = append(os.Environ(), "DEBUG_API_TEST_ORIGIN="+server.URL, "DEBUG_API_TEST_COOKIE="+cookie)
	output, err := app.CombinedOutput()
	require.NoError(t, err, string(output))
	require.Contains(t, string(output), "C-UI-10 MISSING ISOLATION SEND PASS")
	for _, key := range []string{"confirmed-request", "confirmed-request", "new-request"} {
		req, err := http.NewRequest(http.MethodPost, server.URL+"/api/repos/ben/app/invoke", strings.NewReader(`{"flow":"ci"}`))
		require.NoError(t, err)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Origin", server.URL)
		req.Header.Set("Idempotency-Key", key)
		req.Header.Set("X-CSRF-Token", "isolation-csrf")
		req.AddCookie(&http.Cookie{Name: "__csrf", Value: "isolation-csrf"})
		req.AddCookie(&http.Cookie{Name: "smithers_session", Value: cookie})
		res, err := server.Client().Do(req)
		require.NoError(t, err)
		body, err := io.ReadAll(res.Body)
		res.Body.Close()
		require.NoError(t, err)
		require.Equal(t, 503, res.StatusCode, string(body))
		var envelope map[string]any
		require.NoError(t, json.Unmarshal(body, &envelope))
		require.Equal(t, "infra", envelope["class"])
		require.Equal(t, "service_unavailable", envelope["code"])
		for _, table := range []string{"workflow_runs", "workflow_steps", "flow_runtime_host_bindings", "workspaces"} {
			var count int
			require.NoError(t, pool.QueryRow(ctx, "SELECT count(*) FROM "+table).Scan(&count))
			require.Zero(t, count, "%s: refusal must precede admission and host creation", table)
		}
	}
}
