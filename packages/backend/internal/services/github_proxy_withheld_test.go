package services

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// A run started from an outsider's approved text reads no issue and no pull
// request conversation through the proxy; the pull request, its files and
// the repository's contents stay readable.
func TestGitHubProxyPolicyWithholdsConversation(t *testing.T) {
	t.Parallel()
	for path, allowed := range map[string]bool{
		"/repos/acme/demo/issues":                     false,
		"/repos/acme/demo/issues?state=all":           false,
		"/repos/acme/demo/issues/4":                   false,
		"/repos/acme/demo/issues/4/comments":          false,
		"/repos/acme/demo/issues/comments/9":          false,
		"/repos/acme/demo/issues/4/timeline":          false,
		"/repos/acme/demo/pulls/4/comments":           false,
		"/repos/acme/demo/pulls/comments/9":           false,
		"/repos/acme/demo/pulls/4/reviews":            false,
		"/repos/acme/demo/pulls/4/reviews/2/comments": false,
		"/repos/acme/demo/pulls/4":                    true,
		"/repos/acme/demo/pulls/4/files":              true,
		"/repos/acme/demo/pulls?state=all":            false,
		"/repos/acme/demo/contents/README.md":         true,
		"/repos/acme/demo/pulls/../issues/4":          false,
		"/repos/acme/demo/./issues/4":                 false,
	} {
		decision := EvaluateGitHubProxyPolicy(GitHubProxyPolicyInput{Method: "GET", Path: path, RepoOwner: "acme", RepoName: "demo", WithholdConversation: true})
		assert.Equal(t, allowed, decision.Allowed, path)
	}
	comment := EvaluateGitHubProxyPolicy(GitHubProxyPolicyInput{Method: "POST", Path: "/repos/acme/demo/issues/4/comments", RepoOwner: "acme", RepoName: "demo", WithholdConversation: true})
	assert.False(t, comment.Allowed, "a comment write echoes the conversation")
	// A maintainer-started run is unaffected.
	assert.True(t, EvaluateGitHubProxyPolicy(GitHubProxyPolicyInput{Method: "GET", Path: "/repos/acme/demo/issues/4", RepoOwner: "acme", RepoName: "demo"}).Allowed)
}

type outsiderWorkspaceSet map[string]bool

func (s outsiderWorkspaceSet) IsOutsiderWorkspace(_ context.Context, id string) (bool, error) {
	return s[id], nil
}

func TestGitHubProxyServiceRefusesIssueReadsToOutsiderRuns(t *testing.T) {
	t.Parallel()
	store := outsiderWorkspaceSet{"ws-outsider": true}
	proxy := func(workspace string) error {
		var err error
		handler := middleware.ResolveConversationWithheld(store)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			_, err = NewGitHubProxyService(&fakeGitHubProxyTokenIssuer{}).ProxyRepoRequest(r.Context(), &db.User{ID: 7}, "acme", "demo",
				GitHubProxyRequest{Method: "GET", Path: "/repos/acme/demo/issues/4"})
		}))
		scopes := "write:repository," + middleware.LandingWorkspaceScope(workspace)
		req := httptest.NewRequest(http.MethodPost, "/api/repos/acme/demo/github-proxy", nil)
		req = req.WithContext(middleware.ContextWithAuthInfo(req.Context(), &middleware.AuthInfo{User: &db.User{ID: 7},
			IsTokenAuth: true, TokenSystemIssued: true, RawScopes: scopes, Scopes: middleware.ParseTokenScopes(scopes)}))
		handler.ServeHTTP(httptest.NewRecorder(), req)
		return err
	}
	var apiErr *pkgerrors.APIError
	require.True(t, errors.As(proxy("ws-outsider"), &apiErr))
	assert.Equal(t, http.StatusForbidden, apiErr.Status)
	assert.Equal(t, GitHubProxyForbiddenActionCode, apiErr.Code)
	// The maintainer's run reaches the installation token step (the fake
	// issuer has no installation), never the policy refusal.
	err := proxy("ws-maintainer")
	if errors.As(err, &apiErr) {
		assert.NotEqual(t, GitHubProxyForbiddenActionCode, apiErr.Code)
	}
}
