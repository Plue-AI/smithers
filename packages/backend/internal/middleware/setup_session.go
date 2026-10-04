package middleware

import (
	"context"
	"net/http"
	"strings"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// SetupSessionBoundary prevents a live setup cookie from reaching person APIs.
// The durable validator also distinguishes expired cookies from claim revocation.
func SetupSessionBoundary(validate func(context.Context, string) error) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			cookie, err := r.Cookie("smithers_setup_session")
			if err != nil || !strings.HasPrefix(r.URL.Path, "/api/") {
				next.ServeHTTP(w, r)
				return
			}
			if err := validate(r.Context(), cookie.Value); err != nil {
				if api, ok := err.(*pkgerrors.APIError); ok {
					pkgerrors.WriteError(w, api)
				} else {
					pkgerrors.WriteError(w, pkgerrors.Internal("setup authority unavailable").WithCause(err))
				}
				return
			}
			if r.URL.Path == "/api/install" || strings.HasPrefix(r.URL.Path, "/api/install/setup/") || strings.HasPrefix(r.URL.Path, "/api/github-app/") || r.URL.Path == "/api/auth/github" || r.URL.Path == "/api/auth/github/callback" {
				next.ServeHTTP(w, r)
				return
			}
			pkgerrors.WriteJSON(w, 403, map[string]string{"code": "permission", "class": "permission", "message": "setup only"})
		})
	}
}
