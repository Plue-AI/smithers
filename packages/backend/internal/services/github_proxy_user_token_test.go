package services

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

type fakeGitHubProxyUserTokens struct {
	mu        sync.Mutex
	token     string
	tokenErr  error
	rotated   string
	rotateErr error
	users     []int64
	refreshes []db.OauthAccount
}

func (f *fakeGitHubProxyUserTokens) UserGitHubReadToken(_ context.Context, userID int64) (string, db.OauthAccount, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.users = append(f.users, userID)
	return f.token, db.OauthAccount{ID: 77, UserID: userID}, f.tokenErr
}

func (f *fakeGitHubProxyUserTokens) RefreshUserGitHubReadToken(_ context.Context, account db.OauthAccount) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.refreshes = append(f.refreshes, account)
	return f.rotated, f.rotateErr
}

// importedSourceNotCovered is what RepoConnectionService answers for a verified
// imported source whose GitHub App is not installed.
func importedSourceNotCovered() *fakeGitHubProxyImportedSourceTokenIssuer {
	return &fakeGitHubProxyImportedSourceTokenIssuer{
		createImportedFn: func(context.Context, int64, int64, string, string) (GitHubInstallationToken, error) {
			return GitHubInstallationToken{}, pkgerrors.BadRequest("github app is not installed for this repository").WithCause(errGitHubImportedSourceAppNotInstalled)
		},
	}
}

// mirrorContext is a mirror whose local name differs from its GitHub source.
func mirrorContext() context.Context {
	return middleware.ContextWithRepoContext(context.Background(), &middleware.RepoContext{
		Owner:      "alice",
		Repository: &db.Repository{ID: 333, Name: "widgets-import", LowerName: "widgets-import"},
	}, middleware.PermissionWrite)
}

func TestGitHubProxyService_ImportedSourceWithoutAppReadsRegistrationPathsWithImporterToken(t *testing.T) {
	var seen []string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, http.MethodGet, r.Method)
		assert.Equal(t, "Bearer gho_importer", r.Header.Get("Authorization"))
		seen = append(seen, r.URL.RequestURI())
		_, _ = w.Write([]byte(`[{"number":12}]`))
	}))
	defer upstream.Close()
	t.Setenv(envGitHubAppAPIBaseURL, upstream.URL)

	issuer := importedSourceNotCovered()
	users := &fakeGitHubProxyUserTokens{token: "gho_importer"}
	service := NewGitHubProxyService(issuer, WithGitHubProxyUserTokens(users))
	paths := []string{
		"/repos/acme/widgets/pulls?state=all&per_page=50",
		"/repos/acme/widgets/pulls/12/reviews?per_page=10",
		"/repos/acme/widgets/pulls/12/files?per_page=100",
		"/repos/acme/widgets/actions/runs?event=pull_request&status=success&per_page=30",
	}
	for _, path := range paths {
		resp, err := service.ProxyRepoRequest(mirrorContext(), &db.User{ID: 8}, "acme", "widgets", GitHubProxyRequest{Method: "GET", Path: path})
		require.NoError(t, err, path)
		body, _ := io.ReadAll(resp.Body)
		_ = resp.Body.Close()
		assert.Equal(t, http.StatusOK, resp.StatusCode, path)
		assert.JSONEq(t, `[{"number":12}]`, string(body), path)
	}
	assert.Equal(t, paths, seen)
	assert.Equal(t, []int64{8, 8, 8, 8}, users.users, "every read uses the acting importer's own credential")
	assert.Len(t, issuer.importedCalls, 4, "the App is tried first on each read")
	assert.Empty(t, users.refreshes)
}

func TestGitHubProxyService_ImporterTokenRotatesOnceAfter401(t *testing.T) {
	var auth []string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth = append(auth, r.Header.Get("Authorization"))
		if r.Header.Get("Authorization") == "Bearer gho_expired" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		_, _ = w.Write([]byte(`[]`))
	}))
	defer upstream.Close()
	t.Setenv(envGitHubAppAPIBaseURL, upstream.URL)

	users := &fakeGitHubProxyUserTokens{token: "gho_expired", rotated: "gho_fresh"}
	service := NewGitHubProxyService(importedSourceNotCovered(), WithGitHubProxyUserTokens(users))
	resp, err := service.ProxyRepoRequest(mirrorContext(), &db.User{ID: 8}, "acme", "widgets", GitHubProxyRequest{Method: "GET", Path: "/repos/acme/widgets/pulls"})
	require.NoError(t, err)
	_ = resp.Body.Close()
	assert.Equal(t, http.StatusOK, resp.StatusCode)
	assert.Equal(t, []string{"Bearer gho_expired", "Bearer gho_fresh"}, auth)
	require.Len(t, users.refreshes, 1)
	assert.Equal(t, int64(77), users.refreshes[0].ID)

	// A failed rotation hands GitHub's 401 back instead of retrying again.
	auth = nil
	users = &fakeGitHubProxyUserTokens{token: "gho_expired", rotateErr: pkgerrors.Unauthorized("github oauth token was rejected")}
	service = NewGitHubProxyService(importedSourceNotCovered(), WithGitHubProxyUserTokens(users))
	resp, err = service.ProxyRepoRequest(mirrorContext(), &db.User{ID: 8}, "acme", "widgets", GitHubProxyRequest{Method: "GET", Path: "/repos/acme/widgets/pulls"})
	require.NoError(t, err)
	_ = resp.Body.Close()
	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
	assert.Equal(t, []string{"Bearer gho_expired"}, auth)
}

func TestGitHubProxyService_ImporterTokenFailureIsReturned(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		t.Fatal("no upstream request without a credential")
	}))
	defer upstream.Close()
	t.Setenv(envGitHubAppAPIBaseURL, upstream.URL)

	users := &fakeGitHubProxyUserTokens{tokenErr: pkgerrors.Unauthorized("github oauth account is not connected")}
	service := NewGitHubProxyService(importedSourceNotCovered(), WithGitHubProxyUserTokens(users))
	_, err := service.ProxyRepoRequest(mirrorContext(), &db.User{ID: 8}, "acme", "widgets", GitHubProxyRequest{Method: "GET", Path: "/repos/acme/widgets/pulls"})
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, http.StatusUnauthorized, apiErr.Status)
	assert.Equal(t, "github oauth account is not connected", apiErr.Message)
}

func TestGitHubProxyService_ImporterTokenIsNeverUsedOutsideRegistrationReads(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		t.Fatal("no upstream request may be sent")
	}))
	defer upstream.Close()
	t.Setenv(envGitHubAppAPIBaseURL, upstream.URL)

	notInstalled := func(context.Context, int64, int64, string, string) (GitHubInstallationToken, error) {
		return GitHubInstallationToken{}, pkgerrors.BadRequest("github app is not installed for this repository")
	}
	cases := []struct {
		name    string
		issuer  GitHubProxyInstallationTokenIssuer
		method  string
		path    string
		body    string
		noUsers bool
	}{
		{name: "a write", issuer: importedSourceNotCovered(), method: "POST", path: "/repos/acme/widgets/issues/1/comments", body: `{"body":"x"}`},
		{name: "an issue read", issuer: importedSourceNotCovered(), method: "GET", path: "/repos/acme/widgets/issues"},
		{name: "a contents read", issuer: importedSourceNotCovered(), method: "GET", path: "/repos/acme/widgets/contents/.env"},
		{name: "a single pull", issuer: importedSourceNotCovered(), method: "GET", path: "/repos/acme/widgets/pulls/12"},
		{name: "a non-numeric pull", issuer: importedSourceNotCovered(), method: "GET", path: "/repos/acme/widgets/pulls/x/files"},
		{name: "no verified provenance", issuer: &fakeGitHubProxyImportedSourceTokenIssuer{createImportedFn: notInstalled}, method: "GET", path: "/repos/acme/widgets/pulls"},
		{name: "no user token source", issuer: importedSourceNotCovered(), method: "GET", path: "/repos/acme/widgets/pulls", noUsers: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			users := &fakeGitHubProxyUserTokens{token: "gho_importer"}
			opts := []GitHubProxyServiceOption{WithGitHubProxyUserTokens(users)}
			if tc.noUsers {
				opts = nil
			}
			service := NewGitHubProxyService(tc.issuer, opts...)
			input := GitHubProxyRequest{Method: tc.method, Path: tc.path}
			if tc.body != "" {
				input.Body = []byte(tc.body)
			}
			_, err := service.ProxyRepoRequest(mirrorContext(), &db.User{ID: 8}, "acme", "widgets", input)
			require.Error(t, err)
			assert.Empty(t, users.users, "the importer's credential is not read")
		})
	}
}

func TestRepoConnectionService_ImportedSourceWithoutAppNamesItsCause(t *testing.T) {
	queries := 0
	svc := NewRepoConnectionService(&mockRepoConnectionDB{
		queryRowFn: func(context.Context, string, ...any) pgx.Row {
			queries++
			if queries == 1 {
				return mockRepoConnectionRow{scanFn: func(dest ...any) error {
					*(dest[0].(*bool)) = true
					return nil
				}}
			}
			return mockRepoConnectionRow{scanFn: func(...any) error { return pgx.ErrNoRows }}
		},
	})
	_, err := svc.CreateGitHubInstallationTokenForImportedSource(context.Background(), 8, 333, "acme", "widgets", testTokenPermissions)
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, http.StatusBadRequest, apiErr.Status)
	assert.Equal(t, "github app is not installed for this repository", apiErr.Message)
	assert.Equal(t, errGitHubImportedSourceAppNotInstalled, apiErr.Cause())
	assert.Equal(t, 2, queries)
}

func TestEvaluateGitHubProxyPolicy_AllowsOnlyReadingWorkflowRuns(t *testing.T) {
	read := EvaluateGitHubProxyPolicy(GitHubProxyPolicyInput{Method: "GET", Path: "/repos/acme/widgets/actions/runs?event=pull_request", RepoOwner: "acme", RepoName: "widgets"})
	assert.True(t, read.Allowed)
	for _, input := range []GitHubProxyPolicyInput{
		{Method: "POST", Path: "/repos/acme/widgets/actions/runs"},
		{Method: "GET", Path: "/repos/acme/widgets/actions/runs/1/logs"},
		{Method: "POST", Path: "/repos/acme/widgets/actions/runs/1/rerun"},
		{Method: "GET", Path: "/repos/other/widgets/actions/runs"},
	} {
		input.RepoOwner, input.RepoName = "acme", "widgets"
		assert.False(t, EvaluateGitHubProxyPolicy(input).Allowed, input.Method+" "+input.Path)
	}
}

func TestGitHubUserReposService_UserGitHubReadTokenUsesTheUsersOwnCredential(t *testing.T) {
	var missing *GitHubUserReposService
	_, _, err := missing.UserGitHubReadToken(context.Background(), 42)
	require.Error(t, err)

	service := NewGitHubUserReposService(newFakeGitHubUserReposDB(), fakeOAuthTokenDecrypter{token: "gho_user"})
	token, _, err := service.UserGitHubReadToken(context.Background(), 42)
	require.NoError(t, err)
	assert.Equal(t, "gho_user", token)

	_, err = service.RefreshUserGitHubReadToken(context.Background(), db.OauthAccount{ID: 1})
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr, "without a refresher the rejected credential stays rejected")
	assert.Equal(t, http.StatusUnauthorized, apiErr.Status)
}
