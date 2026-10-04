package routes

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/require"
)

func TestTodoControlDarkBoundary(t *testing.T) {
	// Supplemental HTTP coverage only. Production install dispatch/authorization
	// and machine-backed joint acceptance remain disabled, not mocked here.
	handler := &MythicalHandler{}
	router := chi.NewRouter()
	router.Post("/api/todos/{n}", handler.TodoControl)
	for _, op := range []string{"stop", "resume", "retry", "retry-current-flow", "drop"} {
		t.Run(op, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodPost, "/api/todos/12", strings.NewReader(`{"op":"`+op+`"}`))
			request.Header.Set("Idempotency-Key", "literal-key")
			response := httptest.NewRecorder()
			router.ServeHTTP(response, request)
			require.Equal(t, http.StatusServiceUnavailable, response.Code)
			require.JSONEq(t, `{"code":"todo_control_unavailable","class":"infra","message":"TODO controls are unavailable"}`, response.Body.String())
		})
	}
	for _, tc := range []struct{ path, body, key, code string }{
		{"0", `{"op":"stop"}`, "key", "invalid_todo"},
		{"9223372036854775808", `{"op":"stop"}`, "key", "invalid_todo"},
		{"12", `{`, "key", "invalid_control"},
		{"12", `{"op":"stop","unexpected":true}`, "key", "invalid_control"},
		{"12", `{"op":"stop"} {}`, "key", "invalid_control"},
		{"12", `{"op":"stop"}`, "", "idempotency_key_required"},
		{"12", `{"op":"cancel"}`, "key", "invalid_control"},
		{"12", `{"op":"drop","steer":"no"}`, "key", "invalid_control"},
		{"12", strings.Repeat(" ", 64<<10) + `{}`, "key", "invalid_control"},
	} {
		request := httptest.NewRequest(http.MethodPost, "/api/todos/"+tc.path, strings.NewReader(tc.body))
		request.Header.Set("Idempotency-Key", tc.key)
		response := httptest.NewRecorder()
		router.ServeHTTP(response, request)
		require.Equal(t, http.StatusBadRequest, response.Code, tc.body[:min(len(tc.body), 100)])
		require.Contains(t, response.Body.String(), `"code":"`+tc.code+`"`)
	}
}

func TestTodoSteerUnavailableProviders(t *testing.T) {
	// Supplemental dark handler tests, not a served-install/guest-host receipt.
	// A nil handler service makes any subject read or effect panic.
	handler := &MythicalHandler{}
	router := chi.NewRouter()
	router.Post("/api/todos/{n}", handler.TodoControl)
	router.Patch("/api/todos/{n}", handler.TodoAmend)
	for _, tc := range []struct{ method, body string }{
		{http.MethodPost, `{"steer":"Keep the max at 5"}`},
		{http.MethodPatch, `{"prompt":"Also log each retry.","acceptance":"Retries are logged."}`},
	} {
		for _, key := range []string{"literal-key", "literal-key", "another-key"} {
			request := httptest.NewRequest(tc.method, "/api/todos/12", strings.NewReader(tc.body))
			request.Header.Set("Idempotency-Key", key)
			response := httptest.NewRecorder()
			router.ServeHTTP(response, request)
			require.Equal(t, http.StatusServiceUnavailable, response.Code)
			require.JSONEq(t, `{"code":"todo_control_unavailable","class":"infra","message":"TODO controls are unavailable"}`, response.Body.String())
		}
	}
	for _, tc := range []struct{ method, body, code string }{
		{http.MethodPost, `{}`, "invalid_steer"},
		{http.MethodPost, `{"steer":" "}`, "invalid_steer"},
		{http.MethodPost, `{"steer":"x","via":"smithers"}`, "invalid_control"},
		{http.MethodPost, `{"steer":"x","actor":"Ben"}`, "invalid_control"},
		{http.MethodPatch, `{}`, "invalid_amendment"},
		{http.MethodPatch, `{"prompt":" "}`, "invalid_amendment"},
		{http.MethodPatch, `{"prompt":"x","revision":2}`, "invalid_control"},
		{http.MethodPatch, `{"prompt":"x","via":"smithers"}`, "invalid_control"},
		{http.MethodPatch, `{"prompt":"x"} {}`, "invalid_control"},
	} {
		request := httptest.NewRequest(tc.method, "/api/todos/12", strings.NewReader(tc.body))
		request.Header.Set("Idempotency-Key", "key")
		response := httptest.NewRecorder()
		router.ServeHTTP(response, request)
		require.Equal(t, http.StatusBadRequest, response.Code)
		require.Contains(t, response.Body.String(), `"code":"`+tc.code+`"`)
	}
}
