package routes

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/require"
)

// TODO controls (POST /api/todos/{n}) are TodoHandler.Control, authorized by
// role in TestTodoRoutesAuthorizeByRole. Amend stays dark.
func TestTodoAmendUnavailableProviders(t *testing.T) {
	// Supplemental dark handler tests, not a served-install/guest-host receipt.
	// A nil handler service makes any subject read or effect panic.
	handler := &MythicalHandler{}
	router := chi.NewRouter()
	router.Patch("/api/todos/{n}", handler.TodoAmend)
	for _, key := range []string{"literal-key", "literal-key", "another-key"} {
		request := httptest.NewRequest(http.MethodPatch, "/api/todos/12", strings.NewReader(`{"prompt":"Also log each retry.","acceptance":"Retries are logged."}`))
		request.Header.Set("Idempotency-Key", key)
		response := httptest.NewRecorder()
		router.ServeHTTP(response, request)
		require.Equal(t, http.StatusServiceUnavailable, response.Code)
		require.JSONEq(t, `{"code":"todo_control_unavailable","class":"infra","message":"TODO controls are unavailable"}`, response.Body.String())
	}
	for _, tc := range []struct{ path, body, key, code string }{
		{"12", `{}`, "key", "invalid_amendment"},
		{"12", `{"prompt":" "}`, "key", "invalid_amendment"},
		{"12", `{"prompt":"x","revision":2}`, "key", "invalid_control"},
		{"12", `{"prompt":"x","via":"smithers"}`, "key", "invalid_control"},
		{"12", `{"prompt":"x"} {}`, "key", "invalid_control"},
		{"12", `{`, "key", "invalid_control"},
		{"12", `{"prompt":"x"}`, "", "idempotency_key_required"},
		{"0", `{"prompt":"x"}`, "key", "invalid_todo"},
		{"9223372036854775808", `{"prompt":"x"}`, "key", "invalid_todo"},
		{"12", strings.Repeat(" ", 64<<10) + `{}`, "key", "invalid_control"},
	} {
		request := httptest.NewRequest(http.MethodPatch, "/api/todos/"+tc.path, strings.NewReader(tc.body))
		request.Header.Set("Idempotency-Key", tc.key)
		response := httptest.NewRecorder()
		router.ServeHTTP(response, request)
		require.Equal(t, http.StatusBadRequest, response.Code, tc.body[:min(len(tc.body), 100)])
		require.Contains(t, response.Body.String(), `"code":"`+tc.code+`"`)
	}
}
