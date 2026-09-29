package routes

import (
	"context"
	"net/http"
	"strings"

	"github.com/prometheus/client_golang/prometheus"

	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// SSETicketService defines the interface for creating SSE tickets.
type SSETicketService interface {
	CreateTicket(ctx context.Context, userID int64, tokenAuth bool, rawScopes, credentialHash string) (services.SSETicketResult, error)
}

// SSETicketHandler handles the SSE ticket creation endpoint.
type SSETicketHandler struct {
	Service SSETicketService
	Metrics *SSETicketRouteMetrics
}

// SSETicketRouteMetrics holds Prometheus metrics for SSE ticket route operations.
type SSETicketRouteMetrics struct {
	TicketsIssued prometheus.Counter
}

// PostSSETicket handles POST /api/auth/sse-ticket and /api/v1/sse/ticket.
// Creates a short-lived, single-use ticket for SSE authentication.
// The response includes the opaque ticket and its expires_at timestamp.
func (h *SSETicketHandler) PostSSETicket(w http.ResponseWriter, r *http.Request) {
	authInfo := middleware.AuthInfoFromContext(r.Context())
	if authInfo == nil || authInfo.User == nil {
		pkgerrors.WriteError(w, pkgerrors.Unauthorized("authentication required"))
		return
	}

	rawScopes := ""
	credentialHash := authInfo.SessionHash
	if authInfo.IsTokenAuth {
		rawScopes = authInfo.RawScopes
		credentialHash = strings.TrimSpace(authInfo.TokenHash)
	}

	ticket, err := h.Service.CreateTicket(r.Context(), authInfo.User.ID, authInfo.IsTokenAuth, rawScopes, credentialHash)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}

	if h.Metrics != nil && h.Metrics.TicketsIssued != nil {
		h.Metrics.TicketsIssued.Inc()
	}

	pkgerrors.WriteJSON(w, http.StatusOK, ticket)
}
