package middleware

import (
	"net/http"
	"strings"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// RejectTenantProvisioning removes organization/team and hosted tenant-admin
// surfaces from a single-owner installation. This guard is intentionally at
// the shared HTTP boundary so adding a new handler cannot accidentally expose
// tenant provisioning in self-host mode.
//
// GET /api/user/orgs is not provisioning: it lists the caller's own
// memberships, and the same app build asks it on every backend to classify
// repository owners. A single owner belongs to no organization, so the
// handler answers the empty list here exactly as the hosted backend does for
// a user with none, instead of a 404 the app has to read as "no orgs".
func RejectTenantProvisioning(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := strings.TrimSuffix(r.URL.Path, "/")
		if path == "/api/orgs" || strings.HasPrefix(path, "/api/orgs/") ||
			path == "/api/admin/orgs" || strings.HasPrefix(path, "/api/admin/orgs/") ||
			path == "/api/admin/users" || strings.HasPrefix(path, "/api/admin/users/") {
			pkgerrors.WriteError(w, pkgerrors.NotFound("tenant routes are not available in single-owner mode"))
			return
		}
		next.ServeHTTP(w, r)
	})
}
