package routes

import (
	"encoding/json"
	"io"
	"net/http"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// InstallAckDelayHandler uses the owner-person-session admission of install
// settings, then binds the diagnostic to a branch in this install's repository.
type InstallAckDelayHandler struct {
	Queries  *db.Queries
	Registry *machined.Registry
}

func (h *InstallAckDelayHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	branch := r.URL.Query().Get("branch")
	delay := 0
	if r.Method == http.MethodPost {
		var body struct {
			Branch  string `json:"branch"`
			DelayMS *int   `json:"delay_ms"`
		}
		decoder := json.NewDecoder(io.LimitReader(r.Body, 4097))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&body); err != nil || body.DelayMS == nil || decoder.Decode(new(any)) != io.EOF {
			pkgerrors.WriteError(w, pkgerrors.BadRequest("branch and delay_ms required"))
			return
		}
		branch, delay = body.Branch, *body.DelayMS
		if delay != 0 && delay != 10000 {
			pkgerrors.WriteError(w, pkgerrors.BadRequest("delay_ms must be 0 or 10000"))
			return
		}
	}
	if branch == "" {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("branch required"))
		return
	}
	repository, err := services.InstallRepositoryID(r.Context(), h.Queries)
	if err != nil {
		pkgerrors.WriteError(w, pkgerrors.Forbidden("install repository unavailable"))
		return
	}
	row, err := h.Queries.GetWorkspace(r.Context(), branch)
	if err != nil || row.RepositoryID != repository {
		pkgerrors.WriteError(w, pkgerrors.NotFound("branch not found"))
		return
	}
	if h.Registry == nil {
		pkgerrors.WriteError(w, pkgerrors.New(pkgerrors.CodeServiceUnavailable, "machine connection unavailable"))
		return
	}
	var receipt machined.AckDelayReceipt
	if r.Method == http.MethodPost {
		receipt, err = h.Registry.AckDelay(branch, delay)
	} else {
		receipt, err = h.Registry.ReadAckDelay(branch)
	}
	if err != nil {
		pkgerrors.WriteError(w, pkgerrors.Conflict("ready machine connection required"))
		return
	}
	pkgerrors.WriteJSON(w, http.StatusOK, receipt)
}
