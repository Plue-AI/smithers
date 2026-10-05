package routes

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

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
