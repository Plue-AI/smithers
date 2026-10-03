package auth

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// githubCoverJSONServer starts a test server that responds with the given
// status code and JSON body for every request.
func githubCoverJSONServer(t *testing.T, status int, body map[string]any) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(body)
	}))
	t.Cleanup(srv.Close)
	return srv
}

func githubCoverClient(srvURL string) *GitHubClient {
	client := NewGitHubClient(&testOAuthCredentials{id: "client-id", secret: "client-secret"}, "http://localhost:4000/api/auth/github/callback", "", "")
	client.oauthBaseURL = srvURL
	return client
}

func TestGitHubClient_RefreshToken_Cover(t *testing.T) {
	t.Parallel()

	t.Run("invalid base URL returns request creation error", func(t *testing.T) {
		t.Parallel()

		client := NewGitHubClient(&testOAuthCredentials{id: "client-id", secret: "client-secret"}, "http://localhost:4000/api/auth/github/callback", "", "")
		client.oauthBaseURL = "://invalid\x7f"

		_, err := client.RefreshToken(context.Background(), "ghr_old")
		require.Error(t, err)
		assert.Contains(t, err.Error(), "create github oauth refresh request")
	})

	t.Run("canceled context returns request failed error", func(t *testing.T) {
		t.Parallel()

		client := NewGitHubClient(&testOAuthCredentials{id: "client-id", secret: "client-secret"}, "http://localhost:4000/api/auth/github/callback", "", "")
		client.oauthBaseURL = "http://localhost:1"

		ctx, cancel := context.WithCancel(context.Background())
		cancel()

		_, err := client.RefreshToken(ctx, "ghr_old")
		require.Error(t, err)
		assert.ErrorIs(t, err, context.Canceled)
	})

	t.Run("decode error on malformed body", func(t *testing.T) {
		t.Parallel()

		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte("not-json"))
		}))
		defer srv.Close()

		client := githubCoverClient(srv.URL)
		_, err := client.RefreshToken(context.Background(), "ghr_old")
		require.Error(t, err)
		assert.Contains(t, err.Error(), "decode github oauth refresh response")
	})

	t.Run("invalid_grant with empty description falls back to error code", func(t *testing.T) {
		t.Parallel()

		srv := githubCoverJSONServer(t, http.StatusOK, map[string]any{
			"error": "invalid_grant",
		})
		client := githubCoverClient(srv.URL)

		_, err := client.RefreshToken(context.Background(), "ghr_bad")
		require.Error(t, err)
		assert.ErrorIs(t, err, services.ErrGitHubRefreshTokenInvalid)
		assert.Contains(t, err.Error(), "invalid_grant")
	})

	t.Run("non-2xx with error_description (non-invalid error code)", func(t *testing.T) {
		t.Parallel()

		srv := githubCoverJSONServer(t, http.StatusBadRequest, map[string]any{
			"error":             "server_error",
			"error_description": "Temporary upstream failure",
		})
		client := githubCoverClient(srv.URL)

		_, err := client.RefreshToken(context.Background(), "ghr_old")
		require.Error(t, err)
		assert.NotErrorIs(t, err, services.ErrGitHubRefreshTokenInvalid)
		assert.Contains(t, err.Error(), "Temporary upstream failure")
	})

	t.Run("non-2xx with error field only", func(t *testing.T) {
		t.Parallel()

		srv := githubCoverJSONServer(t, http.StatusBadRequest, map[string]any{
			"error": "server_error",
		})
		client := githubCoverClient(srv.URL)

		_, err := client.RefreshToken(context.Background(), "ghr_old")
		require.Error(t, err)
		assert.Contains(t, err.Error(), "server_error")
	})

	t.Run("non-2xx with empty JSON body returns status code error", func(t *testing.T) {
		t.Parallel()

		srv := githubCoverJSONServer(t, http.StatusForbidden, map[string]any{})
		client := githubCoverClient(srv.URL)

		_, err := client.RefreshToken(context.Background(), "ghr_old")
		require.Error(t, err)
		assert.Contains(t, err.Error(), "403")
	})

	t.Run("200 empty access token with error_description", func(t *testing.T) {
		t.Parallel()

		srv := githubCoverJSONServer(t, http.StatusOK, map[string]any{
			"access_token":      "",
			"error_description": "no token issued",
		})
		client := githubCoverClient(srv.URL)

		_, err := client.RefreshToken(context.Background(), "ghr_old")
		require.Error(t, err)
		assert.Contains(t, err.Error(), "no token issued")
	})

	t.Run("200 empty access token with error field only", func(t *testing.T) {
		t.Parallel()

		srv := githubCoverJSONServer(t, http.StatusOK, map[string]any{
			"access_token": "",
			"error":        "server_error",
		})
		client := githubCoverClient(srv.URL)

		_, err := client.RefreshToken(context.Background(), "ghr_old")
		require.Error(t, err)
		assert.Contains(t, err.Error(), "server_error")
	})

	t.Run("200 empty access token with no error fields", func(t *testing.T) {
		t.Parallel()

		srv := githubCoverJSONServer(t, http.StatusOK, map[string]any{
			"access_token": "   ",
		})
		client := githubCoverClient(srv.URL)

		_, err := client.RefreshToken(context.Background(), "ghr_old")
		require.Error(t, err)
		assert.Contains(t, err.Error(), "empty access token")
	})
}
