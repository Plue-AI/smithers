package compose

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// routerProviderConnectionStub answers every provider-connection call so a
// request that passes the gate returns 2xx.
type routerProviderConnectionStub struct{}

func (routerProviderConnectionStub) ConnectForUser(context.Context, *db.User, services.ConnectProviderInput) (services.ProviderConnectionResponse, error) {
	return services.ProviderConnectionResponse{ID: "conn-1"}, nil
}
func (routerProviderConnectionStub) ConnectForOrg(context.Context, *db.User, string, services.ConnectProviderInput) (services.ProviderConnectionResponse, error) {
	return services.ProviderConnectionResponse{ID: "conn-1"}, nil
}
func (routerProviderConnectionStub) ListForUser(context.Context, *db.User) ([]services.ProviderConnectionResponse, error) {
	return nil, nil
}
func (routerProviderConnectionStub) ListForOrg(context.Context, *db.User, string) ([]services.ProviderConnectionResponse, error) {
	return nil, nil
}
func (routerProviderConnectionStub) Get(context.Context, *db.User, string) (services.ProviderConnectionResponse, error) {
	return services.ProviderConnectionResponse{ID: "conn-1"}, nil
}
func (routerProviderConnectionStub) Revoke(context.Context, *db.User, string) error { return nil }
func (routerProviderConnectionStub) RefreshNow(context.Context, *db.User, string) (services.ProviderConnectionResponse, error) {
	return services.ProviderConnectionResponse{ID: "conn-1"}, nil
}
func (routerProviderConnectionStub) AddGrant(context.Context, *db.User, string, services.ProviderConnectionGrantInput) (services.ProviderConnectionGrantResponse, error) {
	return services.ProviderConnectionGrantResponse{ID: 1}, nil
}
func (routerProviderConnectionStub) DeleteGrant(context.Context, *db.User, string, int64) error {
	return nil
}
func (routerProviderConnectionStub) Reorder(context.Context, *db.User, string, []string) error {
	return nil
}
func (routerProviderConnectionStub) StartCodexDeviceLogin(context.Context, *db.User) (services.ProviderDeviceLoginResponse, error) {
	return services.ProviderDeviceLoginResponse{}, nil
}
func (routerProviderConnectionStub) PollCodexDeviceLogin(context.Context, *db.User, string) (services.ProviderDeviceLoginResponse, error) {
	return services.ProviderDeviceLoginResponse{}, nil
}

var subscriptionConnectionRoutes = []struct {
	method, path, body string
}{
	{http.MethodGet, "/api/user/provider-connections", ""},
	{http.MethodPost, "/api/user/provider-connections", `{"provider":"claude","kind":"api_key","access_token":"sk-ant-api03-x"}`},
	{http.MethodPut, "/api/user/provider-connections/order", `{"provider":"claude","ids":["conn-1"]}`},
	{http.MethodPost, "/api/user/provider-connections/codex/device", ""},
	{http.MethodPost, "/api/user/provider-connections/codex/device/dev-1", ""},
	{http.MethodGet, "/api/user/provider-connections/conn-1", ""},
	{http.MethodDelete, "/api/user/provider-connections/conn-1", ""},
	{http.MethodPost, "/api/user/provider-connections/conn-1/refresh", ""},
	{http.MethodPost, "/api/user/provider-connections/conn-1/grants", `{"all_repositories":true}`},
	{http.MethodDelete, "/api/user/provider-connections/conn-1/grants/1", ""},
	{http.MethodGet, "/api/orgs/acme/provider-connections", ""},
	{http.MethodPost, "/api/orgs/acme/provider-connections", `{"provider":"codex","kind":"oauth","access_token":"at"}`},
}

func serveSubscriptionConnectionRoute(t *testing.T, flags config.FeatureFlagsConfig, method, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	cfg := testConfigAllFlagsOn()
	cfg.FeatureFlags.SubscriptionConnections = flags.SubscriptionConnections
	router := buildRouterCompat(cfg, nil, nil,
		&routes.RepoHandler{}, &routes.AuthHandler{}, &routes.UserHandler{}, &routes.SSHKeyHandler{}, &routes.LabelHandler{},
		&routes.OrgHandler{}, &routes.LandingHandler{}, &routes.SearchHandler{Service: &mockRouterSearchService{}}, &routes.IssueHandler{},
		nil, &routes.GitSmartHandler{Service: &mockRouterGitService{}},
		nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil,
		&routes.ProviderConnectionHandler{Service: routerProviderConnectionStub{}, Pool: &routes.ProviderPoolHandler{}},
	)
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	req = withRouterTokenAuth(req, middleware.ScopeReadUser, middleware.ScopeWriteUser)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	return rec
}

// The hosted product never stores a user's Claude or ChatGPT subscription
// login: with the flag off every connection route, user and organization,
// answers the feature gate's 403 before any handler runs.
func TestServerRouter_SubscriptionConnectionsGatedOffByDefault(t *testing.T) {
	t.Parallel()
	for _, tc := range subscriptionConnectionRoutes {
		tc := tc
		t.Run(tc.method+" "+tc.path, func(t *testing.T) {
			t.Parallel()
			rec := serveSubscriptionConnectionRoute(t, config.FeatureFlagsConfig{}, tc.method, tc.path, tc.body)
			require.Equal(t, http.StatusForbidden, rec.Code, rec.Body.String())
			assert.Contains(t, rec.Body.String(), "feature not available")
		})
	}
}

// A self-hosted deployment that opts in reaches the handlers.
func TestServerRouter_SubscriptionConnectionsReachableWhenEnabled(t *testing.T) {
	t.Parallel()
	for _, tc := range subscriptionConnectionRoutes {
		tc := tc
		t.Run(tc.method+" "+tc.path, func(t *testing.T) {
			t.Parallel()
			rec := serveSubscriptionConnectionRoute(t, config.FeatureFlagsConfig{SubscriptionConnections: true}, tc.method, tc.path, tc.body)
			assert.Less(t, rec.Code, 300, rec.Body.String())
		})
	}
}

// The account pool serves workspaces' model calls from stored subscriptions,
// so the same gate closes it.
func TestServerRouter_ProviderPoolGatedOffByDefault(t *testing.T) {
	t.Parallel()
	rec := serveSubscriptionConnectionRoute(t, config.FeatureFlagsConfig{}, http.MethodPost, services.ProviderPoolPath+"/chatgpt/codex/responses", `{}`)
	require.Equal(t, http.StatusForbidden, rec.Code, rec.Body.String())
	assert.Contains(t, rec.Body.String(), "feature not available")
}
