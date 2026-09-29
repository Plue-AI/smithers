package routes

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type stubProviderConnectionService struct {
	connected services.ConnectProviderInput
	revoked   string
	listErr   error
	order     []string
	polled    string
}

func (s *stubProviderConnectionService) Reorder(_ context.Context, _ *db.User, provider string, ids []string) error {
	s.order = append([]string{provider}, ids...)
	return nil
}
func (s *stubProviderConnectionService) StartCodexDeviceLogin(context.Context, *db.User) (services.ProviderDeviceLoginResponse, error) {
	return services.ProviderDeviceLoginResponse{ID: "login-1", Provider: "codex", State: "pending", UserCode: "ABCD-1234", VerificationURI: "https://auth.openai.com/codex/device", IntervalSeconds: 5}, nil
}
func (s *stubProviderConnectionService) PollCodexDeviceLogin(_ context.Context, _ *db.User, id string) (services.ProviderDeviceLoginResponse, error) {
	s.polled = id
	return services.ProviderDeviceLoginResponse{ID: id, Provider: "codex", State: "connected"}, nil
}

func (s *stubProviderConnectionService) ConnectForUser(_ context.Context, actor *db.User, in services.ConnectProviderInput) (services.ProviderConnectionResponse, error) {
	s.connected = in
	return services.ProviderConnectionResponse{ID: "conn-1", OwnerType: "user", Provider: in.Provider, Kind: "api_key", State: "active", Grants: []services.ProviderConnectionGrantResponse{}}, nil
}
func (s *stubProviderConnectionService) ConnectForOrg(context.Context, *db.User, string, services.ConnectProviderInput) (services.ProviderConnectionResponse, error) {
	return services.ProviderConnectionResponse{ID: "conn-org"}, nil
}
func (s *stubProviderConnectionService) ListForUser(context.Context, *db.User) ([]services.ProviderConnectionResponse, error) {
	if s.listErr != nil {
		return nil, s.listErr
	}
	return []services.ProviderConnectionResponse{{ID: "conn-1", Provider: "claude", State: "active", Grants: []services.ProviderConnectionGrantResponse{}}}, nil
}
func (s *stubProviderConnectionService) ListForOrg(context.Context, *db.User, string) ([]services.ProviderConnectionResponse, error) {
	return nil, errors.Forbidden("not a member of this organization")
}
func (s *stubProviderConnectionService) Get(context.Context, *db.User, string) (services.ProviderConnectionResponse, error) {
	return services.ProviderConnectionResponse{}, errors.NotFound("provider connection not found")
}
func (s *stubProviderConnectionService) Revoke(_ context.Context, _ *db.User, id string) error {
	s.revoked = id
	return nil
}
func (s *stubProviderConnectionService) RefreshNow(context.Context, *db.User, string) (services.ProviderConnectionResponse, error) {
	return services.ProviderConnectionResponse{}, errors.BadRequest("this connection has no refresh token; setup tokens are not refreshed")
}
func (s *stubProviderConnectionService) AddGrant(context.Context, *db.User, string, services.ProviderConnectionGrantInput) (services.ProviderConnectionGrantResponse, error) {
	return services.ProviderConnectionGrantResponse{ID: 1, AllRepositories: true}, nil
}
func (s *stubProviderConnectionService) DeleteGrant(context.Context, *db.User, string, int64) error {
	return errors.NotFound("grant not found")
}

func providerConnectionTestRouter(h *ProviderConnectionHandler, user *db.User) http.Handler {
	r := chi.NewRouter()
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			if user != nil {
				req = req.WithContext(context.WithValue(req.Context(), middleware.UserContextKey, user))
			}
			next.ServeHTTP(w, req)
		})
	})
	r.Get("/api/user/provider-connections", h.ListUserConnections)
	r.Post("/api/user/provider-connections", h.ConnectUser)
	r.Put("/api/user/provider-connections/order", h.ReorderConnections)
	r.Post("/api/user/provider-connections/codex/device", h.StartCodexDeviceLogin)
	r.Post("/api/user/provider-connections/codex/device/{id}", h.PollCodexDeviceLogin)
	r.Get("/api/user/provider-connections/{id}", h.GetConnection)
	r.Delete("/api/user/provider-connections/{id}", h.RevokeConnection)
	r.Post("/api/user/provider-connections/{id}/refresh", h.RefreshConnection)
	r.Post("/api/user/provider-connections/{id}/grants", h.AddGrant)
	r.Delete("/api/user/provider-connections/{id}/grants/{grantID}", h.DeleteGrant)
	r.Get("/api/orgs/{org}/provider-connections", h.ListOrgConnections)
	return r
}

func TestProviderConnectionRoutes(t *testing.T) {
	stub := &stubProviderConnectionService{}
	user := &db.User{ID: 7, Username: "will"}
	router := providerConnectionTestRouter(&ProviderConnectionHandler{Service: stub}, user)

	do := func(method, path, body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, path, bytes.NewBufferString(body))
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		return rec
	}

	rec := do(http.MethodPost, "/api/user/provider-connections", `{"provider":"claude","access_token":"sk-ant-api03-x"}`)
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	assert.Equal(t, "claude", stub.connected.Provider)
	assert.Contains(t, rec.Body.String(), `"id":"conn-1"`)
	assert.NotContains(t, rec.Body.String(), "sk-ant-api03-x", "a response never echoes a token")

	rec = do(http.MethodGet, "/api/user/provider-connections", "")
	require.Equal(t, http.StatusOK, rec.Code)
	assert.Contains(t, rec.Body.String(), `"provider":"claude"`)

	rec = do(http.MethodDelete, "/api/user/provider-connections/conn-1", "")
	require.Equal(t, http.StatusNoContent, rec.Code)
	assert.Equal(t, "conn-1", stub.revoked)

	rec = do(http.MethodPost, "/api/user/provider-connections/conn-1/refresh", "")
	assert.Equal(t, http.StatusBadRequest, rec.Code)

	rec = do(http.MethodGet, "/api/user/provider-connections/missing", "")
	assert.Equal(t, http.StatusNotFound, rec.Code)

	rec = do(http.MethodPost, "/api/user/provider-connections/conn-1/grants", `{"all_repositories":true}`)
	assert.Equal(t, http.StatusCreated, rec.Code)

	rec = do(http.MethodDelete, "/api/user/provider-connections/conn-1/grants/abc", "")
	assert.Equal(t, http.StatusBadRequest, rec.Code)

	rec = do(http.MethodGet, "/api/orgs/acme/provider-connections", "")
	assert.Equal(t, http.StatusForbidden, rec.Code)

	rec = do(http.MethodPut, "/api/user/provider-connections/order", `{"provider":"claude","ids":["b","a"]}`)
	assert.Equal(t, http.StatusNoContent, rec.Code)
	assert.Equal(t, []string{"claude", "b", "a"}, stub.order)

	rec = do(http.MethodPost, "/api/user/provider-connections/codex/device", "")
	require.Equal(t, http.StatusCreated, rec.Code)
	assert.Contains(t, rec.Body.String(), `"user_code":"ABCD-1234"`)
	rec = do(http.MethodPost, "/api/user/provider-connections/codex/device/login-1", "")
	require.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, "login-1", stub.polled)

	rec = do(http.MethodPost, "/api/user/provider-connections", `{bad json`)
	assert.Equal(t, http.StatusBadRequest, rec.Code)

	// Unauthenticated requests are refused before the service is reached.
	anon := providerConnectionTestRouter(&ProviderConnectionHandler{Service: stub}, nil)
	req := httptest.NewRequest(http.MethodGet, "/api/user/provider-connections", nil)
	rec = httptest.NewRecorder()
	anon.ServeHTTP(rec, req)
	assert.Equal(t, http.StatusUnauthorized, rec.Code)
}
