package routes

import (
	"context"
	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/require"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type visibilityRouteService struct {
	mockWorkspaceRouteService
	public bool
	calls  int
}

func (s *visibilityRouteService) SetWorkspaceServicePublic(_ context.Context, id string, repo, user int64, port uint16, public bool) error {
	s.calls++
	s.public = public
	return nil
}
func (s *visibilityRouteService) WorkspaceServicePublic(context.Context, string, int64, int64, uint16) (bool, error) {
	return s.public, nil
}
func TestWorkspaceVisibilityRoute(t *testing.T) {
	s := &visibilityRouteService{}
	router := chi.NewRouter()
	RegisterWorkspaceRuntimeRoutes(router, &WorkspaceHandler{Service: s}, nil, nil)
	req := httptest.NewRequest(http.MethodPut, "/workspaces/ws1/services/3000/visibility", strings.NewReader(`{"public":true}`))
	req = withWorkspaceRepoCtx(withAuth(req, 1, "alice"), "alice", "demo")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.True(t, s.public)
	require.Equal(t, 1, s.calls)
	get := httptest.NewRequest(http.MethodGet, "/workspaces/ws1/services/3000/visibility", nil)
	get = withWorkspaceRepoCtx(withAuth(get, 1, "alice"), "alice", "demo")
	got := httptest.NewRecorder()
	router.ServeHTTP(got, get)
	require.Equal(t, http.StatusOK, got.Code)
	require.JSONEq(t, `{"public":true}`, got.Body.String())
	require.Equal(t, "no-store", got.Header().Get("Cache-Control"))
}
func TestWorkspaceVisibilityRejectsMalformedRequests(t *testing.T) {
	for _, tc := range []struct{ port, body string }{{"0", `{"public":true}`}, {"65536", `{"public":true}`}, {"3000", `{}`}, {"3000", `{"public":"yes"}`}, {"3000", `{"public":true,"other":1}`}, {"3000", `{"public":true} {}`}} {
		t.Run(tc.port+tc.body, func(t *testing.T) {
			s := &visibilityRouteService{}
			h := &WorkspaceHandler{Service: s}
			req := httptest.NewRequest(http.MethodPut, "/", strings.NewReader(tc.body))
			req = withWorkspaceRepoCtx(withAuth(req, 1, "alice"), "alice", "demo")
			req = withRouteParams(req, map[string]string{"id": "ws1", "port": tc.port})
			rec := httptest.NewRecorder()
			h.WorkspaceServiceVisibility(rec, req)
			require.Equal(t, http.StatusBadRequest, rec.Code)
			require.Zero(t, s.calls)
		})
	}
}
