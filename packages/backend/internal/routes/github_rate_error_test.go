package routes

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/stretchr/testify/require"
)

func TestGitHubRateLimitPreservesInstallEnvelope(t *testing.T) {
	for _, write := range []struct {
		name string
		send func(http.ResponseWriter, *http.Request, error)
	}{
		{"setup", WriteInstallSetupError},
		{"members", func(w http.ResponseWriter, _ *http.Request, e error) { memberRouteError(w, e) }},
		{"ordinary route", writeRouteError},
	} {
		t.Run(write.name, func(t *testing.T) {
			at := time.Date(2026, 10, 5, 22, 0, 0, 0, time.UTC)
			err := pkgerrors.New(pkgerrors.CodeGitHubRateLimited, "GitHub rate limit reached")
			err.RetryAfter = 120
			err.RetryAt = &at
			rec := httptest.NewRecorder()
			write.send(rec, httptest.NewRequest("GET", "/", nil), fmt.Errorf("poll: %w", err))
			require.Equal(t, 429, rec.Code)
			require.Equal(t, "120", rec.Header().Get("Retry-After"))
			require.Contains(t, rec.Body.String(), `"code":"github_rate_limited"`)
			require.Contains(t, rec.Body.String(), `"class":"github"`)
			require.Contains(t, rec.Body.String(), `"retry_at":"2026-10-05T22:00:00Z"`)
			require.NotContains(t, rec.Body.String(), "poll:")
		})
	}
}

func TestGitHubResponseFailurePreservesInstallEnvelope(t *testing.T) {
	for _, code := range []pkgerrors.Code{pkgerrors.CodeGitHubPermission, pkgerrors.CodeGitHubNotInstalled, pkgerrors.CodeGitHubUnavailable} {
		t.Run(string(code), func(t *testing.T) {
			for _, write := range []func(http.ResponseWriter, *http.Request, error){WriteInstallSetupError, writeRouteError} {
				err := pkgerrors.New(code, "GitHub request failed")
				rec := httptest.NewRecorder()
				write(rec, httptest.NewRequest("GET", "/", nil), err)
				require.Equal(t, http.StatusBadGateway, rec.Code)
				require.Contains(t, rec.Body.String(), `"class":"github"`)
				require.Contains(t, rec.Body.String(), `"code":"`+string(code)+`"`)
				require.NotContains(t, rec.Body.String(), "retry_at")
			}
		})
	}
}
