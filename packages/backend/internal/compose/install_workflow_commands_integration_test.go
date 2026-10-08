package compose

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/stretchr/testify/require"
)

func TestInstallWorkflowCommandsPostgres(t *testing.T) {
	f := newLandingGateFixtureWithFactory(t, nil, "", true)
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Auth.SessionCookieName = "session"
	cfg.Server.PublicURL = "http://example.com"
	cfg.Server.AllowedOrigins = []string{"http://example.com"}
	workflow := services.NewWorkflowAPIService(f.q, services.NewWorkflowRunService(f.q))
	router := buildWorkflowTriggerRouter(f.q, f.pool, &routes.WorkflowHandler{Service: workflow}, cfg)
	definition := ciTestDefinition(t, f.q, f.repoID)
	cookie := "workflow-command-owner"
	sum := sha256.Sum256([]byte(cookie))
	_, err := f.q.CreateAuthSession(f.ctx, db.CreateAuthSessionParams{UserID: f.owner.ID, Username: f.owner.Username, SessionKey: hex.EncodeToString(sum[:]), ExpiresAt: time.Now().Add(time.Hour)})
	require.NoError(t, err)
	issuer := services.NewAuthService(f.q, cfg.Auth, nil, nil)
	issuer.Members = &services.Members{Pool: f.pool}
	external, err := issuer.CreateToken(f.ctx, f.owner.ID, services.CreateTokenRequest{Name: "workflow-codex", Via: "codex", Scopes: []string{"repo", "user"}})
	require.NoError(t, err)
	app, err := issuer.MintForTurn(f.ctx, f.owner.ID, liveAppTurnCredentialFixture(t, f.pool, f.owner.ID), 1)
	require.NoError(t, err)
	memberCookie := "workflow-command-member"
	sum = sha256.Sum256([]byte(memberCookie))
	_, err = f.q.CreateAuthSession(f.ctx, db.CreateAuthSessionParams{UserID: f.other.ID, Username: f.other.Username, SessionKey: hex.EncodeToString(sum[:]), ExpiresAt: time.Now().Add(time.Hour)})
	require.NoError(t, err)
	memberToken, err := issuer.CreateToken(f.ctx, f.other.ID, services.CreateTokenRequest{Name: "workflow-member-codex", Via: "codex", Scopes: []string{"repo", "user"}})
	require.NoError(t, err)
	run := f.token(f.owner, "workflow-run", "write:repository", true)
	for _, cell := range []struct {
		name, token, session string
		status               int
	}{
		{"owner", "", cookie, 201}, {"member", "", memberCookie, 201}, {"member external", memberToken.Token, "", 201}, {"external", external.Token, "", 201}, {"app", app.Token, "", 201}, {"run", run, "", 403},
	} {
		for _, suffix := range []string{fmt.Sprintf("/workflows/%d/dispatches", definition), "/workflows/CI/dispatch"} {
			t.Run(cell.name+suffix, func(t *testing.T) {
				var before int
				require.NoError(t, f.pool.QueryRow(f.ctx, `SELECT count(*) FROM workflow_runs WHERE repository_id=$1`, f.repoID).Scan(&before))
				req := httptest.NewRequest(http.MethodPost, "http://example.com/api/repos/gate-owner/app"+suffix, strings.NewReader(`{"ref":"main"}`))
				req.Header.Set("Content-Type", "application/json")
				req.Header.Set("Origin", "http://example.com")
				req.Header.Set("Smithers-Actor", "person")
				req.Header.Set("Smithers-Via", "smithers")
				if cell.token != "" {
					req.Header.Set("Authorization", "Bearer "+cell.token)
				} else {
					req.AddCookie(&http.Cookie{Name: "session", Value: cell.session})
					req.AddCookie(&http.Cookie{Name: "__csrf", Value: "csrf"})
					req.Header.Set("X-CSRF-Token", "csrf")
				}
				var decisions []string
				req = req.WithContext(services.WithAuthorizationObserver(req.Context(), func(command string) { decisions = append(decisions, command) }))
				out := httptest.NewRecorder()
				router.ServeHTTP(out, req)
				require.Equal(t, cell.status, out.Code, out.Body.String())
				require.Equal(t, []string{"flow.run"}, decisions)
				var after int
				require.NoError(t, f.pool.QueryRow(f.ctx, `SELECT count(*) FROM workflow_runs WHERE repository_id=$1`, f.repoID).Scan(&after))
				if cell.status == 201 {
					require.Equal(t, before+1, after)
					var runID int64
					require.NoError(t, f.pool.QueryRow(f.ctx, `SELECT max(id) FROM workflow_runs WHERE repository_id=$1`, f.repoID).Scan(&runID))
					cancel := httptest.NewRequest(http.MethodPost, fmt.Sprintf("http://example.com/api/repos/gate-owner/app/runs/%d/cancel", runID), strings.NewReader(`{}`))
					cancel.Header.Set("Content-Type", "application/json")
					cancel.Header.Set("Origin", "http://example.com")
					cancel.AddCookie(&http.Cookie{Name: "session", Value: cookie})
					cancel.AddCookie(&http.Cookie{Name: "__csrf", Value: "csrf"})
					cancel.Header.Set("X-CSRF-Token", "csrf")
					decisions = nil
					cancel = cancel.WithContext(services.WithAuthorizationObserver(cancel.Context(), func(command string) { decisions = append(decisions, command) }))
					cancelled := httptest.NewRecorder()
					router.ServeHTTP(cancelled, cancel)
					require.Equal(t, 204, cancelled.Code, cancelled.Body.String())
					require.Equal(t, []string{"runs.cancel"}, decisions)
				} else {
					require.Equal(t, before, after)
					require.Contains(t, out.Body.String(), `"code":"permission"`)
				}
			})
		}
	}
	var runID int64
	require.NoError(t, f.pool.QueryRow(f.ctx, `SELECT min(id) FROM workflow_runs WHERE repository_id=$1`, f.repoID).Scan(&runID))
	for _, action := range []struct{ suffix, command string }{
		{"runs/%d/cancel", "runs.cancel"}, {"workflows/runs/%d/cancel", "runs.cancel"}, {"actions/runs/%d/cancel", "runs.cancel"},
		{"runs/%d/rerun", "runs.rerun"}, {"workflows/runs/%d/rerun", "runs.rerun"}, {"actions/runs/%d/rerun", "runs.rerun"},
		{"runs/%d/resume", "runs.resume"}, {"workflows/runs/%d/resume", "runs.resume"},
	} {
		for _, credential := range []struct {
			name, token string
			status      int
			code        string
		}{
			{"run", run, 403, "permission"}, {"external", external.Token, 403, "permission"}, {"app", app.Token, 503, "confirmation_unavailable"},
		} {
			t.Run(credential.name+"/"+action.suffix, func(t *testing.T) {
				path := "/api/repos/gate-owner/app/" + fmt.Sprintf(action.suffix, runID)
				req := httptest.NewRequest(http.MethodPost, "http://example.com"+path, strings.NewReader(`{}`))
				req.Header.Set("Content-Type", "application/json")
				req.Header.Set("Origin", "http://example.com")
				req.Header.Set("Authorization", "Bearer "+credential.token)
				req.Header.Set("Idempotency-Key", credential.name+"-"+path)
				var decisions []string
				req = req.WithContext(services.WithAuthorizationObserver(req.Context(), func(command string) { decisions = append(decisions, command) }))
				out := httptest.NewRecorder()
				router.ServeHTTP(out, req)
				require.Equal(t, credential.status, out.Code, out.Body.String())
				require.Contains(t, out.Body.String(), `"code":"`+credential.code+`"`)
				require.Equal(t, []string{action.command}, decisions)
				var active, confirmations int
				require.NoError(t, f.pool.QueryRow(f.ctx, `SELECT count(*) FROM workflow_runs WHERE repository_id=$1 AND status != 'cancelled'`, f.repoID).Scan(&active))
				require.NoError(t, f.pool.QueryRow(f.ctx, `SELECT count(*) FROM approvals WHERE repository_id=$1`, f.repoID).Scan(&confirmations))
				require.Zero(t, active, "refusal started or resumed a run")
				require.Zero(t, confirmations, "unavailable consumer persisted a confirmation")
			})
		}
	}

	for _, route := range []struct{ suffix, command string }{
		{"workflows", "flows.read"}, {fmt.Sprintf("workflows/%d", definition), "flows.read"},
		{"runs", "runs.list"}, {"workflows/runs", "runs.list"}, {"actions/runs", "runs.list"},
		{fmt.Sprintf("workflows/%d/runs", definition), "runs.list"},
		{fmt.Sprintf("runs/%d", runID), "runs.open"}, {fmt.Sprintf("actions/runs/%d", runID), "runs.open"}, {fmt.Sprintf("workflows/runs/%d", runID), "runs.open"},
		{fmt.Sprintf("runs/%d/steps", runID), "runs.steps"}, {fmt.Sprintf("actions/runs/%d/steps", runID), "runs.steps"},
	} {
		for _, credential := range []struct {
			name, token, session  string
			flowStatus, runStatus int
		}{
			{"owner", "", cookie, 200, 200}, {"member", "", memberCookie, 200, 200}, {"app", app.Token, "", 200, 200},
			{"external", external.Token, "", 200, 403}, {"run", run, "", 403, 403},
		} {
			t.Run(credential.name+"/read/"+route.suffix, func(t *testing.T) {
				req := httptest.NewRequest(http.MethodGet, "http://example.com/api/repos/gate-owner/app/"+route.suffix, nil)
				if credential.token != "" {
					req.Header.Set("Authorization", "Bearer "+credential.token)
				} else {
					req.AddCookie(&http.Cookie{Name: "session", Value: credential.session})
				}
				var decisions []string
				req = req.WithContext(services.WithAuthorizationObserver(req.Context(), func(command string) { decisions = append(decisions, command) }))
				out := httptest.NewRecorder()
				router.ServeHTTP(out, req)
				status := credential.runStatus
				if route.command == "flows.read" {
					status = credential.flowStatus
				}
				require.Equal(t, status, out.Code, out.Body.String())
				require.Equal(t, []string{route.command}, decisions)
				if status == 403 {
					require.Contains(t, out.Body.String(), `"code":"permission"`)
				}
			})
		}
	}

	// Stream aliases sit outside the JSON route group but share its policy.
	for _, route := range []struct{ suffix, command string }{
		{"runs/%d/logs", "runs.logs"}, {"runs/%d/events", "runs.events"},
		{"workflows/runs/%d/events", "runs.events"}, {"runs/%d/status/stream", "runs.open"},
	} {
		for _, credential := range []struct{ name, token string }{{"external", external.Token}, {"run", run}} {
			t.Run(credential.name+"/stream/"+route.suffix, func(t *testing.T) {
				req := httptest.NewRequest(http.MethodGet, fmt.Sprintf("http://example.com/api/repos/gate-owner/app/"+route.suffix, runID), nil)
				req.Header.Set("Authorization", "Bearer "+credential.token)
				var decisions []string
				req = req.WithContext(services.WithAuthorizationObserver(req.Context(), func(command string) { decisions = append(decisions, command) }))
				out := httptest.NewRecorder()
				router.ServeHTTP(out, req)
				require.Equal(t, 403, out.Code, out.Body.String())
				require.Contains(t, out.Body.String(), `"code":"permission"`)
				require.Equal(t, []string{route.command}, decisions)
			})
		}
	}

}
