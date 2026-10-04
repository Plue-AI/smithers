package routes

import (
	"context"
	"net/http"
	"time"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type InstallScorecardService interface {
	Summary(context.Context, time.Time, time.Time) (services.Scorecard, error)
}

// Authorize must be T-ACC-03's owner-person-session authorizer, including its
// typed never/permission refusals. No admin, PAT, or setup-session fallback.
type InstallScorecardHandler struct {
	Authorize func(*http.Request) error
	Service   InstallScorecardService
}

func (h *InstallScorecardHandler) Available() bool {
	return h != nil && h.Authorize != nil && h.Service != nil
}

func (h *InstallScorecardHandler) Summary(w http.ResponseWriter, r *http.Request) {
	if !h.Available() {
		http.NotFound(w, r)
		return
	}
	if err := h.Authorize(r); err != nil {
		writeRouteError(w, r, err)
		return
	}
	query := r.URL.Query()
	dates := make([]time.Time, 2)
	for i, name := range []string{"from", "to"} {
		values := query[name]
		if len(values) != 1 {
			pkgerrors.WriteError(w, pkgerrors.BadRequest("from and to must be specified once"))
			return
		}
		value, err := time.Parse(time.RFC3339Nano, values[0])
		if err != nil {
			pkgerrors.WriteError(w, pkgerrors.BadRequest("from and to must be RFC3339 timestamps"))
			return
		}
		dates[i] = value
	}
	if _, err := services.ValidateScorecardWindow(dates[0], dates[1]); err != nil {
		writeRouteError(w, r, err)
		return
	}
	out, err := h.Service.Summary(r.Context(), dates[0], dates[1])
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	pkgerrors.WriteJSON(w, http.StatusOK, out)
}
