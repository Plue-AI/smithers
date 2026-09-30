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

type secretsCovService struct {
	setSecretFn       func(context.Context, *db.User, string, string, string, string) (services.SecretResponse, error)
	listSecretsFn     func(context.Context, *db.User, string, string) ([]services.SecretResponse, error)
	deleteSecretFn    func(context.Context, *db.User, string, string, string) error
	setOrgSecretFn    func(context.Context, *db.User, string, string, string) (services.SecretResponse, error)
	listOrgSecretsFn  func(context.Context, *db.User, string) ([]services.SecretResponse, error)
	deleteOrgSecretFn func(context.Context, *db.User, string, string) error
}

func (s secretsCovService) SetSecretBinding(_ context.Context, _ *db.User, _, _, name string, binding services.SecretBinding) (services.SecretResponse, error) {
	return services.SecretResponse{Name: name, Hosts: binding.Hosts, MatchHeaders: binding.MatchHeaders}, nil
}

func (s secretsCovService) SetSecretMainOnly(_ context.Context, _ *db.User, _, _, name string, mainOnly bool) (services.SecretResponse, error) {
	return services.SecretResponse{Name: name, MainOnly: mainOnly}, nil
}

func (s secretsCovService) SetSecret(ctx context.Context, actor *db.User, owner, repo, name, value string, _ *bool, _ *services.SecretBinding) (services.SecretResponse, error) {
	if s.setSecretFn != nil {
		return s.setSecretFn(ctx, actor, owner, repo, name, value)
	}
	return services.SecretResponse{Name: name}, nil
}

func (s secretsCovService) ListSecrets(ctx context.Context, actor *db.User, owner, repo string) ([]services.SecretResponse, error) {
	if s.listSecretsFn != nil {
		return s.listSecretsFn(ctx, actor, owner, repo)
	}
	return []services.SecretResponse{}, nil
}

func (s secretsCovService) DeleteSecret(ctx context.Context, actor *db.User, owner, repo, name string) error {
	if s.deleteSecretFn != nil {
		return s.deleteSecretFn(ctx, actor, owner, repo, name)
	}
	return nil
}

func (s secretsCovService) SetOrgSecret(ctx context.Context, actor *db.User, orgName, name, value string, _ *services.SecretBinding) (services.SecretResponse, error) {
	if s.setOrgSecretFn != nil {
		return s.setOrgSecretFn(ctx, actor, orgName, name, value)
	}
	return services.SecretResponse{Name: name}, nil
}

func (s secretsCovService) ListOrgSecrets(ctx context.Context, actor *db.User, orgName string) ([]services.SecretResponse, error) {
	if s.listOrgSecretsFn != nil {
		return s.listOrgSecretsFn(ctx, actor, orgName)
	}
	return []services.SecretResponse{}, nil
}

func (s secretsCovService) DeleteOrgSecret(ctx context.Context, actor *db.User, orgName, name string) error {
	if s.deleteOrgSecretFn != nil {
		return s.deleteOrgSecretFn(ctx, actor, orgName, name)
	}
	return nil
}

func TestSecrets_Cov_OrgSecretHandlers(t *testing.T) {
	t.Parallel()

	t.Run("list success", func(t *testing.T) {
		t.Parallel()

		h := &SecretHandler{Service: secretsCovService{
			listOrgSecretsFn: func(_ context.Context, actor *db.User, orgName string) ([]services.SecretResponse, error) {
				require.NotNil(t, actor)
				assert.Equal(t, int64(7), actor.ID)
				assert.Equal(t, "acme", orgName)
				return []services.SecretResponse{{Name: "ORG_TOKEN"}}, nil
			},
		}}
		req := httptest.NewRequest(http.MethodGet, "/api/orgs/acme/secrets", nil)
		req = withRouteParams(req, map[string]string{"org": "acme"})
		req = withAuth(req, 7, "alice")
		rec := httptest.NewRecorder()

		h.ListOrgSecrets(rec, req)

		require.Equal(t, http.StatusOK, rec.Code)
		var out []services.SecretResponse
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &out))
		require.Len(t, out, 1)
		assert.Equal(t, "ORG_TOKEN", out[0].Name)
	})

	t.Run("set success", func(t *testing.T) {
		t.Parallel()

		h := &SecretHandler{Service: secretsCovService{
			setOrgSecretFn: func(_ context.Context, actor *db.User, orgName, name, value string) (services.SecretResponse, error) {
				assert.Equal(t, int64(7), actor.ID)
				assert.Equal(t, "acme", orgName)
				assert.Equal(t, "ORG_TOKEN", name)
				assert.Equal(t, "secret-value", value)
				return services.SecretResponse{Name: name}, nil
			},
		}}
		req := httptest.NewRequest(http.MethodPut, "/api/orgs/acme/secrets", strings.NewReader(`{"name":"ORG_TOKEN","value":"secret-value"}`))
		req = withRouteParams(req, map[string]string{"org": "acme"})
		req = withAuth(req, 7, "alice")
		rec := httptest.NewRecorder()

		h.SetOrgSecret(rec, req)

		require.Equal(t, http.StatusCreated, rec.Code)
		assert.Contains(t, rec.Body.String(), "ORG_TOKEN")
	})

	t.Run("delete success", func(t *testing.T) {
		t.Parallel()

		h := &SecretHandler{Service: secretsCovService{
			deleteOrgSecretFn: func(_ context.Context, actor *db.User, orgName, name string) error {
				assert.Equal(t, int64(7), actor.ID)
				assert.Equal(t, "acme", orgName)
				assert.Equal(t, "ORG_TOKEN", name)
				return nil
			},
		}}
		req := httptest.NewRequest(http.MethodDelete, "/api/orgs/acme/secrets/ORG_TOKEN", nil)
		req = withRouteParams(req, map[string]string{"org": "acme", "name": "ORG_TOKEN"})
		req = withAuth(req, 7, "alice")
		rec := httptest.NewRecorder()

		h.DeleteOrgSecret(rec, req)

		require.Equal(t, http.StatusNoContent, rec.Code)
	})
}

func TestSecrets_Cov_ValidationAndServiceErrors(t *testing.T) {
	t.Parallel()

	t.Run("repo invalid secret value", func(t *testing.T) {
		t.Parallel()

		h := &SecretHandler{Service: secretsCovService{}}
		req := httptest.NewRequest(http.MethodPut, "/api/repos/alice/demo/secrets", strings.NewReader(`{"name":"KEY","value":""}`))
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
		req = withAuth(req, 1, "alice")
		rec := httptest.NewRecorder()

		h.SetSecret(rec, req)

		require.Equal(t, http.StatusUnprocessableEntity, rec.Code)
	})

	t.Run("org invalid json", func(t *testing.T) {
		t.Parallel()

		h := &SecretHandler{Service: secretsCovService{}}
		req := httptest.NewRequest(http.MethodPut, "/api/orgs/acme/secrets", strings.NewReader(`{`))
		req = withRouteParams(req, map[string]string{"org": "acme"})
		req = withAuth(req, 1, "alice")
		rec := httptest.NewRecorder()

		h.SetOrgSecret(rec, req)

		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("org service error", func(t *testing.T) {
		t.Parallel()

		h := &SecretHandler{Service: secretsCovService{
			listOrgSecretsFn: func(context.Context, *db.User, string) ([]services.SecretResponse, error) {
				return nil, pkgerrors.Forbidden("permission denied")
			},
		}}
		req := httptest.NewRequest(http.MethodGet, "/api/orgs/acme/secrets", nil)
		req = withRouteParams(req, map[string]string{"org": "acme"})
		rec := httptest.NewRecorder()

		h.ListOrgSecrets(rec, req)

		require.Equal(t, http.StatusForbidden, rec.Code)
	})

	t.Run("delete invalid org secret name", func(t *testing.T) {
		t.Parallel()

		h := &SecretHandler{Service: secretsCovService{}}
		req := httptest.NewRequest(http.MethodDelete, "/api/orgs/acme/secrets/bad%20name", nil)
		req = withRouteParams(req, map[string]string{"org": "acme", "name": "bad name"})
		req = withAuth(req, 1, "alice")
		rec := httptest.NewRecorder()

		h.DeleteOrgSecret(rec, req)

		require.Equal(t, http.StatusUnprocessableEntity, rec.Code)
	})
}
