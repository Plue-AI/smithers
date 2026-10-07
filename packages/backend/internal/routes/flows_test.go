package routes

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

func TestFlowNameParamDecodesOneURLComponent(t *testing.T) {
	for _, tc := range []struct {
		encoded, name string
		raw           bool
	}{
		{"", "", false}, {"canary", "canary", false}, {"checks%2Fcanary", "checks/canary", true},
		{"%6derge", "merge", true}, {"%256derge", "%6derge", true},
		{"%6derge", "%6derge", false}, {"checks/canary", "checks/canary", false},
	} {
		t.Run(tc.encoded, func(t *testing.T) {
			r := httptest.NewRequest("GET", "/api/flows", nil)
			if tc.raw {
				r.URL.RawPath = "/api/flows/" + tc.encoded
			}
			route := chi.NewRouteContext()
			route.URLParams.Add("name", tc.encoded)
			name, err := flowNameParam(r.WithContext(context.WithValue(r.Context(), chi.RouteCtxKey, route)))
			require.NoError(t, err)
			require.Equal(t, tc.name, name)
		})
	}
	for _, encoded := range []string{"%", "%2", "%GG"} {
		t.Run(encoded, func(t *testing.T) {
			r := httptest.NewRequest("GET", "/api/flows", nil)
			r.URL.RawPath = "/api/flows/" + encoded
			route := chi.NewRouteContext()
			route.URLParams.Add("name", encoded)
			_, err := flowNameParam(r.WithContext(context.WithValue(r.Context(), chi.RouteCtxKey, route)))
			var refusal *services.TodoControlError
			require.ErrorAs(t, err, &refusal)
			require.Equal(t, 400, refusal.Status)
			require.Equal(t, "user", refusal.Class)
			require.Equal(t, "invalid_flow_name", refusal.Code)
		})
	}
}

// The flow catalog answers only a person it can authorize, and an
// unavailable handler says so instead of serving an empty catalog.
func TestFlowsListRefusesBeforeServing(t *testing.T) {
	for _, tc := range []struct {
		name    string
		handler *FlowsHandler
		status  int
		body    string
	}{
		{"no handler", nil, http.StatusServiceUnavailable, `{"code":"flows_unavailable","class":"infra","message":"Flows unavailable"}`},
		{"no store", &FlowsHandler{}, http.StatusServiceUnavailable, `{"code":"flows_unavailable","class":"infra","message":"Flows unavailable"}`},
		{"signed out", &FlowsHandler{Queries: db.New(nil)}, http.StatusUnauthorized, `{"class":"permission","code":"unauthenticated","message":"Sign in"}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			w := httptest.NewRecorder()
			tc.handler.List(w, httptest.NewRequest(http.MethodGet, "/api/flows", nil))
			require.Equal(t, tc.status, w.Code)
			require.JSONEq(t, tc.body, w.Body.String())
		})
	}
}
