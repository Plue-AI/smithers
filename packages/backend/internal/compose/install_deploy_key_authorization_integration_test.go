package compose

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
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
	"golang.org/x/crypto/ssh"
)

type deployKeyAdmissionProbe struct {
	routes.DeployKeyRouteService
	before  func()
	replace bool
	keyID   int64
}

func (p *deployKeyAdmissionProbe) ListDeployKeys(ctx context.Context, owner, repo string) ([]services.DeployKeyResponse, error) {
	if p.before != nil {
		p.before()
	}
	if p.replace {
		repo = "different"
	}
	return p.DeployKeyRouteService.ListDeployKeys(ctx, owner, repo)
}
func (p *deployKeyAdmissionProbe) CreateDeployKey(ctx context.Context, owner, repo string, input services.CreateDeployKeyRequest) (services.DeployKeyResponse, error) {
	if p.before != nil {
		p.before()
	}
	if p.replace {
		input.ReadOnly = !input.ReadOnly
	}
	return p.DeployKeyRouteService.CreateDeployKey(ctx, owner, repo, input)
}
func (p *deployKeyAdmissionProbe) DeleteDeployKey(ctx context.Context, owner, repo string, id int64) error {
	if p.before != nil {
		p.before()
	}
	if p.keyID != 0 {
		id = p.keyID
	}
	return p.DeployKeyRouteService.DeleteDeployKey(ctx, owner, repo, id)
}

func TestInstallDeployKeyAuthorizationPostgres(t *testing.T) {
	f := newLandingGateFixtureWithFactory(t, nil, "", true)
	pool, err := postgresfixture.Open(f.ctx, f.pool.Config().ConnConfig.ConnString(), 1)
	require.NoError(t, err)
	defer pool.Close()
	q := db.New(pool)
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode, cfg.Auth.SessionCookieName, cfg.Auth.SessionRefreshWindow = "selfhost", "session", "0s"
	cfg.Server.PublicURL = "http://example.com"
	cfg.Server.AllowedOrigins = []string{cfg.Server.PublicURL}
	service := services.NewDeployKeyService(q, services.WithDeployKeyInstallAuthorization(pool))
	handler := &routes.DeployKeyHandler{Service: service}
	router := buildRouterCompat(cfg, q, pool, &routes.RepoHandler{Service: services.NewRepoService(q, nil, "")}, &routes.AuthHandler{}, &routes.UserHandler{}, &routes.SSHKeyHandler{}, &routes.LabelHandler{},
		&routes.OrgHandler{}, &routes.LandingHandler{}, &routes.SearchHandler{Service: &mockRouterSearchService{}}, &routes.IssueHandler{}, nil, &routes.GitSmartHandler{Service: &mockRouterGitService{}},
		nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, &routes.WorkspaceHandler{}, nil, nil, nil, nil, nil, nil, handler)
	session := func(user db.User, raw string) string {
		sum := sha256.Sum256([]byte(raw))
		hash := hex.EncodeToString(sum[:])
		_, err := f.q.CreateAuthSession(f.ctx, db.CreateAuthSessionParams{UserID: user.ID, Username: user.Username, SessionKey: hash, ExpiresAt: time.Now().Add(time.Hour)})
		require.NoError(t, err)
		return hash
	}
	ownerCookie, memberCookie := "deploy-owner", "deploy-member"
	ownerHash := session(f.owner, ownerCookie)
	session(f.other, memberCookie)
	maintainer, err := f.q.CreateUser(f.ctx, db.CreateUserParams{Username: "deploy-maintainer", LowerUsername: "deploy-maintainer"})
	require.NoError(t, err)
	_, err = f.pool.Exec(f.ctx, `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,'admin')`, f.repoID, maintainer.ID)
	require.NoError(t, err)
	maintainerCookie := "deploy-maintainer"
	session(maintainer, maintainerCookie)
	newKey := func() (string, string) {
		public, _, err := ed25519.GenerateKey(rand.Reader)
		require.NoError(t, err)
		key, err := ssh.NewPublicKey(public)
		require.NoError(t, err)
		return strings.TrimSpace(string(ssh.MarshalAuthorizedKey(key))), ssh.FingerprintSHA256(key)
	}
	retainedPublic, retainedFingerprint := newKey()
	retained, err := f.q.CreateDeployKey(f.ctx, db.CreateDeployKeyParams{RepositoryID: f.repoID, Title: "Retained private key entry", PublicKey: retainedPublic, KeyFingerprint: retainedFingerprint, ReadOnly: true})
	require.NoError(t, err)
	newPublic, _ := newKey()
	bodyBytes, err := json.Marshal(services.CreateDeployKeyRequest{Title: "Created", Key: newPublic, ReadOnly: true})
	require.NoError(t, err)
	body := string(bodyBytes)
	external := f.token(f.owner, "deploy-external", "write:repository,via:codex", true)
	app := f.token(f.owner, "deploy-app", "write:repository,via:smithers,terminal-session:"+liveAppTurnCredentialFixture(t, f.pool, f.owner.ID)+"/1", true)
	run := f.token(f.owner, "deploy-run", "write:repository", true)
	machine := f.token(f.owner, "deploy-machine", "write:repository,"+middleware.WorkspaceRestrictionScope("11111111-1111-4111-8111-111111111111"), true)
	call := func(t *testing.T, method, path, cookie, bearer, body, command string, status int) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(method, cfg.Server.PublicURL+"/api/repos/gate-owner/app"+path, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Origin", cfg.Server.PublicURL)
		req.Header.Set("X-CSRF-Token", "deploy-csrf")
		req.AddCookie(&http.Cookie{Name: middleware.CSRFCookieName, Value: "deploy-csrf"})
		if cookie != "" {
			req.AddCookie(&http.Cookie{Name: "session", Value: cookie})
		}
		if bearer != "" {
			req.Header.Set("Authorization", "Bearer "+bearer)
		}
		var commands []string
		req = req.WithContext(services.WithAuthorizationObserver(req.Context(), func(command string) { commands = append(commands, command) }))
		out := httptest.NewRecorder()
		router.ServeHTTP(out, req)
		require.Equal(t, status, out.Code, out.Body.String())
		require.Equal(t, []string{command}, commands)
		return out
	}
	assertUnchanged := func(t *testing.T) {
		rows, err := f.q.ListDeployKeysByRepo(f.ctx, f.repoID)
		require.NoError(t, err)
		require.Len(t, rows, 1)
		require.Equal(t, retained.ID, rows[0].ID)
		var count int
		require.NoError(t, f.pool.QueryRow(f.ctx, `SELECT count(*) FROM revocation_events WHERE key_fingerprint=$1`, retainedFingerprint).Scan(&count))
		require.Zero(t, count)
	}
	operations := []struct{ method, path, body, command string }{
		{"GET", "/keys", "", "deploy-keys.read"}, {"POST", "/keys", body, "deploy-keys.create"}, {"DELETE", fmt.Sprintf("/keys/%d", retained.ID), "", "deploy-keys.delete"},
	}
	for _, actor := range []struct {
		name, cookie, bearer string
		status               int
		code                 string
	}{
		{"member", memberCookie, "", 403, "permission"}, {"maintainer", maintainerCookie, "", 403, "permission"}, {"external", "", external, 403, "never"}, {"app", "", app, 403, "never"}, {"run", "", run, 403, "permission"}, {"machine", "", machine, 403, "permission"},
		{"wrong-scope", "", f.token(f.owner, "deploy-wrong-scope", "read:user,via:codex", true), 403, "permission"}, {"anonymous", "", "", 401, "unauthenticated"},
	} {
		for _, op := range operations {
			t.Run(actor.name+"/"+op.command, func(t *testing.T) {
				out := call(t, op.method, op.path, actor.cookie, actor.bearer, op.body, op.command, actor.status)
				require.Contains(t, out.Body.String(), `"code":"`+actor.code+`"`)
				require.NotContains(t, out.Body.String(), retainedPublic)
				assertUnchanged(t)
			})
		}
	}
	for _, op := range operations {
		for _, mode := range []string{"substitution", "expired"} {
			t.Run(op.command+"/"+mode, func(t *testing.T) {
				probe := &deployKeyAdmissionProbe{DeployKeyRouteService: service}
				status := 403
				if mode == "substitution" {
					probe.replace = true
					probe.keyID = retained.ID + 1000
				} else {
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
				call(t, op.method, op.path, ownerCookie, "", op.body, op.command, status)
				assertUnchanged(t)
			})
		}
	}

	t.Run("expiry while deletion waits rolls back key and revocation", func(t *testing.T) {
		ctx, cancel := context.WithTimeout(f.ctx, 12*time.Second)
		defer cancel()
		held, err := f.pool.Begin(ctx)
		require.NoError(t, err)
		defer held.Rollback(context.Background())
		_, err = held.Exec(ctx, `SELECT id FROM deploy_keys WHERE id=$1 FOR UPDATE`, retained.ID)
		require.NoError(t, err)
		deadline := time.Now().Add(4 * time.Second)
		_, err = f.pool.Exec(ctx, `UPDATE auth_sessions SET expires_at=$2 WHERE session_key=$1`, ownerHash, deadline)
		require.NoError(t, err)
		defer func() {
			_, err := f.pool.Exec(f.ctx, `UPDATE auth_sessions SET expires_at=now()+interval '1 hour' WHERE session_key=$1`, ownerHash)
			require.NoError(t, err)
		}()
		req := httptest.NewRequest("DELETE", fmt.Sprintf("%s/api/repos/gate-owner/app/keys/%d", cfg.Server.PublicURL, retained.ID), nil)
		req.Header.Set("Origin", cfg.Server.PublicURL)
		req.Header.Set("X-CSRF-Token", "deploy-csrf")
		req.AddCookie(&http.Cookie{Name: middleware.CSRFCookieName, Value: "deploy-csrf"})
		req.AddCookie(&http.Cookie{Name: "session", Value: ownerCookie})
		var commands []string
		req = req.WithContext(services.WithAuthorizationObserver(ctx, func(command string) { commands = append(commands, command) }))
		done := make(chan *httptest.ResponseRecorder, 1)
		go func() { out := httptest.NewRecorder(); router.ServeHTTP(out, req); done <- out }()
		require.Eventually(t, func() bool {
			var count int
			err := f.pool.QueryRow(ctx, `SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%DELETE FROM deploy_keys%'`).Scan(&count)
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
		require.Equal(t, []string{"deploy-keys.delete"}, commands)
		assertUnchanged(t)
	})
	t.Run("owner lists creates and validates deploy keys", func(t *testing.T) {
		out := call(t, "GET", "/keys", ownerCookie, "", "", "deploy-keys.read", 200)
		require.Contains(t, out.Body.String(), retainedPublic)
		call(t, "POST", "/keys", ownerCookie, "", `{"title":"Invalid","key":"bad"}`, "deploy-keys.create", 422)
		call(t, "POST", "/keys", "", external, `{"title":"Invalid","key":"bad"}`, "deploy-keys.create", 403)
		assertUnchanged(t)
		out = call(t, "POST", "/keys", ownerCookie, "", body, "deploy-keys.create", 201)
		var created services.DeployKeyResponse
		require.NoError(t, json.Unmarshal(out.Body.Bytes(), &created))
		require.True(t, created.ReadOnly)
		require.Equal(t, newPublic, created.PublicKey)
		call(t, "POST", "/keys", ownerCookie, "", body, "deploy-keys.create", 409)
		call(t, "DELETE", fmt.Sprintf("/keys/%d", created.ID), ownerCookie, "", "", "deploy-keys.delete", 204)
		var count int
		require.NoError(t, f.pool.QueryRow(f.ctx, `SELECT count(*) FROM revocation_events WHERE key_fingerprint=$1 AND repository_id=$2 AND kind='ssh_key_revoked'`, created.KeyFingerprint, f.repoID).Scan(&count))
		require.Equal(t, 1, count)
		assertUnchanged(t)
	})
	t.Run("failed durable revocation rolls back key deletion", func(t *testing.T) {
		_, err := f.pool.Exec(f.ctx, `CREATE FUNCTION reject_deploy_revocation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test revocation failure'; END $$`)
		require.NoError(t, err)
		_, err = f.pool.Exec(f.ctx, `CREATE TRIGGER reject_deploy_revocation BEFORE INSERT ON revocation_events FOR EACH ROW EXECUTE FUNCTION reject_deploy_revocation()`)
		require.NoError(t, err)
		call(t, "DELETE", fmt.Sprintf("/keys/%d", retained.ID), ownerCookie, "", "", "deploy-keys.delete", 500)
		assertUnchanged(t)
		_, err = f.pool.Exec(f.ctx, `DROP TRIGGER reject_deploy_revocation ON revocation_events`)
		require.NoError(t, err)
		_, err = f.pool.Exec(f.ctx, `DROP FUNCTION reject_deploy_revocation()`)
		require.NoError(t, err)
		call(t, "DELETE", fmt.Sprintf("/keys/%d", retained.ID), ownerCookie, "", "", "deploy-keys.delete", 204)
		rows, err := f.q.ListDeployKeysByRepo(f.ctx, f.repoID)
		require.NoError(t, err)
		require.Empty(t, rows)
		var count int
		require.NoError(t, f.pool.QueryRow(f.ctx, `SELECT count(*) FROM revocation_events WHERE key_fingerprint=$1`, retainedFingerprint).Scan(&count))
		require.Equal(t, 1, count)
	})
	t.Run("direct service needs live authority", func(t *testing.T) {
		_, err := service.ListDeployKeys(f.ctx, "gate-owner", "app")
		var denied *services.AccessError
		require.ErrorAs(t, err, &denied)
		require.Equal(t, 401, denied.Status)
		ctx := middleware.ContextWithAuthInfo(f.ctx, &middleware.AuthInfo{User: &f.owner, SessionHash: ownerHash})
		var commands []string
		ctx = services.WithAuthorizationObserver(ctx, func(command string) { commands = append(commands, command) })
		rows, err := service.ListDeployKeys(ctx, "gate-owner", "app")
		require.NoError(t, err)
		require.Empty(t, rows)
		require.Equal(t, []string{"deploy-keys.read"}, commands)
	})
}
