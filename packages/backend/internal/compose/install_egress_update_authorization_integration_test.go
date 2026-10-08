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
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/sandbox"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

// Only the guest provider is recorded; HTTP, policy persistence, advisory locks,
// credentials and transaction visibility use the composed router and PostgreSQL.
type installEgressReloadRecorder struct {
	mu      sync.Mutex
	calls   int
	inspect func(context.Context, string, []string) error
}

func (p *installEgressReloadRecorder) ReloadEgress(ctx context.Context, id string, input sandbox.EgressReloadRequest) (sandbox.EgressReloadResult, error) {
	p.mu.Lock()
	p.calls++
	inspect := p.inspect
	p.mu.Unlock()
	if inspect != nil {
		if err := inspect(ctx, id, input.ExtraAllowDomains); err != nil {
			return sandbox.EgressReloadResult{}, err
		}
	}
	return sandbox.EgressReloadResult{SandboxID: id, AllowDomains: input.ExtraAllowDomains}, nil
}
func (p *installEgressReloadRecorder) count() int { p.mu.Lock(); defer p.mu.Unlock(); return p.calls }

type egressUpdateAdmissionProbe struct {
	routes.RepositoryEgressPolicyRouteService
	before     func()
	actor      *db.User
	repository int64
	replace    bool
}

func (p *egressUpdateAdmissionProbe) Patch(ctx context.Context, actor *db.User, repo int64, add, remove []string) (services.RepositoryEgressPolicyUpdate, error) {
	if p.before != nil {
		p.before()
	}
	if p.actor != nil {
		actor = p.actor
	}
	if p.repository != 0 {
		repo = p.repository
	}
	if p.replace {
		add = []string{"substituted.example"}
	}
	return p.RepositoryEgressPolicyRouteService.Patch(ctx, actor, repo, add, remove)
}

func TestInstallEgressUpdateAuthorizationPostgres(t *testing.T) {
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
	recorder := &installEgressReloadRecorder{}
	service := services.NewRepositoryEgressPolicyService(services.NewPostgresRepositoryEgressPolicyStore(pool), recorder, services.WithRepositoryEgressInstallAuthorization(pool))
	handler := &routes.RepositoryEgressPolicyHandler{Service: service}
	router := githubAppSetupComposeRouter(cfg, pool, nil, routerExtras{EgressPolicy: handler})
	session := func(user db.User, raw string) string {
		sum := sha256.Sum256([]byte(raw))
		hash := hex.EncodeToString(sum[:])
		_, err := q.CreateAuthSession(f.ctx, db.CreateAuthSessionParams{UserID: user.ID, Username: user.Username, SessionKey: hash, ExpiresAt: time.Now().Add(time.Hour)})
		require.NoError(t, err)
		return hash
	}
	ownerHash := session(f.owner, "egress-write-owner")
	session(f.other, "egress-write-member")
	maintainer, err := q.CreateUser(f.ctx, db.CreateUserParams{Username: "egress-write-maint", LowerUsername: "egress-write-maint"})
	require.NoError(t, err)
	_, err = pool.Exec(f.ctx, "INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,'admin')", f.repoID, maintainer.ID)
	require.NoError(t, err)
	session(maintainer, "egress-write-maint")
	_, err = q.PatchRepositoryEgressPolicy(f.ctx, db.PatchRepositoryEgressPolicyParams{RepositoryID: f.repoID, UpdatedBy: pgtype.Int8{Int64: f.owner.ID, Valid: true}, AddDomains: []string{"old-private.example"}, RemoveDomains: []string{}, MaxDomains: 200})
	require.NoError(t, err)
	_, err = pool.Exec(f.ctx, "INSERT INTO workspaces(id,repository_id,user_id,status,vm_id) VALUES($1,$2,$3,'running','egress-install-guest')", uuid.NewString(), f.repoID, f.owner.ID)
	require.NoError(t, err)
	recorder.inspect = func(ctx context.Context, id string, domains []string) error {
		// A different connection must already see the commit when guest I/O starts.
		row, err := f.q.GetRepositoryEgressPolicy(ctx, f.repoID)
		if err != nil {
			return err
		}
		if id != "egress-install-guest" || strings.Join(row.AllowDomains, ",") != strings.Join(domains, ",") {
			return fmt.Errorf("reload did not observe committed policy")
		}
		return nil
	}
	call := func(cookie, bearer, body string) (*httptest.ResponseRecorder, []string) {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		req := httptest.NewRequest("PATCH", cfg.Server.PublicURL+"/api/repos/gate-owner/app/egress-policy", strings.NewReader(body)).WithContext(ctx)
		req.Header.Set("Origin", cfg.Server.PublicURL)
		req.Header.Set("Content-Type", "application/json")
		if cookie != "" {
			req.AddCookie(&http.Cookie{Name: "session", Value: cookie})
			req.AddCookie(&http.Cookie{Name: middleware.CSRFCookieName, Value: "egress-csrf"})
			req.Header.Set("X-CSRF-Token", "egress-csrf")
		}
		if bearer != "" {
			req.Header.Set("Authorization", "Bearer "+bearer)
		}
		commands := []string{}
		req = req.WithContext(services.WithAuthorizationObserver(req.Context(), func(command string) { commands = append(commands, command) }))
		out := httptest.NewRecorder()
		router.ServeHTTP(out, req)
		return out, commands
	}
	for _, actor := range []struct {
		name, cookie, bearer string
		status               int
	}{
		{"member", "egress-write-member", "", 403}, {"maintainer", "egress-write-maint", "", 403},
		{"app", "", f.token(f.owner, "egress-w-app", "write:repository,via:smithers,terminal-session:"+liveAppTurnCredentialFixture(t, f.pool, f.owner.ID)+"/1", true), 403},
		{"external", "", f.token(f.owner, "egress-w-ext", "write:repository,via:codex", true), 403},
		{"run", "", f.token(f.owner, "egress-w-run", "write:repository", true), 403},
		{"machine", "", f.token(f.owner, "egress-w-machine", "write:repository,"+middleware.WorkspaceRestrictionScope("11111111-1111-4111-8111-111111111111"), true), 403},
		{"scope", "", f.token(f.owner, "egress-w-scope", "read:repository,via:codex", true), 403}, {"anonymous", "", "", 401},
	} {
		t.Run(actor.name, func(t *testing.T) {
			out, commands := call(actor.cookie, actor.bearer, `{"add":["new.example"]}`)
			require.Equal(t, actor.status, out.Code, out.Body.String())
			require.Equal(t, []string{"egress.update"}, commands)
			require.Zero(t, recorder.count())
			row, err := q.GetRepositoryEgressPolicy(f.ctx, f.repoID)
			require.NoError(t, err)
			require.Equal(t, []string{"old-private.example"}, row.AllowDomains)
		})
	}
	for _, body := range []string{`{}`, `{"add":["*"]}`, `{"add":["127.0.0.1"]}`, `{"add":["same.example"],"remove":["same.example"]}`, `{"add":["ok.example"],"unknown":true}`, `{"add":["ok.example"]} {}`} {
		t.Run("invalid "+body, func(t *testing.T) {
			out, commands := call("egress-write-owner", "", body)
			require.Equal(t, 400, out.Code, out.Body.String())
			require.Equal(t, []string{"egress.update"}, commands)
			require.Zero(t, recorder.count())
		})
	}
	for _, mode := range []string{"payload", "actor", "repository"} {
		t.Run("substituted "+mode, func(t *testing.T) {
			probe := &egressUpdateAdmissionProbe{RepositoryEgressPolicyRouteService: service}
			switch mode {
			case "payload":
				probe.replace = true
			case "actor":
				probe.actor = &f.other
			case "repository":
				probe.repository = f.repoID + 1
			}
			handler.Service = probe
			defer func() { handler.Service = service }()
			out, commands := call("egress-write-owner", "", `{"add":["new.example"]}`)
			require.Equal(t, 403, out.Code, out.Body.String())
			require.Equal(t, []string{"egress.update"}, commands)
			require.Zero(t, recorder.count())
		})
	}
	t.Run("owner commits before a single reload", func(t *testing.T) {
		out, commands := call("egress-write-owner", "", `{"add":["Registry.Example","registry.example"],"remove":["old-private.example"]}`)
		require.Equal(t, 200, out.Code, out.Body.String())
		require.Equal(t, []string{"egress.update"}, commands)
		var result services.RepositoryEgressPolicyUpdate
		require.NoError(t, json.Unmarshal(out.Body.Bytes(), &result))
		require.Equal(t, []string{"registry.example"}, result.AllowDomains)
		require.Equal(t, []services.RepositoryEgressReload{{SandboxID: "egress-install-guest", Reloaded: true}}, result.Reloads)
		require.Equal(t, 1, recorder.count())
	})
	t.Run("expiry while waiting for the policy lock", func(t *testing.T) {
		block, err := f.pool.Begin(f.ctx)
		require.NoError(t, err)
		defer block.Rollback(context.WithoutCancel(f.ctx))
		_, err = block.Exec(f.ctx, "SELECT pg_advisory_xact_lock(hashtextextended('repository-egress-policy:' || $1::bigint::text,0))", f.repoID)
		require.NoError(t, err)
		conn, err := pool.Acquire(f.ctx)
		require.NoError(t, err)
		pid := conn.Conn().PgConn().PID()
		conn.Release()
		type response struct {
			out      *httptest.ResponseRecorder
			commands []string
		}
		done := make(chan response, 1)
		go func() {
			out, commands := call("egress-write-owner", "", `{"add":["refused.example"]}`)
			done <- response{out, commands}
		}()
		require.Eventually(t, func() bool {
			var wait bool
			err := f.pool.QueryRow(f.ctx, "SELECT coalesce(wait_event_type='Lock',false) FROM pg_stat_activity WHERE pid=$1", pid).Scan(&wait)
			return err == nil && wait
		}, time.Second, 10*time.Millisecond)
		// The waiting writer holds no credential rows yet, so revoke its session.
		_, err = f.pool.Exec(f.ctx, "UPDATE auth_sessions SET expires_at=now()-interval '1 second' WHERE session_key=$1", ownerHash)
		require.NoError(t, err)
		require.NoError(t, block.Rollback(f.ctx))
		select {
		case result := <-done:
			require.Equal(t, 401, result.out.Code, result.out.Body.String())
			require.Equal(t, []string{"egress.update"}, result.commands)
		case <-time.After(5 * time.Second):
			t.Fatal("waiting policy request did not settle")
		}
		row, err := q.GetRepositoryEgressPolicy(f.ctx, f.repoID)
		require.NoError(t, err)
		require.Equal(t, []string{"registry.example"}, row.AllowDomains)
		require.Equal(t, 1, recorder.count())
	})
	t.Run("clock expiry while the policy row is locked rolls back", func(t *testing.T) {
		expires := time.Now().Add(2 * time.Second)
		_, err := f.pool.Exec(f.ctx, "UPDATE auth_sessions SET expires_at=$2 WHERE session_key=$1", ownerHash, expires)
		require.NoError(t, err)
		block, err := f.pool.Begin(f.ctx)
		require.NoError(t, err)
		defer block.Rollback(context.WithoutCancel(f.ctx))
		_, err = block.Exec(f.ctx, "SELECT repository_id FROM repository_egress_policies WHERE repository_id=$1 FOR UPDATE", f.repoID)
		require.NoError(t, err)
		conn, err := pool.Acquire(f.ctx)
		require.NoError(t, err)
		pid := conn.Conn().PgConn().PID()
		conn.Release()
		done := make(chan *httptest.ResponseRecorder, 1)
		go func() { out, _ := call("egress-write-owner", "", `{"add":["expired.example"]}`); done <- out }()
		require.Eventually(t, func() bool {
			var wait bool
			err := f.pool.QueryRow(f.ctx, "SELECT coalesce(wait_event_type='Lock',false) FROM pg_stat_activity WHERE pid=$1", pid).Scan(&wait)
			return err == nil && wait
		}, time.Second, 10*time.Millisecond)
		require.Eventually(t, func() bool { return time.Now().After(expires) }, 3*time.Second, 10*time.Millisecond)
		require.NoError(t, block.Rollback(f.ctx))
		select {
		case out := <-done:
			require.Equal(t, 401, out.Code, out.Body.String())
		case <-time.After(5 * time.Second):
			t.Fatal("expired policy writer did not settle")
		}
		row, err := q.GetRepositoryEgressPolicy(f.ctx, f.repoID)
		require.NoError(t, err)
		require.Equal(t, []string{"registry.example"}, row.AllowDomains)
		require.Equal(t, 1, recorder.count())
	})
	t.Run("expiry during reload preserves the committed change", func(t *testing.T) {
		_, err := pool.Exec(f.ctx, "UPDATE auth_sessions SET expires_at=now()+interval '1 hour' WHERE session_key=$1", ownerHash)
		require.NoError(t, err)
		recorder.inspect = func(ctx context.Context, _ string, _ []string) error {
			_, err := f.pool.Exec(ctx, "UPDATE auth_sessions SET expires_at=now()-interval '1 second' WHERE session_key=$1", ownerHash)
			return err
		}
		out, commands := call("egress-write-owner", "", `{"add":["committed.example"]}`)
		require.Equal(t, 401, out.Code, out.Body.String())
		require.Equal(t, []string{"egress.update"}, commands)
		require.NotContains(t, out.Body.String(), "committed.example")
		row, err := q.GetRepositoryEgressPolicy(f.ctx, f.repoID)
		require.NoError(t, err)
		require.Equal(t, []string{"committed.example", "registry.example"}, row.AllowDomains)
		require.Equal(t, 2, recorder.count())
	})
	t.Run("ambiguous reload is reported without retry", func(t *testing.T) {
		_, err := pool.Exec(f.ctx, "UPDATE auth_sessions SET expires_at=now()+interval '1 hour' WHERE session_key=$1", ownerHash)
		require.NoError(t, err)
		recorder.inspect = func(context.Context, string, []string) error { return fmt.Errorf("lost reload response") }
		out, commands := call("egress-write-owner", "", `{"add":["durable.example"]}`)
		require.Equal(t, 200, out.Code, out.Body.String())
		require.Equal(t, []string{"egress.update"}, commands)
		var result services.RepositoryEgressPolicyUpdate
		require.NoError(t, json.Unmarshal(out.Body.Bytes(), &result))
		require.Equal(t, []services.RepositoryEgressReload{{SandboxID: "egress-install-guest", Error: "lost reload response", Outcome: "outcomeUnknown"}}, result.Reloads)
		row, err := q.GetRepositoryEgressPolicy(f.ctx, f.repoID)
		require.NoError(t, err)
		require.Contains(t, row.AllowDomains, "durable.example")
		require.Equal(t, 3, recorder.count())
	})
	_, err = service.Patch(context.Background(), &f.owner, f.repoID, []string{"direct-denied.example"}, nil)
	require.Error(t, err)
	require.Equal(t, 3, recorder.count())
}
