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
