package routes

import (
	"context"
	"encoding/json"
	"github.com/go-chi/chi/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"net/http"
)

type LearningProposalRoutes interface {
	LearningProposals(context.Context, int64) ([]services.LearningProposalCard, error)
	ResolveLearningProposal(context.Context, int64, int64, string, bool) (services.LearningProposalCard, error)
}
type LearningProposalsHandler struct {
	Queries *db.Queries
	Service LearningProposalRoutes
}

func (h *LearningProposalsHandler) List(w http.ResponseWriter, r *http.Request) {
	if h.Service == nil {
		todoRouteError(w, nil)
		return
	}
	repository, _, ok := authorizeInstallRepository(w, r, h.Queries, "proposals.read")
	if !ok {
		return
	}
	cards, err := h.Service.LearningProposals(r.Context(), repository)
	if err != nil {
		todoRouteError(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(cards)
}
func (h *LearningProposalsHandler) Accept(w http.ResponseWriter, r *http.Request) {
	h.resolve(w, r, true)
}
func (h *LearningProposalsHandler) Dismiss(w http.ResponseWriter, r *http.Request) {
	h.resolve(w, r, false)
}
func (h *LearningProposalsHandler) resolve(w http.ResponseWriter, r *http.Request, accept bool) {
	if h.Service == nil {
		todoRouteError(w, nil)
		return
	}
	command := "learning.dismiss"
	if accept {
		command = "learning.accept"
	}
	repository, user, ok := authorizeInstallRepository(w, r, h.Queries, command)
	if !ok {
		return
	}
	card, err := h.Service.ResolveLearningProposal(r.Context(), repository, user, chi.URLParam(r, "id"), accept)
	if err != nil {
		todoRouteError(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusAccepted)
	_ = json.NewEncoder(w).Encode(card)
}
