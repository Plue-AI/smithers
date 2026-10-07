package compose

import (
	"crypto/sha256"
	"encoding/hex"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/stretchr/testify/require"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestInstallVisibleRunCountsAndPublicCatalogPostgres(t *testing.T) {
	f := newLandingGateFixtureWithFactory(t, nil, "", true)
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Auth.SessionCookieName = "session"
	cfg.Server.PublicURL = "http://example.com"
	cfg.Server.AllowedOrigins = []string{cfg.Server.PublicURL}
	router := githubAppSetupComposeRouter(cfg, f.pool, nil)
	ownDef := ciTestDefinition(t, f.q, f.repoID)
	privateRepo := ciTestRepo(t, f.pool, f.owner.ID, "private-owner-canary")
	privateDef := ciTestDefinition(t, f.q, privateRepo)
	for _, row := range []struct {
		repo, definition int64
		status           string
	}{{f.repoID, ownDef, "running"}, {f.repoID, ownDef, "success"}, {privateRepo, privateDef, "running"}, {privateRepo, privateDef, "queued"}} {
		_, err := f.q.CreateWorkflowRun(f.ctx, db.CreateWorkflowRunParams{RepositoryID: row.repo, WorkflowDefinitionID: row.definition, Status: row.status, TriggerEvent: "workflow_dispatch", TriggerRef: "refs/heads/main", DispatchInputs: []byte(`{}`)})
		require.NoError(t, err)
	}
	cookie := "run-count-member"
	sum := sha256.Sum256([]byte(cookie))
	_, err := f.q.CreateAuthSession(f.ctx, db.CreateAuthSessionParams{UserID: f.other.ID, Username: f.other.Username, SessionKey: hex.EncodeToString(sum[:]), ExpiresAt: time.Now().Add(time.Hour)})
	require.NoError(t, err)
	for _, actor := range []struct {
		name, token string
		status      int
	}{
		{"member", "", 200}, {"external", f.token(f.other, "counts-external", "read:repository,via:codex", true), 200}, {"app", f.token(f.other, "counts-app", "read:repository,via:smithers,terminal-session:"+liveAppTurnCredentialFixture(t, f.pool, f.other.ID)+"/1", true), 200}, {"run", f.token(f.owner, "counts-run", "read:repository", true), 403}, {"scope", f.token(f.other, "counts-scope", "read:user,via:codex", true), 403},
	} {
		t.Run(actor.name, func(t *testing.T) {
			req := httptest.NewRequest("GET", cfg.Server.PublicURL+"/api/user/workflow-runs/active-count?user_id=1", nil)
			if actor.token == "" {
				req.AddCookie(&http.Cookie{Name: "session", Value: cookie})
			} else {
				req.Header.Set("Authorization", "Bearer "+actor.token)
			}
			var decisions []string
			req = req.WithContext(services.WithAuthorizationObserver(req.Context(), func(c string) { decisions = append(decisions, c) }))
			out := httptest.NewRecorder()
			router.ServeHTTP(out, req)
			require.Equal(t, actor.status, out.Code, out.Body.String())
			require.Equal(t, []string{"repo.read"}, decisions)
			if actor.status == 200 {
				require.JSONEq(t, `{"active_count":1}`, out.Body.String())
				require.Equal(t, "no-store", out.Header().Get("Cache-Control"))
			} else {
				require.Contains(t, out.Body.String(), `"code":"permission"`)
			}
		})
	}
	public := ciTestRepo(t, f.pool, f.owner.ID, "public-catalog-entry")
	_, err = f.pool.Exec(f.ctx, `UPDATE repositories SET is_public=true WHERE id=$1`, public)
	require.NoError(t, err)
	out := httptest.NewRecorder()
	router.ServeHTTP(out, httptest.NewRequest("GET", cfg.Server.PublicURL+"/api/public/repos", nil))
	require.Equal(t, 200, out.Code, out.Body.String())
	require.Contains(t, out.Body.String(), "public-catalog-entry")
	require.NotContains(t, out.Body.String(), "private-owner-canary")
	require.NotContains(t, out.Body.String(), "gate-owner/app")
}
