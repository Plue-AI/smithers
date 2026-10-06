package routes

import (
	"context"
	"encoding/json"
	"github.com/go-chi/chi/v5"
	"io"
	"net/http"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type InstallReviewRouteService interface {
	RequestReview(context.Context, int64, int64, services.ReviewRequest, string) (services.ReviewAdmission, error)
}

type InstallReviewHandler struct {
	Queries *db.Queries
	Service InstallReviewRouteService
}

func (h *InstallReviewHandler) Request(w http.ResponseWriter, r *http.Request) {
	repo, requester, ok := authorizeInstallRepository(w, r, h.Queries, "review")
	if !ok {
		return
	}
	if h.Service == nil {
		todoRouteError(w, &services.TodoControlError{Status: 503, Class: "infra", Code: "review_unavailable", Message: "Review unavailable"})
		return
	}
	var input services.ReviewRequest
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&input); err != nil {
		todoRouteError(w, &services.TodoControlError{Status: 400, Class: "user", Code: "invalid_review", Message: "Invalid review request"})
		return
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		todoRouteError(w, &services.TodoControlError{Status: 400, Class: "user", Code: "invalid_review", Message: "Invalid review request"})
		return
	}
	receipt, err := h.Service.RequestReview(r.Context(), repo, requester, input, r.Header.Get("Idempotency-Key"))
	if err != nil {
		todoRouteError(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusAccepted)
	_ = json.NewEncoder(w).Encode(receipt)
}

func (h *InstallReviewHandler) Get(w http.ResponseWriter, r *http.Request) {
	repo, requester, ok := authorizeInstallRepository(w, r, h.Queries, "repo.read")
	if !ok {
		return
	}
	reader, ok := h.Service.(interface {
		GetReview(context.Context, int64, int64, string) (services.ReviewStatus, error)
	})
	if !ok {
		todoRouteError(w, &services.TodoControlError{Status: 503, Class: "infra", Code: "review_delivery_unavailable", Message: "Review unavailable"})
		return
	}
	result, err := reader.GetReview(r.Context(), repo, requester, chi.URLParam(r, "id"))
	if err != nil {
		todoRouteError(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(result)
}
