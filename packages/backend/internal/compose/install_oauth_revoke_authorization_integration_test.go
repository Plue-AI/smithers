package compose

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
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

type oauthRevokeAdmissionProbe struct {
	routes.OAuth2Service
	before    func()
	app, user int64
}

func (p *oauthRevokeAdmissionProbe) RevokeAllByAppAndUser(ctx context.Context, app, user int64) error {
	if p.before != nil {
		p.before()
	}
	if p.app != 0 {
		app = p.app
	}
	if p.user != 0 {
		user = p.user
	}
	return p.OAuth2Service.RevokeAllByAppAndUser(ctx, app, user)
}

func TestInstallOAuthRevokeAuthorizationPostgres(t *testing.T) {
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
	service := services.NewOAuth2ServiceWithPool(q, pool, services.WithOAuth2InstallAuthorization(pool))
	handler := &routes.OAuth2Handler{Service: service}
	router := buildRouterCompat(cfg, q, pool, &routes.RepoHandler{}, &routes.AuthHandler{}, &routes.UserHandler{}, &routes.SSHKeyHandler{}, &routes.LabelHandler{}, &routes.OrgHandler{}, &routes.LandingHandler{}, &routes.SearchHandler{Service: &mockRouterSearchService{}}, &routes.IssueHandler{}, nil, &routes.GitSmartHandler{Service: &mockRouterGitService{}},
		nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, handler, nil)
	app, err := q.CreateOAuth2Application(f.ctx, db.CreateOAuth2ApplicationParams{ClientID: services.FirstPartyClientID, Name: "Smithers", OwnerID: f.owner.ID, RedirectUris: []string{"https://example.com/callback"}, Scopes: []string{"read:user", "write:user"}})
	require.NoError(t, err)
	legacy, err := q.CreateOAuth2Application(f.ctx, db.CreateOAuth2ApplicationParams{ClientID: "retired-revoke-fixture", Name: "retired", OwnerID: f.owner.ID, RedirectUris: []string{"https://example.com/callback"}, Scopes: []string{"write:user"}})
	require.NoError(t, err)
	hash := func(raw string) string { sum := sha256.Sum256([]byte(raw)); return hex.EncodeToString(sum[:]) }
	seed := func(user, appID int64, name, scope string) string {
		t.Helper()
		raw := "smithers_oat_" + hash(name)
		_, err := q.CreateOAuth2AccessToken(f.ctx, db.CreateOAuth2AccessTokenParams{TokenHash: hash(raw), AppID: appID, UserID: user, Scopes: []string{scope}, ExpiresAt: time.Now().Add(time.Hour)})
		require.NoError(t, err)
		_, err = q.CreateOAuth2RefreshToken(f.ctx, db.CreateOAuth2RefreshTokenParams{TokenHash: hash(raw + "refresh"), AppID: appID, UserID: user, Scopes: []string{scope}, ExpiresAt: time.Now().Add(time.Hour)})
		require.NoError(t, err)
		return raw
	}
	assertLive := func(raw string) {
		t.Helper()
		_, err := q.GetOAuth2AccessTokenByHash(f.ctx, hash(raw))
		require.NoError(t, err)
		_, err = q.GetOAuth2RefreshTokenByHash(f.ctx, hash(raw+"refresh"))
		require.NoError(t, err)
	}
	call := func(token, cookie string) (*httptest.ResponseRecorder, []string) {
		t.Helper()
		req := httptest.NewRequest("POST", cfg.Server.PublicURL+"/api/oauth2/revoke-all", nil)
		ctx, cancel := context.WithTimeout(req.Context(), 10*time.Second)
		defer cancel()
		req = req.WithContext(ctx)
		req.Header.Set("Origin", cfg.Server.PublicURL)
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		if cookie != "" {
			req.AddCookie(&http.Cookie{Name: "session", Value: cookie})
			req.AddCookie(&http.Cookie{Name: middleware.CSRFCookieName, Value: "oauth-csrf"})
			req.Header.Set("X-CSRF-Token", "oauth-csrf")
		}
		commands := []string{}
		req = req.WithContext(services.WithAuthorizationObserver(req.Context(), func(command string) { commands = append(commands, command) }))
		out := httptest.NewRecorder()
		router.ServeHTTP(out, req)
		return out, commands
	}
	_, err = q.CreateAuthSession(f.ctx, db.CreateAuthSessionParams{UserID: f.owner.ID, Username: f.owner.Username, SessionKey: hash("oauth-owner"), ExpiresAt: time.Now().Add(time.Hour)})
	require.NoError(t, err)
	protected := seed(f.other.ID, app.ID, "protected-member", "write:user")
	old := seed(f.owner.ID, legacy.ID, "protected-legacy", "write:user")
	for _, actor := range []struct {
		name, token, cookie string
		status              int
	}{
		{"browser", "", "oauth-owner", 403},
		{"PAT", f.token(f.owner, "oauth-pat", "write:user", false), "", 403},
		{"external", f.token(f.owner, "oauth-external", "write:user,via:codex", true), "", 403},
		{"app", f.token(f.owner, "oauth-app", "write:user,via:smithers,terminal-session:"+liveAppTurnCredentialFixture(t, f.pool, f.owner.ID)+"/1", true), "", 403},
		{"run", f.token(f.owner, "oauth-run", "write:user", true), "", 403},
		{"machine", f.token(f.owner, "oauth-machine", "write:user,"+middleware.WorkspaceRestrictionScope("11111111-1111-4111-8111-111111111111"), true), "", 403},
		{"scope", seed(f.owner.ID, app.ID, "readonly", "read:user"), "", 403},
		{"anonymous", "", "", 401},
	} {
		t.Run(actor.name, func(t *testing.T) {
			out, commands := call(actor.token, actor.cookie)
			require.Equal(t, actor.status, out.Code, out.Body.String())
			require.Equal(t, []string{"account.oauth.revoke"}, commands)
			assertLive(protected)
			assertLive(old)
		})
	}
	for _, user := range []db.User{f.owner, f.other} {
		t.Run(user.Username+" revokes only own first-party grants", func(t *testing.T) {
			raw := seed(user.ID, app.ID, "success-"+user.Username, "write:user")
			sibling := seed(user.ID, app.ID, "sibling-"+user.Username, "write:user")
			out, commands := call(raw, "")
			require.Equal(t, 200, out.Code, out.Body.String())
			require.Equal(t, []string{"account.oauth.revoke"}, commands)
			for _, token := range []string{raw, sibling} {
				_, err := q.GetOAuth2AccessTokenByHash(f.ctx, hash(token))
				require.ErrorIs(t, err, pgx.ErrNoRows)
				_, err = q.GetOAuth2RefreshTokenByHash(f.ctx, hash(token+"refresh"))
				require.ErrorIs(t, err, pgx.ErrNoRows)
				var count int
				require.NoError(t, pool.QueryRow(f.ctx, "SELECT count(*) FROM revocation_events WHERE token_hash=$1", hash(token)).Scan(&count))
				require.Equal(t, 1, count)
			}
			assertLive(old)
			if user.ID == f.owner.ID {
				assertLive(protected)
			}
			replay, _ := call(raw, "")
			require.Equal(t, 401, replay.Code, replay.Body.String())
		})
	}
	for _, mode := range []string{"different app", "different account", "expired after route", "SQL failure rolls back both token types"} {
		t.Run(mode, func(t *testing.T) {
			raw := seed(f.owner.ID, app.ID, "probe-"+mode, "write:user")
			probe := &oauthRevokeAdmissionProbe{OAuth2Service: service}
			want := 403
			switch mode {
			case "different app":
				probe.app = legacy.ID
			case "different account":
				probe.user = f.other.ID
			case "expired after route":
				want = 401
				probe.before = func() {
					_, err := pool.Exec(f.ctx, "UPDATE oauth2_access_tokens SET expires_at=now()-interval '1 second' WHERE token_hash=$1", hash(raw))
					require.NoError(t, err)
				}
			case "SQL failure rolls back both token types":
				want = 500
				_, err := pool.Exec(f.ctx, `CREATE FUNCTION lane_oauth_delete_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture delete failure'; END $$; CREATE TRIGGER lane_oauth_delete_failure BEFORE DELETE ON oauth2_access_tokens FOR EACH ROW EXECUTE FUNCTION lane_oauth_delete_failure()`)
				require.NoError(t, err)
				defer func() {
					_, err := pool.Exec(f.ctx, `DROP TRIGGER lane_oauth_delete_failure ON oauth2_access_tokens; DROP FUNCTION lane_oauth_delete_failure()`)
					require.NoError(t, err)
				}()
			}
			handler.Service = probe
			defer func() { handler.Service = service }()
			out, commands := call(raw, "")
			require.Equal(t, want, out.Code, out.Body.String())
			require.Equal(t, []string{"account.oauth.revoke"}, commands)
			var count int
			require.NoError(t, pool.QueryRow(f.ctx, "SELECT count(*) FROM oauth2_access_tokens WHERE token_hash=$1", hash(raw)).Scan(&count))
			require.Equal(t, 1, count)
			_, err = q.GetOAuth2RefreshTokenByHash(f.ctx, hash(raw+"refresh"))
			require.NoError(t, err)
			require.NoError(t, pool.QueryRow(f.ctx, "SELECT count(*) FROM revocation_events WHERE token_hash=$1", hash(raw)).Scan(&count))
			require.Zero(t, count)
		})
	}
	t.Run("expiry while target grants are locked", func(t *testing.T) {
		raw := seed(f.owner.ID, app.ID, "expiry-during-grant-lock", "write:user")
		expires := time.Now().Add(2 * time.Second)
		_, err := pool.Exec(f.ctx, "UPDATE oauth2_access_tokens SET expires_at=$1 WHERE token_hash=$2", expires, hash(raw))
		require.NoError(t, err)
		conn, err := pool.Acquire(f.ctx)
		require.NoError(t, err)
		pid := conn.Conn().PgConn().PID()
		conn.Release()
		blocker, err := f.pool.Begin(f.ctx)
		require.NoError(t, err)
		defer blocker.Rollback(context.WithoutCancel(f.ctx))
		var id int64
		require.NoError(t, blocker.QueryRow(f.ctx, "SELECT id FROM oauth2_refresh_tokens WHERE token_hash=$1 FOR UPDATE", hash(raw+"refresh")).Scan(&id))
		type response struct {
			out      *httptest.ResponseRecorder
			commands []string
		}
		done := make(chan response, 1)
		go func() { out, commands := call(raw, ""); done <- response{out, commands} }()
		require.Eventually(t, func() bool {
			var waiting bool
			err := f.pool.QueryRow(f.ctx, "SELECT coalesce(wait_event_type='Lock',false) FROM pg_stat_activity WHERE pid=$1", pid).Scan(&waiting)
			return err == nil && waiting
		}, time.Second, 10*time.Millisecond)
		require.Eventually(t, func() bool { return time.Now().After(expires) }, 3*time.Second, 20*time.Millisecond)
		require.NoError(t, blocker.Rollback(f.ctx))
		select {
		case result := <-done:
			require.Equal(t, 401, result.out.Code, result.out.Body.String())
			require.Equal(t, []string{"account.oauth.revoke"}, result.commands)
		case <-time.After(5 * time.Second):
			t.Fatal("revocation did not settle after the target lock was released")
		}
		var count int
		require.NoError(t, pool.QueryRow(f.ctx, "SELECT count(*) FROM oauth2_access_tokens WHERE token_hash=$1", hash(raw)).Scan(&count))
		require.Equal(t, 1, count)
		_, err = q.GetOAuth2RefreshTokenByHash(f.ctx, hash(raw+"refresh"))
		require.NoError(t, err)
	})

	t.Run("PAT and producer leases expire inside an open transaction", func(t *testing.T) {
		pat := f.token(f.owner, "tx-expiring-pat", "read:user", false)
		turn := liveAppTurnCredentialFixture(t, f.pool, f.owner.ID)
		appToken := f.token(f.owner, "tx-expiring-app", "read:user,via:smithers,terminal-session:"+turn+"/1", true)
		control := f.token(f.owner, "tx-live-control", "read:user", false)
		expires := time.Now().Add(2 * time.Second)
		_, err := pool.Exec(f.ctx, "UPDATE access_tokens SET expires_at=$1 WHERE token_hash=$2", expires, hash(pat))
		require.NoError(t, err)
		_, err = pool.Exec(f.ctx, "UPDATE chat_turns SET producer_lease_expires_at=$1 WHERE id=$2", expires, turn)
		require.NoError(t, err)
		tx, err := pool.Begin(f.ctx)
		require.NoError(t, err)
		defer tx.Rollback(context.WithoutCancel(f.ctx))
		queries := db.New(tx)
		for _, raw := range []string{pat, appToken, control} {
			_, err := middleware.ReloadCredential(f.ctx, queries, middleware.Credential{TokenHash: hash(raw)}, time.Now())
			require.NoError(t, err)
		}
		require.Eventually(t, func() bool { return time.Now().After(expires) }, 3*time.Second, 20*time.Millisecond)
		for _, raw := range []string{pat, appToken} {
			_, err := middleware.ReloadCredential(f.ctx, queries, middleware.Credential{TokenHash: hash(raw)}, time.Now())
			require.ErrorIs(t, err, middleware.ErrCredentialGone)
		}
		_, err = middleware.ReloadCredential(f.ctx, queries, middleware.Credential{TokenHash: hash(control)}, time.Now())
		require.NoError(t, err)
	})

	require.Error(t, service.RevokeAllByAppAndUser(context.Background(), app.ID, f.owner.ID))
}
