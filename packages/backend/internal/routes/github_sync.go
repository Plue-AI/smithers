package routes

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"

	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// GitHubSyncRouteService is the authorized catalog dispatch seam. Status is
// read-only; Retry returns only after durable admission, never after execution.
// The install mounts a nil provider until authority and stream checks qualify.
type GitHubSyncRouteService interface {
	SyncHealth(context.Context) (services.GitHubSyncHealth, error)
	RetrySync(context.Context) error
}
type GitHubSyncHandler struct{ Service GitHubSyncRouteService }

func (h *GitHubSyncHandler) unavailable(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusServiceUnavailable)
	_ = json.NewEncoder(w).Encode(services.GitHubSyncUnavailable{Code: "github_sync_unavailable", Class: "infra", Message: "GitHub sync is unavailable"})
}
func (h *GitHubSyncHandler) writeError(w http.ResponseWriter, r *http.Request, err error) {
	var unavailable *services.GitHubSyncUnavailable
	if errors.As(err, &unavailable) {
		h.unavailable(w)
		return
	}
	writeRouteError(w, r, err)
}
func (h *GitHubSyncHandler) Status(w http.ResponseWriter, r *http.Request) {
	if h.Service == nil {
		h.unavailable(w)
		return
	}
	health, err := h.Service.SyncHealth(r.Context())
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(health)
}
func (h *GitHubSyncHandler) Retry(w http.ResponseWriter, r *http.Request) {
	if h.Service == nil {
		h.unavailable(w)
		return
	}
	if err := h.Service.RetrySync(r.Context()); err != nil {
		h.writeError(w, r, err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusAccepted)
	_ = json.NewEncoder(w).Encode(struct {
		State string `json:"state"`
	}{"accepted"})
}
