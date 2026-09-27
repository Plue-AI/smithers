package middleware

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

type fakeOutsiderWorkspaces struct {
	marked map[string]bool
	err    error
	asked  []string
}

func (f *fakeOutsiderWorkspaces) IsOutsiderWorkspace(_ context.Context, workspaceID string) (bool, error) {
	f.asked = append(f.asked, workspaceID)
	return f.marked[workspaceID], f.err
}

func runTokenAuth(systemIssued bool, scopes string) *AuthInfo {
	return &AuthInfo{User: &db.User{ID: 7}, IsTokenAuth: true, TokenSystemIssued: systemIssued,
		RawScopes: scopes, Scopes: ParseTokenScopes(scopes)}
}

func serveWithheld(t *testing.T, store OutsiderWorkspaces, info *AuthInfo) (*httptest.ResponseRecorder, bool) {
	t.Helper()
	reached := false
	handler := WithholdConversation(store)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		reached = true
		w.WriteHeader(http.StatusOK)
	}))
	req := httptest.NewRequest(http.MethodGet, "/api/repos/o/r/issues/1", nil)
	if info != nil {
		req = req.WithContext(ContextWithAuthInfo(req.Context(), info))
	}
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	return rec, reached
}

// A run started from an outsider's approved text works from its pinned copy:
// its box's run credentials read no issue or conversation, whichever binding
// (the coding host's landing token or a workspace-bound token) they carry.
func TestWithholdConversationRefusesOutsiderRunCredentials(t *testing.T) {
	t.Parallel()
	store := &fakeOutsiderWorkspaces{marked: map[string]bool{"ws-outsider": true}}
	landing := "write:repository," + RepositoryRestrictionScope(3) + "," + LandingWorkspaceScope("WS-Outsider") + "," + PathRestrictionScopes([]string{"**"})[0]
	for name, info := range map[string]*AuthInfo{
		"coding host landing token": runTokenAuth(true, landing),
		// An SSE ticket keeps the minting token's scopes, not its issuer.
		"SSE ticket of a landing token": runTokenAuth(false, landing),
		"workspace-bound token":         runTokenAuth(true, "read:workspace,"+RepositoryRestrictionScope(3)+","+WorkspaceRestrictionScope("ws-outsider")),
	} {
		rec, reached := serveWithheld(t, store, info)
		assert.False(t, reached, name)
		assert.Equal(t, http.StatusForbidden, rec.Code, name)
	}
}

// A maintainer-started run's workspace carries no mark: nothing changes.
func TestWithholdConversationLeavesMaintainerRunsAndPeople(t *testing.T) {
	t.Parallel()
	store := &fakeOutsiderWorkspaces{marked: map[string]bool{"ws-outsider": true}}
	for name, info := range map[string]*AuthInfo{
		"maintainer run":           runTokenAuth(true, "write:repository,"+RepositoryRestrictionScope(3)+","+LandingWorkspaceScope("ws-maintainer")),
		"unbound run token":        runTokenAuth(true, "write:repository,"+RepositoryRestrictionScope(3)),
		"person token":             runTokenAuth(false, "write:repository"),
		"session":                  {User: &db.User{ID: 7}},
		"anonymous":                nil,
		"platform sync credential": runTokenAuth(true, "write:repository,"+RepositoryRestrictionScope(3)+","+SyncCredentialScope()+","+LandingWorkspaceScope("ws-outsider")),
	} {
		rec, reached := serveWithheld(t, store, info)
		assert.True(t, reached, name)
		assert.Equal(t, http.StatusOK, rec.Code, name)
	}
}

func TestWithholdConversationFailsClosed(t *testing.T) {
	t.Parallel()
	store := &fakeOutsiderWorkspaces{err: errors.New("database down")}
	rec, reached := serveWithheld(t, store, runTokenAuth(true, "write:repository,"+LandingWorkspaceScope("ws-1")))
	assert.False(t, reached)
	assert.Equal(t, http.StatusInternalServerError, rec.Code)
}

func TestResolveConversationWithheldRecordsTheVerdict(t *testing.T) {
	t.Parallel()
	store := &fakeOutsiderWorkspaces{marked: map[string]bool{"ws-outsider": true}}
	var seen []bool
	handler := ResolveConversationWithheld(store)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = append(seen, ConversationWithheldFromContext(r.Context()))
	}))
	for _, scopes := range []string{LandingWorkspaceScope("ws-outsider"), LandingWorkspaceScope("ws-maintainer")} {
		req := httptest.NewRequest(http.MethodPost, "/api/repos/o/r/github-proxy", nil)
		req = req.WithContext(ContextWithAuthInfo(req.Context(), runTokenAuth(true, "write:repository,"+scopes)))
		handler.ServeHTTP(httptest.NewRecorder(), req)
	}
	require.Equal(t, []bool{true, false}, seen)
	assert.False(t, ConversationWithheldFromContext(context.Background()))
}
