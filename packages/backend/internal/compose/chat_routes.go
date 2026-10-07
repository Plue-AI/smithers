package compose

import (
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/cors"

	"github.com/smithersai/smithers/packages/backend/internal/chat"
	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
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
		if config.IsSingleOwner(cfg.Auth) {
			r.Use(memberCommands(queries))
		}
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

func mountModelPublic(router chi.Router, models modelhost.OwnerModels, queries *db.Queries, cfg *config.Config, sources ...workspaceapi.SourceFiles) {
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
		r.Use(middleware.RequireAuth)
		if config.IsSingleOwner(cfg.Auth) {
			r.Use(memberCommands(queries))
		}
		r.Get("/api/model/catalog", models.Catalog)
		r.Get("/api/model/credential/receipt", models.CredentialReceipt)
		r.Get("/api/model/default", models.Default)
		if config.IsSingleOwner(cfg.Auth) {
			r.Get("/api/agents", serveAgents(queries, sources...))
			r.Get("/api/agents/{name}", serveAgents(queries, sources...))
		}
		r.Group(func(writes chi.Router) {
			writes.Use(middleware.RequireScope(middleware.ScopeWriteUser))
			writes.Post("/api/model/credential", models.Credential)
			writes.Put("/api/model/default", models.SetDefault)
			writes.Post("/api/model/test", models.Test)
			writes.Get("/api/model/test/receipt", models.TestReceipt)
			if config.IsSingleOwner(cfg.Auth) {
				writes.Put("/api/agents/{role}/model", assignAgentModel(queries, sources...))
			}
		})
	})
}

func chatCallbackHandler(runtime *chat.Runtime, api ...http.Handler) http.Handler {
	router := chi.NewRouter()
	runtime.MountProducerCallbacks(router)
	if len(api) == 1 && api[0] != nil {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if strings.HasPrefix(r.URL.Path, "/api/") {
				// This listener is private loopback transport, not a public
				// origin. Forward as the fixed install control host, preserving
				// the ordinary API's bearer, membership and policy checks. Never
				// accept caller-selected proxy authority on this internal hop.
				forwarded := r.Clone(r.Context())
				forwarded.Host = "localhost:4000"
				forwarded.Header.Del("X-Forwarded-Host")
				api[0].ServeHTTP(w, forwarded)
				return
			}
			router.ServeHTTP(w, r)
		})
	}
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
