package auth

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/stretchr/testify/require"
)

func TestGitHubClientRateLimitPrecedesCredentialFailure(t *testing.T) {
	for _, action := range []string{"exchange", "refresh", "profile", "emails"} {
		t.Run(action, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Retry-After", "120")
				w.WriteHeader(403)
				_, _ = io.WriteString(w, `{"error":"invalid_grant"}`)
			}))
			defer server.Close()
			client := githubCoverClient(server.URL)
			client.apiBaseURL = server.URL
			var err error
			switch action {
			case "exchange":
				_, err = client.ExchangeCode(t.Context(), "code")
			case "refresh":
				_, err = client.RefreshToken(t.Context(), "refresh")
			case "profile":
				_, err = client.FetchUser(t.Context(), "access")
			case "emails":
				_, err = client.FetchEmails(t.Context(), "access")
			}
			var failure *pkgerrors.APIError
			require.ErrorAs(t, err, &failure)
			require.Equal(t, pkgerrors.CodeGitHubRateLimited, failure.Code)
			require.Equal(t, pkgerrors.ClassGitHub, failure.Class)
			require.Equal(t, 120, failure.RetryAfter)
			require.NotNil(t, failure.RetryAt)
			require.NotErrorIs(t, err, services.ErrGitHubRefreshTokenInvalid)
			require.NotErrorIs(t, err, services.ErrGitHubTokenRejected)
		})
	}
}

func TestGitHubClientTokenResponsesMustBeComplete(t *testing.T) {
	for _, action := range []string{"exchange", "refresh"} {
		t.Run(action, func(t *testing.T) {
			for _, failure := range []string{"truncated", "oversized", "trailing JSON"} {
				t.Run(failure, func(t *testing.T) {
					server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
						body := `{"access_token":"new-access","refresh_token":"new-refresh","expires_in":3600}`
						switch failure {
						case "truncated":
							w.Header().Set("Content-Length", strconv.Itoa(len(body)+10))
						case "oversized":
							body += strings.Repeat(" ", 1<<20)
						case "trailing JSON":
							body += `{}`
						}
						_, _ = io.WriteString(w, body)
					}))
					defer server.Close()
					client := githubCoverClient(server.URL)
					var result services.GitHubTokenResult
					var err error
					if action == "exchange" {
						result, err = client.ExchangeCode(t.Context(), "code")
					} else {
						result, err = client.RefreshToken(t.Context(), "refresh")
					}
					require.Error(t, err)
					require.Empty(t, result.AccessToken)
					require.Empty(t, result.RefreshToken)
					require.NotErrorIs(t, err, services.ErrGitHubRefreshTokenInvalid)
				})
			}
		})
	}
}
