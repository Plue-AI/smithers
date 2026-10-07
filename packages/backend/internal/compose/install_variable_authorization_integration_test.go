package compose

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

type variableAdmissionProbe struct {
	routes.VariableRouteService
	before                    func()
	replaceValue, replaceName bool
}

func (p *variableAdmissionProbe) SetVariable(ctx context.Context, actor *db.User, owner, repo, name, value string) (services.VariableResponse, error) {
	if p.before != nil {
		p.before()
	}
	if p.replaceValue {
		value = "substituted"
	}
	return p.VariableRouteService.SetVariable(ctx, actor, owner, repo, name, value)
}
func (p *variableAdmissionProbe) GetVariable(ctx context.Context, actor *db.User, owner, repo, name string) (services.VariableResponse, error) {
	if p.replaceName {
		name = "PRIVATE"
	}
	return p.VariableRouteService.GetVariable(ctx, actor, owner, repo, name)
}
func (p *variableAdmissionProbe) DeleteVariable(ctx context.Context, actor *db.User, owner, repo, name string) error {
	if p.replaceName {
		name = "PRIVATE"
	}
	return p.VariableRouteService.DeleteVariable(ctx, actor, owner, repo, name)
}

func TestInstallVariableAuthorizationPostgres(t *testing.T) {
	f := newLandingGateFixtureWithFactory(t, nil, "", true)
	pool, err := postgresfixture.Open(f.ctx, f.pool.Config().ConnConfig.ConnString(), 1)
	require.NoError(t, err)
	defer pool.Close()
	q := db.New(pool)
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode, cfg.Auth.SessionCookieName, cfg.Auth.SessionRefreshWindow = "selfhost", "session", "0s"
	cfg.Server.PublicURL = "http://example.com"
	cfg.Server.AllowedOrigins = []string{cfg.Server.PublicURL}
	service := services.NewVariableService(q, services.WithVariableInstallAuthorization(pool), services.WithVariableOwnershipGuard(services.NewRepoOwnershipFence(pool)))
	handler := &routes.VariableHandler{Service: service}
	router := buildRouterCompat(cfg, q, pool,
		&routes.RepoHandler{}, &routes.AuthHandler{}, &routes.UserHandler{}, &routes.SSHKeyHandler{}, &routes.LabelHandler{},
		&routes.OrgHandler{}, &routes.LandingHandler{}, &routes.SearchHandler{Service: &mockRouterSearchService{}}, &routes.IssueHandler{}, nil, &routes.GitSmartHandler{Service: &mockRouterGitService{}},
		nil, nil, nil, nil, nil, nil, nil, nil, handler, nil, nil, nil, nil, nil, nil, nil, nil, &routes.WorkspaceHandler{}, nil, nil, nil, nil, nil, nil)
	session := func(user db.User, raw string) string {
		sum := sha256.Sum256([]byte(raw))
		hash := hex.EncodeToString(sum[:])
		_, err := f.q.CreateAuthSession(f.ctx, db.CreateAuthSessionParams{UserID: user.ID, Username: user.Username, SessionKey: hash, ExpiresAt: time.Now().Add(time.Hour)})
		require.NoError(t, err)
		return hash
	}
	ownerCookie, memberCookie := "variables-owner", "variables-member"
	ownerHash := session(f.owner, ownerCookie)
	session(f.other, memberCookie)
	for name, value := range map[string]string{"KEEP": "retained-value", "PRIVATE": "private-value"} {
		_, err := f.q.CreateOrUpdateVariable(f.ctx, db.CreateOrUpdateVariableParams{RepositoryID: f.repoID, Name: name, Value: value})
		require.NoError(t, err)
	}
	external := f.token(f.owner, "variables-external", "write:repository,via:codex", true)
	app := f.token(f.owner, "variables-app", "write:repository,via:smithers,terminal-session:"+liveAppTurnCredentialFixture(t, f.pool, f.owner.ID)+"/1", true)
	run := f.token(f.owner, "variables-run", "write:repository", true)
	machine := f.token(f.owner, "variables-machine", "write:repository,"+middleware.WorkspaceRestrictionScope("11111111-1111-4111-8111-111111111111"), true)
	call := func(t *testing.T, method, path, cookie, bearer, body, command string, status int) *httptest.ResponseRecorder {
		t.Helper()
		ctx, cancel := context.WithTimeout(f.ctx, 5*time.Second)
		defer cancel()
		req := httptest.NewRequest(method, cfg.Server.PublicURL+"/api/repos/gate-owner/app/variables"+path, strings.NewReader(body))
		req.Header.Set("Origin", cfg.Server.PublicURL)
		req.Header.Set("Content-Type", "application/json")
		if cookie != "" {
			req.AddCookie(&http.Cookie{Name: "session", Value: cookie})
			req.AddCookie(&http.Cookie{Name: "__csrf", Value: "csrf"})
			req.Header.Set("X-CSRF-Token", "csrf")
		}
		if bearer != "" {
			req.Header.Set("Authorization", "Bearer "+bearer)
		}
		var decisions []string
		req = req.WithContext(services.WithAuthorizationObserver(ctx, func(command string) { decisions = append(decisions, command) }))
		out := httptest.NewRecorder()
		router.ServeHTTP(out, req)
		require.Equal(t, status, out.Code, out.Body.String())
		require.Equal(t, []string{command}, decisions)
		return out
	}
	assertRetained := func(t *testing.T) {
		t.Helper()
		rows, err := f.q.ListVariables(f.ctx, f.repoID)
		require.NoError(t, err)
		require.Len(t, rows, 2)
		for _, row := range rows {
			require.Equal(t, map[string]string{"KEEP": "retained-value", "PRIVATE": "private-value"}[row.Name], row.Value)
		}
	}
	for _, actor := range []struct {
		name, cookie, bearer, code string
		status                     int
	}{
		{"member", memberCookie, "", "permission", 403}, {"external", "", external, "never", 403}, {"app", "", app, "never", 403},
		{"run", "", run, "permission", 403}, {"machine", "", machine, "permission", 403},
		{"read scope cannot disclose values", "", f.token(f.owner, "variables-readonly", "read:repository,via:codex", true), "permission", 403},
		{"anonymous", "", "", "unauthenticated", 401},
	} {
		for _, op := range []struct{ method, path, body, command string }{
			{"GET", "", "", "variables.read"}, {"GET", "/KEEP", "", "variables.read"},
			{"POST", "", `{"name":"KEEP","value":"changed"}`, "variables.set"}, {"DELETE", "/KEEP", "", "variables.delete"},
		} {
			t.Run(actor.name+"/"+op.method+op.path, func(t *testing.T) {
				out := call(t, op.method, op.path, actor.cookie, actor.bearer, op.body, op.command, actor.status)
				require.Contains(t, out.Body.String(), `"code":"`+actor.code+`"`)
				require.NotContains(t, out.Body.String(), "retained-value")
				require.NotContains(t, out.Body.String(), "private-value")
				assertRetained(t)
			})
		}
	}
	t.Run("maintainer retains no owner configuration authority", func(t *testing.T) {
		_, err := f.pool.Exec(f.ctx, `UPDATE collaborators SET permission='admin' WHERE repository_id=$1 AND user_id=$2`, f.repoID, f.other.ID)
		require.NoError(t, err)
		call(t, "GET", "", memberCookie, "", "", "variables.read", 403)
		call(t, "POST", "", memberCookie, "", `{"name":"KEEP","value":"changed"}`, "variables.set", 403)
		call(t, "DELETE", "/KEEP", memberCookie, "", "", "variables.delete", 403)
		assertRetained(t)
	})
	t.Run("owner CRUD shares one connection with the real ownership guard", func(t *testing.T) {
		value := strings.Repeat("\t", 48*1024)
		body, err := json.Marshal(services.SetVariableInput{Name: "BUILD_FLAVOR", Value: value})
		require.NoError(t, err)
		require.Greater(t, len(body), 64<<10)
		call(t, "POST", "", ownerCookie, "", string(body), "variables.set", 201)
		detail := call(t, "GET", "/BUILD_FLAVOR", ownerCookie, "", "", "variables.read", 200)
		var got services.VariableResponse
		require.NoError(t, json.Unmarshal(detail.Body.Bytes(), &got))
		require.Equal(t, value, got.Value)
		list := call(t, "GET", "", ownerCookie, "", "", "variables.read", 200)
		require.Contains(t, list.Body.String(), "BUILD_FLAVOR")
		call(t, "POST", "", ownerCookie, "", `{"name":"BUILD_FLAVOR","value":"release"}`, "variables.set", 201)
		row, err := f.q.GetVariableByName(f.ctx, db.GetVariableByNameParams{RepositoryID: f.repoID, Name: "BUILD_FLAVOR"})
		require.NoError(t, err)
		require.Equal(t, "release", row.Value)
		call(t, "DELETE", "/BUILD_FLAVOR", ownerCookie, "", "", "variables.delete", 204)
		_, err = f.q.GetVariableByName(f.ctx, db.GetVariableByNameParams{RepositoryID: f.repoID, Name: "BUILD_FLAVOR"})
		require.ErrorIs(t, err, pgx.ErrNoRows)
		assertRetained(t)
	})
	t.Run("invalid input never changes stored values", func(t *testing.T) {
		for _, body := range []string{`{"name":"bad-name","value":"value"}`, `{"name":"KEEP","value":""}`, `{"name":"KEEP","value":"nul\u0000value"}`} {
			call(t, "POST", "", ownerCookie, "", body, "variables.set", 422)
			call(t, "POST", "", "", external, body, "variables.set", 403)
			assertRetained(t)
		}
	})
	for _, mode := range []string{"payload substitution", "name substitution", "expired after admission"} {
		t.Run(mode, func(t *testing.T) {
			probe := &variableAdmissionProbe{VariableRouteService: service, replaceValue: mode == "payload substitution", replaceName: mode == "name substitution"}
			status := 403
			if mode == "expired after admission" {
				status = 401
				probe.before = func() {
					_, err := f.pool.Exec(f.ctx, `UPDATE auth_sessions SET expires_at=now()-interval '1 second' WHERE session_key=$1`, ownerHash)
					require.NoError(t, err)
				}
			}
			handler.Service = probe
			defer func() {
				handler.Service = service
				_, err := f.pool.Exec(f.ctx, `UPDATE auth_sessions SET expires_at=now()+interval '1 hour' WHERE session_key=$1`, ownerHash)
				require.NoError(t, err)
			}()
			if mode == "name substitution" {
				call(t, "GET", "/KEEP", ownerCookie, "", "", "variables.read", 403)
				call(t, "DELETE", "/KEEP", ownerCookie, "", "", "variables.delete", 403)
			} else {
				call(t, "POST", "", ownerCookie, "", `{"name":"KEEP","value":"changed"}`, "variables.set", status)
			}
			assertRetained(t)
		})
	}
	t.Run("direct service checks credentials before private lookup", func(t *testing.T) {
		ctx := middleware.ContextWithAuthInfo(f.ctx, &middleware.AuthInfo{User: &f.owner, SessionHash: ownerHash})
		decisions := 0
		ctx = services.WithAuthorizationObserver(ctx, func(command string) { require.Equal(t, "variables.read", command); decisions++ })
		rows, err := service.ListVariables(ctx, &f.owner, "gate-owner", "app")
		require.NoError(t, err)
		require.Len(t, rows, 2)
		require.Equal(t, 1, decisions)
		_, err = service.GetVariable(f.ctx, &f.owner, "gate-owner", "missing", "KEEP")
		var refusal *services.AccessError
		require.ErrorAs(t, err, &refusal)
		require.Equal(t, 401, refusal.Status)
		_, err = f.pool.Exec(f.ctx, `UPDATE auth_sessions SET expires_at=now()-interval '1 second' WHERE session_key=$1`, ownerHash)
		require.NoError(t, err)
		_, err = service.GetVariable(ctx, &f.owner, "gate-owner", "missing", "KEEP")
		require.ErrorAs(t, err, &refusal)
		require.Equal(t, 401, refusal.Status)
	})
}
