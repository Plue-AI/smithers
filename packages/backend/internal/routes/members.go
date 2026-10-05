package routes

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// MembersHandler serves the install's roster (GET/POST /api/members,
// PATCH/DELETE /api/members/{login}). services.Authorize decides each
// request: members read, maintainers write.
type MembersHandler struct{ Service *services.Members }

func memberRouteError(w http.ResponseWriter, err error) {
	failure := &services.AccessError{Status: http.StatusServiceUnavailable, Class: "infra", Code: "unavailable", Message: "Members unavailable"}
	var typed *services.AccessError
	if errors.As(err, &typed) {
		failure = typed
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(failure.Status)
	_ = json.NewEncoder(w).Encode(failure)
}

func (h *MembersHandler) List(w http.ResponseWriter, r *http.Request) {
	if h == nil || h.Service == nil {
		memberRouteError(w, nil)
		return
	}
	out, err := h.Service.List(r.Context())
	if err != nil {
		memberRouteError(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(out)
}

func (h *MembersHandler) Mutate(w http.ResponseWriter, r *http.Request) {
	if h == nil || h.Service == nil {
		memberRouteError(w, nil)
		return
	}
	var err error
	if r.Method == http.MethodDelete {
		err = h.Service.Remove(r.Context(), chi.URLParam(r, "login"))
	} else {
		var body struct {
			Login string `json:"login,omitempty"`
			Role  string `json:"role,omitempty"`
		}
		decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096))
		decoder.DisallowUnknownFields()
		invalid := decodeSingleJSONDocument(decoder, &body) != nil ||
			r.Method == http.MethodPost && body.Role != "" ||
			r.Method == http.MethodPatch && body.Login != ""
		if invalid {
			memberRouteError(w, &services.AccessError{Status: http.StatusBadRequest, Class: "user", Code: "invalid_request", Message: "Invalid request"})
			return
		}
		if r.Method == http.MethodPost {
			err = h.Service.Add(r.Context(), body.Login)
		} else {
			err = h.Service.ChangeRole(r.Context(), chi.URLParam(r, "login"), body.Role)
		}
	}
	if err != nil {
		memberRouteError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
