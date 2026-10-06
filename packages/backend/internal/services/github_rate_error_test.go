package services

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"sync/atomic"
	"testing"
	"time"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/stretchr/testify/require"
)

func TestGitHubRateLimitErrorThroughSharedReadAndWrite(t *testing.T) {
	deadline := time.Now().UTC().Add(time.Hour).Truncate(time.Second)
	for _, method := range []string{http.MethodGet, http.MethodPost} {
		for _, tc := range []struct {
			name    string
			status  int
			headers http.Header
			limited bool
		}{
			{"secondary", 403, http.Header{"Retry-After": {deadline.Format(http.TimeFormat)}}, true},
			{"primary", 403, http.Header{"X-Ratelimit-Remaining": {"0"}, "X-Ratelimit-Reset": {strconv.FormatInt(deadline.Unix(), 10)}}, true},
			{"429", 429, http.Header{"Retry-After": {deadline.Format(http.TimeFormat)}}, true},
			{"permission", 403, nil, false},
			{"absent", 404, nil, false},
			{"write-conflict", 409, nil, false},
		} {
			t.Run(method+"/"+tc.name, func(t *testing.T) {
				var calls atomic.Int32
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					calls.Add(1)
					for key, values := range tc.headers {
						for _, value := range values {
							w.Header().Add(key, value)
						}
					}
					w.WriteHeader(tc.status)
					_, _ = w.Write([]byte(`{"message":"private upstream detail"}`))
				}))
				defer server.Close()
				api := &landingGitHubAPI{client: server.Client(), baseURL: func() string { return server.URL }}
				status, headers, err := api.requestHeaders(context.Background(), "token", method, "/repos/acme/app/pulls", "", nil, nil)
				require.Equal(t, tc.status, status)
				require.NotNil(t, headers)
				require.EqualValues(t, 1, calls.Load(), "classification never retries an outbound request")
				if !tc.limited {
					require.NoError(t, err)
					return
				}
				var limited *pkgerrors.APIError
				require.ErrorAs(t, err, &limited)
				require.Equal(t, pkgerrors.CodeGitHubRateLimited, limited.Code)
				require.Equal(t, pkgerrors.ClassGitHub, limited.Class)
				require.Equal(t, http.StatusTooManyRequests, limited.Status)
				require.Equal(t, deadline, *limited.RetryAt)
				require.Greater(t, limited.RetryAfter, 3500)
				require.NotContains(t, limited.Error(), "private upstream detail")
			})
		}
	}
}

func TestGitHubRateLimitErrorFromSharedAdmission(t *testing.T) {
	deadline := time.Now().UTC().Add(time.Hour).Truncate(time.Second)
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.Header().Set("Retry-After", deadline.Format(http.TimeFormat))
		w.WriteHeader(http.StatusTooManyRequests)
	}))
	defer server.Close()
	budget := NewGitHubResponseBudgetTracker()
	api := &landingGitHubAPI{client: budget.WrapClient(server.Client()), baseURL: func() string { return server.URL }}
	for i := 0; i < 2; i++ {
		status, err := api.request(context.Background(), "same-token", http.MethodGet, "/repos/acme/app/issues", nil, nil)
		require.Equal(t, 429, status)
		var limited *pkgerrors.APIError
		require.ErrorAs(t, err, &limited)
		require.Equal(t, pkgerrors.CodeGitHubRateLimited, limited.Code)
		require.WithinDuration(t, deadline, *limited.RetryAt, time.Second)
	}
	require.EqualValues(t, 1, calls.Load(), "the second typed refusal comes from shared local admission")
}

func TestGitHubRateLimitSurvivesSetupWorkerAndReload(t *testing.T) {
	f := newSetupFixture(t, "repository")
	deadline := time.Now().UTC().Add(2 * time.Hour).Truncate(time.Second)
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.Header().Set("Retry-After", deadline.Format(http.TimeFormat))
		w.WriteHeader(http.StatusTooManyRequests)
	}))
	defer server.Close()
	api := &landingGitHubAPI{client: server.Client(), baseURL: func() string { return server.URL }}
	f.svc.Providers = map[string]func(context.Context, *jobs.Lease, InstallSetupInput) error{"repository": func(ctx context.Context, _ *jobs.Lease, _ InstallSetupInput) error {
		_, err := api.request(ctx, "token", http.MethodGet, "/repos/acme/app", nil, nil)
		return err
	}}
	receipt, err := f.svc.Admit(t.Context(), "repository", "rate-limited-repository", json.RawMessage(`{"repository":"acme/app"}`))
	require.NoError(t, err)
	f.run(t, "repository")
	f.awaitStep(t, "repository", InstallFailed)
	restarted := &InstallSetupService{Pool: f.pool, Jobs: f.store}
	steps, err := restarted.Steps(t.Context())
	require.NoError(t, err)
	var failure *InstallReadinessError
	for _, step := range steps {
		if step.ID == "repository" {
			failure = step.Error
		}
	}
	require.NotNil(t, failure)
	require.Equal(t, "github_rate_limited", failure.Code)
	require.Equal(t, "github", failure.Class)
	require.Equal(t, deadline, *failure.RetryAt)
	operation, err := f.store.Get(t.Context(), jobs.Scope{TenantID: "install", PrincipalID: "owner"}, receipt.OperationID)
	require.NoError(t, err)
	require.Equal(t, jobs.StateFailed, operation.State)
	require.EqualValues(t, 1, calls.Load(), "reading the persisted failure does not retry the provider")
}

func TestGitHubRateLimitDirectReaders(t *testing.T) {
	deadline := time.Now().UTC().Add(2 * time.Hour).Truncate(time.Second)
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.Header().Set("Retry-After", deadline.Format(http.TimeFormat))
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte("untrusted upstream body"))
	}))
	defer server.Close()
	t.Setenv(envGitHubAppAPIBaseURL, server.URL)
	user := NewGitHubUserReposService(newFakeGitHubUserReposDB(), nil, WithGitHubUserReposHTTPClient(server.Client()))
	list := NewGitHubRepoListService(fakeRepoListDB{}, fakeRepoListTokenIssuer{instID: 7001}, WithGitHubRepoListHTTPClient(server.Client()))
	manifest := NewGitHubAppManifestService(nil, nil, server.URL, nil)
	for _, tc := range []struct {
		name string
		read func() error
	}{
		{"user permissions", func() error {
			_, _, e := user.requestGitHubRepoPushPermission(t.Context(), "user", "acme", "app")
			return e
		}},
		{"user list", func() error { _, _, e := user.requestGitHubUserRepos(t.Context(), "user", url.Values{}); return e }},
		{"user metadata", func() error {
			_, e := user.requestGitHubRepoMetadata(t.Context(), "user", "acme", "app", "issues", url.Values{})
			return e
		}},
		{"installation list", func() error { _, e := list.ListInstallationRepositories(t.Context(), 42, url.Values{}); return e }},
		{"manifest owner", func() error { return manifest.request(t.Context(), http.MethodGet, "/users/acme", "", nil) }},
		{"manifest conversion", func() error {
			return manifest.request(t.Context(), http.MethodPost, "/app-manifests/secret/conversions", "", nil)
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var limited *pkgerrors.APIError
			require.ErrorAs(t, tc.read(), &limited)
			require.Equal(t, pkgerrors.CodeGitHubRateLimited, limited.Code)
			require.Equal(t, pkgerrors.ClassGitHub, limited.Class)
			require.Equal(t, deadline, *limited.RetryAt)
			require.Greater(t, limited.RetryAfter, 7100)
			require.NotContains(t, limited.Error(), "untrusted")
		})
	}
	require.EqualValues(t, 6, calls.Load())
}
