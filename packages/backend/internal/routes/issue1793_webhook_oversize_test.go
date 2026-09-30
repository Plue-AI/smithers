package routes

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestIssue1793GitHubWebhookBodyBoundary(t *testing.T) {
	for _, tc := range []struct {
		name       string
		size       int
		streamed   bool
		wantStatus int
		wantCalls  int
	}{
		{"at limit", gitHubWebhookMaxBodyBytes, false, http.StatusOK, 1},
		{"over limit", gitHubWebhookMaxBodyBytes + 1, false, http.StatusRequestEntityTooLarge, 0},
		{"streamed over limit", gitHubWebhookMaxBodyBytes + 1, true, http.StatusRequestEntityTooLarge, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls := 0
			payloadSize := 0
			handler := &GitHubWebhookHandler{Service: &mockGitHubWebhookRouteService{
				handleFn: func(_ context.Context, _, _, _ string, payload []byte) error {
					calls++
					payloadSize = len(payload)
					return nil
				},
			}}
			req := httptest.NewRequest(http.MethodPost, "/webhooks/github", strings.NewReader(strings.Repeat("x", tc.size)))
			if tc.streamed {
				req.ContentLength = -1
				req.TransferEncoding = []string{"chunked"}
			}
			req.Header.Set(gitHubWebhookEventHeader, "push")
			req.Header.Set(gitHubWebhookDeliveryHeader, "issue1793-delivery")
			rec := httptest.NewRecorder()
			handler.PostGitHubWebhook(rec, req)
			require.Equal(t, tc.wantStatus, rec.Code)
			require.Equal(t, tc.wantCalls, calls)
			if tc.wantCalls > 0 {
				require.Equal(t, tc.size, payloadSize)
			}
		})
	}
}

func TestIssue1793StripeWebhookBodyBoundary(t *testing.T) {
	const limit = 1 << 20
	for _, tc := range []struct {
		name       string
		size       int
		streamed   bool
		wantStatus int
		wantCalls  int
	}{
		{"at limit", limit, false, http.StatusOK, 1},
		{"over limit", limit + 1, false, http.StatusRequestEntityTooLarge, 0},
		{"streamed over limit", limit + 1, true, http.StatusRequestEntityTooLarge, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls := 0
			payloadSize := 0
			handler := &BillingHandler{Service: &mockBillingRouteService{
				handleWebhookFn: func(_ context.Context, payload []byte, _ string) error {
					calls++
					payloadSize = len(payload)
					return nil
				},
			}}
			req := httptest.NewRequest(http.MethodPost, "/webhooks/stripe", strings.NewReader(strings.Repeat("x", tc.size)))
			if tc.streamed {
				req.ContentLength = -1
				req.TransferEncoding = []string{"chunked"}
			}
			rec := httptest.NewRecorder()
			handler.PostStripeWebhook(rec, req)
			require.Equal(t, tc.wantStatus, rec.Code)
			require.Equal(t, tc.wantCalls, calls)
			if tc.wantCalls > 0 {
				require.Equal(t, tc.size, payloadSize)
			}
		})
	}
}
