package middleware

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

const terminalScopes = "read:repository,read:user,repo:7,via:terminal,branch:0b1c-branch,profile:terminal_s1,terminal-session:5e55-session"

// A system-issued token with an issuer-bound via is delegated (spec §5.3.0);
// the same entries on a person's own token, or a token without via, are not.
func TestDelegatedCredentialKind(t *testing.T) {
	assert.Equal(t, CredentialDelegated, TokenCredentialKind(true, terminalScopes, "user"))
	assert.Equal(t, CredentialPerson, TokenCredentialKind(false, terminalScopes, "user"), "a person cannot mint delegation")
	assert.Equal(t, CredentialAgentRun, TokenCredentialKind(false, terminalScopes, "bot"))
	assert.Equal(t, CredentialAgentRun, TokenCredentialKind(true, "read:repository,repo:7,branch:x,profile:terminal_s1", "user"), "no via, no delegation")
	assert.Equal(t, CredentialSync, TokenCredentialKind(true, "credential:sync,via:terminal", "user"))
	assert.Equal(t, CredentialDelegated, ParseCredentialKind("delegated"))
	assert.True(t, CredentialDelegated.Agent(), "a delegated credential has an agent run's restrictions")
	assert.True(t, CredentialAgentRun.Agent())
	assert.False(t, CredentialPerson.Agent())
	assert.False(t, CredentialDelegated.Reviewed())
	assert.Equal(t, ScopeSet{ScopeReadRepository: {}, ScopeReadUser: {}}, ParseTokenScopes(terminalScopes), "delegation entries grant nothing")
}

func TestDelegationScopesRoundTrip(t *testing.T) {
	entries := DelegationScopes(Delegation{Via: "Terminal", Branch: "0B1C-branch", Profile: TerminalProfileS1, Session: "5e55-session"})
	assert.Equal(t, []string{"via:terminal", "branch:0b1c-branch", "profile:terminal_s1", "terminal-session:5e55-session"}, entries)
	got, ok := ParseTokenDelegation(true, "read:user,"+strings.Join(entries, ","))
	require.True(t, ok)
	assert.Equal(t, Delegation{Via: "terminal", Branch: "0b1c-branch", Profile: "terminal_s1", Session: "5e55-session"}, got)
	assert.Equal(t, []string{"via:cli"}, DelegationScopes(Delegation{Via: "cli"}))
	_, ok = ParseTokenDelegation(false, strings.Join(entries, ","))
	assert.False(t, ok)
	info := &AuthInfo{IsTokenAuth: true, TokenSystemIssued: true, RawScopes: terminalScopes}
	got, ok = info.Delegation()
	require.True(t, ok)
	assert.Equal(t, "terminal", got.Via)
	_, ok = (&AuthInfo{TokenSystemIssued: true, RawScopes: terminalScopes}).Delegation()
	assert.False(t, ok, "a browser session is never delegated")
}

// The Smithers-Via hint attributes a terminal's or the CLI's credential to the
// agent working in it, and never changes any other stored via (spec §6.4).
func TestEffectiveVia(t *testing.T) {
	for _, tc := range []struct{ stored, hint, want string }{
		{"terminal", "claude-code", "claude-code"},
		{"terminal", "Codex", "codex"},
		{"terminal", "", "terminal"},
		{"terminal", "smithers", "terminal"},
		{"cli", "claude-code", "claude-code"},
		{"claude-code", "codex", "claude-code"},
		{"smithers", "claude-code", "smithers"},
	} {
		assert.Equal(t, tc.want, EffectiveVia(tc.stored, tc.hint), "%s + %s", tc.stored, tc.hint)
	}
}

// A stage-1 terminal credential reaches only its profile's routes; every
// other route refuses it with 403 permission before its handler runs.
func TestTerminalProfileRoutes(t *testing.T) {
	serve := func(info *AuthInfo, method, path string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		if allowTerminalProfileToken(rec, httptest.NewRequest(method, path, nil), info) {
			rec.WriteHeader(http.StatusNoContent)
		}
		return rec
	}
	terminal := &AuthInfo{User: &db.User{ID: 2}, IsTokenAuth: true, TokenSystemIssued: true, RawScopes: terminalScopes}
	for _, allowed := range [][2]string{
		{"GET", "/api/user"},
		{"GET", "/api/user/repos"},
		{"GET", "/api/todos"},
		{"GET", "/api/todos/3"},
		{"GET", "/api/repos/acme/app"},
		{"GET", "/api/repos/acme/app/mythical/items/4"},
		{"GET", "/api/repos/acme/app/wiki"},
		{"GET", "/api/repos/acme/app/wiki/search"},
		{"GET", "/api/repos/acme/app/wiki/home/revisions"},
	} {
		assert.Equal(t, http.StatusNoContent, serve(terminal, allowed[0], allowed[1]).Code, "%v", allowed)
	}
	for _, refused := range [][2]string{
		{"POST", "/api/todos"},
		{"POST", "/api/todos/3"},
		{"POST", "/api/todos/3/answer"},
		{"POST", "/api/todos/3/merge"},
		{"GET", "/api/install"},
		{"GET", "/api/members"},
		{"POST", "/api/repos/acme/app/wiki"},
		{"PATCH", "/api/repos/acme/app/wiki/home"},
		{"GET", "/api/user/tokens"},
		{"GET", "/acme/app.git/info/refs"},
	} {
		rec := serve(terminal, refused[0], refused[1])
		assert.Equal(t, http.StatusForbidden, rec.Code, "%v", refused)
		assert.JSONEq(t, `{"class":"permission","code":"permission","message":"A terminal's credential cannot do this"}`, rec.Body.String())
	}
	run := &AuthInfo{User: &db.User{ID: 2}, IsTokenAuth: true, TokenSystemIssued: true, RawScopes: "write:repository,repo:7"}
	assert.Equal(t, http.StatusNoContent, serve(run, "POST", "/api/todos").Code, "other credentials are not confined here")
	cli := &AuthInfo{User: &db.User{ID: 2}, IsTokenAuth: true, TokenSystemIssued: true, RawScopes: "read:repository,via:cli"}
	assert.Equal(t, http.StatusNoContent, serve(cli, "POST", "/api/todos").Code, "only the terminal profile is confined to these routes")
}

// A terminal's repository-bound credential reads its person's identity
// (GET /api/user, smthrs auth status); any other repository-bound token is
// still refused outside its repository.
func TestTerminalCredentialReadsItsPersonOutsideTheRepository(t *testing.T) {
	handler := RequireScope(ScopeReadUser)(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) }))
	serve := func(scopes string) int {
		req := httptest.NewRequest(http.MethodGet, "/api/user", nil)
		req = req.WithContext(ContextWithAuthInfo(req.Context(), &AuthInfo{User: &db.User{ID: 2}, IsTokenAuth: true, TokenSystemIssued: true, RawScopes: scopes, Scopes: ParseTokenScopes(scopes)}))
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		return rec.Code
	}
	assert.Equal(t, http.StatusNoContent, serve(terminalScopes))
	assert.Equal(t, http.StatusForbidden, serve("read:user,repo:7"))
	assert.Equal(t, http.StatusForbidden, serve("read:user,repo:7,via:cli"))
}
