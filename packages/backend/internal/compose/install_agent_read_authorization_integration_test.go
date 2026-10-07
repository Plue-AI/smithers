package compose

import (
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/stretchr/testify/require"
)

func TestInstallRetainedAgentReadsPostgres(t *testing.T) {
	f := newLandingGateFixtureWithFactory(t, nil, "", true)
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode, cfg.Auth.SessionCookieName = "selfhost", "session"
	cfg.Server.PublicURL = "http://example.com"
	cfg.Server.AllowedOrigins = []string{cfg.Server.PublicURL}
	agent := &routes.AgentSessionHandler{Service: services.NewAgentServiceWithPool(f.q, f.pool)}
	router := buildRouterCompat(cfg, f.q, f.pool,
		&routes.RepoHandler{}, &routes.AuthHandler{}, &routes.UserHandler{}, &routes.SSHKeyHandler{}, &routes.LabelHandler{},
		&routes.OrgHandler{}, &routes.LandingHandler{}, &routes.SearchHandler{Service: &mockRouterSearchService{}}, &routes.IssueHandler{}, nil, &routes.GitSmartHandler{Service: &mockRouterGitService{}},
		nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, agent, nil, nil, nil, &routes.WorkspaceHandler{}, nil, nil, nil, nil, nil, nil)
	cookie := "retained-agent-member"
	sum := sha256.Sum256([]byte(cookie))
	_, err := f.q.CreateAuthSession(f.ctx, db.CreateAuthSessionParams{UserID: f.other.ID, Username: f.other.Username, SessionKey: hex.EncodeToString(sum[:]), ExpiresAt: time.Now().Add(time.Hour)})
	require.NoError(t, err)
	recorded, err := f.q.CreateAgentSession(f.ctx, db.CreateAgentSessionParams{ID: uuid.NewString(), RepositoryID: f.repoID, UserID: f.owner.ID, Title: "Recorded execution", Status: "active", Metadata: []byte(`{}`)})
	require.NoError(t, err)
	run := f.token(f.owner, "agent-read-run", "read:repository,write:repository", true)
	for _, row := range []struct{ suffix, command, content string }{
		{"", "runs.list", "Recorded execution"},
		{"/" + recorded.ID, "run.view", "Recorded execution"},
		{"/" + recorded.ID + "/messages", "runs.events", "[]"},
	} {
		for _, actor := range []struct {
			name, token string
			status      int
		}{{"member", "", 200}, {"unbound run", run, 403}} {
			t.Run(actor.name+"/"+row.command, func(t *testing.T) {
				req := httptest.NewRequest("GET", cfg.Server.PublicURL+"/api/repos/gate-owner/app/agent/sessions"+row.suffix, nil)
				if actor.token == "" {
					req.AddCookie(&http.Cookie{Name: "session", Value: cookie})
				} else {
					req.Header.Set("Authorization", "Bearer "+actor.token)
				}
				var decisions []string
				req = req.WithContext(services.WithAuthorizationObserver(req.Context(), func(command string) { decisions = append(decisions, command) }))
				out := httptest.NewRecorder()
				router.ServeHTTP(out, req)
				require.Equal(t, actor.status, out.Code, out.Body.String())
				require.Equal(t, []string{row.command}, decisions)
				if actor.status == 200 {
					require.Contains(t, out.Body.String(), row.content)
				} else {
					require.Contains(t, out.Body.String(), `"code":"permission"`)
					require.NotContains(t, out.Body.String(), recorded.Title)
				}
			})
		}
	}
	require.Zero(t, f.hostCalls.Load())
}
