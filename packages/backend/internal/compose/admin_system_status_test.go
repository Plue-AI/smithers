package compose

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type routerStatusStub struct{}

func (routerStatusStub) SystemStatus(context.Context) services.AdminSystemStatus {
	return services.AdminSystemStatus{Status: "ok"}
}

// routerWithExtras builds the router with every handler nil except extras.
func routerWithExtras(extras routerExtras) http.Handler {
	fn := reflect.ValueOf(buildRouter)
	fnType := fn.Type()
	args := make([]reflect.Value, fnType.NumIn())
	for i := range args[:len(args)-1] {
		args[i] = reflect.Zero(fnType.In(i))
	}
	args[0] = reflect.ValueOf(&config.Config{Auth: config.AuthConfig{Mode: config.AuthModeMultitenant}})
	args[len(args)-1] = reflect.ValueOf([]any{extras})
	return fn.CallSlice(args)[0].Interface().(http.Handler)
}

func TestAdminSystemStatusRouteAuthorization(t *testing.T) {
	router := routerWithExtras(routerExtras{AdminSystemStatus: &routes.AdminSystemStatusHandler{Service: routerStatusStub{}}})
	for _, tc := range []struct {
		name   string
		auth   func(*http.Request) *http.Request
		status int
	}{
		{"anonymous", func(r *http.Request) *http.Request { return r }, http.StatusUnauthorized},
		{"non-admin", func(r *http.Request) *http.Request {
			return withRouterAdminTokenAuth(r, false, middleware.TokenSourcePersonalAccessToken, middleware.ScopeReadAdmin)
		}, http.StatusForbidden},
		{"admin without read:admin", func(r *http.Request) *http.Request {
			return withRouterAdminTokenAuth(r, true, middleware.TokenSourcePersonalAccessToken, middleware.ScopeReadRepository)
		}, http.StatusForbidden},
		{"admin with read:admin", func(r *http.Request) *http.Request {
			return withRouterAdminTokenAuth(r, true, middleware.TokenSourcePersonalAccessToken, middleware.ScopeReadAdmin)
		}, http.StatusOK},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req := tc.auth(httptest.NewRequest(http.MethodGet, "/api/admin/system/status", nil))
			rec := httptest.NewRecorder()
			router.ServeHTTP(rec, req)
			require.Equal(t, tc.status, rec.Code, rec.Body.String())
			if tc.status == http.StatusOK {
				var body services.AdminSystemStatus
				require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
				assert.Equal(t, "ok", body.Status)
			}
		})
	}
}

func TestAdminSystemCanariesRouteIsRetired(t *testing.T) {
	router := routerWithExtras(routerExtras{AdminSystemStatus: &routes.AdminSystemStatusHandler{Service: routerStatusStub{}}})
	req := withRouterAdminTokenAuth(httptest.NewRequest(http.MethodGet, "/api/admin/system/canaries", nil), true, middleware.TokenSourcePersonalAccessToken, middleware.ScopeReadAdmin)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	assert.Equal(t, http.StatusNotFound, rec.Code)
}
