package routes

import (
	"context"
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
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

const childParentID = "0f8fad5b-d9cb-469f-a165-70867728950e"

type mockWorkspaceChildrenService struct {
	mockWorkspaceRouteService
	spawn  services.SpawnWorkspaceChildrenInput
	parent string
	child  string
	err    error
}

func (m *mockWorkspaceChildrenService) SpawnWorkspaceChildren(_ context.Context, input services.SpawnWorkspaceChildrenInput) (services.WorkspaceChildBatch, error) {
	m.spawn = input
	return services.WorkspaceChildBatch{ID: "batch", ParentWorkspaceID: input.ParentWorkspaceID,
		Children: []services.WorkspaceChild{{WorkspaceID: "child-1", Status: "starting"}}}, m.err
}

func (m *mockWorkspaceChildrenService) ListWorkspaceChildren(_ context.Context, workspaceID string, repositoryID, userID int64) ([]services.WorkspaceChild, error) {
	m.parent = workspaceID
	return []services.WorkspaceChild{{WorkspaceID: "child-1", Status: "running"}}, m.err
}

func (m *mockWorkspaceChildrenService) StopWorkspaceChild(_ context.Context, parent, child string, repositoryID, userID int64) (services.WorkspaceChild, error) {
	m.parent, m.child = parent, child
	return services.WorkspaceChild{WorkspaceID: child, Status: "stopped", StopReason: "requested"}, m.err
}

// childRouter mounts the children routes behind a stand-in for the auth and
// repository middleware.
func childRouter(svc WorkspaceRouteService, info *middleware.AuthInfo, repo bool) http.Handler {
	r := chi.NewRouter()
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			if repo {
				req = withWorkspaceRepoCtx(req, "alice", "demo")
			}
			if info != nil {
				req = req.WithContext(middleware.ContextWithAuthInfo(req.Context(), info))
			}
			next.ServeHTTP(w, req)
		})
	})
	r.Route("/api/repos/{owner}/{repo}", func(r chi.Router) {
		RegisterWorkspaceChildrenRoutes(r, &WorkspaceHandler{Service: svc}, nil, nil)
	})
	return r
}

func childRequest(t *testing.T, handler http.Handler, method, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, "/api/repos/alice/demo/workspaces/"+path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	return rec
}

func TestWorkspaceChildrenRoutes(t *testing.T) {
	t.Parallel()
	owner := &middleware.AuthInfo{User: &db.User{ID: 7}}
	credential := &middleware.AuthInfo{User: &db.User{ID: 7}, IsTokenAuth: true,
		RawScopes: "write:workspace,repo:200," + middleware.WorkspaceRestrictionScope(childParentID) + "," + middleware.WorkspaceChildrenCredentialScope()}

	t.Run("spawn from outside", func(t *testing.T) {
		svc := &mockWorkspaceChildrenService{}
		rec := childRequest(t, childRouter(svc, owner, true), http.MethodPost, childParentID+"/children", `{"count":3,"profile":"build","ttl_secs":600}`)
		require.Equal(t, http.StatusAccepted, rec.Code, rec.Body.String())
		assert.Equal(t, services.SpawnWorkspaceChildrenInput{RepositoryID: 200, UserID: 7, ParentWorkspaceID: childParentID,
			Count: 3, Profile: "build", TTL: 10 * time.Minute}, svc.spawn)
		assert.Contains(t, rec.Body.String(), `"workspace_id":"child-1"`)
	})
	t.Run("spawn from inside marks the credential", func(t *testing.T) {
		svc := &mockWorkspaceChildrenService{}
		rec := childRequest(t, childRouter(svc, credential, true), http.MethodPost, strings.ToUpper(childParentID)+"/children", `{"count":1}`)
		require.Equal(t, http.StatusAccepted, rec.Code, rec.Body.String())
		assert.True(t, svc.spawn.ViaWorkspaceCredential)
	})
	t.Run("a credential addresses only its own workspace", func(t *testing.T) {
		svc := &mockWorkspaceChildrenService{}
		for _, tc := range []struct{ method, path string }{
			{http.MethodPost, "7c9e6679-7425-40de-944b-e07fc1f90ae7/children"},
			{http.MethodGet, "7c9e6679-7425-40de-944b-e07fc1f90ae7/children"},
			{http.MethodPost, "7c9e6679-7425-40de-944b-e07fc1f90ae7/children/child-1/stop"},
		} {
			rec := childRequest(t, childRouter(svc, credential, true), tc.method, tc.path, `{"count":1}`)
			require.Equal(t, http.StatusForbidden, rec.Code, tc.path)
		}
		assert.Zero(t, svc.spawn.Count)
		assert.Empty(t, svc.parent)
	})
	t.Run("bad bodies", func(t *testing.T) {
		for body, want := range map[string]string{
			`{"count":1,"parent":"x"}`:          "unknown field",
			`{"count":1,"ttl_secs":-1}`:         "ttl_secs is out of range",
			`{"count":1,"ttl_secs":9300000000}`: "ttl_secs is out of range",
			`{"count":`:                         "invalid request body",
		} {
			svc := &mockWorkspaceChildrenService{}
			rec := childRequest(t, childRouter(svc, owner, true), http.MethodPost, childParentID+"/children", body)
			require.Equal(t, http.StatusBadRequest, rec.Code, body)
			assert.Contains(t, rec.Body.String(), want, body)
			assert.Zero(t, svc.spawn.Count, body)
		}
	})
	t.Run("list and stop", func(t *testing.T) {
		svc := &mockWorkspaceChildrenService{}
		rec := childRequest(t, childRouter(svc, credential, true), http.MethodGet, childParentID+"/children", "")
		require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
		assert.True(t, strings.HasPrefix(rec.Body.String(), "["), "the list is an array")
		rec = childRequest(t, childRouter(svc, credential, true), http.MethodPost, childParentID+"/children/child-1/stop", "")
		require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
		assert.Equal(t, childParentID, svc.parent)
		assert.Equal(t, "child-1", svc.child)
		assert.Contains(t, rec.Body.String(), `"stop_reason":"requested"`)
	})
	t.Run("service errors keep their status", func(t *testing.T) {
		svc := &mockWorkspaceChildrenService{err: pkgerrors.QuotaExceeded("child workspace limit reached")}
		for _, tc := range []struct{ method, path string }{
			{http.MethodPost, childParentID + "/children"},
			{http.MethodGet, childParentID + "/children"},
			{http.MethodPost, childParentID + "/children/child-1/stop"},
		} {
			rec := childRequest(t, childRouter(svc, owner, true), tc.method, tc.path, `{"count":1}`)
			require.Equal(t, http.StatusTooManyRequests, rec.Code, tc.path)
			assert.Contains(t, rec.Body.String(), "child workspace limit reached")
		}
	})
	t.Run("preconditions", func(t *testing.T) {
		rec := childRequest(t, childRouter(&mockWorkspaceChildrenService{}, nil, true), http.MethodGet, childParentID+"/children", "")
		assert.Equal(t, http.StatusUnauthorized, rec.Code)
		rec = childRequest(t, childRouter(&mockWorkspaceChildrenService{}, owner, false), http.MethodGet, childParentID+"/children", "")
		assert.Equal(t, http.StatusBadRequest, rec.Code)
		rec = childRequest(t, childRouter(&mockWorkspaceRouteService{}, owner, true), http.MethodGet, childParentID+"/children", "")
		assert.Equal(t, http.StatusConflict, rec.Code)
		assert.Contains(t, rec.Body.String(), "sandbox provider")

		h := &WorkspaceHandler{Service: &mockWorkspaceChildrenService{}}
		req := withWorkspaceRepoCtx(httptest.NewRequest(http.MethodGet, "/", nil), "alice", "demo")
		req = req.WithContext(middleware.ContextWithAuthInfo(req.Context(), owner))
		rec = httptest.NewRecorder()
		h.ListWorkspaceChildren(rec, req)
		assert.Equal(t, http.StatusBadRequest, rec.Code, "no workspace id")
		rctx := chi.NewRouteContext()
		rctx.URLParams.Add("id", childParentID)
		rec = httptest.NewRecorder()
		h.StopWorkspaceChild(rec, req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rctx)))
		assert.Equal(t, http.StatusBadRequest, rec.Code, "no child id")
		assert.Contains(t, rec.Body.String(), "child workspace id is required")
		for _, rec := range []*httptest.ResponseRecorder{httptest.NewRecorder(), httptest.NewRecorder()} {
			h.SpawnWorkspaceChildren(rec, httptest.NewRequest(http.MethodPost, "/", nil))
			assert.Equal(t, http.StatusUnauthorized, rec.Code)
		}
		RegisterWorkspaceChildrenRoutes(nil, h, nil, nil)
		RegisterWorkspaceChildrenRoutes(chi.NewRouter(), nil, nil, nil)
	})
}
