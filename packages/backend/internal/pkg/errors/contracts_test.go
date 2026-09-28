package errors

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestSpecializedConstructorsUseRegisteredVerdicts(t *testing.T) {
	for _, tc := range []struct {
		name       string
		build      func(string) *APIError
		code       Code
		status     int
		fault      Fault
		retryAfter int
	}{
		{"desktop not ready", DesktopNotReady, CodeDesktopNotReady, http.StatusServiceUnavailable, FaultWait, 2},
		{"desktop not running", DesktopNotRunning, CodeDesktopNotRunning, http.StatusConflict, FaultUser, 0},
		{"desktop busy", DesktopBusy, CodeDesktopBusy, http.StatusConflict, FaultWait, 1},
		{"desktop tools unavailable", DesktopToolsUnavailable, CodeDesktopToolsUnavailable, http.StatusConflict, FaultInfra, 0},
		{"environment image unavailable", EnvironmentImageUnavailable, CodeEnvironmentImageUnavailable, http.StatusConflict, FaultInfra, 0},
		{"desktop act repeated", DesktopActRepeated, CodeDesktopActRepeated, http.StatusConflict, FaultUser, 0},
		{"guest not ready", GuestNotReady, CodeGuestNotReady, http.StatusServiceUnavailable, FaultWait, 3},
		{"github reconnect required", GitHubReconnectRequired, CodeGitHubReconnectRequired, http.StatusUnauthorized, FaultUser, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			entry, ok := Lookup(tc.code)
			require.True(t, ok)
			err := tc.build("client-facing sentence")
			require.Equal(t, tc.code, err.Code)
			require.Equal(t, tc.status, err.Status)
			require.Equal(t, tc.fault, err.Fault)
			require.Equal(t, tc.retryAfter, err.RetryAfter)
			require.Equal(t, entry.Status, err.Status)
			require.Equal(t, entry.Fault, err.Fault)
			require.Equal(t, entry.RetryAfter, err.RetryAfter)
			require.Equal(t, "client-facing sentence", err.Message)
		})
	}
	for _, tc := range []struct {
		name       string
		build      func(string, any) *APIError
		code       Code
		status     int
		fault      Fault
		retryAfter int
	}{
		{"frame changed", DesktopFrameChanged, CodeDesktopFrameChanged, http.StatusConflict, FaultUser, 0},
		{"focus terminal", DesktopFocusTerminal, CodeDesktopFocusTerminal, http.StatusConflict, FaultUser, 0},
		{"input out of bounds", DesktopInputOutOfBounds, CodeDesktopInputOutOfBounds, http.StatusUnprocessableEntity, FaultUser, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			details := map[string]any{"completed": 2, "index": 3}
			err := tc.build("action refused", details)
			entry, ok := Lookup(tc.code)
			require.True(t, ok)
			require.Equal(t, tc.code, err.Code)
			require.Equal(t, tc.status, err.Status)
			require.Equal(t, tc.fault, err.Fault)
			require.Equal(t, tc.retryAfter, err.RetryAfter)
			require.Equal(t, entry.Status, err.Status)
			require.Equal(t, entry.Fault, err.Fault)
			require.Equal(t, entry.RetryAfter, err.RetryAfter)
			require.Equal(t, details, err.Details)
			response := httptest.NewRecorder()
			WriteError(response, err)
			var body map[string]any
			require.NoError(t, json.Unmarshal(response.Body.Bytes(), &body))
			wireDetails, ok := body["details"].(map[string]any)
			require.True(t, ok)
			require.Equal(t, float64(2), wireDetails["completed"])
		})
	}
}

func TestBareStatusesReceiveSpecificFallbackVerdicts(t *testing.T) {
	for _, tc := range []struct {
		status int
		code   Code
	}{
		{http.StatusBadRequest, CodeBadRequest},
		{http.StatusUnauthorized, CodeUnauthorized},
		{http.StatusForbidden, CodeForbidden},
		{http.StatusNotFound, CodeNotFound},
		{http.StatusConflict, CodeConflict},
		{http.StatusRequestEntityTooLarge, CodeRequestEntityTooLarge},
		{http.StatusUnsupportedMediaType, CodeUnsupportedMediaType},
		{http.StatusUnprocessableEntity, CodeUnprocessableEntity},
		{http.StatusTooEarly, CodeWorkspaceSessionPending},
		{http.StatusTooManyRequests, CodeRateLimitExceeded},
		{http.StatusNotImplemented, CodeNotImplemented},
		{http.StatusBadGateway, CodeBadGateway},
		{http.StatusServiceUnavailable, CodeServiceUnavailable},
		{http.StatusGatewayTimeout, CodeGatewayTimeout},
		{http.StatusTeapot, CodeBadRequest},
		{http.StatusHTTPVersionNotSupported, CodeInternal},
	} {
		t.Run(http.StatusText(tc.status), func(t *testing.T) {
			original := &APIError{Status: tc.status, Message: "failure"}
			response := httptest.NewRecorder()
			WriteError(response, original)
			var body APIError
			require.NoError(t, json.Unmarshal(response.Body.Bytes(), &body))
			entry, ok := Lookup(tc.code)
			require.True(t, ok)
			require.Equal(t, tc.code, body.Code)
			require.Equal(t, entry.Fault, body.Fault)
			require.Equal(t, tc.status, response.Code)
			require.Empty(t, original.Code, "wire normalization must not mutate the caller")
		})
	}
}

func TestRefusalRecorderKeepsFirstVerdictWithinOneRequest(t *testing.T) {
	bare := context.Background()
	first := New(CodeNoCapacity, "pool full")
	RecordRefusal(bare, first)
	require.Nil(t, RecordedRefusal(bare))
	ctx := WithRefusalRecorder(bare)
	require.Nil(t, RecordedRefusal(ctx))
	RecordRefusal(ctx, nil)
	require.Nil(t, RecordedRefusal(ctx))
	RecordRefusal(ctx, first)
	child := context.WithValue(ctx, struct{}{}, "child")
	var concurrent sync.WaitGroup
	for range 32 {
		concurrent.Add(1)
		go func() {
			defer concurrent.Done()
			RecordRefusal(child, New(CodeGitHubUnavailable, "upstream failed"))
		}()
	}
	concurrent.Wait()
	require.Same(t, first, RecordedRefusal(ctx))
	require.Same(t, first, RecordedRefusal(child))
	other := WithRefusalRecorder(ctx)
	require.Nil(t, RecordedRefusal(other), "a new request gets its own recorder")
}
