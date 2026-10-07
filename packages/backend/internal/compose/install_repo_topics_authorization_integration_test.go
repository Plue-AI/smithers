package compose

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
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

type topicAdmissionProbe struct {
	routes.RepoRouteService
	before  func()
	replace string
	actor   *db.User
}

func (p *topicAdmissionProbe) ReplaceRepoTopics(ctx context.Context, actor *db.User, owner, repo string, topics []string) ([]string, error) {
	if p.before != nil {
		p.before()
	}
	switch p.replace {
	case "payload":
		topics = []string{"substituted"}
	case "repository":
		repo = "different"
	}
	if p.actor != nil {
		actor = p.actor
	}
	return p.RepoRouteService.ReplaceRepoTopics(ctx, actor, owner, repo, topics)
}

func TestInstallRepoTopicsAuthorizationPostgres(t *testing.T) {
	f := newLandingGateFixtureWithFactory(t, nil, "", true)
	pool, err := postgresfixture.Open(f.ctx, f.pool.Config().ConnConfig.ConnString(), 1)
	require.NoError(t, err)
	defer pool.Close()
	q := db.New(pool)
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode, cfg.Auth.SessionCookieName, cfg.Auth.SessionRefreshWindow = "selfhost", "session", "0s"
	cfg.Server.PublicURL = "http://example.com"
	cfg.Server.AllowedOrigins = []string{cfg.Server.PublicURL}
	service := services.NewProductRepoServiceWithPool(q, nil, pool, services.WithRepoInstallAuthorization(pool))
	probe := &topicAdmissionProbe{RepoRouteService: service}
	router := buildRouterCompat(cfg, q, pool,
		&routes.RepoHandler{Service: probe}, &routes.AuthHandler{}, &routes.UserHandler{}, &routes.SSHKeyHandler{}, &routes.LabelHandler{},
		&routes.OrgHandler{}, &routes.LandingHandler{}, &routes.SearchHandler{Service: &mockRouterSearchService{}}, &routes.IssueHandler{Service: services.NewIssueService(f.q)},
		nil, &routes.GitSmartHandler{Service: &mockRouterGitService{}},
		nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, &routes.WorkspaceHandler{}, nil, nil, nil, nil, nil, nil)

	session := func(user db.User, raw string) string {
		sum := sha256.Sum256([]byte(raw))
		hash := hex.EncodeToString(sum[:])
		_, err := f.q.CreateAuthSession(f.ctx, db.CreateAuthSessionParams{UserID: user.ID, Username: user.Username, SessionKey: hash, ExpiresAt: time.Now().Add(time.Hour)})
		require.NoError(t, err)
		return hash
	}
	ownerCookie, memberCookie := "topics-owner", "topics-member"
	ownerHash := session(f.owner, ownerCookie)
	session(f.other, memberCookie)
	maintainer, err := f.q.CreateUser(f.ctx, db.CreateUserParams{Username: "topics-maintainer", LowerUsername: "topics-maintainer"})
	require.NoError(t, err)
	_, err = f.pool.Exec(f.ctx, `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,'admin')`, f.repoID, maintainer.ID)
	require.NoError(t, err)
	maintainerCookie := "topics-maintainer"
	session(maintainer, maintainerCookie)
	app := f.token(f.owner, "topics-app", "write:repository,via:smithers,terminal-session:"+liveAppTurnCredentialFixture(t, f.pool, f.owner.ID)+"/1", true)
	external := f.token(f.owner, "topics-external", "write:repository,via:codex", true)
	run := f.token(f.owner, "topics-run", "write:repository", true)
	machine := f.token(f.owner, "topics-machine", "write:repository,"+middleware.WorkspaceRestrictionScope("11111111-1111-4111-8111-111111111111"), true)
	limited := f.token(f.owner, "topics-limited", "read:repository,via:codex", true)
	call := func(t *testing.T, cookie, bearer, body string, status int) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest("PUT", cfg.Server.PublicURL+"/api/repos/gate-owner/app/topics", strings.NewReader(body))
		req.Header.Set("Origin", cfg.Server.PublicURL)
		req.Header.Set("Content-Type", "application/json")
		if cookie != "" {
			req.AddCookie(&http.Cookie{Name: "session", Value: cookie})
			req.AddCookie(&http.Cookie{Name: "__csrf", Value: "topics-csrf"})
			req.Header.Set("X-CSRF-Token", "topics-csrf")
		}
		if bearer != "" {
			req.Header.Set("Authorization", "Bearer "+bearer)
		}
		var commands []string
		req = req.WithContext(services.WithAuthorizationObserver(req.Context(), func(command string) { commands = append(commands, command) }))
		out := httptest.NewRecorder()
		router.ServeHTTP(out, req)
		require.Equal(t, status, out.Code, out.Body.String())
		require.Equal(t, []string{"repo.topics.update"}, commands)
		return out
	}
	retained := func() {
		row, err := f.q.GetRepoByID(f.ctx, f.repoID)
		require.NoError(t, err)
		require.Equal(t, []string{"retained"}, row.Topics)
	}
	_, err = f.q.UpdateRepoTopics(f.ctx, db.UpdateRepoTopicsParams{ID: f.repoID, Topics: []string{"retained"}})
	require.NoError(t, err)
	for _, a := range []struct {
		name, cookie, token, code string
		status                    int
	}{
		{"member", memberCookie, "", "permission", 403}, {"maintainer", maintainerCookie, "", "permission", 403}, {"app", "", app, "never", 403}, {"external", "", external, "never", 403}, {"run", "", run, "permission", 403}, {"machine", "", machine, "permission", 403}, {"scope", "", limited, "permission", 403}, {"anonymous", "", "", "unauthenticated", 401},
	} {
		t.Run(a.name, func(t *testing.T) {
			out := call(t, a.cookie, a.token, `{"topics":["changed"]}`, a.status)
			require.Contains(t, out.Body.String(), `"code":"`+a.code+`"`)
			retained()
		})
	}
	for _, substitution := range []string{"payload", "repository", "actor"} {
		t.Run(substitution+" after admission", func(t *testing.T) {
			probe.replace = substitution
			if substitution == "actor" {
				probe.actor = &f.other
			}
			defer func() { probe.replace = ""; probe.actor = nil }()
			call(t, ownerCookie, "", `{"topics":["changed"]}`, 403)
			retained()
		})
	}
	t.Run("expiry after admission", func(t *testing.T) {
		probe.before = func() {
			_, err := f.pool.Exec(f.ctx, `UPDATE auth_sessions SET expires_at=now()-interval '1 second' WHERE session_key=$1`, ownerHash)
			require.NoError(t, err)
		}
		defer func() {
			probe.before = nil
			_, err := f.pool.Exec(f.ctx, `UPDATE auth_sessions SET expires_at=now()+interval '1 hour' WHERE session_key=$1`, ownerHash)
			require.NoError(t, err)
		}()
		call(t, ownerCookie, "", `{"topics":["changed"]}`, 401)
		retained()
	})
	t.Run("validation is atomic", func(t *testing.T) { call(t, ownerCookie, "", `{"topics":["valid","bad topic"]}`, 422); retained() })
	t.Run("malformed body", func(t *testing.T) { call(t, ownerCookie, "", `{"topics":3}`, 400); retained() })
	t.Run("expiry while topic write waits rolls back topics", func(t *testing.T) {
		ctx, cancel := context.WithTimeout(f.ctx, 12*time.Second)
		defer cancel()
		// A row lock would stop the earlier credential fence's repository read.
		// Hold only the actual UPDATE inside PostgreSQL to exercise the final fence.
		_, err := f.pool.Exec(ctx, `CREATE FUNCTION delay_topics_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(hashtextextended('fr4b_topics_expiry',0)); RETURN NEW; END $$`)
		require.NoError(t, err)
		_, err = f.pool.Exec(ctx, `CREATE TRIGGER delay_topics_write BEFORE UPDATE OF topics ON repositories FOR EACH ROW EXECUTE FUNCTION delay_topics_write()`)
		require.NoError(t, err)
		defer func() {
			_, err := f.pool.Exec(f.ctx, `DROP TRIGGER delay_topics_write ON repositories`)
			require.NoError(t, err)
			_, err = f.pool.Exec(f.ctx, `DROP FUNCTION delay_topics_write()`)
			require.NoError(t, err)
		}()
		held, err := f.pool.Begin(ctx)
		require.NoError(t, err)
		defer held.Rollback(context.Background())
		_, err = held.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('fr4b_topics_expiry',0))`)
		require.NoError(t, err)
		deadline := time.Now().Add(4 * time.Second)
		_, err = f.pool.Exec(ctx, `UPDATE auth_sessions SET expires_at=$2 WHERE session_key=$1`, ownerHash, deadline)
		require.NoError(t, err)
		defer func() {
			_, err := f.pool.Exec(f.ctx, `UPDATE auth_sessions SET expires_at=now()+interval '1 hour' WHERE session_key=$1`, ownerHash)
			require.NoError(t, err)
		}()
		req := httptest.NewRequest("PUT", cfg.Server.PublicURL+"/api/repos/gate-owner/app/topics", strings.NewReader(`{"topics":["changed"]}`))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Origin", cfg.Server.PublicURL)
		req.Header.Set("X-CSRF-Token", "topics-csrf")
		req.AddCookie(&http.Cookie{Name: middleware.CSRFCookieName, Value: "topics-csrf"})
		req.AddCookie(&http.Cookie{Name: "session", Value: ownerCookie})
		var commands []string
		req = req.WithContext(services.WithAuthorizationObserver(ctx, func(command string) { commands = append(commands, command) }))
		done := make(chan *httptest.ResponseRecorder, 1)
		go func() { out := httptest.NewRecorder(); router.ServeHTTP(out, req); done <- out }()
		require.Eventually(t, func() bool {
			var count int
			err := f.pool.QueryRow(ctx, `SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%UPDATE repositories%'`).Scan(&count)
			return err == nil && count == 1
		}, 3*time.Second, 10*time.Millisecond)
		timer := time.NewTimer(time.Until(deadline) + 25*time.Millisecond)
		defer timer.Stop()
		select {
		case <-timer.C:
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
		require.NoError(t, held.Commit(ctx))
		select {
		case out := <-done:
			require.Equal(t, 401, out.Code, out.Body.String())
			require.Contains(t, out.Body.String(), `"code":"unauthenticated"`)
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
		require.Equal(t, []string{"repo.topics.update"}, commands)
		retained()
	})
	t.Run("owner normalizes and clears", func(t *testing.T) {
		out := call(t, ownerCookie, "", `{"topics":[" Go ","go","api"],"ignored":"retained decoder behavior"}`, 200)
		require.JSONEq(t, `{"topics":["go","api"]}`, out.Body.String())
		for _, body := range []string{`{"topics":null}`, `{}`, `{"topics":[]}`} {
			out = call(t, ownerCookie, "", body, 200)
			require.JSONEq(t, `{"topics":[]}`, out.Body.String())
		}
	})
	t.Run("direct service needs a credential", func(t *testing.T) {
		_, err := service.ReplaceRepoTopics(f.ctx, &f.owner, "gate-owner", "app", []string{"bypass"})
		var access *services.AccessError
		require.ErrorAs(t, err, &access)
		require.Equal(t, 401, access.Status)
		ctx := middleware.ContextWithAuthInfo(f.ctx, &middleware.AuthInfo{User: &f.owner, SessionHash: ownerHash})
		var commands []string
		ctx = services.WithAuthorizationObserver(ctx, func(command string) { commands = append(commands, command) })
		result, err := service.ReplaceRepoTopics(ctx, &f.owner, "gate-owner", "app", []string{" Direct "})
		require.NoError(t, err)
		require.Equal(t, []string{"direct"}, result)
		require.Equal(t, []string{"repo.topics.update"}, commands)
	})
}
