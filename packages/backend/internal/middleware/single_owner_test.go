package middleware

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestRejectTenantProvisioningCoversOrganizationsAndTeams(t *testing.T) {
	next := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) })
	for _, path := range []string{"/api/orgs", "/api/orgs/acme/teams", "/api/admin/orgs", "/api/admin/users"} {
		rec := httptest.NewRecorder()
		RejectTenantProvisioning(next).ServeHTTP(rec, httptest.NewRequest(http.MethodPost, path, nil))
		assert.Equal(t, http.StatusNotFound, rec.Code, path)
	}
}

// The caller's own membership list is a read every backend answers: a single
// owner has none, and the app reads the empty list, not a 404.
func TestRejectTenantProvisioningPassesTheUsersOwnOrgList(t *testing.T) {
	next := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) })
	for _, path := range []string{"/api/user/orgs", "/api/user/orgs/"} {
		rec := httptest.NewRecorder()
		RejectTenantProvisioning(next).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
		assert.Equal(t, http.StatusNoContent, rec.Code, path)
	}
}
