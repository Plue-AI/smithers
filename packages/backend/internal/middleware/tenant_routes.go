package middleware

import (
	"net/http"
	"strings"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// RejectTenantProvisioning keeps hosted tenant administration out of a team install.
// The install roster is independent of hosted organizations. GET /api/user/orgs
// remains available for repository-owner classification.
func RejectTenantProvisioning(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := strings.TrimSuffix(r.URL.Path, "/")
		// Account erasure is also an install operation; hosted user creation
		// and administration remain absent. Its route enforces an owner browser
		// session before reaching the erasure service.
		parts := strings.Split(strings.Trim(path, "/"), "/")
		if r.Method == http.MethodPost && len(parts) == 5 && parts[0] == "api" && parts[1] == "admin" && parts[2] == "users" && parts[3] != "" && parts[4] == "erase" {
			next.ServeHTTP(w, r)
			return
		}
		if path == "/api/orgs" || strings.HasPrefix(path, "/api/orgs/") ||
			path == "/api/admin/orgs" || strings.HasPrefix(path, "/api/admin/orgs/") ||
			path == "/api/admin/users" || strings.HasPrefix(path, "/api/admin/users/") {
			pkgerrors.WriteError(w, pkgerrors.NotFound("tenant routes are not available on this install"))
			return
		}
		next.ServeHTTP(w, r)
	})
}

// RejectDeferredRepositoryRoutes keeps trigger management and cloud session
// audit doors absent before credential lookup: an absent
// install route is a 404 for every caller, including workers and anonymous users.
func RejectDeferredRepositoryRoutes(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
		repoJobs := len(parts) >= 5 && parts[0] == "api" && parts[1] == "repos" && parts[4] == "repository-jobs"
		gatewayJobs := len(parts) >= 5 && parts[0] == "api" && parts[1] == "gateways" && parts[3] == "repository-jobs" &&
			(len(parts) == 5 || (len(parts) >= 6 && (parts[5] == "manual" || parts[5] == "trials" || parts[5] == "check-receipts")))
		cloudSessionAudit := len(parts) == 7 && parts[0] == "api" && parts[1] == "repos" && parts[4] == "agent-sessions" && parts[6] == "egress"
		if repoJobs || gatewayJobs || cloudSessionAudit {
			pkgerrors.WriteError(w, pkgerrors.NotFound("not found"))
			return
		}
		// T-ACC-03 must bind system grants and live install membership before
		// retained callbacks can run. The install has no such provider yet.
		if len(parts) >= 5 && parts[0] == "api" && parts[1] == "gateways" && parts[3] == "repository-jobs" {
			pkgerrors.WriteError(w, pkgerrors.Forbidden("system authority is unavailable"))
			return
		}
		next.ServeHTTP(w, r)
	})
}

// RejectDeferredCommerce preserves the install's absent billing routes before auth.
func RejectDeferredCommerce(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := strings.TrimSuffix(r.URL.Path, "/")
		if path == "/api/billing" || strings.HasPrefix(path, "/api/billing/") {
			pkgerrors.WriteError(w, pkgerrors.NotFound("not found"))
			return
		}
		next.ServeHTTP(w, r)
	})
}

// RejectLocalAuth keeps the removed password door absent before credential
// lookup, including when the browser holds a provisional owner session.
func RejectLocalAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := strings.TrimSuffix(r.URL.Path, "/")
		if path == "/api/auth/local" || strings.HasPrefix(path, "/api/auth/local/") {
			pkgerrors.WriteError(w, pkgerrors.NotFound("not found"))
			return
		}
		next.ServeHTTP(w, r)
	})
}
