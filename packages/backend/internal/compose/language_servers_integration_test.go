package compose

import (
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// The install router serves the File card's language-server doors under the
// code.hover decision, refuses without a member exec provider before any
// session or wake, and no longer serves the legacy workspace-session relay.
func TestInstallLanguageServerDoorsPostgres(t *testing.T) {
	f := newLandingGateFixtureWithFactory(t, nil, "", true)
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Auth.SessionCookieName = "session"
	cfg.Server.PublicURL = "http://example.com"
	cfg.Server.AllowedOrigins = []string{"http://example.com"}
	router := hostStatusProductionRouter(cfg, f.q, &services.InstallCapacityService{}, conformanceServices{pool: f.pool})
	const person = ""
	cookie := "lsp-person-session"
	sum := sha256.Sum256([]byte(cookie))
	_, err := f.q.CreateAuthSession(f.ctx, db.CreateAuthSessionParams{UserID: f.owner.ID, Username: f.owner.Username, SessionKey: hex.EncodeToString(sum[:]), ExpiresAt: time.Now().Add(time.Hour)})
	require.NoError(t, err)
	run := f.token(f.owner, "lsp-run", "write:repository,read:user", true)
	serve := func(method, path, credential, body string) (*httptest.ResponseRecorder, []string) {
		req := httptest.NewRequest(method, "http://example.com"+path, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Origin", "http://example.com")
		if credential == person {
			req.AddCookie(&http.Cookie{Name: "session", Value: cookie})
			req.AddCookie(&http.Cookie{Name: "__csrf", Value: "csrf"})
			req.Header.Set("X-CSRF-Token", "csrf")
		} else {
			req.Header.Set("Authorization", "Bearer "+credential)
		}
		var decisions []string
		req = req.WithContext(services.WithAuthorizationObserver(req.Context(), func(command string) { decisions = append(decisions, command) }))
		out := httptest.NewRecorder()
		router.ServeHTTP(out, req)
		return out, decisions
	}

	out, decisions := serve(http.MethodPost, "/api/branches/scratch%2Fgate-owner%2Fone/lsp", person, `{"language":"typescript"}`)
	require.Equal(t, http.StatusServiceUnavailable, out.Code, out.Body.String())
	require.Contains(t, out.Body.String(), "Code intelligence is unavailable")
	require.Contains(t, decisions, "code.hover")

	out, decisions = serve(http.MethodPost, "/api/branches/scratch%2Fgate-owner%2Fone/lsp", run, `{"language":"typescript"}`)
	require.Equal(t, http.StatusForbidden, out.Code, out.Body.String())
	require.Contains(t, out.Body.String(), `"code":"permission"`)
	require.Equal(t, []string{"code.hover"}, decisions)

	out, _ = serve(http.MethodGet, "/api/branches/scratch%2Fgate-owner%2Fone/lsp/s1", person, "")
	require.Equal(t, http.StatusServiceUnavailable, out.Code, out.Body.String())

	out, _ = serve(http.MethodGet, "/api/repos/gate-owner/app/workspace/sessions/s1/lsp", person, "")
	require.Equal(t, http.StatusNotFound, out.Code, "the workspace-session relay is gone: %s", out.Body.String())
	var sessions int
	require.NoError(t, f.pool.QueryRow(f.ctx, `SELECT count(*) FROM workspace_sessions`).Scan(&sessions))
	require.Zero(t, sessions, "a refused door writes no session")
}

// A File card's language server runs as the member's daemon exec session with
// presence via "lsp": it is never announced and never holds the machine.
func TestPresenceSkipsLanguageServerSessions(t *testing.T) {
	f := presenceInstall(t)
	_, err := f.pool.Exec(t.Context(), `INSERT INTO collaborators(repository_id,user_id,permission,unix_login,unix_uid)
 VALUES($1,$2,'admin','maya',20001) ON CONFLICT(repository_id,user_id) WHERE user_id IS NOT NULL DO UPDATE SET unix_login='maya',unix_uid=20001`, f.row.RepositoryID, f.user.ID)
	require.NoError(t, err)
	registry := new(machined.Registry)
	link, guest := presenceTestLink(t, registry, f.row.ID)
	require.NoError(t, link.Reconciled())
	sessions := machined.NewSessions(link.Connection, f.row.ID, registry.Sessions(f.row.ID)).WithActor([]byte("actor-reference1"), "")
	for n, via := range []string{"lsp", "ssh"} {
		opened := make(chan error, 1)
		go func() {
			_, err := sessions.WithPresenceVia(via).OpenSession(t.Context(), machined.SessionUser{Login: "maya", UID: 20001}, machined.SessionExec, []string{"/bin/sh", "-c", "exec server --stdio"}, nil)
			opened <- err
		}()
		request, err := wire.Read(guest)
		require.NoError(t, err)
		id, method, _, err := request.Request()
		require.NoError(t, err)
		require.Equal(t, byte(wire.OpenSession), method)
		require.NoError(t, wire.Write(guest, wire.Frame{Kind: wire.Control, Payload: wire.Union(2, wire.Field(1, wire.U32(id)), wire.Field(2, wire.Union(byte(wire.OpenSession), wire.Field(1, wire.U32(uint32(n+1))))))}))
		require.NoError(t, <-opened)
	}
	resolver := f.p.sessionResolver(link)
	binding, err := resolver(t.Context(), f.row.ID, 1)
	require.NoError(t, err)
	require.Equal(t, presenceSessionBinding{Skip: true}, binding, "a language server is not a participant")
	binding, err = resolver(t.Context(), f.row.ID, 2)
	require.NoError(t, err)
	require.Equal(t, presenceSessionBinding{Member: f.user.ID, Name: "Alice", Kind: "person", Via: "ssh"}, binding, "the control: the same member's SSH session is present")
}

func TestBootstrapAdvertisesCodeIntelligenceOnlyWithItsProvider(t *testing.T) {
	require.NotContains(t, newAppBootstrap(bootstrapFeatures{install: true}).Capabilities, "code.intelligence")
	require.Contains(t, newAppBootstrap(bootstrapFeatures{install: true, codeIntelligence: true}).Capabilities, "code.intelligence")
	require.False(t, newInstallLanguageServers(nil, nil, nil).Available(), "no member runtime, no language servers")
}
