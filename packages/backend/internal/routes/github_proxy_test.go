package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type mockGitHubProxyTokenIssuer struct {
	createFn func(ctx context.Context, userID int64, owner string, repo string) (services.GitHubInstallationToken, error)
	calls    []struct {
		userID int64
		owner  string
		repo   string
	}
}

func (m *mockGitHubProxyTokenIssuer) CreateGitHubInstallationToken(ctx context.Context, userID int64, owner string, repo string) (services.GitHubInstallationToken, error) {
	m.calls = append(m.calls, struct {
		userID int64
		owner  string
		repo   string
	}{
		userID: userID,
		owner:  owner,
		repo:   repo,
	})
	if m.createFn != nil {
		return m.createFn(ctx, userID, owner, repo)
	}
	return services.GitHubInstallationToken{
		InstallationID: 1,
		Token:          "test-install-token",
	}, nil
}

func TestGitHubProxyHandler_PostRepoGitHubProxy_RoundTrip(t *testing.T) {
	var gotGitHubAuth string
	var gotGitHubMethod string
	var gotGitHubPath string
	var gotGitHubUserAgent string
	var gotGitHubBody map[string]any

	gitHubServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotGitHubAuth = r.Header.Get("Authorization")
		gotGitHubMethod = r.Method
		gotGitHubPath = r.URL.Path
		gotGitHubUserAgent = r.Header.Get("User-Agent")
		require.NoError(t, json.NewDecoder(r.Body).Decode(&gotGitHubBody))

		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("X-RateLimit-Remaining", "42")
		w.Header().Add("Set-Cookie", "secret=value; HttpOnly")
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"id":999,"status":"queued"}`))
	}))
	defer gitHubServer.Close()

	t.Setenv("SMITHERS_GITHUB_APP_API_BASE_URL", gitHubServer.URL)

	tokenIssuer := &mockGitHubProxyTokenIssuer{
		createFn: func(ctx context.Context, userID int64, owner string, repo string) (services.GitHubInstallationToken, error) {
			return services.GitHubInstallationToken{
				InstallationID: 77,
				Token:          "install-token-xyz",
			}, nil
		},
	}

	service := services.NewGitHubProxyService(tokenIssuer)
	handler := &GitHubProxyHandler{Service: service}

	payload := map[string]any{
		"method": "POST",
		"path":   "/repos/acme/demo/check-runs",
		"headers": map[string]string{
			"X-GitHub-Api-Version": "2022-11-28",
		},
		"body": map[string]any{
			"name":     "smithers/checks",
			"head_sha": "deadbeef",
		},
	}
	body, err := json.Marshal(payload)
	require.NoError(t, err)

	req := httptest.NewRequest(http.MethodPost, "/api/repos/acme/demo/github-proxy", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req = withRouteParams(req, map[string]string{"owner": "acme", "repo": "demo"})
	req = withAuth(req, 77, "alice")
	rec := httptest.NewRecorder()
	handler.PostRepoGitHubProxy(rec, req)

	require.Equal(t, http.StatusCreated, rec.Code)
	assert.Equal(t, "application/json", rec.Header().Get("Content-Type"))
	assert.Equal(t, "42", rec.Header().Get("X-RateLimit-Remaining"))
	assert.Empty(t, rec.Header().Get("Set-Cookie"))
	assert.JSONEq(t, `{"id":999,"status":"queued"}`, rec.Body.String())

	assert.Equal(t, "Bearer install-token-xyz", gotGitHubAuth)
	assert.Equal(t, http.MethodPost, gotGitHubMethod)
	assert.Equal(t, "/repos/acme/demo/check-runs", gotGitHubPath)
	assert.Equal(t, "smithers-server", gotGitHubUserAgent)
	assert.Equal(t, "smithers/checks", gotGitHubBody["name"])
	assert.Equal(t, "deadbeef", gotGitHubBody["head_sha"])

	require.Len(t, tokenIssuer.calls, 1)
	assert.Equal(t, int64(77), tokenIssuer.calls[0].userID)
	assert.Equal(t, "acme", tokenIssuer.calls[0].owner)
	assert.Equal(t, "demo", tokenIssuer.calls[0].repo)
}

func TestGitHubProxyHandler_RateLimitRefusalsAreStructured(t *testing.T) {
	t.Parallel()

	resetAt := time.Date(2026, 9, 2, 13, 0, 0, 0, time.UTC)
	newRateLimitError := func() error {
		limit := 5000
		remaining := 0
		return &pkgerrors.APIError{
			Status:     http.StatusTooManyRequests,
			Code:       pkgerrors.CodeGitHubRateLimited,
			Message:    "github installation rate limit exceeded",
			Limit:      &limit,
			Remaining:  &remaining,
			ResetAt:    &resetAt,
			RetryAfter: 3600,
		}
	}
	assertResponse := func(t *testing.T, rec *httptest.ResponseRecorder) {
		t.Helper()
		require.Equal(t, http.StatusTooManyRequests, rec.Code)
		assert.Equal(t, "3600", rec.Header().Get("Retry-After"))
		assert.JSONEq(t, `{
			"code":"github_rate_limited",
			"class":"github",
			"fault":"dependency",
			"retry_after":3600,
			"message":"github installation rate limit exceeded",
			"limit":5000,
			"remaining":0,
			"reset_at":"2026-09-02T13:00:00Z"
		}`, rec.Body.String())
	}

	t.Run("repository proxy", func(t *testing.T) {
		t.Parallel()
		handler := &GitHubProxyHandler{Service: githubProxyCovService{
			proxyRepoFn: func(context.Context, *db.User, string, string, services.GitHubProxyRequest) (*services.GitHubProxyResponse, error) {
				return nil, newRateLimitError()
			},
		}}
		req := httptest.NewRequest(http.MethodPost, "/api/repos/acme/demo/github-proxy", bytes.NewBufferString(`{"method":"GET","path":"/repos/acme/demo"}`))
		req = withRouteParams(req, map[string]string{"owner": "acme", "repo": "demo"})
		req = withAuth(req, 42, "alice")
		rec := httptest.NewRecorder()

		handler.PostRepoGitHubProxy(rec, req)

		assertResponse(t, rec)
	})
}

func TestGitHubProxyHandler_PostRepoGitHubProxy_AllowsPullCreationWithServerToken(t *testing.T) {
	var gotGitHubAuth string
	var gotGitHubPath string
	var gotGitHubBody map[string]any

	gitHubServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotGitHubAuth = r.Header.Get("Authorization")
		gotGitHubPath = r.URL.Path
		require.NoError(t, json.NewDecoder(r.Body).Decode(&gotGitHubBody))

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"number":77,"html_url":"https://github.com/acme/demo/pull/77","state":"open"}`))
	}))
	defer gitHubServer.Close()

	t.Setenv("SMITHERS_GITHUB_APP_API_BASE_URL", gitHubServer.URL)

	tokenIssuer := &mockGitHubProxyTokenIssuer{
		createFn: func(ctx context.Context, userID int64, owner string, repo string) (services.GitHubInstallationToken, error) {
			assert.Equal(t, int64(42), userID)
			assert.Equal(t, "acme", owner)
			assert.Equal(t, "demo", repo)
			return services.GitHubInstallationToken{
				InstallationID: 77,
				Token:          "server-install-token",
			}, nil
		},
	}

	service := services.NewGitHubProxyService(tokenIssuer)
	handler := &GitHubProxyHandler{Service: service}

	payload := map[string]any{
		"method": "POST",
		"path":   "/repos/acme/demo/pulls",
		"body": map[string]any{
			"title": "Sandbox change",
			"head":  "smithers/abcd1234",
			"base":  "main",
		},
	}
	body, err := json.Marshal(payload)
	require.NoError(t, err)

	req := httptest.NewRequest(http.MethodPost, "/api/repos/acme/demo/github-proxy", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req = withRouteParams(req, map[string]string{"owner": "acme", "repo": "demo"})
	req = withAuth(req, 42, "alice")
	rec := httptest.NewRecorder()

	handler.PostRepoGitHubProxy(rec, req)

	require.Equal(t, http.StatusCreated, rec.Code)
	assert.JSONEq(t, `{"number":77,"html_url":"https://github.com/acme/demo/pull/77","state":"open"}`, rec.Body.String())
	assert.Equal(t, "Bearer server-install-token", gotGitHubAuth)
	assert.Equal(t, "/repos/acme/demo/pulls", gotGitHubPath)
	assert.Equal(t, "Sandbox change", gotGitHubBody["title"])
	assert.Equal(t, "smithers/abcd1234", gotGitHubBody["head"])
	assert.Len(t, tokenIssuer.calls, 1)
}

func TestGitHubProxyHandler_PostRepoGitHubProxy_DeniesUnsafeStackActions(t *testing.T) {
	tests := []struct {
		name        string
		payload     map[string]any
		wantMessage string
	}{
		{
			name: "merge",
			payload: map[string]any{
				"method": "PUT",
				"path":   "/repos/acme/demo/pulls/77/merge",
			},
			wantMessage: "pull request merges are not allowed for workflows",
		},
		{
			name: "branch delete",
			payload: map[string]any{
				"method": "DELETE",
				"path":   "/repos/acme/demo/git/refs/heads/smithers/change123",
			},
			wantMessage: "deleting branches is not allowed for workflows",
		},
		{
			name: "repo mismatch",
			payload: map[string]any{
				"method": "POST",
				"path":   "/repos/evil/demo/pulls",
				"body": map[string]any{
					"title": "Sandbox change",
					"head":  "smithers/abcd1234",
					"base":  "main",
				},
			},
			wantMessage: "request path repository does not match workflow repository",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			tokenIssuer := &mockGitHubProxyTokenIssuer{}
			service := services.NewGitHubProxyService(tokenIssuer)
			handler := &GitHubProxyHandler{Service: service}

			body, err := json.Marshal(tt.payload)
			require.NoError(t, err)

			req := httptest.NewRequest(http.MethodPost, "/api/repos/acme/demo/github-proxy", bytes.NewReader(body))
			req.Header.Set("Content-Type", "application/json")
			req = withRouteParams(req, map[string]string{"owner": "acme", "repo": "demo"})
			req = withAuth(req, 42, "alice")
			rec := httptest.NewRecorder()

			handler.PostRepoGitHubProxy(rec, req)

			require.Equal(t, http.StatusForbidden, rec.Code)
			var apiErr pkgerrors.APIError
			require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &apiErr))
			assert.Equal(t, services.GitHubProxyForbiddenActionCode, apiErr.Code)
			assert.Equal(t, tt.wantMessage, apiErr.Message)
			assert.Empty(t, tokenIssuer.calls)
		})
	}
}
