package compose

import (
	"context"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/cors"

	"github.com/smithersai/smithers/packages/backend/internal/chat"
	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/modelhost"
)

// Chat streams a durable journal until the model leg terminates, so these
// routes deliberately live outside the ordinary API's 30-second JSON timeout.
func mountChatPublic(router chi.Router, runtime *chat.Runtime, queries *db.Queries, cfg *config.Config) {
	if runtime == nil {
		return
	}
	// Use the same bus as AuthLoader for the entire live delivery lifetime.
	runtime.Handler.Revocations, _ = revocationChecker.(chat.RevocationSource)
	router.Group(func(r chi.Router) {
		r.Use(cors.Handler(apiCORSOptions(cfg)))
		r.Use(middleware.JSONAllowContentType("application/json"))
		r.Use(middleware.MaxBodySize(middleware.MaxRequestBodySize))
		r.Use(authLoader(queries, cfg.Auth))
		if config.IsSingleOwner(cfg.Auth) {
			r.Use(middleware.RejectTenantProvisioning)
		}
		r.Use(apiCSRFMiddleware)
		r.Use(middleware.GlobalAPIRateLimit(queries))
		r.Use(middleware.RequireAuth, middleware.RequireScope(middleware.ScopeWriteUser))
		runtime.MountAuthenticated(r)
	})
	// The deletion proof is a capability: this route must survive sign-out.
	router.Group(func(r chi.Router) {
		r.Use(cors.Handler(apiCORSOptions(cfg)))
		r.Use(middleware.JSONAllowContentType("application/json"))
		r.Use(middleware.MaxBodySize(middleware.MaxRequestBodySize))
		r.Use(apiCSRFMiddleware)
		r.Use(middleware.GlobalAPIRateLimit(queries))
		allowed := apiAllowedOrigins(cfg)
		r.Use(func(next http.Handler) http.Handler {
			return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
				if origin := req.Header.Get("Origin"); origin != "" {
					trusted := false
					for _, candidate := range allowed {
						trusted = trusted || strings.EqualFold(origin, candidate)
					}
					if !trusted {
						http.Error(w, "forbidden", http.StatusForbidden)
						return
					}
				}
				next.ServeHTTP(w, req)
			})
		})
		runtime.MountErasure(r)
	})
}

func mountModelPublic(router chi.Router, models modelhost.OwnerModels, queries *db.Queries, cfg *config.Config) {
	router.Group(func(r chi.Router) {
		r.Use(cors.Handler(apiCORSOptions(cfg)))
		r.Use(middleware.JSONAllowContentType("application/json"))
		r.Use(middleware.MaxBodySize(middleware.MaxRequestBodySize))
		r.Use(authLoader(queries, cfg.Auth))
		if config.IsSingleOwner(cfg.Auth) {
			r.Use(middleware.RejectTenantProvisioning)
		}
		r.Use(apiCSRFMiddleware)
		r.Use(middleware.GlobalAPIRateLimit(queries))
		r.Use(middleware.RequireAuth, middleware.RequireScope(middleware.ScopeWriteUser))
		if config.IsSingleOwner(cfg.Auth) {
			r.Use(installModelOwner(queries))
		}
		r.Get("/api/model/catalog", models.Catalog)
		r.Post("/api/model/credential", models.Credential)
		r.Get("/api/model/credential/receipt", models.CredentialReceipt)
		r.Get("/api/model/default", models.Default)
		r.Put("/api/model/default", models.SetDefault)
		r.Post("/api/model/test", models.Test)
	})
}

func chatCallbackHandler(runtime *chat.Runtime) http.Handler {
	router := chi.NewRouter()
	runtime.MountProducerCallbacks(router)
	return router
}

// Hosted API replicas can receive capability-authenticated producer callbacks
// on their existing HTTPS listener. This lets isolated guests reach the journal
// through the deployment's public API address without a second exposed port.
func mountChatProducerOnSharedListener(router chi.Router, composition *chatComposition) {
	if composition != nil && composition.listener == nil {
		composition.runtime.MountProducerCallbacks(router)
	}
}

// Install model access belongs to the installer, including during provisional
// setup. Hosted composition retains its deployment-specific model policy.
func installModelOwner(owners interface {
	GetSelfHostOwner(context.Context) (db.User, error)
}) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			owner, err := owners.GetSelfHostOwner(r.Context())
			if err != nil {
				routes.WriteInstallSetupError(w, r, pkgerrors.Forbidden("install owner session required"))
				return
			}
			info := middleware.AuthInfoFromContext(r.Context())
			if info == nil || info.User == nil || info.User.ID != owner.ID || info.IsTokenAuth || info.IsAgent() || info.SessionHash == "" {
				routes.WriteInstallSetupError(w, r, pkgerrors.Forbidden("install owner session required"))
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}
