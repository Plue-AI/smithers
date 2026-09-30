package routes

import (
	"net/http"
	"strings"

	"github.com/smithersai/smithers/packages/backend/flowhost"
	"github.com/smithersai/smithers/packages/backend/internal/chat/turncredential"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/modelproxy"
)

// ModelProxyAuth authenticates the metered model proxy. An Anthropic SDK's
// x-api-key is read as the bearer. A managed Flow host's or a chat turn's
// model credential is verified by the proxy's caller resolver, a per-run
// agent token by
// agentAuth, and anything else must be a user token (userAuth). A cookie
// never spends credit.
func ModelProxyAuth(agentAuth, userAuth func(http.Handler) http.Handler) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		agent, user := agentAuth(next), userAuth(next)
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if strings.TrimSpace(r.Header.Get("Authorization")) == "" {
				if key := strings.TrimSpace(r.Header.Get("X-Api-Key")); key != "" {
					r.Header.Set("Authorization", "Bearer "+key)
				}
			}
			r.Header.Del("X-Api-Key")
			r.Header.Del("Cookie")
			scheme, token, _ := strings.Cut(strings.TrimSpace(r.Header.Get("Authorization")), " ")
			token = strings.TrimSpace(token)
			switch {
			case !strings.EqualFold(scheme, "bearer") || token == "":
				modelproxy.WriteError(w, "", http.StatusUnauthorized, "authentication_error", "Authentication required.")
			case strings.HasPrefix(token, flowhost.ModelCredentialPrefix), strings.HasPrefix(token, turncredential.Prefix):
				next.ServeHTTP(w, r)
			case middleware.IsAgentCredentialSyntax(token):
				agent.ServeHTTP(w, r)
			default:
				user.ServeHTTP(w, r)
			}
		})
	}
}
