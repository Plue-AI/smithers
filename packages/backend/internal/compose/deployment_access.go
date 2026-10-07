package compose

import (
	"net/http"
	"os"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/cors"
	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/operations"
)

func deploymentAccess(q *db.Queries, cfg *config.Config) operations.Access {
	admin := func(scope middleware.TokenScope) func(http.Handler) http.Handler {
		return func(next http.Handler) http.Handler {
			chain := chi.Chain(
				cors.Handler(apiCORSOptions(cfg)), middleware.JSONRecoverer,
				middleware.JSONTimeout(apiJSONTimeout),
				middleware.JSONAllowContentType("application/json"),
				middleware.MaxBodySize(middleware.MaxRequestBodySize),
				authLoader(q, cfg.Auth), apiCSRFMiddleware,
				middleware.GlobalAPIRateLimit(q), middleware.RequireAdmin,
				middleware.RequireScope(scope), middleware.RequirePersonCredential,
			)
			return chain.Handler(next)
		}
	}
	return operations.Access{
		Service: chi.Chain(middleware.JSONRecoverer,
			middleware.JSONTimeout(apiJSONTimeout),
			middleware.JSONAllowContentType("application/json"),
			middleware.MaxBodySize(middleware.MaxRequestBodySize)).Handler,
		AdminRead:   admin(middleware.ScopeReadAdmin),
		AdminWrite:  admin(middleware.ScopeWriteAdmin),
		AgentTask:   middleware.RequireAgentToken(q),
		SharedAgent: middleware.RequireSharedBearerToken(strings.TrimSpace(os.Getenv("SMITHERS_AGENT_TOKEN"))),
	}
}
