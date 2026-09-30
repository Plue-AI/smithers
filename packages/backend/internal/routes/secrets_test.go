package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type mockSecretRouteService struct {
	setSecretFn    func(ctx context.Context, actor *db.User, owner, repo, name, value string) (services.SecretResponse, error)
	listSecretsFn  func(ctx context.Context, actor *db.User, owner, repo string) ([]services.SecretResponse, error)
	deleteSecretFn func(ctx context.Context, actor *db.User, owner, repo, name string) error
	mainOnly       *bool
	binding        *services.SecretBinding
	orgBinding     *services.SecretBinding
}

func (m *mockSecretRouteService) UpdateSecret(_ context.Context, _ *db.User, _, _, name string, mainOnly *bool, binding *services.SecretBinding) (services.SecretResponse, error) {
	m.mainOnly, m.binding = mainOnly, binding
	response := services.SecretResponse{Name: name}
	if mainOnly != nil {
		response.MainOnly = *mainOnly
	}
	if binding != nil {
		response.Hosts, response.MatchHeaders = binding.Hosts, binding.MatchHeaders
	}
	return response, nil
}

func (m *mockSecretRouteService) SetSecret(ctx context.Context, actor *db.User, owner, repo, name, value string, mainOnly *bool, binding *services.SecretBinding) (services.SecretResponse, error) {
	m.mainOnly = mainOnly
	m.binding = binding
	if m.setSecretFn != nil {
		return m.setSecretFn(ctx, actor, owner, repo, name, value)
	}
	return services.SecretResponse{}, nil
}

func (m *mockSecretRouteService) ListSecrets(ctx context.Context, actor *db.User, owner, repo string) ([]services.SecretResponse, error) {
	if m.listSecretsFn != nil {
		return m.listSecretsFn(ctx, actor, owner, repo)
	}
	return nil, nil
}

func (m *mockSecretRouteService) DeleteSecret(ctx context.Context, actor *db.User, owner, repo, name string) error {
	if m.deleteSecretFn != nil {
		return m.deleteSecretFn(ctx, actor, owner, repo, name)
	}
	return nil
}

func (m *mockSecretRouteService) SetOrgSecret(ctx context.Context, actor *db.User, orgName, name, value string, binding *services.SecretBinding) (services.SecretResponse, error) {
	m.orgBinding = binding
	return services.SecretResponse{Name: name}, nil
}

func (m *mockSecretRouteService) ListOrgSecrets(ctx context.Context, actor *db.User, orgName string) ([]services.SecretResponse, error) {
	return nil, nil
}

func (m *mockSecretRouteService) DeleteOrgSecret(ctx context.Context, actor *db.User, orgName, name string) error {
	return nil
}

func TestSecretHandler_ListSecrets(t *testing.T) {
	t.Parallel()

	h := &SecretHandler{Service: &mockSecretRouteService{
		listSecretsFn: func(ctx context.Context, actor *db.User, owner, repo string) ([]services.SecretResponse, error) {
			assert.Equal(t, "alice", owner)
			assert.Equal(t, "demo", repo)
			return []services.SecretResponse{
				{Name: "API_KEY", CreatedAt: "2025-01-01T00:00:00Z", UpdatedAt: "2025-01-01T00:00:00Z"},
			}, nil
		},
	}}

	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/secrets", nil)
	req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
	req = withAuth(req, 1, "alice")
	rec := httptest.NewRecorder()
	h.ListSecrets(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	var secrets []services.SecretResponse
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &secrets))
	assert.Len(t, secrets, 1)
	assert.Equal(t, "API_KEY", secrets[0].Name)
}

func TestSecretHandler_SetSecret_RequiresAuth(t *testing.T) {
	t.Parallel()

	h := &SecretHandler{Service: &mockSecretRouteService{}}
	req := httptest.NewRequest(http.MethodPut, "/api/repos/alice/demo/secrets", strings.NewReader(`{"name":"KEY","value":"val"}`))
	req.Header.Set("Content-Type", "application/json")
	req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
	rec := httptest.NewRecorder()
	h.SetSecret(rec, req)

	require.Equal(t, http.StatusUnauthorized, rec.Code)
}

func TestSecretHandler_SetSecret_Success(t *testing.T) {
	t.Parallel()

	h := &SecretHandler{Service: &mockSecretRouteService{
		setSecretFn: func(ctx context.Context, actor *db.User, owner, repo, name, value string) (services.SecretResponse, error) {
			assert.Equal(t, int64(1), actor.ID)
			assert.Equal(t, "MY_SECRET", name)
			assert.Equal(t, "secret-value", value)
			return services.SecretResponse{Name: "MY_SECRET", CreatedAt: "2025-01-01T00:00:00Z", UpdatedAt: "2025-01-01T00:00:00Z"}, nil
		},
	}}

	req := httptest.NewRequest(http.MethodPut, "/api/repos/alice/demo/secrets", strings.NewReader(`{"name":"MY_SECRET","value":"secret-value"}`))
	req.Header.Set("Content-Type", "application/json")
	req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
	req = withAuth(req, 1, "alice")
	rec := httptest.NewRecorder()
	h.SetSecret(rec, req)

	require.Equal(t, http.StatusCreated, rec.Code)
}

func TestSecretHandler_DeleteSecret_RequiresAuth(t *testing.T) {
	t.Parallel()

	h := &SecretHandler{Service: &mockSecretRouteService{}}
	req := httptest.NewRequest(http.MethodDelete, "/api/repos/alice/demo/secrets/KEY", nil)
	req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "name": "KEY"})
	rec := httptest.NewRecorder()
	h.DeleteSecret(rec, req)

	require.Equal(t, http.StatusUnauthorized, rec.Code)
}

func TestSecretHandler_DeleteSecret_Success(t *testing.T) {
	t.Parallel()

	h := &SecretHandler{Service: &mockSecretRouteService{
		deleteSecretFn: func(ctx context.Context, actor *db.User, owner, repo, name string) error {
			assert.Equal(t, "alice", owner)
			assert.Equal(t, "demo", repo)
			assert.Equal(t, "API_KEY", name)
			return nil
		},
	}}

	req := httptest.NewRequest(http.MethodDelete, "/api/repos/alice/demo/secrets/API_KEY", nil)
	req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "name": "API_KEY"})
	req = withAuth(req, 1, "alice")
	rec := httptest.NewRecorder()
	h.DeleteSecret(rec, req)

	require.Equal(t, http.StatusNoContent, rec.Code)
}

func TestSecretHandler_SetSecret_ServiceError(t *testing.T) {
	t.Parallel()

	h := &SecretHandler{Service: &mockSecretRouteService{
		setSecretFn: func(ctx context.Context, actor *db.User, owner, repo, name, value string) (services.SecretResponse, error) {
			return services.SecretResponse{}, pkgerrors.Forbidden("permission denied")
		},
	}}

	req := httptest.NewRequest(http.MethodPut, "/api/repos/alice/demo/secrets", strings.NewReader(`{"name":"KEY","value":"val"}`))
	req.Header.Set("Content-Type", "application/json")
	req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
	req = withAuth(req, 1, "alice")
	rec := httptest.NewRecorder()
	h.SetSecret(rec, req)

	require.Equal(t, http.StatusForbidden, rec.Code)
}

func TestSecretHandler_SetSecret_InvalidJSON(t *testing.T) {
	t.Parallel()

	h := &SecretHandler{Service: &mockSecretRouteService{}}
	req := httptest.NewRequest(http.MethodPut, "/api/repos/alice/demo/secrets", strings.NewReader("not-json"))
	req.Header.Set("Content-Type", "application/json")
	req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
	req = withAuth(req, 1, "alice")
	rec := httptest.NewRecorder()
	h.SetSecret(rec, req)

	require.Equal(t, http.StatusBadRequest, rec.Code)
}

// A secret is marked main-only on set, or by itself without its value.
func TestSecretHandler_MainOnlyScope(t *testing.T) {
	t.Parallel()
	service := &mockSecretRouteService{}
	h := &SecretHandler{Service: service}
	serve := func(method, body string, handler func(http.ResponseWriter, *http.Request)) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, "/api/repos/alice/demo/secrets/DEPLOY", strings.NewReader(body))
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "name": "DEPLOY"})
		req = withAuth(req, 1, "alice")
		rec := httptest.NewRecorder()
		handler(rec, req)
		return rec
	}
	rec := serve(http.MethodPost, `{"name":"DEPLOY","value":"v","main_only":true}`, h.SetSecret)
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	require.NotNil(t, service.mainOnly)
	assert.True(t, *service.mainOnly)
	rec = serve(http.MethodPost, `{"name":"DEPLOY","value":"v"}`, h.SetSecret)
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	assert.Nil(t, service.mainOnly, "an omitted scope keeps the stored one")

	rec = serve(http.MethodPatch, `{"main_only":true}`, h.SetSecretScope)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var got services.SecretResponse
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &got))
	assert.Equal(t, services.SecretResponse{Name: "DEPLOY", MainOnly: true}, got)
	rec = serve(http.MethodPatch, `{}`, h.SetSecretScope)
	assert.Equal(t, http.StatusBadRequest, rec.Code, rec.Body.String())
}

// #3175: a write names the hosts and headers a secret may be sent to; an
// omitted binding keeps the stored one, and a binding changes by itself
// without the value.
func TestSecretHandler_HostBinding(t *testing.T) {
	t.Parallel()
	service := &mockSecretRouteService{}
	h := &SecretHandler{Service: service}
	serve := func(method, body string, params map[string]string, handler func(http.ResponseWriter, *http.Request)) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, "/api/secrets", strings.NewReader(body))
		req = withRouteParams(req, params)
		req = withAuth(req, 1, "alice")
		rec := httptest.NewRecorder()
		handler(rec, req)
		return rec
	}
	repo := map[string]string{"owner": "alice", "repo": "demo", "name": "NPM_TOKEN"}
	rec := serve(http.MethodPost, `{"name":"NPM_TOKEN","value":"v","hosts":["registry.npmjs.org"],"match_headers":["authorization"]}`, repo, h.SetSecret)
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	require.NotNil(t, service.binding)
	assert.Equal(t, services.SecretBinding{Hosts: []string{"registry.npmjs.org"}, MatchHeaders: []string{"authorization"}}, *service.binding)
	rec = serve(http.MethodPost, `{"name":"NPM_TOKEN","value":"v"}`, repo, h.SetSecret)
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	assert.Nil(t, service.binding, "an omitted binding keeps the stored one")
	rec = serve(http.MethodPost, `{"name":"NPM_TOKEN","value":"v","hosts":[],"match_headers":[]}`, repo, h.SetSecret)
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	require.NotNil(t, service.binding)
	assert.Equal(t, services.SecretBinding{Hosts: []string{}, MatchHeaders: []string{}}, *service.binding, "two empty lists unbind")
	service.binding = nil
	for _, body := range []string{
		`{"name":"NPM_TOKEN","value":"v","hosts":[]}`,
		`{"name":"NPM_TOKEN","value":"v","hosts":[],"match_headers":null}`,
		`{"name":"NPM_TOKEN","value":"v","match_headers":["authorization"]}`,
	} {
		rec = serve(http.MethodPost, body, repo, h.SetSecret)
		assert.Equal(t, http.StatusBadRequest, rec.Code, body)
		rec = serve(http.MethodPatch, body, repo, h.SetSecretScope)
		assert.Equal(t, http.StatusBadRequest, rec.Code, body)
		rec = serve(http.MethodPost, body, map[string]string{"org": "acme"}, h.SetOrgSecret)
		assert.Equal(t, http.StatusBadRequest, rec.Code, body)
	}
	assert.Nil(t, service.binding, "a half-written binding reaches no service")

	service.binding = nil
	rec = serve(http.MethodPatch, `{"hosts":["api.example.com"],"match_headers":["x-api-key"]}`, repo, h.SetSecretScope)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var got services.SecretResponse
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &got))
	assert.Equal(t, services.SecretResponse{Name: "NPM_TOKEN", Hosts: []string{"api.example.com"}, MatchHeaders: []string{"x-api-key"}}, got)
	rec = serve(http.MethodPatch, `{"hosts":["api.example.com"],"match_headers":["x-api-key"],"main_only":true}`, repo, h.SetSecretScope)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &got))
	assert.True(t, got.MainOnly, "one request changes the scope and the binding, in one service write")
	require.NotNil(t, service.mainOnly)
	require.NotNil(t, service.binding)

	org := map[string]string{"org": "acme"}
	rec = serve(http.MethodPost, `{"name":"ORG_KEY","value":"v","hosts":["deploy.example.com"],"match_headers":["authorization"]}`, org, h.SetOrgSecret)
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	require.NotNil(t, service.orgBinding)
	assert.Equal(t, []string{"deploy.example.com"}, service.orgBinding.Hosts)
	rec = serve(http.MethodPost, `{"name":"ORG_KEY","value":"v"}`, org, h.SetOrgSecret)
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	assert.Nil(t, service.orgBinding)
}
