package routes

import (
	"encoding/json"
	"errors"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/microsandbox"
	"io"
	"net/http"

	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// HostStatusHandler supplies Settings and smthrs host status with the same model.
type HostStatusHandler struct {
	Service *services.InstallCapacityService
}

func (h *HostStatusHandler) Status(w http.ResponseWriter, r *http.Request) {
	status, err := h.Service.Read(r.Context())
	w.Header().Set("Content-Type", "application/json")
	if err != nil {
		w.WriteHeader(http.StatusServiceUnavailable)
		_ = json.NewEncoder(w).Encode(map[string]string{"code": "host_status_unavailable", "class": "infra", "message": "host status unavailable"})
		return
	}
	_ = json.NewEncoder(w).Encode(status)
}

// SetCapacity uses the authenticated person; the SQL write rechecks ownership.
func (h *HostStatusHandler) SetCapacity(w http.ResponseWriter, r *http.Request) {
	user := middleware.UserFromContext(r.Context())
	if user == nil {
		http.Error(w, "authentication required", http.StatusUnauthorized)
		return
	}
	if err := middleware.RequirePerson(r.Context(), "set capacity"); err != nil {
		http.Error(w, "person required", http.StatusForbidden)
		return
	}
	var input struct {
		Capacity int `json:"capacity"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&input); err != nil {
		http.Error(w, "invalid capacity", http.StatusBadRequest)
		return
	}
	if decoder.Decode(new(any)) != io.EOF {
		http.Error(w, "invalid capacity", http.StatusBadRequest)
		return
	}
	if err := h.Service.Set(r.Context(), user.ID, input.Capacity); err != nil {
		w.Header().Set("Content-Type", "application/json")
		var typed *microsandbox.CapacityError
		if errors.As(err, &typed) {
			status := http.StatusUnprocessableEntity
			if typed.Class == "permission" {
				status = http.StatusForbidden
			}
			w.WriteHeader(status)
			_ = json.NewEncoder(w).Encode(typed)
		} else {
			w.WriteHeader(http.StatusServiceUnavailable)
			_ = json.NewEncoder(w).Encode(map[string]string{"code": "host_status_unavailable", "class": "infra", "message": "host status unavailable"})
		}
		return
	}
	h.Status(w, r)
}
