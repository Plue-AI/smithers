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

// memberCommands binds one install command decision before the handler runs.
// Owners use the same authorizer as every other member. A handler resolving
// the same command reuses the decision; a different command is checked anew.
func memberCommands(queries *db.Queries) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			info := middleware.AuthInfoFromContext(r.Context())
			command := middleware.InstallMemberCommand(r.Method, r.URL.Path)
			if info == nil || info.User == nil || command == "" || command == "self" {
				next.ServeHTTP(w, r)
				return
			}
			decision, err := services.Authorize(r.Context(), queries, command)
			if err != nil {
				var access *services.AccessError
				if !stdErrors.As(err, &access) {
					pkgerrors.WriteError(w, pkgerrors.Internal("failed to authorize member").WithCause(err))
					return
				}
				// The restricted S1 profile can request append confirmation
				// only. Before never reaches a confirmation consumer.
				if _, terminal := info.TerminalDelegation(); terminal && command == "todo.new" && access.Code == "confirm_in_app" {
					var input struct {
						Place struct {
							Mode string `json:"mode"`
						} `json:"place"`
					}
					if json.NewDecoder(http.MaxBytesReader(w, r.Body, 256<<10)).Decode(&input) == nil && input.Place.Mode == "before" {
						access = &services.AccessError{Status: 403, Class: "permission", Code: "permission", Message: "A terminal's credential cannot do this"}
					}
				}
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(access.Status)
				_ = json.NewEncoder(w).Encode(access)
				return
			}
			next.ServeHTTP(w, r.WithContext(services.WithInstallAuthorization(r.Context(), command, decision)))
		})
	}
}
