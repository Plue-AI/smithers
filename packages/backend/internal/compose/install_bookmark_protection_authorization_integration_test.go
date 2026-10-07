package compose

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/stretchr/testify/require"
)

type bookmarkProtectionAdmissionProbe struct {
	routes.ProtectedBookmarkRouteService
	before  func()
	replace bool
}

func (p *bookmarkProtectionAdmissionProbe) UpsertProtectedBookmark(ctx context.Context, actor *db.User, owner, repo string, input services.UpsertProtectedBookmarkInput) (services.ProtectedBookmarkResponse, error) {
	if p.before != nil {
		p.before()
	}
	if p.replace {
		input.RequireReview = false
	}
	return p.ProtectedBookmarkRouteService.UpsertProtectedBookmark(ctx, actor, owner, repo, input)
}

func TestInstallBookmarkProtectionPostgres(t *testing.T) {
	f := newLandingGateFixtureWithFactory(t, nil, "", true)
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode, cfg.Auth.SessionCookieName = "selfhost", "session"
	// Keep the deliberately short expiry in the lock-wait regression. The
	// default browser loader would otherwise renew it at initial admission.
	cfg.Auth.SessionRefreshWindow = "0s"
	cfg.Server.PublicURL = "http://example.com"
	cfg.Server.AllowedOrigins = []string{cfg.Server.PublicURL}
	service := services.NewProtectedBookmarkService(f.q, services.WithProtectedBookmarkInstallAuthorization(f.pool))
	handler := &routes.ProtectedBookmarkHandler{Service: service}
	router := buildRouterCompat(cfg, f.q, f.pool, &routes.RepoHandler{}, &routes.AuthHandler{}, &routes.UserHandler{}, &routes.SSHKeyHandler{}, &routes.LabelHandler{Service: services.NewLabelService(f.q, services.WithLabelInstallAuthorization(f.q, f.pool))}, &routes.OrgHandler{}, &routes.LandingHandler{}, &routes.SearchHandler{Service: &mockRouterSearchService{}}, &routes.IssueHandler{}, nil, &routes.GitSmartHandler{Service: &mockRouterGitService{}}, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, &routes.WorkspaceHandler{}, nil, nil, nil, nil, nil, nil, handler)
	session := func(user db.User, raw string) string {
		digest := sha256.Sum256([]byte(raw))
		hash := hex.EncodeToString(digest[:])
		_, err := f.q.CreateAuthSession(f.ctx, db.CreateAuthSessionParams{UserID: user.ID, Username: user.Username, SessionKey: hash, ExpiresAt: time.Now().Add(time.Hour)})
		require.NoError(t, err)
		return hash
	}
	ownerCookie, memberCookie := "protection-owner", "protection-member"
	ownerHash := session(f.owner, ownerCookie)
	session(f.other, memberCookie)
	_, err := f.q.UpsertProtectedBookmark(f.ctx, db.UpsertProtectedBookmarkParams{RepositoryID: f.repoID, Pattern: "main", RequireReview: true, RequireHumanApprovals: 1, RequiredStatusContexts: []string{"checks"}})
	require.NoError(t, err)
	external := f.token(f.owner, "protection-external", "read:repository,write:repository,via:codex", true)
	app := f.token(f.owner, "protection-app", "read:repository,write:repository,via:smithers,terminal-session:"+liveAppTurnCredentialFixture(t, f.pool, f.owner.ID)+"/1", true)
	run := f.token(f.owner, "protection-run", "read:repository,write:repository", true)
	machine := f.token(f.owner, "protection-machine", "read:repository,write:repository,"+middleware.WorkspaceRestrictionScope("11111111-1111-4111-8111-111111111111"), true)
	call := func(method, path, cookie, bearer, body, command string, status int) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(method, cfg.Server.PublicURL+"/api/repos/gate-owner/app/protected-bookmarks"+path, strings.NewReader(body))
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
		req = req.WithContext(services.WithAuthorizationObserver(req.Context(), func(command string) { decisions = append(decisions, command) }))
		out := httptest.NewRecorder()
		router.ServeHTTP(out, req)
		require.Equal(t, status, out.Code, out.Body.String())
		require.Equal(t, []string{command}, decisions)
		return out
	}
	assertRetained := func() {
		rows, err := f.q.ListAllProtectedBookmarksByRepo(f.ctx, f.repoID)
		require.NoError(t, err)
		require.Len(t, rows, 1)
		require.Equal(t, "main", rows[0].Pattern)
		require.True(t, rows[0].RequireReview)
		require.EqualValues(t, 1, rows[0].RequireHumanApprovals)
	}
	for _, actor := range []struct {
		name, cookie, bearer, code string
		status                     int
	}{
		{"member", memberCookie, "", "permission", 403},
		{"external", "", external, "never", 403}, {"app", "", app, "never", 403},
		{"run", "", run, "permission", 403}, {"machine", "", machine, "permission", 403},
		{"scope", "", f.token(f.owner, "protection-scope", "read:user,via:codex", true), "permission", 403},
		{"anonymous", "", "", "unauthenticated", 401},
	} {
		for _, op := range []struct{ method, path, body, command string }{
			{"GET", "", "", "protected-bookmarks.read"},
			{"POST", "", `{"pattern":"main","require_review":false}`, "protected-bookmarks.upsert"},
			{"DELETE", "/main", "", "protected-bookmarks.delete"},
		} {
			t.Run(actor.name+"/"+op.command, func(t *testing.T) {
				out := call(op.method, op.path, actor.cookie, actor.bearer, op.body, op.command, actor.status)
				require.Contains(t, out.Body.String(), `"code":"`+actor.code+`"`)
				assertRetained()
			})
		}
	}
	t.Run("maintainer cannot alter or inspect owner configuration", func(t *testing.T) {
		_, err := f.pool.Exec(f.ctx, `UPDATE collaborators SET permission='admin' WHERE repository_id=$1 AND user_id=$2`, f.repoID, f.other.ID)
		require.NoError(t, err)
		call("GET", "", memberCookie, "", "", "protected-bookmarks.read", 403)
		call("POST", "", memberCookie, "", `{"pattern":"main"}`, "protected-bookmarks.upsert", 403)
		call("DELETE", "/main", memberCookie, "", "", "protected-bookmarks.delete", 403)
		assertRetained()
	})
	t.Run("owner saves lists updates and deletes literal patterns", func(t *testing.T) {
		for _, pattern := range []string{"release/*", "100%", "literal%2F"} {
			body, _ := json.Marshal(services.UpsertProtectedBookmarkInput{Pattern: pattern, RequireReview: true, RequireHumanApprovals: 2, RequiredStatusContexts: []string{"unit", "integration"}})
			call("POST", "", ownerCookie, "", string(body), "protected-bookmarks.upsert", 200)
			listed := call("GET", "", ownerCookie, "", "", "protected-bookmarks.read", 200)
			require.Contains(t, listed.Body.String(), pattern)
			updated, _ := json.Marshal(services.UpsertProtectedBookmarkInput{Pattern: pattern, RequireReview: true, RequireHumanApprovals: 3})
			result := call("POST", "", ownerCookie, "", string(updated), "protected-bookmarks.upsert", 200)
			require.Contains(t, result.Body.String(), `"require_human_approvals":3`)
			call("DELETE", "/"+url.PathEscape(pattern), ownerCookie, "", "", "protected-bookmarks.delete", 204)
			assertRetained()
		}
	})
	for _, mode := range []string{"payload substitution", "expired after admission"} {
		t.Run(mode, func(t *testing.T) {
			probe := &bookmarkProtectionAdmissionProbe{ProtectedBookmarkRouteService: service, replace: mode == "payload substitution"}
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
			call("POST", "", ownerCookie, "", `{"pattern":"main","require_review":true}`, "protected-bookmarks.upsert", status)
			assertRetained()
		})
	}
	t.Run("credential expiry during a stored row lock cannot write", func(t *testing.T) {
		label, err := f.q.CreateLabel(f.ctx, db.CreateLabelParams{RepositoryID: f.repoID, Name: "retained", Color: "#abcdef"})
		require.NoError(t, err)
		for _, target := range []struct {
			name, method, path, body, lock, query string
			id                                    any
		}{
			{"protection", "POST", "/protected-bookmarks", `{"pattern":"main","require_review":false}`, `SELECT id FROM protected_bookmarks WHERE repository_id=$1 AND pattern=$2 FOR UPDATE`, "%FROM protected_bookmarks%FOR UPDATE%", "main"},
			{"label", "PATCH", fmt.Sprintf("/labels/%d", label.ID), `{"name":"changed"}`, `SELECT id FROM labels WHERE repository_id=$1 AND id=$2 FOR UPDATE`, "%FROM labels%FOR UPDATE%", label.ID},
		} {
			t.Run(target.name, func(t *testing.T) {
				blocker, err := f.pool.Begin(f.ctx)
				require.NoError(t, err)
				defer blocker.Rollback(context.WithoutCancel(f.ctx))
				_, err = blocker.Exec(f.ctx, target.lock, f.repoID, target.id)
				require.NoError(t, err)
				deadline := time.Now().Add(2 * time.Second)
				_, err = f.pool.Exec(f.ctx, `UPDATE auth_sessions SET expires_at=$2 WHERE session_key=$1`, ownerHash, deadline)
				require.NoError(t, err)
				defer func() {
					_, err := f.pool.Exec(f.ctx, `UPDATE auth_sessions SET expires_at=now()+interval '1 hour' WHERE session_key=$1`, ownerHash)
					require.NoError(t, err)
				}()
				requestCtx, cancel := context.WithTimeout(f.ctx, 10*time.Second)
				defer cancel()
				req := httptest.NewRequest(target.method, cfg.Server.PublicURL+"/api/repos/gate-owner/app"+target.path, strings.NewReader(target.body))
				req.Header.Set("Origin", cfg.Server.PublicURL)
				req.Header.Set("Content-Type", "application/json")
				req.AddCookie(&http.Cookie{Name: "session", Value: ownerCookie})
				req.AddCookie(&http.Cookie{Name: "__csrf", Value: "csrf"})
				req.Header.Set("X-CSRF-Token", "csrf")
				decisions := 0
				req = req.WithContext(services.WithAuthorizationObserver(requestCtx, func(string) { decisions++ }))
				out := httptest.NewRecorder()
				done := make(chan struct{})
				go func() { router.ServeHTTP(out, req); close(done) }()
				require.Eventually(t, func() bool {
					var waiting bool
					err := f.pool.QueryRow(f.ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE $1)`, target.query).Scan(&waiting)
					return err == nil && waiting
				}, time.Second, 10*time.Millisecond, "the admitted request must actually wait on the stored row")
				time.Sleep(time.Until(deadline.Add(100 * time.Millisecond)))
				require.NoError(t, blocker.Rollback(f.ctx))
				select {
				case <-done:
				case <-time.After(5 * time.Second):
					t.Fatal("request did not finish after lock release")
				}
				require.Equal(t, 401, out.Code, out.Body.String())
				require.Equal(t, 1, decisions)
				assertRetained()
				kept, err := f.q.GetLabelByID(f.ctx, db.GetLabelByIDParams{RepositoryID: f.repoID, ID: label.ID})
				require.NoError(t, err)
				require.Equal(t, "retained", kept.Name)
			})
		}
	})
	t.Run("direct service authenticates once before lookup", func(t *testing.T) {
		ctx := middleware.ContextWithAuthInfo(f.ctx, &middleware.AuthInfo{User: &f.owner, SessionHash: ownerHash})
		decisions := 0
		ctx = services.WithAuthorizationObserver(ctx, func(command string) { require.Equal(t, "protected-bookmarks.read", command); decisions++ })
		rows, err := service.ListProtectedBookmarks(ctx, &f.owner, "gate-owner", "app", 1, 30)
		require.NoError(t, err)
		require.Len(t, rows, 1)
		require.Equal(t, 1, decisions)
		_, err = f.pool.Exec(f.ctx, `UPDATE auth_sessions SET expires_at=now()-interval '1 second' WHERE session_key=$1`, ownerHash)
		require.NoError(t, err)
		_, err = service.UpsertProtectedBookmark(ctx, &f.owner, "gate-owner", "missing", services.UpsertProtectedBookmarkInput{})
		var refusal *services.AccessError
		require.ErrorAs(t, err, &refusal)
		require.Equal(t, 401, refusal.Status)
		_, err = service.ListProtectedBookmarks(f.ctx, &f.owner, "gate-owner", "missing", 1, 30)
		require.ErrorAs(t, err, &refusal)
		require.Equal(t, 401, refusal.Status)
		assertRetained()
	})
}
