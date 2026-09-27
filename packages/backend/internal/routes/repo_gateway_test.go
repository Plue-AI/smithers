package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/previewgateway"
)

type mockRepoGatewayRouteService struct {
	getConnectionInfoFn func(ctx context.Context, input services.RepoGatewayConnectionInput) (services.RepoGatewayConnectionInfo, error)
}

type mockRepoGatewayRelayService struct {
	authorizeFn func(context.Context, string, string) (services.RepoGatewayRelayTarget, error)
}

func (m *mockRepoGatewayRelayService) AuthorizeRelay(ctx context.Context, gatewayID, token string) (services.RepoGatewayRelayTarget, error) {
	return m.authorizeFn(ctx, gatewayID, token)
}

func (m *mockRepoGatewayRouteService) GetRepoGatewayConnectionInfo(ctx context.Context, input services.RepoGatewayConnectionInput) (services.RepoGatewayConnectionInfo, error) {
	if m.getConnectionInfoFn != nil {
		return m.getConnectionInfoFn(ctx, input)
	}
	return services.RepoGatewayConnectionInfo{}, nil
}

func TestRepoGatewayHandler_RequiresAuth(t *testing.T) {
	t.Parallel()

	h := &RepoGatewayHandler{Service: &mockRepoGatewayRouteService{}}
	req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/gateway", nil)
	req = withWorkspaceRepoCtx(req, "alice", "demo")
	rec := httptest.NewRecorder()
	h.PostRepoGateway(rec, req)

	require.Equal(t, http.StatusUnauthorized, rec.Code)
}

func TestRepoGatewayHandler_RequiresRepoContext(t *testing.T) {
	t.Parallel()

	h := &RepoGatewayHandler{Service: &mockRepoGatewayRouteService{}}
	req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/gateway", nil)
	req = withAuth(req, 1, "alice")
	rec := httptest.NewRecorder()
	h.PostRepoGateway(rec, req)

	require.Equal(t, http.StatusBadRequest, rec.Code)
}

func TestRepoGatewayHandler_Success(t *testing.T) {
	t.Parallel()

	expiresAt := time.Date(2026, 7, 3, 12, 0, 0, 0, time.UTC)
	h := &RepoGatewayHandler{Service: &mockRepoGatewayRouteService{
		getConnectionInfoFn: func(ctx context.Context, input services.RepoGatewayConnectionInput) (services.RepoGatewayConnectionInfo, error) {
			assert.Equal(t, int64(200), input.RepositoryID)
			assert.Equal(t, int64(1), input.UserID)
			assert.Equal(t, "ca5f0c31-7736-4a6d-b275-b62c8f5d7fe2", input.WorkspaceID)
			return services.RepoGatewayConnectionInfo{
				BaseURL:   "https://vm-1.sandbox.sh",
				Token:     "smithers_gateway_abc123",
				ExpiresAt: expiresAt,
				GatewayID: "gw-1",
				VMID:      "vm-1",
				Status:    "running",
			}, nil
		},
	}}

	req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/gateway", strings.NewReader(`{"workspace_id":"ca5f0c31-7736-4a6d-b275-b62c8f5d7fe2"}`))
	req = withWorkspaceRepoCtx(req, "alice", "demo")
	req = withAuth(req, 1, "alice")
	rec := httptest.NewRecorder()
	h.PostRepoGateway(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	var payload map[string]any
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &payload))
	assert.Equal(t, "https://example.com/api/gateways/gw-1", payload["base_url"])
	assert.Equal(t, "smithers_gateway_abc123", payload["token"])
	assert.Equal(t, "2026-07-03T12:00:00Z", payload["expires_at"])
	assert.Equal(t, "running", payload["status"])
}

func TestRepoGatewayHandler_ForwardsRequiredCapability(t *testing.T) {
	h := &RepoGatewayHandler{Service: &mockRepoGatewayRouteService{getConnectionInfoFn: func(_ context.Context, input services.RepoGatewayConnectionInput) (services.RepoGatewayConnectionInfo, error) {
		require.Equal(t, "workspace", input.WorkspaceID)
		require.Equal(t, "repository-jobs/v1", input.RequiredCapability)
		return services.RepoGatewayConnectionInfo{GatewayID: "gateway", WorkspaceID: input.WorkspaceID}, nil
	}}}
	req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/gateway", strings.NewReader(`{"workspace_id":"workspace","required_capability":"repository-jobs/v1"}`))
	req = withAuth(withWorkspaceRepoCtx(req, "alice", "demo"), 1, "alice")
	rec := httptest.NewRecorder()
	h.PostRepoGateway(rec, req)
	require.Equal(t, http.StatusOK, rec.Code)
}

func TestRepoGatewayHandler_ServiceErrorMapped(t *testing.T) {
	t.Parallel()

	h := &RepoGatewayHandler{Service: &mockRepoGatewayRouteService{
		getConnectionInfoFn: func(ctx context.Context, input services.RepoGatewayConnectionInput) (services.RepoGatewayConnectionInfo, error) {
			return services.RepoGatewayConnectionInfo{}, pkgerrors.Conflict("gateway provisioning is not configured on this deployment")
		},
	}}

	req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/gateway", nil)
	req = withWorkspaceRepoCtx(req, "alice", "demo")
	req = withAuth(req, 1, "alice")
	rec := httptest.NewRecorder()
	h.PostRepoGateway(rec, req)

	require.Equal(t, http.StatusConflict, rec.Code)
	assert.Contains(t, rec.Body.String(), "not configured")
}

func TestRepoGatewayHandler_RelayAuthenticatesAndRewrites(t *testing.T) {
	t.Parallel()
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, "gw-vm.preview.jjhub.tech", r.Host)
		// The preview gateway routes by path (/__preview/{domain}/{path});
		// a bare forwarded path 404s there.
		assert.Equal(t, "/__preview/gw-vm.preview.jjhub.tech/v1/rpc/listWorkflows", r.URL.Path)
		assert.Equal(t, "Bearer relay-token", r.Header.Get("Authorization"))
		// The gateway VM validates that operator token itself; the API-origin
		// session cookie is no business of the guest.
		assert.Empty(t, r.Header.Values("Cookie"))
		// The gateway refuses smithers-gw-* without the relay credential, and
		// the client's own value for that header is never forwarded.
		assert.Equal(t, "relay-secret", r.Header.Get(previewgateway.RelayTokenHeader))
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer upstream.Close()

	h := &RepoGatewayHandler{
		RelayServiceURL: upstream.URL,
		RelayToken:      "relay-secret",
		RelayService: &mockRepoGatewayRelayService{authorizeFn: func(_ context.Context, gatewayID, token string) (services.RepoGatewayRelayTarget, error) {
			assert.Equal(t, "gateway-1", gatewayID)
			assert.Equal(t, "relay-token", token)
			return services.RepoGatewayRelayTarget{Domain: "gw-vm.preview.jjhub.tech"}, nil
		}},
	}
	router := chi.NewRouter()
	router.Handle("/api/gateways/{gatewayID}/*", http.HandlerFunc(h.Relay))
	req := httptest.NewRequest(http.MethodPost, "/api/gateways/gateway-1/v1/rpc/listWorkflows", nil)
	req.Header.Set("Authorization", "Bearer relay-token")
	req.Header.Set("Cookie", "smithers_session=session-secret")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	require.Equal(t, http.StatusOK, rec.Code)
	assert.JSONEq(t, `{"ok":true}`, rec.Body.String())
}

// Every gateway is a box's coding host (#2194): a request that names no box
// reaches the service, which refuses it before touching any store or VM.
func TestRepoGatewayHandler_BoxlessRequestRefused(t *testing.T) {
	for _, body := range []string{`{}`, ``} {
		t.Run(body, func(t *testing.T) {
			h := &RepoGatewayHandler{Service: services.NewRepoGatewayService(nil)}
			req := withAuth(withWorkspaceRepoCtx(httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/gateway", strings.NewReader(body)), "alice", "demo"), 1, "alice")
			rec := httptest.NewRecorder()
			h.PostRepoGateway(rec, req)
			require.Equal(t, http.StatusBadRequest, rec.Code)
			assert.Contains(t, rec.Body.String(), "workspace_id is required")
		})
	}
}

func TestRepoGatewayHandler_WorkspaceBinding(t *testing.T) {
	h := &RepoGatewayHandler{Service: &mockRepoGatewayRouteService{getConnectionInfoFn: func(_ context.Context, input services.RepoGatewayConnectionInput) (services.RepoGatewayConnectionInfo, error) {
		require.Equal(t, "ca5f0c31-7736-4a6d-b275-b62c8f5d7fe2", input.WorkspaceID)
		return services.RepoGatewayConnectionInfo{GatewayID: "gateway", WorkspaceID: input.WorkspaceID}, nil
	}}}
	req := withAuth(withWorkspaceRepoCtx(httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/gateway", strings.NewReader(`{"workspace_id":"ca5f0c31-7736-4a6d-b275-b62c8f5d7fe2"}`)), "alice", "demo"), 1, "alice")
	rec := httptest.NewRecorder()
	h.PostRepoGateway(rec, req)
	require.Equal(t, http.StatusOK, rec.Code)
	for _, body := range []string{`{"workspace_id":12}`, `{"workspace_id":"x","actor_id":2}`, `{} {}`, `{"workspace_id":`} {
		h := &RepoGatewayHandler{Service: &mockRepoGatewayRouteService{getConnectionInfoFn: func(context.Context, services.RepoGatewayConnectionInput) (services.RepoGatewayConnectionInfo, error) {
			t.Fatal("invalid body reached service")
			return services.RepoGatewayConnectionInfo{}, nil
		}}}
		req := withAuth(withWorkspaceRepoCtx(httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/gateway", strings.NewReader(body)), "alice", "demo"), 1, "alice")
		rec := httptest.NewRecorder()
		h.PostRepoGateway(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code, body)
	}
}
