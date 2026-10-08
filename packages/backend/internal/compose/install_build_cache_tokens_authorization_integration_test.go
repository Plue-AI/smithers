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

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

func installBuildCacheTokensRouter(cfg *config.Config, pool *pgxpool.Pool, service routes.BuildCacheRouteService) http.Handler {
	return buildRouter(
		cfg,
		db.New(pool),
		pool, // pool
		&routes.RepoHandler{},
		nil, // mirrorSyncHandler
		&routes.AuthHandler{},
		&routes.UserHandler{},
		&routes.SSHKeyHandler{},
		nil, // deployKeyHandler
		&routes.LabelHandler{},

		&routes.OrgHandler{},
		&routes.LandingHandler{},
		&routes.BuildCacheHandler{Service: service},
		nil, // stackHandler
		&routes.SearchHandler{Service: &mockRouterSearchService{}},
		&routes.IssueHandler{},
		nil, // wikiService
		&routes.GitSmartHandler{Service: &mockRouterGitService{}},
		nil, // notificationHandler
		nil, // adminUserHandler
		nil, // adminOrgHandler
		nil, // adminSystemMetricsHandler
		nil, // adminGitHubAppHandler
		nil, // adminAuditHandler
		nil, // webhookHandler
		nil, // secretHandler
		nil, // providerConnectionHandler
		nil, // variableHandler
		nil, // billingHandler
		nil, // protectedBookmarkHandler
		nil, // commitStatusHandler
		nil, // lfsHandler
		nil, // jjVCSHandler
		nil, // agentInternalHandler
		nil, // agentSessionHandler
		nil, // agentSessionStreamHandler
		nil, // approvalsHandler
		nil, // canaryReportHandler
		nil, // workflowHandler
		nil, // workflowCacheHandler
		nil, // workflowArtifactHandler
		nil, // issueEventHandler
		&routes.WorkspaceHandler{},
		nil, // workspaceInternalHandler
		&routes.RepositoryJobHandler{},
		nil, // gitHubProxyHandler
		nil, // gitHubRepoListHandler
		nil, // gitHubUserReposHandler
		nil, // gitHubSyncedReposHandler
		nil, // gitHubImportHandler
		nil, // workspaceTerminalHandler
		nil, // telemetryHandler
		nil, // featureFlagHandler
		nil, // oauth2Handler
		nil, // gitHubWebhookHandler
		nil, // smithersMetrics
	)
}

func TestInstallBuildCacheTokensAuthorizationPostgres(t *testing.T) {
	f := newLandingGateFixtureWithFactory(t, nil, "", true)
	pool, err := postgresfixture.Open(f.ctx, f.pool.Config().ConnConfig.ConnString(), 1)
	require.NoError(t, err)
	defer pool.Close()
	q := db.New(pool)
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Auth.SessionCookieName = "session"
	cfg.Auth.SessionRefreshWindow = "0s"
	cfg.Server.PublicURL = "http://example.com"
	cfg.Server.AllowedOrigins = []string{cfg.Server.PublicURL}
	service := services.NewBuildCacheService(services.NewPgxBuildCacheStore(q, pool), nil, 0, services.WithBuildCacheInstallAuthorization(pool))
	router := installBuildCacheTokensRouter(cfg, pool, service)
	session := func(user db.User, raw string) string {
		sum := sha256.Sum256([]byte(raw))
		hash := hex.EncodeToString(sum[:])
		_, err := q.CreateAuthSession(f.ctx, db.CreateAuthSessionParams{UserID: user.ID, Username: user.Username, SessionKey: hash, ExpiresAt: time.Now().Add(time.Hour)})
		require.NoError(t, err)
		return hash
	}
	ownerHash := session(f.owner, "cache-owner")
	session(f.other, "cache-member")
	maintainer, err := q.CreateUser(f.ctx, db.CreateUserParams{Username: "cache-maintainer", LowerUsername: "cache-maintainer"})
	require.NoError(t, err)
	_, err = f.pool.Exec(f.ctx, `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,'admin')`, f.repoID, maintainer.ID)
	require.NoError(t, err)
	session(maintainer, "cache-maintainer")
	app := f.token(f.owner, "cache-app", "write:repository,via:smithers,terminal-session:"+liveAppTurnCredentialFixture(t, f.pool, f.owner.ID)+"/1", true)
	external := f.token(f.owner, "cache-external", "write:repository,via:codex", true)
	run := f.token(f.owner, "cache-run", "write:repository", true)
	machine := f.token(f.owner, "cache-machine", "write:repository,"+middleware.WorkspaceRestrictionScope("11111111-1111-4111-8111-111111111111"), true)
	limited := f.token(f.owner, "cache-limited", "read:repository", false)
	request := func(ctx context.Context, method, path, cookie, token, body string) *http.Request {
		req := httptest.NewRequest(method, cfg.Server.PublicURL+"/api/repos/gate-owner/app/build-cache/tokens"+path, strings.NewReader(body)).WithContext(ctx)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Origin", cfg.Server.PublicURL)
		if cookie != "" {
			req.AddCookie(&http.Cookie{Name: "session", Value: cookie})
			req.AddCookie(&http.Cookie{Name: middleware.CSRFCookieName, Value: "cache-csrf"})
			req.Header.Set("X-CSRF-Token", "cache-csrf")
		}
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		return req
	}
	call := func(t *testing.T, method, path, cookie, token, body string, status int) *httptest.ResponseRecorder {
		t.Helper()
		ctx, cancel := context.WithTimeout(f.ctx, 7*time.Second)
		defer cancel()
		commands := []string{}
		ctx = services.WithAuthorizationObserver(ctx, func(command string) { commands = append(commands, command) })
		out := httptest.NewRecorder()
		router.ServeHTTP(out, request(ctx, method, path, cookie, token, body))
		require.Equal(t, status, out.Code, out.Body.String())
		command := map[string]string{"GET": "cache.tokens.list", "POST": "cache.tokens.create", "DELETE": "cache.tokens.revoke"}[method]
		require.Equal(t, []string{command}, commands)
		return out
	}
	count := func(want int) {
		var got int
		require.NoError(t, f.pool.QueryRow(f.ctx, `SELECT count(*) FROM build_cache_read_tokens WHERE repository_id=$1 AND revoked_at IS NULL`, f.repoID).Scan(&got))
		require.Equal(t, want, got)
	}
	for _, a := range []struct {
		name, cookie, token string
		status              int
	}{{"member", "cache-member", "", 403}, {"maintainer", "cache-maintainer", "", 403}, {"app", "", app, 403}, {"external", "", external, 403}, {"run", "", run, 403}, {"machine", "", machine, 403}, {"anonymous", "", "", 401}} {
		t.Run(a.name, func(t *testing.T) {
			for _, m := range []string{"GET", "POST", "DELETE"} {
				path := ""
				if m == "DELETE" {
					path = "/1"
				}
				call(t, m, path, a.cookie, a.token, `{"name":"refused"}`, a.status)
			}
			count(0)
		})
	}
	call(t, "POST", "", "", limited, `{}`, 403)
	call(t, "DELETE", "/1", "", limited, "", 403)
	count(0)
	created := func(body string) services.BuildCacheReadTokenCreated {
		out := call(t, "POST", "", "cache-owner", "", body, 201)
		require.Equal(t, "no-store", out.Header().Get("Cache-Control"))
		var row services.BuildCacheReadTokenCreated
		require.NoError(t, json.Unmarshal(out.Body.Bytes(), &row))
		require.NotEmpty(t, row.Token)
		require.Equal(t, "https://example.com/api/repos/gate-owner/app/build-cache", row.Endpoint)
		return row
	}
	first := created(`{"name":"  build  ","namespace_prefix":"main/"}`)
	require.Equal(t, "build", first.Name)
	require.Equal(t, "main/", first.NamespacePrefix)
	second := created("")
	count(2)
	t.Run("owner list never reveals token hashes or plaintext", func(t *testing.T) {
		out := call(t, "GET", "", "cache-owner", "", "", 200)
		var rows []services.BuildCacheReadTokenResponse
		require.NoError(t, json.Unmarshal(out.Body.Bytes(), &rows))
		require.Len(t, rows, 2)
		require.NotContains(t, out.Body.String(), first.Token)
		require.NotContains(t, out.Body.String(), "token_hash")
		call(t, "GET", "", "", limited, "", 403)
	})
	t.Run("invalid input does not create tokens", func(t *testing.T) {
		for _, body := range []string{`{"namespace_prefix":"../"}`, `{"name":3}`, `{} {}`, `{"name":"` + strings.Repeat("x", 256) + `"}`} {
			call(t, "POST", "", "cache-owner", "", body, 400)
			count(2)
		}
		call(t, "DELETE", "/invalid", "cache-owner", "", "", 400)
		call(t, "DELETE", "/0", "cache-owner", "", "", 400)
		call(t, "DELETE", "/99999999", "cache-owner", "", "", 404)
		count(2)
	})
	t.Run("bound create cannot substitute payload repository actor or command", func(t *testing.T) {
		repo, err := q.GetRepoByID(f.ctx, f.repoID)
		require.NoError(t, err)
		ctx := middleware.ContextWithAuthInfo(f.ctx, &middleware.AuthInfo{User: &f.owner, SessionHash: ownerHash})
		subject := services.InstallBuildCacheTokenSubject(&repo, 0, "bound", "main/")
		decision, err := services.Authorize(ctx, q, "cache.tokens.create", subject)
		require.NoError(t, err)
		ctx = services.WithInstallAuthorization(ctx, "cache.tokens.create", decision, subject)
		for _, change := range []string{"name", "namespace", "repository", "actor", "command"} {
			t.Run(change, func(t *testing.T) {
				r := repo
				actor := f.owner
				name, namespace := "bound", "main/"
				switch change {
				case "name":
					name = "changed"
				case "namespace":
					namespace = "other/"
				case "repository":
					r.ID++
				case "actor":
					actor = f.other
				}
				var failure error
				if change == "command" {
					_, failure = service.ListReadTokens(ctx, &r, "gate-owner/app")
				} else {
					_, failure = service.CreateReadToken(ctx, &actor, &r, "gate-owner/app", name, "", namespace)
				}
				var access *services.AccessError
				require.ErrorAs(t, failure, &access)
				require.Equal(t, 403, access.Status)
				count(2)
			})
		}
		_, err = service.CreateReadToken(f.ctx, &f.owner, &repo, "gate-owner/app", "bound", "", "main/")
		require.Error(t, err)
		count(2)
	})
	t.Run("another repository token is not revocable", func(t *testing.T) {
		other, err := q.CreateRepo(f.ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: f.owner.ID, Valid: true}, Name: "cache-other", LowerName: "cache-other", DefaultBookmark: "main"})
		require.NoError(t, err)
		foreign, err := q.CreateBuildCacheReadToken(f.ctx, db.CreateBuildCacheReadTokenParams{RepositoryID: other.ID, Name: "foreign", TokenHash: strings.Repeat("f", 64), TokenLastEight: "ffffffff"})
		require.NoError(t, err)
		call(t, "DELETE", fmt.Sprint("/", foreign.ID), "cache-owner", "", "", 404)
		rows, err := q.ListBuildCacheReadTokens(f.ctx, other.ID)
		require.NoError(t, err)
		require.Len(t, rows, 1)
		require.Equal(t, foreign.ID, rows[0].ID)
		count(2)
	})
	t.Run("bound revoke cannot select a different token", func(t *testing.T) {
		repo, err := q.GetRepoByID(f.ctx, f.repoID)
		require.NoError(t, err)
		ctx := middleware.ContextWithAuthInfo(f.ctx, &middleware.AuthInfo{User: &f.owner, SessionHash: ownerHash})
		subject := services.InstallBuildCacheTokenSubject(&repo, first.ID, "", "")
		decision, err := services.Authorize(ctx, q, "cache.tokens.revoke", subject)
		require.NoError(t, err)
		err = service.RevokeReadToken(services.WithInstallAuthorization(ctx, "cache.tokens.revoke", decision, subject), &repo, second.ID)
		var access *services.AccessError
		require.ErrorAs(t, err, &access)
		require.Equal(t, 403, access.Status)
		count(2)
	})
	t.Run("expired bound decision cannot disclose or mutate", func(t *testing.T) {
		repo, err := q.GetRepoByID(f.ctx, f.repoID)
		require.NoError(t, err)
		for _, command := range []string{"cache.tokens.create", "cache.tokens.list", "cache.tokens.revoke"} {
			ctx := middleware.ContextWithAuthInfo(f.ctx, &middleware.AuthInfo{User: &f.owner, SessionHash: ownerHash})
			id := int64(0)
			if command == "cache.tokens.revoke" {
				id = first.ID
			}
			subject := services.InstallBuildCacheTokenSubject(&repo, id, "", "")
			decision, err := services.Authorize(ctx, q, command, subject)
			require.NoError(t, err)
			ctx = services.WithInstallAuthorization(ctx, command, decision, subject)
			_, err = f.pool.Exec(f.ctx, `UPDATE auth_sessions SET expires_at=now()-interval '1 second' WHERE session_key=$1`, ownerHash)
			require.NoError(t, err)
			switch command {
			case "cache.tokens.create":
				_, err = service.CreateReadToken(ctx, &f.owner, &repo, "gate-owner/app", "", "", "")
			case "cache.tokens.list":
				_, err = service.ListReadTokens(ctx, &repo, "gate-owner/app")
			case "cache.tokens.revoke":
				err = service.RevokeReadToken(ctx, &repo, first.ID)
			}
			var access *services.AccessError
			require.ErrorAs(t, err, &access)
			require.Equal(t, 401, access.Status)
			count(2)
			_, err = f.pool.Exec(f.ctx, `UPDATE auth_sessions SET expires_at=now()+interval '1 hour' WHERE session_key=$1`, ownerHash)
			require.NoError(t, err)
		}
	})
	t.Run("expiry while revoking rolls back the token", func(t *testing.T) {
		ctx, cancel := context.WithTimeout(f.ctx, 9*time.Second)
		defer cancel()
		held, err := f.pool.Begin(ctx)
		require.NoError(t, err)
		defer held.Rollback(context.Background())
		_, err = held.Exec(ctx, `SELECT id FROM build_cache_read_tokens WHERE id=$1 FOR UPDATE`, first.ID)
		require.NoError(t, err)
		deadline := time.Now().Add(4 * time.Second)
		_, err = f.pool.Exec(ctx, `UPDATE auth_sessions SET expires_at=$2 WHERE session_key=$1`, ownerHash, deadline)
		require.NoError(t, err)
		defer func() {
			_, err := f.pool.Exec(f.ctx, `UPDATE auth_sessions SET expires_at=now()+interval '1 hour' WHERE session_key=$1`, ownerHash)
			require.NoError(t, err)
		}()
		commands := []string{}
		req := request(services.WithAuthorizationObserver(ctx, func(command string) { commands = append(commands, command) }), "DELETE", fmt.Sprint("/", first.ID), "cache-owner", "", "")
		done := make(chan *httptest.ResponseRecorder, 1)
		go func() { out := httptest.NewRecorder(); router.ServeHTTP(out, req); done <- out }()
		require.Eventually(t, func() bool {
			var count int
			err := f.pool.QueryRow(ctx, `SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%UPDATE build_cache_read_tokens%'`).Scan(&count)
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
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
		require.Equal(t, []string{"cache.tokens.revoke"}, commands)
		count(2)
		_, err = service.ResolveReadToken(f.ctx, first.Token)
		require.NoError(t, err)
	})
	t.Run("revoke removes only the selected token", func(t *testing.T) {
		call(t, "DELETE", fmt.Sprint("/", first.ID), "cache-owner", "", "", 204)
		count(1)
		_, err := service.ResolveReadToken(f.ctx, first.Token)
		require.Error(t, err)
		_, err = service.ResolveReadToken(f.ctx, second.Token)
		require.NoError(t, err)
		call(t, "DELETE", fmt.Sprint("/", first.ID), "cache-owner", "", "", 404)
		call(t, "DELETE", fmt.Sprint("/", second.ID), "cache-owner", "", "", 204)
		count(0)
	})
}
