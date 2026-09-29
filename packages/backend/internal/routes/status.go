package routes

import (
	"context"
	"net/http"
	"time"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// StatusHandler serves public deployment evidence separately from liveness:
// stale canaries must not trigger Kubernetes restarts of a healthy API.
type StatusHandler struct {
	CanaryRuns services.CanaryRunSource
	Clock      func() time.Time
}

func (h *StatusHandler) Status(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	now := time.Now
	if h.Clock != nil {
		now = h.Clock
	}
	var runs []services.CanaryRun
	var err error
	if h.CanaryRuns != nil {
		runs, err = h.CanaryRuns.LatestCanaryRuns(ctx)
	}
	checkedAt := now().UTC()
	canary := services.CanaryComponent(runs, err, checkedAt)
	status := "ok"
	if canary.Status != "ok" {
		status = "degraded"
	}
	w.Header().Set("Cache-Control", "no-store")
	pkgerrors.WriteJSON(w, http.StatusOK, struct {
		Status     string                              `json:"status"`
		CheckedAt  time.Time                           `json:"checked_at"`
		Components map[string]services.StatusComponent `json:"components"`
	}{status, checkedAt, map[string]services.StatusComponent{"canary": canary}})
}
