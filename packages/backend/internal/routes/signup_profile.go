package routes

import (
	"context"
	"net/http"

	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// UserSignupProfileService reads and replaces the session user's signup
// profile (services/signup_profile.go).
type UserSignupProfileService interface {
	Get(ctx context.Context, userID int64) (services.SignupProfileReceipt, error)
	Put(ctx context.Context, userID int64, profile services.SignupProfile) (services.SignupProfileReceipt, error)
}

// GetSignupProfile answers GET /api/user/settings/signup: the session user's
// profile, or {"profile": null} when none is saved. No path names a user, so
// no caller can read another person's profile.
func (h *UserHandler) GetSignupProfile(w http.ResponseWriter, r *http.Request) {
	user := middleware.UserFromContext(r.Context())
	if user == nil {
		errors.WriteError(w, errors.Unauthorized("authentication required"))
		return
	}
	receipt, err := h.SignupProfiles.Get(r.Context(), user.ID)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	errors.WriteJSON(w, http.StatusOK, receipt)
}

// PutSignupProfile answers PUT /api/user/settings/signup: it replaces the
// session user's whole profile and returns the saved receipt.
func (h *UserHandler) PutSignupProfile(w http.ResponseWriter, r *http.Request) {
	user := middleware.UserFromContext(r.Context())
	if user == nil {
		errors.WriteError(w, errors.Unauthorized("authentication required"))
		return
	}
	var profile services.SignupProfile
	if !decodeJSONBody(w, r, &profile) {
		return
	}
	receipt, err := h.SignupProfiles.Put(r.Context(), user.ID, profile)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	errors.WriteJSON(w, http.StatusOK, receipt)
}
