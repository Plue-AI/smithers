package services

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type mockGitHubCheckRunTokenIssuer struct {
	createFn func(ctx context.Context, installationID int64) (GitHubInstallationToken, error)

	calls []struct {
		installationID int64
	}
}

func (m *mockGitHubCheckRunTokenIssuer) CreateGitHubInstallationToken(ctx context.Context, installationID int64, _ GitHubTokenScope) (GitHubInstallationToken, error) {
	m.calls = append(m.calls, struct {
		installationID int64
	}{
		installationID: installationID,
	})
	if m.createFn != nil {
		return m.createFn(ctx, installationID)
	}
	return GitHubInstallationToken{
		InstallationID: installationID,
		Token:          "test-install-token",
	}, nil
}

func TestGitHubCheckRunService_PostCheckRun_BatchesAnnotations(t *testing.T) {
	var methods []string
	var annotationCounts []int
	var patchStatuses []string

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		methods = append(methods, r.Method)
		assert.Equal(t, "Bearer test-install-token", r.Header.Get("Authorization"))

		var payload struct {
			Status string `json:"status"`
			Output struct {
				Annotations []map[string]any `json:"annotations"`
			} `json:"output"`
		}
		require.NoError(t, json.NewDecoder(r.Body).Decode(&payload))
		annotationCounts = append(annotationCounts, len(payload.Output.Annotations))
		if r.Method == http.MethodPatch {
			patchStatuses = append(patchStatuses, payload.Status)
		}

		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/repos/acme/demo/check-runs":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"id":777,"url":"https://api.github.com/repos/acme/demo/check-runs/777","html_url":"https://github.com/acme/demo/runs/777"}`))
		case r.Method == http.MethodPatch && r.URL.Path == "/repos/acme/demo/check-runs/777":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"id":777,"url":"https://api.github.com/repos/acme/demo/check-runs/777","html_url":"https://github.com/acme/demo/runs/777"}`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()

	t.Setenv(envGitHubAppAPIBaseURL, server.URL)

	tokenIssuer := &mockGitHubCheckRunTokenIssuer{}
	svc := NewGitHubCheckRunService(tokenIssuer)

	annotations := make([]GitHubCheckRunAnnotation, 0, 120)
	for i := 1; i <= 120; i++ {
		annotations = append(annotations, GitHubCheckRunAnnotation{
			Path:            "src/main.go",
			StartLine:       i,
			EndLine:         i,
			AnnotationLevel: "warning",
			Message:         "lint issue",
		})
	}

	result, err := svc.PostCheckRun(context.Background(), 11, 100, "acme", "demo", GitHubCheckRunInput{
		Name:    "smithers / CI",
		HeadSHA: "abc123",
		Status:  "in_progress",
		Output: &GitHubCheckRunOutput{
			Title:       "Run started",
			Summary:     "Workflow is running.",
			Annotations: annotations,
		},
	})
	require.NoError(t, err)
	assert.Equal(t, int64(777), result.ID)
	assert.Equal(t, "https://api.github.com/repos/acme/demo/check-runs/777", result.URL)

	require.Len(t, tokenIssuer.calls, 1)
	assert.Equal(t, int64(11), tokenIssuer.calls[0].installationID)

	assert.Equal(t, []string{http.MethodPost, http.MethodPatch, http.MethodPatch}, methods)
	assert.Equal(t, []int{50, 50, 20}, annotationCounts)
	assert.Equal(t, []string{"", ""}, patchStatuses)
}

func TestGitHubCheckRunService_UpdateCheckRun_BatchesAnnotations(t *testing.T) {
	var requestBodies []map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, http.MethodPatch, r.Method)
		require.Equal(t, "/repos/acme/demo/check-runs/999", r.URL.Path)
		assert.Equal(t, "Bearer test-install-token", r.Header.Get("Authorization"))

		var body map[string]any
		require.NoError(t, json.NewDecoder(r.Body).Decode(&body))
		requestBodies = append(requestBodies, body)

		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":999,"url":"https://api.github.com/repos/acme/demo/check-runs/999","html_url":"https://github.com/acme/demo/runs/999"}`))
	}))
	defer server.Close()

	t.Setenv(envGitHubAppAPIBaseURL, server.URL)

	tokenIssuer := &mockGitHubCheckRunTokenIssuer{}
	svc := NewGitHubCheckRunService(tokenIssuer)

	annotations := make([]GitHubCheckRunAnnotation, 0, 70)
	for i := 1; i <= 70; i++ {
		annotations = append(annotations, GitHubCheckRunAnnotation{
			Path:            "src/main.go",
			StartLine:       i,
			EndLine:         i,
			AnnotationLevel: "failure",
			Message:         "test failure",
		})
	}

	result, err := svc.UpdateCheckRun(context.Background(), 11, 100, "acme", "demo", 999, GitHubCheckRunUpdate{
		Status:     "completed",
		Conclusion: "failure",
		Output: &GitHubCheckRunOutput{
			Title:       "Run failed",
			Summary:     "One or more steps failed.",
			Annotations: annotations,
		},
	})
	require.NoError(t, err)
	assert.Equal(t, int64(999), result.ID)

	require.Len(t, tokenIssuer.calls, 1)
	require.Len(t, requestBodies, 2)

	firstAnnotations := requestBodies[0]["output"].(map[string]any)["annotations"].([]any)
	secondAnnotations := requestBodies[1]["output"].(map[string]any)["annotations"].([]any)
	assert.Len(t, firstAnnotations, 50)
	assert.Len(t, secondAnnotations, 20)
	assert.Equal(t, "completed", requestBodies[0]["status"])
	assert.Equal(t, "failure", requestBodies[0]["conclusion"])

	_, hasStatusSecond := requestBodies[1]["status"]
	_, hasConclusionSecond := requestBodies[1]["conclusion"]
	assert.False(t, hasStatusSecond)
	assert.False(t, hasConclusionSecond)
}

func TestSplitCheckRunOutputBatches(t *testing.T) {
	t.Parallel()

	output := &GitHubCheckRunOutput{
		Title:   "title",
		Summary: "summary",
		Text:    "text",
	}
	for i := 1; i <= 51; i++ {
		output.Annotations = append(output.Annotations, GitHubCheckRunAnnotation{
			Path:            "a.go",
			StartLine:       i,
			EndLine:         i,
			AnnotationLevel: "notice",
			Message:         "note",
		})
	}

	batches := splitCheckRunOutputBatches(output, 50)
	require.Len(t, batches, 2)
	assert.Len(t, batches[0].Annotations, 50)
	assert.Len(t, batches[1].Annotations, 1)
	assert.Equal(t, "title", batches[1].Title)
	assert.Equal(t, "summary", batches[1].Summary)
	assert.Equal(t, "text", batches[1].Text)
}

func TestGitHubCheckRunService_PostCheckRun_RejectsMissingNameOrSHA(t *testing.T) {
	t.Parallel()

	svc := NewGitHubCheckRunService(&mockGitHubCheckRunTokenIssuer{})

	_, err := svc.PostCheckRun(context.Background(), 1, 100, "acme", "demo", GitHubCheckRunInput{
		Name:    "",
		HeadSHA: "abc",
	})
	require.Error(t, err)
	assert.True(t, strings.Contains(err.Error(), "required"))
}
