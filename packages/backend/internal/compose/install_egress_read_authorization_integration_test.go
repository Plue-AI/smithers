package compose

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

type egressReadAdmissionProbe struct {
	routes.RepositoryEgressPolicyRouteService
	before     func()
	repository int64
}

func (p *egressReadAdmissionProbe) Get(ctx context.Context, repository int64) (services.RepositoryEgressPolicy, error) {
	if p.before != nil {
		p.before()
	}
	if p.repository != 0 {
		repository = p.repository
	}
	return p.RepositoryEgressPolicyRouteService.Get(ctx, repository)
}
func TestInstallEgressReadAuthorizationPostgres(t *testing.T) {
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
	service := services.NewRepositoryEgressPolicyService(services.NewPostgresRepositoryEgressPolicyStore(pool), nil, services.WithRepositoryEgressInstallAuthorization(pool))
	handler := &routes.RepositoryEgressPolicyHandler{Service: service}
	router := githubAppSetupComposeRouter(cfg, pool, nil, routerExtras{EgressPolicy: handler})
	session := func(user db.User, raw string) string {
		sum := sha256.Sum256([]byte(raw))
		hash := hex.EncodeToString(sum[:])
		_, err := q.CreateAuthSession(f.ctx, db.CreateAuthSessionParams{UserID: user.ID, Username: user.Username, SessionKey: hash, ExpiresAt: time.Now().Add(time.Hour)})
		require.NoError(t, err)
		return hash
	}
	ownerHash := session(f.owner, "egress-owner")
	session(f.other, "egress-member")
	maintainer, err := q.CreateUser(f.ctx, db.CreateUserParams{Username: "egress-maintainer", LowerUsername: "egress-maintainer"})
	require.NoError(t, err)
	_, err = pool.Exec(f.ctx, "INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,'admin')", f.repoID, maintainer.ID)
	require.NoError(t, err)
	session(maintainer, "egress-maintainer")
	call := func(cookie, bearer string) (*httptest.ResponseRecorder, []string) {
		req := httptest.NewRequest("GET", cfg.Server.PublicURL+"/api/repos/gate-owner/app/egress-policy", nil)
		if cookie != "" {
			req.AddCookie(&http.Cookie{Name: "session", Value: cookie})
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
	out, commands := call("egress-owner", "")
	require.Equal(t, 200, out.Code, out.Body.String())
	require.JSONEq(t, `{"allow_domains":[]}`, out.Body.String())
	require.Equal(t, []string{"egress.read"}, commands)
	_, err = q.PatchRepositoryEgressPolicy(f.ctx, db.PatchRepositoryEgressPolicyParams{RepositoryID: f.repoID, UpdatedBy: pgtype.Int8{Int64: f.owner.ID, Valid: true}, AddDomains: []string{"owner-private.example"}, RemoveDomains: []string{}, MaxDomains: 200})
	require.NoError(t, err)
	for _, actor := range []struct {
		name, cookie, bearer string
		status               int
	}{
		{"owner", "egress-owner", "", 200}, {"member", "egress-member", "", 403}, {"maintainer", "egress-maintainer", "", 403},
		{"app", "", f.token(f.owner, "egress-app", "write:repository,via:smithers,terminal-session:"+liveAppTurnCredentialFixture(t, f.pool, f.owner.ID)+"/1", true), 403},
		{"external", "", f.token(f.owner, "egress-external", "write:repository,via:codex", true), 403},
		{"run", "", f.token(f.owner, "egress-run", "write:repository", true), 403},
		{"machine", "", f.token(f.owner, "egress-machine", "write:repository,"+middleware.WorkspaceRestrictionScope("11111111-1111-4111-8111-111111111111"), true), 403},
		{"scope", "", f.token(f.owner, "egress-scope", "read:repository,via:codex", true), 403},
		{"anonymous", "", "", 401},
	} {
		t.Run(actor.name, func(t *testing.T) {
			out, commands := call(actor.cookie, actor.bearer)
			require.Equal(t, actor.status, out.Code, out.Body.String())
			require.Equal(t, []string{"egress.read"}, commands)
			if actor.status == 200 {
				require.Contains(t, out.Body.String(), "owner-private.example")
			} else {
				require.NotContains(t, out.Body.String(), "owner-private.example")
			}
		})
	}
	foreign, err := q.CreateRepo(f.ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: f.owner.ID, Valid: true}, Name: "other-egress", LowerName: "other-egress", DefaultBookmark: "main"})
	require.NoError(t, err)
	_, err = q.PatchRepositoryEgressPolicy(f.ctx, db.PatchRepositoryEgressPolicyParams{RepositoryID: foreign.ID, UpdatedBy: pgtype.Int8{Int64: f.owner.ID, Valid: true}, AddDomains: []string{"foreign-private.example"}, RemoveDomains: []string{}, MaxDomains: 200})
	require.NoError(t, err)
	for _, mode := range []string{"repository substitution", "expired after route"} {
		t.Run(mode, func(t *testing.T) {
			probe := &egressReadAdmissionProbe{RepositoryEgressPolicyRouteService: service}
			status := 403
			if mode == "repository substitution" {
				probe.repository = foreign.ID
			} else {
				status = 401
				probe.before = func() {
					_, err := pool.Exec(f.ctx, "UPDATE auth_sessions SET expires_at=now()-interval '1 second' WHERE session_key=$1", ownerHash)
					require.NoError(t, err)
				}
			}
			handler.Service = probe
			defer func() { handler.Service = service }()
			out, commands := call("egress-owner", "")
			require.Equal(t, status, out.Code, out.Body.String())
			require.Equal(t, []string{"egress.read"}, commands)
			require.NotContains(t, out.Body.String(), "private.example")
		})
	}
	_, err = service.Get(context.Background(), f.repoID)
	require.Error(t, err)
	// Trusted sandbox creation still obtains configuration without a browser read.
	domains, err := service.AllowDomains(f.ctx, f.repoID)
	require.NoError(t, err)
	require.Equal(t, []string{"owner-private.example"}, domains)
}
