package middleware

import (
	"context"
	"net/http"

	"github.com/prometheus/client_golang/prometheus"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/identity"
	"github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// SSETicketPrincipal describes the identity and authority granted by a
// validated SSE ticket. Tickets minted by fine-grained tokens carry the
// minting token's scopes so ticket auth cannot escalate past them.
type SSETicketPrincipal struct {
	User        *db.User
	IsTokenAuth bool
	RawScopes   string
	TokenHash   string
	// SessionHash is the SHA-256 of the minting browser session key.
	SessionHash string
}

// SSETicketValidator is the interface for validating SSE tickets.
type SSETicketValidator interface {
	ValidateTicket(ctx context.Context, rawTicket string) (*SSETicketPrincipal, error)
}

// SSETicketMetrics holds Prometheus metrics for SSE ticket operations.
type SSETicketMetrics struct {
	TicketsValidated *prometheus.CounterVec
}

// SSETicketAuth returns middleware that checks for a ?ticket= query parameter
// and validates it as a short-lived SSE authentication ticket.
//
// If no ticket parameter is present, the request continues to the next handler
// unchanged (allowing AuthLoader to handle cookie/token auth as usual).
//
// If a ticket is present and valid, the user is injected into the request context.
// If a ticket is present but invalid, a 401 Unauthorized response is returned.
func SSETicketAuth(validator SSETicketValidator, metrics *SSETicketMetrics, boundaries ...identity.MemberAuthorizer) func(http.Handler) http.Handler {
	var ownerBoundary identity.MemberAuthorizer
	if len(boundaries) > 0 {
		ownerBoundary = boundaries[0]
	}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ticket := r.URL.Query().Get("ticket")
			if ticket == "" {
				next.ServeHTTP(w, r)
				return
			}

			principal, err := validator.ValidateTicket(r.Context(), ticket)
			if err != nil {
				if metrics != nil && metrics.TicketsValidated != nil {
					var label string
					apiErr, ok := err.(*errors.APIError)
					if ok && apiErr.Status == http.StatusForbidden {
						label = "suspended"
					} else {
						label = "invalid"
					}
					metrics.TicketsValidated.WithLabelValues(label).Inc()
				}
				errors.WriteError(w, errors.Unauthorized("invalid or expired SSE ticket"))
				return
			}
			if principal == nil || principal.User == nil {
				if metrics != nil && metrics.TicketsValidated != nil {
					metrics.TicketsValidated.WithLabelValues("invalid").Inc()
				}
				errors.WriteError(w, errors.Unauthorized("invalid or expired SSE ticket"))
				return
			}
			if ownerBoundary != nil {
				if err := ownerBoundary.AuthorizeMember(r.Context(), principal.User.ID); err != nil {
					if metrics != nil && metrics.TicketsValidated != nil {
						metrics.TicketsValidated.WithLabelValues("wrong_owner").Inc()
					}
					errors.WriteError(w, err)
					return
				}
			}

			if metrics != nil && metrics.TicketsValidated != nil {
				metrics.TicketsValidated.WithLabelValues("success").Inc()
			}

			// Inject the ticket's principal into the request context. Tickets
			// minted by session auth behave like session auth (no scope
			// restrictions); tickets minted by fine-grained tokens keep the
			// minting token's scopes so RequireScope still applies.
			authInfo := &AuthInfo{
				User:        principal.User,
				IsTokenAuth: principal.IsTokenAuth,
				TokenHash:   principal.TokenHash,
				SessionHash: principal.SessionHash,
				RawScopes:   principal.RawScopes,
				Scopes:      ScopeSet{},
			}
			if principal.IsTokenAuth {
				authInfo.Scopes = ParseTokenScopes(principal.RawScopes)
			}
			ctx := ContextWithAuthInfo(r.Context(), authInfo)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}
