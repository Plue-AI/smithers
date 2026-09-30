package services_test

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/stretchr/testify/require"
)

// Authentication is absent for a public read; the authorizer isolates admission
// handling from database policy. Both HTTP hops and the proxy service are real.
type admissionReadAuthorizer struct{}

func (admissionReadAuthorizer) Authorize(context.Context, int64, string, string, services.AccessMode) error {
	return nil
}

func TestUploadPackAdmissionHTTPBoundary(t *testing.T) {
	for _, tc := range []struct {
		code       string
		status     int
		retry      string
		wantStatus int
		wantRetry  string
	}{
		{repohost.UploadPackQueueFullCode, http.StatusServiceUnavailable, "900", http.StatusServiceUnavailable, "1"},
		{repohost.UploadPackQueueTimeoutCode, http.StatusGatewayTimeout, "", http.StatusGatewayTimeout, ""},
		{repohost.UploadPackNegotiationTooLargeCode, http.StatusRequestEntityTooLarge, "", http.StatusRequestEntityTooLarge, ""},
		{repohost.UploadPackQueueFullCode, http.StatusGatewayTimeout, "900", http.StatusInternalServerError, ""},
		{"unrelated", http.StatusServiceUnavailable, "900", http.StatusInternalServerError, ""},
	} {
		t.Run(tc.code, func(t *testing.T) {
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				require.Equal(t, "/repos/alice/demo/git/upload-pack", r.URL.Path)
				_, _ = io.Copy(io.Discard, r.Body)
				w.Header().Set("X-Smithers-Error-Code", tc.code)
				if tc.retry != "" {
					w.Header().Set("Retry-After", tc.retry)
				}
				w.WriteHeader(tc.status)
				_, _ = io.WriteString(w, "secret upstream details")
			}))
			t.Cleanup(upstream.Close)
			client := repohost.NewClient(&repohost.StaticStorageSetResolver{URL: upstream.URL}, "token")
			svc := services.NewGitHTTPProxyService(nil, admissionReadAuthorizer{}, client)
			handler := &routes.GitSmartHandler{Service: svc}
			router := chi.NewRouter()
			router.Post("/{owner}/{repo}/git-upload-pack", handler.UploadPack)
			req := httptest.NewRequest(http.MethodPost, "/alice/demo.git/git-upload-pack", bytes.NewReader(nil))
			out := httptest.NewRecorder()
			router.ServeHTTP(out, req)
			require.Equal(t, tc.wantStatus, out.Code)
			require.Equal(t, tc.wantRetry, out.Header().Get("Retry-After"))
			require.NotContains(t, out.Body.String(), "secret")
		})
	}
}
