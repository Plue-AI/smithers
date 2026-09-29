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
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type mockLFSRouteService struct {
	batchFn         func(ctx context.Context, actor *db.User, owner, repo string, input services.LFSBatchInput) (services.LFSBatchResponse, error)
	confirmUploadFn func(ctx context.Context, actor *db.User, owner, repo string, input services.LFSConfirmUploadInput) (db.LfsObject, error)
	deleteObjectFn  func(ctx context.Context, actor *db.User, owner, repo, oid string) error
	listObjectsFn   func(ctx context.Context, viewer *db.User, owner, repo string, page, perPage int) ([]db.LfsObject, int64, error)
}

func (m *mockLFSRouteService) Batch(ctx context.Context, actor *db.User, owner, repo string, input services.LFSBatchInput) (services.LFSBatchResponse, error) {
	if m.batchFn != nil {
		return m.batchFn(ctx, actor, owner, repo, input)
	}
	return services.LFSBatchResponse{Transfer: "basic", Objects: []services.LFSBatchObjectResponse{}}, nil
}
func (m *mockLFSRouteService) ConfirmUpload(ctx context.Context, actor *db.User, owner, repo string, input services.LFSConfirmUploadInput) (db.LfsObject, error) {
	if m.confirmUploadFn != nil {
		return m.confirmUploadFn(ctx, actor, owner, repo, input)
	}
	return db.LfsObject{}, nil
}
func (m *mockLFSRouteService) DeleteObject(ctx context.Context, actor *db.User, owner, repo, oid string) error {
	if m.deleteObjectFn != nil {
		return m.deleteObjectFn(ctx, actor, owner, repo, oid)
	}
	return nil
}
func (m *mockLFSRouteService) ListObjects(ctx context.Context, viewer *db.User, owner, repo string, page, perPage int) ([]db.LfsObject, int64, error) {
	if m.listObjectsFn != nil {
		return m.listObjectsFn(ctx, viewer, owner, repo, page, perPage)
	}
	return []db.LfsObject{}, 0, nil
}

func TestLFSHandler_BatchAndConfirm(t *testing.T) {
	t.Run("batch invalid json", func(t *testing.T) {
		h := LFSHandler{Service: &mockLFSRouteService{}}
		req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/lfs/batch", strings.NewReader("not-json"))
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
		rec := httptest.NewRecorder()
		h.PostBatch(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)
	})
	t.Run("batch success includes transfer and objects envelope", func(t *testing.T) {
		h := LFSHandler{Service: &mockLFSRouteService{batchFn: func(ctx context.Context, actor *db.User, owner, repo string, input services.LFSBatchInput) (services.LFSBatchResponse, error) {
			return services.LFSBatchResponse{
				Transfer: "basic",
				Objects:  []services.LFSBatchObjectResponse{{Oid: "a", Size: 1, Actions: map[string]services.LFSBatchActionLink{"upload": {Href: "u"}}}},
			}, nil
		}}}
		req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/lfs/batch", strings.NewReader(`{"operation":"upload","objects":[{"oid":"a","size":1}]}`))
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
		req = withAuth(req, 1, "alice")
		rec := httptest.NewRecorder()
		h.PostBatch(rec, req)
		require.Equal(t, http.StatusOK, rec.Code)
		assert.Equal(t, LFSJSONMediaType, rec.Header().Get("Content-Type"))
		var resp services.LFSBatchResponse
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &resp))
		assert.Equal(t, "basic", resp.Transfer)
		require.Len(t, resp.Objects, 1)
		assert.Equal(t, "a", resp.Objects[0].Oid)
		assert.Equal(t, "u", resp.Objects[0].Actions["upload"].Href)
	})
	t.Run("batch service error", func(t *testing.T) {
		h := LFSHandler{Service: &mockLFSRouteService{batchFn: func(ctx context.Context, actor *db.User, owner, repo string, input services.LFSBatchInput) (services.LFSBatchResponse, error) {
			return services.LFSBatchResponse{}, pkgerrors.Forbidden("denied")
		}}}
		req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/lfs/batch", strings.NewReader(`{"operation":"upload","objects":[{"oid":"a","size":1}]}`))
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
		rec := httptest.NewRecorder()
		h.PostBatch(rec, req)
		require.Equal(t, http.StatusForbidden, rec.Code)
	})
	t.Run("batch delegates token scope decision to service", func(t *testing.T) {
		called := false
		h := LFSHandler{Service: &mockLFSRouteService{batchFn: func(ctx context.Context, actor *db.User, owner, repo string, input services.LFSBatchInput) (services.LFSBatchResponse, error) {
			called = true
			assert.True(t, middleware.AuthInfoFromContext(ctx).Scopes.Has(middleware.ScopeReadRepository))
			return services.LFSBatchResponse{}, pkgerrors.Forbidden("insufficient token scope")
		}}}
		req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/lfs/batch", strings.NewReader(`{"operation":"upload","objects":[{"oid":"a","size":1}]}`))
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
		req = withTokenAuth(req, 1, "alice", middleware.ScopeReadRepository)
		rec := httptest.NewRecorder()
		h.PostBatch(rec, req)
		require.Equal(t, http.StatusForbidden, rec.Code)
		assert.True(t, called)
	})
	t.Run("batch download allows read scope for token auth", func(t *testing.T) {
		h := LFSHandler{Service: &mockLFSRouteService{batchFn: func(ctx context.Context, actor *db.User, owner, repo string, input services.LFSBatchInput) (services.LFSBatchResponse, error) {
			assert.Equal(t, "download", input.Operation)
			return services.LFSBatchResponse{Transfer: "basic"}, nil
		}}}
		req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/lfs/batch", strings.NewReader(`{"operation":"download","objects":[{"oid":"a","size":1}]}`))
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
		req = withTokenAuth(req, 1, "alice", middleware.ScopeReadRepository)
		rec := httptest.NewRecorder()
		h.PostBatch(rec, req)
		require.Equal(t, http.StatusOK, rec.Code)
	})
	t.Run("confirm requires auth", func(t *testing.T) {
		h := LFSHandler{Service: &mockLFSRouteService{}}
		req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/lfs/confirm", strings.NewReader(`{"oid":"a","size":1}`))
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
		rec := httptest.NewRecorder()
		h.PostConfirm(rec, req)
		require.Equal(t, http.StatusUnauthorized, rec.Code)
	})
	t.Run("confirm created", func(t *testing.T) {
		h := LFSHandler{Service: &mockLFSRouteService{confirmUploadFn: func(ctx context.Context, actor *db.User, owner, repo string, input services.LFSConfirmUploadInput) (db.LfsObject, error) {
			return db.LfsObject{ID: 9, Oid: input.Oid, Size: input.Size}, nil
		}}}
		req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/lfs/confirm", strings.NewReader(`{"oid":"a","size":1}`))
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
		req = withAuth(req, 1, "alice")
		rec := httptest.NewRecorder()
		h.PostConfirm(rec, req)
		require.Equal(t, http.StatusCreated, rec.Code)
		var out db.LfsObject
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &out))
		assert.Equal(t, int64(9), out.ID)
	})
	t.Run("standard verify returns empty protocol response", func(t *testing.T) {
		called := false
		h := LFSHandler{Service: &mockLFSRouteService{confirmUploadFn: func(_ context.Context, actor *db.User, owner, repo string, input services.LFSConfirmUploadInput) (db.LfsObject, error) {
			called = true
			assert.Equal(t, int64(1), actor.ID)
			assert.Equal(t, "alice", owner)
			assert.Equal(t, "demo", repo)
			assert.Equal(t, "abc", input.Oid)
			assert.Equal(t, int64(3), input.Size)
			return db.LfsObject{ID: 10}, nil
		}}}
		req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/lfs/verify", strings.NewReader(`{"oid":"abc","size":3}`))
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
		req = withAuth(req, 1, "alice")
		rec := httptest.NewRecorder()
		h.PostVerify(rec, req)
		require.Equal(t, http.StatusOK, rec.Code)
		assert.True(t, called)
		assert.Equal(t, LFSJSONMediaType, rec.Header().Get("Content-Type"))
		assert.Empty(t, rec.Body.String())
	})
}

func TestLFSHandler_DeleteAndList(t *testing.T) {
	t.Run("delete missing oid", func(t *testing.T) {
		h := LFSHandler{Service: &mockLFSRouteService{}}
		req := httptest.NewRequest(http.MethodDelete, "/api/repos/alice/demo/lfs/objects/", nil)
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
		req = withAuth(req, 1, "alice")
		rec := httptest.NewRecorder()
		h.DeleteObject(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)
	})
	t.Run("delete success", func(t *testing.T) {
		h := LFSHandler{Service: &mockLFSRouteService{}}
		req := httptest.NewRequest(http.MethodDelete, "/api/repos/alice/demo/lfs/objects/a", nil)
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "oid": "a"})
		req = withAuth(req, 1, "alice")
		rec := httptest.NewRecorder()
		h.DeleteObject(rec, req)
		require.Equal(t, http.StatusNoContent, rec.Code)
	})
	t.Run("list success", func(t *testing.T) {
		h := LFSHandler{Service: &mockLFSRouteService{listObjectsFn: func(ctx context.Context, viewer *db.User, owner, repo string, page, perPage int) ([]db.LfsObject, int64, error) {
			return []db.LfsObject{{ID: 1, Oid: "a", Size: 1}}, 21, nil
		}}}
		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/lfs/objects?page=2&per_page=10", nil)
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
		rec := httptest.NewRecorder()
		h.GetObjects(rec, req)
		require.Equal(t, http.StatusOK, rec.Code)
		assert.Equal(t, "21", rec.Header().Get("X-Total-Count"))
	})
	t.Run("list service error", func(t *testing.T) {
		h := LFSHandler{Service: &mockLFSRouteService{listObjectsFn: func(ctx context.Context, viewer *db.User, owner, repo string, page, perPage int) ([]db.LfsObject, int64, error) {
			return nil, 0, pkgerrors.NotFound("missing")
		}}}
		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/lfs/objects", nil)
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
		rec := httptest.NewRecorder()
		h.GetObjects(rec, req)
		require.Equal(t, http.StatusNotFound, rec.Code)
	})
	t.Run("uses repo context without route params", func(t *testing.T) {
		h := LFSHandler{Service: &mockLFSRouteService{listObjectsFn: func(ctx context.Context, viewer *db.User, owner, repo string, page, perPage int) ([]db.LfsObject, int64, error) {
			assert.Equal(t, "alice", owner)
			assert.Equal(t, "demo", repo)
			return []db.LfsObject{}, 0, nil
		}}}
		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/lfs/objects", nil)
		req = withRepoContext(req, "alice", "demo")
		rec := httptest.NewRecorder()
		h.GetObjects(rec, req)
		require.Equal(t, http.StatusOK, rec.Code)
	})
}
