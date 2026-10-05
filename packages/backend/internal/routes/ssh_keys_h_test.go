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

type sshKeysHAuditQuerier struct {
	calls int
	last  db.InsertAuditLogParams
}

func (q *sshKeysHAuditQuerier) InsertAuditLog(_ context.Context, arg db.InsertAuditLogParams) error {
	q.calls++
	q.last = arg
	return nil
}

func TestSSHKeys_H_AuditBranches(t *testing.T) {
	t.Run("create logs audit event", func(t *testing.T) {
		audit := &sshKeysHAuditQuerier{}
		h := SSHKeyHandler{
			Service: mockSSHKeyRouteService{
				createKeyFn: func(context.Context, int64, services.CreateSSHKeyRequest) (services.SSHKeyResponse, error) {
					return services.SSHKeyResponse{ID: 44, Name: "laptop"}, nil
				},
			},
			AuditService: services.NewAuditService(audit),
		}
		req := withSSHKeyAuth(httptest.NewRequest(http.MethodPost, "/api/user/keys", strings.NewReader(`{"title":"laptop","key":"ssh-ed25519 AAAA"}`)), 7)
		req.RemoteAddr = "127.0.0.1:1111"
		rec := httptest.NewRecorder()

		h.CreateSSHKey(rec, req)

		require.Equal(t, http.StatusCreated, rec.Code)
		require.Equal(t, 1, audit.calls)
		assert.Equal(t, "ssh_key.create", audit.last.EventType)
		assert.Equal(t, "laptop", audit.last.TargetName)
		assert.Equal(t, "127.0.0.1", audit.last.IpAddress, "audit_log stores the client IP without its port")
	})

	t.Run("delete logs audit event", func(t *testing.T) {
		audit := &sshKeysHAuditQuerier{}
		h := SSHKeyHandler{
			Service: mockSSHKeyRouteService{
				deleteKeyFn: func(context.Context, int64, int64) error { return nil },
			},
			AuditService: services.NewAuditService(audit),
		}
		req := withSSHKeyAuth(withSSHKeyRouteParam(httptest.NewRequest(http.MethodDelete, "/api/user/keys/44", nil), "44"), 7)
		req.RemoteAddr = "127.0.0.1:2222"
		rec := httptest.NewRecorder()

		h.DeleteSSHKey(rec, req)

		require.Equal(t, http.StatusNoContent, rec.Code)
		require.Equal(t, 1, audit.calls)
		assert.Equal(t, "ssh_key.delete", audit.last.EventType)
		assert.Equal(t, "key_44", audit.last.TargetName)
		assert.Equal(t, "127.0.0.1", audit.last.IpAddress, "audit_log stores the client IP without its port")
	})
}
