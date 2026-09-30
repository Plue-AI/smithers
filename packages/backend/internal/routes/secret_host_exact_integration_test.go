//go:build integration
// +build integration

package routes

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
)

// #3212: a secret bound to a wildcard or address range would be swapped into
// requests to every host the pattern covers. Every secret-binding route
// refuses one with the same typed body: validation_failed on the hosts field,
// naming the host, and stores nothing.
func TestSecretBindingRoutesRefuseWildcardAndCIDRHosts(t *testing.T) {
	pool := setupRoutesIntegrationPool(t)
	queries := db.New(pool)
	owner := routesIntegrationCreateUser(t, pool, "exacthost")
	repo := routesIntegrationCreateRepo(t, pool, owner, "exacthost", false)
	codec, err := webhook.NewSecretCodec("exact-host-route-test-key")
	require.NoError(t, err)
	handler := &SecretHandler{Service: services.NewSecretService(queries, codec), AgentEnvironment: services.NewAgentEnvironmentService(queries, codec)}

	r := chi.NewRouter()
	r.Use(middleware.AuthLoader(queries, config.AuthConfig{}))
	r.Route("/api/repos/{owner}/{repo}", func(r chi.Router) {
		r.Use(middleware.RequireAuth)
		r.Post("/secrets", handler.SetSecret)
		r.Patch("/secrets/{name}", handler.SetSecretScope)
		r.Put("/agent-environment", handler.PutAgentEnvironment)
		r.Put("/agent-environment/secrets/{name}", handler.PutAgentEnvironmentSecret)
	})
	server := httptest.NewServer(r)
	t.Cleanup(server.Close)
	client := routesIntegrationAuthenticatedClient(t, server, routesIntegrationCreateSessionCookie(t, queries, owner))
	base := fmt.Sprintf("/api/repos/%s/%s", repo.Owner, repo.Name)

	resp := routesIntegrationDoRequest(t, client, server.URL, http.MethodPost, base+"/secrets",
		[]byte(`{"name":"DEPLOY_KEY","value":"deploy-value","hosts":["api.example.com"],"match_headers":["authorization"]}`))
	require.Equal(t, http.StatusCreated, resp.StatusCode, string(routesIntegrationReadBody(t, resp)))

	for _, host := range []string{"*.ngrok-free.app", "127.0.0.0/8", "10.0.0.1/32"} {
		hosts, err := json.Marshal([]string{"api.example.com", host})
		require.NoError(t, err)
		for _, call := range []struct{ method, path, body string }{
			{http.MethodPost, base + "/secrets", `{"name":"BROAD","value":"broad-value","hosts":` + string(hosts) + `,"match_headers":["authorization"]}`},
			{http.MethodPatch, base + "/secrets/DEPLOY_KEY", `{"hosts":` + string(hosts) + `,"match_headers":["authorization"]}`},
			{http.MethodPut, base + "/agent-environment/secrets/BROAD", `{"value":"broad-value","hosts":` + string(hosts) + `,"match_headers":["authorization"]}`},
			{http.MethodPut, base + "/agent-environment", `{"setup_script":"","env":[],"secrets":[{"name":"BROAD","value":"broad-value","hosts":` + string(hosts) + `,"match_headers":["authorization"]}]}`},
		} {
			resp := routesIntegrationDoRequest(t, client, server.URL, call.method, call.path, []byte(call.body))
			body := routesIntegrationReadBody(t, resp)
			require.Equal(t, http.StatusUnprocessableEntity, resp.StatusCode, "%s %s: %s", call.method, call.path, body)
			var refusal struct {
				Code    string `json:"code"`
				Fault   string `json:"fault"`
				Message string `json:"message"`
				Errors  []struct {
					Resource string `json:"resource"`
					Field    string `json:"field"`
					Code     string `json:"code"`
				} `json:"errors"`
			}
			require.NoError(t, json.Unmarshal(body, &refusal), string(body))
			assert.Equal(t, "validation_failed", refusal.Code, call.path)
			assert.Equal(t, "user", refusal.Fault, call.path)
			assert.Contains(t, refusal.Message, host, call.path)
			require.Len(t, refusal.Errors, 1, call.path)
			assert.Equal(t, "Secret", refusal.Errors[0].Resource)
			assert.Equal(t, "hosts", refusal.Errors[0].Field)
			assert.Equal(t, "invalid", refusal.Errors[0].Code)
			assert.NotContains(t, string(body), "broad-value")
		}
	}

	var stored int
	require.NoError(t, pool.QueryRow(t.Context(), `SELECT
		(SELECT count(*) FROM repository_secrets WHERE repository_id = $1 AND (name = 'BROAD' OR cardinality(hosts) <> 1))
		+ (SELECT count(*) FROM repository_agent_environment_secrets WHERE repository_id = $1)`, repo.ID).Scan(&stored))
	assert.Zero(t, stored, "a refused binding stores nothing and leaves the exact binding in place")
}
