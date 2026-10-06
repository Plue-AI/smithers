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

func TestRejectDeferredBoundariesBeforeEffects(t *testing.T) {
	for _, test := range []struct {
		name             string
		gate             func(http.Handler) http.Handler
		absent, retained []string
	}{
		{"triggers", RejectDeferredTriggerManagement,
			[]string{"/api/repos/will/app/repository-jobs", "/api/repos/will/app/repository-jobs/ci/resume", "/api/gateways/host/repository-jobs/ci", "/api/gateways/host/repository-jobs/ci/manual/request", "/api/gateways/host/repository-jobs/ci/trials/request", "/api/gateways/host/repository-jobs/ci/check-receipts/request"},
			[]string{"/api/repos/will/app/repository-source", "/healthz"}},
		{"commerce", RejectDeferredCommerce, []string{"/api/billing", "/api/billing/", "/api/billing/webhook", "/api/billing/plans"}, []string{"/api/billing-other", "/api/install", "/healthz"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			effects := 0
			handler := test.gate(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { effects++; w.WriteHeader(http.StatusNoContent) }))
			for _, path := range test.absent {
				rec := httptest.NewRecorder()
				handler.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, path, nil))
				assert.Equal(t, http.StatusNotFound, rec.Code, path)
			}
			assert.Zero(t, effects)
			for _, path := range test.retained {
				rec := httptest.NewRecorder()
				handler.ServeHTTP(rec, httptest.NewRequest(http.MethodPut, path, nil))
				assert.Equal(t, http.StatusNoContent, rec.Code, path)
			}
			assert.Equal(t, len(test.retained), effects)
		})
	}
}

func TestRejectUnboundRepositoryJobCallbacks(t *testing.T) {
	effects := 0
	handler := RejectDeferredTriggerManagement(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { effects++ }))
	for _, path := range []string{
		"/api/gateways/host/repository-jobs/ci/comments/step",
	} {
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, httptest.NewRequest(http.MethodPut, path, nil))
		assert.Equal(t, http.StatusForbidden, rec.Code, path)
	}
	assert.Zero(t, effects)
}

func TestRejectTenantProvisioningAllowsOnlyAccountErasure(t *testing.T) {
	for _, tc := range []struct {
		method, path string
		want         int
	}{
		{http.MethodPost, "/api/admin/users/ben/erase", http.StatusNoContent},
		{http.MethodGet, "/api/admin/users/ben/erase", http.StatusNotFound},
		{http.MethodPost, "/api/admin/users/ben/export", http.StatusNotFound},
		{http.MethodPost, "/api/admin/users/ben/erase/extra", http.StatusNotFound},
		{http.MethodPost, "/api/admin/users/erase", http.StatusNotFound},
	} {
		t.Run(tc.method+tc.path, func(t *testing.T) {
			next := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) })
			rec := httptest.NewRecorder()
			RejectTenantProvisioning(next).ServeHTTP(rec, httptest.NewRequest(tc.method, tc.path, nil))
			assert.Equal(t, tc.want, rec.Code)
		})
	}
}

func TestRejectLocalAuthBeforeCredentialLookup(t *testing.T) {
	next := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) })
	for _, method := range []string{http.MethodGet, http.MethodPost, http.MethodPut, http.MethodDelete} {
		for _, path := range []string{"/api/auth/local", "/api/auth/local/", "/api/auth/local/status", "/api/auth/local/bootstrap", "/api/auth/local/login", "/api/auth/local/token", "/api/auth/local/password"} {
			rec := httptest.NewRecorder()
			RejectLocalAuth(next).ServeHTTP(rec, httptest.NewRequest(method, path, nil))
			assert.Equal(t, http.StatusNotFound, rec.Code, "%s %s", method, path)
		}
	}
	for _, path := range []string{"/api/auth/github", "/api/auth/locality", "/api/user"} {
		rec := httptest.NewRecorder()
		RejectLocalAuth(next).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
		assert.Equal(t, http.StatusNoContent, rec.Code, path)
	}
}
