package routes

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type InstallQuiesceHandler struct {
	Owners  GitHubAppSetupOwners
	Service *services.InstallQuiesce
}

func (h *InstallQuiesceHandler) Handle(w http.ResponseWriter, r *http.Request) {
	if h == nil || h.Owners == nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("install owner authority unavailable"))
		return
	}
	// Reuse the install owner browser-session check, without setup-token fallback.
	auth := &GitHubAppSetupHandler{Owners: h.Owners}
	if !auth.authorize(w, r) {
		return
	}
	owner, err := h.Owners.GetSelfHostOwner(r.Context())
	if err != nil {
		writeRouteError(w, r, pkgerrors.Internal("install owner unavailable").WithCause(err))
		return
	}
	if h.Service == nil {
		quiesceResponse(w, errors.New("quiesce unavailable"))
		return
	}
	var request struct {
		Op string `json:"op"`
	}
	if r.Method == http.MethodPost {
		if err = json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024)).Decode(&request); err != nil || request.Op == "" {
			pkgerrors.WriteError(w, pkgerrors.BadRequest("quiesce op required"))
			return
		}
		row, err := h.Service.Freeze(r.Context(), request.Op, owner.ID)
		if err != nil {
			quiesceResponse(w, err)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(row)
		return
	}
	if err = h.Service.Reopen(r.Context(), ""); err != nil {
		quiesceResponse(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
func quiesceResponse(w http.ResponseWriter, err error) {
	body := map[string]any{"code": "install_quiesced", "class": "quiesced", "message": err.Error()}
	var frozen *services.InstallQuiescedError
	if errors.As(err, &frozen) {
		body["retry_at"] = frozen.RetryAt
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusServiceUnavailable)
	json.NewEncoder(w).Encode(body)
}

// MountInstallQuiesce is deliberately opt-in until the admission, machine and
// host contracts land. Its own two owner operations bypass admission.
func MountInstallQuiesce(r chi.Router, enabled bool, gate *services.QuiesceGate, h *InstallQuiesceHandler) {
	if !enabled {
		return
	}
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path == "/api/install/quiesce" && (r.Method == http.MethodPost || r.Method == http.MethodDelete) {
				next.ServeHTTP(w, r)
				return
			}
			switch r.Method {
			case http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete:
				if err := gate.Admit(r.Context(), r.Method); err != nil {
					quiesceResponse(w, err)
					return
				}
			}
			next.ServeHTTP(w, r)
		})
	})
	// Authentication and CSRF are installed by the API group, not here.
	if h != nil {
		r.Post("/api/install/quiesce", h.Handle)
		r.Delete("/api/install/quiesce", h.Handle)
	}
}
