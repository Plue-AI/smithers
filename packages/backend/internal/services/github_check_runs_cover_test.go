package services

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type githubCheckRunsCovRoundTripper struct {
	err error
}

func (rt githubCheckRunsCovRoundTripper) RoundTrip(*http.Request) (*http.Response, error) {
	return nil, rt.err
}

func TestGithubCheckRuns_Cov_ValidationAndTokenErrors(t *testing.T) {
	ctx := context.Background()
	var nilSvc *githubCheckRunService
	_, err := nilSvc.PostCheckRun(ctx, 1, 100, "acme", "demo", GitHubCheckRunInput{Name: "ci", HeadSHA: "abc"})
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	svc := NewGitHubCheckRunService(&mockGitHubCheckRunTokenIssuer{}).(*githubCheckRunService)
	for _, input := range []struct {
		installationID int64
		owner          string
		repo           string
		name           string
		sha            string
		status         int
	}{
		{installationID: 0, owner: "acme", repo: "demo", name: "ci", sha: "abc", status: 400},
		{installationID: 1, owner: " ", repo: "demo", name: "ci", sha: "abc", status: 400},
		{installationID: 1, owner: "acme", repo: " ", name: "ci", sha: "abc", status: 400},
		{installationID: 1, owner: "acme", repo: "demo", name: " ", sha: "abc", status: 400},
		{installationID: 1, owner: "acme", repo: "demo", name: "ci", sha: " ", status: 400},
	} {
		_, err := svc.PostCheckRun(ctx, input.installationID, 100, input.owner, input.repo, GitHubCheckRunInput{Name: input.name, HeadSHA: input.sha})
		require.Error(t, err)
		assert.Equal(t, input.status, apiStatus(t, err))
	}

	_, err = svc.UpdateCheckRun(ctx, 0, 100, "acme", "demo", 1, GitHubCheckRunUpdate{})
	require.Error(t, err)
	assert.Equal(t, 400, apiStatus(t, err))
	_, err = svc.UpdateCheckRun(ctx, 1, 100, "acme", "demo", 0, GitHubCheckRunUpdate{})
	require.Error(t, err)
	assert.Equal(t, 400, apiStatus(t, err))
	_, err = svc.UpdateCheckRun(ctx, 1, 100, "", "demo", 1, GitHubCheckRunUpdate{})
	require.Error(t, err)
	assert.Equal(t, 400, apiStatus(t, err))

	tokenSvc := &githubCheckRunService{tokenIssuer: &mockGitHubCheckRunTokenIssuer{
		createFn: func(context.Context, int64) (GitHubInstallationToken, error) {
			return GitHubInstallationToken{}, assert.AnError
		},
	}}
	_, err = tokenSvc.issueInstallationToken(ctx, 1, 100)
	require.ErrorIs(t, err, assert.AnError)

	tokenSvc.tokenIssuer = &mockGitHubCheckRunTokenIssuer{
		createFn: func(context.Context, int64) (GitHubInstallationToken, error) {
			return GitHubInstallationToken{InstallationID: 2, Token: "tok"}, nil
		},
	}
	_, err = tokenSvc.issueInstallationToken(ctx, 1, 100)
	require.Error(t, err)
	assert.Equal(t, 403, apiStatus(t, err))

	tokenSvc.tokenIssuer = &mockGitHubCheckRunTokenIssuer{
		createFn: func(context.Context, int64) (GitHubInstallationToken, error) {
			return GitHubInstallationToken{InstallationID: 1, Token: " "}, nil
		},
	}
	_, err = tokenSvc.issueInstallationToken(ctx, 1, 100)
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))
}

func TestGithubCheckRuns_Cov_HTTPStatusMappingAndDecodeBranches(t *testing.T) {
	ctx := context.Background()

	for _, tc := range []struct {
		name   string
		status int
		body   string
		want   int
	}{
		{name: "forbidden", status: http.StatusForbidden, body: `{"message":"suspended"}`, want: 403},
		{name: "not found", status: http.StatusNotFound, body: `{"message":"missing"}`, want: 404},
		{name: "unprocessable", status: http.StatusUnprocessableEntity, body: `{"message":"bad annotations"}`, want: 400},
		{name: "server", status: http.StatusInternalServerError, body: `{}`, want: 500},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				assert.Equal(t, "Bearer tok", r.Header.Get("Authorization"))
				w.WriteHeader(tc.status)
				_, _ = w.Write([]byte(tc.body))
			}))
			defer server.Close()
			svc := &githubCheckRunService{httpClient: server.Client()}
			err := svc.doGitHubJSON(ctx, 99, http.MethodPost, server.URL, " tok ", map[string]string{"ok": "true"}, nil)
			require.Error(t, err)
			assert.Equal(t, tc.want, apiStatus(t, err))
		})
	}

	decodeServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{`))
	}))
	defer decodeServer.Close()
	svc := &githubCheckRunService{httpClient: decodeServer.Client()}
	var out GitHubCheckRunResult
	err := svc.doGitHubJSON(ctx, 1, http.MethodPost, decodeServer.URL, "tok", nil, &out)
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	emptyServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	defer emptyServer.Close()
	svc = &githubCheckRunService{httpClient: emptyServer.Client()}
	require.NoError(t, svc.doGitHubJSON(ctx, 1, http.MethodPatch, emptyServer.URL, "tok", nil, &out))

	err = svc.doGitHubJSON(ctx, 1, http.MethodPost, "://bad-url", "tok", nil, nil)
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))
	err = svc.doGitHubJSON(ctx, 1, http.MethodPost, emptyServer.URL, "tok", make(chan int), nil)
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	svc = &githubCheckRunService{httpClient: &http.Client{Transport: githubCheckRunsCovRoundTripper{err: errors.New("network down")}}}
	err = svc.doGitHubJSON(ctx, 1, http.MethodPost, "https://example.test/check-runs", "tok", nil, nil)
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))
}

func TestGithubCheckRuns_Cov_CreateUpdateAndBatchHelpers(t *testing.T) {
	ctx := context.Background()
	var methods []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		methods = append(methods, r.Method)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":123,"html_url":"https://github.test/acme/demo/runs/123"}`))
	}))
	defer server.Close()

	svc := &githubCheckRunService{httpClient: server.Client()}
	created, err := svc.createCheckRunWithToken(ctx, 7, server.URL, "tok", githubCreateCheckRunRequest{Name: "ci", HeadSHA: "abc"})
	require.NoError(t, err)
	assert.Equal(t, int64(123), created.ID)
	assert.Equal(t, created.HTMLURL, created.URL)
	updated, err := svc.updateCheckRunWithToken(ctx, 7, server.URL, "tok", githubUpdateCheckRunRequest{Status: "completed"})
	require.NoError(t, err)
	assert.Equal(t, int64(123), updated.ID)
	assert.Equal(t, []string{http.MethodPost, http.MethodPatch}, methods)

	assert.Equal(t, []*GitHubCheckRunOutput{nil}, splitCheckRunOutputBatches(nil, 50))
	output := &GitHubCheckRunOutput{Title: "title", Summary: "summary"}
	assert.Equal(t, []*GitHubCheckRunOutput{output}, splitCheckRunOutputBatches(output, 0))
	normalized := normalizeCheckRunResult(GitHubCheckRunResult{URL: "https://api.test/run"})
	assert.Equal(t, normalized.URL, normalized.HTMLURL)
	normalized = normalizeCheckRunResult(GitHubCheckRunResult{HTMLURL: "https://github.test/run"})
	assert.Equal(t, normalized.HTMLURL, normalized.URL)
}
