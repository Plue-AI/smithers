package middleware

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

func TestRefuseRunCredentials(t *testing.T) {
	t.Parallel()
	handler := RefuseRunCredentials(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) }))
	serve := func(info *AuthInfo) int {
		req := httptest.NewRequest(http.MethodPost, "/api/repos/acme/app/invoke", nil)
		if info != nil {
			req = req.WithContext(ContextWithAuthInfo(req.Context(), info))
		}
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		return rec.Code
	}
	assert.Equal(t, http.StatusForbidden, serve(&AuthInfo{User: &db.User{ID: 1}, IsTokenAuth: true, TokenSystemIssued: true}))
	assert.Equal(t, http.StatusNoContent, serve(&AuthInfo{User: &db.User{ID: 1}, IsTokenAuth: true}))
	assert.Equal(t, http.StatusNoContent, serve(&AuthInfo{User: &db.User{ID: 1}}))
	assert.Equal(t, http.StatusNoContent, serve(nil), "anonymous callers fall through to RequireAuth")
}
