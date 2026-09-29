package routes

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type agentEnvironmentRouteMock struct {
	response services.AgentEnvironmentResponse
}

func (m agentEnvironmentRouteMock) GetAgentEnvironment(context.Context, *db.User, string, string) (services.AgentEnvironmentResponse, error) {
	return m.response, nil
}
func (m agentEnvironmentRouteMock) PutAgentEnvironment(context.Context, *db.User, string, string, services.PutAgentEnvironmentInput) (services.AgentEnvironmentResponse, error) {
	return m.response, nil
}
func (m agentEnvironmentRouteMock) PutAgentEnvironmentSecret(_ context.Context, _ *db.User, _, _ string, input services.AgentEnvironmentSecretWrite) (services.AgentEnvironmentSecretMetadata, error) {
	return services.AgentEnvironmentSecretMetadata{
		Name: input.Name, Hosts: input.Hosts, MatchHeaders: input.MatchHeaders,
		UpdatedAt: time.Date(2026, 7, 15, 12, 0, 0, 0, time.UTC),
	}, nil
}
func (m agentEnvironmentRouteMock) DeleteAgentEnvironmentSecret(context.Context, *db.User, string, string, string) error {
	return nil
}

func agentEnvironmentRouteRequest(method, target, body string) *http.Request {
	req := httptest.NewRequest(method, target, strings.NewReader(body))
	routeCtx := chi.NewRouteContext()
	routeCtx.URLParams.Add("owner", "alice")
	routeCtx.URLParams.Add("repo", "demo")
	routeCtx.URLParams.Add("name", "SETUP_TOKEN")
	ctx := context.WithValue(req.Context(), chi.RouteCtxKey, routeCtx)
	ctx = context.WithValue(ctx, middleware.UserContextKey, &db.User{ID: 7})
	return req.WithContext(ctx)
}

func TestAgentEnvironmentHandler_SecretValuesAreWriteOnly(t *testing.T) {
	t.Parallel()
	secretValue := "setup-only-value"
	handler := &SecretHandler{AgentEnvironment: agentEnvironmentRouteMock{response: services.AgentEnvironmentResponse{
		SetupScript: "npm install",
		Env:         []services.AgentEnvironmentVariable{{Name: "NODE_ENV", Value: "development"}},
		Secrets: []services.AgentEnvironmentSecretMetadata{{
			Name:      "SETUP_TOKEN",
			UpdatedAt: time.Date(2026, 7, 15, 12, 0, 0, 0, time.UTC),
		}},
	}}}

	getRecorder := httptest.NewRecorder()
	handler.GetAgentEnvironment(getRecorder, agentEnvironmentRouteRequest(http.MethodGet, "/api/repos/alice/demo/agent-environment", ""))
	require.Equal(t, http.StatusOK, getRecorder.Code)
	assert.NotContains(t, getRecorder.Body.String(), secretValue)
	var body map[string]any
	require.NoError(t, json.Unmarshal(getRecorder.Body.Bytes(), &body))
	secrets := body["secrets"].([]any)
	secret := secrets[0].(map[string]any)
	assert.Equal(t, "SETUP_TOKEN", secret["name"])
	_, hasValue := secret["value"]
	assert.False(t, hasValue)

	putRecorder := httptest.NewRecorder()
	handler.PutAgentEnvironmentSecret(putRecorder, agentEnvironmentRouteRequest(
		http.MethodPut,
		"/api/repos/alice/demo/agent-environment/secrets/SETUP_TOKEN",
		`{"value":"`+secretValue+`"}`,
	))
	require.Equal(t, http.StatusCreated, putRecorder.Code)
	assert.NotContains(t, putRecorder.Body.String(), secretValue)
}

func TestAgentEnvironmentHandler_CombinedBodyBoundary(t *testing.T) {
	const target = "/api/repos/alice/demo/agent-environment"
	limit := int(middleware.MaxAgentEnvironmentBodySize)
	// A large combined document passes the public PUT, including escaped JSON.
	input := services.PutAgentEnvironmentInput{SetupScript: strings.Repeat("\x01", 1024*1024)}
	for i := range 100 {
		input.Env = append(input.Env, services.AgentEnvironmentVariable{Name: fmt.Sprintf("ENV_%d", i), Value: strings.Repeat("x", 64*1024)})
	}
	for i := range 30 {
		input.Secrets = append(input.Secrets, services.AgentEnvironmentSecretWrite{Name: fmt.Sprintf("SECRET_%d", i), Value: strings.Repeat("x", 64*1024)})
	}
	encoded, err := json.Marshal(input)
	require.NoError(t, err)
	require.Greater(t, len(encoded), 8<<20)
	handler := middleware.MaxBodySizeForRequest(func(*http.Request) int64 { return middleware.MaxAgentEnvironmentBodySize })(http.HandlerFunc((&SecretHandler{AgentEnvironment: agentEnvironmentRouteMock{}}).PutAgentEnvironment))
	request := agentEnvironmentRouteRequest(http.MethodPut, target, string(encoded))
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	require.Equal(t, http.StatusOK, response.Code)

	// The wire limit is inclusive; legal trailing whitespace reaches it exactly.
	base := `{"setup_script":"","env":[],"secrets":[]}`
	exact := base + strings.Repeat(" ", limit-len(base))
	for _, tc := range []struct {
		name, body string
		want       int
	}{
		{"exact", exact, http.StatusOK},
		{"over", exact + " ", http.StatusRequestEntityTooLarge},
		{"trailing document", base + ` {}`, http.StatusBadRequest},
	} {
		t.Run(tc.name, func(t *testing.T) {
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, agentEnvironmentRouteRequest(http.MethodPut, target, tc.body))
			require.Equal(t, tc.want, response.Code)
		})
	}
}
