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
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type deployKeysHAuditQuerier struct {
	calls int
	last  db.InsertAuditLogParams
}

func (q *deployKeysHAuditQuerier) InsertAuditLog(_ context.Context, arg db.InsertAuditLogParams) error {
	q.calls++
	q.last = arg
	return nil
}

func TestDeployKeys_H_CreateAndDeleteRemainingBranches(t *testing.T) {
	t.Run("create missing repo param", func(t *testing.T) {
		h := &DeployKeyHandler{Service: &mockDeployKeyRouteService{}}
		req := httptest.NewRequest(http.MethodPost, "/api/repos/alice//keys", strings.NewReader(`{"title":"k","key":"ssh-ed25519 AAAA"}`))
		req = withRouteParams(req, map[string]string{"owner": "alice"})
		req = withAuth(req, 7, "alice")
		rec := httptest.NewRecorder()

		h.CreateDeployKey(rec, req)

		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("create logs audit event", func(t *testing.T) {
		audit := &deployKeysHAuditQuerier{}
		h := &DeployKeyHandler{
			Service: &mockDeployKeyRouteService{
				createDeployKeyFn: func(context.Context, string, string, services.CreateDeployKeyRequest) (services.DeployKeyResponse, error) {
					return services.DeployKeyResponse{ID: 55, Title: "deploy"}, nil
				},
			},
			AuditService: services.NewAuditService(audit),
		}
		req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/keys", strings.NewReader(`{"title":"deploy","key":"ssh-ed25519 AAAA"}`))
		req.RemoteAddr = "127.0.0.1:1234"
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
		req = withAuth(req, 7, "alice")
		rec := httptest.NewRecorder()

		h.CreateDeployKey(rec, req)

		require.Equal(t, http.StatusCreated, rec.Code)
		require.Equal(t, 1, audit.calls)
		assert.Equal(t, "deploy_key.create", audit.last.EventType)
		assert.Equal(t, "deploy", audit.last.TargetName)
		assert.Equal(t, "127.0.0.1", audit.last.IpAddress, "audit_log stores the client IP without its port")
	})

	t.Run("delete missing repo param", func(t *testing.T) {
		h := &DeployKeyHandler{Service: &mockDeployKeyRouteService{}}
		req := httptest.NewRequest(http.MethodDelete, "/api/repos/alice//keys/9", nil)
		req = withRouteParams(req, map[string]string{"owner": "alice", "id": "9"})
		req = withAuth(req, 7, "alice")
		rec := httptest.NewRecorder()

		h.DeleteDeployKey(rec, req)

		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("delete logs audit event", func(t *testing.T) {
		audit := &deployKeysHAuditQuerier{}
		h := &DeployKeyHandler{
			Service: &mockDeployKeyRouteService{
				deleteDeployKeyFn: func(context.Context, string, string, int64) error { return nil },
			},
			AuditService: services.NewAuditService(audit),
		}
		req := httptest.NewRequest(http.MethodDelete, "/api/repos/alice/demo/keys/55", nil)
		req.RemoteAddr = "127.0.0.1:5678"
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "id": "55"})
		req = withAuth(req, 7, "alice")
		rec := httptest.NewRecorder()

		h.DeleteDeployKey(rec, req)

		require.Equal(t, http.StatusNoContent, rec.Code)
		require.Equal(t, 1, audit.calls)
		assert.Equal(t, "deploy_key.delete", audit.last.EventType)
		assert.Equal(t, "deploy_key_55", audit.last.TargetName)
		assert.Equal(t, "127.0.0.1", audit.last.IpAddress, "audit_log stores the client IP without its port")
	})
}
