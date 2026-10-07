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

	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/stretchr/testify/require"
)

type labelAdmissionProbe struct {
	routes.LabelRouteService
	before  func()
	replace bool
}

func (p *labelAdmissionProbe) CreateLabel(ctx context.Context, actor *db.User, owner, repo string, input services.CreateLabelInput) (db.Label, error) {
	if p.before != nil {
		p.before()
	}
	if p.replace {
		input.Name = "substituted"
	}
	return p.LabelRouteService.CreateLabel(ctx, actor, owner, repo, input)
}

func TestInstallLabelMutationsPostgres(t *testing.T) {
	f := newLandingGateFixtureWithFactory(t, nil, "", true)
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Auth.SessionCookieName = "session"
	cfg.Server.PublicURL = "http://example.com"
	cfg.Server.AllowedOrigins = []string{cfg.Server.PublicURL}
	service := services.NewLabelService(f.q, services.WithLabelInstallAuthorization(f.q, f.pool))
	handler := &routes.LabelHandler{Service: service}
	router := buildRouterCompat(cfg, f.q, f.pool,
		&routes.RepoHandler{Service: services.NewRepoService(f.q, nil, "")}, &routes.AuthHandler{}, &routes.UserHandler{}, &routes.SSHKeyHandler{}, handler,
		&routes.OrgHandler{}, &routes.LandingHandler{}, &routes.SearchHandler{Service: &mockRouterSearchService{}}, &routes.IssueHandler{Service: services.NewIssueService(f.q)},
		nil, &routes.GitSmartHandler{Service: &mockRouterGitService{}},
		nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, &routes.WorkspaceHandler{}, nil, nil, nil, nil, nil, nil)
	cookie := func(user db.User, value string) string {
		digest := sha256.Sum256([]byte(value))
		hash := hex.EncodeToString(digest[:])
		_, err := f.q.CreateAuthSession(f.ctx, db.CreateAuthSessionParams{UserID: user.ID, Username: user.Username, SessionKey: hash, ExpiresAt: time.Now().Add(time.Hour)})
		require.NoError(t, err)
		return hash
	}
	ownerCookie, memberCookie := "labels-owner", "labels-member"
	ownerHash := cookie(f.owner, ownerCookie)
	cookie(f.other, memberCookie)
	label, err := f.q.CreateLabel(f.ctx, db.CreateLabelParams{RepositoryID: f.repoID, Name: "retained", Color: "#abcdef", Description: "unchanged"})
	require.NoError(t, err)
	external := f.token(f.owner, "labels-external", "write:repository,via:codex", true)
	app := f.token(f.owner, "labels-app", "write:repository,via:smithers,terminal-session:"+liveAppTurnCredentialFixture(t, f.pool, f.owner.ID)+"/1", true)
	run := f.token(f.owner, "labels-run", "write:repository", true)
	machine := f.token(f.owner, "labels-machine", "write:repository,"+middleware.WorkspaceRestrictionScope("11111111-1111-4111-8111-111111111111"), true)
	limited := f.token(f.owner, "labels-limited", "read:repository,via:codex", true)
	call := func(t *testing.T, method, path, cookie, bearer, body, command string, status int) *httptest.ResponseRecorder {
		t.Helper()
		request := httptest.NewRequest(method, cfg.Server.PublicURL+"/api/repos/gate-owner/app"+path, strings.NewReader(body))
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Origin", cfg.Server.PublicURL)
		if cookie != "" {
			request.AddCookie(&http.Cookie{Name: "session", Value: cookie})
			request.AddCookie(&http.Cookie{Name: "__csrf", Value: "labels-csrf"})
			request.Header.Set("X-CSRF-Token", "labels-csrf")
		}
		if bearer != "" {
			request.Header.Set("Authorization", "Bearer "+bearer)
		}
		var decisions []string
		request = request.WithContext(services.WithAuthorizationObserver(request.Context(), func(command string) { decisions = append(decisions, command) }))
		out := httptest.NewRecorder()
		router.ServeHTTP(out, request)
		require.Equal(t, status, out.Code, out.Body.String())
		require.Equal(t, []string{command}, decisions)
		return out
	}
	for _, actor := range []struct {
		name, cookie, bearer, code string
		status                     int
	}{
		{"member", memberCookie, "", "permission", 403},
		{"external", "", external, "never", 403}, {"app", "", app, "never", 403},
		{"run", "", run, "permission", 403}, {"machine", "", machine, "permission", 403},
		{"scope", "", limited, "permission", 403}, {"anonymous", "", "", "unauthenticated", 401},
	} {
		for _, op := range []struct{ method, path, body, command string }{
			{"POST", "/labels", `{"name":"changed","color":"ff0000"}`, "labels.create"},
			{"PATCH", fmt.Sprintf("/labels/%d", label.ID), `{"name":"changed"}`, "labels.update"},
			{"DELETE", fmt.Sprintf("/labels/%d", label.ID), "", "labels.delete"},
		} {
			t.Run(actor.name+"/"+op.command, func(t *testing.T) {
				out := call(t, op.method, op.path, actor.cookie, actor.bearer, op.body, op.command, actor.status)
				require.Contains(t, out.Body.String(), `"code":"`+actor.code+`"`)
				retained, err := f.q.GetLabelByID(f.ctx, db.GetLabelByIDParams{RepositoryID: f.repoID, ID: label.ID})
				require.NoError(t, err)
				require.Equal(t, "retained", retained.Name)
				count, err := f.q.CountLabelsByRepo(f.ctx, f.repoID)
				require.NoError(t, err)
				require.EqualValues(t, 1, count)
			})
		}
	}
	t.Run("owner uses the existing CRUD boundary", func(t *testing.T) {
		created := call(t, "POST", "/labels", ownerCookie, "", `{"name":"owned","color":"aabbcc"}`, "labels.create", 201)
		var row db.Label
		require.NoError(t, json.Unmarshal(created.Body.Bytes(), &row))
		require.Positive(t, row.ID)
		updated := call(t, "PATCH", fmt.Sprintf("/labels/%d", row.ID), ownerCookie, "", `{"description":"updated"}`, "labels.update", 200)
		require.Contains(t, updated.Body.String(), `"description":"updated"`)
		require.Contains(t, updated.Body.String(), `"name":"owned"`)
		call(t, "DELETE", fmt.Sprintf("/labels/%d", row.ID), ownerCookie, "", "", "labels.delete", 204)
		_, err := f.q.GetLabelByID(f.ctx, db.GetLabelByIDParams{RepositoryID: f.repoID, ID: row.ID})
		require.ErrorIs(t, err, pgx.ErrNoRows)
	})
	t.Run("escaped description retains the existing API body allowance", func(t *testing.T) {
		description := strings.Repeat("\t", 48*1024)
		body, err := json.Marshal(services.CreateLabelInput{Name: "escaped", Color: "112233", Description: description})
		require.NoError(t, err)
		require.Greater(t, len(body), 64<<10)
		created := call(t, "POST", "/labels", ownerCookie, "", string(body), "labels.create", 201)
		var row db.Label
		require.NoError(t, json.Unmarshal(created.Body.Bytes(), &row))
		stored, err := f.q.GetLabelByID(f.ctx, db.GetLabelByIDParams{RepositoryID: f.repoID, ID: row.ID})
		require.NoError(t, err)
		require.Equal(t, description, stored.Description)
		call(t, "DELETE", fmt.Sprintf("/labels/%d", row.ID), ownerCookie, "", "", "labels.delete", 204)
	})
	for _, mode := range []string{"payload substitution", "expired after admission", "demoted after admission", "removed after admission"} {
		t.Run(mode, func(t *testing.T) {
			probe := &labelAdmissionProbe{LabelRouteService: service, replace: mode == "payload substitution"}
			status := 403
			if mode == "expired after admission" {
				status = 401
				probe.before = func() {
					_, err := f.pool.Exec(f.ctx, `UPDATE auth_sessions SET expires_at=now()-interval '1 second' WHERE session_key=$1`, ownerHash)
					require.NoError(t, err)
				}
			}
			if mode == "demoted after admission" || mode == "removed after admission" {
				if mode == "removed after admission" {
					status = 401
				}
				probe.before = func() {
					expectedRole := services.InstallMember
					if mode == "demoted after admission" {
						_, err := f.pool.Exec(f.ctx, `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,'write')`, f.repoID, f.owner.ID)
						require.NoError(t, err)
					} else {
						expectedRole = ""
						_, err := f.pool.Exec(f.ctx, `DELETE FROM collaborators WHERE repository_id=$1 AND user_id=$2`, f.repoID, f.owner.ID)
						require.NoError(t, err)
					}
					_, err := f.pool.Exec(f.ctx, `UPDATE self_host_owners SET user_id=$1 WHERE singleton`, f.other.ID)
					require.NoError(t, err)
					role, err := services.InstallRoleOf(f.ctx, f.q, f.owner.ID)
					require.NoError(t, err)
					require.Equal(t, expectedRole, role)
				}
			}
			handler.Service = probe
			defer func() {
				handler.Service = service
				_, err := f.pool.Exec(f.ctx, `UPDATE self_host_owners SET user_id=$1 WHERE singleton`, f.owner.ID)
				require.NoError(t, err)
				_, err = f.pool.Exec(f.ctx, `UPDATE auth_sessions SET expires_at=now()+interval '1 hour' WHERE session_key=$1`, ownerHash)
				require.NoError(t, err)
			}()
			call(t, "POST", "/labels", ownerCookie, "", `{"name":"admitted","color":"112233"}`, "labels.create", status)
			count, err := f.q.CountLabelsByRepo(f.ctx, f.repoID)
			require.NoError(t, err)
			require.EqualValues(t, 1, count)
		})
	}
	t.Run("direct service entry authenticates once", func(t *testing.T) {
		ctx := middleware.ContextWithAuthInfo(f.ctx, &middleware.AuthInfo{User: &f.owner, SessionHash: ownerHash})
		decisions := 0
		ctx = services.WithAuthorizationObserver(ctx, func(command string) { require.Equal(t, "labels.create", command); decisions++ })
		row, err := service.CreateLabel(ctx, &f.owner, "gate-owner", "app", services.CreateLabelInput{Name: "direct", Color: "123abc"})
		require.NoError(t, err)
		require.Positive(t, row.ID)
		require.Equal(t, 1, decisions)
		_, err = service.CreateLabel(f.ctx, &f.owner, "gate-owner", "app", services.CreateLabelInput{Name: "uncredentialed", Color: "123abc"})
		var refusal *services.AccessError
		require.ErrorAs(t, err, &refusal)
		require.Equal(t, 401, refusal.Status)
	})
	t.Run("direct expired credential precedes private lookup and validation", func(t *testing.T) {
		_, err := f.pool.Exec(f.ctx, `UPDATE auth_sessions SET expires_at=now()-interval '1 second' WHERE session_key=$1`, ownerHash)
		require.NoError(t, err)
		ctx := middleware.ContextWithAuthInfo(f.ctx, &middleware.AuthInfo{User: &f.owner, SessionHash: ownerHash})
		for _, repo := range []string{"app", "missing"} {
			_, err := service.CreateLabel(ctx, &f.owner, "gate-owner", repo, services.CreateLabelInput{})
			var refusal *services.AccessError
			require.ErrorAs(t, err, &refusal)
			require.Equal(t, 401, refusal.Status)
			require.Equal(t, "unauthenticated", refusal.Code)
		}
	})

}
