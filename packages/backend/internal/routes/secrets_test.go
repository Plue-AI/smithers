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
}

func (m *mockSecretRouteService) SetSecretMainOnly(_ context.Context, _ *db.User, _, _, name string, mainOnly bool) (services.SecretResponse, error) {
	return services.SecretResponse{Name: name, MainOnly: mainOnly}, nil
}

func (m *mockSecretRouteService) SetSecret(ctx context.Context, actor *db.User, owner, repo, name, value string, mainOnly *bool) (services.SecretResponse, error) {
	m.mainOnly = mainOnly
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

func (m *mockSecretRouteService) SetOrgSecret(ctx context.Context, actor *db.User, orgName, name, value string) (services.SecretResponse, error) {
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
