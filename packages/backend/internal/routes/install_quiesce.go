package routes

import (
	"encoding/json"
	"errors"
	"github.com/smithersai/smithers/packages/backend/ports"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type InstallQuiesceHandler struct {
	Owners   GitHubAppSetupOwners
	Service  *services.InstallQuiesce
	Database ports.InstallMaintenanceDatabase
	Summary  ports.InstallMaintenanceSummary
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
	h.HandleInstallingOwner(w, r)
}

// HandleInstallingOwner is mounted only on the installing user's private Unix
// socket. Never mount this handler on a TCP listener. The socket's user-owned
// 0700 parents and 0600 mode authenticate the local installing user.
func (h *InstallQuiesceHandler) HandleInstallingOwner(w http.ResponseWriter, r *http.Request) {
	if h == nil || h.Owners == nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("install owner authority unavailable"))
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
	if r.URL.Path == "/maintenance/database/size" || r.URL.Path == "/maintenance/database/dump" {
		h.handleDatabase(w, r, owner.ID)
		return
	}
	if r.URL.Path == "/maintenance/backup/check" {
		if r.Method != http.MethodGet {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		errs := []error{h.Service.Check(r.Context())}
		if h.Database == nil {
			errs = append(errs, errors.New("owned postgres maintenance unavailable"))
		}
		if h.Summary == nil {
			errs = append(errs, errors.New("backup summary authority unavailable"))
		} else {
			errs = append(errs, h.Summary.Check(r.Context()))
		}
		if err := errors.Join(errs...); err != nil {
			quiesceResponse(w, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.URL.Path == "/maintenance/summary" {
		if r.Method != http.MethodGet {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		if h.Summary == nil {
			quiesceResponse(w, errors.New("backup summary authority unavailable"))
			return
		}
		if err := h.Service.RequireReady(r.Context(), r.URL.Query().Get("op"), owner.ID); err != nil {
			quiesceResponse(w, err)
			return
		}
		summary, err := h.Summary.Summary(r.Context())
		if err == nil {
			err = h.Service.RequireReady(r.Context(), r.URL.Query().Get("op"), owner.ID)
		}
		if err != nil {
			quiesceResponse(w, err)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(summary)
		return
	}
	if r.URL.Path == "/maintenance/check" {
		if r.Method != http.MethodGet {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		if err := h.Service.Check(r.Context()); err != nil {
			quiesceResponse(w, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != http.MethodPost && r.Method != http.MethodDelete {
		w.WriteHeader(http.StatusMethodNotAllowed)
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
	if err = h.Service.Reopen(r.Context(), r.URL.Query().Get("op")); err != nil {
		quiesceResponse(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
func quiesceResponse(w http.ResponseWriter, err error) {
	body := map[string]any{"code": "install_quiesced", "class": "infra", "message": err.Error()}
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

// Only HandleInstallingOwner can reach these exports. They are never TCP routes.
func (h *InstallQuiesceHandler) handleDatabase(w http.ResponseWriter, r *http.Request, owner int64) {
	method := http.MethodGet
	if r.URL.Path == "/maintenance/database/dump" {
		method = http.MethodPost
	}
	if r.Method != method {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	if h.Database == nil {
		quiesceResponse(w, errors.New("owned postgres maintenance unavailable"))
		return
	}
	if method == http.MethodGet {
		size, err := h.Database.DatabaseSize(r.Context())
		if err != nil {
			quiesceResponse(w, err)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(struct {
			Bytes uint64 `json:"bytes"`
		}{size})
		return
	}
	if err := h.Service.RequireReady(r.Context(), r.URL.Query().Get("op"), owner); err != nil {
		quiesceResponse(w, err)
		return
	}
	// Large dumps must outlive the bridge's ordinary 65-second response deadline.
	if err := http.NewResponseController(w).SetWriteDeadline(time.Time{}); err != nil {
		quiesceResponse(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	err := h.Database.Dump(r.Context(), w)
	if err == nil {
		err = h.Service.RequireReady(r.Context(), r.URL.Query().Get("op"), owner)
	}
	if err != nil {
		// Closing the chunked stream makes a partial dump fail at the CLI boundary.
		// Never append a JSON error to database bytes or let EOF imply success.
		panic(http.ErrAbortHandler)
	}
}
