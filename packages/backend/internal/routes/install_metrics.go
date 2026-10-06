package routes

import (
	"net/http"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/live"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// InstallMetrics exposes the same in-process registry as /metrics. Histograms
// are server cross-checks, never browser or guest performance passing values.
// Absent producers remain absent rather than being reported as zero samples.
type InstallMetricsHandler struct {
	Metrics  *SmithersMetrics
	Capacity *services.InstallCapacityService
}

func (h *InstallMetricsHandler) Read(w http.ResponseWriter, r *http.Request) {
	families, err := h.Metrics.registry.Gather()
	if err != nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("failed to collect install metrics").WithCause(err))
		return
	}
	var host *services.HostStatus
	if h.Capacity != nil {
		status, err := h.Capacity.Read(r.Context())
		if err != nil {
			pkgerrors.WriteError(w, pkgerrors.Internal("failed to read install host profile").WithCause(err))
			return
		}
		host = &status
	}
	w.Header().Set("Cache-Control", "no-store")
	pkgerrors.WriteJSON(w, http.StatusOK, map[string]any{
		"collected_at": time.Now().UTC(), "clock": "process cumulative collectors",
		"metrics":          families,
		"live_connections": live.Connections(),
		"host":             host,
	})
}
