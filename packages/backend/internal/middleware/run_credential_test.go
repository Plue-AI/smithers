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
