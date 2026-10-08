package compose

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/stretchr/testify/require"
)

func TestInstallWorkflowBodyCommandBindingPostgres(t *testing.T) {
	f := newLandingGateFixtureWithFactory(t, nil, "", true)
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode, cfg.Auth.SessionCookieName = "selfhost", "session"
	cfg.Server.PublicURL = "http://example.com"
	cfg.Server.AllowedOrigins = []string{cfg.Server.PublicURL}
	definition := ciTestDefinition(t, f.q, f.repoID)
	workflow := services.NewWorkflowAPIService(f.q, services.NewWorkflowRunService(f.q))
	router := buildWorkflowTriggerRouter(f.q, f.pool, &routes.WorkflowHandler{Service: workflow}, cfg)
	issuer := services.NewAuthService(f.q, cfg.Auth, nil, nil)
	issuer.Members = &services.Members{Pool: f.pool}
	token, err := issuer.CreateToken(f.ctx, f.other.ID, services.CreateTokenRequest{Name: "body-command", Via: "codex", Scopes: []string{"repo", "user"}})
	require.NoError(t, err)
	for _, suffix := range []string{"/workflows/CI/dispatch", fmt.Sprintf("/workflows/%d/dispatches", definition)} {
		// Each door gets an independent dispatch quota so all malformed-body
		// cases reach validation rather than the unrelated rate-limit boundary.
		_, err := f.pool.Exec(f.ctx, `DELETE FROM search_rate_limits WHERE scope='workflow_dispatch'`)
		require.NoError(t, err)
		for _, cell := range []struct {
			name, body string
			status     int
			command    string
		}{
			{"explicit allowed", `{"command":"flow.run","ref":"main","inputs":{}}`, 201, "flow.run"},
			{"forbidden command", `{"command":"approve","ref":"main"}`, 403, "denied"},
			{"mismatched command", `{"command":"todo.new","ref":"main"}`, 403, "denied"},
			{"unknown command", `{"command":"new.unmapped.command","ref":"main"}`, 403, "denied"},
			{"forged subject", `{"command":"flow.run","ref":"main","subject":{"role":"owner"}}`, 400, ""},
			{"trailing body", `{"command":"flow.run","ref":"main"}{}`, 400, ""},
		} {
			t.Run(suffix+"/"+cell.name, func(t *testing.T) {
				var before int
				require.NoError(t, f.pool.QueryRow(f.ctx, `SELECT count(*) FROM workflow_runs WHERE repository_id=$1`, f.repoID).Scan(&before))
				req := httptest.NewRequest("POST", cfg.Server.PublicURL+"/api/repos/gate-owner/app"+suffix, strings.NewReader(cell.body))
				req.Header.Set("Authorization", "Bearer "+token.Token)
				req.Header.Set("Content-Type", "application/json")
				req.Header.Set("Origin", cfg.Server.PublicURL)
				var decisions []string
				req = req.WithContext(services.WithAuthorizationObserver(req.Context(), func(command string) { decisions = append(decisions, command) }))
				out := httptest.NewRecorder()
				router.ServeHTTP(out, req)
				require.Equal(t, cell.status, out.Code, out.Body.String())
				if cell.command == "" {
					require.Empty(t, decisions)
				} else {
					require.Equal(t, []string{cell.command}, decisions)
				}
				var after int
				require.NoError(t, f.pool.QueryRow(f.ctx, `SELECT count(*) FROM workflow_runs WHERE repository_id=$1`, f.repoID).Scan(&after))
				if cell.status == http.StatusCreated {
					require.Equal(t, before+1, after)
				} else {
					require.Equal(t, before, after)
					if cell.status == 403 {
						require.Contains(t, out.Body.String(), `"class":"permission"`)
					}
				}
			})
		}
	}
}
