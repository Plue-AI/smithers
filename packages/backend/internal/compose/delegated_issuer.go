package compose

import (
	"encoding/json"
	"net/http"

	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// installCredentialIssuer gates public issuance on the same production
// authorization store and effective-origin provider used by bearer dispatch.
// Membership readiness is checked by AuthService before any provider call/mint.
func installCredentialIssuer(cfg config.AuthConfig, queries *db.Queries, handler *routes.AuthHandler) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if config.IsSingleOwner(cfg) && (queries == nil || handler == nil || handler.InstallSetup == nil || handler.Origins == nil) {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusServiceUnavailable)
				_ = json.NewEncoder(w).Encode(&services.AccessError{Status: 503, Class: "infra", Code: "credential_issuer_unavailable", Message: "Credential issuer unavailable"})
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}
