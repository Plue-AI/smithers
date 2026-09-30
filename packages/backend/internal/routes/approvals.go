// Package routes — approvals HTTP handler (ticket 0110).
//
// Exposes:
//
//	POST /api/repos/{owner}/{repo}/approvals/{id}/decide
//	  body: {"decision":"approved" | "rejected"}
//
// The handler is a thin adapter over services.ApprovalsService.Decide; the
// service owns all idempotency / conflict / expiry logic (keeps the matrix
// testable in one place).
//
// Feature-gate: when config.FeatureFlagsConfig.ApprovalsFlowEnabled is
// false, the handler returns 404. This lets infra flip the flag without
// shipping a separate route-registration gate, and keeps the surface
// area minimal for clients that haven't opted in.
package routes

import (
	"context"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// ApprovalRouteService is the service surface the handler needs. Narrow
// interface so tests can stub with a minimal mock.
type ApprovalRouteService interface {
	ListForRepo(ctx context.Context, repositoryID int64, state string, page, perPage int) ([]services.ApprovalResponse, error)
	GetForRepo(ctx context.Context, approvalID string, repoID int64) (services.ApprovalResponse, error)
	Decide(ctx context.Context, input services.DecideApprovalInput) (services.ApprovalResponse, error)
}

// ApprovalsHandler handles the public repo-scoped approvals API.
type ApprovalsHandler struct {
	Service ApprovalRouteService
	// Enabled mirrors config.FeatureFlagsConfig.ApprovalsFlowEnabled. When
	// false, every handler returns 404 and does NOT call into the service
	// layer. This is the flag gate the rollout plan (ticket 0101) and
	// ticket 0110's acceptance criteria rely on.
	Enabled bool
}

type decideApprovalRequest struct {
	Decision string `json:"decision"`
}

// ListApprovals handles GET /api/repos/{owner}/{repo}/approvals.
func (h *ApprovalsHandler) ListApprovals(w http.ResponseWriter, r *http.Request) {
	if h == nil || !h.Enabled {
		pkgerrors.WriteError(w, pkgerrors.NotFound("approvals flow disabled"))
		return
	}
	if h.Service == nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("approvals service unavailable"))
		return
	}

	repoCtx := middleware.RepoContextFromContext(r.Context())
	if repoCtx == nil || repoCtx.Repository == nil {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("repository context required"))
		return
	}

	cursor, limit, err := parseOffsetPagination(r)
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}

	state := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("state")))
	page := cursorToPage(cursor, limit)
	resp, svcErr := h.Service.ListForRepo(r.Context(), repoCtx.Repository.ID, state, page, limit)
	if svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}

	pkgerrors.WriteJSON(w, http.StatusOK, resp)
}

// GetApproval handles GET /api/repos/{owner}/{repo}/approvals/{id}.
func (h *ApprovalsHandler) GetApproval(w http.ResponseWriter, r *http.Request) {
	if h == nil || !h.Enabled {
		pkgerrors.WriteError(w, pkgerrors.NotFound("approvals flow disabled"))
		return
	}
	if h.Service == nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("approvals service unavailable"))
		return
	}

	repoCtx := middleware.RepoContextFromContext(r.Context())
	if repoCtx == nil || repoCtx.Repository == nil {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("repository context required"))
		return
	}

	approvalID := chi.URLParam(r, "id")
	if approvalID == "" {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("approval id required"))
		return
	}

	resp, svcErr := h.Service.GetForRepo(r.Context(), approvalID, repoCtx.Repository.ID)
	if svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}

	pkgerrors.WriteJSON(w, http.StatusOK, resp)
}

// Decide handles POST /api/repos/{owner}/{repo}/approvals/{id}/decide.
func (h *ApprovalsHandler) Decide(w http.ResponseWriter, r *http.Request) {
	if h == nil || !h.Enabled {
		pkgerrors.WriteError(w, pkgerrors.NotFound("approvals flow disabled"))
		return
	}
	if h.Service == nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("approvals service unavailable"))
		return
	}

	user, err := requireRouteUser(r)
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}

	repoCtx := middleware.RepoContextFromContext(r.Context())
	if repoCtx == nil || repoCtx.Repository == nil {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("repository context required"))
		return
	}

	approvalID := chi.URLParam(r, "id")
	if approvalID == "" {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("approval id required"))
		return
	}

	var req decideApprovalRequest
	// Small fixed-size body; prevent payload abuse.
	r.Body = http.MaxBytesReader(w, r.Body, 1<<10)
	if err := decodeJSONBodyError(w, r, &req); err != nil {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("invalid JSON body"))
		return
	}

	// Defensive normalization; the service does its own validation.
	if req.Decision != services.ApprovalStateApproved && req.Decision != services.ApprovalStateRejected {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("decision must be 'approved' or 'rejected'"))
		return
	}

	resp, svcErr := h.Service.Decide(r.Context(), services.DecideApprovalInput{
		ApprovalID:   approvalID,
		RepositoryID: repoCtx.Repository.ID,
		UserID:       user.ID,
		// Ticket 0134: pass actor context through so the audit row the
		// service writes shows a human-readable username and source IP.
		ActorName: user.Username,
		IPAddress: r.RemoteAddr,
		Decision:  req.Decision,
	})
	if svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}

	pkgerrors.WriteJSON(w, http.StatusOK, resp)
}

// DecideApproval is kept for older route harnesses that still call this name.
func (h *ApprovalsHandler) DecideApproval(w http.ResponseWriter, r *http.Request) {
	h.Decide(w, r)
}
