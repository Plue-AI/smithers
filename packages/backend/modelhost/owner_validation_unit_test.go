package modelhost

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/stretchr/testify/require"
)

// A nil pool is deliberate: validation must return before touching storage.
func TestOwnerModelHandlersRequireAuthenticationBeforeStorage(t *testing.T) {
	handlers := OwnerModels{}
	for name, handler := range map[string]http.HandlerFunc{"catalog": handlers.Catalog, "credential": handlers.Credential, "receipt": handlers.CredentialReceipt, "default": handlers.Default, "set-default": handlers.SetDefault, "test": handlers.Test} {
		t.Run(name, func(t *testing.T) {
			for _, id := range []int64{0, -1} {
				request := httptest.NewRequest(http.MethodPost, "/api/model", strings.NewReader(`{`))
				if id < 0 {
					request = request.WithContext(middleware.ContextWithAuthInfo(request.Context(), &middleware.AuthInfo{User: &db.User{ID: id}}))
				}
				response := httptest.NewRecorder()
				handler(response, request)
				require.Equal(t, http.StatusUnauthorized, response.Code)
				require.JSONEq(t, `{"code":"sign_in_required"}`, response.Body.String())
				require.Equal(t, "no-store", response.Header().Get("Cache-Control"))
			}
		})
	}
}

func TestOwnerCredentialValidationBeforeStorage(t *testing.T) {
	base := map[string]string{"action": "enroll", "requestId": "request-123", "name": "OPENAI_API_KEY", "origin": "https://api.openai.com", "value": "api-key"}
	cases := []struct{ name, field, value, want string }{
		{"short request", "requestId", "seven77", "requestId"}, {"long request", "requestId", strings.Repeat("a", 65), "requestId"},
		{"request punctuation", "requestId", "request_123", "requestId"}, {"short name", "name", "A", "name"},
		{"long name", "name", strings.Repeat("A", 64), "name"}, {"lowercase name", "name", "openai", "name"},
		{"reserved name", "name", "CUSTOM_ORIGIN", "name"}, {"empty action", "action", "", "action"}, {"unknown action", "action", "save", "action"},
		{"blank value", "value", " \t", "value"}, {"oversize value", "value", strings.Repeat("x", 8193), "value"},
		{"newline value", "value", "key\nsecret", "value"}, {"return value", "value", "key\rsecret", "value"}, {"nul value", "value", "key\x00secret", "value"},
		{"subscription value", "value", "sk-ant-oat01-private", "value"}, {"wrong builtin origin", "origin", "https://evil.example", "origin"},
		{"path origin", "origin", "https://api.openai.com/", "origin"}, {"userinfo origin", "origin", "https://user@api.openai.com", "origin"},
		{"query origin", "origin", "https://api.openai.com?x=1", "origin"}, {"fragment origin", "origin", "https://api.openai.com#x", "origin"},
		{"malformed origin", "origin", "http://[", "origin"}, {"external http", "origin", "http://example.com", "origin"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			input := map[string]string{}
			for k, v := range base {
				input[k] = v
			}
			input[tc.field] = tc.value
			body, err := json.Marshal(input)
			require.NoError(t, err)
			request := httptest.NewRequest(http.MethodPost, "/api/model", strings.NewReader(string(body)))
			request = request.WithContext(middleware.ContextWithAuthInfo(context.Background(), &middleware.AuthInfo{User: &db.User{ID: 7}}))
			response := httptest.NewRecorder()
			OwnerModels{}.Credential(response, request)
			require.Equal(t, http.StatusOK, response.Code)
			require.JSONEq(t, `{"ok":false,"failure":{"code":"invalid","field":"`+tc.want+`"},"fault":"user"}`, response.Body.String())
			require.NotContains(t, response.Body.String(), "private")
		})
	}
	for _, body := range []string{`{`, `{"unknown":true}`, `{}` + `{}`, `null false`} {
		request := httptest.NewRequest(http.MethodPost, "/api/model", strings.NewReader(body))
		request = request.WithContext(middleware.ContextWithAuthInfo(request.Context(), &middleware.AuthInfo{User: &db.User{ID: 7}}))
		response := httptest.NewRecorder()
		OwnerModels{}.Credential(response, request)
		require.JSONEq(t, `{"ok":false,"failure":{"code":"invalid","field":"action"},"fault":"user"}`, response.Body.String())
	}
}

func TestOwnerCredentialRejectsNonlocalHTTPBeforeStorage(t *testing.T) {
	for _, origin := range []string{"http://127.evil.example:8123", "http://127.0.0.1.evil.example:8123", "http://127.999.0.1:8123"} {
		t.Run(origin, func(t *testing.T) {
			body, err := json.Marshal(credentialRequest{Action: "enroll", RequestID: "request-123", Name: "CUSTOM_KEY", Origin: origin, Value: "private-api-key"})
			require.NoError(t, err)
			request := httptest.NewRequest(http.MethodPost, "/api/model", strings.NewReader(string(body)))
			request = request.WithContext(middleware.ContextWithAuthInfo(request.Context(), &middleware.AuthInfo{User: &db.User{ID: 7}}))
			response := httptest.NewRecorder()
			// A nil pool proves the origin is rejected before persisting the key.
			OwnerModels{}.Credential(response, request)
			require.Equal(t, http.StatusOK, response.Code)
			require.JSONEq(t, `{"ok":false,"failure":{"code":"invalid","field":"origin"},"fault":"user"}`, response.Body.String())
			require.NotContains(t, response.Body.String(), "private-api-key")
		})
	}
}

func TestOwnerResolverRejectsConfigurationBeforeDatabase(t *testing.T) {
	for _, providers := range []struct{ url, key func() string }{{nil, func() string { return "key" }}, {func() string { return "url" }, nil}, {nil, nil}} {
		resolver, err := NewOwnerSecretResolver(providers.url, providers.key)
		require.Nil(t, resolver)
		require.Error(t, err)
	}
	resolver, err := NewOwnerSecretResolver(func() string { return "" }, func() string { t.Fatal("secret key read before availability validation"); return "" })
	require.NoError(t, err)
	defer resolver.Close()
	for _, tc := range []struct {
		owner   int64
		request string
		message string
	}{{7, `{`, "model turn request is invalid"}, {0, `{}`, "owner model store is unavailable"}, {-1, `{}`, "owner model store is unavailable"}, {7, `{}`, "owner model store is unavailable"}} {
		binding, err := resolver.ResolveChatModel(context.Background(), tc.owner, 0, json.RawMessage(tc.request))
		require.Equal(t, Binding{}, binding)
		require.EqualError(t, err, tc.message)
	}
	resolver.Close() // Repeated close before any connection is harmless.
}
