package compose

import (
	"encoding/json"
	stdErrors "errors"
	"net/http"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// memberCommands authorizes a roster member's request by the command its
// route runs (middleware.InstallMemberCommand) through the install's one
// authorizer, services.Authorize: the member boundary admitted the person to
// the route, and this checks their role now and that a browser session, not
// a token, made the request. The owner's requests pass unchanged; handlers
// that need the decision authorize their command again.
func memberCommands(queries *db.Queries) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			info := middleware.AuthInfoFromContext(r.Context())
			command := middleware.InstallMemberCommand(r.Method, r.URL.Path)
			if info == nil || info.User == nil || command == "" || command == "self" {
				next.ServeHTTP(w, r)
				return
			}
			role, err := services.InstallRoleOf(r.Context(), queries, info.User.ID)
			if err == nil && role == services.InstallOwner {
				next.ServeHTTP(w, r)
				return
			}
			if err == nil {
				_, err = services.Authorize(r.Context(), queries, command)
			}
			if err != nil {
				var access *services.AccessError
				if !stdErrors.As(err, &access) {
					pkgerrors.WriteError(w, pkgerrors.Internal("failed to authorize member").WithCause(err))
					return
				}
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(access.Status)
				_ = json.NewEncoder(w).Encode(access)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}
