package modelhost

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/stretchr/testify/require"
)

func TestOwnerModelProbeFailureResultsStayTyped(t *testing.T) {
	const body = `{"model":{"id":"writer","protocol":"openai-chat","modelId":"fixture","credential":"TEST_KEY"}}`
	for _, tc := range []struct {
		name     string
		result   json.RawMessage
		err      error
		status   int
		expected string
	}{
		{"invalid request", nil, ErrModelTestInvalid, 400, `{"code":"request_invalid"}`},
		{"dependency error", nil, errors.New("private secret must never escape"), 200, `{"ok":false,"latencyMs":0,"failure":{"code":"unreachable"},"fault":"dependency"}`},
		{"malformed result", json.RawMessage(`{`), nil, 200, `{"ok":false,"latencyMs":0,"failure":{"code":"unreachable"},"fault":"dependency"}`},
		{"oversize result", json.RawMessage(`"` + strings.Repeat("x", 65535) + `"`), nil, 200, `{"ok":false,"latencyMs":0,"failure":{"code":"unreachable"},"fault":"dependency"}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodPost, "/api/model/test", strings.NewReader(body))
			request = request.WithContext(middleware.ContextWithAuthInfo(request.Context(), &middleware.AuthInfo{User: &db.User{ID: 7}}))
			handler := OwnerModels{Tester: fixtureTester(func(context.Context, int64, json.RawMessage) (json.RawMessage, error) { return tc.result, tc.err })}
			recorder := httptest.NewRecorder()
			handler.Test(recorder, request)
			require.Equal(t, tc.status, recorder.Code)
			require.JSONEq(t, tc.expected, recorder.Body.String())
		})
	}
	request := httptest.NewRequest(http.MethodPost, "/api/model/test", strings.NewReader(body))
	request = request.WithContext(middleware.ContextWithAuthInfo(request.Context(), &middleware.AuthInfo{User: &db.User{ID: 7}}))
	recorder := httptest.NewRecorder()
	OwnerModels{}.Test(recorder, request)
	require.Equal(t, 503, recorder.Code)
	require.JSONEq(t, `{"code":"model_host_unavailable"}`, recorder.Body.String())
}
