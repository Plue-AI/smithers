package middleware

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

func TestRefuseRunCredentials(t *testing.T) {
	t.Parallel()
	handler := RefuseRunCredentials(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) }))
	serve := func(info *AuthInfo) int {
		req := httptest.NewRequest(http.MethodPost, "/api/repos/acme/app/invoke", nil)
		if info != nil {
			req = req.WithContext(ContextWithAuthInfo(req.Context(), info))
		}
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		return rec.Code
	}
	assert.Equal(t, http.StatusForbidden, serve(&AuthInfo{User: &db.User{ID: 1}, IsTokenAuth: true, TokenSystemIssued: true}))
	assert.Equal(t, http.StatusNoContent, serve(&AuthInfo{User: &db.User{ID: 1}, IsTokenAuth: true}))
	assert.Equal(t, http.StatusNoContent, serve(&AuthInfo{User: &db.User{ID: 1}}))
	assert.Equal(t, http.StatusNoContent, serve(nil), "anonymous callers fall through to RequireAuth")
}

// An agent account (a bot or service user) is an agent whatever token it
// holds, so it cannot write the default bookmark directly or pass as a person
// (D-23); the platform's sync token stays sync.
func TestAgentAccountCredentialIsAnAgentRun(t *testing.T) {
	for _, tc := range []struct {
		systemIssued bool
		scopes       string
		userType     string
		want         CredentialKind
	}{
		{false, "write:repository", "user", CredentialPerson},
		{false, "write:repository", "bot", CredentialAgentRun},
		{false, "write:repository", "service", CredentialAgentRun},
		{true, "write:repository", "user", CredentialAgentRun},
		{true, SyncCredentialScope(), "user", CredentialSync},
	} {
		assert.Equal(t, tc.want, TokenCredentialKind(tc.systemIssued, tc.scopes, tc.userType), "%+v", tc)
	}
	bot := &db.User{ID: 7, UserType: "bot"}
	assert.Equal(t, CredentialAgentRun, (&AuthInfo{User: bot}).CredentialKind(), "a bot's session")
	assert.Equal(t, CredentialAgentRun, (&AuthInfo{User: bot, IsTokenAuth: true}).CredentialKind(), "a bot's token")
	assert.Equal(t, CredentialPerson, (&AuthInfo{User: &db.User{ID: 8, UserType: "user"}, IsTokenAuth: true}).CredentialKind())
}

// An agent account takes no person's decision (D-23).
func TestRequirePersonRefusesAgentAccounts(t *testing.T) {
	bot := &db.User{ID: 7, UserType: "bot"}
	err := RequirePerson(ContextWithAuthInfo(context.Background(), &AuthInfo{User: bot, IsTokenAuth: true, RawScopes: "write:repository"}), "decide")
	assert.ErrorContains(t, err, "an agent account cannot decide")
	assert.NoError(t, RequirePerson(ContextWithAuthInfo(context.Background(), &AuthInfo{User: &db.User{ID: 8, UserType: "user"}, IsTokenAuth: true}), "decide"))
}

func TestMachineCredentialClassification(t *testing.T) {
	for _, tc := range []struct {
		issued bool
		scopes string
		want   CredentialKind
	}{
		{true, "write:repository,workspace:box-1", CredentialMachine},
		{true, "write:workspace,workspace:box-1,credential:workspace-children", CredentialMachine},
		{true, "write:repository,landing-workspace:box-1", CredentialAgentRun},
		{false, "write:repository,workspace:box-1", CredentialPerson},
		{true, "write:repository,via:cli,branch:box-1", CredentialDelegated},
	} {
		assert.Equal(t, tc.want, TokenCredentialKind(tc.issued, tc.scopes, "user"))
	}
	assert.Equal(t, CredentialMachine, ParseCredentialKind("machine"))
	assert.Equal(t, CredentialAgentRun, ParseCredentialKind("setup"), "unhandled kinds remain restricted")
	assert.True(t, CredentialMachine.Agent())
	assert.False(t, CredentialMachine.Reviewed())
	info := &AuthInfo{User: &db.User{ID: 1}, IsTokenAuth: true, TokenSystemIssued: true, RawScopes: "workspace:box-1"}
	assert.Equal(t, CredentialMachine, info.CredentialKind())
	assert.Error(t, RequirePerson(ContextWithAuthInfo(context.Background(), info), "approve"))
}

func TestMachineAndSyncDoNotInheritTerminalDelegation(t *testing.T) {
	for _, scopes := range []string{
		"workspace:box-1,via:terminal,branch:box-1,profile:terminal_s1",
		"credential:sync,via:terminal,branch:box-1,profile:terminal_s1",
	} {
		info := &AuthInfo{User: &db.User{ID: 1}, IsTokenAuth: true, TokenSystemIssued: true, RawScopes: scopes, ViaHint: "codex"}
		_, delegated := info.Delegation()
		assert.False(t, delegated)
		_, terminal := info.TerminalDelegation()
		assert.False(t, terminal)
		assert.Empty(t, info.ActingVia())
		assert.Error(t, RequirePerson(ContextWithAuthInfo(context.Background(), info), "approve"))
	}
}

func TestInstallPATClassificationHasNoBackfill(t *testing.T) {
	for _, raw := range []string{"repo,user,write:approval", "repo,via:smithers,profile:terminal_s1"} {
		if got := TokenCredentialKind(false, raw, "user", true); got != CredentialDelegated {
			t.Fatalf("install PAT classified %s", got)
		}
		if got := TokenCredentialKind(false, raw, "user"); got != CredentialPerson {
			t.Fatalf("Plue PAT classified %s", got)
		}
	}
	if got := TokenCredentialKind(true, "repo,via:claude-code", "user", true); got != CredentialDelegated {
		t.Fatalf("delegated classified %s", got)
	}
	if got := TokenCredentialKind(true, "repo,workspace:branch-1", "user", true); got != CredentialMachine {
		t.Fatalf("workspace subject classified %s", got)
	}
	if got := TokenCredentialKind(false, "repo", "bot", true); got != CredentialAgentRun {
		t.Fatalf("bot classified %s", got)
	}
}
