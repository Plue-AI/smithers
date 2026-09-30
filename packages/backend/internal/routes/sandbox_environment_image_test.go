package routes

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type fakeEnvironmentImageRouteService struct {
	registered []services.RegisterSandboxEnvironmentImageInput
}

func (f *fakeEnvironmentImageRouteService) Register(_ context.Context, input services.RegisterSandboxEnvironmentImageInput) (services.SandboxEnvironmentImageResponse, error) {
	f.registered = append(f.registered, input)
	return services.SandboxEnvironmentImageResponse{ID: "image-id", RepositoryID: input.RepositoryID, Kind: input.Kind}, nil
}

func (*fakeEnvironmentImageRouteService) List(context.Context, int64) ([]services.SandboxEnvironmentImageResponse, error) {
	return nil, nil
}

func (*fakeEnvironmentImageRouteService) Retire(context.Context, int64, string) (services.SandboxEnvironmentImageResponse, error) {
	return services.SandboxEnvironmentImageResponse{}, nil
}

func TestSandboxEnvironmentImageHandlerRegisterBaseImageUsesPlatformScope(t *testing.T) {
	service := &fakeEnvironmentImageRouteService{}
	handler := &SandboxEnvironmentImageHandler{Service: service}
	body := `{"kind":"vm","closure_hash":"0123456789abcdefghijklmnopqrstuv","image":"registry/base:0123456789abcdefghijklmnopqrstuv"}`
	request := withAuth(httptest.NewRequest(http.MethodPost, "/api/admin/sandbox/environment-images", strings.NewReader(body)), 19, "admin")
	recorder := httptest.NewRecorder()

	handler.RegisterBaseImage(recorder, request)

	require.Equal(t, http.StatusCreated, recorder.Code)
	require.Len(t, service.registered, 1)
	assert.Zero(t, service.registered[0].RepositoryID)
	assert.Equal(t, int64(19), service.registered[0].CreatedBy)
}

func TestSandboxEnvironmentImageHandlerRegisterRepoImageUsesRouteRepository(t *testing.T) {
	service := &fakeEnvironmentImageRouteService{}
	handler := &SandboxEnvironmentImageHandler{Service: service}
	body := `{"kind":"desktop","closure_hash":"0123456789abcdefghijklmnopqrstuv","image":"registry/repo:0123456789abcdefghijklmnopqrstuv"}`
	request := withAuth(httptest.NewRequest(http.MethodPost, "/api/repos/acme/widgets/environment-images", strings.NewReader(body)), 7, "owner")
	request = request.WithContext(middleware.ContextWithRepoContext(request.Context(), &middleware.RepoContext{
		Owner: "acme", Repository: &db.Repository{ID: 42, Name: "widgets"},
	}, middleware.PermissionAdmin))
	recorder := httptest.NewRecorder()

	handler.RegisterRepoImage(recorder, request)

	require.Equal(t, http.StatusCreated, recorder.Code)
	require.Len(t, service.registered, 1)
	assert.Equal(t, int64(42), service.registered[0].RepositoryID)
	assert.Equal(t, int64(7), service.registered[0].CreatedBy)
}

func TestSandboxEnvironmentImageRegistrationRequiresOneBoundedDocument(t *testing.T) {
	body := `{"kind":"vm","closure_hash":"0123456789abcdefghijklmnopqrstuv","image":"registry/base:0123456789abcdefghijklmnopqrstuv","future":true}`
	for _, scope := range []string{"repository", "platform"} {
		for _, tc := range []struct {
			name, suffix string
			accepted     bool
		}{
			{"one document", "", true}, {"whitespace", "\n\t ", true},
			{"exact limit", strings.Repeat(" ", (16<<10)-len(body)), true},
			{"above limit", strings.Repeat(" ", (16<<10)-len(body)+1), false},
			{"object", " {}", false}, {"null", " null", false}, {"array", " []", false},
			{"boolean", " true", false}, {"number", " 1", false}, {"string", ` "text"`, false}, {"junk", " junk", false},
		} {
			t.Run(scope+"/"+tc.name, func(t *testing.T) {
				service := &fakeEnvironmentImageRouteService{}
				handler := &SandboxEnvironmentImageHandler{Service: service}
				req := withAuth(httptest.NewRequest(http.MethodPost, "/", strings.NewReader(body+tc.suffix)), 7, "owner")
				rec := httptest.NewRecorder()
				if scope == "repository" {
					req = withWorkspaceRepoCtx(req, "owner", "demo")
					handler.RegisterRepoImage(rec, req)
				} else {
					handler.RegisterBaseImage(rec, req)
				}
				if tc.accepted {
					require.Equal(t, 201, rec.Code, rec.Body.String())
					require.Len(t, service.registered, 1)
					require.Equal(t, "vm", service.registered[0].Kind)
				} else {
					require.Equal(t, 400, rec.Code, rec.Body.String())
					require.Empty(t, service.registered)
				}
			})
		}
	}
}
