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

func githubCheckRunsZAnnotations(n int) []GitHubCheckRunAnnotation {
	out := make([]GitHubCheckRunAnnotation, 0, n)
	for i := 0; i < n; i++ {
		out = append(out, GitHubCheckRunAnnotation{
			Path:            "main.go",
			StartLine:       i + 1,
			AnnotationLevel: "failure",
			Message:         "failed",
		})
	}
	return out
}

func TestGitHubCheckRuns_Z_GuardsTokenAndUpstreamErrors(t *testing.T) {
	ctx := context.Background()

	var nilSvc *githubCheckRunService
	_, err := nilSvc.PostCheckRun(ctx, 1, 100, "acme", "demo", GitHubCheckRunInput{Name: "ci", HeadSHA: "abc"})
	require.Equal(t, 500, apiStatus(t, err))

	_, err = NewGitHubCheckRunService(nil).UpdateCheckRun(ctx, 1, 100, "acme", "demo", 9, GitHubCheckRunUpdate{})
	require.Equal(t, 500, apiStatus(t, err))

	svc := NewGitHubCheckRunService(&mockGitHubCheckRunTokenIssuer{})
	_, err = svc.PostCheckRun(ctx, 0, 100, "acme", "demo", GitHubCheckRunInput{Name: "ci", HeadSHA: "abc"})
	require.Equal(t, 400, apiStatus(t, err))
	_, err = svc.PostCheckRun(ctx, 1, 100, " ", "demo", GitHubCheckRunInput{Name: "ci", HeadSHA: "abc"})
	require.Equal(t, 400, apiStatus(t, err))
	_, err = svc.UpdateCheckRun(ctx, 1, 100, "acme", "demo", 0, GitHubCheckRunUpdate{})
	require.Equal(t, 400, apiStatus(t, err))

	issuerErr := &mockGitHubCheckRunTokenIssuer{createFn: func(context.Context, int64) (GitHubInstallationToken, error) {
		return GitHubInstallationToken{}, errors.New("token failed")
	}}
	_, err = NewGitHubCheckRunService(issuerErr).PostCheckRun(ctx, 1, 100, "acme", "demo", GitHubCheckRunInput{Name: "ci", HeadSHA: "abc"})
	require.ErrorContains(t, err, "token failed")
	_, err = NewGitHubCheckRunService(issuerErr).UpdateCheckRun(ctx, 1, 100, "acme", "demo", 9, GitHubCheckRunUpdate{})
	require.ErrorContains(t, err, "token failed")

	createFail := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, `{"message":"create failed"}`, http.StatusInternalServerError)
	}))
	defer createFail.Close()
	t.Setenv(envGitHubAppAPIBaseURL, createFail.URL)
	_, err = NewGitHubCheckRunService(&mockGitHubCheckRunTokenIssuer{}).PostCheckRun(ctx, 1, 100, "acme", "demo", GitHubCheckRunInput{Name: "ci", HeadSHA: "abc"})
	require.Equal(t, 500, apiStatus(t, err))

	var calls int
	patchFail := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if calls == 1 {
			_, _ = w.Write([]byte(`{"id":55}`))
			return
		}
		http.Error(w, `{"message":"patch failed"}`, http.StatusUnprocessableEntity)
	}))
	defer patchFail.Close()
	t.Setenv(envGitHubAppAPIBaseURL, patchFail.URL)
	_, err = NewGitHubCheckRunService(&mockGitHubCheckRunTokenIssuer{}).PostCheckRun(ctx, 1, 100, "acme", "demo", GitHubCheckRunInput{
		Name:    "ci",
		HeadSHA: "abc",
		Output:  &GitHubCheckRunOutput{Title: "t", Summary: "s", Annotations: githubCheckRunsZAnnotations(51)},
	})
	require.Equal(t, 400, apiStatus(t, err))
	assert.Equal(t, 2, calls)

	updateFail := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, `{"message":"missing"}`, http.StatusNotFound)
	}))
	defer updateFail.Close()
	t.Setenv(envGitHubAppAPIBaseURL, updateFail.URL)
	_, err = NewGitHubCheckRunService(&mockGitHubCheckRunTokenIssuer{}).UpdateCheckRun(ctx, 1, 100, "acme", "demo", 9, GitHubCheckRunUpdate{})
	require.Equal(t, 404, apiStatus(t, err))
}
