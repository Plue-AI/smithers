package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// pathSecretService validates the declared path the way SecretService does,
// so the route's refusal body is the one a person sees.
type pathSecretService struct {
	mockSecretRouteService
}

func (s *pathSecretService) SetSecret(ctx context.Context, actor *db.User, owner, repo, name, value string, mainOnly *bool, binding *services.SecretBinding, path *string) (services.SecretResponse, error) {
	s.path = path
	response := services.SecretResponse{Name: name}
	if path != nil {
		normalized, err := services.NormalizeSecretPath(*path)
		if err != nil {
			return services.SecretResponse{}, err
		}
		response.Path = normalized
	}
	return response, nil
}

func TestSecretHandlerSetSecretPath(t *testing.T) {
	t.Parallel()
	put := func(service *pathSecretService, body string) *httptest.ResponseRecorder {
		h := &SecretHandler{Service: service}
		req := httptest.NewRequest(http.MethodPut, "/api/secrets", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
		req = withAuth(req, 1, "alice")
		rec := httptest.NewRecorder()
		h.SetSecret(rec, req)
		return rec
	}

	service := &pathSecretService{}
	rec := put(service, `{"name":"ANTHROPIC_API_KEY","value":"v","path":"~/.config/anthropic/key"}`)
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	require.NotNil(t, service.path)
	require.Equal(t, "~/.config/anthropic/key", *service.path)
	var created services.SecretResponse
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &created))
	require.Equal(t, "~/.config/anthropic/key", created.Path)

	service = &pathSecretService{}
	rec = put(service, `{"name":"TOKEN","value":"v"}`)
	require.Equal(t, http.StatusCreated, rec.Code)
	require.Nil(t, service.path, "an omitted path keeps the stored one")
	require.NotContains(t, rec.Body.String(), `"path"`)

	service = &pathSecretService{}
	rec = put(service, `{"name":"TOKEN","value":"v","path":""}`)
	require.Equal(t, http.StatusCreated, rec.Code)
	require.NotNil(t, service.path)
	require.Equal(t, "", *service.path)

	for _, declared := range []string{"/workspace/.env", "~/../x", "~/.cargo/credentials.toml", "/etc/x"} {
		rec = put(&pathSecretService{}, `{"name":"TOKEN","value":"v","path":"`+declared+`"}`)
		require.Equal(t, http.StatusBadRequest, rec.Code, declared)
		var refusal struct {
			Class string `json:"class"`
			Code  string `json:"code"`
		}
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &refusal), rec.Body.String())
		require.Equal(t, "user", refusal.Class, declared)
		require.True(t, strings.HasPrefix(refusal.Code, "path_"), refusal.Code)
	}
}
